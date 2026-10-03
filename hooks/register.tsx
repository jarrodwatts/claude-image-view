import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PastedImage } from '../types'
import { blockCells, fitRow, imageNumbers, pngSize, THUMB } from './layout'
import type { Size } from './layout'

// Pasting an image raises no prompt.edit (the tag only shows up on the next keystroke),
// so the draft is polled instead.
const POLL_MS = 200

const images = atom({ plugin: 'image-view', key: 'images' } as const, [] as PastedImage[])

// Windows PowerShell's System.Drawing decodes the image and scales it to the thumbnail,
// printing "<width> <height> <base64 BGRA>": the mod's environment has no decoder of its own.
const THUMBNAIL_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($env:IMAGE_VIEW_FILE)
try {
  $w = ${THUMB.width}; $h = ${THUMB.height}
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Black)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $attr = New-Object System.Drawing.Imaging.ImageAttributes
  $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $g.DrawImage($src, $rect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $bmp.PixelFormat)
  $bytes = New-Object byte[] ($w * $h * 4)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  $bmp.UnlockBits($data)
  "$($src.Width) $($src.Height) $([Convert]::ToBase64String($bytes))"
} finally { $src.Dispose() }
`

type Thumbnail = { size: Size; pixels: string }

let tmpRoots: string[] | undefined
// On Windows a program's output reaches the terminal through ConPTY, and one older than this
// drops kitty graphics on the way. WezTerm runs the OpenConsole.exe beside it: its stable
// release bundles an unversioned one that drops them, its nightly 1.22.
const KITTY_CONPTY = { major: 1, minor: 22 }
const CONPTY_VERSION_SCRIPT = `
$ErrorActionPreference = 'Stop'
$v = (Get-Item $env:IMAGE_VIEW_CONSOLE).VersionInfo
"$($v.FileMajorPart).$($v.FileMinorPart)"
`

// True where thumbnails are drawn as half blocks: on Windows, unless kitty graphics reach
// the terminal.
let usesBlocks: boolean | undefined
const thumbnails = new Map<string, Thumbnail | null>()
let found: { sessionId: string; dir: string } | undefined
// The image numbers last drawn, so an unchanged draft doesn't rewrite state; undefined
// while a drawn image's file is still missing, so the next poll looks again.
let shownKey: string | undefined
let isChecking = false
const sizes = new Map<string, Size | null>()

// Claude Code caches each paste as <tmp>/<project>/<session>/images/<n>.png. The project
// folder is named after a working directory that may since have moved, so find it by the
// session id instead of rebuilding it.
async function imagesDir($: EngineInterface): Promise<string | undefined> {
  const sessionId = await $.session.id()
  if (found?.sessionId === sessionId) return found.dir
  tmpRoots ??= await findTmpRoots($)
  for (const root of tmpRoots) {
    const entries = await $.fs.list(root).catch(() => [])
    for (const entry of entries) {
      const dir = `${root}/${entry.name}/${sessionId}/images`
      if (entry.kind === 'dir' && (await $.fs.exists(dir))) {
        found = { sessionId, dir }
        return dir
      }
    }
  }
  return undefined
}

async function isWindows($: EngineInterface): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

// The cache's root is <tmp>/claude-<uid>, and on Windows, which has no uid, %TEMP%\claude.
async function findTmpRoots($: EngineInterface): Promise<string[]> {
  const fromEnv = await $.env.get('CLAUDE_CODE_TMPDIR')
  if (await isWindows($)) {
    const base = fromEnv ?? (await $.env.get('TEMP')) ?? (await $.env.get('TMP'))
    return base === undefined ? [] : [`${base}\\claude`, base]
  }
  return [fromEnv ?? `/tmp/claude-${(await $.process.run(['id', '-u'])).stdout.trim()}`]
}

async function windowsHasKittyGraphics($: EngineInterface): Promise<boolean> {
  if ((await $.env.get('TERM_PROGRAM')) !== 'WezTerm') return false
  const dir = await $.env.get('WEZTERM_EXECUTABLE_DIR')
  if (dir === undefined) return false
  return $.process
    .run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', CONPTY_VERSION_SCRIPT], {
      env: { IMAGE_VIEW_CONSOLE: `${dir}\\OpenConsole.exe` },
    })
    .then(
      ({ exitCode, stdout }) => {
        const [major, minor] = stdout.trim().split('.').map(Number)
        if (exitCode !== 0 || major === undefined || minor === undefined) return false
        return major > KITTY_CONPTY.major || (major === KITTY_CONPTY.major && minor >= KITTY_CONPTY.minor)
      },
      () => false,
    )
}

async function thumbnail($: EngineInterface, path: string): Promise<Thumbnail | null> {
  const made = thumbnails.get(path)
  if (made !== undefined) return made
  const thumb = await $.process
    .run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', THUMBNAIL_SCRIPT], {
      env: { IMAGE_VIEW_FILE: path },
    })
    .then(
      ({ exitCode, stdout }) => {
        const [width, height, pixels] = stdout.trim().split(' ')
        if (exitCode !== 0 || pixels === undefined) return null
        return { size: { width: Number(width), height: Number(height) }, pixels }
      },
      () => null,
    )
  thumbnails.set(path, thumb)
  return thumb
}

// Windows pastes aren't always PNGs: the cache names each file <n>.<extension>.
async function describeBlocks($: EngineInterface, dir: string | undefined, n: number): Promise<PastedImage> {
  const none = { n, path: null, size: null, pixels: null }
  if (dir === undefined) return none
  const entries = await $.fs.list(dir).catch(() => [])
  const file = entries.find(entry => entry.kind === 'file' && new RegExp(`^${n}\\.[a-z]+$`).test(entry.name))
  if (file === undefined) return none
  const path = `${dir}/${file.name}`
  const thumb = await thumbnail($, path)
  return { n, path, size: thumb?.size ?? null, pixels: thumb?.pixels ?? null }
}

async function describe($: EngineInterface, dir: string | undefined, n: number): Promise<PastedImage> {
  if (usesBlocks) return describeBlocks($, dir, n)
  const path = `${dir}/${n}.png`
  if (dir === undefined || !(await $.fs.exists(path))) {
    // A Windows paste that isn't a PNG: the terminal reads only PNGs, so it is drawn as blocks.
    return (await isWindows($)) ? describeBlocks($, dir, n) : { n, path: null, size: null, pixels: null }
  }
  if (!sizes.has(path)) {
    const head = await $.fs.read(path, { as: 'bytes' }).then(
      ({ base64 }) => pngSize(base64),
      () => undefined, // too big to read: still drawable, just without its aspect ratio
    )
    if (head === null) return { n, path: null, size: null, pixels: null }
    sizes.set(path, head ?? null)
  }
  return { n, path, size: sizes.get(path) ?? null, pixels: null }
}

async function show($: EngineInterface, draft: string) {
  const numbers = imageNumbers(draft)
  const key = numbers.join(',')
  if (key === shownKey) return
  const dir = numbers.length > 0 ? await imagesDir($) : undefined
  usesBlocks ??= (await isWindows($)) && !(await windowsHasKittyGraphics($))
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
            const blocks = image.pixels === null ? null : blockCells(image.pixels, columns, rows)
            return (
              <Box flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
                {image.path === null ? (
                  <Box width={columns} height={rows} alignItems="center" justifyContent="center">
                    <Text dimColor wrap="truncate">no preview</Text>
                  </Box>
                ) : blocks !== null ? (
                  <Raster key={`image-${image.n}`} columns={columns} rows={rows} cells={blocks} />
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
