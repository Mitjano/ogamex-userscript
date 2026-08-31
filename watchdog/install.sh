#!/bin/bash
# Instalacja strażnika OGX na macOS (LaunchAgent — startuje z systemem, sam wstaje po padzie).
#   bash watchdog/install.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.mch.ogx-watchdog.plist"
# macOS TCC nie pozwala launchd czytać ~/Documents — skrypt jedzie do ~/Library.
APPDIR="$HOME/Library/Application Support/ogx-watchdog"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$APPDIR"
cp "$DIR/ogx-watchdog.py" "$APPDIR/ogx-watchdog.py"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mch.ogx-watchdog</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string>
    <string>${APPDIR}/ogx-watchdog.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${HOME}/Library/Logs/ogx-watchdog.log</string>
  <key>StandardErrorPath</key><string>${HOME}/Library/Logs/ogx-watchdog.log</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
for i in 1 2 3 4 5 6; do
  sleep 2
  if curl -sf http://127.0.0.1:8765/status >/dev/null; then
    echo "OK: strażnik działa — status: $(curl -s http://127.0.0.1:8765/status)"
    exit 0
  fi
done
echo "BŁĄD: strażnik nie odpowiada — zajrzyj do ~/Library/Logs/ogx-watchdog.log" >&2
exit 1
