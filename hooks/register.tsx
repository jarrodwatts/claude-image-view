import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { PastedImage } from '../types'
import { blockCells, drawsPictures, fitRow, imageNumbers, opensLinks, pngSize } from './layout'
import type { Size } from './layout'
import { decodeThumb } from './png'
import type { Thumb } from './png'

// Pasting an image raises no prompt.edit (the tag only shows up on the next keystroke),
// so the draft is polled instead.
const POLL_MS = 200
// The tallest a sent prompt's tiles get, so a few pastes don't push the conversation off screen.
const SENT_ROWS = 8

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
let links: boolean | undefined

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
  const sourcePath = await sourceFor($, dir, n)
  if (sourcePath === undefined) return undefined
  if (unconvertible.has(sourcePath)) return undefined
  const { exitCode } = await $.process
    .run(['sips', '-s', 'format', 'png', '-Z', '800', sourcePath, '--out', out])
    .catch(() => ({ exitCode: 1 }))
  if (exitCode === 0) return out
  unconvertible.add(sourcePath)
  return undefined
}

// The original paste, <n>.<ext>, whatever format it was cached in.
async function sourceFor($: EngineInterface, dir: string, n: number): Promise<string | undefined> {
  const entries = await $.fs.list(dir).catch(() => [])
  const source = entries.find(entry => entry.kind === 'file' && entry.name.startsWith(`${n}.`))
  return source === undefined ? undefined : `${dir}/${source.name}`
}

// The terminal can only show a thumbnail, so a press on a tile's label opens the paste itself,
// at full size, in the system's image viewer.
async function openFull($: EngineInterface, file: string) {
  const command =
    (await $.env.get('OS')) === 'Windows_NT'
      ? ['cmd', '/c', 'start', '""', file]
      : (await $.process.run(['uname', '-s'])).stdout.trim() === 'Darwin'
        ? ['open', file]
        : ['xdg-open', file]
  const { exitCode } = await $.process.run(command).catch(() => ({ exitCode: 1 }))
  if (exitCode !== 0) await $.ui.toast(`Couldn't open ${file}`)
}

function fileUrl(path: string): string {
  return `file://${encodeURI(path.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/'))}`
}

