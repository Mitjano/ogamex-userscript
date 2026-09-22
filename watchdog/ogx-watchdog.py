#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────
#  OGX WATCHDOG — strażnik karty z grą (macOS, LaunchAgent)
# ─────────────────────────────────────────────────────────────────────────
# Powód (owner 31.08: „karta może się zawiesić albo zamrozić — bot wtedy nie
# działa"): bot żyje wyłącznie w karcie przeglądarki. Martwa karta = cicha
# śmierć obrony, bez żadnego alarmu. Ten strażnik:
#   1. słucha pulsu bota na http://127.0.0.1:8765/hb (bot pinguje co ~60 s,
#      tylko karta-lider; od v3.106.0 puls niesie nazwę uni: /hb?u=genesis),
#   2. gdy puls ustanie na > THRESHOLD (12 min) — GLOBALNIE albo dla JEDNEGO
#      uni, gdy drugie wciąż pinguje (gra na dwóch uni naraz: martwa karta
#      Atheny była niewidzialna, dopóki Genesis żył — AUDYT-ATHENA-2026-09-22
#      sekcja 3) — wysyła push na ntfy i restartuje PRZEGLĄDARKĘ, z której
#      szedł puls (Firefox/Chrome — patrz OGX_WD_BROWSER), otwierając karty
#      WSZYSTKICH pilnowanych uni; stan bota przeżywa w GM storage,
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
import re
import subprocess
import threading
import time
import urllib.request
from urllib.parse import parse_qs, urlparse

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
# Jawna lista kart do otwarcia po restarcie (przecinki). Pusta = wyprowadzana
# z uni widzianych w pulsie (https://<uni>.ogamex.net/), a bez żadnego uni
# w pulsie (stary bot) zostaje GAME_URL.
GAME_URLS_ENV = os.environ.get("OGX_WD_URLS", "")
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
         "browser": None, "seen_browsers": {}, "warned_dup": 0.0,
         # per-uni: ostatni puls i licznik nieudanych ożywień (uni, które nie
         # wstaje po 3 restartach, najpewniej ZAMKNĄŁ owner — przestajemy je
         # pilnować, wraca pod ochronę przy pierwszym pulsie)
         "unis": {}, "uni_strikes": {}}
lock = threading.Lock()


def game_urls():
    """Karty do otwarcia po restarcie. Jawny env > uni z pulsu > GAME_URL."""
    if GAME_URLS_ENV.strip():
        return [u.strip() for u in GAME_URLS_ENV.split(",") if u.strip()]
    with lock:
        unis = sorted(state["unis"].keys())
    return [f"https://{u}.ogamex.net/" for u in unis] or [GAME_URL]

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
    urls = game_urls()
    if DRYRUN:
        log(f"[DRYRUN] restart {app} (osascript quit → pkill {proc} → open z kartami: {' '.join(urls)})")
        return
    try:
        subprocess.run(["osascript", "-e", f'tell application "{app}" to quit'], timeout=20)
    except Exception:
        pass
    time.sleep(15)
    subprocess.run(["pkill", "-9", "-x", proc], check=False)
    time.sleep(5)
    subprocess.run(["open", "-a", app] + urls, check=False)
    log(f"{app} zrestartowany z kartami: {' '.join(urls)}")


class HB(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/hb"):
            app = browser_from_ua(self.headers.get("User-Agent"))
            # v3.106.0: puls niesie uni (?u=genesis/athena) — bez tego martwa karta
            # jednego uni chowała się za żywym pulsem drugiego. Stary bot pinguje
            # bez parametru: trafia tylko do zegara globalnego, jak dotąd.
            uni = None
            try:
                uni = (parse_qs(urlparse(self.path).query).get("u") or [None])[0]
                if uni:
                    uni = re.sub(r"[^a-z0-9-]", "", uni.lower())[:24] or None
            except Exception:
                uni = None
            now = time.time()
            dup = None
            with lock:
                state["last_hb"] = now
                state["hb_count"] += 1
                if uni:
                    state["unis"][uni] = now
                    state["uni_strikes"].pop(uni, None)
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
                                   "unis": {u: round(time.time() - t) for u, t in state["unis"].items()},
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
                for u in state["unis"]:
                    state["unis"][u] = now
                continue
            ref = state["last_hb"] or state["started"]
            silent = now - ref
            grace = STARTUP_GRACE if not state["last_hb"] else THRESHOLD
            stale = []
            reason = None
            if silent >= grace:
                reason = f"Brak pulsu od {round(silent / 60)} min"
            else:
                # Globalnie żywy — ale przy grze na DWÓCH uni martwa karta jednego
                # chowa się za pulsem drugiego (utrata floty 08.09 była globalna;
                # ta sama ślepota per uni bez tego bloku zostaje na zawsze).
                stale = [u for u, t in state["unis"].items() if now - t > THRESHOLD]
                if stale:
                    ages = ", ".join(f"{u} od {round((now - state['unis'][u]) / 60)} min" for u in stale)
                    reason = f"Karta uni bez pulsu ({ages}), reszta żyje"
            if not reason:
                continue
            if quiet_now():
                push("🩺 Bot OGameX MILCZY (godziny ciszy)", f"{reason} — w oknie ciszy NIE restartuję; wejdź do gry, gdy wstaniesz.")
                state["last_hb"] = max(state["last_hb"], now + 1800)  # w ciszy przypominaj co ~30 min
                for u in stale:
                    state["unis"][u] = now + 1800
                continue
            state["restarts"] = [t for t in state["restarts"] if now - t < 3600]
            if len(state["restarts"]) >= MAX_RESTARTS_H:
                push("🩺 Bot OGameX MILCZY", f"{reason}, a limit restartów wyczerpany — wejdź do gry RĘCZNIE.")
                state["last_hb"] = max(state["last_hb"], now)  # nie spamuj co 30 s
                for u in stale:
                    state["unis"][u] = now
                continue
            # Uni, które nie wstaje mimo 3 restartów, najpewniej ZAMKNĄŁ owner —
            # bez tego strażnik restartowałby przeglądarkę 3×/h w nieskończoność.
            # Uni wraca pod ochronę przy pierwszym pulsie (patrz /hb).
            dropped = []
            for u in stale:
                state["uni_strikes"][u] = state["uni_strikes"].get(u, 0) + 1
                if state["uni_strikes"][u] > 3:
                    dropped.append(u)
            for u in dropped:
                state["unis"].pop(u, None)
                state["uni_strikes"].pop(u, None)
            stale = [u for u in stale if u not in dropped]
            if dropped and not stale and silent < grace:
                push("🩺 Przestaję pilnować uni: " + ", ".join(dropped),
                     "Karta nie wstała po 3 restartach — jeśli sam ją zamknąłeś, wszystko OK. "
                     "Wraca pod ochronę przy pierwszym pulsie (otwórz grę).", "high")
                continue
            state["restarts"].append(now)
            state["last_hb"] = max(state["last_hb"], now + 300)  # 5 min łaski na wstanie przeglądarki
            for u in state["unis"]:
                state["unis"][u] = max(state["unis"][u], now + 300)
        app = target_browser()
        log(f"{reason} — restartuję {app}")
        push("🩺 Karta z grą ZAMARŁA", f"{reason} — restartuję {app} z kartami gry. Sprawdź, czy wstał.")
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
