// Runs the translator hidden with Claude Code inside, pastes a picture tag, then clicks the band's
// own "[-]" collapse control. If the tile disappears, clicks travel through the translator to Claude.
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const picture = process.argv[2]
const logFile = path.join(__dirname, 'click-wrapper.log')
const sessionId = crypto.randomUUID()
const cacheDir = path.join(process.env.TEMP, 'claude', 'claude-pictures-click', sessionId, 'images')
fs.mkdirSync(cacheDir, { recursive: true })
fs.copyFileSync(picture, path.join(cacheDir, '1.png'))
try { fs.unlinkSync(logFile) } catch {}

const cols = 120, rows = 40
const term = new Terminal({ cols, rows, allowProposedApi: true })
const child = pty.spawn('node.exe', [path.join(process.env.USERPROFILE, '.claude', 'tools', 'claude-pictures', 'index.cjs'), '--session-id', sessionId], {
  name: 'xterm-256color', cols, rows, cwd: __dirname, useConptyDll: true,
  // A fresh tab's environment: nothing inherited from the session running this test.
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k))), CLAUDE_PICTURES_LOG: logFile, CLAUDE_PICTURES_DEBUG_INPUT: '1' },
})
child.onData(d => {
  term.write(d)
  // Answer the terminal questions the way Windows Terminal does, so Claude treats this as a real terminal.
  if (d.includes('\x1b[c')) child.write('\x1b[?61;4;6;7;14;21;22;23;24;28;32;42c')
  if (d.includes('\x1b[?1004h')) child.write('\x1b[I')
})
const wait = ms => new Promise(r => setTimeout(r, ms))
const screen = () => {
  const b = term.buffer.active, lines = []
  for (let y = 0; y < rows; y++) lines.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '')
  return lines
}

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
  const before = screen()
  const row = before.findIndex(l => l.includes('[-]'))
  const col = row >= 0 ? before[row].indexOf('[-]') : -1
  console.log('tile shown before click:', before.some(l => l.includes('open')), '| [-] at row', row + 1, 'col', col + 2)
  if (row >= 0) {
    child.write(`\x1b[<0;${col + 2};${row + 1}M`)
    await wait(150)
    child.write(`\x1b[<0;${col + 2};${row + 1}m`)
  }
  await wait(3000)
  const after = screen()
  console.log('tile shown after click:', after.some(l => l.includes('open')))
  console.log('--- screen bottom before click (blank rows kept):')
  console.log(before.slice(row - 2, rows).map(l => '|' + l.slice(0, 40)).join('\n'))
  // Leave through the app's own exit so the run never counts as a failed fullscreen start.
  child.write('\x15')
  await wait(300)
  child.write('/exit\r')
  await wait(4000)
  child.kill()
  fs.rmSync(path.dirname(path.dirname(cacheDir)), { recursive: true, force: true })
  process.exit(0)
})()
