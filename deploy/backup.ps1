# Daily backup on a Windows clinic server with Docker Desktop (R6a, ADR-036).
# Same content as backup.sh: database dump + patient files, kept $KeepDays days,
# optional copy to $OffsiteDir (external disk / NAS / synced folder).
# Schedule with Task Scheduler: powershell -ExecutionPolicy Bypass -File C:\dawali\deploy\backup.ps1
param(
  [string]$OffsiteDir = $env:OFFSITE_DIR,
  [int]$KeepDays = 30
)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$Dest = Join-Path $Here "backups\$Stamp"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$Compose = Join-Path $Here "docker-compose.yml"

# Database dump written inside the container, then copied out (no text-encoding issues).
docker compose -f $Compose exec -T db pg_dump -U dawali --format=custom --no-owner --file=/tmp/database.dump dawali
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
docker compose -f $Compose cp db:/tmp/database.dump (Join-Path $Dest "database.dump")
docker compose -f $Compose exec -T db pg_restore --list /tmp/database.dump | Out-Null
if ($LASTEXITCODE -ne 0) { throw "backup dump is not readable" }

tar -C (Join-Path $Here "data\files") -czf (Join-Path $Dest "files.tar.gz") .
if ($LASTEXITCODE -ne 0) { throw "files archive failed" }
Get-FileHash (Join-Path $Dest "database.dump"), (Join-Path $Dest "files.tar.gz") -Algorithm SHA256 |
  ForEach-Object { "$($_.Hash.ToLower())  $(Split-Path -Leaf $_.Path)" } |
  Set-Content (Join-Path $Dest "SHA256SUMS")
Write-Output "backup ok: $Dest"

if ($OffsiteDir) {
  New-Item -ItemType Directory -Force -Path $OffsiteDir | Out-Null
  Copy-Item -Recurse $Dest $OffsiteDir
  Write-Output "offsite copy ok: $OffsiteDir"
}

Get-ChildItem (Join-Path $Here "backups") -Directory |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
  Remove-Item -Recurse -Force
