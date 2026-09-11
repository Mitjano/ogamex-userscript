#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────
#  OGX WATCHDOG — strażnik karty z grą (macOS, LaunchAgent)
# ─────────────────────────────────────────────────────────────────────────
# Powód (owner 31.08: „karta może się zawiesić albo zamrozić — bot wtedy nie
# działa"): bot żyje wyłącznie w karcie przeglądarki. Martwa karta = cicha
# śmierć obrony, bez żadnego alarmu. Ten strażnik:
#   1. słucha pulsu bota na http://127.0.0.1:8765/hb (bot pinguje co ~60 s,
#      tylko karta-lider),
#   2. gdy puls ustanie na > THRESHOLD (12 min), wysyła push na ntfy
#      i restartuje PRZEGLĄDARKĘ, z której szedł puls (Firefox/Chrome — patrz
#      OGX_WD_BROWSER), z kartą gry; stan bota przeżywa w GM storage,
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
# 08.09: 15 min łaski po starcie to było 15 min ślepoty po każdym reboocie i po
# każdym wskrzeszeniu przez warstwę 2 — 6 min starcza na login + start przeglądarki,
# a po prostu OTWARCIE gry (to robi restart_browser przy braku pulsu) nie boli.
STARTUP_GRACE = int(os.environ.get("OGX_WD_GRACE", str(6 * 60)))     # s po starcie strażnika
MAX_RESTARTS_H = 3
DRYRUN = os.environ.get("OGX_WD_DRYRUN") == "1"
NTFY_TOPIC = os.environ.get("OGX_WD_NTFY", "ogx-4wrgtgf1zknuoa")
GAME_URL = os.environ.get("OGX_WD_URL", "https://genesis.ogamex.net/")
# Godziny ciszy „S-E" (np. "1-7"): w tym oknie strażnik NIE restartuje, tylko
# pushuje — restart o 4 w nocy w 2 min wzmacnia wzorzec „konto nigdy nie znika".
# Puste (domyślnie) = restart o każdej porze. Sam puls nigdy nie wychodzi poza
# 127.0.0.1, więc dla admina gry strażnik nie istnieje.
QUIET = os.environ.get("OGX_WD_QUIET", "")
# 08.09: flota zginęła, gdy karta stała martwa — jedyną odpowiedzią na śpiącego
# Maca jest Mac, który nie śpi (sekcja 6 AUDYT-ATAKI-2026-08-31.md). Wake lock
# bota działa tylko przy WIDOCZNEJ karcie; strażnik trzyma teraz caffeinate -i -s
# (bez snu bezczynności/systemu; ZAMKNIĘTA KLAPA nadal usypia — na to nie ma
# bezpiecznej rady bez roota). Wyłączenie: OGX_WD_CAFFEINATE=0.
CAFFEINATE = os.environ.get("OGX_WD_CAFFEINATE", "1") == "1"


def quiet_now():
    if not QUIET or "-" not in QUIET:
        return False
    try:
        s, e = (int(x) for x in QUIET.split("-", 1))
    except ValueError:
        return False
    h = time.localtime().tm_hour
    return (s <= h < e) if s < e else (h >= s or h < e)

state = {"last_hb": 0.0, "hb_count": 0, "restarts": [], "started": time.time(),
         "browser": None, "seen_browsers": {}, "warned_dup": 0.0}
lock = threading.Lock()

# 09.09 (owner przesiada się na Chrome): strażnik był ZASZYTY na Firefoksa — ubijał
# proces `firefox` i robił `open -a Firefox`. Przy grze w Chrome to nie tylko nie
# naprawiało zawieszonej karty, ale ODPALAŁO DRUGĄ INSTANCJĘ BOTA w Firefoksie, a dwie
# instancje kłócące się o konfigurację to dokładnie mechanizm, który 09.09 o 04:09
# przestawił bota na OFF (2,5 h ślepoty). Przeglądarkę poznajemy po nagłówku
# User-Agent PULSU — puls przychodzi z tej samej karty, w której żyje bot, więc to
# jedyne źródło, które nie może się pomylić. Bez zgadywania i bez uprawnień do
# automatyzacji (osascript „get tabs" prosiłby o TCC i w LaunchAgencie bywa martwy).
BROWSER = os.environ.get("OGX_WD_BROWSER", "auto")
# nazwa procesu do pkill bywa inna niż nazwa aplikacji do `open -a`
PROC_NAME = {"Firefox": "firefox", "Google Chrome": "Google Chrome",
             "Brave Browser": "Brave Browser", "Microsoft Edge": "Microsoft Edge"}


def browser_from_ua(ua):
    u = ua or ""
    if "Firefox/" in u:
        return "Firefox"
    if "Edg/" in u:
        return "Microsoft Edge"
    if "Brave/" in u:
        return "Brave Browser"
    if "Chrome/" in u:            # Chrome UA zawiera też „Safari" — kolejność ma znaczenie
        return "Google Chrome"
    return None


def is_running(app):
    try:
        return subprocess.run(["pgrep", "-x", PROC_NAME.get(app, app)],
                              capture_output=True).returncode == 0
    except Exception:
        return False


