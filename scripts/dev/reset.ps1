# Developer helper (Windows): stop the PACT dev servers, delete the local database, reseed.
# Then start `npm run dev` again yourself.
for ($k = 0; $k -lt 10; $k++) {
  $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'PACT' -and $_.CommandLine -notmatch 'reset.ps1' }
  if (-not $p) { break }
  $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep 2
}
Set-Location (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
foreach ($f in 'data\pact.db', 'data\pact.db-wal', 'data\pact.db-shm', 'data\simulated-paypal.json') {
  for ($k = 0; $k -lt 10 -and (Test-Path $f); $k++) { Remove-Item $f -Force -ErrorAction SilentlyContinue; if (Test-Path $f) { Start-Sleep 2 } }
}
npx tsx scripts/seed.ts 2>&1 | Select-Object -Last 1
