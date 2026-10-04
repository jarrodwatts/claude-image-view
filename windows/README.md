# Claude Image View on Windows

Windows Terminal has no kitty graphics, so the mod alone cannot hand it a picture. This folder adds
the Windows half:

- **Without anything extra**, the mod draws each pasted picture as coloured half-block characters
  (a rough but recognisable thumbnail), with a `#1 · open` label that opens the real file in Photos.
- **With the `claude-pictures` helper**, the tile shows the real, smooth picture. The helper runs
  Claude Code under the newer Windows pseudo-console and rewrites every picture Claude prints into
  Sixel, which Windows Terminal draws natively. Keys and mouse pass straight through.

```
╭──────────────╮
│              │
│   (photo)    │
│              │
│  #1 · open   │
╰──────────────╯
❯ what is wrong with this screenshot [Image #1]
```

Pictures cost no tokens: the terminal paints them from the file; the model never sees them.

## Install

Requirements: Windows Terminal 1.22 or newer (Sixel support), Node.js 20 or newer, Claude Code.

```powershell
git clone https://github.com/jarrodwatts/claude-image-view
cd claude-image-view\windows
powershell -ExecutionPolicy Bypass -File install.ps1
```

The script installs the plugin from the marketplace, copies the helper to `%USERPROFILE%\.claude\tools\claude-pictures`
and installs its packages, puts a `claude` launcher first on your user PATH (so a plain `claude`
goes through the helper in every new tab), and adds the `alt+i` key that hides and shows the panel.
Open a **new** terminal tab afterwards.

- `claude-pictures` is the same thing by its own name, for when something else named `claude` wins
  on the PATH.
- To try a checkout before it is on the marketplace: `install.ps1 -PluginSource <path to the repo>`
  (remove a marketplace of the same name first: `claude plugin marketplace remove claude-image-view`).
- Outside a console (pipes, scripts, `claude -p`), the launcher runs Claude Code untouched.
- `uninstall.ps1` takes it all back out.

[WezTerm](https://wezfurlong.org/wezterm/) on Windows speaks kitty graphics, so it needs none of
this: the mod draws the real picture there as it does on macOS and Linux.

## What you get

- The real picture in the tile, fitted and centred, keeping its shape.
- Click the picture or the `#1 · open` label: the file opens in the default viewer.
- Hover the tile: the frame and label light up. The label never flips to inverse video.
- `alt+i` hides and shows the panel. Claude Code's own `ctrl+x ctrl+a` still works too.

## How it works

Two pieces:

1. **The mod** (`hooks/register.tsx`, shared with every platform). On Windows it finds the paste
   cache at `%TEMP%\claude\<project>\<session>\images\<n>.png` and adds the open label. When the
   terminal cannot draw pictures it shrinks each one with the built-in .NET `System.Drawing`
   (through `powershell.exe`, no install needed) and draws it as half-blocks.
2. **The helper** (`claude-pictures/`). Claude Code draws pictures the kitty way: one escape code
   transmits the picture, then placeholder characters mark the cells it covers. The helper keeps the
   transmission, and when the placeholder for the top-left cell goes by it clears the box and draws
   the picture there as Sixel, centred to the pixel on a see-through canvas. It asks the terminal
   its cell size (`CSI 16 t`) and, after each drawing, the cursor position (`CSI 6 n`), so it knows
   which cells each picture covers and can open the right one on a click.

The mod turns real pictures on under the helper (which sets `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1`)
and under WezTerm; every other Windows terminal gets the half-block fallback.

## Checking it

```powershell
cd windows\claude-pictures
npm install
npm test                      # the translator's unit tests (kitty -> Sixel, clicks, the label)
```

`tests/` holds end-to-end runs that start Claude Code under a hidden pseudo-console and check the
drawing, clicks, hover and the panel key. Read `tests/README.md` first: a hidden run that dies early
counts as a failed fullscreen start for Claude Code, and two of those switch fullscreen (and the
mouse) off for the whole machine.

## Troubleshooting

**The tile shows coloured blocks, not the picture.** The session is not running under the helper.
Open a new tab (the PATH change only reaches new tabs) and check `where claude` lists
`%USERPROFILE%\.claude\tools\bin\claude.cmd` first; or run `claude-pictures`.

**The picture is drawn but a click does nothing.** Clicks need Claude Code's fullscreen mode, which
it turns off for the machine after two sessions that died early. Run
`python tests\fix-fullscreen-state.py` to see, and `--fix` to clear it.

**`claude-pictures` says Claude Code was not found.** It looks for `claude.exe` on the PATH and in
`%USERPROFILE%\.local\bin`, then for an npm `claude.cmd`. Set `CLAUDE_PICTURES_CLAUDE` to the full
path of your Claude Code if it lives somewhere else.

**Something looks wrong.** The helper writes `last.log` next to itself (or to `CLAUDE_PICTURES_LOG`)
with every picture it received and drew; `CLAUDE_PICTURES_DEBUG_INPUT=1` logs keys and mouse too.

## Known limits

- Windows Terminal reports Sixel cells as 10x20 px and scales them to the real font; expected.
- One blank row sits between the tile and the prompt box: it is Claude Code's own status row.
- If Claude Code changes how it sends pictures, `claude-pictures/translate.cjs` is the place to
  update (`handleApc` and `placeholder`). If Windows Terminal gains kitty graphics one day, the
  helper can simply be retired.
