# Hidden end-to-end runs (Windows)

These scripts start Claude Code under a hidden pseudo-console (no window), paste a picture tag,
and check what comes out. They run against the INSTALLED copies in `%USERPROFILE%\.claude`, so run
`install.ps1` first.

    npm install          # node-pty and @xterm/headless, once
    node wrapper-test.cjs <picture.png> wrapper.log        # the helper draws one Sixel, nothing leaks
    node capture-claude.cjs <picture.png> raw.bin          # Claude alone: how it sends the picture
    node replay.cjs raw.bin                                # show a captured screen as text
    node click-collapse-test.cjs <picture.png>             # a click on [-] hides the panel (fullscreen)
    node chord-test.cjs <picture.png>                      # alt+i hides and shows the panel
    node hover-capture-test.cjs <picture.png>              # label never flips; clicks open the picture
    python fix-fullscreen-state.py [--fix]                 # show / clear a fullscreen auto-disable
    powershell -File shot-window.ps1 WindowsTerminal out.png   # screenshot a real window

## The fullscreen canary — read before running anything

Claude Code records every fullscreen session that dies before it settles as a failed start. After
two of those it writes `fullscreenAutoDisabled` into `%USERPROFILE%\.claude.json` and every new tab
on the machine runs inline, which also turns the mouse off (clicks and hover stop working).

So a hidden run must either pass `--settings '{"tui":"default"}'` (the capture and wrapper tests do)
or leave through `/exit` (the fullscreen tests do). After a fullscreen test, run
`python fix-fullscreen-state.py` and make sure it prints "no fullscreen records".

Clicks: set `IMAGE_VIEW_CLICK_LOG=<file>` and both the plugin and the helper note a click in
that file instead of opening a window. The fullscreen tests answer the terminal questions Claude
asks (device attributes, focus, cursor position) the way Windows Terminal would.
