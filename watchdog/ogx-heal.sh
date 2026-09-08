#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
#  OGX HEAL — warstwa 2 samonaprawy: pilnuje STRAŻNIKA (ogx-watchdog)
# ─────────────────────────────────────────────────────────────────────────
# Powód (utrata całej floty 08.09.2026 ~05:10): strażnik był wyłączony trwałą
# flagą „disabled" w launchd (przeżywa reboot — po restartach Maca 07.09 agent
# nie wstał) i karta z grą stała martwa 2 h bez żadnego ożywienia. Strażnik
# pilnował karty, ale strażnika nie pilnował nikt.
#
# Ten skrypt odpala CRON co 5 min (mechanizm niezależny od flag LaunchAgentów):
#   1. strażnik odpowiada na /status → wyjście po cichu (zero logu, zero pushy),
#   2. nie odpowiada → zdejmij flagę disabled, odtwórz plist gdyby zniknął,
#      bootstrap/kickstart przez launchd,
#   3. launchd zawiódł (np. cron bez dostępu do domeny gui) → odpal strażnika
#      WPROST przez nohup (port 8765 zajęty = podwójny start sam się zabije),
#   4. ożywiony → push info na ntfy; nie umiem ożywić → push urgent co ≥1 h.
# Żyje w ~/Library/Application Support/ogx-watchdog/ (cron nie widzi ~/Documents
# przez TCC), więc jest SAMOWYSTARCZALNY: plist odtwarza z własnego heredoca.
# Instalacja/aktualizacja: bash watchdog/install.sh (kopiuje + wpis w crontab).
set -u
LABEL="com.mch.ogx-watchdog"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
APPDIR="$HOME/Library/Application Support/ogx-watchdog"
LOG="$HOME/Library/Logs/ogx-heal.log"
NTFY_TOPIC="${OGX_WD_NTFY:-ogamex3-d0zjvhl9eiho}"
STAMP="$APPDIR/.heal-push-stamp"
U="$(id -u)"

say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
alive() { curl -sf -m 4 http://127.0.0.1:8765/status >/dev/null 2>&1; }
# Nagłówki HTTP są latin-1 (lekcja 31.08: emoji w Title wywalało push) — tytuły ASCII.
push() { curl -s -m 10 -H "Title: $1" -H "Priority: $2" -H "Tags: $3" -d "$4" "https://ntfy.sh/${NTFY_TOPIC}" >/dev/null 2>&1; }

alive && exit 0
say "strażnik nie odpowiada — leczę"

if [ ! -f "$PLIST" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
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
  say "plist zniknął — odtworzyłem z heredoca"
fi

launchctl enable "gui/${U}/${LABEL}" >> "$LOG" 2>&1
launchctl bootstrap "gui/${U}" "$PLIST" >> "$LOG" 2>&1 || launchctl kickstart -k "gui/${U}/${LABEL}" >> "$LOG" 2>&1
sleep 5
if alive; then
  say "ożywiony przez launchd (enable + bootstrap/kickstart)"
  push "OGX: straznik ozywiony (warstwa 2)" "default" "adhesive_bandage" "Straznik karty lezal — cron go wskrzesil przez launchd. Sprawdz ~/Library/Logs/ogx-heal.log"
  exit 0
fi

if [ -f "$APPDIR/ogx-watchdog.py" ]; then
  say "launchd zawiódł — odpalam strażnika wprost (nohup)"
  nohup /usr/bin/python3 "$APPDIR/ogx-watchdog.py" >> "$HOME/Library/Logs/ogx-watchdog.log" 2>&1 &
  disown
  sleep 5
  if alive; then
    say "ożywiony bezpośrednio (nohup, poza launchd)"
    push "OGX: straznik ozywiony (warstwa 2)" "default" "adhesive_bandage" "launchd nie dal rady, straznik chodzi z nohup. Przy okazji odpal: bash watchdog/install.sh"
    exit 0
  fi
else
  say "brak $APPDIR/ogx-watchdog.py — nie mam czego odpalić (TCC: cron nie widzi ~/Documents)"
fi

say "NIE UMIEM ożywić strażnika"
now=$(date +%s); last=$(cat "$STAMP" 2>/dev/null || echo 0)
if [ $((now - last)) -ge 3600 ]; then
  echo "$now" > "$STAMP"
  push "OGX: straznika NIE DA SIE ozywic" "urgent" "rotating_light" "Cron nie umie wskrzesic straznika karty — obrona bez auto-restartu. Wejdz na Maca: bash watchdog/install.sh, log: ~/Library/Logs/ogx-heal.log"
fi
exit 1
