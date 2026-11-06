import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PastedImage } from '../types'
import { blockCells, drawsPictures, fitRow, imageNumbers, pngSize, thumbSide } from './layout'
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
// The list last written, so a poll that finds the same tiles doesn't redraw the band.
let written: string | undefined
let isChecking = false
const sizes = new Map<string, Size | null>()
// Files whose first bytes aren't a PNG's: they never will be, so they aren't read again.
const notPng = new Set<string>()
// Source files sips couldn't convert, so a broken paste isn't retried on every poll.
const unconvertible = new Set<string>()
// Small decoded copies for terminals that can't draw pictures, which get colored blocks instead.
const thumbs = new Map<string, Thumb | null>()
let pictures: boolean | undefined

// Claude Code doesn't tell mods whether its Image draws a picture, so go by the environment
// it decides from.
async function canDrawPictures($: EngineInterface): Promise<boolean> {
  if (pictures === undefined) {
    pictures = drawsPictures({
      TERM: await $.env.get('TERM'),
      TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
      TMUX: await $.env.get('TMUX'),
      STY: await $.env.get('STY'),
      KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
      GHOSTTY_RESOURCES_DIR: await $.env.get('GHOSTTY_RESOURCES_DIR'),
      CLAUDE_CODE_FORCE_TERMINAL_IMAGES: await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES'),
      CLAUDE_CODE_SESSION_KIND: await $.env.get('CLAUDE_CODE_SESSION_KIND'),
      CLAUDE_IMAGE_VIEW_RENDERER: await $.env.get('CLAUDE_IMAGE_VIEW_RENDERER'),
    })
  }
  return pictures
}

// Claude Code keeps its temp files in <base>/claude-<uid>, or <base>\claude on Windows. The base
// is CLAUDE_CODE_TMPDIR when set, else /tmp (%TEMP% on Windows): the variable names the folder
// Claude Code nests its own in, not that folder itself.
async function tempRoot($: EngineInterface): Promise<string | undefined> {
  const fromEnv = await $.env.get('CLAUDE_CODE_TMPDIR')
  if ((await $.env.get('OS')) === 'Windows_NT') {
    const base = fromEnv ?? (await $.env.get('TEMP'))
    return base === undefined ? undefined : `${base.replace(/[\\/]+$/, '')}/claude`
  }
  const uid = (await $.process.run(['id', '-u'])).stdout.trim()
  return `${(fromEnv ?? '/tmp').replace(/\/+$/, '')}/claude-${uid}`
}

// Claude Code caches each paste as <tmp>/<project>/<session>/images/<n>.png. The project
// folder is named after a working directory that may since have moved, so find it by the
// session id instead of rebuilding it.
async function imagesDir($: EngineInterface): Promise<string | undefined> {
  const sessionId = await $.session.id()
  if (found?.sessionId === sessionId) return found.dir
  tmpRoot ??= await tempRoot($)
  if (tmpRoot === undefined) return undefined
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

// Pastes are cached as <n>.png or <n>.webp (or another format), but the terminal only
// decodes PNG, so anything else is converted once to <session>/image-view-<n>.png.
// sips ships with macOS only, so on Linux a non-PNG paste still shows "no preview".
async function pngFor($: EngineInterface, dir: string, n: number): Promise<string | undefined> {
  const png = `${dir}/${n}.png`
  if (await $.fs.exists(png)) return png
  const out = `${dir.replace(/\/images$/, '')}/image-view-${n}.png`
  if (await $.fs.exists(out)) return out
  const entries = await $.fs.list(dir).catch(() => [])
  const source = entries.find(entry => entry.kind === 'file' && entry.name.startsWith(`${n}.`))
  if (source === undefined) return undefined
  const sourcePath = `${dir}/${source.name}`
  if (unconvertible.has(sourcePath)) return undefined
  const { exitCode } = await $.process
    .run(['sips', '-s', 'format', 'png', '-Z', '800', sourcePath, '--out', out])
    .catch(() => ({ exitCode: 1 }))
  if (exitCode === 0) return out
  unconvertible.add(sourcePath)
  return undefined
}

// Hands the terminal a copy near the tile's size, since it aliases what it shrinks far itself.
// Where sips can't run (it ships with macOS only) the terminal gets the original, which still draws.
async function prescaled($: EngineInterface, dir: string, n: number, path: string, size: Size | null): Promise<string> {
  const side = thumbSide(size)
  if (side === null || unconvertible.has(path) || !(await canDrawPictures($))) return path
  const out = `${dir.replace(/\/images$/, '')}/image-view-${n}-thumb.png`
  if (await $.fs.exists(out)) return out
  const { exitCode } = await $.process
    .run(['sips', '-Z', String(side), path, '--out', out])
    .catch(() => ({ exitCode: 1 }))
  if (exitCode === 0) return out
  unconvertible.add(path)
  return path
}

async function describe($: EngineInterface, dir: string | undefined, n: number): Promise<PastedImage> {
  if (dir === undefined) return { n, path: null, size: null }
  const path = await pngFor($, dir, n)
  if (path === undefined || notPng.has(path)) return { n, path: null, size: null }
  if (!sizes.has(path)) {
    const base64 = await $.fs.read(path, { as: 'bytes' }).then(
      bytes => bytes.base64,
      () => undefined, // too big to read: still drawable, just without its aspect ratio
    )
    const head = base64 === undefined ? undefined : pngSize(base64)
    if (head === null) {
      // A file no longer than the 24-byte header may still be being written; a longer one is settled.
      if (base64!.length > 32) notPng.add(path)
      return { n, path: null, size: null }
    }
    sizes.set(path, head ?? null)
    if (base64 !== undefined && !(await canDrawPictures($))) thumbs.set(path, decodeThumb(Uint8Array.fromBase64(base64)))
  }
  const size = sizes.get(path) ?? null
  return { n, path: await prescaled($, dir, n, path, size), size }
}

async function show($: EngineInterface, draft: string) {
  const numbers = imageNumbers(draft)
  const key = numbers.join(',')
  if (key === shownKey) return
  const dir = numbers.length > 0 ? await imagesDir($) : undefined
  const list: PastedImage[] = []
  for (const n of numbers) list.push(await describe($, dir, n))
  shownKey = list.every(image => image.path !== null) ? key : undefined
  const json = JSON.stringify(list)
  if (json === written) return
  await update($, images, () => list)
  written = json
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
    if (cells.length === 0) return next(e)
    const hidden = list.length - cells.length
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {list.slice(0, cells.length).map((image, i) => {
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
          {hidden > 0 && <Text dimColor>+{hidden}</Text>}
        </Box>
        {below}
      </Box>
    )
  })
}
