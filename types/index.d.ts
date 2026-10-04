export type PastedImage = {
  n: number
  /** Absolute path of the cached PNG; null when it can't be found. */
  path: string | null
  /** Pixel size; null when unknown, and the tile falls back to a default shape. */
  size: { width: number; height: number } | null
  /**
   * Windows without kitty graphics only: the picture shrunk to at most 96x48, one `rrggbb...`
   * string per pixel row, drawn as half-block characters.
   */
  grid?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'image-view': { images: PastedImage[] }
  }
}
