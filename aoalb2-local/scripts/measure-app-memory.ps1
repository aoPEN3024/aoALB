# Windows（WebView2）でアプリ全体（aoalb2-app と msedgewebview2 の全プロセス）のメモリを計測する。
# 使い方：pwsh scripts/measure-app-memory.ps1 -App <exe> -Project <工事フォルダ> -Out <出力フォルダ>
param([string]$App, [string]$Project, [string]$Out)
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$env:AOALB2_E2E_PROJECT = $Project
$env:AOALB2_E2E_OUT = Join-Path $Out "e2e-result.json"
$p = Start-Process -FilePath $App -PassThru
$csv = Join-Path $Out "memory.csv"
"time,processes,working_set_mb,private_mb" | Out-File $csv -Encoding utf8
function Get-Tree($id) {
  $all = Get-CimInstance Win32_Process
  $ids = @($id); $queue = @($id)
  while ($queue.Count) { $cur = $queue[0]; $queue = $queue[1..$queue.Count]; foreach ($c in ($all | Where-Object ParentProcessId -eq $cur)) { $ids += $c.ProcessId; $queue += $c.ProcessId } }
  return $ids
}
$deadline = (Get-Date).AddMinutes(20)
while (-not $p.HasExited -and (Get-Date) -lt $deadline) {
  $ids = Get-Tree $p.Id
  $procs = Get-Process -Id $ids -ErrorAction SilentlyContinue
  $ws = ($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB
  $pm = ($procs | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB
  "{0},{1},{2:N0},{3:N0}" -f (Get-Date).ToUniversalTime().ToString("o"), $procs.Count, $ws, $pm | Out-File $csv -Append -Encoding utf8
  Start-Sleep -Milliseconds 500
}
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force; throw "計測がタイムアウトしました" }
# 合否：自動操作が最後まで成功し、サムネイルの読込み失敗がないこと
$resultPath = Join-Path $Out "e2e-result.json"
if (-not (Test-Path $resultPath)) { throw "自動操作の結果がありません（$resultPath）" }
$r = Get-Content $resultPath -Raw -Encoding utf8 | ConvertFrom-Json
if (-not $r.ok) { throw "自動操作が失敗しました：$($r.error)" }
if ($r.thumbnailsLoaded.errors.Count -gt 0) { throw "サムネイルの読込みに失敗しました：$($r.thumbnailsLoaded.errors -join ', ')" }
if ($p.ExitCode -ne 0) { throw "アプリが異常終了しました（終了コード $($p.ExitCode)）" }
Write-Output "計測完了：$csv"
