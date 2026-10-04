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

type Env = Readonly<Record<string, string | undefined>>

/**
 * Whether the terminal draws `Image` as a real picture, which takes the kitty graphics protocol.
 * `CLAUDE_IMAGE_VIEW_RENDERER` forces it: `image` for the picture, `blocks` for colored half blocks.
 */
export function drawsPictures(env: Env): boolean {
  const forced = env.CLAUDE_IMAGE_VIEW_RENDERER
  if (forced === 'image' || forced === 'blocks') return forced === 'image'
  // tmux swallows the protocol, whatever terminal it runs in.
  if (env.TMUX) return false
  const term = env.TERM ?? ''
  const program = env.TERM_PROGRAM ?? ''
  return (
    Boolean(env.KITTY_WINDOW_ID || env.GHOSTTY_RESOURCES_DIR || env.WEZTERM_EXECUTABLE) ||
    /kitty|ghostty/i.test(term) ||
    /^(ghostty|WezTerm)$/i.test(program)
  )
}

/**
 * The cells of a `Raster` that draws `rgb` (a `width` x `height` thumbnail) in `columns` x `rows`
 * cells, base64. Each cell is an upper half block, so it holds two pixels: the top as its
 * foreground and the bottom as its background.
 */
export function blockCells(thumb: { width: number; height: number; rgb: Uint8Array }, columns: number, rows: number): string {
  const pixelRows = rows * 2
  const average = (px: number, py: number): number => {
    // The box of source pixels under output pixel (px, py), at least one pixel wide and tall.
    const x0 = Math.floor((px * thumb.width) / columns)
    const x1 = Math.max(x0 + 1, Math.floor(((px + 1) * thumb.width) / columns))
    const y0 = Math.floor((py * thumb.height) / pixelRows)
    const y1 = Math.max(y0 + 1, Math.floor(((py + 1) * thumb.height) / pixelRows))
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (let y = y0; y < y1 && y < thumb.height; y++) {
      for (let x = x0; x < x1 && x < thumb.width; x++, n++) {
        const at = (y * thumb.width + x) * 3
        r += thumb.rgb[at]!
        g += thumb.rgb[at + 1]!
        b += thumb.rgb[at + 2]!
      }
    }
    n = n || 1
    return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n)
  }
  const words = new Uint32Array(columns * rows * 3)
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const at = (row * columns + column) * 3
      words[at] = 0x2580
      words[at + 1] = average(column, row * 2)
      words[at + 2] = average(column, row * 2 + 1)
    }
  }
  return (new Uint8Array(words.buffer) as Uint8Array & { toBase64(): string }).toBase64()
}
