'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { PNG } = require('pngjs')
const { decode: decodeSixel } = require('sixel')
const { Translator, foregroundOf, escapeEnd } = require('../translate.cjs')

const ESC = '\x1b'
const ST = `${ESC}\\`
const CELL = '\u{10EEEE}'
const MARK = ['̅', '̍', '̎', '̐'] // 0, 1, 2, 3

function png(width, height, colour) {
  const image = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) image.data.set([...colour, 255], i * 4)
  return PNG.sync.write(image)
}

function placeholders(rows, cols) {
  let out = ''
  for (let r = 0; r < rows; r++) {
    out += `${ESC}[12;5H`
    for (let c = 0; c < cols; c++) out += CELL + MARK[r] + MARK[c]
  }
  return out
}

function translator() {
  return new Translator({ cellWidth: 8, cellHeight: 16 })
}

test('plain text and ordinary escape sequences pass through untouched', () => {
  const t = translator()
  const input = `hello ${ESC}[31mred${ESC}[0m\r\n${ESC}]8;;https://x${ESC}\\link${ESC}]8;;\x07 ${ESC}7${ESC}8${ESC}(B`
  assert.equal(t.push(input), input)
  assert.equal(t.flush(), '')
})

test('foreground colour parsing finds the picture id', () => {
  assert.equal(foregroundOf('38;2;63;164;183'), 4170935)
  assert.equal(foregroundOf('1;38;5;42'), 42)
  assert.equal(foregroundOf('38:2::63:164:183'), 4170935)
  assert.equal(foregroundOf('39'), null)
  assert.equal(foregroundOf(''), null)
  assert.equal(foregroundOf('1;4'), undefined)
})

test('escape sequences are measured, and cut-off ones reported', () => {
  assert.equal(escapeEnd(`${ESC}[1;2H`, 0), 6)
  assert.equal(escapeEnd(`${ESC}[1;2`, 0), -1)
  assert.equal(escapeEnd(`${ESC}_Gi=1;AAAA${ST}`, 0), 13)
  assert.equal(escapeEnd(`${ESC}_Gi=1;AAAA`, 0), -1)
  assert.equal(escapeEnd(`${ESC}]0;title\x07`, 0), 10)
  assert.equal(escapeEnd(`${ESC}7`, 0), 2)
})

