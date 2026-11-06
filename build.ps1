# Đóng gói extension thành thư mục + zip để Load unpacked / cài thử.
# Chỉ copy file runtime: không kèm .git, graphify-out, AGENTS.md, opencode.json, fonts (chưa dùng).
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$version = (Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version
$name = "fb-unsend-viewer-$version"
$dist = Join-Path $root 'dist'
$out = Join-Path $dist $name
$zip = Join-Path $dist "$name.zip"

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
New-Item -ItemType Directory -Path $out -Force | Out-Null

$files = 'manifest.json', 'background.js', 'content.js', 'injected.js', 'popup.html', 'popup.css', 'popup.js', 'styles.css', 'archive-defaults.js', 'offscreen.html', 'offscreen.js', 'options.html', 'options.css', 'options.js'
foreach ($f in $files) { Copy-Item (Join-Path $root $f) $out }
Copy-Item (Join-Path $root 'icons') $out -Recurse

foreach ($js in Get-ChildItem $out -Filter *.js) {
  node --check $js.FullName
  if ($LASTEXITCODE -ne 0) { throw "Syntax error: $($js.Name)" }
}

Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip -CompressionLevel Optimal
"built: $out"
"zipped: $zip ($([math]::Round((Get-Item $zip).Length / 1KB)) KB)"
