// A small PNG decoder for terminals that can't draw pictures. A mod has no zlib, so this
// carries its own inflate. It box-averages the picture down to a thumbnail as it unfilters,
// so a screenshot never has to sit in memory as RGBA.

export type Thumb = { width: number; height: number; rgb: Uint8Array }

// The longest side of the stored thumbnail, in pixels: more than any tile can show.
const THUMB_SIDE = 96
// What transparent pixels are composited over (the dark of most terminal themes).
const BACKDROP = 0x1e
// Refuse a picture whose raw scanlines would be bigger than this (an Adam7-free 8k x 8k RGBA).
const MAX_RAW_BYTES = 256 * 1024 * 1024

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

type Huffman = { table: Uint32Array; bits: number }

/** A lookup table indexed by the next `bits` input bits: (code length << 16) | symbol. */
function huffman(lengths: ArrayLike<number>): Huffman {
  let bits = 0
  const count = new Array<number>(16).fill(0)
  for (let i = 0; i < lengths.length; i++) {
    count[lengths[i]!]!++
    if (lengths[i]! > bits) bits = lengths[i]!
  }
  count[0] = 0
  const next = new Array<number>(16).fill(0)
  for (let len = 1, code = 0; len < 16; len++) {
    code = (code + count[len - 1]!) << 1
    next[len] = code
  }
  const size = 1 << Math.max(bits, 1)
  const table = new Uint32Array(size)
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const len = lengths[symbol]!
    if (len === 0) continue
    let code = next[len]!++
    let reversed = 0
    for (let i = 0; i < len; i++, code >>= 1) reversed = (reversed << 1) | (code & 1)
    for (let at = reversed; at < size; at += 1 << len) table[at] = (len << 16) | symbol
  }
  return { table, bits: Math.max(bits, 1) }
}

let fixedLiterals: Huffman | undefined
let fixedDistances: Huffman | undefined

/** Inflate a zlib stream into exactly `size` bytes; null when it is malformed or short. */
export function inflate(input: Uint8Array, size: number): Uint8Array | null {
  if (input.length < 2 || (input[0]! & 0x0f) !== 8) return null
  const out = new Uint8Array(size)
  let pos = 2
  let written = 0
  let buffer = 0
  let held = 0

  const need = (n: number) => {
    while (held < n) {
      buffer |= (pos < input.length ? input[pos]! : 0) << held
      pos++
      held += 8
    }
  }
  const take = (n: number) => {
    if (n === 0) return 0
    need(n)
    const value = buffer & ((1 << n) - 1)
    buffer >>>= n
    held -= n
    return value
  }
  const decode = ({ table, bits }: Huffman) => {
    need(bits)
    const entry = table[buffer & ((1 << bits) - 1)]!
    const len = entry >>> 16
    if (len === 0) return -1
    buffer >>>= len
    held -= len
    return entry & 0xffff
  }

  let last = false
  while (!last) {
    if (pos > input.length + 4) return null
    last = take(1) === 1
    const type = take(2)
    if (type === 0) {
      take(held & 7)
      const len = take(16)
      take(16)
      for (let i = 0; i < len && written < size; i++) out[written++] = take(8)
      continue
    }
    let literals: Huffman
    let distances: Huffman
    if (type === 1) {
      if (!fixedLiterals || !fixedDistances) {
        const lengths = new Uint8Array(288)
        lengths.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288)
        fixedLiterals = huffman(lengths)
        fixedDistances = huffman(new Uint8Array(30).fill(5))
      }
      literals = fixedLiterals
      distances = fixedDistances
    } else if (type === 2) {
      const nLiterals = take(5) + 257
      const nDistances = take(5) + 1
      const nCodes = take(4) + 4
      const codeLengths = new Uint8Array(19)
      for (let i = 0; i < nCodes; i++) codeLengths[CODE_LENGTH_ORDER[i]!] = take(3)
      const codes = huffman(codeLengths)
      const lengths = new Uint8Array(nLiterals + nDistances)
      for (let i = 0; i < lengths.length; ) {
        const symbol = decode(codes)
        if (symbol < 0) return null
        if (symbol < 16) {
          lengths[i++] = symbol
          continue
        }
        const repeat = symbol === 16 ? 3 + take(2) : symbol === 17 ? 3 + take(3) : 11 + take(7)
        const value = symbol === 16 ? lengths[i - 1]! : 0
        if (symbol === 16 && i === 0) return null
        for (let r = 0; r < repeat && i < lengths.length; r++) lengths[i++] = value
      }
      literals = huffman(lengths.subarray(0, nLiterals))
      distances = huffman(lengths.subarray(nLiterals))
    } else {
      return null
    }

    for (;;) {
      const symbol = decode(literals)
      if (symbol < 0) return null
      if (symbol < 256) {
        if (written >= size) return null
        out[written++] = symbol
        continue
      }
      if (symbol === 256) break
      const lengthIndex = symbol - 257
      if (lengthIndex >= 29) return null
      const length = LENGTH_BASE[lengthIndex]! + take(LENGTH_EXTRA[lengthIndex]!)
      const distanceSymbol = decode(distances)
      if (distanceSymbol < 0 || distanceSymbol >= 30) return null
      const distance = DISTANCE_BASE[distanceSymbol]! + take(DISTANCE_EXTRA[distanceSymbol]!)
      if (distance > written || written + length > size) return null
      for (let i = 0; i < length; i++, written++) out[written] = out[written - distance]!
    }
  }
  return written === size ? out : null
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
// Samples per pixel by PNG color type: gray, -, RGB, palette, gray + alpha, -, RGBA.
const CHANNELS = [1, 0, 3, 1, 2, 0, 4]

