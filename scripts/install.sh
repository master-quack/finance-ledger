#!/usr/bin/env bash
# Installs finance-ledger for the current user (no root needed).
#   ./scripts/install.sh            install deps, create dirs, put `ledger` on PATH
#   ./scripts/install.sh --service  also install + start a systemd *user* service
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js 20+ is required. Install it from https://nodejs.org or your package manager."; exit 1; }
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 20 ] || { echo "Node $MAJOR found, need 20 or newer."; exit 1; }
command -v npm >/dev/null || { echo "npm is required."; exit 1; }

echo "==> Installing dependencies"
npm install --omit=dev --no-audit --no-fund

echo "==> Linking 'ledger' into ~/.local/bin"
mkdir -p "$HOME/.local/bin"
ln -sf "$DIR/bin/ledger.js" "$HOME/.local/bin/ledger"
chmod +x "$DIR/bin/ledger.js"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "    Add ~/.local/bin to your PATH to use the 'ledger' command." ;; esac

echo "==> Creating config and data directories"
"$NODE" "$DIR/bin/ledger.js" init

if [ "${1:-}" = "--service" ]; then
  command -v systemctl >/dev/null || { echo "systemctl not found; skipping service."; exit 0; }
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  sed -e "s|@INSTALL_DIR@|$DIR|g" -e "s|@NODE@|$NODE|g" systemd/finance-ledger.service > "$UNIT_DIR/finance-ledger.service"
  systemctl --user daemon-reload
  systemctl --user enable finance-ledger.service
  echo "==> Service installed. Finish Gmail setup (ledger auth), then:"
  echo "      systemctl --user start finance-ledger"
  echo "      loginctl enable-linger \"$USER\"    # keep it running when logged out (needs sudo on some systems)"
  echo "      journalctl --user -u finance-ledger -f"
fi

echo
echo "Done. Run 'ledger doctor' to see what's left to set up."
