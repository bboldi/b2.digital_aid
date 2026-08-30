<#
.SYNOPSIS
    Removes the Digital Aid client and its Scheduled Task.

.DESCRIPTION
    Run from an elevated PowerShell (the parent's admin account). Order matters: the Scheduled Task is
    removed first, otherwise the every-minute watchdog would just relaunch the process we then stop.

    By default the app and task go but the data folder (state + client.log) is KEPT, so the audit log
    survives and a later reinstall resumes where it left off. Pass -Purge to delete that too.

.PARAMETER Purge
    Also delete the data folder (state + logs) under %ProgramData%\DigitalAid.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Uninstall-DigitalAid.ps1
    powershell -ExecutionPolicy Bypass -File .\Uninstall-DigitalAid.ps1 -Purge
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [string]$TaskName = 'Digital Aid',
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'

if (-not $InstallDir) { $InstallDir = Join-Path $env:ProgramData 'DigitalAid' }

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this from an elevated PowerShell (Run as administrator).'
    }
}

Assert-Admin

# 1. Remove the task FIRST, so the watchdog cannot relaunch the process we are about to stop.
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\DigitalAid\' -ErrorAction SilentlyContinue
if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\DigitalAid\' -Confirm:$false
    Write-Host "Removed Scheduled Task \DigitalAid\$TaskName"
} else {
    Write-Host "No Scheduled Task \DigitalAid\$TaskName found (already gone)."
}

# Best-effort: drop the now-empty \DigitalAid\ task folder.
try {
    $svc = New-Object -ComObject 'Schedule.Service'
    $svc.Connect()
    $svc.GetFolder('\').DeleteFolder('DigitalAid', 0)
    Write-Host 'Removed empty task folder \DigitalAid\'
} catch { }   # folder missing or not empty -- harmless

# 2. Stop the running app (it will not come back now the task is gone).
Get-Process -Name 'DigitalAid' -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force
    Write-Host "Stopped DigitalAid.exe (PID $($_.Id))"
}
Start-Sleep -Milliseconds 500   # let the file handle release before we delete the exe

# 3. Remove the program files. Keep or purge the data folder.
if (Test-Path $InstallDir) {
    if ($Purge) {
        Remove-Item $InstallDir -Recurse -Force
        Write-Host "Deleted $InstallDir (including state + logs)"
    } else {
        # Delete the exe (and its .old rollback), keep state\ and client.log.
        Get-ChildItem $InstallDir -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'DigitalAid*.exe*' } |
            ForEach-Object { Remove-Item $_.FullName -Force }
        Write-Host "Removed the app from $InstallDir"
        Write-Host "Kept data: $(Join-Path $InstallDir 'state') and $(Join-Path $InstallDir 'client.log')"
        Write-Host 'Re-run with -Purge to delete those too.'
    }
} else {
    Write-Host "No install folder at $InstallDir."
}

Write-Host ''
Write-Host 'Uninstalled.' -ForegroundColor Green
