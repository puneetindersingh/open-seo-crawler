# Robust restart/launch helper for Open SEO Crawler (Windows).
#
# Invoked detached by the in-app "Update" button (POST /restart) and by the
# installer's Update.ps1 / Autostart.ps1. It exists because the old one-shot
# "taskkill then start" restart could silently leave nothing running: if the
# fresh pythonw tried to bind port 5002 while the just-killed socket was still
# in TIME_WAIT, it died with no console and no log, and the install looked
# bricked. This helper instead:
#   1. kills the old PID (and anything still holding the port),
#   2. waits for the port to actually be released,
#   3. starts the app and VERIFIES it answers on /version, retrying a few
#      times, and finally falls back to a logged console start so a genuine
#      failure is diagnosable instead of invisible.
param(
    [int]$OldPid = 0,
    [int]$Port = 5002
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$log = Join-Path $root 'restart.log'
function Log($m) {
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -LiteralPath $log -Value ('[' + $ts + '] ' + $m)
}
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 200KB)) {
    Set-Content -Path $log -Value (Get-Content $log -Tail 400) -Encoding UTF8
}

$pyw   = Join-Path $root 'venv\Scripts\pythonw.exe'
$py    = Join-Path $root 'venv\Scripts\python.exe'
$appPy = Join-Path $root 'app.py'
if (-not (Test-Path $pyw)) { $pyw = $py }

Log ("restart helper begin (OldPid=" + $OldPid + " Port=" + $Port + ")")

function Stop-Port {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
            try { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } catch {}
        }
}

# 1. Kill the outgoing process and anything else squatting on the port.
if ($OldPid -gt 0) { try { Stop-Process -Id $OldPid -Force -ErrorAction SilentlyContinue } catch {} }
Stop-Port

# 2. Wait (up to ~10s) for the port to be released so the new bind succeeds.
for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
}

# 3. Start + verify, retrying so a transient bind failure never bricks it.
$ok = $false
for ($attempt = 1; $attempt -le 5 -and -not $ok; $attempt++) {
    Log ("start attempt " + $attempt)
    Start-Process -FilePath $pyw -ArgumentList ('"' + $appPy + '"') -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    for ($j = 0; $j -lt 12; $j++) {
        Start-Sleep -Milliseconds 700
        try {
            $r = Invoke-WebRequest ('http://localhost:' + $Port + '/version') -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { $ok = $true; break }
        } catch {}
    }
    if (-not $ok) { Stop-Port }   # clear the failed attempt before retrying
}

if ($ok) {
    Log 'app is live'
} else {
    # Last resort: console python with output captured, so a real startup
    # error (bad dependency, syntax error) lands in restart.err.log.
    Log 'all silent starts failed - launching with output capture'
    try {
        Start-Process -FilePath $py -ArgumentList ('"' + $appPy + '"') -WorkingDirectory $root `
            -WindowStyle Hidden `
            -RedirectStandardError  (Join-Path $root 'restart.err.log') `
            -RedirectStandardOutput (Join-Path $root 'restart.out.log') | Out-Null
    } catch { Log ('fallback start failed: ' + $_.Exception.Message) }
}
Log 'restart helper end'
