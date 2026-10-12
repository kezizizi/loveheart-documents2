param(
  [Parameter(Mandatory=$true)][string]$Html,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$Frames = 4,
  [int]$Vw = 390,
  [int]$Vh = 844,
  [int]$Tall = 6400
)
# 手机预览：把设计放进 390px 宽的 iframe。iframe 有自己的布局视口，媒体查询才会
# 真正按手机宽度生效 —— Edge 的 --window-size=390 只裁剪画面，不改变布局视口。
# harness 必须与设计文件同目录并用相对 src，否则 file:// 下 iframe 加载会失败。
$ErrorActionPreference = 'Continue'
$py = 'C:\Users\gzk16\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
# 先拆查询串，再解析路径（Resolve-Path 处理不了 ?query）
$query = ''
if ($Html -match '\?') { $parts = $Html -split '\?', 2; $Html = $parts[0]; $query = '?' + $parts[1] }
$Html = (Resolve-Path $Html).Path
$dir = Split-Path $Html -Parent
$leaf = Split-Path $Html -Leaf
$off = 20
$harness = Join-Path $dir '_phone-harness.html'

@"
<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;background:#1b1e21}
  iframe{position:absolute;left:${off}px;top:${off}px;width:${Vw}px;height:${Tall}px;
    border:0;background:#fff}
</style>
<iframe src="$leaf$query"></iframe>
"@ | Set-Content -LiteralPath $harness -Encoding UTF8

$raw = Join-Path $dir '_phone-raw.png'
& "$PSScriptRoot\shot.ps1" -Html $harness -Out $raw -Width ($Vw + 2 * $off) -Height ($Tall + 2 * $off) -Scale 1
& $py "$PSScriptRoot\phone-frame.py" $raw $Out $off $off $Vw $Vh $Frames
Remove-Item $raw -Force -ErrorAction SilentlyContinue
