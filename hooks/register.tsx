import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PastedImage } from '../types'
import { fitRow, halfBlocks, imageNumbers, parseShrunk, pngSize } from './layout'
import type { Size } from './layout'

// Pasting an image raises no prompt.edit (the tag only shows up on the next keystroke),
// so the draft is polled instead.
const POLL_MS = 200

// Windows Terminal has no kitty graphics. Without the claude-pictures helper (see windows/), the
// picture is shrunk by the built-in System.Drawing (no install needed) and drawn as coloured
// half-block characters instead.
const SHRINK_PS = [
  'Add-Type -AssemblyName System.Drawing',
  '$s=[System.Drawing.Image]::FromFile($env:IMAGE_VIEW_PATH)',
  '$k=[Math]::Min(1.0,[Math]::Min(96.0/$s.Width,48.0/$s.Height))',
  '$w=[Math]::Max(1,[int]($s.Width*$k)); $h=[Math]::Max(1,[int]($s.Height*$k))',
  '$b=New-Object System.Drawing.Bitmap $w,$h',
  '$g=[System.Drawing.Graphics]::FromImage($b); $g.InterpolationMode=7; $g.PixelOffsetMode=4',
  '$g.DrawImage($s,0,0,$w,$h)',
  "[Console]::Out.Write(('{0} {1}' -f $s.Width,$s.Height))",
  'for($y=0;$y -lt $h;$y++){ $r=New-Object Text.StringBuilder; for($x=0;$x -lt $w;$x++){ $c=$b.GetPixel($x,$y); ' +
    "[void]$r.AppendFormat('{0:x2}{1:x2}{2:x2}',$c.R,$c.G,$c.B) }; [Console]::Out.Write([char]10+$r.ToString()) }",
].join('; ')

const images = atom({ plugin: 'image-view', key: 'images' } as const, [] as PastedImage[])

let platform: { isWindows: boolean; useBlocks: boolean; tmpRoot: string; sep: string } | undefined
let found: { sessionId: string; dir: string } | undefined
// The image numbers last drawn, so an unchanged draft doesn't rewrite state; undefined
// while a drawn image's file is still missing, so the next poll looks again.
let shownKey: string | undefined
let isChecking = false
const described = new Map<string, Omit<PastedImage, 'n'> | null>()

async function getPlatform($: EngineInterface) {
  if (platform) return platform
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const fromEnv = await $.env.get('CLAUDE_CODE_TMPDIR')
  if (isWindows) {
    const temp = (await $.env.get('TEMP')) ?? (await $.env.get('TMP')) ?? ''
    // WezTerm speaks kitty graphics on Windows, and the claude-pictures helper turns kitty
    // graphics into Sixel for Windows Terminal; both get the real picture. Anything else gets
    // coloured blocks.
    const hasPictures =
      (await $.env.get('TERM_PROGRAM')) === 'WezTerm' || (await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) === '1'
    platform = { isWindows, useBlocks: !hasPictures, tmpRoot: fromEnv ?? `${temp}\\claude`, sep: '\\' }
  } else {
    const uid = fromEnv === undefined ? (await $.process.run(['id', '-u'])).stdout.trim() : ''
    platform = { isWindows, useBlocks: false, tmpRoot: fromEnv ?? `/tmp/claude-${uid}`, sep: '/' }
  }
  return platform
}

// Claude Code caches each paste as <tmp>/<project>/<session>/images/<n>.png. The project
// folder is named after a working directory that may since have moved, so find it by the
// session id instead of rebuilding it. On Windows <tmp> is %TEMP%\claude.
async function imagesDir($: EngineInterface): Promise<string | undefined> {
  const sessionId = await $.session.id()
  if (found?.sessionId === sessionId) return found.dir
  const { tmpRoot, sep } = await getPlatform($)
  const entries = await $.fs.list(tmpRoot).catch(() => [])
  for (const entry of entries) {
    const dir = [tmpRoot, entry.name, sessionId, 'images'].join(sep)
    if (entry.kind === 'dir' && (await $.fs.exists(dir))) {
      found = { sessionId, dir }
      return dir
    }
  }
  return undefined
}

