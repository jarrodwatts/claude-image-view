# Claude Image View

A Claude Code mod that shows the images you paste, so you see thumbnails above your prompt instead of bare `[Image #1]` tags.

[![License](https://img.shields.io/github/license/jarrodwatts/claude-image-view?v=2)](LICENSE)
[![Stars](https://img.shields.io/github/stars/jarrodwatts/claude-image-view)](https://github.com/jarrodwatts/claude-image-view/stargazers)

![Claude Image View in action](claude-image-view.png)

## Install

Inside Claude Code, run:

```
/plugin marketplace add jarrodwatts/claude-image-view
/plugin install image-view
/reload-plugins
```

That's it. Paste an image into the prompt and its thumbnail appears above the input.

<details>
<summary><strong>Prefer the terminal?</strong></summary>

```bash
claude plugin marketplace add jarrodwatts/claude-image-view
claude plugin install image-view@claude-image-view
```

Then run `/reload-plugins` inside a session, or start a new one.

</details>

**On Windows Terminal**, also run `windows\install.ps1` to get real pictures instead of coloured blocks. See [Windows](#windows).

## What You See

Paste one or more images and a row of thumbnails sits above the prompt, each labelled with the number of its tag:

```
╭────────────────────────╮ ╭────────────╮
│                        │ │            │
│      (screenshot)      │ │  (photo)   │
│                        │ │            │
│           #1           │ │     #2     │
╰────────────────────────╯ ╰────────────╯
❯ why is the header misaligned here [Image #1] vs [Image #2]
```

- **Thumbnails appear as soon as you paste.** You don't have to type another key first.
- **Thumbnails keep their shape.** Wide screenshots stay wide and phone shots stay tall.
- **Always fits on screen.** Tiles shrink to fit the space above the prompt, so the row never scrolls or gets cut off.
- **Clears on send.** Once the prompt is sent (or the tags are deleted), the row goes away.
- **Lights up under the pointer.** In terminals that report mouse movement, the frame of the tile under the pointer brightens.

## How It Works

Claude Code saves every pasted image to a cache folder for the session, as `<tmp>/<project>/<session>/images/<n>.png`, and puts an `[Image #n]` tag in the prompt. Claude Image View is a [mod](https://code.claude.com/docs/en/plugins/mods/overview):

1. Every 200ms it reads the prompt box and looks for `[Image #n]` tags. It checks on a timer because pasting an image doesn't raise an edit event.
2. For each tag it finds the cached PNG and reads its size from the PNG header.
3. It draws the thumbnails in the band above the prompt with Claude Code's `Image` element. The terminal reads the file itself, so the image data never passes through the mod.

## Windows

Windows Terminal has no kitty graphics, so on Windows the mod does two extra things:

- **Finds the cache** under `%TEMP%\claude` and labels each tile `#1 · open`; a click on the label opens the picture in your default viewer.
- **Draws a fallback.** Without kitty graphics it shrinks the picture with the built-in .NET `System.Drawing` and draws it as coloured half-block characters: rough, but you can tell which picture is which.

For the **real picture** in Windows Terminal (1.22 or newer), install the `claude-pictures` helper from the [`windows/`](windows/) folder:

```powershell
cd windows
powershell -ExecutionPolicy Bypass -File install.ps1
```

It runs Claude Code under the newer Windows pseudo-console and rewrites each picture Claude prints into Sixel, which Windows Terminal draws. A plain `claude` then goes through it in every new tab. [WezTerm](https://wezfurlong.org/wezterm/) on Windows has kitty graphics and needs none of this. Details, checks and troubleshooting: [windows/README.md](windows/README.md).

## Security

Claude Image View is local-only. It makes no network requests and writes no files. It reads the prompt box, lists Claude Code's temp folder to find the current session's image cache, and reads the first bytes of each pasted image. If `CLAUDE_CODE_TMPDIR` isn't set, it runs `id -u` once to find the default temp folder.

On Windows it additionally runs `powershell.exe` to shrink a picture for the half-block fallback (only when the terminal can't draw pictures), and `explorer.exe` to open a picture when you click its label. The optional `claude-pictures` helper writes a short log of what it drew next to itself and keeps a copy of each drawn picture in `%TEMP%\claude-pictures`.

Run `claude plugin validate` on the repo to see every event it hooks and every call it makes.

## Requirements

- Claude Code v2.1.287 or later (mods support)
- macOS, Linux, or Windows
- A terminal with the kitty graphics protocol, such as [Ghostty](https://ghostty.org), [kitty](https://sw.kovidgoyal.net/kitty/) or [WezTerm](https://wezfurlong.org/wezterm/); or Windows Terminal 1.22+ with the [`claude-pictures` helper](windows/)

Other terminals show `[Image #n]` in each tile instead of the picture (coloured blocks on Windows). The Claude Desktop app already previews pasted images, so the mod draws nothing there.

## Troubleshooting

**Nothing appears when I paste.** Run `/plugin` and check the dim line under the tabs lists `image-view` as an active mod. If it isn't listed, run `/reload-plugins`.

**The tile says "no preview".** The mod couldn't find the cached file. Claude Code may have moved where it stores pasted images. Please [open an issue](https://github.com/jarrodwatts/claude-image-view/issues) with your Claude Code version.

**The tile shows `[Image #1]` text instead of the picture.** Your terminal doesn't support the kitty graphics protocol. See [Requirements](#requirements).

**The tile shows coloured blocks (Windows).** The session isn't running under the `claude-pictures` helper. Open a new tab after installing, or run `claude-pictures`. See [windows/README.md](windows/README.md#troubleshooting).

**The tile shows `[Image #1]` text in agent view or a background session, even in Ghostty or kitty.** Claude Code turns terminal images off for background sessions. If you attach from a terminal with the kitty graphics protocol, turn them back on in the `env` block of `~/.claude/settings.json`, then start a new session:

```json
"env": { "CLAUDE_CODE_FORCE_TERMINAL_IMAGES": "1" }
```

## Development

```bash
git clone https://github.com/jarrodwatts/claude-image-view
cd claude-image-view

# Load it for one session without installing
claude --plugin-dir .

# Check it and run the tests
claude plugin validate .
claude plugin test .

# The Windows helper's own tests
cd windows/claude-pictures && npm install && npm test
```

Claude Code writes the API types into `.claude-plugin/types/` the first time it loads the mod, and `tsc -p .` type-checks it from then on.

## License

MIT. See [LICENSE](LICENSE).

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=jarrodwatts/claude-image-view&type=Date)](https://star-history.com/#jarrodwatts/claude-image-view&Date)
