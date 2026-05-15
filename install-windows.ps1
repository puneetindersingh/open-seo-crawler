# Open SEO Crawler — Windows installer (PowerShell)
#   - preflight checks
#   - Task Scheduler autostart at logon
#   - daily auto-update (git pull + restart if changed) via Task Scheduler
#
# Usage (from PowerShell):
#   iwr https://raw.githubusercontent.com/puneetindersingh/open-seo-crawler/master/install-windows.ps1 -OutFile install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Flags:
#   .\install.ps1 -Check       # preflight only, no changes
#   .\install.ps1 -UpdateNow   # run the updater immediately

param(
    [switch]$Check,
    [switch]$UpdateNow
)

$ErrorActionPreference = 'Stop'

$REPO_URL    = 'https://github.com/puneetindersingh/open-seo-crawler.git'
$INSTALL_DIR = Join-Path $env:USERPROFILE 'open-seo-crawler'
$TASK_NAME   = 'OpenSeoCrawler'
$UPDATE_TASK = 'OpenSeoCrawler-Update'
$PORT        = 5002
$MIN_PY_MAJ  = 3
$MIN_PY_MIN  = 10
$MIN_DISK_MB = 500

function Red($m)    { Write-Host $m -ForegroundColor Red }
function Green($m)  { Write-Host $m -ForegroundColor Green }
function Yellow($m) { Write-Host $m -ForegroundColor Yellow }
function Fail($m)   { Red "FAIL: $m"; exit 1 }
function OK($m)     { Green "  OK: $m" }
function Warn($m)   { Yellow "WARN: $m" }

