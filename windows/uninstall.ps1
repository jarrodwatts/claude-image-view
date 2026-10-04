<#
Removes what install.ps1 put on this machine: the launchers and their PATH entry, the
claude-pictures helper, the alt+i key, and (unless -KeepPlugin) the image-view plugin.
  powershell -ExecutionPolicy Bypass -File uninstall.ps1
#>
param([switch]$KeepPlugin)
$ErrorActionPreference = 'Stop'
$claudeHome = Join-Path $env:USERPROFILE '.claude'

function Invoke-Claude {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & claude @args 2>$null | Out-Null } finally { $ErrorActionPreference = $previous }
}

# Launchers and PATH.
$binDir = Join-Path $claudeHome 'tools\bin'
foreach ($name in 'claude.cmd', 'claude-pictures.cmd') {
    $file = Join-Path $binDir $name
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
}
if ((Test-Path -LiteralPath $binDir) -and -not (Get-ChildItem -LiteralPath $binDir -Force)) { Remove-Item -LiteralPath $binDir -Force }
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($userPath -split ';' | Where-Object { $_ -ne '' -and $_ -ne $binDir })
[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')

# The helper.
$toolDir = Join-Path $claudeHome 'tools\claude-pictures'
if (Test-Path -LiteralPath $toolDir) {
    # A tab still running under the helper holds some of its files; say so instead of failing.
    Remove-Item -LiteralPath $toolDir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $toolDir) { Write-Warning "Could not remove $toolDir completely. Close every Claude Code tab and delete it by hand." }
}

# The alt+i key, only if it is still ours.
$keyFile = Join-Path $claudeHome 'keybindings.json'
if (Test-Path -LiteralPath $keyFile) {
    $keys = Get-Content -LiteralPath $keyFile -Raw | ConvertFrom-Json
    $chat = @($keys.bindings) | Where-Object { $_.context -eq 'Chat' } | Select-Object -First 1
    if ($chat -and $chat.bindings.'alt+i' -eq 'abovePrompt:toggle') {
        $chat.bindings.PSObject.Properties.Remove('alt+i')
        [System.IO.File]::WriteAllText($keyFile, ($keys | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding $false))
    }
}

if (-not $KeepPlugin) { Invoke-Claude plugin uninstall image-view@claude-image-view }

Write-Host 'Removed. Open a new terminal tab for the PATH change to take effect.'
