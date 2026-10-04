<#
Installs the Windows half of Claude Image View for the current user (no admin needed):
  1. the image-view plugin, from the GitHub marketplace (or a checkout, with -PluginSource <folder>)
  2. the claude-pictures helper, which draws real pictures in Windows Terminal, and its packages
  3. a `claude` launcher first on the user PATH, so every new terminal tab goes through the helper
  4. the alt+i key, which hides and shows the picture panel

Run from this folder:
  powershell -ExecutionPolicy Bypass -File install.ps1

Needs Windows Terminal 1.22 or newer, Node.js 20 or newer, and Claude Code on the PATH.
#>
param(
    [string]$PluginSource = 'jarrodwatts/claude-image-view',
    [switch]$SkipPlugin
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$claudeHome = Join-Path $env:USERPROFILE '.claude'

function Assert-Command($name, $hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name was not found on the PATH. $hint" }
}
# Runs claude quietly; a step that is already done (marketplace added, plugin installed) is not an error.
function Invoke-Claude {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & claude @args 2>$null | Out-Null } finally { $ErrorActionPreference = $previous }
}

Assert-Command node 'Install Node.js 20 or newer from https://nodejs.org first.'
Assert-Command npm 'Install Node.js 20 or newer from https://nodejs.org first.'
Assert-Command claude 'Install Claude Code first: https://code.claude.com/docs/en/setup'
$nodeVersion = (& node --version).Trim()
if ([int]$nodeVersion.TrimStart('v').Split('.')[0] -lt 20) { throw "Node.js 20 or newer is needed (found $nodeVersion)." }

# 1. The plugin.
if (-not $SkipPlugin) {
    Write-Host "Installing the image-view plugin from $PluginSource"
    Invoke-Claude plugin marketplace add $PluginSource
    Invoke-Claude plugin install image-view@claude-image-view
    Invoke-Claude plugin update image-view@claude-image-view
}

# 2. The helper and its packages.
$toolDir = Join-Path $claudeHome 'tools\claude-pictures'
Write-Host "Copying the claude-pictures helper to $toolDir"
New-Item -ItemType Directory -Path $toolDir -Force | Out-Null
robocopy (Join-Path $here 'claude-pictures') $toolDir /E /XD node_modules /XF last.log /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying the helper to $toolDir failed." }
Push-Location $toolDir
try {
    Write-Host 'Installing its packages (node-pty, koffi, sixel, pngjs)'
    & npm install --no-audit --no-fund --loglevel=error | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed. Run it again inside the folder above to see why.' }
} finally {
    Pop-Location
}

# 3. The launchers, first on the user PATH.
$binDir = Join-Path $claudeHome 'tools\bin'
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
Copy-Item (Join-Path $here 'claude.cmd') (Join-Path $binDir 'claude.cmd') -Force
Copy-Item (Join-Path $here 'claude-pictures.cmd') (Join-Path $binDir 'claude-pictures.cmd') -Force
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($userPath -split ';' | Where-Object { $_ -ne '' })
if ($parts -notcontains $binDir) {
    [Environment]::SetEnvironmentVariable('Path', ((@($binDir) + $parts) -join ';'), 'User')
    Write-Host "Added $binDir to the front of your PATH"
}

# 4. The alt+i key, merged into keybindings.json without touching other keys.
$keyFile = Join-Path $claudeHome 'keybindings.json'
$keys = if (Test-Path -LiteralPath $keyFile) { Get-Content -LiteralPath $keyFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{ bindings = @() } }
if (-not $keys.PSObject.Properties['bindings']) { $keys | Add-Member -NotePropertyName bindings -NotePropertyValue @() }
$chat = @($keys.bindings) | Where-Object { $_.context -eq 'Chat' } | Select-Object -First 1
if (-not $chat) {
    $chat = [pscustomobject]@{ context = 'Chat'; bindings = [pscustomobject]@{} }
    $keys.bindings = @($keys.bindings) + $chat
}
if (-not ($chat.bindings.PSObject.Properties.Name -contains 'alt+i')) {
    $chat.bindings | Add-Member -NotePropertyName 'alt+i' -NotePropertyValue 'abovePrompt:toggle'
}
# Written without a byte-order mark: Claude Code reads the file as plain JSON.
[System.IO.File]::WriteAllText($keyFile, ($keys | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding $false))

Write-Host ''
Write-Host 'Done. Open a NEW Windows Terminal tab, run claude, and paste a picture.'
Write-Host 'If a plain `claude` still shows blocks, run claude-pictures instead (same thing by its own name).'
