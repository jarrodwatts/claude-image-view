// Inside tmux, Claude Code's own Image element only draws when CLAUDE_CODE_FORCE_TERMINAL_IMAGES
// is set, and even then the kitty graphics command it sends is a bare APC that tmux drops: the
// placeholder cells reach the terminal, the pixels never do. Plugins may not draw placeholder
// cells themselves (Text refuses U+10EEEE), so the mod reads which image id Claude Code gave
// each tile off the pane and sends that image again, wrapped in tmux's DCS passthrough.

// The first 32 row/column diacritics of the kitty graphics protocol (rowcolumn-diacritics.txt),
// copied from Claude Code 2.1.294's own table rather than retyped from the spec. 32 covers
// layout.ts's MAX_COLUMNS and TILE_ROWS.
const DIACRITICS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c,
  0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
  0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483, 0x0484,
]
const INDEX = new Map(DIACRITICS.map((codePoint, i) => [codePoint, i]))
const PLACEHOLDER = 0x10eeee

/** One image's placeholder grid as drawn on the pane: its id and how many cells it spans. */
export type PlacedGrid = { id: number; columns: number; rows: number }

/** The foreground image id after an SGR parameter list: `current` carried on, a new id, or null on a reset. */
function foreground(params: string, current: number | null): number | null {
  const parts = params === '' ? ['0'] : params.split(/[;:]/)
  let id = current
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p === '0' || p === '39') {
      id = null
      continue
    }
    // 38 sets the foreground; 48 (background) and 58 (underline) take the same arguments,
    // which must be skipped so a value of 0 or 39 among them is not read as a reset.
    if ((p !== '38' && p !== '48' && p !== '58') || (parts[i + 1] !== '5' && parts[i + 1] !== '2')) continue
    if (parts[i + 1] === '5') {
      if (p === '38') id = Number(parts[i + 2])
      i += 2
      continue
    }
    // A colon form may carry an empty colour-space field: 38:2::R:G:B.
    const hasSpace = parts[i + 2] === ''
    const rgb = parts.slice(i + (hasSpace ? 3 : 2), i + (hasSpace ? 6 : 5))
    if (p === '38') id = (Number(rgb[0]) << 16) | (Number(rgb[1]) << 8) | Number(rgb[2])
    i += hasSpace ? 5 : 4
  }
  return id
}

/**
 * The placeholder grids in `tmux capture-pane -e -p` output, in the order they first appear
 * (top row, then left to right), which is the order of the tiles above the prompt.
 */
export function findPlaceholders(captured: string): PlacedGrid[] {
  const grids = new Map<number, PlacedGrid>()
  for (const line of captured.split('\n')) {
    let id: number | null = null
    const chars = [...line]
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i]!
      if (char === '\x1b' && chars[i + 1] === '[') {
        let end = i + 2
        while (end < chars.length && !/[@-~]/.test(chars[end]!)) end++
        if (chars[end] === 'm') id = foreground(chars.slice(i + 2, end).join(''), id)
        i = end
        continue
      }
      if (char.codePointAt(0) !== PLACEHOLDER || id === null || id <= 0) continue
      const row = INDEX.get(chars[i + 1]?.codePointAt(0) ?? -1)
      const column = INDEX.get(chars[i + 2]?.codePointAt(0) ?? -1)
      if (row === undefined || column === undefined) continue
      const grid = grids.get(id) ?? { id, columns: 0, rows: 0 }
      grid.columns = Math.max(grid.columns, column + 1)
      grid.rows = Math.max(grid.rows, row + 1)
      grids.set(id, grid)
    }
  }
  return [...grids.values()]
}

/**
 * Transmit the PNG at `path` by file name with a virtual placement `columns` × `rows` cells,
 * wrapped so tmux forwards it to the outer terminal (needs `allow-passthrough on`).
 */
export function tmuxTransmit(id: number, path: string, columns: number, rows: number): string {
  const name = btoa(String.fromCharCode(...new TextEncoder().encode(path)))
  const apc = `\x1b_Ga=T,U=1,q=2,f=100,t=f,i=${id},c=${columns},r=${rows};${name}\x1b\\`
  return `\x1bPtmux;${apc.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`
}
