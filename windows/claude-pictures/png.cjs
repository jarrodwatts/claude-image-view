// Picture decoding and resizing for the translator: a PNG (or raw RGB/RGBA bytes) in, RGBA pixels out.
const { PNG } = require('pngjs')
const zlib = require('zlib')

/** Decodes a transmitted picture into { width, height, rgba }. `format` is kitty's f= value. */
function decode(bytes, format, width, height, compressed) {
  const data = compressed ? zlib.inflateSync(bytes) : bytes
  if (format === 100) {
    const png = PNG.sync.read(Buffer.from(data))
    return { width: png.width, height: png.height, rgba: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) }
  }
  if (format === 24) {
    const rgba = new Uint8Array(width * height * 4)
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      rgba[i * 4] = data[j]
      rgba[i * 4 + 1] = data[j + 1]
      rgba[i * 4 + 2] = data[j + 2]
      rgba[i * 4 + 3] = 255
    }
    return { width, height, rgba }
  }
  if (format === 32) return { width, height, rgba: new Uint8Array(data.buffer, data.byteOffset, width * height * 4) }
  throw new Error(`unsupported picture format f=${format}`)
}

/**
 * Shrinks or grows RGBA pixels to exactly `dw` x `dh` with a box filter (averages the source pixels
 * each output pixel covers, so shrunk screenshots stay smooth). Transparent pixels are composited
 * on `background` so the terminal gets opaque colours.
 */
function resize({ width, height, rgba }, dw, dh, background = [0, 0, 0]) {
  const out = new Uint8Array(dw * dh * 4)
  const sum = [0, 0, 0, 0]
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * height) / dh)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / dh))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * width) / dw)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / dw))
      sum[0] = sum[1] = sum[2] = sum[3] = 0
      let count = 0
      for (let sy = y0; sy < y1 && sy < height; sy++) {
        let i = (sy * width + x0) * 4
        for (let sx = x0; sx < x1 && sx < width; sx++, i += 4) {
          const a = rgba[i + 3] / 255
          sum[0] += rgba[i] * a + background[0] * (1 - a)
          sum[1] += rgba[i + 1] * a + background[1] * (1 - a)
          sum[2] += rgba[i + 2] * a + background[2] * (1 - a)
          count++
        }
      }
      const o = (y * dw + x) * 4
      out[o] = count ? Math.round(sum[0] / count) : background[0]
      out[o + 1] = count ? Math.round(sum[1] / count) : background[1]
      out[o + 2] = count ? Math.round(sum[2] / count) : background[2]
      out[o + 3] = 255
    }
  }
  return { width: dw, height: dh, rgba: out }
}

/** RGBA pixels as a PNG file's bytes. */
function encodePng({ width, height, rgba }) {
  const png = new PNG({ width, height })
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length)
  return PNG.sync.write(png)
}

module.exports = { decode, resize, encodePng }
