$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$lock = Get-Content -LiteralPath (Join-Path $repository 'dependencies.lock.json') -Raw | ConvertFrom-Json
$cache = Join-Path $repository 'build\downloads'
New-Item -ItemType Directory -Path $cache -Force | Out-Null
function Fetch([string]$url, [string]$file) {
    if (-not (Test-Path -LiteralPath $file)) { Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing }
}
function Assert-Sha256([string]$file, [string]$expected) {
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $expected) { throw "Checksum mismatch: $file. Remove the cached download and retry." }
}
function Extract-File([IO.Compression.ZipArchive]$zip, [string]$entryName, [string]$target) {
    $entry = $zip.GetEntry($entryName)
    if (-not $entry) { throw "Missing package entry: $entryName" }
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
}
$nodeZip = Join-Path $cache 'node.zip'
Fetch $lock.node.url $nodeZip
Assert-Sha256 $nodeZip $lock.node.sha256
$archive = [IO.Compression.ZipFile]::OpenRead($nodeZip)
try {
    $prefix = "node-v$($lock.node.version)-win-x64/"
    Extract-File $archive ($prefix + 'node.exe') (Join-Path $repository 'vendor\node\node.exe')
    Extract-File $archive ($prefix + 'LICENSE') (Join-Path $repository 'licenses\Node-LICENSE.txt')
} finally { $archive.Dispose() }
$pnpmTar = Join-Path $cache 'pnpm.tgz'
Fetch $lock.pnpm.url $pnpmTar
$hasher = [Security.Cryptography.SHA512]::Create()
$stream = [IO.File]::OpenRead($pnpmTar)
try { $integrity = 'sha512-' + [Convert]::ToBase64String($hasher.ComputeHash($stream)) } finally { $stream.Dispose(); $hasher.Dispose() }
if ($integrity -ne $lock.pnpm.integrity) { throw 'pnpm archive integrity mismatch.' }
$pnpmExtract = Join-Path $cache ('pnpm-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $pnpmExtract -Force | Out-Null
try {
    & tar.exe -xzf $pnpmTar -C $pnpmExtract
    if ($LASTEXITCODE -ne 0) { throw 'pnpm extraction failed.' }
    $package = Join-Path $pnpmExtract 'package'
    $destination = Join-Path $repository 'vendor\pnpm'
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Copy-Item -Path (Join-Path $package '*') -Destination $destination -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $package 'LICENSE') -Destination (Join-Path $repository 'licenses\pnpm-LICENSE.txt') -Force
} finally {
    if (-not [IO.Path]::GetFullPath($pnpmExtract).StartsWith([IO.Path]::GetFullPath($cache) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cleanup path.' }
    Remove-Item -LiteralPath $pnpmExtract -Recurse -Force
}
$webviewZip = Join-Path $cache 'webview2.nupkg'
Fetch $lock.webview2.url $webviewZip
$archive = [IO.Compression.ZipFile]::OpenRead($webviewZip)
try {
    foreach ($name in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.Wpf.dll')) {
        Extract-File $archive ("lib/net462/$name") (Join-Path $repository "app\native\bin\$name")
    }
    Extract-File $archive 'runtimes/win-x64/native/WebView2Loader.dll' (Join-Path $repository 'app\native\bin\WebView2Loader.dll')
    Extract-File $archive 'LICENSE.txt' (Join-Path $repository 'licenses\WebView2-LICENSE.txt')
} finally { $archive.Dispose() }
foreach ($property in $lock.files.PSObject.Properties) { Assert-Sha256 (Join-Path $repository $property.Name) $property.Value }
Write-Output 'Verified Node, pnpm and WebView2 SDK from pinned upstream downloads.'
