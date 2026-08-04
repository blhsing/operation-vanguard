[CmdletBinding()]
param(
    [ValidateSet('win-x64', 'win-arm64')]
    [string]$RuntimeIdentifier = 'win-x64',
    [switch]$FrameworkDependent
)

$ErrorActionPreference = 'Stop'

$projectPath = Join-Path $PSScriptRoot 'src\OperationVanguard.Game\OperationVanguard.Game.csproj'
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\Operation Vanguard'
$programsRoot = [Environment]::GetFolderPath('Programs')
$shortcutPath = Join-Path $programsRoot 'Operation Vanguard.lnk'
$selfContained = if ($FrameworkDependent) { 'false' } else { 'true' }

New-Item -ItemType Directory -Force -Path $installRoot | Out-Null

& dotnet publish $projectPath `
    --configuration Release `
    --runtime $RuntimeIdentifier `
    --self-contained $selfContained `
    --output $installRoot

if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE."
}

$executablePath = Join-Path $installRoot 'OperationVanguard.Game.exe'
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    throw "Published executable was not found at $executablePath."
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $executablePath
$shortcut.WorkingDirectory = $installRoot
$shortcut.IconLocation = "$executablePath,0"
$shortcut.Description = 'Operation Vanguard native .NET edition'
$shortcut.Save()

Write-Output "Installed Operation Vanguard to $installRoot"
Write-Output "Created Start Menu shortcut at $shortcutPath"
