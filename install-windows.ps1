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

# Locate a REAL python.exe, bypassing the Microsoft Store alias stubs in
# %LOCALAPPDATA%\Microsoft\WindowsApps (which Get-Command happily returns, but
# which only pop open the Store and report "Python was not found"). Checks the
# PEP-514 registry keys first, then the standard winget / python.org dirs.
function Find-RealPython {
    $cands = @()
    foreach ($root in 'HKCU:\Software\Python\PythonCore', 'HKLM:\Software\Python\PythonCore') {
        if (Test-Path $root) {
            Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
                $exe = (Get-ItemProperty -Path (Join-Path $_.PSPath 'InstallPath') -ErrorAction SilentlyContinue).ExecutablePath
                if ($exe) { $cands += $exe }
            }
        }
    }
    $globs = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python3*\python.exe'),
        (Join-Path $env:PROGRAMFILES 'Python3*\python.exe')
    )
    if (${env:ProgramFiles(x86)}) { $globs += (Join-Path ${env:ProgramFiles(x86)} 'Python3*\python.exe') }
    foreach ($g in $globs) {
        Get-ChildItem $g -ErrorAction SilentlyContinue | ForEach-Object { $cands += $_.FullName }
    }
    foreach ($exe in ($cands | Select-Object -Unique)) {
        if ($exe -and ($exe -notmatch 'WindowsApps') -and (Test-Path $exe)) {
            if (Test-PythonOK $exe) { return $exe }
        }
    }
    return $null
}

$pythonBin = $null
$pythonVer = $null
foreach ($cand in @('python', 'python3', 'py')) {
    $g = Get-Command $cand -ErrorAction SilentlyContinue
    if ($g -and ($g.Source -notmatch 'WindowsApps')) {
        $v = Test-PythonOK $cand
        if ($v) { $pythonBin = $g.Source; $pythonVer = $v; break }
    }
}
if (-not $pythonBin) {
    $real = Find-RealPython
    if ($real) { $pythonBin = $real; $pythonVer = Test-PythonOK $real }
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
    # --source winget is REQUIRED. Without it, winget also queries the msstore
    # source, which on many machines fails with a certificate error
    # (0x8a15005e "server certificate did not match") and aborts the whole
    # install with "specify one of them using the --source option".
    if (-not $pythonBin) {
        winget install -e --id Python.Python.3.12 --source winget --scope user --silent --accept-source-agreements --accept-package-agreements
    }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        winget install -e --id Git.Git --source winget --scope user --silent --accept-source-agreements --accept-package-agreements
    }
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
    if (-not $pythonBin) {
        foreach ($cand in @('python', 'python3', 'py')) {
            $g = Get-Command $cand -ErrorAction SilentlyContinue
            if ($g -and ($g.Source -notmatch 'WindowsApps')) {
                $v = Test-PythonOK $cand
                if ($v) { $pythonBin = $g.Source; $pythonVer = $v; break }
            }
        }
        # PATH often isn't refreshed in-session after a winget install, and the
        # Store alias stub can shadow the real python - resolve it by abs path.
        if (-not $pythonBin) {
            $real = Find-RealPython
            if ($real) { $pythonBin = $real; $pythonVer = Test-PythonOK $real }
        }
    }
    if (-not $pythonBin) { Fail 'Python install via winget did not land. Install manually from python.org.' }
}
OK ("Using " + $pythonBin + " (Python " + $pythonVer + ") for the venv")

# -------- Stop any running app so git can rewrite files --------
# Windows holds file locks on running .exe / loaded modules; if pythonw
# from a previous install is still bound to the port, git fetch/pull
# can fail with "Unlink of file ... failed" on .git/objects/pack/*.
Write-Host '>>> Stopping any previously-running crawler process...'
$conns = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    $pidsToKill = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($targetPid in $pidsToKill) {
        try {
            Stop-Process -Id $targetPid -Force -ErrorAction Stop
            OK ('Stopped previous instance (PID ' + [string]$targetPid + ')')
        } catch {
            Warn ('Could not stop PID ' + [string]$targetPid + ': ' + $_.Exception.Message)
        }
    }
    Start-Sleep -Seconds 2
}

