'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const { PNG } = require('pngjs')
const { Translator, labelFollows } = require('../translate.cjs')

const ESC = '\x1b'
const ST = `${ESC}\\`
const CELL = '\u{10EEEE}'
const MARK = ['̅', '̍', '̎', '̐'] // 0, 1, 2, 3

function png(width, height, colour) {
  const image = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) image.data.set([...colour, 255], i * 4)
  return PNG.sync.write(image)
}

/** A translator with one 3x2-cell red picture (id 42) transmitted and drawn at cell (row 12, col 5). */
function drawn() {
  const t = new Translator({ cellWidth: 8, cellHeight: 16 })
  const data = png(4, 4, [255, 0, 0]).toString('base64')
  const out = t.push(`${ESC}_Ga=T,U=1,q=2,f=100,t=d,i=42,c=3,r=2;${data}${ST}${ESC}[38;5;42m${CELL}${MARK[0]}${MARK[0]}${ESC}[39m`)
  return { t, out }
}

test('drawing a picture asks where the cursor is, and the answer places the picture', () => {
  const { t, out } = drawn()
  assert.ok(out.includes(`${ESC}8${ESC}[6n${ESC}P`), 'the question sits between the cursor restore and the Sixel')
  assert.equal(t.answerPosition(12, 5), true, 'the answer is ours, not passed on')
  const image = t.images.get(42)
  assert.deepEqual(image.rect, { row: 12, col: 5 })
  assert.equal(t.imageAt(5, 12), image, 'top-left cell')
  assert.equal(t.imageAt(7, 13), image, 'bottom-right cell')
  assert.equal(t.imageAt(6, 14), image, 'the open label row under the picture')
  assert.equal(t.imageAt(8, 12), null, 'right of the picture')
  assert.equal(t.imageAt(5, 15), null, 'below the label row')
  assert.equal(t.imageAt(4, 12), null, 'left of the picture')
})

test("Claude's own cursor question is answered to Claude, in order", () => {
  const { t } = drawn()
  assert.equal(t.push(`${ESC}[6n`), `${ESC}[6n`, 'the question goes through')
  assert.equal(t.answerPosition(12, 5), true, 'first answer: our picture')
  assert.equal(t.answerPosition(3, 1), false, 'second answer: passed on to Claude')
  assert.equal(t.answerPosition(3, 1), false, 'an answer nobody asked for is passed on too')
})

test('a deleted picture no longer catches clicks', () => {
  const { t } = drawn()
  t.answerPosition(12, 5)
  t.push(`${ESC}_Ga=d,d=I,i=42,q=2${ST}`)
  assert.equal(t.imageAt(5, 12), null)
})

test('the open label is never drawn in reverse video', () => {
  const { t } = drawn()
  assert.equal(t.push(`${ESC}[7m#01 · open${ESC}[27m`), `#01 · open${ESC}[27m`, 'a plain flip is dropped')
  assert.equal(t.push(`${ESC}[7;1m#02 · open`), `${ESC}[1m#02 · open`, 'other attributes stay')
  assert.equal(t.push(`${ESC}[7m${ESC}[2m#03 · open`), `${ESC}[2m#03 · open`, 'colour codes between are looked past')
  assert.equal(t.push(`${ESC}[7mhello`), `${ESC}[7mhello`, 'other text keeps its flip')
  assert.equal(t.push(`${ESC}[7m#01 · opus`), `${ESC}[7m#01 · opus`, 'a near miss keeps its flip')
  assert.equal(t.push(`${ESC}[7m#04${ESC}[27m`), `#04${ESC}[27m`, 'the short label of a narrow tile')
  // Cut across chunks: the flip waits for the rest of the label.
  assert.equal(t.push(`${ESC}[7m#0`), '', 'held back')
  assert.equal(t.push(`5 · open`), `#05 · open`, 'then dropped once the label is whole')
  assert.equal(t.push(`${ESC}[7m#0`) + t.flush(), `${ESC}[7m#0`, 'at the end of the stream it goes through as is')
})

test('without any picture on screen, reverse video is left alone', () => {
  const t = new Translator()
  assert.equal(t.push(`${ESC}[7m#01 · open`), `${ESC}[7m#01 · open`)
})

test('labelFollows reads the label through colour codes', () => {
  assert.equal(labelFollows(`${ESC}[2m${ESC}[38;5;7m#12 · open`, 0), 'yes')
  assert.equal(labelFollows(`${ESC}[2m${ESC}[1`, 0), 'wait')
  assert.equal(labelFollows(`${ESC}[1B#12 · open`, 0), 'no')
  assert.equal(labelFollows('#1x', 0), 'no')
  // One, two or three digits: the upstream mod labels `#1`, a fork may label `#01`.
  assert.equal(labelFollows('#1 · open', 0), 'yes')
  assert.equal(labelFollows('#123 · open', 0), 'yes')
  assert.equal(labelFollows(`#7${ESC}[27m`, 0), 'yes')
  assert.equal(labelFollows('#1234 · open', 0), 'no')
  assert.equal(labelFollows('#', 0), 'wait')
  assert.equal(labelFollows('#1', 0), 'wait')
  assert.equal(labelFollows('#x', 0), 'no')
})

test('a one-digit label is kept still too', () => {
  const { t } = drawn()
  assert.equal(t.push(`${ESC}[7m#1 · open${ESC}[27m`), `#1 · open${ESC}[27m`)
  assert.equal(t.push(`${ESC}[7m#9${ESC}[27m`), `#9${ESC}[27m`)
})

test('a picture sent as bytes is saved to a file for opening', () => {
  const { t } = drawn()
  const file = t.pictureFile(t.images.get(42))
  assert.ok(file.endsWith('42.png'))
  assert.ok(fs.existsSync(file))
  assert.equal(PNG.sync.read(fs.readFileSync(file)).width, 4)
  const byFile = new Translator()
  byFile.register({ i: '7', f: '100', c: '1', r: '1' }, { kind: 'file', path: 'C:\\pics\\7.png' })
  assert.equal(byFile.pictureFile(byFile.images.get(7)), 'C:\\pics\\7.png')
})