test('a transmitted picture is drawn as Sixel where its placeholder starts, and the cells are skipped', () => {
  const t = translator()
  const data = png(4, 4, [255, 0, 0]).toString('base64')
  const apc = `${ESC}_Ga=T,U=1,q=2,f=100,t=d,i=42,c=3,r=2;${data}${ST}`
  const out = t.push(`${apc}${ESC}[38;5;42m${placeholders(2, 3)}${ESC}[39m|`)
  assert.ok(!out.includes(ESC + '_G'), 'the transmission is not forwarded')
  assert.ok(!out.includes(CELL), 'placeholder cells are not forwarded')
  // Clear the 3x2 box, draw, restore, then step over the three cells of the first row.
  const draw = `${ESC}7${ESC}[3X${ESC}[1B${ESC}[3X${ESC}8`
  const start = out.indexOf(draw)
  assert.ok(start >= 0, 'box is cleared before drawing')
  const sixelStart = out.indexOf(`${ESC}P`, start)
  const sixelEnd = out.indexOf(ST, sixelStart) + 2
  assert.ok(sixelStart > 0 && sixelEnd > sixelStart, 'a Sixel picture follows')
  assert.equal(out.slice(sixelEnd, sixelEnd + 2), ESC + '8', 'cursor goes back to the top-left cell')
  assert.ok(out.includes(`${ESC}8${ESC}[3C`), 'the cursor steps over the first row')
  assert.ok(out.endsWith(`${ESC}[12;5H${ESC}[3C${ESC}[39m|`), 'the second row is just stepped over')
  const sixel = out.slice(sixelStart, sixelEnd)
  // The Sixel is the size of the whole box (3x2 cells of 8x16 px), with a see-through background.
  assert.ok(sixel.startsWith(`${ESC}P0;1;q`), 'unpainted pixels are left alone')
  assert.match(sixel, /"1;1;24;32/)
  // Its one palette colour is pure red (Sixel colours are percentages).
  assert.match(sixel, /#0;2;100;0;0/)
  // The square picture is 24x24, centred: 4 px of untouched canvas above and below it.
  // (The reader rounds the size up to whole bands, so only the painted rows are checked.)
  const decoded = decodeSixel(sixel, { fillColor: 0 })
  assert.ok(decoded.height >= 32 && decoded.width >= 24, 'a Sixel reader accepts it')
  const painted = y => decoded.data32[y * decoded.width + 12] !== 0
  assert.deepEqual([painted(3), painted(4), painted(27), painted(28)], [false, true, true, false])
})

/** Cursor steps split across chunks (`ESC[1C ESC[1C`) and merged ones (`ESC[2C`) land in the same place. */
function mergeSteps(s) {
  return s.replace(/(?:\x1b\[\d+C)+/g, run => `\x1b[${[...run.matchAll(/\d+/g)].reduce((sum, m) => sum + Number(m[0]), 0)}C`)
}

test('the same picture arriving in pieces draws the same thing', () => {
  const data = png(4, 4, [0, 0, 255]).toString('base64')
  const whole = `${ESC}_Ga=T,U=1,q=2,f=100,t=d,i=7,c=2,r=1;${data}${ST}${ESC}[38;5;7m${placeholders(1, 2)}${ESC}[39m`
  const one = translator()
  const expected = one.push(whole) + one.flush()
  const two = translator()
  let got = ''
  for (let cut = 0; cut < whole.length; cut += 7) got += two.push(whole.slice(cut, cut + 7))
  got += two.flush()
  assert.equal(mergeSteps(got), mergeSteps(expected))
  assert.match(expected, /#0;2;0;0;100/, 'the picture is blue')
})

test('chunked transmissions are joined before decoding', () => {
  const t = translator()
  const data = png(2, 2, [0, 255, 0]).toString('base64')
  const half = Math.ceil(data.length / 2)
  const out = t.push(
    `${ESC}_Ga=T,U=1,q=2,f=100,t=d,i=9,c=1,r=1,m=1;${data.slice(0, half)}${ST}` +
      `${ESC}_Gm=0;${data.slice(half)}${ST}${ESC}[38;5;9m${CELL}${MARK[0]}${MARK[0]}${ESC}[39m`,
  )
  assert.ok(out.includes(`${ESC}P`), 'drawn')
})

test('placeholders for a picture nobody transmitted, or one since deleted, are only stepped over', () => {
  const t = translator()
  const out = t.push(`${ESC}[38;5;5m${CELL}${MARK[0]}${MARK[0]}${CELL}${MARK[0]}${MARK[1]}${ESC}[39m`)
  assert.equal(out, `${ESC}[38;5;5m${ESC}[2C${ESC}[39m`)
  const data = png(2, 2, [0, 255, 0]).toString('base64')
  t.push(`${ESC}_Ga=T,U=1,q=2,f=100,t=d,i=5,c=1,r=1;${data}${ST}${ESC}_Ga=d,d=I,i=5,q=2${ST}`)
  assert.equal(t.push(`${ESC}[38;5;5m${CELL}${MARK[0]}${MARK[0]}${ESC}[39m`), `${ESC}[38;5;5m${ESC}[1C${ESC}[39m`)
})

test('cells without marks inherit their place from the cell to the left', () => {
  const t = translator()
  const data = png(2, 2, [0, 255, 0]).toString('base64')
  t.push(`${ESC}_Ga=T,U=1,q=2,f=100,t=d,i=3,c=3,r=1;${data}${ST}`)
  const out = t.push(`${ESC}[38;5;3m${CELL}${MARK[0]}${CELL}${CELL}${ESC}[39m`)
  assert.ok(out.includes(`${ESC}P`), 'drawn at the first cell')
  assert.ok(out.endsWith(`${ESC}8${ESC}[3C${ESC}[39m`), 'all three cells stepped over')
})

test('a cut-off escape sequence waits for the rest, then goes through whole', () => {
  const t = translator()
  assert.equal(t.push(`ab${ESC}[12`), 'ab')
  assert.equal(t.push(`;5Hcd`), `${ESC}[12;5Hcd`)
  assert.equal(t.push(`${ESC}]0;half`), '')
  assert.equal(t.flush(), `${ESC}]0;half`)
})
