#!/usr/bin/env bash
# Open SEO Crawler — macOS installer
#   - preflight checks
#   - launchd autostart on login + 2 min after boot
#   - daily auto-update via launchd timer (git pull + restart if changed)
#
# Usage:
#   ./install-macos.sh              # install + enable autostart + auto-update
#   ./install-macos.sh --check      # preflight only, no changes
#   ./install-macos.sh --update-now # run the updater immediately
set -euo pipefail

REPO_URL="https://github.com/puneetindersingh/open-seo-crawler.git"
INSTALL_DIR="$HOME/open-seo-crawler"
LABEL="io.openseocrawler.app"
UPDATE_LABEL="io.openseocrawler.update"
PLIST_DIR="$HOME/Library/LaunchAgents"
APP_PLIST="$PLIST_DIR/${LABEL}.plist"
UPDATE_PLIST="$PLIST_DIR/${UPDATE_LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/OpenSEOCrawler"
PORT=5002
MIN_PY_MAJOR=3
MIN_PY_MINOR=10
MIN_DISK_MB=500
RUN_USER="$(id -un)"

MODE="install"
case "${1:-}" in
  --check)      MODE="check" ;;
  --update-now) MODE="update-now" ;;
esac

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
fail()   { red "FAIL: $*"; exit 1; }
ok()     { green "  OK: $*"; }
warn()   { yellow "WARN: $*"; }

# ---------- --update-now: just trigger the updater agent ----------
if [ "$MODE" = "update-now" ]; then
  launchctl kickstart -k "gui/$(id -u)/${UPDATE_LABEL}" 2>/dev/null \
    || launchctl start "${UPDATE_LABEL}"
  echo "Updater triggered. Tail logs with:"
  echo "  tail -f $LOG_DIR/update.log"
  exit 0
fi

# ---------- Preflight ----------
echo "=============================================="
echo " Open SEO Crawler — macOS preflight checks"
[ "$MODE" = "check" ] && echo " (--check mode: no changes will be made)"
echo "=============================================="

# Must be macOS
[ "$(uname -s)" = "Darwin" ] || fail "This script targets macOS (Darwin). For Linux, use install.sh."
SW_VERS=$(sw_vers -productVersion 2>/dev/null || echo "unknown")
ok "macOS $SW_VERS"

# Arch (Apple Silicon vs Intel)
ARCH=$(uname -m)
ok "Architecture: $ARCH"

# Must not be root
[ "$EUID" -eq 0 ] && fail "Run as your normal user, not root."
ok "Running as non-root user: $RUN_USER"

# Internet
curl -fsSL --max-time 5 https://github.com >/dev/null 2>&1 || fail "Cannot reach github.com — check internet."
ok "Internet reachable (github.com)"

# Homebrew (will install Python if needed)
if ! command -v brew >/dev/null 2>&1; then
  if [ "$MODE" = "check" ]; then
    warn "Homebrew not installed — will be installed during real run."
  else
    yellow "Homebrew not installed — installing now (you'll be prompted for your password)..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Refresh shell environment so brew is on PATH
    if [ "$ARCH" = "arm64" ]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    else
      eval "$(/usr/local/bin/brew shellenv)"
    fi
  fi
fi
if command -v brew >/dev/null 2>&1; then ok "Homebrew available ($(brew --prefix))"; fi

# Python ≥ 3.10
python_ok() {
  local bin="$1"
  command -v "$bin" >/dev/null 2>&1 || return 1
  "$bin" -c "import sys; sys.exit(0 if sys.version_info >= (${MIN_PY_MAJOR}, ${MIN_PY_MINOR}) else 1)" 2>/dev/null
}

PYTHON_BIN=""
for candidate in python3 python3.13 python3.12 python3.11 python3.10; do
  if python_ok "$candidate"; then PYTHON_BIN="$candidate"; break; fi
done

if [ -n "$PYTHON_BIN" ]; then
  PY_VER=$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  ok "Python $PY_VER ($PYTHON_BIN) — meets ${MIN_PY_MAJOR}.${MIN_PY_MINOR}+ requirement"
else
  warn "Python ${MIN_PY_MAJOR}.${MIN_PY_MINOR}+ not found — will install python@3.12 via Homebrew."
fi

# Git
if ! command -v git >/dev/null 2>&1; then
  warn "git not found — will install via Homebrew (or Xcode Command Line Tools)."
else
  ok "git available ($(git --version | awk '{print $3}'))"
