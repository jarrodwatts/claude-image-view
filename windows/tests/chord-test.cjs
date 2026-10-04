// Runs the translator hidden with Claude Code inside (fullscreen), pastes a picture tag, hides the
// plugin panel with a click on "[-]", then presses ctrl+x followed by ctrl+a to show it again.
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const picture = process.argv[2]
const logFile = path.join(__dirname, 'chord-wrapper.log')
const sessionId = crypto.randomUUID()
const cacheDir = path.join(process.env.TEMP, 'claude', 'claude-pictures-chord', sessionId, 'images')
fs.mkdirSync(cacheDir, { recursive: true })
fs.copyFileSync(picture, path.join(cacheDir, '1.png'))
try { fs.unlinkSync(logFile) } catch {}

const cols = 120, rows = 40
const term = new Terminal({ cols, rows, allowProposedApi: true })
const child = pty.spawn('node.exe', [path.join(process.env.USERPROFILE, '.claude', 'tools', 'claude-pictures', 'index.cjs'), '--session-id', sessionId], {
  name: 'xterm-256color', cols, rows, cwd: __dirname, useConptyDll: true,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k))), CLAUDE_PICTURES_LOG: logFile, CLAUDE_PICTURES_DEBUG_INPUT: '1' },
})
child.onData(d => {
  term.write(d)
  if (d.includes('\x1b[c')) child.write('\x1b[?61;4;6;7;14;21;22;23;24;28;32;42c')
  if (d.includes('\x1b[?1004h')) child.write('\x1b[I')
})
const wait = ms => new Promise(r => setTimeout(r, ms))
const screen = () => {
  const b = term.buffer.active, lines = []
  for (let y = 0; y < rows; y++) lines.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '')
  return lines
}
const state = () => (screen().some(l => l.includes('open')) ? 'tile shown' : screen().some(l => l.includes('panel hidden')) ? 'panel hidden' : 'neither')

;(async () => {
  setTimeout(() => child.write('\x1b[6;20;10t'), 1500)
  for (let i = 0; i < 40; i++) {
    await wait(500)
    const s = screen().join('\n')
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
  console.log('1. after paste:', state())
  const before = screen()
  const row = before.findIndex(l => l.includes('[-]'))
  const col = row >= 0 ? before[row].indexOf('[-]') : -1
  if (row >= 0) {
    child.write(`\x1b[<0;${col + 2};${row + 1}M`)
    await wait(150)
    child.write(`\x1b[<0;${col + 2};${row + 1}m`)
  }
  await wait(2500)
  console.log('2. after clicking [-]:', state())
  // alt+i, as a terminal sends it (ESC then the letter).
  child.write('\x1bi')
  await wait(2500)
  console.log('3. after alt+i:', state())
  child.write('\x1bi')
  await wait(2500)
  console.log('3b. after alt+i again:', state())
  if (state() !== 'tile shown') {
    const now = screen()
    const r2 = now.findIndex(l => l.includes('panel hidden'))
    if (r2 >= 0) {
      child.write(`\x1b[<0;5;${r2 + 1}M`)
      await wait(150)
      child.write(`\x1b[<0;5;${r2 + 1}m`)
      await wait(2500)
      console.log('4. after clicking the hidden row:', state())
    }
  }
  child.write('\x15')
  await wait(300)
  child.write('/exit\r')
  await wait(4000)
  child.kill()
  fs.rmSync(path.dirname(path.dirname(cacheDir)), { recursive: true, force: true })
  process.exit(0)
})()
