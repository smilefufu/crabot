param([string]$Installer, [string]$Node)
$ErrorActionPreference = 'Stop'
$temporary = Join-Path $env:TEMP ('crabot-remote-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
$originalTemp = $env:TEMP
try {
    $env:TEMP = $temporary
    $installed = Join-Path $temporary 'installed'
    . $Installer -Version fixture -InstallDir $installed
    Add-Type -TypeDefinition @'
using System.IO;
using System.Threading;
public static class CrabotInstallerSharingLock {
    public static Thread Hold(string path) {
        var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None);
        var thread = new Thread(() => { Thread.Sleep(400); stream.Dispose(); });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }
}
'@
    $script:OriginalNativeSuccess = ${function:Assert-NativeSuccess}
    function Assert-NativeSuccess($stage) {
        if ($stage -eq 'Bundled CLI installation' -and $script:Mode -eq 'complete') {
            # Hold a real file through the first cleanup attempt, as an exiting process or scanner can.
            $script:CleanupHold = [CrabotInstallerSharingLock]::Hold((Join-Path $bundledSource 'cleanup-lock'))
        }
        & $script:OriginalNativeSuccess $stage
    }
    function Ensure-Node { throw 'UNEXPECTED_HOST_NODE' }
    function Ensure-Uv { throw 'UNEXPECTED_HOST_UV' }
    function Ensure-Bash { throw 'UNEXPECTED_HOST_BASH' }
    function Ensure-Pnpm { throw 'UNEXPECTED_HOST_PNPM' }
    $payload = Join-Path $temporary 'crabot-fixture-windows-x64'
    New-Item -ItemType Directory -Path (Join-Path $payload '.product-runtime/node'), (Join-Path $payload 'scripts') | Out-Null
    Copy-Item -LiteralPath $Node -Destination (Join-Path $payload '.product-runtime/node/node.exe')
    Set-Content -LiteralPath (Join-Path $payload 'core-release.json') -Value '{}' -Encoding ASCII
    $entry = "if(!process.argv.includes('--scope=user')||!process.argv.includes('--expected-version=fixture'))process.exit(98);require('fs').writeFileSync(process.env.CRABOT_TEST_BUNDLED_ENTRY,'used');process.exit(47)"
    Set-Content -LiteralPath (Join-Path $payload 'scripts/install-core.mjs') -Value $entry.Replace("require('fs')", "(await import('node:fs'))") -Encoding ASCII
    $script:GoodArchive = Join-Path $temporary 'complete.zip'
    Compress-Archive -LiteralPath $payload -DestinationPath $script:GoodArchive -CompressionLevel Fastest
    Remove-Item -LiteralPath (Join-Path $payload 'core-release.json')
    $script:IncompleteArchive = Join-Path $temporary 'incomplete.zip'
    Compress-Archive -LiteralPath $payload -DestinationPath $script:IncompleteArchive -CompressionLevel Fastest
    $env:CRABOT_TEST_BUNDLED_ENTRY = Join-Path $temporary 'bundled-entry'
    function Invoke-WebRequest {
        param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
        $archive = if ($script:Mode -eq 'missing-metadata') { $script:IncompleteArchive } else { $script:GoodArchive }
        if ($Uri.EndsWith('.sha256')) {
            $hash = if ($script:Mode -eq 'bad-checksum') { '0' * 64 } else { (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() }
            Set-Content -LiteralPath $OutFile -Value $hash -Encoding ASCII
        } else { Copy-Item -LiteralPath $archive -Destination $OutFile }
    }
    foreach ($script:Mode in @('complete', 'missing-metadata', 'bad-checksum')) {
        Remove-Item -LiteralPath $env:CRABOT_TEST_BUNDLED_ENTRY -Force -ErrorAction SilentlyContinue
        $failure = $null
        try { Install-Crabot } catch { $failure = $_ }
        $expected = switch ($script:Mode) {
            complete { 'Bundled CLI installation failed \(exit code 47\)' }
            missing-metadata { 'Bundled release metadata is missing' }
            bad-checksum { 'checksum verification failed' }
        }
        if (-not $failure -or $failure.Exception.Message -notmatch $expected) { throw "Unexpected $script:Mode result: $failure" }
        if ((Test-Path -LiteralPath $env:CRABOT_TEST_BUNDLED_ENTRY) -ne ($script:Mode -eq 'complete')) { throw 'Bundled Node selection was incorrect' }
        if (Test-Path -LiteralPath $installed) { throw 'Failed preparation modified installation' }
        if ($script:CleanupHold) { $script:CleanupHold.Join(); $script:CleanupHold = $null }
        $remaining = @(Get-ChildItem -LiteralPath $temporary -Filter 'crabot-install-*')
        if ($remaining.Count) {
            $diagnostic = @($remaining | Get-ChildItem -Recurse -Force | Select-Object Name, Attributes)
            throw ('Download staging was not cleaned: ' + ($diagnostic | ConvertTo-Json -Compress))
        }
    }
} finally {
    $env:TEMP = $originalTemp
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
exit 0