/**
 * Decode a PNG into a small RGB thumbnail (longest side at most THUMB_SIDE), or null when it
 * isn't a PNG, is interlaced, or is malformed. Transparent pixels are composited over a dark backdrop.
 */
export function decodeThumb(png: Uint8Array): Thumb | null {
  if (png.length < 33 || SIGNATURE.some((byte, i) => png[i] !== byte)) return null
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)

  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let palette = new Uint8Array(0)
  let paletteAlpha = new Uint8Array(0)
  const data: Uint8Array[] = []
  for (let at = 8; at + 8 <= png.length; ) {
    const length = view.getUint32(at)
    const name = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!)
    const body = png.subarray(at + 8, at + 8 + length)
    if (body.length < length) return null
    if (name === 'IHDR' && length >= 13) {
      width = view.getUint32(at + 8)
      height = view.getUint32(at + 12)
      depth = body[8]!
      colorType = body[9]!
      if (body[10] !== 0 || body[11] !== 0 || body[12] !== 0) return null // not deflate, or interlaced
    } else if (name === 'PLTE') palette = body
    else if (name === 'tRNS') paletteAlpha = body
    else if (name === 'IDAT') data.push(body)
    else if (name === 'IEND') break
    at += 12 + length
  }
  const channels = CHANNELS[colorType] ?? 0
  if (width === 0 || height === 0 || channels === 0 || ![1, 2, 4, 8, 16].includes(depth)) return null
  if (colorType === 3 && (palette.length === 0 || depth === 16)) return null

  const bitsPerPixel = channels * depth
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const step = Math.max(1, bitsPerPixel >> 3)
  if ((stride + 1) * height > MAX_RAW_BYTES) return null

  const joined = new Uint8Array(data.reduce((sum, chunk) => sum + chunk.length, 0))
  for (let i = 0, offset = 0; i < data.length; offset += data[i]!.length, i++) joined.set(data[i]!, offset)
  const raw = inflate(joined, (stride + 1) * height)
  if (!raw) return null

  const scale = Math.min(1, THUMB_SIDE / Math.max(width, height))
  const tw = Math.max(1, Math.round(width * scale))
  const th = Math.max(1, Math.round(height * scale))
  const sums = new Float64Array(tw * th * 3)
  const counts = new Uint32Array(tw * th)
  const columnOf = new Uint16Array(width)
  for (let x = 0; x < width; x++) columnOf[x] = Math.min(tw - 1, Math.floor((x * tw) / width))

  const max = (1 << Math.min(depth, 8)) - 1
  const unit = depth === 16 ? 1 : 255 / max
  let prior = new Uint8Array(stride)
  let line = new Uint8Array(stride)
  const sample = (x: number, channel: number) => {
    if (depth === 8) return line[x * channels + channel]!
    if (depth === 16) return line[(x * channels + channel) * 2]!
    const bit = (x * channels + channel) * depth
    return (line[bit >> 3]! >> (8 - depth - (bit & 7))) & max
  }

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const left = i >= step ? line[i - step]! : 0
      const up = prior[i]!
      const upLeft = i >= step ? prior[i - step]! : 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      } else if (filter !== 0) return null
      line[i] = (source[i]! + predicted) & 0xff
    }

    const row = Math.min(th - 1, Math.floor((y * th) / height))
    for (let x = 0; x < width; x++) {
      let r: number
      let g: number
      let b: number
      let a = 255
      if (colorType === 2 || colorType === 6) {
        r = sample(x, 0)
        g = sample(x, 1)
        b = sample(x, 2)
        if (colorType === 6) a = sample(x, 3)
      } else if (colorType === 3) {
        const index = sample(x, 0)
        r = palette[index * 3] ?? 0
        g = palette[index * 3 + 1] ?? 0
        b = palette[index * 3 + 2] ?? 0
        a = paletteAlpha[index] ?? 255
      } else {
        r = g = b = Math.round(sample(x, 0) * unit)
        if (colorType === 4) a = sample(x, 1)
      }
      if (a < 255) {
        r = (r * a + BACKDROP * (255 - a)) / 255
        g = (g * a + BACKDROP * (255 - a)) / 255
        b = (b * a + BACKDROP * (255 - a)) / 255
      }
      const cell = row * tw + columnOf[x]!
      sums[cell * 3] += r
      sums[cell * 3 + 1] += g
      sums[cell * 3 + 2] += b
      counts[cell]!++
    }
    ;[prior, line] = [line, prior]
  }

  const rgb = new Uint8Array(tw * th * 3)
  for (let cell = 0; cell < tw * th; cell++) {
    const n = counts[cell] || 1
    for (let c = 0; c < 3; c++) rgb[cell * 3 + c] = Math.round(sums[cell * 3 + c]! / n)
  }
  return { width: tw, height: th, rgb }
}
