#!/usr/bin/env bash
# Open SEO Crawler — Linux Mint installer
#   - preflight checks
#   - systemd autostart on boot
#   - daily auto-update via systemd timer (git pull + restart if changed)
#
# Usage:
#   ./install-open-seo-crawler.sh              # install + enable autostart + enable daily auto-update
#   ./install-open-seo-crawler.sh --check      # preflight only, no changes
#   ./install-open-seo-crawler.sh --update-now # run the updater immediately (after install)
set -euo pipefail

REPO_URL="https://github.com/puneetindersingh/open-seo-crawler.git"
INSTALL_DIR="$HOME/open-seo-crawler"
SERVICE_NAME="open-seo-crawler"
UPDATE_NAME="open-seo-crawler-update"
PORT=5002
MIN_PY_MAJOR=3
MIN_PY_MINOR=10
MIN_DISK_MB=500
RUN_USER="$(id -un)"
RUN_GROUP="$(id -gn)"

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

# ---------- --update-now: just trigger the updater service ----------
if [ "$MODE" = "update-now" ]; then
  sudo systemctl start ${UPDATE_NAME}.service
  echo "Updater triggered. Tail logs with:"
  echo "  journalctl -u ${UPDATE_NAME}.service -n 50 --no-pager"
  exit 0
fi

# ---------- Preflight ----------
echo "=============================================="
echo " Open SEO Crawler — preflight checks"
[ "$MODE" = "check" ] && echo " (--check mode: no changes will be made)"
echo "=============================================="

[ "$EUID" -eq 0 ] && fail "Run as your normal user, not root. The script will sudo when needed."
ok "Running as non-root user: $RUN_USER"

command -v apt-get >/dev/null 2>&1 || fail "apt-get not found. This script targets Linux Mint / Ubuntu / Debian."
if [ -r /etc/os-release ]; then
  . /etc/os-release
  ok "Detected OS: ${PRETTY_NAME:-unknown}"
  case "${ID:-}${ID_LIKE:-}" in
    *linuxmint*|*ubuntu*|*debian*) : ;;
    *) warn "Not Mint/Ubuntu/Debian — script may still work but is untested." ;;
  esac
fi

command -v sudo >/dev/null 2>&1 || fail "sudo not installed. Install it first: su -c 'apt install sudo'"
sudo -n true 2>/dev/null || yellow "sudo will prompt for your password during install."
ok "sudo available"

[ -d /run/systemd/system ] || fail "systemd not running — autostart cannot be configured."
ok "systemd active"

curl -fsSL --max-time 5 https://github.com >/dev/null 2>&1 || fail "Cannot reach github.com — check internet connection."
ok "Internet reachable (github.com)"

if ! command -v python3 >/dev/null 2>&1; then
  yellow "python3 not found — will install via apt."
else
  PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  PY_MAJ=${PY_VER%.*}; PY_MIN=${PY_VER#*.}
  if [ "$PY_MAJ" -lt "$MIN_PY_MAJOR" ] || { [ "$PY_MAJ" -eq "$MIN_PY_MAJOR" ] && [ "$PY_MIN" -lt "$MIN_PY_MINOR" ]; }; then
    fail "Python $PY_VER detected, need ${MIN_PY_MAJOR}.${MIN_PY_MINOR}+. Upgrade Mint or install python3.10+."
  fi
  ok "Python $PY_VER (>= ${MIN_PY_MAJOR}.${MIN_PY_MINOR})"
fi

FREE_MB=$(df -Pm "$HOME" | awk 'NR==2 {print $4}')
[ "$FREE_MB" -lt "$MIN_DISK_MB" ] && fail "Only ${FREE_MB}MB free in $HOME — need at least ${MIN_DISK_MB}MB."
ok "Disk space: ${FREE_MB}MB free in \$HOME"

if command -v ss >/dev/null 2>&1; then
  if ss -ltn "( sport = :$PORT )" | grep -q ":$PORT"; then
    fail "Port $PORT already in use. Stop whatever is listening, or edit app.py to change ports."
  fi
fi
ok "Port $PORT is free"

if [ -d "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR/.git" ]; then
  fail "$INSTALL_DIR exists but is not a git checkout. Remove or rename it first."
fi
if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}.service"; then
  warn "Service ${SERVICE_NAME} already installed — will be overwritten + restarted."