fi

# Disk space
FREE_MB=$(df -m "$HOME" | awk 'NR==2 {print $4}')
[ "$FREE_MB" -lt "$MIN_DISK_MB" ] && fail "Only ${FREE_MB}MB free in \$HOME — need at least ${MIN_DISK_MB}MB."
ok "Disk space: ${FREE_MB}MB free in \$HOME"

# Port free
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Port $PORT is in use. Stop whatever is listening, or edit app.py to change ports."
fi
ok "Port $PORT is free"

# Existing install
if [ -d "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR/.git" ]; then
  fail "$INSTALL_DIR exists but is not a git checkout. Remove or rename it first."
fi
if [ -f "$APP_PLIST" ]; then
  warn "LaunchAgent ${LABEL} already exists — will be overwritten + reloaded."
fi

green "All preflight checks passed."
echo

if [ "$MODE" = "check" ]; then
  green "--check complete. Re-run without --check to install."
  exit 0
fi

# ---------- Install Python / Git via Homebrew if needed ----------
if [ -z "$PYTHON_BIN" ] || ! command -v git >/dev/null 2>&1; then
  echo ">>> Installing missing packages via Homebrew..."
  command -v brew >/dev/null 2>&1 || fail "Homebrew install failed. Re-run after installing brew manually."
  [ -z "$PYTHON_BIN" ] && brew install python@3.12
  command -v git >/dev/null 2>&1 || brew install git
  # Refresh PATH (brew links to /opt/homebrew or /usr/local)
  for candidate in python3 python3.13 python3.12 python3.11 python3.10; do
    if python_ok "$candidate"; then PYTHON_BIN="$candidate"; break; fi
  done
  [ -n "$PYTHON_BIN" ] || fail "Python install via Homebrew didn't land — install manually from python.org."
fi
ok "Using $PYTHON_BIN for the venv"

# ---------- Clone / update repo ----------
if [ -d "$INSTALL_DIR/.git" ]; then
  echo ">>> Updating existing repo at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo ">>> Cloning into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# ---------- venv + deps ----------
echo ">>> Setting up Python venv with $PYTHON_BIN..."
"$PYTHON_BIN" -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --upgrade pip
"$INSTALL_DIR/venv/bin/pip" install -r "$INSTALL_DIR/requirements.txt"

echo ">>> Smoke test..."
"$INSTALL_DIR/venv/bin/python3" -c "import flask, requests, bs4, lxml, openpyxl; print('imports OK')"
"$INSTALL_DIR/venv/bin/python3" -m py_compile "$INSTALL_DIR/app.py"
ok "App imports + compiles"

# ---------- Updater script ----------
echo ">>> Installing updater script..."
mkdir -p "$LOG_DIR"
cat > "$INSTALL_DIR/update.sh" <<'UPDATE_EOF'
#!/usr/bin/env bash
# Auto-updater for Open SEO Crawler (macOS).
# Pulls latest, reinstalls deps if requirements.txt changed, smoke-tests,
# then kickstarts the LaunchAgent. Bails (with rollback) on any failure.
set -euo pipefail

INSTALL_DIR="__INSTALL_DIR__"
LABEL="__LABEL__"
LOG_DIR="__LOG_DIR__"
cd "$INSTALL_DIR"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG_DIR/update.log"; }

log "fetch origin"
git fetch --quiet origin

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse '@{u}' 2>/dev/null || git rev-parse origin/HEAD)

if [ "$LOCAL" = "$REMOTE" ]; then
  log "already up to date ($LOCAL)"
  exit 0
fi

log "update available: $LOCAL -> $REMOTE"
REQ_BEFORE=$(shasum -a 1 requirements.txt | awk '{print $1}')

if ! git pull --ff-only --quiet; then
  log "git pull failed. Aborting update."
  exit 1
fi

REQ_AFTER=$(shasum -a 1 requirements.txt | awk '{print $1}')
if [ "$REQ_BEFORE" != "$REQ_AFTER" ]; then
  log "requirements.txt changed — reinstalling deps"
  "$INSTALL_DIR/venv/bin/pip" install --quiet --upgrade pip
  "$INSTALL_DIR/venv/bin/pip" install --quiet -r requirements.txt
fi

log "smoke test"
if ! "$INSTALL_DIR/venv/bin/python3" -c "import flask, requests, bs4, lxml, openpyxl" 2>>"$LOG_DIR/update.log"; then
  log "imports broke — rolling back"
  git reset --hard "$LOCAL"
  exit 1
