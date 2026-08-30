<#
.SYNOPSIS
    Installs the Digital Aid client and the Scheduled Task that keeps it running.

.DESCRIPTION
    Run this once per kid's PC, from an elevated PowerShell, using the parent's admin account.

    Windows itself is the watchdog (PRD sec. 6.1): the task starts the app at logon and re-runs it every
    minute if it is not running, so ending it in Task Manager costs the kid a minute and leaves a
    visible stripe in the log. The task is created by an admin, so the kid's standard account cannot
    edit or delete it - which is also why the kid's account must NOT be an administrator.

    The app runs as whoever is logged on, unelevated, because it has to draw windows in their session.

.PARAMETER ExePath
    The DigitalAid.exe to install. Defaults to one beside this script (the Install Kit layout), then
    to ..\dist\DigitalAid.exe (a checkout after publish.sh).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Install-DigitalAid.ps1
#>
[CmdletBinding()]
param(
    [string]$ExePath,
    [string]$InstallDir,
    [string]$TaskName = 'Digital Aid'
)

$ErrorActionPreference = 'Stop'

# Resolve the script's own folder ourselves: $PSScriptRoot is unreliable inside a param() default and
# comes back empty when launched over a mapped/UNC path (e.g. the VirtualBox shared drive).
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
# Beside this script first, then the repo layout. The Install Kit is flat - exe and scripts in one
# folder - so that is the case a parent hits; '..\dist\' is what a checkout looks like after
# publish.sh. Looking beside itself first is correct for both and costs one Test-Path.
if (-not $ExePath) {
    $beside = Join-Path $scriptDir 'DigitalAid.exe'
    $ExePath = if (Test-Path $beside) { $beside } else { Join-Path $scriptDir '..\dist\DigitalAid.exe' }
}
if (-not $InstallDir) { $InstallDir = Join-Path $env:ProgramData 'DigitalAid' }

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this from an elevated PowerShell (Run as administrator).'
    }
}

function Test-DesktopRuntime {
    # The filesystem before the CLI, for two reasons. A PC that has never had .NET on it has no
    # `dotnet` command at all, and `& dotnet` against a missing command is a *terminating* error -
    # which under $ErrorActionPreference='Stop' would end the script with a stack trace on exactly the
    # machine this function exists to rescue. And after winget installs the runtime, PATH changes do
    # not reach a process that is already running, so the CLI can stay invisible to us even though the
    # install worked. The directory is the answer to both.
    $shared = Join-Path $env:ProgramFiles 'dotnet\shared\Microsoft.WindowsDesktop.App'
    if (Test-Path $shared) {
        $ten = Get-ChildItem $shared -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like '10.*' }
        if ($ten) { return $true }
    }

    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { return $false }
    $runtimes = & dotnet --list-runtimes 2>$null
    return [bool]($LASTEXITCODE -eq 0 -and ($runtimes | Select-String -SimpleMatch 'Microsoft.WindowsDesktop.App 10.'))
}

