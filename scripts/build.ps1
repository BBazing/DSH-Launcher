param([switch]$FetchDependencies)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($FetchDependencies) { & (Join-Path $PSScriptRoot 'fetch-dependencies.ps1'); if (-not $?) { throw 'Dependency preparation failed.' } }
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$buildRoot = Join-Path $repository 'build'
$distribution = Join-Path $repository 'dist'
New-Item -ItemType Directory -Path $buildRoot,$distribution -Force | Out-Null
$stage = Join-Path $buildRoot ('stage-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
function Copy-ReleaseFile([string]$relative) {
    $source = Join-Path $repository $relative
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing input: $relative" }
    $target = Join-Path $stage $relative
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Recurse
}
try {
    # Explicit allowlist: never package the author's config, profiles or logs.
    foreach ($relative in @('app\server','app\web','app\native\window.ps1','app\native\desktop-window.ps1','app\native\bin','app\launch-release.ps1','app\package.json','vendor\node','vendor\pnpm','licenses','LICENSE','THIRD_PARTY_NOTICES.md','README.md')) { Copy-ReleaseFile $relative }
    $lock = Get-Content -LiteralPath (Join-Path $repository 'dependencies.lock.json') -Raw | ConvertFrom-Json
    foreach ($property in $lock.files.PSObject.Properties) {
        $actual = (Get-FileHash -LiteralPath (Join-Path $stage $property.Name) -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $property.Value) { throw "Dependency checksum mismatch: $($property.Name)" }
    }
    Get-ChildItem -LiteralPath (Join-Path $stage 'app') -Recurse -Filter '*.ps1' -File | ForEach-Object {
        $scriptText = [IO.File]::ReadAllText($_.FullName, [Text.Encoding]::UTF8)
        [IO.File]::WriteAllText($_.FullName, $scriptText, (New-Object Text.UTF8Encoding $true))
    }
    $manifest = @()
    foreach ($file in (Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName)) {
        $relative = $file.FullName.Substring($stage.Length + 1).Replace('\','/')
        if ($relative -match '(^|/)(\.credentials|launcher\.config|\.webview-profile|\.window-profile|logs|backups)(/|\.|$)') { throw "Private data in staging: $relative" }
        $manifest += [ordered]@{ path = $relative; size = $file.Length; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    [IO.File]::WriteAllText((Join-Path $stage 'payload-manifest.json'), (ConvertTo-Json -InputObject $manifest -Depth 4), (New-Object Text.UTF8Encoding $false))
    $payload = Join-Path $buildRoot 'payload.zip'
    $payloadStream = [IO.File]::Open($payload, [IO.FileMode]::Create)
    $archive = [IO.Compression.ZipArchive]::new($payloadStream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in (Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName)) {
            $relative = $file.FullName.Substring($stage.Length + 1).Replace('\','/')
            $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = [DateTimeOffset]::new(2000,1,1,0,0,0,[TimeSpan]::Zero)
            $entryStream = $entry.Open()
            $sourceStream = [IO.File]::OpenRead($file.FullName)
            try { $sourceStream.CopyTo($entryStream) } finally { $sourceStream.Dispose(); $entryStream.Dispose() }
        }
    } finally { $archive.Dispose(); $payloadStream.Dispose() }
    $payloadHash = (Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant()
    $version = (Get-Content -LiteralPath (Join-Path $stage 'app\package.json') -Raw | ConvertFrom-Json).version
    $generated = Join-Path $buildRoot 'BuildInfo.cs'
    [IO.File]::WriteAllText($generated, ('internal static class BuildInfo { public const string Version = "' + $version + '"; public const string PayloadHash = "' + $payloadHash + '"; }'))
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $output = Join-Path $distribution ("DSHLauncher-v$version-win-x64.exe")
    $compilerArgs = @('/nologo','/target:winexe','/platform:x64','/optimize+','/codepage:65001',('/out:' + $output),('/resource:' + $payload + ',payload.zip'),('/win32manifest:' + (Join-Path $repository 'launcher\app.manifest')), '/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.IO.Compression.dll','/r:System.IO.Compression.FileSystem.dll','/r:System.Web.Extensions.dll', (Join-Path $repository 'launcher\Program.cs'), $generated)
    & $compiler @compilerArgs
    if ($LASTEXITCODE -ne 0) { throw 'EXE compilation failed.' }
    $outputHash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $distribution 'SHA256SUMS.txt'), ($outputHash + '  ' + [IO.Path]::GetFileName($output) + "`n"), (New-Object Text.UTF8Encoding $false))
    Copy-Item -LiteralPath (Join-Path $stage 'payload-manifest.json') -Destination (Join-Path $distribution 'payload-manifest.json')
    $sourceArchivePath = Join-Path $distribution ("DSHLauncher-v$version-source.zip")
    $sourceStream = [IO.File]::Open($sourceArchivePath, [IO.FileMode]::Create)
    $sourceArchive = [IO.Compression.ZipArchive]::new($sourceStream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $sourceFiles = @()
        foreach ($directory in @('app\server','app\web','launcher','scripts','tests','licenses','.github')) { $sourceFiles += Get-ChildItem -LiteralPath (Join-Path $repository $directory) -Recurse -File }
        foreach ($relative in @('app\native\window.ps1','app\native\desktop-window.ps1','app\launch-release.ps1','app\package.json','dependencies.lock.json','.gitignore','.gitattributes','README.md','LICENSE','THIRD_PARTY_NOTICES.md','VALIDATION.md')) { $sourceFiles += Get-Item -LiteralPath (Join-Path $repository $relative) }
        foreach ($file in ($sourceFiles | Sort-Object FullName)) {
            $relative = $file.FullName.Substring($repository.Length + 1).Replace('\','/')
            $entry = $sourceArchive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = [DateTimeOffset]::new(2000,1,1,0,0,0,[TimeSpan]::Zero)
            $entryStream = $entry.Open()
            $inputStream = [IO.File]::OpenRead($file.FullName)
            try { $inputStream.CopyTo($entryStream) } finally { $inputStream.Dispose(); $entryStream.Dispose() }
        }
    } finally { $sourceArchive.Dispose(); $sourceStream.Dispose() }
    $sourceHash = (Get-FileHash -LiteralPath $sourceArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::AppendAllText((Join-Path $distribution 'SHA256SUMS.txt'), ($sourceHash + '  ' + [IO.Path]::GetFileName($sourceArchivePath) + "`n"), (New-Object Text.UTF8Encoding $false))
    [ordered]@{ version = $version; file = [IO.Path]::GetFileName($output); size = (Get-Item -LiteralPath $output).Length; sha256 = $outputHash; payloadSha256 = $payloadHash; node = $lock.node.version; pnpm = $lock.pnpm.version; webview2 = $lock.webview2.version } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $distribution 'release-info.json') -Encoding UTF8
    Write-Output "Built: $output"
    Write-Output "SHA256: $outputHash"
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    if (-not $resolvedStage.StartsWith([IO.Path]::GetFullPath($buildRoot) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe staging cleanup path.' }
    if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}