fi

green "All preflight checks passed."
echo

if [ "$MODE" = "check" ]; then
  green "--check complete. Re-run without --check to install."
  exit 0
fi

# ---------- Install ----------
echo ">>> Installing system packages..."
sudo apt-get update -y
sudo apt-get install -y python3 python3-venv python3-pip git curl

PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJ=${PY_VER%.*}; PY_MIN=${PY_VER#*.}
if [ "$PY_MAJ" -lt "$MIN_PY_MAJOR" ] || { [ "$PY_MAJ" -eq "$MIN_PY_MAJOR" ] && [ "$PY_MIN" -lt "$MIN_PY_MINOR" ]; }; then
  fail "Python $PY_VER still too old after apt install. Aborting."
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo ">>> Updating existing repo at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo ">>> Cloning into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

echo ">>> Setting up Python venv..."
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --upgrade pip
"$INSTALL_DIR/venv/bin/pip" install -r "$INSTALL_DIR/requirements.txt"

echo ">>> Smoke test..."
"$INSTALL_DIR/venv/bin/python3" -c "import flask, requests, bs4, lxml, openpyxl; print('imports OK')"
"$INSTALL_DIR/venv/bin/python3" -m py_compile "$INSTALL_DIR/app.py"
ok "App imports + compiles"

# ---------- Updater script ----------
echo ">>> Installing updater script..."
cat > "$INSTALL_DIR/update.sh" <<'UPDATE_EOF'
#!/usr/bin/env bash
# Auto-updater for Open SEO Crawler.
# Pulls latest from origin, reinstalls deps if requirements.txt changed,
# smoke-tests, then restarts the service. Bails safely on any failure.
set -euo pipefail

INSTALL_DIR="__INSTALL_DIR__"
SERVICE_NAME="__SERVICE_NAME__"
cd "$INSTALL_DIR"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*"; }

log "fetch origin"
git fetch --quiet origin

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse '@{u}' 2>/dev/null || git rev-parse origin/HEAD)

if [ "$LOCAL" = "$REMOTE" ]; then
  log "already up to date ($LOCAL)"
  exit 0
fi

log "update available: $LOCAL -> $REMOTE"

REQ_BEFORE=$(sha1sum requirements.txt | awk '{print $1}')

if ! git pull --ff-only --quiet; then
  log "git pull failed (non fast-forward or local changes). Aborting update."
  exit 1
fi

REQ_AFTER=$(sha1sum requirements.txt | awk '{print $1}')
if [ "$REQ_BEFORE" != "$REQ_AFTER" ]; then
  log "requirements.txt changed — reinstalling deps"
  "$INSTALL_DIR/venv/bin/pip" install --quiet --upgrade pip
  "$INSTALL_DIR/venv/bin/pip" install --quiet -r requirements.txt
fi

log "smoke test"
if ! "$INSTALL_DIR/venv/bin/python3" -c "import flask, requests, bs4, lxml, openpyxl" 2>&1; then
  log "import smoke test failed — rolling back"
  git reset --hard "$LOCAL"
  exit 1
fi
if ! "$INSTALL_DIR/venv/bin/python3" -m py_compile app.py 2>&1; then
  log "py_compile failed — rolling back"
  git reset --hard "$LOCAL"
  exit 1
fi

log "restarting $SERVICE_NAME"
sudo /bin/systemctl restart "${SERVICE_NAME}.service"

sleep 3
if ! systemctl is-active --quiet "${SERVICE_NAME}.service"; then
  log "service failed to start after update — rolling back"
  git reset --hard "$LOCAL"
  "$INSTALL_DIR/venv/bin/pip" install --quiet -r requirements.txt || true
  sudo /bin/systemctl restart "${SERVICE_NAME}.service" || true
  exit 1