# -------- Clone / update repo --------
# Disable git's interactive unlink prompt and opportunistic gc, both of
# which trip over Windows file locking and stall the install.
$env:GIT_OPTIONAL_LOCKS = '0'

if (Test-Path (Join-Path $INSTALL_DIR '.git')) {
    Write-Host (">>> Updating existing repo at " + $INSTALL_DIR)
    Push-Location $INSTALL_DIR
    git -c gc.auto=0 fetch --quiet origin master
    if ($LASTEXITCODE -ne 0) {
        Pop-Location
        Fail 'git fetch failed - check network / antivirus.'
    }
    # Try a clean fast-forward; if local diverged (forced-push, or a
    # prior failed pull left the tree mid-state), hard-reset to origin.
    # Untracked installer artifacts (Run.ps1, autostart.log, etc.) are
    # ignored via .gitignore so they survive the reset.
    git -c gc.auto=0 pull --ff-only --quiet origin master 2>$null
    if ($LASTEXITCODE -ne 0) {
        Warn 'Fast-forward not possible (diverging branches). Hard-resetting to origin/master...'
        git -c gc.auto=0 reset --hard origin/master
        if ($LASTEXITCODE -ne 0) {
            Pop-Location
            Fail 'git reset failed - manual cleanup needed.'
        }
    }
    Pop-Location
} else {
    Write-Host (">>> Cloning into " + $INSTALL_DIR)
    git -c gc.auto=0 clone $REPO_URL $INSTALL_DIR
    if ($LASTEXITCODE -ne 0) { Fail 'git clone failed - check network / antivirus.' }
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
$env:GIT_OPTIONAL_LOCKS = '0'
Set-Location -Path $PSScriptRoot

# Stop the app first so git can rewrite tracked files without lock conflicts.
$conns = Get-NetTCPConnection -LocalPort 5002 -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    Write-Host 'Stopping running app...'
    $conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
        try { Stop-Process -Id $_ -Force -ErrorAction Stop } catch {}
    }
    Start-Sleep -Seconds 2
}

$reqBefore = if (Test-Path 'requirements.txt') { (Get-FileHash 'requirements.txt' -Algorithm SHA1).Hash } else { '' }
git -c gc.auto=0 fetch --quiet origin master
git -c gc.auto=0 pull --ff-only --quiet origin master 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Fast-forward not possible - hard-resetting to origin/master.' -ForegroundColor Yellow
    git -c gc.auto=0 reset --hard origin/master
}
$reqAfter  = if (Test-Path 'requirements.txt') { (Get-FileHash 'requirements.txt' -Algorithm SHA1).Hash } else { '' }
if ($reqBefore -ne $reqAfter) {
    Write-Host 'requirements.txt changed - reinstalling deps'
    & (Join-Path $PSScriptRoot 'venv\Scripts\pip.exe') install --upgrade pip
    & (Join-Path $PSScriptRoot 'venv\Scripts\pip.exe') install -r 'requirements.txt'
}

# Relaunch the app if it was running before we stopped it.
if ($conns) {
    Write-Host 'Restarting app...'
    $pyw = Join-Path $PSScriptRoot 'venv\Scripts\pythonw.exe'
    Start-Process -FilePath $pyw -ArgumentList ('"' + (Join-Path $PSScriptRoot 'app.py') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
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
        $env:GIT_OPTIONAL_LOCKS = '0'
        Set-Location $dir
        git -c gc.auto=0 fetch --quiet origin master 2>&1
        $pullOut = git -c gc.auto=0 pull --ff-only --quiet origin master 2>&1
        if ($LASTEXITCODE -ne 0) {
            'fast-forward not possible - hard-reset to origin/master'
            git -c gc.auto=0 reset --hard origin/master 2>&1
        } else {
            $pullOut
        }
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
