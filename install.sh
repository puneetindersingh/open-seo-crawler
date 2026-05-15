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

# Helper: check whether a given python binary is >= MIN_PY_MAJOR.MIN_PY_MINOR
python_ok() {
  local bin="$1"
  command -v "$bin" >/dev/null 2>&1 || return 1
  "$bin" -c "import sys; sys.exit(0 if sys.version_info >= (${MIN_PY_MAJOR}, ${MIN_PY_MINOR}) else 1)" 2>/dev/null
}

# Pick a Python binary to use. Try python3 first, then any python3.10+ already installed.
PYTHON_BIN=""
for candidate in python3 python3.13 python3.12 python3.11 python3.10; do
  if python_ok "$candidate"; then PYTHON_BIN="$candidate"; break; fi
done

if [ -n "$PYTHON_BIN" ]; then
  PY_VER=$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  ok "Python $PY_VER ($PYTHON_BIN) — meets ${MIN_PY_MAJOR}.${MIN_PY_MINOR}+ requirement"
else
  CUR_PY="(none)"
  if command -v python3 >/dev/null 2>&1; then
    CUR_PY=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  fi
  warn "Python ${MIN_PY_MAJOR}.${MIN_PY_MINOR}+ not found (system has $CUR_PY)."
  warn "Will install python${MIN_PY_MAJOR}.${MIN_PY_MINOR} via the deadsnakes PPA during install step."
  if [ "$MODE" = "check" ]; then
    # In --check mode we don't install, just confirm the path forward is viable
    if [ -r /etc/os-release ]; then
      . /etc/os-release
      case "${ID:-}${ID_LIKE:-}" in
        *linuxmint*|*ubuntu*) ok "OS is Ubuntu-based — deadsnakes PPA will work" ;;
        *) fail "Old Python and not on Ubuntu/Mint — deadsnakes PPA not available. Install python${MIN_PY_MAJOR}.${MIN_PY_MINOR} manually first." ;;
      esac
    fi
  fi
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
sudo apt-get install -y python3 python3-venv python3-pip git curl software-properties-common

# If we don't yet have a Python 3.10+, add deadsnakes PPA and try installing
# the newest version available for the host's release (3.13 -> 3.12 -> 3.11 -> 3.10).
# deadsnakes drops older Python builds on older Ubuntu releases over time, so we
# fall back through versions until apt actually finds one.
if [ -z "$PYTHON_BIN" ]; then
  echo ">>> System Python is too old — installing a newer Python via deadsnakes PPA..."
  if [ -r /etc/os-release ]; then
    . /etc/os-release
    case "${ID:-}${ID_LIKE:-}" in
      *linuxmint*|*ubuntu*) : ;;
      *) fail "deadsnakes PPA only supports Ubuntu/Mint. Install python${MIN_PY_MAJOR}.${MIN_PY_MINOR}+ manually first." ;;
    esac
  fi

  sudo add-apt-repository -y ppa:deadsnakes/ppa
  sudo apt-get update -y

  for ver in 3.13 3.12 3.11 3.10; do
    echo ">>> Trying python${ver}..."
    # distutils was removed from the stdlib in 3.12+; the deadsnakes package
    # only exists for 3.10 / 3.11.
    pkgs="python${ver} python${ver}-venv"
    case "$ver" in
      3.10|3.11) pkgs="$pkgs python${ver}-distutils" ;;
    esac
    # Confirm the main package actually exists in the index before invoking apt-get
    # (avoids apt's "regex match" fallback that picks up libpython*, libqgis*, etc).
    if ! apt-cache show "python${ver}" >/dev/null 2>&1; then
      yellow "python${ver} not in apt index — trying older version"
      continue
    fi
    if sudo apt-get install -y $pkgs; then
      if command -v "python${ver}" >/dev/null 2>&1 && python_ok "python${ver}"; then
        PYTHON_BIN="python${ver}"
        ok "Installed $PYTHON_BIN"
        break
      fi
    fi
    yellow "python${ver} install failed — falling back"
  done

  # Last-resort fallback: compile Python 3.10 from source.
  # This runs when deadsnakes ships none of 3.10–3.13 cleanly for the host's
  # Ubuntu/Mint release. Takes ~5–15 minutes depending on hardware.
  if [ -z "$PYTHON_BIN" ]; then
    PY_SRC_VER="3.10.14"
    yellow "All deadsnakes options failed — falling back to compiling Python ${PY_SRC_VER} from source."
    yellow "This takes 5–15 minutes. Grab a coffee."

    echo ">>> Installing build deps..."
    sudo apt-get install -y \
      build-essential wget \
      libssl-dev libffi-dev zlib1g-dev libbz2-dev libsqlite3-dev \
      libreadline-dev libncurses-dev libgdbm-dev liblzma-dev \
      tk-dev uuid-dev

    BUILD_DIR=$(mktemp -d)
    pushd "$BUILD_DIR" >/dev/null

    echo ">>> Downloading Python ${PY_SRC_VER} source..."
    wget -q "https://www.python.org/ftp/python/${PY_SRC_VER}/Python-${PY_SRC_VER}.tgz" \
      || fail "Could not download Python ${PY_SRC_VER} source."
    tar -xf "Python-${PY_SRC_VER}.tgz"
    cd "Python-${PY_SRC_VER}"

    echo ">>> Configuring (with optimizations)..."
    ./configure --enable-optimizations --prefix=/usr/local >/dev/null

    echo ">>> Building (this is the slow part)..."
    make -j "$(nproc)" >/dev/null

    echo ">>> Installing to /usr/local/bin/python3.10..."
    sudo make altinstall >/dev/null

    popd >/dev/null
    rm -rf "$BUILD_DIR"

    if command -v python3.10 >/dev/null 2>&1 && python_ok python3.10; then
      PYTHON_BIN="python3.10"
      ok "Built and installed $(python3.10 --version) from source"
    else
      fail "Source build appeared to succeed but python3.10 is not callable. Aborting."
    fi
  fi
fi

# Re-verify
if ! python_ok "$PYTHON_BIN"; then
  fail "Python ${MIN_PY_MAJOR}.${MIN_PY_MINOR}+ still not available after install. Aborting."
fi
PY_VER=$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
ok "Using $PYTHON_BIN (Python $PY_VER) for the venv"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo ">>> Updating existing repo at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo ">>> Cloning into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

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