function Assert-DesktopRuntime {
    # The client ships framework-dependent (~270 KB) so self-updates stay small; the runtime is the
    # price of that, installed once per machine.
    if (Test-DesktopRuntime) { return }

    Write-Warning 'The .NET 10 Desktop Runtime was not found. The app cannot start without it.'

    # Offered, not assumed - and it may well not be offerable. This script runs elevated, so on the
    # kid's standard account UAC ran it as the *parent's* account, and winget is a per-user MSIX that
    # is only provisioned for users who have logged in interactively. Absent there, which is exactly
    # the machine this matters on. Hence the fall-through to the instruction rather than a hard stop.
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        $answer = Read-Host 'Install it now with winget? (Y/n)'
        if ($answer -ne 'n') {
            Write-Host 'Installing the .NET 10 Desktop Runtime - this downloads ~70 MB and takes a few'
            Write-Host 'minutes. It will look like nothing is happening. Do not close this window.'
            # The agreement flags are what stop a first-ever winget run stopping dead on an
            # interactive prompt nobody is watching for.
            & winget install --id Microsoft.DotNet.DesktopRuntime.10 --exact --silent `
                --accept-source-agreements --accept-package-agreements
            # Winget's exit codes are many and its successes are not all zero, so trust the check
            # rather than the code: re-ask the question the code was standing in for.
            if (Test-DesktopRuntime) {
                Write-Host 'Runtime installed.' -ForegroundColor Green
                return
            }
            Write-Warning "winget finished (exit $LASTEXITCODE) but the runtime is still not there."
        }
    }

    Write-Warning 'Install it by hand with:'
    Write-Warning '    winget install Microsoft.DotNet.DesktopRuntime.10'
    $answer = Read-Host 'Continue anyway? (y/N)'
    if ($answer -ne 'y') { throw 'Install the runtime first, then re-run this script.' }
}

Assert-Admin
Assert-DesktopRuntime

if (-not (Test-Path $ExePath)) { throw "Cannot find $ExePath - build it with client/publish.sh first." }

Write-Host "Installing to $InstallDir"
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $InstallDir 'state') -Force | Out-Null
Copy-Item $ExePath (Join-Path $InstallDir 'DigitalAid.exe') -Force

# Copy-Item carries alternate data streams across, Zone.Identifier included. An exe that arrived in
# the Install Kit - i.e. through a browser - is marked, and that mark would follow it into ProgramData
# and into a Scheduled Task that relaunches it every minute with nobody at the machine. Strip it here,
# where we know the bytes came from the household's own server. The scripts get the same treatment so
# a re-run of this one is not itself blocked. Self-update never needs this: the client fetches over
# HTTP with no browser in the path, so no zone is ever attached (ADR-0015).
Unblock-File -Path (Join-Path $InstallDir 'DigitalAid.exe') -ErrorAction SilentlyContinue
# -Path must end in a wildcard for -Include to match anything; without it this silently does nothing.
Get-ChildItem -Path (Join-Path $scriptDir '*') -Include '*.ps1', '*.bat' -File -ErrorAction SilentlyContinue |
    Unblock-File -ErrorAction SilentlyContinue

# Standard users need write access here: the app stores its state as the kid, and self-update
# replaces the exe in place. File-level tamper resistance was traded away deliberately (PRD sec. 6.1) -
# ending the process was always the easier route and is equally visible in the log.
& icacls $InstallDir /grant 'BUILTIN\Users:(OI)(CI)M' /T | Out-Null

$exe = Join-Path $InstallDir 'DigitalAid.exe'
# -Argument '--scheduled' marks this as the watchdog rather than a person starting the app. It is
# what lets "Exit application" stick: an exit-by-Admin-Code stands the app down until midnight or
# the next reboot, and only the watchdog is turned away - double-clicking the exe brings protection
# straight back. Without the argument the two are indistinguishable and an exit would last a minute.
$action = New-ScheduledTaskAction -Execute $exe -Argument '--scheduled'

# Two triggers: start at logon, and re-check every minute forever.
$atLogon = New-ScheduledTaskTrigger -AtLogOn
# RepetitionDuration is a ~10-year span, not [TimeSpan]::MaxValue: MaxValue is rejected by the Task
# Scheduler XML on many Windows builds ("value incorrectly formatted or out of range").
$everyMinute = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)

# Runs as whichever standard user is logged on, unelevated, in their own session.
$principal = New-ScheduledTaskPrincipal -GroupId 'BUILTIN\Users' -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -TaskPath '\DigitalAid\' `
    -Action $action -Trigger @($atLogon, $everyMinute) `
    -Principal $principal -Settings $settings -Force | Out-Null

# Installing is a deliberate human action, so it ends any stand-down - otherwise the Start below
# runs as the watchdog, gets turned away, and the install looks like it silently did nothing.
$stoodDown = Join-Path $InstallDir 'state\stood-down'
if (Test-Path $stoodDown) {
    Remove-Item $stoodDown -Force
    Write-Host 'Cleared a stood-down marker left by a previous Exit application.'
}

Start-ScheduledTask -TaskName $TaskName -TaskPath '\DigitalAid\'

Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
Write-Host "  App:   $exe"
Write-Host "  Task:  \DigitalAid\$TaskName (at logon + every minute)"
Write-Host "  State: $(Join-Path $InstallDir 'state')"
Write-Host ''
Write-Host 'Next: the app should appear in the tray. Pair it from the tray menu if it is not paired.'
Write-Host 'Useful: DigitalAid.exe --status   (what it thinks is going on)'
Write-Host 'Disable/enable a PC from the server (Client page) - the app stays running while disabled.'
Write-Host ''
Write-Host 'Exiting with an admin code now sticks: the app stays off until local midnight, the next'
Write-Host 'reboot, or until someone starts DigitalAid.exe by hand. That is deliberate - it cannot be'
Write-Host 'undone from the server, because nothing is left running to receive the command.'
Write-Host ''
Write-Host 'Reminder: the kid''s Windows account must be a standard user, not an administrator -'
Write-Host 'that is what stops the clock being changed and this task being deleted.'
