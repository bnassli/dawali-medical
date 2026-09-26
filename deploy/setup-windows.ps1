# One-time setup of a Windows clinic server (R6a, ADR-036). Run once, as Administrator:
#   powershell -ExecutionPolicy Bypass -File C:\dawali\deploy\setup-windows.ps1 -OffsiteDir E:\dawali-backups
# - opens ports 443/80 on the private (clinic) network only
# - keeps the server awake
# - schedules the nightly backup at 02:30
param(
  [string]$OffsiteDir = "",
  [string]$BackupTime = "02:30"
)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

foreach ($port in 443, 80) {
  $name = "Dawali Medical $port"
  if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $port `
      -Action Allow -Profile Private | Out-Null
  }
}
Write-Output "firewall: 443/80 open on the Private network profile"

powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Output "power: sleep and hibernate disabled on AC power"

$taskArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$Here\backup.ps1`""
if ($OffsiteDir) { $taskArgs += " -OffsiteDir `"$OffsiteDir`"" }
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $taskArgs -WorkingDirectory $Here
$trigger = New-ScheduledTaskTrigger -Daily -At $BackupTime
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
# Runs as the signed-in user, because Docker Desktop runs in that user's session.
Register-ScheduledTask -TaskName "Dawali Medical backup" -Action $action -Trigger $trigger `
  -Settings $settings -User $env:USERNAME -RunLevel Highest -Force | Out-Null
Write-Output "backup: scheduled daily at $BackupTime (Task Scheduler > 'Dawali Medical backup')"
