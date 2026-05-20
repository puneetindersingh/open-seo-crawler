# Open SEO Crawler - Windows installer (PowerShell)
#   - No admin required
#   - No Scheduled Tasks
#   - Clone repo, set up venv, install deps, create shortcuts
#   - Optional auto-start on logon via Startup folder shortcut
#   - Auto-update: runs `git pull` on every logon before launching the app
#
# Usage (from a NORMAL PowerShell window - no admin):
#   iwr https://raw.githubusercontent.com/puneetindersingh/open-seo-crawler/master/install-windows.ps1 -OutFile install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Flags:
#   .\install.ps1 -Check        # preflight only, no changes
#   .\install.ps1 -UpdateNow    # git pull + reinstall deps if requirements changed
#   .\install.ps1 -NoAutostart  # skip the Startup folder shortcut

param(
    [switch]$Check,
    [switch]$UpdateNow,
    [switch]$NoAutostart
)

$ErrorActionPreference = 'Stop'
trap {
    Write-Host ""
    Write-Host ("ERROR: " + $_.Exception.Message) -ForegroundColor Red
    if ($_.InvocationInfo) {
        Write-Host ("  at line " + $_.InvocationInfo.ScriptLineNumber + ": " + $_.InvocationInfo.Line.Trim()) -ForegroundColor DarkGray
    }
    exit 1
}

$REPO_URL    = 'https://github.com/puneetindersingh/open-seo-crawler.git'
$INSTALL_DIR = Join-Path $env:USERPROFILE 'open-seo-crawler'
$APP_NAME    = 'Open SEO Crawler'
$PORT        = 5002
$MIN_PY_MAJ  = 3
$MIN_PY_MIN  = 10
$MIN_DISK_MB = 500

function Red    ($m) { Write-Host $m -ForegroundColor Red }
function Green  ($m) { Write-Host $m -ForegroundColor Green }
function Yellow ($m) { Write-Host $m -ForegroundColor Yellow }
function Fail   ($m) { Red ("FAIL: " + $m); exit 1 }
function OK     ($m) { Green ("  OK: " + $m) }
function Warn   ($m) { Yellow ("WARN: " + $m) }

function Make-Shortcut {
    param(
        [string]$LnkPath,
        [string]$TargetPath,
        [string]$Arguments,
        [string]$WorkingDir,
        [string]$IconPath
    )
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($LnkPath)
    $lnk.TargetPath       = $TargetPath
    $lnk.Arguments        = $Arguments
    $lnk.WorkingDirectory = $WorkingDir
    if ($IconPath) { $lnk.IconLocation = $IconPath }
    $lnk.Save()
}

# -------- -UpdateNow: pull + reinstall deps if needed --------
if ($UpdateNow) {
    if (-not (Test-Path (Join-Path $INSTALL_DIR '.git'))) {
        Fail ("Not installed yet at " + $INSTALL_DIR + ". Run the installer first.")
    }
    Push-Location $INSTALL_DIR
    $reqBefore = if (Test-Path 'requirements.txt') { (Get-FileHash 'requirements.txt' -Algorithm SHA1).Hash } else { '' }
    git pull --ff-only
    $reqAfter = if (Test-Path 'requirements.txt') { (Get-FileHash 'requirements.txt' -Algorithm SHA1).Hash } else { '' }
    if ($reqBefore -ne $reqAfter) {
        Write-Host '>>> requirements.txt changed - reinstalling deps'
        $pip = Join-Path $INSTALL_DIR 'venv\Scripts\pip.exe'
        & $pip install --upgrade pip
        & $pip install -r 'requirements.txt'
    }
    Pop-Location
    Green 'Update complete.'
    exit 0
}

# -------- Preflight --------
Write-Host '=============================================='
Write-Host ' Open SEO Crawler - Windows preflight checks'
if ($Check) { Write-Host ' (-Check mode: no changes will be made)' }
Write-Host '=============================================='

