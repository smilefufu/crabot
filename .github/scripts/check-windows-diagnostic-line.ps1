$ErrorActionPreference = 'Stop'
$line = @'
$r="$env:USERPROFILE\.crabot\data"; $p=Join-Path $r 'mm.pid'; if(Test-Path -LiteralPath $p){$v=(Get-Content -LiteralPath $p -Raw).Trim(); Write-Output ('MM_PID='+$v); if($v -match '^\d+$'){$x=Get-Process -Id ([int]$v) -ErrorAction SilentlyContinue; Write-Output ('MM_PID_PROCESS='+$(if($x){$x.ProcessName}else{'not running'}));}}else{Write-Output 'MM_PID_MISSING';}; $d=Join-Path $r 'module-runtime-registry\records'; $files=@(Get-ChildItem -LiteralPath $d -Filter '*.json' -ErrorAction SilentlyContinue); Write-Output ('MODULE_RECORDS='+$files.Count); foreach($f in $files){try{$j=Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json; [pscustomobject]@{file=$f.Name; module=$j.module_id; root_pid=$j.root_pid} | ConvertTo-Json -Compress;}catch{Write-Output ('READ_FAILED: '+$f.Name);};}
'@
$parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseInput($line, [ref]$null, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$root = Join-Path $env:RUNNER_TEMP ('diagnostic-line-' + [guid]::NewGuid().ToString('N'))
New-Item $root -ItemType Directory | Out-Null
$file = Join-Path $root 'exact-line.ps1'
[IO.File]::WriteAllText($file, $line, [Text.UTF8Encoding]::new($false))
$previousProfile = $env:USERPROFILE
try {
 foreach ($case in @('absent','stale','running','malformed')) {
  $env:USERPROFILE = Join-Path $root $case
  $data = Join-Path $env:USERPROFILE '.crabot/data'
  $records = Join-Path $data 'module-runtime-registry/records'
  if ($case -ne 'absent') {
   New-Item $records -ItemType Directory -Force | Out-Null
   [IO.File]::WriteAllText((Join-Path $data 'mm.pid'), $(if ($case -eq 'running') { [string]$PID } else { '2147483647' }))
   [IO.File]::WriteAllText((Join-Path $records 'fixture.json'), $(if ($case -eq 'malformed') { '{invalid json' } else { '{"module_id":"fixture","root_pid":12345}' }))
  }
  $before = @(Get-ChildItem $env:USERPROFILE -File -Recurse -ErrorAction SilentlyContinue | Get-FileHash | ForEach-Object { $_.Path + ':' + $_.Hash })
  $output = @(& $file)
  if ($case -eq 'absent') {
   if ($output -notcontains 'MM_PID_MISSING' -or $output -notcontains 'MODULE_RECORDS=0') { throw 'Missing-data output incorrect' }
  } else {
   if ($output -notcontains 'MODULE_RECORDS=1') { throw 'Record count incorrect' }
   $expected = if ($case -eq 'running') { (Get-Process -Id $PID).ProcessName } else { 'not running' }
   if ($output -notcontains ('MM_PID_PROCESS=' + $expected)) { throw 'PID observation incorrect' }
   if ($case -eq 'malformed') {
    if ($output -notcontains 'READ_FAILED: fixture.json') { throw 'Invalid JSON observation incorrect' }
   } else {
    $record = $output[-1] | ConvertFrom-Json
    if ($record.module -ne 'fixture' -or $record.root_pid -ne 12345) { throw 'Record fields incorrect' }
   }
  }
  $after = @(Get-ChildItem $env:USERPROFILE -File -Recurse -ErrorAction SilentlyContinue | Get-FileHash | ForEach-Object { $_.Path + ':' + $_.Hash })
  if (($before -join "`n") -ne ($after -join "`n")) { throw 'Diagnostic command changed fixture files' }
  Write-Output ('CRABOT_DIAGNOSTIC_LINE_PASS version=' + $PSVersionTable.PSVersion + ' case=' + $case)
 }
} finally {
 $env:USERPROFILE = $previousProfile
 Remove-Item $root -Recurse -Force
}