# -------- -UpdateNow: just trigger the update task --------
if ($UpdateNow) {
    Start-ScheduledTask -TaskName $UPDATE_TASK
    Write-Host "Updater triggered. Tail logs with:"
    Write-Host "  Get-Content `"$INSTALL_DIR\update.log`" -Tail 50 -Wait"
    exit 0
}

# -------- Preflight --------
Write-Host '=============================================='
Write-Host ' Open SEO Crawler - Windows preflight checks'
if ($Check) { Write-Host ' (-Check mode: no changes will be made)' }
Write-Host '=============================================='

# OS check
if (-not (($env:OS -eq 'Windows_NT') -or $IsWindows)) {
    Fail 'This script targets Windows. For Linux use install.sh, for macOS use install-macos.sh.'
}
$winVer = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption
if ($winVer) { OK "OS: $winVer" } else { OK 'Windows detected' }

# Internet
try {
    Invoke-WebRequest -Uri 'https://github.com' -Method Head -TimeoutSec 5 -UseBasicParsing | Out-Null
    OK 'Internet reachable (github.com)'
} catch {
    Fail 'Cannot reach github.com - check internet connection.'
}

# Python ≥ 3.10
function Test-PythonOK {
    param([string]$Cmd)
    try {
        $v = & $Cmd -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $v) { return $null }
        $parts = $v.Trim().Split('.')
        $maj = [int]$parts[0]; $min = [int]$parts[1]
        if ($maj -gt $MIN_PY_MAJ -or ($maj -eq $MIN_PY_MAJ -and $min -ge $MIN_PY_MIN)) {
            return $v.Trim()
        }
    } catch {}
    return $null
}

$pythonBin = $null
$pythonVer = $null
foreach ($cand in @('python', 'python3', 'py')) {
    if (Get-Command $cand -ErrorAction SilentlyContinue) {
        $v = Test-PythonOK $cand
        if ($v) { $pythonBin = $cand; $pythonVer = $v; break }
    }
}

if ($pythonBin) {
    OK "Python $pythonVer ($pythonBin) - meets ${MIN_PY_MAJ}.${MIN_PY_MIN}+ requirement"
} else {
    Warn "Python ${MIN_PY_MAJ}.${MIN_PY_MIN}+ not found - will install via winget during real run."
}

# Git
if (Get-Command git -ErrorAction SilentlyContinue) {
    OK "git available ($((git --version) -replace '^git version '))"
} else {
    Warn 'git not found - will install via winget during real run.'
}

# Disk space ($HOME drive)
$drive = (Get-Item $env:USERPROFILE).PSDrive
$freeMb = [int]($drive.Free / 1MB)
if ($freeMb -lt $MIN_DISK_MB) {
    Fail "Only ${freeMb}MB free on $($drive.Name): - need at least ${MIN_DISK_MB}MB."
}
OK "Disk space: ${freeMb}MB free on $($drive.Name):"

# Port free
$portUsed = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue
if ($portUsed) {
    Fail "Port $PORT is in use. Stop whatever is listening, or edit app.py to change ports."
}
OK "Port $PORT is free"

# Existing install
if ((Test-Path $INSTALL_DIR) -and -not (Test-Path "$INSTALL_DIR\.git")) {
    Fail "$INSTALL_DIR exists but is not a git checkout. Remove or rename it first."
}
if (Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue) {
    Warn "Scheduled task '$TASK_NAME' already exists - will be overwritten."
}

Green 'All preflight checks passed.'
Write-Host ''

if ($Check) {
    Green '-Check complete. Re-run without -Check to install.'
    exit 0
}

# -------- Install Python / Git via winget if needed --------
if (-not $pythonBin -or -not (Get-Command git -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Fail "winget not available. Install Python 3.12 from https://python.org/downloads and Git from https://git-scm.com manually, then re-run."
    }
    Write-Host '>>> Installing missing packages via winget...'
    if (-not $pythonBin) {
        winget install -e --id Python.Python.3.12 --silent --accept-source-agreements --accept-package-agreements --scope user
    }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        winget install -e --id Git.Git --silent --accept-source-agreements --accept-package-agreements --scope user
    }
    # Refresh PATH so the newly-installed binaries are visible in this process
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
    foreach ($cand in @('python', 'python3', 'py')) {
        if (Get-Command $cand -ErrorAction SilentlyContinue) {
            $v = Test-PythonOK $cand
            if ($v) { $pythonBin = $cand; $pythonVer = $v; break }
        }
    }
    if (-not $pythonBin) { Fail 'Python install via winget did not land. Install manually from python.org.' }
}
OK "Using $pythonBin (Python $pythonVer) for the venv"

# -------- Clone / update repo --------
if (Test-Path "$INSTALL_DIR\.git") {
    Write-Host ">>> Updating existing repo at $INSTALL_DIR"
    Push-Location $INSTALL_DIR
    git pull --ff-only
    Pop-Location
} else {
    Write-Host ">>> Cloning into $INSTALL_DIR"
    git clone $REPO_URL $INSTALL_DIR
}

# -------- venv + deps --------
Write-Host ">>> Setting up Python venv with $pythonBin..."
& $pythonBin -m venv "$INSTALL_DIR\venv"
& "$INSTALL_DIR\venv\Scripts\python.exe" -m pip install --upgrade pip
& "$INSTALL_DIR\venv\Scripts\pip.exe" install -r "$INSTALL_DIR\requirements.txt"

Write-Host '>>> Smoke test...'
& "$INSTALL_DIR\venv\Scripts\python.exe" -c "import flask, requests, bs4, lxml, openpyxl; print('imports OK')"
if ($LASTEXITCODE -ne 0) { Fail 'Smoke test failed.' }
OK 'App imports cleanly'

# -------- Updater script (PowerShell) --------
Write-Host '>>> Installing updater script...'
$updateScript = @"
# Auto-updater for Open SEO Crawler (Windows).
`$ErrorActionPreference = 'Stop'
Set-Location '$INSTALL_DIR'
`$logFile = '$INSTALL_DIR\update.log'
function Log(`$msg) {
    `$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath `$logFile -Value "[`$ts] `$msg"
}

try {
    Log 'fetch origin'
    git fetch --quiet origin
    `$local  = git rev-parse HEAD
    `$remote = git rev-parse '@{u}'
    if (`$local -eq `$remote) {
        Log "already up to date (`$local)"
        exit 0
    }
    Log "update available: `$local -> `$remote"
    `$reqBefore = (Get-FileHash requirements.txt -Algorithm SHA1).Hash

    git pull --ff-only --quiet
    if (`$LASTEXITCODE -ne 0) { Log 'git pull failed - aborting'; exit 1 }

    `$reqAfter = (Get-FileHash requirements.txt -Algorithm SHA1).Hash
    if (`$reqBefore -ne `$reqAfter) {
        Log 'requirements.txt changed - reinstalling deps'
        & '$INSTALL_DIR\venv\Scripts\pip.exe' install --quiet --upgrade pip
        & '$INSTALL_DIR\venv\Scripts\pip.exe' install --quiet -r requirements.txt
    }

    Log 'smoke test'
    & '$INSTALL_DIR\venv\Scripts\python.exe' -c "import flask, requests, bs4, lxml, openpyxl" 2>&1 | Out-Null
    if (`$LASTEXITCODE -ne 0) {
        Log 'imports broke - rolling back'
        git reset --hard `$local
        exit 1
    }
    & '$INSTALL_DIR\venv\Scripts\python.exe' -m py_compile app.py 2>&1 | Out-Null
    if (`$LASTEXITCODE -ne 0) {
        Log 'py_compile failed - rolling back'
        git reset --hard `$local
        exit 1
    }

    Log "restarting scheduled task '$TASK_NAME'"
    Stop-ScheduledTask  -TaskName '$TASK_NAME' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName '$TASK_NAME'

    Log "update complete: now at `$remote"
} catch {
    Log "update failed: `$(`$_.Exception.Message)"
    exit 1
}
"@
$updateScript | Set-Content -Path "$INSTALL_DIR\update.ps1" -Encoding UTF8

