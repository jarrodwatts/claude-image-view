// Runs the translator hidden with Claude Code inside (fullscreen), pastes a picture tag, moves the
// pointer over the "#01 · open" label, and prints the escape codes Claude draws the label with,
// at rest and under the pointer.
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const picture = process.argv[2]
const logFile = path.join(__dirname, 'hover-wrapper.log')
const sessionId = crypto.randomUUID()
const cacheDir = path.join(process.env.TEMP, 'claude', 'claude-pictures-hover', sessionId, 'images')
fs.mkdirSync(cacheDir, { recursive: true })
fs.copyFileSync(picture, path.join(cacheDir, '1.png'))
try { fs.unlinkSync(logFile) } catch {}

const cols = 120, rows = 40
const term = new Terminal({ cols, rows, allowProposedApi: true })
let raw = ''
const child = pty.spawn('node.exe', [path.join(process.env.USERPROFILE, '.claude', 'tools', 'claude-pictures', 'index.cjs'), '--session-id', sessionId], {
  name: 'xterm-256color', cols, rows, cwd: __dirname, useConptyDll: true,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k))), CLAUDE_PICTURES_LOG: logFile, CLAUDE_PICTURES_DEBUG_INPUT: '1', IMAGE_VIEW_CLICK_LOG: path.join(__dirname, 'hover-click.log') },
})
let queue = Promise.resolve()
child.onData(d => {
  raw += d
  if (d.includes('\x1b[c')) child.write('\x1b[?61;4;6;7;14;21;22;23;24;28;32;42c')
  if (d.includes('\x1b[?1004h')) child.write('\x1b[I')
  // Windows Terminal answers a cursor-position question at that point of the stream; here the
  // headless screen does the same, so the chunk is fed up to each question before answering.
  const parts = d.split('\x1b[6n')
  parts.forEach((part, idx) => {
    queue = queue.then(() => new Promise(resolve => term.write(part, () => {
      if (idx < parts.length - 1) child.write(`\x1b[${term.buffer.active.cursorY + 1};${term.buffer.active.cursorX + 1}R`)
      resolve()
    })))
  })
})
const wait = ms => new Promise(r => setTimeout(r, ms))
const screen = () => {
  const b = term.buffer.active, lines = []
  for (let y = 0; y < rows; y++) lines.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '')
  return lines
}
const show = (label, text) => console.log(label, JSON.stringify(text))

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
  const row = before.findIndex(l => l.includes('open'))
  const col = row >= 0 ? before[row].indexOf('open') : -1
  console.log('label row:', row >= 0 ? JSON.stringify(before[row].slice(0, 20)) : 'not found')
  let at = raw.indexOf('#01')
  show('at rest:', raw.slice(Math.max(0, at - 70), at + 16))
  const mark = raw.length
  // Pointer moves onto the label (motion report, no button), then rests there.
  child.write(`\x1b[<35;${col + 1};${row + 1}M`)
  await wait(300)
  child.write(`\x1b[<35;${col + 2};${row + 1}M`)
  await wait(2500)
  const later = raw.slice(mark)
  at = later.lastIndexOf('#01')
  show('under the pointer:', at >= 0 ? later.slice(Math.max(0, at - 70), at + 16) : '(label not redrawn)')
  // A click on the picture itself (three rows up), then one on the label.
  child.write(`\x1b[<0;${col + 2};${row - 2}M`)
  await wait(150)
  child.write(`\x1b[<0;${col + 2};${row - 2}m`)
  await wait(1500)
  child.write(`\x1b[<0;${col + 2};${row + 1}M`)
  await wait(150)
  child.write(`\x1b[<0;${col + 2};${row + 1}m`)
  await wait(3000)
  let clicked = ''
  try { clicked = fs.readFileSync(path.join(__dirname, 'hover-click.log'), 'utf8') } catch {}
  console.log('clicks noted (picture, then label):', clicked.trim().split('\n').length + ' -> ' + JSON.stringify(clicked.trim()))
  child.write('\x15')
  await wait(300)
  child.write('/exit\r')
  await wait(4000)
  child.kill()
  fs.rmSync(path.dirname(path.dirname(cacheDir)), { recursive: true, force: true })
  process.exit(0)
})()