# OS
if (-not (($env:OS -eq 'Windows_NT') -or $IsWindows)) {
    Fail 'This script targets Windows. For Linux use install.sh, for macOS use install-macos.sh.'
}
$winVer = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption
if ($winVer) { OK ("OS: " + $winVer) } else { OK 'Windows detected' }

# Internet
try {
    Invoke-WebRequest -Uri 'https://github.com' -Method Head -TimeoutSec 5 -UseBasicParsing | Out-Null
    OK 'Internet reachable (github.com)'
} catch {
    Fail 'Cannot reach github.com - check internet connection.'
}

# Python >= MIN
function Test-PythonOK {
    param([string]$Cmd)
    try {
        $v = & $Cmd -c "import sys; print(str(sys.version_info.major)+'.'+str(sys.version_info.minor))" 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $v) { return $null }
        $parts = ($v.Trim()).Split('.')
        $maj = [int]$parts[0]
        $min = [int]$parts[1]
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
    $needMsg = [string]$MIN_PY_MAJ + '.' + [string]$MIN_PY_MIN + '+'
    OK ("Python " + $pythonVer + " (" + $pythonBin + ") - meets " + $needMsg + " requirement")
} else {
    Warn ("Python " + [string]$MIN_PY_MAJ + "." + [string]$MIN_PY_MIN + "+ not found - will install via winget during real run.")
}

# Git
if (Get-Command git -ErrorAction SilentlyContinue) {
    $gv = (git --version) -replace '^git version ', ''
    OK ("git available (" + $gv + ")")
} else {
    Warn 'git not found - will install via winget during real run.'
}

# Disk space (USERPROFILE drive)
$drive  = (Get-Item $env:USERPROFILE).PSDrive
$freeMb = [int]($drive.Free / 1MB)
if ($freeMb -lt $MIN_DISK_MB) {
    Fail ("Only " + [string]$freeMb + "MB free on " + $drive.Name + ": - need at least " + [string]$MIN_DISK_MB + "MB.")
}
OK ("Disk space: " + [string]$freeMb + "MB free on " + $drive.Name + ":")

# Port free
$portUsed = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue
if ($portUsed) {
    Fail ("Port " + [string]$PORT + " is in use. Stop whatever is listening, or edit app.py to change ports.")
}
OK ("Port " + [string]$PORT + " is free")

# Existing install
if ((Test-Path $INSTALL_DIR) -and -not (Test-Path (Join-Path $INSTALL_DIR '.git'))) {
    Fail ($INSTALL_DIR + ' exists but is not a git checkout. Remove or rename it first.')
}

Green 'All preflight checks passed.'
Write-Host ''

if ($Check) {
    Green '-Check complete. Re-run without -Check to install.'
    exit 0
}

# -------- Install Python / Git via winget if needed (user scope, no admin) --------
if (-not $pythonBin -or -not (Get-Command git -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Fail 'winget not available. Install Python 3.12 from https://python.org/downloads and Git from https://git-scm.com manually, then re-run.'
    }
    Write-Host '>>> Installing missing packages via winget (user scope, no admin)...'
    if (-not $pythonBin) {
        winget install -e --id Python.Python.3.12 --silent --accept-source-agreements --accept-package-agreements --scope user
    }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        winget install -e --id Git.Git --silent --accept-source-agreements --accept-package-agreements --scope user
    }
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
    foreach ($cand in @('python', 'python3', 'py')) {
        if (Get-Command $cand -ErrorAction SilentlyContinue) {
            $v = Test-PythonOK $cand
            if ($v) { $pythonBin = $cand; $pythonVer = $v; break }
        }
    }
    if (-not $pythonBin) { Fail 'Python install via winget did not land. Install manually from python.org.' }
}
OK ("Using " + $pythonBin + " (Python " + $pythonVer + ") for the venv")

