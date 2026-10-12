param(
  [Parameter(Mandatory=$true)][string]$Html,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$Width = 1440,
  [int]$Height = 3600,
  [int]$Scale = 1
)
$ErrorActionPreference = 'Continue'
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { throw "Edge not found at $edge" }

# 允许把 file:// 查询串跟路径一起传进来（用于 ?still=1 冻结动效便于截图）；必须先拆再解析路径
$query = ''
if ($Html -match '\?') { $parts = $Html -split '\?', 2; $Html = $parts[0]; $query = '?' + $parts[1] }
$uri = if ($Html -match '^https?://') { $Html + $query } else {
  $Html = (Resolve-Path $Html).Path
  'file:///' + ($Html -replace '\\','/') + $query
}
$Out  = [IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force -Path (Split-Path $Out -Parent) | Out-Null
Remove-Item $Out -Force -ErrorAction SilentlyContinue
$profile = Join-Path $env:TEMP ('edge-shot-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$err = Join-Path $env:TEMP ('edge-err-' + [guid]::NewGuid().ToString('N').Substring(0,8) + '.txt')
$log = "$err.out"

$argv = @(
  '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  "--user-data-dir=$profile",'--hide-scrollbars',"--force-device-scale-factor=$Scale",
  '--virtual-time-budget=2500',"--window-size=$Width,$Height",
  "--screenshot=$Out", $uri
)
# Edge writes extension warnings to stderr; Start-Process keeps them out of the error stream.
Start-Process -FilePath $edge -ArgumentList $argv -Wait -NoNewWindow `
  -RedirectStandardError $err -RedirectStandardOutput $log | Out-Null
Start-Sleep -Milliseconds 500
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $err, $log -Force -ErrorAction SilentlyContinue

if (Test-Path $Out) { "RAW {0}x{1} -> {2}" -f $Width, $Height, $Out } else { throw "screenshot failed: $Out" }
