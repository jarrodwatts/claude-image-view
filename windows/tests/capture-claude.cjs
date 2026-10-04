// Runs Claude Code hidden under the newer Windows pseudo-console, with pictures forced on,
// and records the raw bytes it sends so we can see exactly how it transmits a picture.
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const picture = process.argv[2]
const rawOut = process.argv[3]
const sessionId = crypto.randomUUID()
const cacheDir = path.join(process.env.TEMP, 'claude', 'claude-pictures-capture', sessionId, 'images')
fs.mkdirSync(cacheDir, { recursive: true })
fs.copyFileSync(picture, path.join(cacheDir, '1.png'))

const cols = 120, rows = 40
const term = new Terminal({ cols, rows, allowProposedApi: true })
const chunks = []
// Plain (non-fullscreen) screen mode: a hidden run that gets killed must never count as a failed fullscreen start.
const child = pty.spawn('claude.exe', ['--session-id', sessionId, '--settings', '{"tui":"default"}'], {
  name: 'xterm-256color', cols, rows, cwd: __dirname, useConptyDll: true,
  env: { ...process.env, COLORTERM: 'truecolor', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' },
})
child.onData(d => { chunks.push(Buffer.from(d, 'utf8')); term.write(d) })
const wait = ms => new Promise(r => setTimeout(r, ms))
const screen = () => {
  const b = term.buffer.active, lines = []
  for (let y = 0; y < rows; y++) lines.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '')
  return lines.join('\n')
}

;(async () => {
  for (let i = 0; i < 40; i++) {
    await wait(500)
    const s = screen()
    if (/confirm/i.test(s) && /yes,/i.test(s)) {
      // A startup dialog (trust this folder, allow CLAUDE.md imports): pick its "Yes" line.
      const yes = s.split('\n').find(l => /yes,/i.test(l)) || ''
      if (!/❯/.test(yes)) { child.write('\x1b[B'); await wait(400) }
      child.write('\r'); await wait(1500)
      continue
    }
    if (/❯|>\s*$/m.test(s) && !/confirm/i.test(s)) break
  }
  await wait(2000)
  const before = chunks.length
  child.write('look at this [Image #1]')
  await wait(5000)
  const all = Buffer.concat(chunks)
  fs.writeFileSync(rawOut, all)
  const text = all.toString('utf8')
  const apcs = [...text.matchAll(/\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\/g)]
  console.log(`APC count: ${apcs.length}`)
  for (const m of apcs.slice(0, 8)) console.log('  APC', m[1], 'payload', (m[2] ?? '').length, 'chars:', (m[2] ?? '').slice(0, 60))
  const placeholders = text.match(/\u{10EEEE}/gu) || []
  console.log(`placeholder cells: ${placeholders.length}`)
  const idx = text.indexOf('\u{10EEEE}')
  if (idx >= 0) console.log('around first placeholder:', JSON.stringify(text.slice(Math.max(0, idx - 80), idx + 60)))
  console.log('--- screen bottom:')
  console.log(screen().split('\n').slice(-16).join('\n'))
  child.write('\x15')
  await wait(300)
  child.kill()
  fs.rmSync(path.dirname(path.dirname(cacheDir)), { recursive: true, force: true })
  process.exit(0)
})()
