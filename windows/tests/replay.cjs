// Replays a raw terminal capture into a headless terminal and prints the final screen,
// with picture placeholder cells shown as '#'.
const { Terminal } = require('@xterm/headless')
const fs = require('fs')
const raw = fs.readFileSync(process.argv[2]).toString('utf8')
const cols = 120, rows = 40
const term = new Terminal({ cols, rows, allowProposedApi: true })
term.write(raw, () => {
  const b = term.buffer.active
  const lines = []
  for (let y = 0; y < rows; y++) {
    const line = (b.getLine(b.viewportY + y)?.translateToString(true) ?? '').replace(/\u{10EEEE}[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯\u{1d165}-\u{1d244}]*/gu, '#')
    lines.push(line)
  }
  let last = lines.length - 1
  while (last > 0 && lines[last].trim() === '') last--
  console.log(lines.slice(Math.max(0, last - 16), last + 1).map(l => l.slice(0, 70)).join('\n'))
})
