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
# Warstwa 2 (utrata floty 08.09): cron co 5 min wskrzesza martwego strażnika —
# mechanizm niezależny od flag LaunchAgentów, przez które strażnik leżał od 04.09.
# Kopia w ~/Library, bo TCC nie wpuszcza crona do ~/Documents.
cp "$DIR/ogx-heal.sh" "$APPDIR/ogx-heal.sh"
chmod +x "$APPDIR/ogx-heal.sh"
CRON_LINE="*/5 * * * * /bin/bash \"$APPDIR/ogx-heal.sh\" # ogx-heal"
# `|| true`, bo grep -v na pustym crontabie zwraca 1, a set -e + pipefail
# ubiłyby instalator w połowie (dokładnie to zaszło przy pierwszym uruchomieniu 08.09)
{ crontab -l 2>/dev/null | grep -v '# ogx-heal$' || true; echo "$CRON_LINE"; } | crontab -
echo "cron: warstwa 2 co 5 min ($(crontab -l | grep -c '# ogx-heal$') wpis)"
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
# 08.09: launchd trzyma trwałą flagę „disabled" (zostaje po `launchctl unload -w`/
# `disable` i PRZEŻYWA reboot) — 07.09 strażnik przez nią nie wstał po restarcie
# Maca i flota zginęła bez warty. Instalacja zawsze zdejmuje tę flagę.
launchctl enable "gui/$(id -u)/com.mch.ogx-watchdog" 2>/dev/null || true
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
