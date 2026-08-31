#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────
#  OGX WATCHDOG — strażnik karty z grą (macOS, LaunchAgent)
# ─────────────────────────────────────────────────────────────────────────
# Powód (owner 31.08: „karta może się zawiesić albo zamrozić — bot wtedy nie
# działa"): bot żyje wyłącznie w karcie Firefoksa. Martwa karta = cicha
# śmierć obrony, bez żadnego alarmu. Ten strażnik:
#   1. słucha pulsu bota na http://127.0.0.1:8765/hb (bot pinguje co ~60 s,
#      tylko karta-lider),
#   2. gdy puls ustanie na > THRESHOLD (12 min), wysyła push na ntfy
#      i restartuje Firefoksa z kartą gry (stan bota przeżywa w GM storage),
#   3. po uśpieniu Maca NIE restartuje w panice — wykrywa lukę w zegarze
#      i daje botowi czas na powrót po wybudzeniu.
# Limity: maks. 3 restarty na godzinę — potem już tylko push „nie umiem ożywić".
# Gdy cały Mac śpi/padnie, strażnik pada razem z nim — na to jedyną odpowiedzią
# jest komputer, który nie śpi (sekcja 6 AUDYT-ATAKI-2026-08-31.md).
#
#   Instalacja:  bash watchdog/install.sh
#   Test:        OGX_WD_DRYRUN=1 OGX_WD_THRESHOLD=5 python3 watchdog/ogx-watchdog.py
#   Status:      curl -s http://127.0.0.1:8765/status
#   Log:         ~/Library/Logs/ogx-watchdog.log

import http.server
import json
import os
import subprocess
import threading
import time
import urllib.request

PORT = int(os.environ.get("OGX_WD_PORT", "8765"))
THRESHOLD = int(os.environ.get("OGX_WD_THRESHOLD", str(12 * 60)))   # s bez pulsu = zawiecha
CHECK_EVERY = 30                                                     # s między kontrolami
SLEEP_GAP = 120                                                      # s luki zegara = Mac spał
STARTUP_GRACE = int(os.environ.get("OGX_WD_GRACE", str(15 * 60)))    # s po starcie strażnika
MAX_RESTARTS_H = 3
DRYRUN = os.environ.get("OGX_WD_DRYRUN") == "1"
NTFY_TOPIC = os.environ.get("OGX_WD_NTFY", "ogamex3-d0zjvhl9eiho")
GAME_URL = os.environ.get("OGX_WD_URL", "https://genesis.ogamex.net/")
# Godziny ciszy „S-E" (np. "1-7"): w tym oknie strażnik NIE restartuje, tylko
# pushuje — restart o 4 w nocy w 2 min wzmacnia wzorzec „konto nigdy nie znika".
# Puste (domyślnie) = restart o każdej porze. Sam puls nigdy nie wychodzi poza
# 127.0.0.1, więc dla admina gry strażnik nie istnieje.
QUIET = os.environ.get("OGX_WD_QUIET", "")


def quiet_now():
    if not QUIET or "-" not in QUIET:
        return False
    try:
        s, e = (int(x) for x in QUIET.split("-", 1))
    except ValueError:
        return False
    h = time.localtime().tm_hour
    return (s <= h < e) if s < e else (h >= s or h < e)

state = {"last_hb": 0.0, "hb_count": 0, "restarts": [], "started": time.time()}
lock = threading.Lock()


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)


def push(title, body, priority="urgent"):
    if DRYRUN:
        log(f"[DRYRUN] push: {title} — {body}")
        return
    try:
        req = urllib.request.Request(
            f"https://ntfy.sh/{NTFY_TOPIC}", data=body.encode("utf-8"),
            headers={"Title": title, "Priority": priority, "Tags": "rotating_light"})
        urllib.request.urlopen(req, timeout=10)
        log(f"push wysłany: {title}")
    except Exception as e:  # push nie może zabić strażnika
        log(f"push NIE wyszedł: {e}")


def restart_firefox():
    if DRYRUN:
        log("[DRYRUN] restart Firefoksa (osascript quit → pkill → open z kartą gry)")
        return
    try:
        subprocess.run(["osascript", "-e", 'tell application "Firefox" to quit'], timeout=20)
    except Exception:
        pass
    time.sleep(15)
    subprocess.run(["pkill", "-9", "-x", "firefox"], check=False)
    time.sleep(5)
    subprocess.run(["open", "-a", "Firefox", GAME_URL], check=False)
    log(f"Firefox zrestartowany z kartą {GAME_URL}")


class HB(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/hb"):
            with lock:
                state["last_hb"] = time.time()
                state["hb_count"] += 1
            self.send_response(204); self.end_headers()
        elif self.path.startswith("/status"):
            with lock:
                age = (time.time() - state["last_hb"]) if state["last_hb"] else None
                body = json.dumps({"hb_count": state["hb_count"],
                                   "last_hb_age_s": round(age) if age is not None else None,
                                   "restarts_last_h": len(state["restarts"]),
                                   "uptime_s": round(time.time() - state["started"])})
            self.send_response(200)
            self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(body.encode())
        else:
            self.send_response(404); self.end_headers()

    def log_message(self, *a):  # nie zaśmiecamy logu wpisami HTTP
        pass


def monitor():
    last_tick = time.monotonic()
    while True:
        time.sleep(CHECK_EVERY)
        gap = time.monotonic() - last_tick
        last_tick = time.monotonic()
        now = time.time()
        with lock:
            # Mac spał: luka w pętli — bot też spał, to nie zawiecha. Reset zegara.
            if gap > CHECK_EVERY + SLEEP_GAP:
                log(f"wykryto sen Maca (luka {round(gap)} s) — daję botowi czas na powrót")
                state["last_hb"] = now
                continue
            ref = state["last_hb"] or state["started"]
            silent = now - ref
            grace = STARTUP_GRACE if not state["last_hb"] else THRESHOLD
            if silent < grace:
                continue
            if quiet_now():
                push("🩺 Bot OGameX MILCZY (godziny ciszy)", f"Brak pulsu od {round(silent / 60)} min — w oknie ciszy NIE restartuję; wejdź do gry, gdy wstaniesz.")
                state["last_hb"] = now + 1800  # w ciszy przypominaj co ~30 min
                continue
            state["restarts"] = [t for t in state["restarts"] if now - t < 3600]
            if len(state["restarts"]) >= MAX_RESTARTS_H:
                push("🩺 Bot OGameX MILCZY", f"Brak pulsu od {round(silent / 60)} min, a limit restartów wyczerpany — wejdź do gry RĘCZNIE.")
                state["last_hb"] = now  # nie spamuj co 30 s
                continue
            state["restarts"].append(now)
            state["last_hb"] = now + 300  # 5 min łaski na wstanie Firefoksa
        log(f"BRAK PULSU od {round(silent)} s — restartuję Firefoksa")
        push("🩺 Karta z grą ZAMARŁA", f"Brak pulsu bota od {round(silent / 60)} min — restartuję Firefoksa z kartą gry. Sprawdź, czy wstał.")
        restart_firefox()


def main():
    log(f"OGX watchdog start: port {PORT}, próg {THRESHOLD} s, dryrun={DRYRUN}")
    threading.Thread(target=monitor, daemon=True).start()
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), HB).serve_forever()


if __name__ == "__main__":
    main()