def target_browser():
    """Kogo restartować. Jawne ustawienie > przeglądarka pulsu > ta, która działa > Firefox."""
    if BROWSER and BROWSER != "auto":
        return BROWSER
    with lock:
        seen = state["browser"]
    if seen:
        return seen
    for app in ("Google Chrome", "Firefox", "Brave Browser", "Microsoft Edge"):
        if is_running(app):
            return app
    return "Firefox"


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)


def push(title, body, priority="urgent"):
    if DRYRUN:
        log(f"[DRYRUN] push: {title} — {body}")
        return
    try:
        # Nagłówki HTTP są latin-1: emoji w Title wywalało cały push (incydent 23:06
        # 31.08 — restart zadziałał, powiadomienie NIE wyszło). Nie-ASCII w tytule
        # kodujemy po stronie ntfy (nagłówek z prefiksem =?UTF-8?B?...?=), a emoji
        # i tak dokleja Tags.
        import base64
        safe = title if title.isascii() else "=?UTF-8?B?" + base64.b64encode(title.encode("utf-8")).decode("ascii") + "?="
        req = urllib.request.Request(
            f"https://ntfy.sh/{NTFY_TOPIC}", data=body.encode("utf-8"),
            headers={"Title": safe, "Priority": priority, "Tags": "rotating_light"})
        urllib.request.urlopen(req, timeout=10)
        log(f"push wysłany: {title}")
    except Exception as e:  # push nie może zabić strażnika
        log(f"push NIE wyszedł: {e}")


def restart_browser():
    app = target_browser()
    proc = PROC_NAME.get(app, app)
    if DRYRUN:
        log(f"[DRYRUN] restart {app} (osascript quit → pkill {proc} → open z kartą gry)")
        return
    try:
        subprocess.run(["osascript", "-e", f'tell application "{app}" to quit'], timeout=20)
    except Exception:
        pass
    time.sleep(15)
    subprocess.run(["pkill", "-9", "-x", proc], check=False)
    time.sleep(5)
    subprocess.run(["open", "-a", app, GAME_URL], check=False)
    log(f"{app} zrestartowany z kartą {GAME_URL}")


class HB(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/hb"):
            app = browser_from_ua(self.headers.get("User-Agent"))
            now = time.time()
            dup = None
            with lock:
                state["last_hb"] = now
                state["hb_count"] += 1
                if app:
                    state["browser"] = app
                    state["seen_browsers"][app] = now
                    # DWIE przeglądarki z żywym pulsem = dwie instancje bota, czyli dwa
                    # panele kłócące się o konfigurację (tak 09.09 o 04:09 bot wpadł w OFF).
                    swiezE = [b for b, t in state["seen_browsers"].items() if now - t < 300]
                    if len(swiezE) > 1 and now - state["warned_dup"] > 3600:
                        state["warned_dup"] = now
                        dup = swiezE
            if dup:
                log(f"UWAGA: puls z DWÓCH przeglądarek ({', '.join(dup)}) — dwie instancje bota")
                push("⚠️ Dwie instancje bota", "Puls przychodzi z: " + ", ".join(dup)
                     + ". Dwa panele nadpisują sobie konfigurację (tak bot wpadł w OFF 09.09 04:09) — zamknij grę w jednej przeglądarce.", "high")
            self.send_response(204); self.end_headers()
        elif self.path.startswith("/status"):
            with lock:
                age = (time.time() - state["last_hb"]) if state["last_hb"] else None
                # UWAGA: bez target_browser() — ta funkcja bierze ten sam zamek (zakleszczenie).
                body = json.dumps({"browser_seen": state["browser"],
                                   "browser_cfg": BROWSER,
                                   "hb_count": state["hb_count"],
                                   "last_hb_age_s": round(age) if age is not None else None,
                                   "restarts_last_h": len([t for t in state["restarts"] if time.time() - t < 3600]),
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
            state["last_hb"] = now + 300  # 5 min łaski na wstanie przeglądarki
        app = target_browser()
        log(f"BRAK PULSU od {round(silent)} s — restartuję {app}")
        push("🩺 Karta z grą ZAMARŁA", f"Brak pulsu bota od {round(silent / 60)} min — restartuję {app} z kartą gry. Sprawdź, czy wstał.")
        restart_browser()


def caffeinate_keeper():
    # dziecko caffeinate umiera np. przy wylogowaniu — wznawiamy w pętli
    while True:
        try:
            p = subprocess.Popen(["/usr/bin/caffeinate", "-i", "-s"])
            log(f"caffeinate trzyma Maca na jawie (pid {p.pid}; klapa nadal usypia)")
            p.wait()
            log("caffeinate padł — wznawiam za 10 s")
        except Exception as e:
            log(f"caffeinate niedostępny: {e}")
            return
        time.sleep(10)


def main():
    log(f"OGX watchdog start: port {PORT}, próg {THRESHOLD} s, dryrun={DRYRUN}, caffeinate={CAFFEINATE}")
    if CAFFEINATE and not DRYRUN:
        threading.Thread(target=caffeinate_keeper, daemon=True).start()
    threading.Thread(target=monitor, daemon=True).start()
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), HB).serve_forever()


if __name__ == "__main__":
    main()
