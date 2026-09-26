# Restore a backup made by backup.ps1 / backup.sh on a Windows clinic server (R6a, ADR-036).
# REPLACES the current database and patient files with the backup's; the replaced files
# are kept aside. Usage (PowerShell):
#   powershell -ExecutionPolicy Bypass -File C:\dawali\deploy\restore.ps1 C:\dawali\deploy\backups\2026-09-26_0230
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [switch]$Yes
)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Compose = Join-Path $Here "docker-compose.yml"
$FilesDir = Join-Path $Here "data\files"

# Refuse a damaged backup.
foreach ($line in Get-Content (Join-Path $Source "SHA256SUMS")) {
  $hash, $name = $line -split "\s+", 2
  $actual = (Get-FileHash (Join-Path $Source $name) -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $hash) { throw "checksum mismatch: $name" }
}

if (-not $Yes) {
  $answer = Read-Host "This REPLACES the current database and files with $Source. Type yes to continue"
  if ($answer -ne "yes") { Write-Output "cancelled"; exit 1 }
}

docker compose -f $Compose stop app
docker compose -f $Compose cp (Join-Path $Source "database.dump") db:/tmp/restore.dump
docker compose -f $Compose exec -T db pg_restore -U dawali --clean --if-exists --no-owner -d dawali /tmp/restore.dump
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed (the app is stopped; fix and retry)" }
docker compose -f $Compose exec -T db rm -f /tmp/restore.dump

if ((Test-Path $FilesDir) -and (Get-ChildItem $FilesDir -Force | Select-Object -First 1)) {
  Rename-Item $FilesDir ("files.before-restore-" + (Get-Date -Format "yyyyMMddHHmmss"))
}
New-Item -ItemType Directory -Force -Path $FilesDir | Out-Null
tar -C $FilesDir -xzf (Join-Path $Source "files.tar.gz")
if ($LASTEXITCODE -ne 0) { throw "files archive could not be extracted" }

docker compose -f $Compose start app
Write-Output "restore ok from $Source"
