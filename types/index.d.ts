export type PastedImage = {
  n: number
  /** Absolute path of the cached image; null when it can't be found. */
  path: string | null
  /** Pixel size; null when unknown, and the tile falls back to a default shape. */
  size: { width: number; height: number } | null
  /**
   * A small BGRA thumbnail, base64, drawn as colored half blocks on Windows, where kitty
   * graphics never reach the terminal; null where the terminal draws the file itself.
   */
  pixels: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'image-view': { images: PastedImage[] }
  }
}
