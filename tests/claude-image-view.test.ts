import { expect, mock, test } from 'claude-code/testing'

import { fitCells, fitRow, halfBlocks, imageNumbers, parseShrunk, pngSize } from '../hooks/layout'

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

test('the Windows shrinker output parses, and half-blocks average it down', () => {
  // 4x4 grid: top half red, bottom half blue.
  const red = 'ff0000'.repeat(4)
  const blue = '0000ff'.repeat(4)
  const shrunk = parseShrunk(`800 800\r\n${red}\r\n${red}\r\n${blue}\r\n${blue}\r\n`)
  expect(shrunk?.size).toEqual({ width: 800, height: 800 })
  expect(shrunk?.grid.length).toBe(4)
  // 2 columns x 1 row = 2x2 pixels: each cell is red over blue, merged into one run.
  expect(halfBlocks(shrunk!.grid, { columns: 2, rows: 1 })).toEqual([[{ top: '#ff0000', bottom: '#0000ff', count: 2 }]])
  expect(parseShrunk('error')).toBeNull()
})

const BAND = {
  plugin: 'image-view',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const ENTRY = { size: 0, mtimeMs: 0, isLink: false }

test('a pasted image shows without another keystroke and clears when the draft does', async ($, on) => {
  const clock = mock.clock(on)
  const dir = '/tmp/claude-501/-work/sess-1/images'
  let draft = 'see [Image #1] [Image #2]'
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', ($, e) => ({ value: e.name === 'CLAUDE_CODE_TMPDIR' ? '/tmp/claude-501' : undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  // Another project's folder and a stray file sit beside the one holding this session.
  on('fs.list', () => ({
    value: [
      { name: '-other', kind: 'dir', ...ENTRY },
      { name: 'notes.txt', kind: 'file', ...ENTRY },
      { name: '-work', kind: 'dir', ...ENTRY },
    ],
  }))
  // The test engine hands paths over in the host's form, so compare them in POSIX form.
  const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  on('fs.exists', ($, e) => ({ value: posix(e.path) === dir || posix(e.path) === `${dir}/1.png` }))
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

test('Windows: the cache is found under %TEMP%\\claude, drawn as half-blocks, and the label opens the file', async ($, on) => {
  const clock = mock.clock(on)
  const dir = 'C:\\T\\claude\\C--work\\sess-1\\images'
  const env: Record<string, string> = { OS: 'Windows_NT', TEMP: 'C:\\T' }
  const draft = 'see [Image #1]'
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.list', ($, e) => ({ value: e.path === 'C:\\T\\claude' ? [{ name: 'C--work', kind: 'dir', ...ENTRY }] : [] }))
  on('fs.exists', ($, e) => ({ value: e.path === dir || e.path === `${dir}\\1.png` }))
  const red = 'ff0000'.repeat(4)
  const blue = '0000ff'.repeat(4)
  let shrunkPath: string | undefined
  let opened: readonly string[] | undefined
  on('process.run', ($, e) => {
    if (e.argv[0] === 'explorer.exe') opened = e.argv
    else shrunkPath = e.init?.env?.IMAGE_VIEW_PATH
    return { value: { exitCode: 0, stdout: `400 400\n${red}\n${blue}`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' })
  await clock.advance(200)
  expect(shrunkPath).toBe(`${dir}\\1.png`)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  // The shrunk picture is 4x2 (red over blue), so in the 12x6 square it sits centred: two blank
  // rows, a half-filled red edge row, full red and blue rows, a half-filled blue edge row.
  const leaf = (cell: { children: unknown[] }, text: string) => cell.children.length === 1 && cell.children[0] === text
  const full = (await ui.findAll({ type: 'Text', text: '▀'.repeat(12) })).filter(cell => cell.props.backgroundColor)
  expect(full.map(cell => `${cell.props.color}/${cell.props.backgroundColor}`)).toEqual(['#ff0000/#ff0000', '#0000ff/#0000ff'])
  const lowerHalf = (await ui.findAll({ type: 'Text', text: '▄'.repeat(12) })).filter(cell => leaf(cell, '▄'.repeat(12)))
  expect(lowerHalf.map(cell => cell.props)).toEqual([{ color: '#ff0000' }])
  const blank = (await ui.findAll({ type: 'Text', text: ' '.repeat(12) })).filter(cell => leaf(cell, ' '.repeat(12)))
  expect(blank).toHaveLength(2)

  // Clicking the label opens the full picture in the default viewer.
  expect(await ui.find({ type: 'Button', text: '#1 · open' })).toBeDefined()
  await ui.press({ key: 'open-1' })
  expect(opened).toEqual(['explorer.exe', `${dir}\\1.png`])
  await ui.unmount()
})

test('Windows with the claude-pictures helper: the real picture is drawn, with the open label', async ($, on) => {
  const clock = mock.clock(on)
  const dir = 'C:\\T\\claude\\C--work\\sess-1\\images'
  const env: Record<string, string> = { OS: 'Windows_NT', TEMP: 'C:\\T', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' }
  const draft = 'see [Image #3]'
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.list', ($, e) => ({ value: e.path === 'C:\\T\\claude' ? [{ name: 'C--work', kind: 'dir', ...ENTRY }] : [] }))
  on('fs.exists', ($, e) => ({ value: e.path === dir || e.path === `${dir}\\3.png` }))
  on('fs.read', () => ({ value: { base64: pngHead(400, 400) } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' })
  await clock.advance(200)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props).toMatchObject({ source: { file: `${dir}\\3.png`, format: 'png' }, columns: 12, rows: 6 })
  expect(await ui.find({ type: 'Button', text: '#3 · open' })).toBeDefined()
  await ui.unmount()
})
