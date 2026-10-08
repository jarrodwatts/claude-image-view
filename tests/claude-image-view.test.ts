import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { findPlaceholders, tmuxTransmit } from '../hooks/kitty'
import { fitCells, fitRow, imageNumbers, pngSize } from '../hooks/layout'
import { ONE_TILE_CAPTURE } from './fixtures'

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
  on('env.get', ($, e) => ({ value: e.name === 'CLAUDE_CODE_TMPDIR' ? '/tmp/claude-501' : undefined }))
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

const cell = (row: number, column: number) => String.fromCodePoint(0x10eeee, [0x0305, 0x030d][row]!, [0x0305, 0x030d, 0x030e][column]!)

test('placeholder grids are read off a captured pane, in tile order', () => {
  expect(findPlaceholders(ONE_TILE_CAPTURE)).toEqual([{ id: 1, columns: 20, rows: 6 }])

  // Two tiles on one line: a 256-colour id, then a truecolour one (24-bit id) in colon form.
  const line = (row: number) =>
    `│\x1b[38;5;7m${cell(row, 0)}${cell(row, 1)}\x1b[39m│ │\x1b[38:2::0:1:2m${cell(row, 0)}${cell(row, 1)}${cell(row, 2)}\x1b[0m│`
  expect(findPlaceholders(`${line(0)}\n${line(1)}`)).toEqual([
    { id: 7, columns: 2, rows: 2 },
    { id: 258, columns: 3, rows: 2 },
  ])
  // Placeholders with no foreground colour name no image, and a reset ends the colour.
  expect(findPlaceholders(cell(0, 0))).toEqual([])
  for (const reset of ['\x1b[0m', '\x1b[m', '\x1b[39m']) {
    expect(findPlaceholders(`\x1b[38;5;7m${cell(0, 0)}${reset}${cell(0, 2)}`)).toEqual([{ id: 7, columns: 1, rows: 1 }])
  }
})

test('the transmit is wrapped in tmux passthrough with every ESC doubled', () => {
  const wrapped = tmuxTransmit(1, '/tmp/a/1.png', 20, 6)
  expect(wrapped.startsWith('\x1bPtmux;\x1b\x1b_G')).toBe(true)
  expect(wrapped.endsWith('\x1b\x1b\\\x1b\\')).toBe(true)
  expect(wrapped).toContain(`a=T,U=1,q=2,f=100,t=f,i=1,c=20,r=6;${btoa('/tmp/a/1.png')}`)
})

function tmuxSession(on: On, env: Record<string, string>, capture: string) {
  const dir = '/tmp/claude-501/-work/sess-1/images'
  const writes: (string | undefined)[] = []
  const commands: string[] = []
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: 'see [Image #1]', cursor: 14 } }))
  on('env.get', ($, e) => ({ value: { CLAUDE_CODE_TMPDIR: '/tmp/claude-501', ...env }[e.name] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.list', () => ({ value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.exists', ($, e) => ({ value: e.path === dir || e.path === `${dir}/1.png` }))
  on('fs.read', () => ({ value: { base64: pngHead(800, 400) } }))
  on('process.run', ($, e) => {
    commands.push(e.argv.slice(0, 2).join(' '))
    if (e.argv[1] === 'display-message') return ok('/dev/ttys009\n')
    if (e.argv[1] === 'capture-pane') return ok(capture)
    writes.push(e.init?.stdin)
    return ok('')
  })
  on('ui.log', () => ({ value: undefined }))
  return { path: `${dir}/1.png`, writes, commands }
}

const TMUX_FORCED = {
  TMUX: '/private/tmp/tmux-501/default,123,0',
  TMUX_PANE: '%5',
  CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1',
}

test('inside tmux the image Claude Code placed is sent again through passthrough, once', async ($, on) => {
  const clock = mock.clock(on)
  const { path, writes } = tmuxSession(on, TMUX_FORCED, ONE_TILE_CAPTURE)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  expect(writes).toEqual([tmuxTransmit(1, path, 20, 6)])

  // The same tile on the next poll is not sent again.
  await clock.advance(200)
  expect(writes).toHaveLength(1)
})

const { TMUX: _tmux, ...NOT_IN_TMUX } = TMUX_FORCED
const { CLAUDE_CODE_FORCE_TERMINAL_IMAGES: _forced, ...NOT_FORCED } = TMUX_FORCED

for (const [name, env] of [['outside tmux', NOT_IN_TMUX], ['without forced terminal images', NOT_FORCED]] as const) {
  test(`${name}, nothing is captured or sent`, async ($, on) => {
    const clock = mock.clock(on)
    const { commands } = tmuxSession(on, env, ONE_TILE_CAPTURE)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await clock.advance(200)
    expect(commands.filter(command => command.startsWith('tmux') || command.startsWith('sh'))).toEqual([])
  })
}
