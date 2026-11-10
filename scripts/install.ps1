# Installs the packaged app to %LOCALAPPDATA%\Programs\LifeLens and puts a LifeLens icon on the desktop.
# (ASCII only on purpose: Windows PowerShell 5.1 misreads UTF-8 scripts without a BOM.)
$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot '..\dist\LifeLens-win32-x64'
$target = Join-Path $env:LOCALAPPDATA 'Programs\LifeLens'
$exe = Join-Path $target 'LifeLens.exe'

if (-not (Test-Path (Join-Path $source 'LifeLens.exe'))) {
    throw "Packaged app not found at $source. Run 'npm run pack' first."
}

# Close a running copy so its files can be replaced
Get-Process -Name LifeLens -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $exe } |
    Stop-Process -Force
Start-Sleep -Milliseconds 800

robocopy $source $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy exit code $LASTEXITCODE)" }

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'LifeLens.lnk'))
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $target
$shortcut.IconLocation = "$exe,0"
$shortcut.Description = 'LifeLens'
$shortcut.Save()

Write-Output "Installed: $exe"
Write-Output "Desktop shortcut: $(Join-Path $desktop 'LifeLens.lnk')"
exit 0
