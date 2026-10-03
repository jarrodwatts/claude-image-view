export type Size = { width: number; height: number }
export type Cells = { columns: number; rows: number }

const TILE_ROWS = 6
const MAX_COLUMNS = 32
const MIN_COLUMNS = 4
// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2
// Used when the size is unknown (file over $.fs.read's 4 MiB cap, or no file).
const FALLBACK: Size = { width: 16, height: 10 }
// Each tile adds a border on every side and a label row under the picture.
const TILE_CHROME_ROWS = 3
const TILE_CHROME_COLUMNS = 2
const GAP = 1

/** The distinct image numbers a draft references, in the order they first appear. */
export function imageNumbers(draft: string): number[] {
  const seen = new Set<number>()
  for (const match of draft.matchAll(/\[Image #(\d+)\]/g)) seen.add(Number(match[1]))
  return [...seen]
}

/** Width and height from a PNG's IHDR chunk, or null when the bytes aren't a PNG. */
export function pngSize(base64: string): Size | null {
  // 24 bytes cover the signature and IHDR's width and height; 32 base64 chars decode to exactly 24.
  const head = Uint8Array.from(atob(base64.slice(0, 32)), char => char.charCodeAt(0))
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (head.length < 24 || signature.some((byte, i) => head[i] !== byte)) return null
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/** A picture box `rows` tall that keeps the picture's aspect ratio. */
export function fitCells(size: Size | null, tileRows = TILE_ROWS): Cells {
  const { width, height } = size ?? FALLBACK
  let rows = tileRows
  let columns = Math.round((rows * CELL_ASPECT * width) / height)
  if (columns > MAX_COLUMNS) {
    columns = MAX_COLUMNS
    rows = Math.max(1, Math.round((MAX_COLUMNS * height) / (CELL_ASPECT * width)))
  }
  return { columns: Math.max(MIN_COLUMNS, columns), rows: Math.min(rows, tileRows) }
}

/**
 * Picture boxes for one row of tiles that fits the band whole, so it never scrolls:
 * the tallest tiles whose chrome fits in `maxRows` and whose total width fits in `bodyColumns`.
 */
export function fitRow(sizes: readonly (Size | null)[], maxRows: number, bodyColumns: number): Cells[] {
  const tallest = Math.max(1, Math.min(TILE_ROWS, maxRows - TILE_CHROME_ROWS))
  for (let tileRows = tallest; tileRows > 1; tileRows--) {
    const cells = sizes.map(size => fitCells(size, tileRows))
    const width = cells.reduce((sum, c) => sum + c.columns + TILE_CHROME_COLUMNS, 0) + GAP * (cells.length - 1)
    if (width <= bodyColumns) return cells
  }
  return sizes.map(size => fitCells(size, 1))
}

/** The thumbnail a terminal without kitty graphics is drawn from: BGRA, stretched to this box. */
export const THUMB = { width: 64, height: 24 }

const UPPER_HALF_BLOCK = 0x2580

/**
 * A `Raster`'s cells for a `columns` by `rows` box showing a THUMB-sized BGRA thumbnail:
 * each cell an upper half block, its foreground the pixel above and its background the one below.
 */
export function blockCells(bgraBase64: string, columns: number, rows: number): string | null {
  const bgra = Uint8Array.from(atob(bgraBase64), char => char.charCodeAt(0))
  if (bgra.length !== THUMB.width * THUMB.height * 4) return null

  // The mean color of the thumbnail pixels one half cell covers.
  const color = (x: number, y: number): number => {
    const left = Math.floor((x * THUMB.width) / columns)
    const right = Math.max(left + 1, Math.floor(((x + 1) * THUMB.width) / columns))
    const top = Math.floor((y * THUMB.height) / (rows * 2))
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * THUMB.height) / (rows * 2)))
    let r = 0
    let g = 0
    let b = 0
    for (let py = top; py < bottom; py++) {
      for (let px = left; px < right; px++) {
        const i = (py * THUMB.width + px) * 4
        b += bgra[i] ?? 0
        g += bgra[i + 1] ?? 0
        r += bgra[i + 2] ?? 0
      }
    }
    const count = (right - left) * (bottom - top)
    return (Math.round(r / count) << 16) | (Math.round(g / count) << 8) | Math.round(b / count)
  }

  const words = new Uint32Array(columns * rows * 3)
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      words.set([UPPER_HALF_BLOCK, color(column, row * 2), color(column, row * 2 + 1)], (row * columns + column) * 3)
    }
  }
  let binary = ''
  for (const byte of new Uint8Array(words.buffer)) binary += String.fromCharCode(byte)
  return btoa(binary)
}