fi

log "update complete: now at $REMOTE"
UPDATE_EOF

sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g; s|__SERVICE_NAME__|$SERVICE_NAME|g" "$INSTALL_DIR/update.sh"
chmod +x "$INSTALL_DIR/update.sh"

# Sudoers rule: let the updater restart only this one service, no password.
echo ">>> Granting passwordless systemctl restart for updater..."
SUDO_FILE="/etc/sudoers.d/${SERVICE_NAME}-updater"
sudo tee "$SUDO_FILE" >/dev/null <<EOF
$RUN_USER ALL=(root) NOPASSWD: /bin/systemctl restart ${SERVICE_NAME}.service
EOF
sudo chmod 0440 "$SUDO_FILE"
sudo visudo -cf "$SUDO_FILE" >/dev/null || fail "sudoers file failed validation — removing."

# ---------- systemd: main service ----------
echo ">>> Writing systemd service unit..."
sudo tee /etc/systemd/system/${SERVICE_NAME}.service >/dev/null <<EOF
[Unit]
Description=Open SEO Crawler (self-hosted SEO site crawler)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/venv/bin/python3 $INSTALL_DIR/app.py
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/${SERVICE_NAME}.log
StandardError=append:/var/log/${SERVICE_NAME}.log

[Install]
WantedBy=multi-user.target
EOF

sudo touch /var/log/${SERVICE_NAME}.log
sudo chown "$RUN_USER:$RUN_GROUP" /var/log/${SERVICE_NAME}.log

# ---------- systemd: updater service + timer ----------
echo ">>> Writing updater service + daily timer..."
sudo tee /etc/systemd/system/${UPDATE_NAME}.service >/dev/null <<EOF
[Unit]
Description=Open SEO Crawler auto-updater (git pull + restart if changed)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/update.sh
EOF

sudo tee /etc/systemd/system/${UPDATE_NAME}.timer >/dev/null <<EOF
[Unit]
Description=Daily check for Open SEO Crawler updates

[Timer]
OnBootSec=2min
OnCalendar=daily
RandomizedDelaySec=30m
Persistent=true
Unit=${UPDATE_NAME}.service

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now ${SERVICE_NAME}.service
sudo systemctl enable --now ${UPDATE_NAME}.timer

# ---------- Verify ----------
sleep 3
if ! systemctl is-active --quiet ${SERVICE_NAME}.service; then
  red "Service failed to start. Last 20 log lines:"
  tail -n 20 /var/log/${SERVICE_NAME}.log || true
  exit 1
fi
if ! curl -fsSL --max-time 5 "http://localhost:$PORT/" >/dev/null; then
  warn "Service is running but http://localhost:$PORT/ not responding yet — give it a few seconds."
fi

# Collect LAN IPs (non-loopback, IPv4) for "open from another device" URLs
LAN_IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^127\.' || true)

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
green " Logs:       tail -f /var/log/${SERVICE_NAME}.log"
green " Restart:    sudo systemctl restart $SERVICE_NAME"
green " Disable:    sudo systemctl disable $SERVICE_NAME"
green ""
green " Auto-update: on every boot (+2min) and daily ($UPDATE_NAME.timer)"
green " Update now:  ./install-open-seo-crawler.sh --update-now"
green " Timer info:  systemctl list-timers | grep $UPDATE_NAME"
green " Update log:  journalctl -u $UPDATE_NAME.service -n 50"
green " Disable AU:  sudo systemctl disable --now $UPDATE_NAME.timer"
green "============================================================"

# Save URLs to a file in the install dir so the user can find them later
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

# Auto-open in browser if a graphical session is present
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
  echo ""
  echo ">>> Opening http://localhost:$PORT/ in your default browser..."
  xdg-open "http://localhost:$PORT/" >/dev/null 2>&1 &
fi
