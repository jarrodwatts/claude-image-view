// Runs the whole translator (index.cjs) hidden under a pseudo-console, with Claude Code inside it,
// pastes a picture tag, and checks what reaches the outside: a Sixel picture, no placeholder cells.
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const picture = process.argv[2]
const logFile = process.argv[3]
const sessionId = crypto.randomUUID()
const cacheDir = path.join(process.env.TEMP, 'claude', 'claude-pictures-wrapper', sessionId, 'images')
fs.mkdirSync(cacheDir, { recursive: true })
fs.copyFileSync(picture, path.join(cacheDir, '1.png'))
try { fs.unlinkSync(logFile) } catch {}

const cols = 120, rows = 40
const term = new Terminal({ cols, rows, allowProposedApi: true })
const chunks = []
// Plain (non-fullscreen) screen mode: a hidden run that gets killed must never count as a failed fullscreen start.
const child = pty.spawn('node.exe', [path.join(process.env.USERPROFILE, '.claude', 'tools', 'claude-pictures', 'index.cjs'), '--session-id', sessionId, '--settings', '{"tui":"default"}'], {
  name: 'xterm-256color', cols, rows, cwd: __dirname, useConptyDll: true,
  // A fresh tab's environment: nothing inherited from a Claude Code session running this test.
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k))), CLAUDE_PICTURES_LOG: logFile },
})
child.onData(d => { chunks.push(Buffer.from(d, 'utf8')); term.write(d) })
const wait = ms => new Promise(r => setTimeout(r, ms))
const screen = () => {
  const b = term.buffer.active, lines = []
  for (let y = 0; y < rows; y++) lines.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '')
  return lines.join('\n')
}

;(async () => {
  // Answer the translator's cell-size question the way Windows Terminal would.
  setTimeout(() => child.write('\x1b[6;20;10t'), 1500)
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
  child.write('look at this [Image #1]')
  await wait(5000)
  const text = Buffer.concat(chunks).toString('utf8')
  const sixels = text.match(/\x1bP[0-9;]*q[^]*?\x1b\\/g) || []
  console.log(`Sixel pictures reached the outside: ${sixels.length}`)
  for (const s of sixels.slice(0, 3)) console.log('  size line:', (s.match(/"\d+;\d+;\d+;\d+/) || ['?'])[0], 'bytes', s.length)
  console.log('placeholder cells leaked:', (text.match(/\u{10EEEE}/gu) || []).length)
  console.log('kitty codes leaked:', (text.match(/\x1b_G/g) || []).length)
  const i = text.indexOf('\x1bP')
  if (i >= 0) console.log('before the picture:', JSON.stringify(text.slice(Math.max(0, i - 60), i)))
  console.log('--- screen bottom:')
  console.log(screen().split('\n').slice(-15).join('\n'))
  console.log('--- translator log:')
  try { console.log(fs.readFileSync(logFile, 'utf8')) } catch {}
  child.write('\x15')
  await wait(300)
  child.write('\x03'); await wait(300); child.write('\x03')
  await wait(1500)
  child.kill()
  fs.rmSync(path.dirname(path.dirname(cacheDir)), { recursive: true, force: true })
  process.exit(0)
})()
