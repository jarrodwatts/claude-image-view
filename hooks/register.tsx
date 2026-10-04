import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PastedImage } from '../types'
import { blockCells, drawsPictures, fitRow, imageNumbers, pngSize } from './layout'
import type { Size } from './layout'
import { decodeThumb } from './png'
import type { Thumb } from './png'

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
// Small decoded copies for terminals that can't draw pictures, which get colored blocks instead.
const thumbs = new Map<string, Thumb | null>()
let pictures: boolean | undefined

// The terminal's own words about itself: there is no capability query, so go by its environment.
async function canDrawPictures($: EngineInterface): Promise<boolean> {
  if (pictures === undefined) {
    pictures = drawsPictures({
      TERM: await $.env.get('TERM'),
      TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
      TMUX: await $.env.get('TMUX'),
      KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
      GHOSTTY_RESOURCES_DIR: await $.env.get('GHOSTTY_RESOURCES_DIR'),
      WEZTERM_EXECUTABLE: await $.env.get('WEZTERM_EXECUTABLE'),
      CLAUDE_IMAGE_VIEW_RENDERER: await $.env.get('CLAUDE_IMAGE_VIEW_RENDERER'),
    })
  }
  return pictures
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
    const file = await $.fs.read(path, { as: 'bytes' }).then(
      ({ base64 }) => base64,
      () => undefined, // too big to read: still drawable, just without its aspect ratio
    )
    const head = file === undefined ? undefined : pngSize(file)
    if (head === null) return { n, path: null, size: null }
    sizes.set(path, head ?? null)
    if (file !== undefined && !(await canDrawPictures($))) thumbs.set(path, decodeThumb(Uint8Array.fromBase64(file)))
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
  } finally {
    isChecking = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    pictures = undefined
    $.clock.every(POLL_MS, () => check($))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const list = await read($, images)
    if (list.length === 0) return next(e)

    const { Box, Image, Raster, Text } = $.ui.resolve(e)
    const cells = fitRow(list.map(image => image.size), e.props.maxRows, e.props.bodyColumns)
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {list.map((image, i) => {
            const { columns, rows } = cells[i] ?? { columns: 4, rows: 1 }
            return (
              <Box key={`tile-${image.n}`} flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
                {image.path === null ? (
                  <Box width={columns} height={rows} alignItems="center" justifyContent="center">
                    <Text dimColor wrap="truncate">no preview</Text>
                  </Box>
                ) : thumbs.get(image.path) ? (
                  <Raster
                    key={`blocks-${image.n}`}
                    columns={columns}
                    rows={rows}
                    cells={blockCells(thumbs.get(image.path)!, columns, rows)}
                  />
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
