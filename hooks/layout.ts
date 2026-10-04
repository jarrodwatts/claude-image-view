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
 * When even one-row tiles are too wide, only the first ones that fit beside a `+N` label for
 * the rest; none when the band is too small for one tile.
 */
export function fitRow(sizes: readonly (Size | null)[], maxRows: number, bodyColumns: number): Cells[] {
  if (maxRows < TILE_CHROME_ROWS + 1) return []
  const tallest = Math.min(TILE_ROWS, maxRows - TILE_CHROME_ROWS)
  for (let tileRows = tallest; tileRows > 1; tileRows--) {
    const cells = sizes.map(size => fitCells(size, tileRows))
    if (rowWidth(cells, 0) <= bodyColumns) return cells
  }
  const cells = sizes.map(size => fitCells(size, 1))
  let count = cells.length
  while (count > 0 && rowWidth(cells.slice(0, count), cells.length - count) > bodyColumns) count--
  return cells.slice(0, count)
}

function rowWidth(cells: readonly Cells[], hidden: number): number {
  const tiles = cells.reduce((sum, c) => sum + c.columns + TILE_CHROME_COLUMNS, 0) + GAP * Math.max(0, cells.length - 1)
  return hidden > 0 ? tiles + GAP + `+${hidden}`.length : tiles
}