async function describe($: EngineInterface, dir: string | undefined, n: number): Promise<PastedImage> {
  const path = dir === undefined ? undefined : await pngFor($, dir, n)
  if (path === undefined || notPng.has(path)) return { n, path: null, source: null, size: null }
  const source = (await sourceFor($, dir!, n)) ?? path
  if (!sizes.has(path)) {
    const base64 = await $.fs.read(path, { as: 'bytes' }).then(
      bytes => bytes.base64,
      () => undefined, // too big to read: still drawable, just without its aspect ratio
    )
    const head = base64 === undefined ? undefined : pngSize(base64)
    if (head === null) {
      // A file no longer than the 24-byte header may still be being written; a longer one is settled.
      if (base64!.length > 32) notPng.add(path)
      return { n, path: null, source: null, size: null }
    }
    sizes.set(path, head ?? null)
    if (base64 !== undefined && !(await canDrawPictures($))) thumbs.set(path, decodeThumb(Uint8Array.fromBase64(base64)))
  }
  return { n, path, source, size: sizes.get(path) ?? null }
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

// How a tile's #n label opens the paste: a Button its digit presses after ctrl+x tab (and a click,
// in fullscreen), a Button only a click presses, a hyperlink, or nothing at all.
type LabelKind = 'hotkey' | 'button' | 'link' | 'text'

function tiles(
  $: EngineInterface,
  { Box, Button, Image, Link, Raster, Text }: Elements['terminal'],
  list: PastedImage[],
  cells: { columns: number; rows: number }[],
  label: LabelKind,
  // Keys are unique per tree, but a sent prompt's tiles must not collide with the band's.
  prefix = '',
  // Terminal.app opens no hyperlinks, but a cmd+click on a URL in plain text Quick Looks it. Each
  // URL gets a line of its own below the tiles: inside a tile, the border's │ became part of it.
  urls = false,
) {
  const hidden = list.length - cells.length
  const shown = list.slice(0, cells.length).filter(image => image.source !== null)
  const row = (
    <Box flexDirection="row" columnGap={1}>
      {list.slice(0, cells.length).map((image, i) => {
        const { columns, rows } = cells[i] ?? { columns: 4, rows: 1 }
        const key = `${prefix}${image.n}`
        return (
          <Box key={`tile-${key}`} flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
            {image.path === null ? (
              <Box width={columns} height={rows} alignItems="center" justifyContent="center">
                <Text dimColor wrap="truncate">no preview</Text>
              </Box>
            ) : thumbs.get(image.path) ? (
              <Raster
                key={`blocks-${key}`}
                columns={columns}
                rows={rows}
                cells={blockCells(thumbs.get(image.path)!, columns, rows)}
              />
            ) : (
              <Image
                key={`image-${key}`}
                source={{ file: image.path, format: 'png' }}
                columns={columns}
                rows={rows}
                alt={`[Image #${image.n}]`}
              />
            )}
            {image.source === null || label === 'text' ? (
              <Text dimColor>#{image.n}</Text>
            ) : label === 'link' ? (
              <Text dimColor>
                <Link href={fileUrl(image.source)} label={`#${image.n}`} />
              </Text>
            ) : (
              <Button
                key={`open-${key}`}
                label={`#${image.n}`}
                hotkey={label === 'hotkey' && image.n <= 9 ? String(image.n) : undefined}
                plain
                dimColor
                onPress={() => void openFull($, image.source!)}
              />
            )}
          </Box>
        )
      })}
      {hidden > 0 && <Text dimColor>+{hidden}</Text>}
    </Box>
  )
  if (!urls || shown.length === 0) return row
  return (
    <Box flexDirection="column">
      {row}
      {shown.map(image => (
        <Text key={`url-${prefix}${image.n}`} dimColor>{`#${image.n} ${fileUrl(image.source!)}`}</Text>
      ))}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    pictures = undefined
    links = undefined
    $.clock.every(POLL_MS, () => check($))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const list = await read($, images)
    if (list.length === 0) return next(e)

    links ??= opensLinks({ TERM_PROGRAM: await $.env.get('TERM_PROGRAM') })
    const urls = e.viewport?.isFullscreen !== true && !links
    const cells = fitRow(list.map(image => image.size), e.props.maxRows - (urls ? list.length : 0), e.props.bodyColumns)
    if (cells.length === 0) return next(e)
    // Only the fullscreen layout reports clicks; on the main screen the label is a hyperlink the
    // terminal opens on cmd/ctrl+click, or, where it opens none, a Button pressed by its digit
    // after ctrl+x tab focuses the band, which leaves the draft as it is.
    const label = e.viewport?.isFullscreen !== true && links ? 'link' : 'hotkey'
    const below = await next(e)
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {tiles($, $.ui.resolve(e), list, cells, label, '', urls)}
        {below}
      </Box>
    )
  })

  // A sent prompt keeps its tiles under it. A row on the main screen is printed into scrollback,
  // where nothing takes a key, so there the label is a hyperlink or, in Terminal.app, a URL line.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.origin.kind !== 'composer') return next(e)
    const numbers = imageNumbers(e.props.text)
    if (numbers.length === 0) return next(e)
    const dir = await imagesDir($)
    if (dir === undefined) return next(e)
    const list: PastedImage[] = []
    for (const n of numbers) list.push(await describe($, dir, n))
    if (list.every(image => image.path === null)) return next(e)

    const cells = fitRow(list.map(image => image.size), SENT_ROWS, (e.viewport?.columns ?? 80) - 4)
    if (cells.length === 0) return next(e)
    links ??= opensLinks({ TERM_PROGRAM: await $.env.get('TERM_PROGRAM') })
    const label = e.viewport?.isFullscreen === true ? 'button' : links ? 'link' : 'text'
    const urls = label === 'text'
    const row = await next(e)
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {row}
        <Box paddingLeft={2}>{tiles($, $.ui.resolve(e), list, cells, label, 'sent', urls)}</Box>
      </Box>
    )
  })
}