# -------- Register Task Scheduler tasks --------
Write-Host '>>> Registering autostart Scheduled Task...'

# Main app: pythonw.exe runs without a console window
$action = New-ScheduledTaskAction `
    -Execute "$INSTALL_DIR\venv\Scripts\pythonw.exe" `
    -Argument "$INSTALL_DIR\app.py" `
    -WorkingDirectory $INSTALL_DIR

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 365)

Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
OK "Scheduled task '$TASK_NAME' registered (auto-starts at logon)"

# Update task: PowerShell update.ps1, 2 min after startup + daily at 03:30
Write-Host '>>> Registering daily auto-update Scheduled Task...'
$updateAction = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$INSTALL_DIR\update.ps1`""

$tsBoot = New-ScheduledTaskTrigger -AtStartup
$tsBoot.Delay = 'PT2M'
$tsDaily = New-ScheduledTaskTrigger -Daily -At '03:30'

Register-ScheduledTask -TaskName $UPDATE_TASK -Action $updateAction -Trigger @($tsBoot, $tsDaily) -Settings $settings -Force | Out-Null
OK "Scheduled task '$UPDATE_TASK' registered (boot+2min, daily 03:30)"

# -------- Start the crawler now --------
Write-Host '>>> Starting the crawler...'
Start-ScheduledTask -TaskName $TASK_NAME
Start-Sleep -Seconds 4

# Verify
try {
    $r = Invoke-WebRequest -Uri "http://localhost:$PORT/" -TimeoutSec 5 -UseBasicParsing
    OK "Service responding (HTTP $($r.StatusCode))"
} catch {
    Warn "Service may not be ready yet - try http://localhost:$PORT/ in a few seconds."
}

# -------- Collect LAN IPs --------
$lanIps = @()
try {
    $lanIps = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^127\.' -and $_.IPAddress -notmatch '^169\.254\.' -and $_.PrefixOrigin -in 'Dhcp','Manual' } |
        Select-Object -ExpandProperty IPAddress -Unique
} catch {}

Write-Host ''
Green '============================================================'
Green '  Open SEO Crawler is LIVE'
Green '============================================================'
Write-Host ''
Green '  On this computer:'
Green "      http://localhost:$PORT/"
if ($lanIps) {
    Write-Host ''
    Green '  From another device on the same network:'
    foreach ($ip in $lanIps) { Green "      http://${ip}:$PORT/" }
}
Write-Host ''
Green '============================================================'
Write-Host " Logs:       Get-Content `"$INSTALL_DIR\update.log`" -Tail 50 -Wait"
Write-Host " Restart:    Stop-ScheduledTask -TaskName $TASK_NAME; Start-ScheduledTask -TaskName $TASK_NAME"
Write-Host " Stop:       Stop-ScheduledTask -TaskName $TASK_NAME"
Write-Host " Disable:    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:`$false"
Write-Host ''
Write-Host " Auto-update: 2 min after boot + daily 03:30 ($UPDATE_TASK)"
Write-Host " Update now:  .\install-windows.ps1 -UpdateNow"
Write-Host " Update log:  Get-Content `"$INSTALL_DIR\update.log`" -Tail 50"
Write-Host " Disable AU:  Unregister-ScheduledTask -TaskName $UPDATE_TASK -Confirm:`$false"
Green '============================================================'

# Save URLs to a file
$urls = "Open SEO Crawler - access URLs`r`nInstalled: $(Get-Date)`r`n`r`nOn this computer:`r`n  http://localhost:$PORT/`r`n"
if ($lanIps) {
    $urls += "`r`nFrom another device on the same network:`r`n"
    foreach ($ip in $lanIps) { $urls += "  http://${ip}:$PORT/`r`n" }
}
$urls | Set-Content -Path "$INSTALL_DIR\ACCESS_URLS.txt" -Encoding UTF8
Write-Host ''
Write-Host " URLs also saved to: $INSTALL_DIR\ACCESS_URLS.txt"

# Auto-open default browser
Start-Process "http://localhost:$PORT/"
