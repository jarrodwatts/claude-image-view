# claude-pictures

Claude Code inside Windows Terminal, with real picture previews.

`claude` itself goes through this tool once `install.ps1` has put the launcher first on the PATH;
`claude-pictures` is the same thing by its own name. Pictures you paste, and any picture a mod
draws, show up as real pictures in the terminal instead of `[Image #1]` or coloured blocks.

A left click on a picture, or on the `#1 · open` label under it, opens the file in the default
viewer. The label is never drawn flipped (reverse video) under the pointer, even though Claude's
buttons normally are.

## How it works

Claude Code draws pictures the kitty way, which Windows Terminal does not understand. This tool
starts Claude Code under the newer Windows pseudo-console (the one VS Code ships, which passes
those codes through), reads everything Claude prints, and rewrites each picture as Sixel, which
Windows Terminal has drawn since version 1.22. Keys and mouse go straight back to Claude.

- `index.cjs`: console setup, finds and starts Claude Code, pumps input and output, asks the
  terminal its cell size, opens a picture when it is clicked.
- `translate.cjs`: the rewrite itself (kitty transmissions and Unicode placeholders in, Sixel out).
  After each drawing it asks the terminal where the cursor is (`CSI 6 n`), so it knows which screen
  cells each picture covers; it also strips reverse video off the open label.
- `png.cjs`: picture decoding and resizing.
- `diacritics.json`: kitty's table of row/column marks for placeholder cells.

Pictures cost no tokens: the terminal paints them from the file; the model never sees them.

## Finding Claude Code

In this order: `CLAUDE_PICTURES_CLAUDE` if set (a `claude.exe`, an npm `claude.cmd`, or a `cli.js`),
then `claude.exe` on the PATH or in `%USERPROFILE%\.local\bin` (the native installer), then an npm
`claude.cmd` on the PATH that is not this tool's own launcher. An npm install is started through
its `cli.js` under the same Node, so arguments arrive exactly as typed.

## Checking it

    npm install
    npm test

Set `CLAUDE_PICTURES_LOG=<file>` to get a log of every picture command and drawing (by default
`last.log` next to this file, truncated each run). `CLAUDE_PICTURES_DEBUG_INPUT=1` logs every key
and mouse report as well. `IMAGE_VIEW_CLICK_LOG=<file>` makes a click note itself in that file
instead of opening a window (for hidden test runs).

Hidden test runs that start Claude Code and then kill it must pass `--settings '{"tui":"default"}'`
or leave with `/exit`: Claude counts a fullscreen session that dies early as a failed start, and
after two of those it turns fullscreen off for the whole machine (and with it, the mouse).