fi
if ! "$INSTALL_DIR/venv/bin/python3" -m py_compile app.py 2>>"$LOG_DIR/update.log"; then
  log "py_compile failed — rolling back"
  git reset --hard "$LOCAL"
  exit 1
fi

log "kickstarting $LABEL"
launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>&1 | tee -a "$LOG_DIR/update.log" || true

log "update complete: now at $REMOTE"
UPDATE_EOF

sed -i '' "s|__INSTALL_DIR__|$INSTALL_DIR|g; s|__LABEL__|$LABEL|g; s|__LOG_DIR__|$LOG_DIR|g" "$INSTALL_DIR/update.sh"
chmod +x "$INSTALL_DIR/update.sh"

# ---------- launchd: main app agent ----------
echo ">>> Writing LaunchAgent for the crawler..."
mkdir -p "$PLIST_DIR"
cat > "$APP_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALL_DIR}/venv/bin/python3</string>
    <string>${INSTALL_DIR}/app.py</string>
  </array>
  <key>WorkingDirectory</key><string>${INSTALL_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>${LOG_DIR}/app.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/app.log</string>
</dict>
</plist>
EOF

# ---------- launchd: updater agent ----------
echo ">>> Writing LaunchAgent for the daily updater..."
cat > "$UPDATE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${UPDATE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALL_DIR}/update.sh</string>
  </array>
  <key>WorkingDirectory</key><string>${INSTALL_DIR}</string>
  <!-- Run 2 min after login and once a day at 03:30 local time. -->
  <key>RunAtLoad</key><false/>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
  </array>
  <key>StandardOutPath</key><string>${LOG_DIR}/update.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/update.log</string>
</dict>
</plist>
EOF

# Reload both agents
echo ">>> Loading LaunchAgents..."
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/${UPDATE_LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$APP_PLIST"
launchctl bootstrap "gui/$(id -u)" "$UPDATE_PLIST"

# Fire the updater once shortly after login (separate kickstart 2 min after install)
( sleep 120 && launchctl kickstart "gui/$(id -u)/${UPDATE_LABEL}" >/dev/null 2>&1 ) &

# ---------- Verify ----------
sleep 3
if ! curl -fsSL --max-time 5 "http://localhost:$PORT/" >/dev/null; then
  warn "Service is starting but http://localhost:$PORT/ not responding yet — give it a few seconds."
fi

# Collect LAN IPs
LAN_IPS=$(ifconfig 2>/dev/null | awk '/inet / && $2 !~ /^127\./ {print $2}' || true)

green ""
green "============================================================"
green "  Open SEO Crawler is LIVE"
green "============================================================"
green ""
green "  On this computer:"
green "      http://localhost:$PORT/"
if [ -n "$LAN_IPS" ]; then
  green ""
  green "  From another device on the same network:"
  while IFS= read -r ip; do
    [ -n "$ip" ] && green "      http://$ip:$PORT/"
  done <<< "$LAN_IPS"
fi
green ""
green "============================================================"
green " Logs:       tail -f $LOG_DIR/app.log"
green " Restart:    launchctl kickstart -k gui/\$(id -u)/${LABEL}"
green " Stop:       launchctl bootout gui/\$(id -u)/${LABEL}"
green " Disable:    rm $APP_PLIST"
green ""
green " Auto-update: 2 min after login + daily 03:30 (${UPDATE_LABEL})"
green " Update now:  ./install-macos.sh --update-now"
green " Update log:  tail -f $LOG_DIR/update.log"
green " Disable AU:  launchctl bootout gui/\$(id -u)/${UPDATE_LABEL}"
green "============================================================"

# Save URLs
{
  echo "Open SEO Crawler — access URLs"
  echo "Installed: $(date)"
  echo ""
  echo "On this computer:"
  echo "  http://localhost:$PORT/"
  if [ -n "$LAN_IPS" ]; then
    echo ""
    echo "From another device on the same network:"
    while IFS= read -r ip; do
      [ -n "$ip" ] && echo "  http://$ip:$PORT/"
    done <<< "$LAN_IPS"
  fi
} > "$INSTALL_DIR/ACCESS_URLS.txt"
green " URLs also saved to: $INSTALL_DIR/ACCESS_URLS.txt"

# Auto-open default browser
open "http://localhost:$PORT/" >/dev/null 2>&1 &
