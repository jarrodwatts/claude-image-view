import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PastedImage } from '../types'
import { REMOVE_LABEL, fitRow, footer, imageNumbers, pngSize, withoutImage } from './layout'
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
// Each cached paste's preview PNG (null when none could be made), so a paste is processed once.
const previews = new Map<string, string | null>()

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

async function run($: EngineInterface, argv: readonly string[]): Promise<boolean> {
  const { exitCode } = await $.process.run(argv).catch(() => ({ exitCode: 1 }))
  return exitCode === 0
}

// Pastes are cached as <n>.png, <n>.webp, <n>.heic and so on, and the terminal only draws PNG.
// Every paste gets a preview: sips converts it to an 800px PNG, then ffmpeg adds a transparent
// strip down each side, PADDING of the height wide. The frame's side lines sit half a column
// from the picture but the top and bottom lines half a row, about twice that; the strip evens
// them out (exactly at the 6-row tile, close when tiles shrink).
// sips ships with macOS only; without ffmpeg the preview is drawn unpadded.
const PADDING = 'trunc(ih/24)'
async function makePreview($: EngineInterface, source: string, base: string, n: number): Promise<string | null> {
  const raw = `${base}/image-preview-${n}.raw.png`
  const out = `${base}/image-preview-${n}.png`
  if (await $.fs.exists(out)) return out
  if (!(await run($, ['sips', '-s', 'format', 'png', '-Z', '800', source, '--out', raw]))) {
    return source.endsWith('.png') ? source : null
  }
  const pad = `format=rgba,pad=iw+2*${PADDING}:ih:${PADDING}:0:color=black@0`
  return (await run($, ['ffmpeg', '-v', 'error', '-y', '-i', raw, '-vf', pad, '-frames:v', '1', out])) ? out : raw
}

async function pngFor($: EngineInterface, dir: string, n: number): Promise<string | undefined> {
  const entries = await $.fs.list(dir).catch(() => [])
  const source = entries.find(entry => entry.kind === 'file' && entry.name.startsWith(`${n}.`))
  if (source === undefined) return undefined
  const sourcePath = `${dir}/${source.name}`
  if (!previews.has(sourcePath)) {
    previews.set(sourcePath, await makePreview($, sourcePath, dir.replace(/\/images$/, ''), n))
  }
  return previews.get(sourcePath) ?? undefined
}

async function describe($: EngineInterface, dir: string | undefined, n: number): Promise<PastedImage> {
  const path = dir === undefined ? undefined : await pngFor($, dir, n)
  if (path === undefined) return { n, path: null, size: null }
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

// The [×] on a tile: take the image's tag out of the draft, then redraw without waiting for the poll.
async function remove($: EngineInterface, n: number) {
  const text = withoutImage((await $.prompt.read()).text, n)
  await $.prompt.fill({ text, mode: 'replace' })
  await show($, text)
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
    $.clock.every(POLL_MS, () => check($))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const list = await read($, images)
    if (list.length === 0) return next(e)

    const { Box, Button, Image, Text } = $.ui.resolve(e)
    const cells = fitRow(list.map(image => image.size), e.props.maxRows, e.props.bodyColumns)
    // The main screen sends no clicks, so the [×] only shows where it can be clicked.
    const canClick = e.viewport?.isFullscreen === true
    const below = await next(e)

    return (
      <Box flexDirection="column">
        {/* Tiles of different heights share a bottom edge, so their labels line up above the prompt. */}
        <Box flexDirection="row" columnGap={1} alignItems="flex-end">
          {list.map((image, i) => {
            const { columns, rows } = cells[i] ?? { columns: 4, rows: 1 }
            // The frame is drawn by hand so the number and [×] can sit in its bottom edge. The
            // sides stay centred │ so they join the rounded corners; the preview's transparent
            // side strips, not the frame, even out the gap around the picture.
            const side = (bar: string) => Array.from({ length: rows }, () => bar).join('\n')
            const { head, tail } = footer(image.n, columns, canClick)
            return (
              <Box flexDirection="column">
                <Text dimColor>{`╭${'─'.repeat(columns)}╮`}</Text>
                <Box flexDirection="row">
                  <Text dimColor>{side('│')}</Text>
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
                  <Text dimColor>{side('│')}</Text>
                </Box>
                <Box flexDirection="row">
                  <Text dimColor>{head}</Text>
                  {canClick && (
                    <Button key={`remove-${image.n}`} plain dimColor onPress={() => remove($, image.n)}>
                      {REMOVE_LABEL}
                    </Button>
                  )}
                  <Text dimColor>{tail}</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
        {below}
      </Box>
    )
  })
}