async function shrink($: EngineInterface, path: string): Promise<{ size: Size; grid: string[] } | null> {
  const result = await $.process
    .run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', SHRINK_PS], {
      env: { IMAGE_VIEW_PATH: path },
      timeoutMs: 15_000,
    })
    .catch(() => undefined)
  return result?.exitCode === 0 ? parseShrunk(result.stdout) : null
}

// Windows only: opens the full picture in the default viewer (Photos).
async function openPicture($: EngineInterface, path: string) {
  // Hidden test runs set this to a file: the click is noted there instead of opening a window.
  const clickLog = await $.env.get('IMAGE_VIEW_CLICK_LOG')
  if (clickLog) {
    await $.process.run(['cmd.exe', '/c', `echo clicked ${path}>> "${clickLog}"`]).catch(() => undefined)
    return
  }
  // explorer.exe exits 1 even when it opened the file, so its result is ignored.
  await $.process.run(['explorer.exe', path]).catch(() => undefined)
}

async function describe($: EngineInterface, dir: string | undefined, n: number): Promise<PastedImage> {
  const { useBlocks, sep } = await getPlatform($)
  const path = `${dir}${sep}${n}.png`
  if (dir === undefined || !(await $.fs.exists(path))) return { n, path: null, size: null }
  if (!described.has(path)) {
    if (useBlocks) {
      const shrunk = await shrink($, path)
      described.set(path, shrunk && { path, size: shrunk.size, grid: shrunk.grid })
    } else {
      const head = await $.fs.read(path, { as: 'bytes' }).then(
        ({ base64 }) => pngSize(base64),
        () => undefined, // too big to read: still drawable, just without its aspect ratio
      )
      described.set(path, head === null ? null : { path, size: head ?? null })
    }
  }
  return { n, ...(described.get(path) ?? { path: null, size: null }) }
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
    $.clock.every(POLL_MS, () => check($))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const list = await read($, images)
    if (list.length === 0) return next(e)

    const { Box, Button, Image, Text } = $.ui.resolve(e)
    const cells = fitRow(list.map(image => image.size), e.props.maxRows, e.props.bodyColumns)
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {list.map((image, i) => {
            const { columns, rows } = cells[i] ?? { columns: 4, rows: 1 }
            // On Windows the label doubles as an "open" button; a narrow tile keeps the short form.
            const canOpen = platform?.isWindows === true && image.path !== null
            const label = canOpen && columns >= `#${image.n} · open`.length ? `#${image.n} · open` : `#${image.n}`
            return (
              // The frame lights up under the pointer, in terminals that report mouse movement.
              <Box
                key={`tile-${image.n}`}
                flexDirection="column"
                alignItems="center"
                borderStyle="round"
                borderDimColor
                hover={{ borderDimColor: false }}
              >
                {image.path === null ? (
                  <Box width={columns} height={rows} alignItems="center" justifyContent="center">
                    <Text dimColor wrap="truncate">no preview</Text>
                  </Box>
                ) : image.grid ? (
                  <Box flexDirection="column" width={columns} height={rows}>
                    {halfBlocks(image.grid, { columns, rows }).map((runs, r) => (
                      <Text key={`row-${r}`} wrap="truncate">
                        {runs.map((run, k) =>
                          run.top === null && run.bottom === null ? (
                            <Text key={`run-${k}`}>{' '.repeat(run.count)}</Text>
                          ) : run.top === null ? (
                            <Text key={`run-${k}`} color={run.bottom!}>{'▄'.repeat(run.count)}</Text>
                          ) : run.bottom === null ? (
                            <Text key={`run-${k}`} color={run.top}>{'▀'.repeat(run.count)}</Text>
                          ) : (
                            <Text key={`run-${k}`} color={run.top} backgroundColor={run.bottom}>{'▀'.repeat(run.count)}</Text>
                          ),
                        )}
                      </Text>
                    ))}
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
                {canOpen ? (
                  // The button fills its row, so the label is centred by hand under the picture.
                  <Box width={columns} paddingLeft={Math.max(0, Math.floor((columns - label.length) / 2))}>
                    <Button key={`open-${image.n}`} plain dimColor hover={{ dimColor: false }} onPress={() => openPicture($, image.path!)}>
                      {label}
                    </Button>
                  </Box>
                ) : (
                  <Text dimColor>{label}</Text>
                )}
              </Box>
            )
          })}
        </Box>
        {below}
      </Box>
    )
  })
}