# -------- Clone / update repo --------
if (Test-Path (Join-Path $INSTALL_DIR '.git')) {
    Write-Host (">>> Updating existing repo at " + $INSTALL_DIR)
    Push-Location $INSTALL_DIR
    git pull --ff-only
    Pop-Location
} else {
    Write-Host (">>> Cloning into " + $INSTALL_DIR)
    git clone $REPO_URL $INSTALL_DIR
}

# -------- venv + deps --------
Write-Host (">>> Setting up Python venv with " + $pythonBin + "...")
$venvPython  = Join-Path $INSTALL_DIR 'venv\Scripts\python.exe'
$venvPythonw = Join-Path $INSTALL_DIR 'venv\Scripts\pythonw.exe'
$venvPip     = Join-Path $INSTALL_DIR 'venv\Scripts\pip.exe'

& $pythonBin -m venv (Join-Path $INSTALL_DIR 'venv')
& $venvPython -m pip install --upgrade pip
& $venvPip install -r (Join-Path $INSTALL_DIR 'requirements.txt')

Write-Host '>>> Smoke test...'
& $venvPython -c "import flask, requests, bs4, lxml, openpyxl; print('imports OK')"
if ($LASTEXITCODE -ne 0) { Fail 'Smoke test failed.' }
OK 'App imports cleanly'

# -------- Helper scripts (no admin, no tasks) --------
Write-Host '>>> Installing helper scripts (Run / Stop / Update)...'

$runPs1Path       = Join-Path $INSTALL_DIR 'Run.ps1'
$stopPs1Path      = Join-Path $INSTALL_DIR 'Stop.ps1'
$updatePs1Path    = Join-Path $INSTALL_DIR 'Update.ps1'
$autostartPs1Path = Join-Path $INSTALL_DIR 'Autostart.ps1'

$runPs1 = @'
# Run the Open SEO Crawler in this window.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
$py = Join-Path $PSScriptRoot 'venv\Scripts\python.exe'
if (-not (Test-Path $py)) {
    Write-Host 'venv missing - re-run install-windows.ps1' -ForegroundColor Red
    exit 1
}
Write-Host 'Open SEO Crawler starting on http://localhost:5002/ ...'
& $py (Join-Path $PSScriptRoot 'app.py')
'@
Set-Content -Path $runPs1Path -Value $runPs1 -Encoding UTF8

$stopPs1 = @'
# Stop any Open SEO Crawler python process bound to port 5002.
$conns = Get-NetTCPConnection -LocalPort 5002 -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
    Write-Host 'Nothing listening on port 5002.'
    exit 0
}
$pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($targetPid in $pids) {
    try {
        Stop-Process -Id $targetPid -Force -ErrorAction Stop
        Write-Host ("Stopped PID " + $targetPid)
    } catch {
        Write-Host ("Could not stop PID " + $targetPid + ": " + $_.Exception.Message) -ForegroundColor Yellow
    }
}
'@
Set-Content -Path $stopPs1Path -Value $stopPs1 -Encoding UTF8

$updatePs1 = @'
# Pull latest code and reinstall deps if requirements.txt changed.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
$reqBefore = if (Test-Path 'requirements.txt') { (Get-FileHash 'requirements.txt' -Algorithm SHA1).Hash } else { '' }
git pull --ff-only
$reqAfter  = if (Test-Path 'requirements.txt') { (Get-FileHash 'requirements.txt' -Algorithm SHA1).Hash } else { '' }
if ($reqBefore -ne $reqAfter) {
    Write-Host 'requirements.txt changed - reinstalling deps'
    & (Join-Path $PSScriptRoot 'venv\Scripts\pip.exe') install --upgrade pip
    & (Join-Path $PSScriptRoot 'venv\Scripts\pip.exe') install -r 'requirements.txt'
}
Write-Host 'Update complete.'
'@
Set-Content -Path $updatePs1Path -Value $updatePs1 -Encoding UTF8

