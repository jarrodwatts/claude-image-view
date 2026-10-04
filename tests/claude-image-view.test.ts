import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { REMOVE_LABEL, fitCells, fitRow, footer, imageNumbers, pngSize, withoutImage } from '../hooks/layout'

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

test('removing an image takes out its tag and the space after it, and no other tag', () => {
  expect(withoutImage('look [Image #1] [Image #12] here [Image #1]', 1)).toEqual('look [Image #12] here ')
  expect(withoutImage('[Image #2]', 2)).toEqual('')
})

test('the bottom border holds the number and [×], exactly as wide as the tile, tightening when narrow', () => {
  const line = (n: number, columns: number, hasButton: boolean) => {
    const { head, tail } = footer(n, columns, hasButton)
    return head + (hasButton ? REMOVE_LABEL : '') + tail
  }
  expect(line(6, 14, true)).toEqual('╰─ #6 ─── [×] ─╯')
  expect(line(6, 6, true)).toEqual('╰#6─[×]╯')
  expect(line(12, 4, true)).toEqual('╰─[×]╯')
  // No button off fullscreen: the number and an unbroken line.
  expect(line(6, 14, false)).toEqual('╰─ #6 ─────────╯')
  expect(line(6, 4, false)).toEqual('╰#6──╯')
  for (const columns of [4, 5, 6, 11, 12, 13, 32]) {
    for (const n of [1, 12]) {
      for (const hasButton of [true, false]) expect(line(n, columns, hasButton).length).toEqual(columns + 2)
    }
  }
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
  // A short band: the top and bottom border take 2 rows, so the picture gets the rest.
  expect(fitRow([square], 7, 120)).toEqual([{ columns: 10, rows: 5 }])
  // A narrow band: three 6-row squares need 3 * 14 + 2 = 44 columns; 40 forces 5 rows.
  expect(fitRow([square, square, square], 20, 40)).toEqual([
    { columns: 10, rows: 5 },
    { columns: 10, rows: 5 },
    { columns: 10, rows: 5 },
  ])
})

const BAND = {
  plugin: 'image-view',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const SESSION = '/tmp/claude-501/-work/sess-1'
const DIR = `${SESSION}/images`
const ENTRY = { size: 0, mtimeMs: 0, isLink: false }
const PAD = 'format=rgba,pad=iw+2*trunc(ih/24):ih:trunc(ih/24):0:color=black@0'

/**
 * A session whose image cache holds `files`, beside another project's folder and a stray file.
 * Every command "succeeds" by creating its last argument; the returned list records them.
 */
function mockSession(on: Parameters<TestBody>[1], files: string[], draft: () => string) {
  const made = new Set<string>()
  const runs: (readonly string[])[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft(), cursor: draft().length } }))
  on('env.get', () => ({ value: '/tmp/claude-501' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.list', ($, e) => ({
    value:
      e.path === DIR
        ? files.map(name => ({ name, kind: 'file' as const, ...ENTRY }))
        : [
            { name: '-other', kind: 'dir' as const, ...ENTRY },
            { name: 'notes.txt', kind: 'file' as const, ...ENTRY },
            { name: '-work', kind: 'dir' as const, ...ENTRY },
          ],
  }))
  on('fs.exists', ($, e) => ({ value: e.path === DIR || made.has(e.path) }))
  on('process.run', ($, e) => {
    runs.push(e.argv)
    made.add(e.argv.at(-1) ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The padded preview of an 800x400 picture: 800 + 2 * trunc(400 / 24) wide.
  on('fs.read', () => ({ value: { base64: pngHead(832, 400) } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  return runs
}

test('a pasted image shows without another keystroke and clears when the draft does', async ($, on) => {
  const clock = mock.clock(on)
  let draft = 'see [Image #1] [Image #2]'
  mockSession(on, ['1.png'], () => draft)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const image = await ui.find({ type: 'Image' })
  // 832x400 at 6 rows: round(12 * 832 / 400) = 25 columns, one more than the unpadded picture.
  const file = `${SESSION}/image-preview-1.png`
  expect(image?.props).toMatchObject({ source: { file, format: 'png' }, columns: 25, rows: 6 })
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

test('a webp paste is converted and padded once, then drawn from the preview', async ($, on) => {
  const clock = mock.clock(on)
  const runs = mockSession(on, ['12.webp', '1.webp'], () => 'see [Image #1]')
  const raw = `${SESSION}/image-preview-1.raw.png`
  const out = `${SESSION}/image-preview-1.png`

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  await clock.advance(200)

  // Made once (12.webp is not #1's file), then reused on the next poll.
  expect(runs).toEqual([
    ['sips', '-s', 'format', 'png', '-Z', '800', `${DIR}/1.webp`, '--out', raw],
    ['ffmpeg', '-v', 'error', '-y', '-i', raw, '-vf', PAD, '-frames:v', '1', out],
  ])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props).toMatchObject({ source: { file: out, format: 'png' }, columns: 25, rows: 6 })
})

test("pressing a tile's [×] takes that image's tag out of the prompt and drops the tile", async ($, on) => {
  const clock = mock.clock(on)
  let draft = 'compare [Image #1] [Image #2] please'
  mockSession(on, ['1.png', '2.png'], () => draft)
  on('prompt.fill', ($, e) => {
    draft = e.text
    return { isFilled: true }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)

  // The main screen sends no clicks, so it draws no [×].
  const main = await $.ui.mount({ ...BAND, surface: 'terminal', viewport: { ...BAND.viewport, isFullscreen: false } })
  expect(await main.find({ key: 'remove-1' })).toBeUndefined()
  expect(await main.find({ type: 'Image' })).toBeDefined()
  await main.unmount()

  const fullscreen = { ...BAND, surface: 'terminal', viewport: { ...BAND.viewport, isFullscreen: true } } as const
  const ui = await $.ui.mount(fullscreen)
  expect((await ui.find({ key: 'remove-1' }))?.text).toEqual('[×]')
  await ui.press({ key: 'remove-1' })
  expect(draft).toEqual('compare [Image #2] please')
  await ui.unmount()

  const after = await $.ui.mount(fullscreen)
  expect(await after.find({ key: 'remove-1' })).toBeUndefined()
  expect(await after.find({ key: 'remove-2' })).toBeDefined()
})
