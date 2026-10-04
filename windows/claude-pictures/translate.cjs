'use strict'
// The translator core: takes the byte stream Claude Code sends to its terminal and rewrites the
// parts Windows Terminal cannot show.
//
// Claude Code draws a picture the kitty way: one escape code transmits the picture (a file path or
// the bytes), then the cells where it should appear are written as placeholder characters
// (U+10EEEE plus row/column marks, with the picture id in the text colour). Windows Terminal knows
// neither, but it does draw Sixel pictures. So here:
//   - the transmission is kept in memory instead of being forwarded;
//   - when the placeholder for the picture's top-left cell goes by, the box is cleared and the
//     picture is drawn there as Sixel, right at the cursor, which is exactly on that cell;
//   - every placeholder cell is swallowed and replaced by a cursor move, so the terminal never
//     writes over the pixels. When Claude later writes other text there, the pixels go with it.
// Everything else passes through untouched.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { StringDecoder } = require('string_decoder')
const { sixelEncode, introducer, FINALIZER, fromRGBA8888 } = require('sixel')
const { reduce } = require('sixel/lib/Quantizer')
const { decode, resize, encodePng } = require('./png.cjs')
const DIACRITICS = require('./diacritics.json')

/**
 * Encodes an opaque picture as Sixel on a see-through canvas of `boxWidth` x `boxHeight`, centred
 * to the pixel. Untouched canvas pixels are left as they are (P2=1), so only the picture shows.
 */
function toSixel({ width, height, rgba }, boxWidth, boxHeight) {
  const { indices, palette } = reduce(rgba, width, 256)
  const colours = palette.map(entry => (typeof entry === 'number' ? fromRGBA8888(entry) : entry))
  const canvas = new Uint8Array(boxWidth * boxHeight * 4)
  const left = Math.floor((boxWidth - width) / 2)
  const top = Math.floor((boxHeight - height) / 2)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colours[indices[y * width + x]]
      const o = ((top + y) * boxWidth + left + x) * 4
      canvas[o] = r
      canvas[o + 1] = g
      canvas[o + 2] = b
      canvas[o + 3] = 255
    }
  }
  return introducer(1) + sixelEncode(canvas, boxWidth, boxHeight, palette) + FINALIZER
}

const ESC = '\x1b'
const PLACEHOLDER = 0x10eeee
const DIACRITIC_INDEX = new Map(DIACRITICS.map((cp, i) => [cp, i]))
// Held-back text is forwarded raw past this size rather than waiting forever for a terminator.
const MAX_CARRY = 1 << 20