# Autostart.ps1 - silently pulls latest, reinstalls deps if requirements changed, then launches pythonw.
$autostartPs1 = @'
# Logon autostart: pull latest, reinstall deps if needed, then launch the app silently.
# All output goes to autostart.log; failures never block the app from starting.
$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot
$logFile = Join-Path $PSScriptRoot 'autostart.log'
function Log($m) {
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -LiteralPath $logFile -Value ('[' + $ts + '] ' + $m)
}

# Trim log if it gets large (keep last 500 lines)
if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 200KB)) {
    $tail = Get-Content $logFile -Tail 500
    Set-Content -Path $logFile -Value $tail -Encoding UTF8
}

Log 'autostart begin'

# Quick git pull (5s network timeout)
try {
    $reqBefore = if (Test-Path 'requirements.txt') { (Get-FileHash 'requirements.txt' -Algorithm SHA1).Hash } else { '' }
    $localBefore = (git rev-parse HEAD 2>$null)

    $job = Start-Job -ScriptBlock {
        param($dir)
        Set-Location $dir
        git fetch --quiet origin 2>&1
        git pull --ff-only --quiet 2>&1
    } -ArgumentList $PSScriptRoot

    if (Wait-Job $job -Timeout 30) {
        $out = Receive-Job $job
        if ($out) { Log ('git: ' + ($out -join ' | ')) }
    } else {
        Log 'git pull timed out after 30s - skipping update this run'
        Stop-Job $job -ErrorAction SilentlyContinue
    }
    Remove-Job $job -Force -ErrorAction SilentlyContinue

    $localAfter = (git rev-parse HEAD 2>$null)
    if ($localBefore -and $localAfter -and ($localBefore -ne $localAfter)) {
        Log ('updated: ' + $localBefore.Substring(0,7) + ' -> ' + $localAfter.Substring(0,7))
        $reqAfter = if (Test-Path 'requirements.txt') { (Get-FileHash 'requirements.txt' -Algorithm SHA1).Hash } else { '' }
        if ($reqBefore -ne $reqAfter) {
            Log 'requirements.txt changed - reinstalling deps'
            $pip = Join-Path $PSScriptRoot 'venv\Scripts\pip.exe'
            & $pip install --quiet --upgrade pip 2>&1 | Out-Null
            & $pip install --quiet -r 'requirements.txt' 2>&1 | Out-Null
            Log 'deps reinstalled'
        }
        # Quick import smoke - if it breaks, roll back so the app still starts
        $py = Join-Path $PSScriptRoot 'venv\Scripts\python.exe'
        & $py -c "import flask, requests, bs4, lxml, openpyxl" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Log 'imports broke after update - rolling back'
            git reset --hard $localBefore 2>&1 | Out-Null
        }
    } else {
        Log 'already up to date'
    }
} catch {
    Log ('update step failed: ' + $_.Exception.Message)
}

