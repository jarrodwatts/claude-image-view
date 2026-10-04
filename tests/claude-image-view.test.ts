import { expect, mock, test } from 'claude-code/testing'

import { blockCells, drawsPictures, fitCells, fitRow, imageNumbers, pngSize } from '../hooks/layout'
import { decodeThumb } from '../hooks/png'

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
  on('fs.exists', ($, e) => ({ value: e.path === dir || e.path === `${dir}/1.png` }))
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

// Real PNGs made with zlib, each row using a different PNG filter (none, sub, up, average, paeth).
// RGBA 64x40, dynamic Huffman blocks: x < 32 opaque, the rest half transparent.
const RGBA = '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'
// 4-bit palette 16x8, fixed Huffman blocks: palette entry 0 is fully transparent.
const PALETTE = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAIBAMAAAACWGKkAAAAMFBMVEUA/wAQ7yUg30owz29Av5RQr7lgn95wjwOAfyiQb02gX3KwT5fAP7zQL+HgHwbwDysGwvM4AAAAEHRSTlMA////////////////////wFCLQwAAADlJREFUeNpjYFR2Te9cffY9o5ASGAgxCUIBs7IUCHDNYoEKKDGEVczac++DkAljOlipkhJYMSMQAwAESQ0dnDbg1AAAAABJRU5ErkJggg=='
// 16-bit grayscale 8x4.
const GRAY16 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAEEAAAAADGNv1vAAAANElEQVR42mNgYJB3sGuIPVDLMMdhd8OtA4zMLxQc5MEQQjOxvECFzBwBglOEpgiJCIlAaADdQBS1IoDTFgAAAABJRU5ErkJggg=='

const bytesOf = (base64: string) => Uint8Array.fromBase64(base64)
const pixel = (thumb: { width: number; rgb: Uint8Array }, x: number, y: number) =>
  [...thumb.rgb.subarray((y * thumb.width + x) * 3, (y * thumb.width + x) * 3 + 3)]
// A half-transparent pixel over the backdrop the decoder uses.
const over = (c: number) => Math.round((c * 128 + 0x1e * 127) / 255)

test('PNG decoding gives the picture back through every row filter', () => {
  const thumb = decodeThumb(bytesOf(RGBA))!
  expect([thumb.width, thumb.height]).toEqual([64, 40])
  for (const [x, y] of [[0, 0], [31, 7], [5, 39], [20, 22]] as const) {
    expect(pixel(thumb, x, y)).toEqual([x * 4, y * 6, (x * y) % 256])
  }
  for (const [x, y] of [[32, 0], [63, 39], [40, 13]] as const) {
    expect(pixel(thumb, x, y)).toEqual([over(x * 4), over(y * 6), over((x * y) % 256)])
  }
})

test('PNG decoding handles palettes with transparency and 16-bit gray', () => {
  const palette = decodeThumb(bytesOf(PALETTE))!
  expect(pixel(palette, 0, 0)).toEqual([0x1e, 0x1e, 0x1e]) // palette entry 0 is transparent
  expect(pixel(palette, 3, 2)).toEqual([5 * 16, 255 - 5 * 16, (5 * 37) % 256])
  const gray = decodeThumb(bytesOf(GRAY16))!
  expect(pixel(gray, 5, 2)).toEqual(Array(3).fill(((5 * 8000 + 2 * 1000) % 65536) >> 8))
})

test('a PNG that cannot be decoded gives no thumbnail', () => {
  const png = bytesOf(RGBA)
  expect(decodeThumb(png.subarray(0, 40))).toBeNull() // cut off before its data
  expect(decodeThumb(new Uint8Array(100))).toBeNull() // not a PNG
  const corrupt = png.slice()
  corrupt.fill(0xff, 60, 200)
  expect(decodeThumb(corrupt)).toBeNull()
})

test('a thumbnail is averaged down into half-block cells', () => {
  // 64x40 drawn in 8x2 cells is 8x4 pixels: each is the average of an 8x10 block of the picture.
  const thumb = decodeThumb(bytesOf(RGBA))!
  const words = new Uint32Array(bytesOf(blockCells(thumb, 8, 2)).buffer)
  expect(words.length).toBe(8 * 2 * 3)
  expect(words[0]).toBe(0x2580) // an upper half block
  const mean = (y0: number, f: (x: number, y: number) => number) => {
    let sum = 0
    for (let y = y0; y < y0 + 10; y++) for (let x = 0; x < 8; x++) sum += f(x, y)
    return Math.round(sum / 80)
  }
  const color = (y0: number) =>
    (mean(y0, x => x * 4) << 16) | (mean(y0, (_, y) => y * 6) << 8) | mean(y0, (x, y) => (x * y) % 256)
  expect(words[1]).toBe(color(0)) // the cell's foreground is the top pixel...
  expect(words[2]).toBe(color(10)) // ...and its background the one below
})

test('only kitty-protocol terminals get real pictures', () => {
  expect(drawsPictures({ TERM: 'xterm-kitty' })).toBe(true)
  expect(drawsPictures({ TERM_PROGRAM: 'ghostty' })).toBe(true)
  expect(drawsPictures({ TERM_PROGRAM: 'WezTerm' })).toBe(true)
  expect(drawsPictures({ KITTY_WINDOW_ID: '4' })).toBe(true)
  expect(drawsPictures({ TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' })).toBe(false)
  expect(drawsPictures({ TERM_PROGRAM: 'vscode' })).toBe(false)
  // tmux eats the protocol, even inside kitty.
  expect(drawsPictures({ TERM: 'xterm-kitty', TMUX: '/tmp/tmux-501/default,1,0' })).toBe(false)
  // An override beats guessing from the environment.
  expect(drawsPictures({ TERM_PROGRAM: 'iTerm.app', CLAUDE_IMAGE_VIEW_RENDERER: 'image' })).toBe(true)
  expect(drawsPictures({ TERM: 'xterm-kitty', CLAUDE_IMAGE_VIEW_RENDERER: 'blocks' })).toBe(false)
})

for (const [name, env, drawn, notDrawn] of [
  ['a terminal without pictures gets the thumbnail in colored blocks', { TERM_PROGRAM: 'Apple_Terminal' }, 'Raster', 'Image'],
  ['a kitty terminal still gets the real picture', { TERM: 'xterm-kitty' }, 'Image', 'Raster'],
] as const) {
  test(name, async ($, on) => {
    const clock = mock.clock(on)
    // Its own session, so nothing is cached from the other tests.
    const session = `sess-${drawn}`
    const dir = `/tmp/claude-501/-work/${session}/images`
    const entry = { size: 0, mtimeMs: 0, isLink: false }
    on('session.start', () => ({ cwd: '/work' }))
    on('prompt.read', () => ({ value: { text: 'see [Image #1]', cursor: 14 } }))
    on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CODE_TMPDIR' ? '/tmp/claude-501' : (env as Record<string, string>)[e.name] }))
    on('session.id', () => ({ value: session }))
    on('fs.list', () => ({ value: [{ name: '-work', kind: 'dir', ...entry }] }))
    on('fs.exists', (_, e) => ({ value: e.path === dir || e.path === `${dir}/1.png` }))
    on('fs.read', () => ({ value: { base64: RGBA } }))
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await clock.advance(200)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: notDrawn })).toBeUndefined()
    // 64x40 is wider than tall: 6 rows of cells, twice as many columns as 6 * 64 / 40 pixels.
    expect((await ui.find({ type: drawn }))?.props).toMatchObject({ columns: 19, rows: 6 })
    await ui.unmount()
  })
}
