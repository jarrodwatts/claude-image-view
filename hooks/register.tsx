import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PastedImage } from '../types'
import { findPlaceholders, tmuxTransmit } from './kitty'
import { fitRow, imageNumbers, pngSize } from './layout'
import type { Size } from './layout'

// Pasting an image raises no prompt.edit (the tag only shows up on the next keystroke),
// so the draft is polled instead.
const POLL_MS = 200

const images = atom({ plugin: 'image-view', key: 'images' } as const, [] as PastedImage[])

let tmpRoot: string | undefined
let found: { sessionId: string; dir: string } | undefined
// The image numbers last drawn, so an unchanged draft doesn't rewrite state; undefined
// while a drawn image's file is still missing, so the next poll looks again.
let shownKey: string | undefined
let isChecking = false
const sizes = new Map<string, Size | null>()
// The pane this session draws into, when it runs inside tmux with terminal images forced on:
// undefined until looked up, null when not applicable or the lookup failed.
let pane: { id: string; tty: string } | null | undefined
// What each image id was last sent as, so an unchanged tile isn't sent again.
const sent = new Map<number, string>()
// The tiles with a file as the terminal band last drew them, left to right, with their cell size.
let drawnTiles: { path: string; columns: number; rows: number }[] = []

async function tmuxPane($: EngineInterface): Promise<{ id: string; tty: string } | null> {
  if (pane !== undefined) return pane
  const id = await $.env.get('TMUX_PANE')
  const isForced = Boolean(await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES'))
  if (!(await $.env.get('TMUX')) || !id || !isForced) return (pane = null)
  const ran = await $.process.run(['tmux', 'display-message', '-p', '-t', id, '#{pane_tty}'])
  const tty = ran.stdout.trim()
  if (ran.exitCode !== 0 || !tty.startsWith('/dev/')) {
    $.ui.log(`image-view: could not find tmux pane ${id}'s tty (exit ${ran.exitCode}); thumbnails stay blank in tmux`)
    return (pane = null)
  }
  return (pane = { id, tty })
}

// Claude Code drew placeholder cells for each tile but its pixels were dropped by tmux: read the
// ids it chose off the pane and send each image again through passthrough. The band sits right
// above the prompt, so its grids are the last ones on screen, left to right; images drawn higher
// up (the transcript) come first and are skipped. Only a run whose sizes match the tiles as drawn
// is trusted, so a band not yet redrawn sends nothing rather than the wrong picture.
async function sendThroughTmux($: EngineInterface, list: readonly PastedImage[]) {
  const target = await tmuxPane($)
  const files = new Set(list.flatMap(image => (image.path === null ? [] : [image.path])))
  const tiles = drawnTiles.filter(tile => files.has(tile.path))
  if (target === null || tiles.length === 0 || tiles.length !== files.size) return
  const captured = await $.process.run(['tmux', 'capture-pane', '-p', '-e', '-t', target.id])
  if (captured.exitCode !== 0) return
  const grids = findPlaceholders(captured.stdout).slice(-tiles.length)
  if (grids.length !== tiles.length) return
  if (grids.some((grid, i) => grid.columns !== tiles[i]!.columns || grid.rows !== tiles[i]!.rows)) return
  for (const [i, grid] of grids.entries()) {
    const { path } = tiles[i]!
    const key = `${path} ${grid.columns}x${grid.rows}`
    if (sent.get(grid.id) === key) continue
    const wrote = await $.process.run(['sh', '-c', 'cat > "$1"', 'image-view', target.tty], {
      stdin: tmuxTransmit(grid.id, path, grid.columns, grid.rows),
    })
    if (wrote.exitCode !== 0) {
      $.ui.log(`image-view: writing image ${grid.id} to ${target.tty} failed (exit ${wrote.exitCode})`)
      continue
    }
    sent.set(grid.id, key)
  }
}

// Claude Code caches each paste as <tmp>/<project>/<session>/images/<n>.png. The project
// folder is named after a working directory that may since have moved, so find it by the
// session id instead of rebuilding it.
async function imagesDir($: EngineInterface): Promise<string | undefined> {
  const sessionId = await $.session.id()
  if (found?.sessionId === sessionId) return found.dir
  if (tmpRoot === undefined) {
    const fromEnv = await $.env.get('CLAUDE_CODE_TMPDIR')
    tmpRoot = fromEnv ?? `/tmp/claude-${(await $.process.run(['id', '-u'])).stdout.trim()}`
  }
  const entries = await $.fs.list(tmpRoot).catch(() => [])
  for (const entry of entries) {
    const dir = `${tmpRoot}/${entry.name}/${sessionId}/images`
    if (entry.kind === 'dir' && (await $.fs.exists(dir))) {
      found = { sessionId, dir }
      return dir
    }
  }
  return undefined
}

async function describe($: EngineInterface, dir: string | undefined, n: number): Promise<PastedImage> {
  const path = `${dir}/${n}.png`
  if (dir === undefined || !(await $.fs.exists(path))) return { n, path: null, size: null }
  if (!sizes.has(path)) {
    const head = await $.fs.read(path, { as: 'bytes' }).then(
      ({ base64 }) => pngSize(base64),
      () => undefined, // too big to read: still drawable, just without its aspect ratio
    )
    if (head === null) return { n, path: null, size: null }
    sizes.set(path, head ?? null)
  }
  return { n, path, size: sizes.get(path) ?? null }
}

async function show($: EngineInterface, draft: string) {
  const numbers = imageNumbers(draft)
  const key = numbers.join(',')
  if (key === shownKey) return
  const dir = numbers.length > 0 ? await imagesDir($) : undefined
  const list: PastedImage[] = []
  for (const n of numbers) list.push(await describe($, dir, n))
  shownKey = list.every(image => image.path !== null) ? key : undefined
  await update($, images, () => list)
}

async function check($: EngineInterface) {
  if (isChecking) return
  isChecking = true
  try {
    await show($, (await $.prompt.read()).text)
    // ponytail: captures the pane every poll while the draft holds images; key it to a render event if that costs
    await sendThroughTmux($, await read($, images))
  } finally {
    isChecking = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    pane = undefined
    sent.clear()
    drawnTiles = []
    $.clock.every(POLL_MS, () => check($))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const list = await read($, images)
    if (list.length === 0) return next(e)

    const { Box, Image, Text } = $.ui.resolve(e)
    const cells = fitRow(list.map(image => image.size), e.props.maxRows, e.props.bodyColumns)
    drawnTiles = list.flatMap((image, i) =>
      image.path === null ? [] : [{ path: image.path, ...(cells[i] ?? { columns: 4, rows: 1 }) }],
    )
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {list.map((image, i) => {
            const { columns, rows } = cells[i] ?? { columns: 4, rows: 1 }
            return (
              <Box flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
                {image.path === null ? (
                  <Box width={columns} height={rows} alignItems="center" justifyContent="center">
                    <Text dimColor wrap="truncate">no preview</Text>
                  </Box>
                ) : (
                  <Image
                    key={`image-${image.n}`}
                    source={{ file: image.path, format: 'png' }}
                    columns={columns}
                    rows={rows}
                    alt={`[Image #${image.n}]`}
                  />
                )}
                <Text dimColor>#{image.n}</Text>
              </Box>
            )
          })}
        </Box>
        {below}
      </Box>
    )
  })
}
