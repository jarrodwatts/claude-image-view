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

/** A run of identical half-block cells: `▀` in `top` over a `bottom` background; null = blank half. */
export type Run = { top: string | null; bottom: string | null; count: number }

/**
 * Windows fallback without kitty graphics: the grid (one `rrggbb...` string per pixel row) fitted
 * inside `columns` x `rows * 2` pixels, keeping its shape and centred, as rows of half-block runs.
 * Each cell shows two stacked pixels.
 */
export function halfBlocks(grid: readonly string[], { columns, rows }: Cells): Run[][] {
  const gh = grid.length
  const gw = Math.floor((grid[0]?.length ?? 0) / 6)
  if (gw === 0) return []
  const th = rows * 2
  const scale = Math.min(columns / gw, th / gh)
  const w = Math.max(1, Math.round(gw * scale))
  const h = Math.max(1, Math.round(gh * scale))
  const left = Math.floor((columns - w) / 2)
  const top = Math.floor((th - h) / 2)
  const pixel = (px: number, py: number): string | null => {
    const tx = px - left
    const ty = py - top
    if (tx < 0 || tx >= w || ty < 0 || ty >= h) return null
    const x0 = Math.floor((tx * gw) / w)
    const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * gw) / w))
    const y0 = Math.floor((ty * gh) / h)
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * gh) / h))
    let r = 0
    let g = 0
    let b = 0
    let count = 0
    for (let y = y0; y < Math.min(y1, gh); y++) {
      const line = grid[y] ?? ''
      for (let x = x0; x < Math.min(x1, gw); x++) {
        r += parseInt(line.slice(x * 6, x * 6 + 2), 16)
        g += parseInt(line.slice(x * 6 + 2, x * 6 + 4), 16)
        b += parseInt(line.slice(x * 6 + 4, x * 6 + 6), 16)
        count++
      }
    }
    if (count === 0) return '#000000'
    return '#' + [r, g, b].map(v => Math.round(v / count).toString(16).padStart(2, '0')).join('')
  }
  const out: Run[][] = []
  for (let r = 0; r < rows; r++) {
    const runs: Run[] = []
    for (let tx = 0; tx < columns; tx++) {
      const top = pixel(tx, r * 2)
      const bottom = pixel(tx, r * 2 + 1)
      const last = runs[runs.length - 1]
      if (last && last.top === top && last.bottom === bottom) last.count++
      else runs.push({ top, bottom, count: 1 })
    }
    out.push(runs)
  }
  return out
}

/** Parses the shrinker's output: `W H` on the first line, then one `rrggbb...` row per line. */
export function parseShrunk(stdout: string): { size: Size; grid: string[] } | null {
  const [first, ...rest] = stdout.trim().split(/\r?\n/)
  const [w, h] = (first ?? '').split(' ').map(Number)
  const width = w ?? 0
  const height = h ?? 0
  const grid = rest.filter(line => /^([0-9a-f]{6})+$/.test(line))
  if (!(width > 0 && height > 0) || grid.length === 0) return null
  return { size: { width, height }, grid }
}
