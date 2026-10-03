import { expect, mock, test } from 'claude-code/testing'

import { fitCells, fitRow, imageNumbers, pngSize } from '../hooks/layout'

function pngHead(width: number, height: number): string {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return btoa(String.fromCharCode(...bytes))
}

test('image numbers come from the draft, deduplicated, in order', () => {
  expect(imageNumbers('look [Image #2] and [Image #1] again [Image #2]')).toEqual([2, 1])
  expect(imageNumbers('[Image 1] [image #3] #4')).toEqual([])
})

test('PNG size is read from the IHDR header', () => {
  expect(pngSize(pngHead(1630, 632))).toEqual({ width: 1630, height: 632 })
  expect(pngSize(btoa('\xff\xd8\xff\xe0 this is a jpeg, not a png...'))).toBeNull()
})

test('thumbnails keep aspect ratio within the tile', () => {
  // Square: 6 rows tall, twice as many columns because cells are tall.
  expect(fitCells({ width: 500, height: 500 })).toEqual({ columns: 12, rows: 6 })
  // Very wide: capped at 32 columns, rows shrink to match.
  expect(fitCells({ width: 3000, height: 500 })).toEqual({ columns: 32, rows: 3 })
  // Very tall: never narrower than 4 columns.
  expect(fitCells({ width: 100, height: 2000 })).toEqual({ columns: 4, rows: 6 })
})

test('a row of tiles shrinks to fit the band so it never scrolls', () => {
  const square = { width: 500, height: 500 }
  // Plenty of room: full 6-row tiles.
  expect(fitRow([square], 20, 120)).toEqual([{ columns: 12, rows: 6 }])
  // A short band: border and label take 3 rows, so the picture gets the rest.
  expect(fitRow([square], 7, 120)).toEqual([{ columns: 8, rows: 4 }])
  // A narrow band: three 6-row squares need 3 * 14 + 2 = 44 columns; 40 forces 5 rows.
  expect(fitRow([square, square, square], 20, 40)).toEqual([
    { columns: 10, rows: 5 },
    { columns: 10, rows: 5 },
    { columns: 10, rows: 5 },
  ])
})

// On Windows the engine resolves a path before a hook sees it (separators, drive letter),
// so the mocks compare how paths end.
const isPath = (path: string, expected: string) =>
  path.replaceAll('\\', '/').endsWith(expected.replaceAll('\\', '/').replace(/^[A-Za-z]:/, ''))

const BAND = {
  plugin: 'image-view',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('a pasted image shows without another keystroke and clears when the draft does', async ($, on) => {
  const clock = mock.clock(on)
  const dir = '/tmp/claude-501/-work/sess-1/images'
  let draft = 'see [Image #1] [Image #2]'
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', () => ({ value: '/tmp/claude-501' }))
  on('session.id', () => ({ value: 'sess-1' }))
  // Another project's folder and a stray file sit beside the one holding this session.
  const entry = { size: 0, mtimeMs: 0, isLink: false }
  on('fs.list', () => ({
    value: [
      { name: '-other', kind: 'dir', ...entry },
      { name: 'notes.txt', kind: 'file', ...entry },
      { name: '-work', kind: 'dir', ...entry },
    ],
  }))
  on('fs.exists', ($, e) => ({ value: isPath(e.path, dir) || isPath(e.path, `${dir}/1.png`) }))
  on('fs.read', () => ({ value: { base64: pngHead(800, 400) } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props).toMatchObject({ source: { file: `${dir}/1.png`, format: 'png' }, columns: 24, rows: 6 })
  // #2 has no cached file, so it gets a placeholder tile instead of a broken Image.
  expect(await ui.find({ type: 'Text', text: 'no preview' })).toBeDefined()
  await ui.unmount()

  // Sending the prompt empties the box.
  draft = ''
  await clock.advance(200)
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Image' })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: 'engine band' })).toBeDefined()
})

test('on Windows the cache is found under %TEMP% and the thumbnail is drawn as half blocks', async ($, on) => {
  const clock = mock.clock(on)
  const root = 'C:\\Temp\\claude'
  const dir = `${root}/C--work/sess-win/images`
  const draft = 'see [Image #1]'
  const env: Record<string, string> = { OS: 'Windows_NT', TEMP: 'C:\\Temp' }
  // A 64x24 BGRA thumbnail, every pixel opaque orange (#ff8800).
  const bgra = new Uint8Array(64 * 24 * 4)
  for (let i = 0; i < bgra.length; i += 4) bgra.set([0x00, 0x88, 0xff, 0xff], i)
  let binary = ''
  for (const byte of bgra) binary += String.fromCharCode(byte)

  on('session.start', () => ({ cwd: 'C:\\work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'sess-win' }))
  const entry = { size: 0, mtimeMs: 0, isLink: false }
  on('fs.list', ($, e) => ({
    value:
      isPath(e.path, root)
        ? [{ name: 'C--work', kind: 'dir', ...entry }]
        : isPath(e.path, dir)
          ? [{ name: '1.jpg', kind: 'file', ...entry }]
          : [],
  }))
  on('fs.exists', ($, e) => ({ value: isPath(e.path, dir) }))
  on('process.run', ($, e) => {
    expect(e.argv[0]).toBe('powershell.exe')
    expect(e.init?.env).toEqual({ IMAGE_VIEW_FILE: `${dir}/1.jpg` })
    return { value: { exitCode: 0, stdout: `800 400 ${btoa(binary)}\r\n`, stderr: '' } }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' })
  await clock.advance(200)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  const raster = await ui.find({ type: 'Raster' })
  expect(raster?.props).toMatchObject({ columns: 24, rows: 6 })
  // Every cell is an upper half block, orange over orange.
  const cells = new Uint32Array(Uint8Array.from(atob(raster?.props.cells as string), c => c.charCodeAt(0)).buffer)
  expect(cells.length).toBe(24 * 6 * 3)
  expect([cells[0], cells[1], cells[2]]).toEqual([0x2580, 0xff8800, 0xff8800])
})