/** `a=T,q=1,i=42` -> { a: 'T', q: '1', i: '42' } */
function parseKeys(control) {
  const keys = {}
  for (const part of control.split(',')) {
    const eq = part.indexOf('=')
    if (eq > 0) keys[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return keys
}

/**
 * The picture id an SGR parameter list selects as the text colour: a number for 38;5;n or
 * 38;2;r;g;b (also the colon forms), null when it resets the colour, undefined when it leaves it.
 */
function foregroundOf(params) {
  let result
  const items = params === '' ? ['0'] : params.split(';')
  for (let i = 0; i < items.length; i++) {
    const sub = items[i].split(':')
    const code = sub[0] === '' ? '0' : sub[0]
    if (code === '0' || code === '39') result = null
    else if (code === '38') {
      if (sub.length > 1) {
        if (sub[1] === '5') result = Number(sub[2])
        else if (sub[1] === '2') {
          const [r, g, b] = sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5)
          result = Number(r) * 65536 + Number(g) * 256 + Number(b)
        }
      } else if (items[i + 1] === '5') {
        result = Number(items[i + 2])
        i += 2
      } else if (items[i + 1] === '2') {
        result = Number(items[i + 2]) * 65536 + Number(items[i + 3]) * 256 + Number(items[i + 4])
        i += 4
      }
    }
  }
  return result
}

/** True when an SGR parameter list turns on reverse video (`7`). */
function hasReverse(params) {
  return params.split(';').includes('7')
}

/**
 * Whether the text at `from` (after any further SGR sequences) is the open label the picture mod
 * draws under a tile: `#1 · open` (one to three digits), or just `#1` on a narrow tile.
 * 'wait' means the chunk ends before that can be known.
 */
function labelFollows(text, from) {
  let j = from
  while (j < text.length && text.charCodeAt(j) === 0x1b) {
    const end = escapeEnd(text, j)
    if (end < 0) return 'wait'
    if (!(text[j + 1] === '[' && text[end - 1] === 'm')) return 'no'
    j = end
  }
  if (j >= text.length) return 'wait'
  if (text[j] !== '#') return 'no'
  // One to three digits after the '#'.
  let k = j + 1
  while (k < text.length && k - j <= 3 && text[k] >= '0' && text[k] <= '9') k++
  if (k >= text.length) return 'wait'
  if (k === j + 1) return 'no'
  // `#1` followed by an escape sequence: the short label of a narrow tile.
  if (text.charCodeAt(k) === 0x1b) return 'yes'
  const rest = ' · open'
  for (let m = 0; m < rest.length; m++) {
    if (k + m >= text.length) return 'wait'
    if (text[k + m] !== rest[m]) return 'no'
  }
  return 'yes'
}

/** Where the escape sequence starting at text[i] ends (exclusive), or -1 when it is cut off. */
function escapeEnd(text, i) {
  if (i + 1 >= text.length) return -1
  const c = text[i + 1]
  if (c === '[') {
    let j = i + 2
    while (j < text.length && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f) j++
    while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++
    return j >= text.length ? -1 : j + 1
  }
  if (c === ']') {
    for (let j = i + 2; j < text.length; j++) {
      const ch = text.charCodeAt(j)
      if (ch === 0x07) return j + 1
      if (ch === 0x1b) return j + 1 >= text.length ? -1 : text[j + 1] === '\\' ? j + 2 : j
    }
    return -1
  }
  if (c === 'P' || c === '_' || c === '^' || c === 'X') {
    const j = text.indexOf(ESC + '\\', i + 2)
    return j < 0 ? -1 : j + 2
  }
  const code = c.charCodeAt(0)
  if (code >= 0x20 && code <= 0x2f) {
    let j = i + 2
    while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++
    return j >= text.length ? -1 : j + 1
  }
  return i + 2
}

class Translator {
  constructor({ cellWidth = 10, cellHeight = 20, log } = {}) {
    this.cell = { width: cellWidth, height: cellHeight }
    this.images = new Map()
    this.pending = null
    this.decoder = new StringDecoder('utf8')
    this.carry = ''
    this.cuf = 0
    this.fg = null
    this.lastCell = null
    // Cursor-position questions in flight, oldest first: a picture waiting to learn where it was
    // drawn, or null for a question Claude asked itself (its answer is passed on).
    this.positions = []
    this.log = log || (() => {})
  }

  /**
   * The terminal's answer to a cursor-position question (1-based row and column). Returns true
   * when it answered one of ours, which then records where that picture sits on screen.
   */
  answerPosition(row, col) {
    const head = this.positions.shift()
    if (!head) return false
    head.rect = { row, col }
    this.log(`picture ${head.id} sits at row ${row} col ${col}`)
    return true
  }

  /** The picture drawn under screen cell (x, y), counting the label row beneath it, or null. */
  imageAt(x, y) {
    for (const image of this.images.values()) {
      const { rect } = image
      if (!rect) continue
      if (y >= rect.row && y <= rect.row + image.rows && x >= rect.col && x < rect.col + image.cols) return image
    }
    return null
  }

  /** A file on disk holding the picture, for opening it in a viewer. */
  pictureFile(image) {
    if (image.source.kind === 'file') return image.source.path
    if (!image.openFile) {
      const dir = path.join(os.tmpdir(), 'claude-pictures')
      fs.mkdirSync(dir, { recursive: true })
      image.openFile = path.join(dir, `${image.id}.png`)
      if (image.format === 100 && image.raw) fs.writeFileSync(image.openFile, image.raw)
      else {
        image.pixels ??= decode(this.readSource(image), image.format, image.width, image.height, image.compressed)
        fs.writeFileSync(image.openFile, encodePng(image.pixels))
      }
    }
    return image.openFile
  }

  /** Cell size in pixels, from the terminal's own report; redraws use it from then on. */
  setCellSize(width, height) {
    if (width > 0 && height > 0 && (width !== this.cell.width || height !== this.cell.height)) {
      this.cell = { width, height }
      for (const image of this.images.values()) image.sixel.clear()
      this.log(`cell size ${width}x${height}`)
    }
  }

  /** Translates a chunk from Claude; returns what to write to the terminal. */
  push(chunk) {
    const text = this.carry + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk))
    this.carry = ''
    return this.process(text, false)
  }

  /** Lets any held-back text through, for when the stream has gone quiet. */
  flush() {
    const text = this.carry + this.decoder.end()
    this.carry = ''
    this.decoder = new StringDecoder('utf8')
    return text ? this.process(text, true) : ''
  }

  process(text, final) {
    let out = ''
    const n = text.length
    let i = 0
    const flushCuf = () => {
      if (this.cuf > 0) {
        out += `${ESC}[${this.cuf}C`
        this.cuf = 0
      }
    }
    while (i < n) {
      if (text.charCodeAt(i) === 0x1b) {
        const end = escapeEnd(text, i)
        if (end < 0) {
          if (final || n - i > MAX_CARRY) {
            flushCuf()
            out += text.slice(i)
          } else this.carry = text.slice(i)
          break
        }
        const seq = text.slice(i, end)
        this.lastCell = null
        if (seq[1] === '_' && seq[2] === 'G') this.handleApc(seq.slice(3, -2))
        else {
          let emit = seq
          if (seq[1] === '[' && seq[seq.length - 1] === 'm') {
            const params = seq.slice(2, -1)
            const fg = foregroundOf(params)
            if (fg !== undefined) this.fg = fg
            // The open label under a tile is never drawn in reverse video: Claude flips a button
            // under the pointer, and the label should keep still.
            if (this.images.size > 0 && hasReverse(params)) {
              const verdict = labelFollows(text, end)
              if (verdict === 'wait' && !final && n - i <= MAX_CARRY) {
                this.carry = text.slice(i)
                break
              }
              if (verdict === 'yes') {
                const kept = params.split(';').filter(p => p !== '7')
                emit = kept.length ? `${ESC}[${kept.join(';')}m` : ''
              }
            }
          } else if (seq === `${ESC}[6n`) this.positions.push(null)
          flushCuf()
          out += emit
        }
        i = end
        continue
      }
      const cp = text.codePointAt(i)
      if (cp >= 0xd800 && cp <= 0xdbff && i === n - 1 && !final) {
        // Half of a character that straddles two chunks: wait for the other half.
        this.carry = text.slice(i)
        break
      }
      if (cp === PLACEHOLDER) {
        let j = i + 2
        const marks = []
        while (marks.length < 3 && j < n) {
          const m = text.codePointAt(j)
          const idx = DIACRITIC_INDEX.get(m)
          if (idx === undefined) break
          marks.push(idx)
          j += m > 0xffff ? 2 : 1
        }
        if (j >= n && marks.length < 3 && !final) {
          this.carry = text.slice(i)
          break
        }
        out += this.placeholder(marks, flushCuf)
        i = j
        continue
      }
      this.lastCell = null
      flushCuf()
      let j = i + (cp > 0xffff ? 2 : 1)
      while (j < n && text.charCodeAt(j) !== 0x1b) {
        const next = text.codePointAt(j)
        if (next === PLACEHOLDER) break
        j += next > 0xffff ? 2 : 1
      }
      out += text.slice(i, j)
      i = j
    }
    flushCuf()
    return out
  }

  /** One placeholder cell: swallowed, the cursor moved past it, and the picture drawn at (0, 0). */
  placeholder(marks, flushCuf) {
    const last = this.lastCell
    const fg = this.fg
    // Missing marks are inherited from the cell to the left, as kitty does; a cell with nothing
    // to inherit from starts at the top-left.
    let [row, col, msb] = marks
    if (row === undefined) {
      if (last && last.fg === fg) ({ row, msb } = last), (col = last.col + 1)
      else (row = 0), (col = 0)
    } else if (col === undefined) {
      if (last && last.fg === fg && last.row === row) (col = last.col + 1), (msb ??= last.msb)
      else col = 0
    } else if (msb === undefined) {
      msb = last && last.fg === fg && last.row === row && last.col === col - 1 ? last.msb : 0
    }
    msb ??= 0
    this.lastCell = { fg, row, col, msb }
    let out = ''
    if (row === 0 && col === 0 && fg !== null && fg !== undefined) {
      const image = this.images.get(msb * 16777216 + fg)
      if (image) {
        flushCuf()
        out = this.draw(image)
      } else this.log(`placeholder for unknown picture ${msb * 16777216 + fg}`)
    }
    this.cuf++
    return out
  }

  /** Clears the box under the cursor, draws the picture centred in it, and puts the cursor back. */
  draw(image) {
    const drawing = this.sixelFor(image)
    if (!drawing) return ''
    let out = ESC + '7'
    for (let k = 0; k < image.rows; k++) {
      out += `${ESC}[${image.cols}X`
      if (k < image.rows - 1) out += `${ESC}[1B`
    }
    // Back at the top-left cell, ask the terminal where that is, so a click on the picture can be
    // told apart later; the answer is caught on the way in.
    this.positions.push(image)
    if (this.positions.length > 64) this.positions.shift()
    return out + ESC + '8' + `${ESC}[6n` + drawing.sixel + ESC + '8'
  }

  /**
   * The picture as a Sixel the exact size of the box: fitted with its shape kept and centred to the
   * pixel on a see-through canvas, so the gaps left and right (or above and below) are equal.
   */
  sixelFor(image) {
    const key = `${image.cols}x${image.rows}@${this.cell.width}x${this.cell.height}`
    if (image.sixel.has(key)) return image.sixel.get(key)
    let drawing = null
    try {
      image.pixels ??= decode(this.readSource(image), image.format, image.width, image.height, image.compressed)
      const boxWidth = Math.max(1, image.cols * this.cell.width)
      const boxHeight = Math.max(1, image.rows * this.cell.height)
      const scale = Math.min(boxWidth / image.pixels.width, boxHeight / image.pixels.height)
      const width = Math.min(boxWidth, Math.max(1, Math.round(image.pixels.width * scale)))
      const height = Math.min(boxHeight, Math.max(1, Math.round(image.pixels.height * scale)))
      const fitted = resize(image.pixels, width, height)
      drawing = { sixel: toSixel(fitted, boxWidth, boxHeight), width, height }
      this.log(`drew picture ${image.cols}x${image.rows} cells as ${width}x${height} px centred in ${boxWidth}x${boxHeight}, ${drawing.sixel.length} bytes`)
    } catch (error) {
      this.log(`could not draw picture: ${error.message}`)
    }
    image.sixel.set(key, drawing)
    return drawing
  }

  readSource(image) {
    const { source } = image
    if (source.kind === 'bytes') return (image.raw = source.bytes)
    const bytes = fs.readFileSync(source.path)
    if (source.kind === 'temp') {
      image.raw = bytes
      fs.rm(source.path, () => {})
    }
    return bytes
  }

  /** A kitty graphics command: the text between `ESC _ G` and `ESC \`. */
  handleApc(body) {
    const semi = body.indexOf(';')
    const control = semi < 0 ? body : body.slice(0, semi)
    const payload = semi < 0 ? '' : body.slice(semi + 1)
    const keys = parseKeys(control)
    if (this.pending) {
      this.pending.parts.push(payload)
      if (keys.m !== '1') {
        const { keys: first, parts } = this.pending
        this.pending = null
        this.register(first, { kind: 'bytes', bytes: Buffer.from(parts.join(''), 'base64') })
      }
      return
    }
    const action = keys.a ?? 't'
    this.log(`command ${control}`)
    if (action === 'q') return
    if (action === 'd') {
      const what = keys.d ?? 'a'
      if (what === 'i' || what === 'I') this.images.delete(Number(keys.i))
      else if (what === 'a' || what === 'A') this.images.clear()
      return
    }
    if (action === 'p') {
      const image = this.images.get(Number(keys.i))
      if (image) {
        if (keys.c) image.cols = Number(keys.c)
        if (keys.r) image.rows = Number(keys.r)
        image.sixel.clear()
      }
      return
    }
    if (action !== 'T' && action !== 't') return
    const medium = keys.t ?? 'd'
    if (medium === 'd') {
      if (keys.m === '1') this.pending = { keys, parts: [payload] }
      else this.register(keys, { kind: 'bytes', bytes: Buffer.from(payload, 'base64') })
    } else if (medium === 'f' || medium === 't') {
      this.register(keys, { kind: medium === 't' ? 'temp' : 'file', path: Buffer.from(payload, 'base64').toString('utf8') })
    } else this.log(`unsupported transfer ${medium}`)
  }

  register(keys, source) {
    const id = Number(keys.i)
    if (!id) return
    this.images.set(id, {
      id,
      source,
      format: Number(keys.f ?? 32),
      width: Number(keys.s ?? 0),
      height: Number(keys.v ?? 0),
      compressed: keys.o === 'z',
      cols: Number(keys.c ?? 0),
      rows: Number(keys.r ?? 0),
      pixels: undefined,
      sixel: new Map(),
    })
  }
}

module.exports = { Translator, foregroundOf, escapeEnd, parseKeys, labelFollows }