# Launch the app (pythonw, no console)
$pyw = Join-Path $PSScriptRoot 'venv\Scripts\pythonw.exe'
$app = Join-Path $PSScriptRoot 'app.py'
Log ('launching ' + $pyw + ' ' + $app)
Start-Process -FilePath $pyw -ArgumentList ('"' + $app + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
Log 'autostart end'
'@
Set-Content -Path $autostartPs1Path -Value $autostartPs1 -Encoding UTF8

OK 'Run.ps1 / Stop.ps1 / Update.ps1 / Autostart.ps1 written'

# -------- Shortcuts --------
Write-Host '>>> Creating shortcuts...'

$pwshArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $runPs1Path + '"'
$pwshExe  = (Get-Command powershell.exe).Source

$startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$startupDir   = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$desktopDir   = [Environment]::GetFolderPath('Desktop')

if (-not (Test-Path $startMenuDir)) { New-Item -ItemType Directory -Force -Path $startMenuDir | Out-Null }
if (-not (Test-Path $startupDir))   { New-Item -ItemType Directory -Force -Path $startupDir   | Out-Null }

# Visible launcher (Run.ps1) - Start Menu + Desktop
$visibleLnk = Join-Path $startMenuDir ($APP_NAME + '.lnk')
Make-Shortcut -LnkPath $visibleLnk -TargetPath $pwshExe -Arguments $pwshArgs -WorkingDir $INSTALL_DIR
OK ('Start Menu shortcut: ' + $visibleLnk)

$desktopLnk = Join-Path $desktopDir ($APP_NAME + '.lnk')
Make-Shortcut -LnkPath $desktopLnk -TargetPath $pwshExe -Arguments $pwshArgs -WorkingDir $INSTALL_DIR
OK ('Desktop shortcut:    ' + $desktopLnk)

# Autostart - silent, pulls latest then launches (Autostart.ps1)
if (-not $NoAutostart) {
    $autostartLnk = Join-Path $startupDir ($APP_NAME + ' (Autostart).lnk')
    $autostartArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $autostartPs1Path + '"'
    Make-Shortcut -LnkPath $autostartLnk -TargetPath $pwshExe -Arguments $autostartArgs -WorkingDir $INSTALL_DIR
    OK ('Autostart shortcut:  ' + $autostartLnk + ' (auto-updates on each logon)')
} else {
    Warn 'Autostart skipped (-NoAutostart). Use the Start Menu shortcut to launch manually.'
}

# -------- Start the crawler now (silent, in background) --------
Write-Host '>>> Starting the crawler...'
Start-Process -FilePath $venvPythonw -ArgumentList ('"' + (Join-Path $INSTALL_DIR 'app.py') + '"') -WorkingDirectory $INSTALL_DIR -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 4

# Verify
try {
    $r = Invoke-WebRequest -Uri ('http://localhost:' + [string]$PORT + '/') -TimeoutSec 5 -UseBasicParsing
    OK ('Service responding (HTTP ' + [string]$r.StatusCode + ')')
} catch {
    Warn ('Service may not be ready yet - try http://localhost:' + [string]$PORT + '/ in a few seconds.')
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
Green ('      http://localhost:' + [string]$PORT + '/')
if ($lanIps) {
    Write-Host ''
    Green '  From another device on the same network:'
    foreach ($ip in $lanIps) {
        $url = 'http://' + $ip + ':' + [string]$PORT + '/'
        Green ('      ' + $url)
    }
}
Write-Host ''
Green '============================================================'
Write-Host (' Run manually:   ' + $runPs1Path)
Write-Host (' Stop:           ' + $stopPs1Path)
Write-Host (' Update now:     ' + $updatePs1Path + '     (or:  .\install-windows.ps1 -UpdateNow)')
Write-Host (' Auto-update:    runs every logon via ' + $autostartPs1Path)
Write-Host (' Autostart log:  ' + (Join-Path $INSTALL_DIR 'autostart.log'))
Write-Host (' Disable auto:   delete shortcut in ' + $startupDir)
Green '============================================================'

# Save URLs to a file
$urls = "Open SEO Crawler - access URLs`r`nInstalled: " + (Get-Date).ToString() + "`r`n`r`nOn this computer:`r`n  http://localhost:" + [string]$PORT + "/`r`n"
if ($lanIps) {
    $urls += "`r`nFrom another device on the same network:`r`n"
    foreach ($ip in $lanIps) {
        $urls += "  http://" + $ip + ":" + [string]$PORT + "/`r`n"
    }
}
Set-Content -Path (Join-Path $INSTALL_DIR 'ACCESS_URLS.txt') -Value $urls -Encoding UTF8
Write-Host ''
Write-Host (' URLs also saved to: ' + (Join-Path $INSTALL_DIR 'ACCESS_URLS.txt'))

# Auto-open default browser
Start-Process ('http://localhost:' + [string]$PORT + '/')
