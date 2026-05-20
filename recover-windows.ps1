# Open SEO Crawler - Windows recovery script
# One-shot fix for the "uncommitted changes" + "Unlink of file" install state.
#
# Usage:
#   iwr https://raw.githubusercontent.com/puneetindersingh/open-seo-crawler/master/recover-windows.ps1 -OutFile recover.ps1
#   powershell -ExecutionPolicy Bypass -File .\recover.ps1

$ErrorActionPreference = 'Continue'

$InstallDir = Join-Path $env:USERPROFILE 'open-seo-crawler'
$Port       = 5002

Write-Host '============================================================'
Write-Host ' Open SEO Crawler - recovery'
Write-Host '============================================================'

if (-not (Test-Path (Join-Path $InstallDir '.git'))) {
    Write-Host ("No git checkout at " + $InstallDir) -ForegroundColor Red
    Write-Host 'Run install-windows.ps1 first.' -ForegroundColor Red
    exit 1
}

# 1. Stop the running app (frees file locks on .git pack files)
Write-Host ''
Write-Host '>>> Stopping running app on port 5002...'
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    $stopped = 0
    foreach ($conn in $conns) {
        try {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction Stop
            $stopped++
        } catch {
            Write-Host ('  could not stop PID ' + $conn.OwningProcess + ': ' + $_.Exception.Message) -ForegroundColor Yellow
        }
    }
    Write-Host ('  stopped ' + [string]$stopped + ' process(es)') -ForegroundColor Green
    Start-Sleep -Seconds 2
} else {
    Write-Host '  nothing running on port 5002' -ForegroundColor Green
}

# 2. Hard-reset to origin/master with locks/gc suppressed
Write-Host ''
Write-Host '>>> Resetting working tree to origin/master...'
$env:GIT_OPTIONAL_LOCKS = '0'
Push-Location $InstallDir
try {
    git -c gc.auto=0 fetch --quiet origin master
    if ($LASTEXITCODE -ne 0) {
        Write-Host '  git fetch failed' -ForegroundColor Red
        Pop-Location
        exit 1
    }
    git -c gc.auto=0 reset --hard origin/master
    if ($LASTEXITCODE -ne 0) {
        Write-Host '  git reset failed' -ForegroundColor Red
        Pop-Location
        exit 1
    }
    $sha = (git rev-parse --short HEAD).Trim()
    Write-Host ('  reset to ' + $sha) -ForegroundColor Green
} finally {
    Pop-Location
}

# 3. Start the app via pythonw (hidden, no console)
Write-Host ''
Write-Host '>>> Starting the crawler...'
$venvPythonw = Join-Path $InstallDir 'venv\Scripts\pythonw.exe'
if (-not (Test-Path $venvPythonw)) {
    Write-Host ('  pythonw missing at ' + $venvPythonw) -ForegroundColor Red
    Write-Host '  re-run install-windows.ps1 to rebuild the venv' -ForegroundColor Red
    exit 1
}
$appPy = Join-Path $InstallDir 'app.py'
Start-Process -FilePath $venvPythonw -ArgumentList ('"' + $appPy + '"') -WorkingDirectory $InstallDir -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 4

# 4. Verify
try {
    $r = Invoke-WebRequest -Uri ('http://localhost:' + [string]$Port + '/') -TimeoutSec 5 -UseBasicParsing
    Write-Host ('  service responding (HTTP ' + [string]$r.StatusCode + ')') -ForegroundColor Green
} catch {
    Write-Host '  service not yet responding - give it a few more seconds' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host ' Recovery complete' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
Write-Host ''
Write-Host ('  Open: http://localhost:' + [string]$Port + '/')
Write-Host ''
Start-Process ('http://localhost:' + [string]$Port + '/')
