// ==UserScript==
// @name         OGameX Assistant 3 (Genesis)
// @namespace    https://github.com/Mitjano/ogamex-userscript
// @version      3.63.0
// @description  Obrona floty dla OGameX (fork .NET) — jedno źródło prawdy (Situation), czysta decyzja (decide), jeden wykonawca (Fly). Parsery przeniesione z 2.x. Genesis only.
// @author       MCH + Claude
// @match        https://genesis.ogamex.net/*
// @updateURL    https://raw.githubusercontent.com/Mitjano/ogamex-userscript/main/ogamex-3.user.js
// @downloadURL  https://raw.githubusercontent.com/Mitjano/ogamex-userscript/main/ogamex-3.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      ntfy.sh
// @connect      raw.githubusercontent.com
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

/* ════════════════════════════════════════════════════════════════════════
   ARCHITEKTURA 3.0 (AUDYT-3.0-2026-08-28.md, opcja C „dusiciel"):
   1. Parsery (PlanetBar, Bar, Movements, Events, Hangar, FleetForm) — kod z 2.x
      sprawdzony bojowo, przeniesiony bez zmian logiki.
   2. Situation — JEDNO źródło prawdy o flocie: pary, hangary (co/gdzie/kiedy),
      zagrożenia (cel, ciało, ETA, źródło) i własne loty, w JEDNYM kluczu.
   3. decide(situation, cfg, now) → plan — CZYSTA funkcja (bez DOM, bez GM),
      testowana macierzą scenariuszy (tests3/decide.test.js).
   4. Fly — jeden wykonawca lotu (Deploy) + Recall; misja wielostronicowa w
      jednym kluczu z krokiem.
   Reguły twarde: dom = księżyc, gdy para go ma; rezerwa deuteru; stan lotu
   zamykany HANGAREM, nie zegarem; jedna ucieczka na parę; nic nie leci NA
   atakowane ciało; nieznany markup → zrzut do logu, nie zgadywanie.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  const VERSION = "3.63.0";
  const HOST = location.host;

  // ─── Store: klucze per host, JSON ────────────────────────────────────────
  const Store = {
    get(k, d = null) { try { const v = GM_getValue(`${HOST}:ogx3_${k}`, undefined); return v === undefined ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { GM_setValue(`${HOST}:ogx3_${k}`, JSON.stringify(v)); } catch {} },
    del(k) { try { GM_setValue(`${HOST}:ogx3_${k}`, "null"); } catch {} },
  };

  // ─── Log + dziennik obrony + push ────────────────────────────────────────
  const LOG_MAX = 400;
  let logEntries = Store.get("log", []) || [];
  let logTimer = null;
  function log(msg, type = "info") {
    const time = new Date().toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const s = String(msg);
    logEntries.unshift({ time, msg: s.length > 700 ? s.slice(0, 700) + " [ucięte]" : s, type });
    if (logEntries.length > LOG_MAX) logEntries.length = LOG_MAX;
    if (!logTimer) logTimer = setTimeout(() => { logTimer = null; Store.set("log", logEntries); }, 800);
    try { UI.renderLog(); } catch {}
  }
  // v3.12.0 (incydent 28.08 22:17): log zapisywał się do GM storage z opóźnieniem
  // 800 ms, a KAŻDA nawigacja bota następuje natychmiast po wpisie („[REKONESANS]
  // sprawdzam hangar…" → location.replace w tej samej linijce). Efekt: po
  // przeładowaniu strony wszystkie powody nawigacji GINĘŁY — w logu zostawały same
  // linie startowe i bot wyglądał, jakby przeładowywał stronę bez powodu. Diagnostyka
  // pętli nawigacji była wtedy niemożliwa. Test E2E tego nie łapał, bo skraca
  // setTimeout 150× (800 ms → 5 ms), więc debounce zawsze zdążył.
  function flushLog() { try { if (logTimer) { clearTimeout(logTimer); logTimer = null; } Store.set("log", logEntries); } catch {} }
  try { window.addEventListener("pagehide", flushLog); window.addEventListener("beforeunload", flushLog); } catch {}
  // Każda nawigacja bota zostawia ślad: PO CO poszedł. Następne uruchomienie skryptu
  // mówi to wprost — bez tego nie da się odróżnić „bot kręci stroną w pętli" od
  // „operator sam klika po grze".
  const Nav = {
    go(url, why) { try { Store.set("nav_last", { at: Date.now(), to: String(url), why }); } catch {} flushLog(); location.replace(url); },
    click(el, why) { try { Store.set("nav_last", { at: Date.now(), to: "klik: " + why, why }); } catch {} flushLog(); el.click(); },
  };
  const Journal = {
    add(kind, msg) {
      const j = Store.get("journal", []) || [];
      j.unshift({ at: Date.now(), kind, msg: String(msg).slice(0, 400) });
      if (j.length > 600) j.length = 600;
      Store.set("journal", j);
      Notifier.fromJournal(kind, msg);
    },
  };
  // v3.55.0 (owner 31.08: „karta może się zawiesić albo zamrozić — bot wtedy nie
  // działa"): PULS DO STRAŻNIKA. Karta-lider pinguje lokalnego strażnika
  // (watchdog/ogx-watchdog.py, LaunchAgent na Macu) co ~60 s. Gdy pulsy ustaną
  // na >12 min, strażnik restartuje Firefoksa z kartą gry i wysyła push na ntfy —
  // martwa karta przestaje być cichą śmiercią obrony. Brak strażnika to nie błąd
  // (bot działa jak dotąd) — logujemy tylko ZMIANĘ stanu.
  const Heartbeat = {
    URL: "http://127.0.0.1:8765/hb",
    ping() {
      const now = Date.now();
      if (now - (Store.get("hb_last", 0) || 0) < 60e3) return;
      Store.set("hb_last", now);
      try {
        GM_xmlhttpRequest({ method: "GET", url: this.URL, timeout: 4000,
          onload: () => { if (Store.get("hb_ok", null) !== true) { Store.set("hb_ok", true); log("[WATCHDOG] strażnik odpowiada — zawieszona karta zostanie ożywiona automatycznie (restart Firefoksa + push).", "success"); } },
          onerror: () => this.down(), ontimeout: () => this.down() });
      } catch { this.down(); }
    },
    down() { if (Store.get("hb_ok", null) !== false) { Store.set("hb_ok", false); log("[WATCHDOG] strażnik nie odpowiada (LaunchAgent wyłączony?) — po zawieszeniu karty NIE będzie auto-restartu.", "warn"); } },
  };
  const Notifier = {
    THROTTLE: { ATAK: 5 * 60e3, RATUNEK: 2 * 60e3, POWRÓT: 5 * 60e3, BŁĄD: 5 * 60e3 },
    topic() { let t = Store.get("ntfy_topic", ""); if (!t) { t = "ogamex3-" + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8); Store.set("ntfy_topic", t); } return t; },
    enabled() { return Store.get("ntfy_on", true) !== false; },
    // v3.33.0 (audyt T2 + pytanie właściciela 29.08: „czy alarm o ataku dojdzie?"):
    // dławik liczył się po RODZAJU zdarzenia, więc atak na drugą kolonię w ciągu
    // 5 minut po pierwszym NIE dawał pusha — cisza dokładnie wtedy, gdy dzieje się
    // najwięcej. Kluczem jest teraz rodzaj + współrzędne z treści.
    throttleKey(kind, msg) { const c = [...String(msg || "").matchAll(/\[(\d+:\d+:\d+)\]/g)].map(m => m[1]); return c.length ? `${kind}|${[...new Set(c)].sort().join(",")}` : kind; },
    throttled(kind, msg) { const key = this.throttleKey(kind, msg); const last = Store.get("ntfy_last", {}) || {}; if (Date.now() - (last[key] || 0) < (this.THROTTLE[kind] || 5 * 60e3)) return true; last[key] = Date.now(); Store.set("ntfy_last", last); return false; },
    push(title, msg, priority = "default", tags = "") {
      if (!this.enabled()) { if (priority === "urgent" || priority === "high") log(`[PUSH] POMINIĘTE — push OFF (${title}).`, "warn"); return; }
      const topic = this.topic();
      try {
        GM_xmlhttpRequest({ method: "POST", url: "https://ntfy.sh/" + topic, headers: { Title: title, Priority: priority, Tags: tags }, data: String(msg).slice(0, 600), timeout: 15000,
          onload: (r) => log(`[PUSH] wysłano (${priority}) na ${topic}: ${title} — HTTP ${r && r.status}`, "info"),
          onerror: () => log("[PUSH] ntfy.sh nie odpowiedziało.", "warn"), ontimeout: () => log("[PUSH] ntfy.sh timeout.", "warn") });
      } catch (e) { log(`[PUSH] błąd: ${e.message}`, "warn"); }
    },
    speak(text, times = 2) {
      if (!Store.get("voice_on", false)) return;
      try { if (!("speechSynthesis" in window)) return; const v = (speechSynthesis.getVoices() || []).find(x => /^pl/i.test(x.lang || "")); for (let i = 0; i < times; i++) { const u = new SpeechSynthesisUtterance(text); if (v) u.voice = v; u.lang = "pl-PL"; speechSynthesis.speak(u); } } catch {}
    },
    fromJournal(kind, msg) {
      const m = String(msg || "");
      if (kind === "ATAK") { if (this.throttled("ATAK", m)) return; this.push("⚔️ ATAK (Genesis)", m, "urgent", "rotating_light"); this.speak("Uwaga! Atak na bazę!", 3); }
      else if (kind === "RATUNEK" && /WYS[ŁL]ANO|wysłan/i.test(m)) { if (this.throttled("RATUNEK", m)) return; this.push("🛟 Flota ewakuowana (Genesis)", m, "default", "shield"); }
      else if (kind === "BŁĄD") { if (this.throttled("BŁĄD", m)) return; this.push("⚠️ Obrona: BŁĄD (Genesis)", m, "high", "warning"); }
      else if (kind === "POWRÓT" && /wróci|wysłan/i.test(m)) { if (this.throttled("POWRÓT", m)) return; this.push("✅ Flota w domu (Genesis)", m, "min", "white_check_mark"); }
    },
  };

  // ─── Konfiguracja ────────────────────────────────────────────────────────
  const DEFAULTS = {
    enabled: true,          // pętla obrony chodzi
    autoRescue: false,      // false = OBSERWATOR (alarmuje, nie rusza flotą). Włącz w panelu po potwierdzeniu markupu.
    // v3.41.0 (owner 30.08 18:04: „stworzyłem nowego moona i bot od razu wysłał transportery
    // z planety na moona. Nie chcę, żeby to robił. Przenosić flotę ma tylko podczas ataku"):
    // reguła „dom = księżyc" zwoziła na księżyc WSZYSTKO, co stanęło na planecie — powroty
    // ekspedycji, transportery kolonii, świeżo postawiony księżyc od razu dostawał dostawę.
    // Teraz jest to OPCJA i domyślnie WYŁĄCZONA. Powrót po ratunku działa niezależnie:
    // gdy to BOT wywiózł flotę z tej pary, wolno mu ją przywieźć z powrotem.
    homeToMoon: false,
    deutReserve: 0,         // zostaje na ciele przy każdym locie (Athena: 100 mld; Genesis start: 0)
    airSpeedPct: 10,        // ucieczka w powietrze: prędkość
    confirmMs: 20000,       // potwierdzenie zagrożenia przed ruchem (artefakty paska)
    tooLateSec: 40,         // dolot krótszy = nie zdążymy z formularzem (tylko alarm)
    recallBufferSec: 90,    // zawrót: ostatni dolot + bufor
    tickMs: 20000,
    // ── ŚLEPY ALARM (pasek misji jako trzecie źródło prawdy) ──
    // Fork nie pokazuje na liście ruchów ataków z WŁASNEGO układu (2.x: katastrofa
    // 12.08 13:10 i atak 25.08 16:22 — pasek widział, lista nie). Pasek podaje samą
    // LICZBĘ obcych flot, bez celu: nadwyżka utrzymująca się dłużej niż `barHoldMs`
    // to atak w ciemno — bronimy kolonii, w której naprawdę stoi flota.
    barExcess: true,
    barHoldMs: 60e3,        // ile musi trwać nadwyżka, zanim ruszymy flotą
    barMaxAgeMs: 3 * 60e3,  // pasek starszy niż to nie jest dowodem na nic (strona bez paska)
    barSpyHoldMs: 5 * 60e3, // gdy pasek mówi „Type: Spy" — dłużej (sondy wracają w minuty)
    // ── LIMITY TEMPA (bezpieczeństwo konta) ──
    maxNavPerHour: 240,     // sufit nawigacji/h dla EKONOMII (obrona nigdy nie liczona)
    quietHours: { enabled: true, startHour: 23, endHour: 5 },   // cisza ekonomii, niezależna od FS
    // v3.25.0: Athena NIE MIAŁA cyklicznego rekonesansu — FleetRecon.scan() odpalał
    // się wyłącznie wtedy, gdy bot i tak był na stronie floty (przy wysyłce, ratunku,
    // FS). Objazd planet to wynalazek 3.0 i to on wkurzał operatora. Patrol domyślnie
    // WYŁĄCZONY; hangar bierze się z trzech naturalnych źródeł:
    //   1. każda Twoja wizyta na /fleet (odczyt za darmo),
    //   2. ekspedycja/mining przed wysyłką dociąga hangar w TLE (bez nawigacji),
    //   3. alarm — wtedy bot ma prawo wejść na atakowane ciało (limit 3 prób).
    recon: false,            // rekonesans hangarów (bez niego bot NIE WIE, gdzie stoi flota)
    reconMs: 8 * 60e3,      // jak stary może być odczyt hangaru Z FLOTĄ, zanim pójdziemy sprawdzić
    // v3.18.0: ciało, na którym ostatnio NIE BYŁO floty, nie wymaga częstych wizyt —
    // interesujące staje się dopiero, gdy coś tam wyląduje, a to bot i tak widzi po
    // własnych lotach. Przy 12 ciałach odświeżanie wszystkich co 8 min oznaczało
    // przeskok na inną planetę praktycznie non stop (zgłoszenie właściciela 29.08).
    reconEmptyMs: 45 * 60e3,
    // v3.19.0 (decyzja właściciela 29.08: „nie chcę, żeby tak przeskakiwało co planetę
    // i sprawdzało statki"): rekonesans ma tryby.
    //   "fleet" — DOMYŚLNY: odwiedza tylko ciała, na których WIDZIAŁ flotę, plus ciało
    //             startowe ekspedycji. Reszta uzupełnia się sama z Twoich wizyt na /fleet.
    //   "all"   — dawne zachowanie: obchodzi wszystkie ciała po kolei.
    // Alarm jest osobny i NIGDY nie podlega temu ograniczeniu: gdy atak leci w ciało,
    // którego hangaru bot nie zna, i tak tam wejdzie — inaczej obrona byłaby ślepa.
    reconMode: "fleet",
    // v3.58.0 (owner 01.09: „jak najmniej śladów aktywności w galaktyce"): każdy
    // cichy fetch `?planet=UUID` pali znacznik aktywności ciała jak wizyta gracza.
    // Tryb cichy ogranicza odczyty KOLONII (baza ekspedycyjna i tak świeci od fal):
    // zwiad kolonii raz na colonyHours zamiast co 45 min, a lądowania sprawdzane
    // tylko na ciele startu ekspedycji albo przy trwającym locie obronnym.
    stealth: { enabled: true, colonyHours: 8 },
    // ── HUMANIZER ──
    // Przerwy dotyczą WYŁĄCZNIE ekonomii. W 2.x przerwa kawowa usypiała cały
    // scheduler razem z keepalive (audyt A8: droga do wylogowania i 15 min
    // ślepoty). Tu obrona, rekonesans i keepalive chodzą zawsze.
    // ecoIdleSec — lekcja z 31.08 (korekta ownera 15:20): jego „ciągle przeskakuje"
    // ZAWSZE dotyczyło skoków na INNE kolonie (robiły to w tle fetche z `?planet=` —
    // sondy i odczyty, naprawione u źródła w 3.47/3.50), a NIE przełączenia na własny
    // księżyc startowy pod formularz fali. Bramka „grasz" (3.43–3.48) leczyła objaw
    // z niewłaściwej strony: hamowała ekspedycje, które miały „wysyłać się normalnie".
    // 0 = fale lecą od razu, także w trakcie klikania. Pole w panelu pozwala włączyć
    // czekanie, gdyby przejmowanie karty na ~40 s przy fali jednak przeszkadzało.
    human: { breaks: true, breakEveryMinMin: 35, breakEveryMaxMin: 65, breakLenMinMin: 5, breakLenMaxMin: 15, economyAtNight: false, ecoIdleSec: 0 },
    // ── NOCNY FLEET SAVE ──
    // Klasyczna obrona: gdy śpisz, flota nie stoi w hangarze. Używa TEJ SAMEJ
    // maszyny lotu co ratunek (lot + zawrót), więc nie ma drugiego stanu.
    fs: { enabled: false, startHour: 23, endHour: 7, speedPct: 10, target: null },
    // ── EKONOMIA (etap 2) ──
    // v3.15.0: system minerów przeniesiony z Atheny. 3.0 wysyłał WSZYSTKIE minery
    // na jedną asteroidę i czekał na powrót — a gra ogranicza urobek pojemnością
    // ładowni floty, więc nadmiar minerów leci pusty, zamiast obrabiać kolejne
    // asteroidy (fork wystawia ich 3–6/h). Stąd: dobór wielkości floty pod
    // spodziewany urobek + loty równoległe resztą minerów.
    aster: { enabled: false, scanGapSec: 6, minTtlSec: 300, launchFrom: null,
      cargoPerMiner: 0,      // 0 = ucz się z formularza floty („Cargo space")
      expectedRes: 0,        // 0 = ucz się z dziennika asteroid; brak danych = leci całość
      buffer: 1.15,          // zapas na asteroidy większe od typowej
      percentile: 85,        // rozmiar liczony z percentyla próbek, nie ze średniej
      sampleSize: 20,
      minMiners: 1,
      parallel: true,        // resztą minerów obrabiaj kolejne asteroidy, nie czekaj na powrót
      partialRatio: 0.5,     // lot mniejszy niż połowa docelowego = czekamy na powroty
      slotReserve: 1,        // ile slotów floty zostaje wolnych (ratunek, ręczna gra)
      gapSec: 20,            // odstęp między kolejnymi wysyłkami minerów
      // v3.18.0 (porównanie z 2.x): trzy rzeczy, które Athena miała, a 3.0 nie.
      maxFlightMin: 45,      // za daleki układ pomijamy PRZED skanem, nie dopiero na formularzu
      idleScanMin: 15,       // gdy obieg zakresów nie dał nic nowego — pauza zamiast kręcenia galaktyką
      lockMin: 60 },         // te same koordy nie dostają drugiej floty (fork respawnuje asteroidy w tym samym miejscu)
    // v3.13.0: bonus online (zielony przycisk w menu gry) = antymateria + PUNKTY AKADEMII.
    // Przeniesione z 2.x (moduł OnlineBonus, sprawdzony bojowo na Athenie; właściciel
    // potwierdził 28.08, że na Genesis działa tak samo). Nie rusza flotą, więc domyślnie ON.
    bonus: { enabled: true, gapMin: 2, retryMin: 15 },
    // v3.14.0: stawianie księżyców (/home/moonformation). Domyślnie WYŁĄCZONE —
    // to jedyny moduł, który BEZPOWROTNIE wydaje surowce (na Athenie 6000 km
    // kosztowało 1,8 bln metalu), więc włącza go wyłącznie operator.
    moon: { enabled: false, maxMetalShare: 0.25, minKm: 2000, maxTries24h: 3 },
    // v3.56.0: włączone domyślnie jak na Athenie (collectDebris: true) — piraci
    // z ekspedycji zostawiają PZ na poz. 16 układu startu ekspedycji i bez
    // zbieracza złom leży godzinami. Moduł nic nie robi bez recyklerów w hangarze.
    // cargoPerRecycler: 125 000 potwierdzone na żywo 01.09 (Empty cargo space /
    // liczba recyklerów); unknownShare = ile hangaru leci, gdy dymek nie zdradza
    // rozmiaru złomu (nigdy całość — reszta wywozi surowce przy ataku).
    debris: { enabled: true, everyMin: 20, cargoPerRecycler: 125_000, unknownShare: 0.2 },
    expo: {
      enabled: false,       // włącz w panelu, gdy obrona potwierdzona na żywo
      waves: 1,             // podział floty na fale (start uni: 1; przy dużej flocie 8-14)
      discoverer40: true,   // KLASA ODKRYWCA: ekspedycje 40 min zamiast 1 h (+ obroty, + łup)
      holdingHours: 1,      // gdy opcji „40 min" nie ma (inna klasa)
      gapMinSec: 60, gapMaxSec: 90,
      // v3.49.1 (owner 31.08: „nie chcę przerw w wysyłaniu eksp"): przerwa między
      // seriami DOMYŚLNIE WYŁĄCZONA (0 = brak). Włączenie = restMaxMin > 0.
      restMinMin: 0, restMaxMin: 0,
      slotReserve: 1,       // ile slotów floty zostaje wolnych (ratunek, ręczna gra)
      excludeTypes: ["ASTEROID_MINER", "COLONY_SHIP", "DEATH_STAR", "RECYCLER", "AVATAR"],
      launchFrom: null,     // {galaxy,system,position} — null = aktywna para
    },
  };
  // v3.9.0 (audyt): płytki Object.assign nadpisywał CAŁE podobiekty (fs/expo/aster/
  // human/debris) zapisem z przeglądarki — po aktualizacji brakowało nowych pól
  // domyślnych (np. human.breakEveryMinMin → jitter(undefined) = NaN).
  const CFG = (() => {
    const saved = Store.get("cfg", {}) || {};
    const out = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
      out[k] = (v && typeof v === "object" && !Array.isArray(v)) ? Object.assign({}, v, saved[k] || {}) : (saved[k] !== undefined ? saved[k] : v);
    }
    return out;
  })();
  const saveCfg = () => Store.set("cfg", CFG);
  // v3.56.0 (prośba ownera 01.09): zapisany config sprzed tej wersji ma
  // debris.enabled:false — jednorazowo włączamy, jak migracje 2.x (RC_KEY v259).
  if (!Store.get("migr_debris_on_v356", false)) {
    Store.set("migr_debris_on_v356", true);
    if (!CFG.debris.enabled) { CFG.debris.enabled = true; saveCfg(); }
  }

  // ─── Pomocnicze ──────────────────────────────────────────────────────────
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const jitter = (a, b) => a + Math.random() * (b - a);
  async function fetchT(url, opts = {}, ms = 8000) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, ms) : null;
    try { return await fetch(url, ctrl ? { ...opts, signal: ctrl.signal } : opts); } finally { if (t) clearTimeout(t); }
  }
  const key = (c) => c && Number.isFinite(c.galaxy) ? `${c.galaxy}:${c.system}:${c.position}` : (typeof c === "string" ? c : null);
  const parseKey = (k) => { const m = String(k || "").match(/^(\d+):(\d+):(\d+)$/); return m ? { galaxy: +m[1], system: +m[2], position: +m[3] } : null; };
  const page = () => { const p = location.pathname; if (p.includes("/fleet")) return "fleet"; if (p.includes("/galaxy")) return "galaxy"; return p.replace(/^\//, "") || "home"; };
  const setInput = (input, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set; if (s) s.call(input, v); else input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); };
  const looksLoggedOut = (res, html) => { try { if (res && res.redirected && /login|auth|password/i.test(String(res.url || ""))) return true; return /name=["']password["']|type=["']password["']|<form[^>]*login/i.test(String(html || "").slice(0, 1500)); } catch { return false; } };

  // ═══ PARSERY (z 2.x) ════════════════════════════════════════════════════
  // Pasek planet: pary, księżyce, ciało aktywne. Markup: a.planet-select / a.moon-select (+.selected),
  // koordy w tekście kotwicy planety; wpis księżyca następuje po wpisie planety.
  const PlanetBar = {
    _coords(el) { const m = (el?.textContent || "").replace(/\s+/g, " ").match(/(\d+):(\d+):(\d+)/); return m ? { galaxy: +m[1], system: +m[2], position: +m[3] } : null; },
    moonOf(planetEl) { let n = planetEl ? planetEl.nextElementSibling : null; while (n && !(n.classList && n.classList.contains("moon-select"))) { if (n.classList && n.classList.contains("planet-select")) return null; n = n.nextElementSibling; } return n || null; },
    pairs() {
      const out = [];
      for (const p of document.querySelectorAll("a.planet-select, .planet-select")) {
        const c = this._coords(p); if (!c) continue;
        out.push({ key: key(c), ...c, hasMoon: !!this.moonOf(p), name: (p.textContent || "").replace(/\[.*?\]/, "").replace(/\s+/g, " ").trim().slice(0, 30) });
      }
      return out;
    },
    active() {
      const el = document.querySelector("a.moon-select.selected, .moon-select.selected, a.planet-select.selected, .planet-select.selected");
      if (!el) return null;
      const isMoon = el.classList.contains("moon-select");
      let c = this._coords(el);
      if (!c && isMoon) { let p = el.previousElementSibling; while (p && !(p.classList && p.classList.contains("planet-select"))) p = p.previousElementSibling; c = this._coords(p); }
      if (!c) { const row = el.closest("li, div, tr") || el.parentElement; c = this._coords(row); }
      return c ? { key: key(c), ...c, body: isMoon ? "moon" : "planet" } : null;
    },
    anchor(k, body) {
      for (const p of document.querySelectorAll("a.planet-select, .planet-select")) {
        if (key(this._coords(p)) !== k) continue;
        if (body === "moon") return this.moonOf(p);
        return p;
      }
      return null;
    },
    ownKeys() { const s = new Set(this.pairs().map(p => p.key)); if (s.size) Store.set("own_keys", [...s]); else for (const k of (Store.get("own_keys", []) || [])) s.add(k); return s; },
  };

  // Pasek misji nad przeglądem: „N Missions: X Own Y Hostile … Type: Attack".
  const Bar = {
    parse(text) {
      const t = String(text || "");
      const m = t.match(/(\d+)\s*Missions?\s*:/);
      if (!m) return /No fleet movement/i.test(t) ? { total: 0, own: 0, foreign: 0, barType: null } : null;
      const total = parseInt(m[1]) || 0;
      const win = t.slice(m.index, m.index + 1200).replace(/\s+/g, " ").slice(0, 220);
      const seg = (re) => { const x = win.match(re); return x ? (parseInt(x[1]) || 0) : null; };
      const own = seg(/(\d+)\s*Own/), hostile = seg(/(\d+)\s*Hostile/), friendly = seg(/(\d+)\s*Friendly/);
      if (own === null && hostile === null && friendly === null) return null;
      const foreign = hostile !== null ? hostile : Math.max(0, total - (own || 0) - (friendly || 0));
      const barType = ((win.match(/Type\s*:\s*([A-Za-z][A-Za-z ()]{0,24})/) || [])[1] || "").trim() || null;
      return { total, own: own || 0, foreign, barType, spyType: /Type\s*:\s*(Spy|Espionage)/i.test(win) };
    },
    read() { return this.parse(document.body.textContent); },
  };

  // Wiersze ruchów (lista AJAX = tylko aktywna para; panel Events w DOM = wszystkie kolonie).
  const Rows = {
    URL: "/home/fleetmovementlist",
    ATTACK: /(ATTACK|MISSILE|DESTRUCT|DESTROY|BOMBARD|INVAS|FEDERATION|GROUP|ACS|HOLD)/i,
    SPY: /(ESPIONAGE|SPY|PROBE|SCAN)/i,
    SAFE: /(TRANSPORT|DEPLOY|STATION|RETURN|EXPEDITION|COLONI|HARVEST|RECYCL|ASTEROID|COLLECT)/i,
    classify(tr, own) {
      const type = (String(tr.className).match(/row-mission-type-([A-Z_]+)/i) || [])[1] || "?";
      const srcEl = tr.querySelector(".fleet-source-coords");
      const coords = [...(tr.textContent || "").matchAll(/\[(\d+:\d+:\d+)\]/g)].map(m => m[1]);
      const srcExplicit = (String(srcEl?.textContent || "").match(/(\d+:\d+:\d+)/) || [])[1] || null;
      const src = srcExplicit || (coords.length >= 2 ? coords[0] : null);
      const dst = (!srcExplicit && coords.length === 1) ? coords[0] : (coords.filter(c => c !== src).pop() || null);   // ACS: „Players: 1/2" + tylko cel
      const eta = parseInt(tr.querySelector("[data-remaining-seconds]")?.getAttribute("data-remaining-seconds") || "0") || 0;
      const isSpy = this.SPY.test(type);
      const hostileCls = /row-hostile-mission/i.test(String(tr.className));
      const friendlyCls = /row-friendly-mission/i.test(String(tr.className));
      const attack = friendlyCls ? false : hostileCls ? !isSpy : (this.ATTACK.test(type) || (!isSpy && !this.SAFE.test(type)));
      const tdOf = (c) => { if (!c) return null; const a = [...tr.querySelectorAll("a")].find(x => (x.textContent || "").includes(`[${c}]`)); return a ? a.closest("td") : null; };
      const bodyOf = (td) => !td ? null : ((td.querySelector("img[src*='moon']") || /\bMoon\b/i.test(td.textContent || "")) ? "moon" : "planet");
      const isReturn = /return/i.test(String(tr.className)) || tr.dataset.returnFlight === "true";
      return { id: tr.getAttribute("data-fleet-id") || "", type, src, dst, eta, srcBody: bodyOf((srcEl && srcEl.closest("td")) || tdOf(src)), dstBody: bodyOf(tdOf(dst)),
        mine: !!(src && own.size && own.has(src)) || (!hostileCls && !friendlyCls && !!dst && own.has(dst) && !!src && own.has(src)),
        friendly: friendlyCls, hostile: hostileCls, attack, spy: isSpy && !friendlyCls, isReturn,
        html: (tr.outerHTML || "").replace(/\s+/g, " ").slice(0, 900) };
    },
    // ═══ WERDYKTY OSTATECZNE (sondy 3.40.1–3.49.1, USUNIĘTE w 3.50.0) ═══════
    // 1. `/home/fleetmovementlist?planet=` IGNORUJE parametr dla TREŚCI (wielokrotny
    //    pomiar A/B, 6/6 na dwóch wersjach) — ALE JAK KAŻDY `?planet=` PRZESTAWIA
    //    PLANETĘ W SESJI. Sonda pytająca o [1:217:8] przestawiała ownerowi planetę
    //    w kółko (31.08 13:48 → /galaxy otwarta na [1:217:8]), a zatrzask „zamknięte"
    //    umierał z każdą wersją, więc wracała jak zombie. LEKCJE: (a) parametr
    //    ignorowany dla treści ≠ ignorowany dla sesji — każdy fetch z `?planet=`
    //    musi przywracać wybór operatora (scanRemote) albo nie istnieć; (b) zatrzask
    //    sondy z werdyktem OSTATECZNYM nie może umierać z wersją.
    // 2. Panel Events na /research jest dla FETCHA PUSTY (4/6 prób, jednoznacznie) —
    //    fork wypełnia go JavaScriptem z tej samej listy per-para; wiersze „innych
    //    kolonii" ze zrzutu ownera to loty DOTYKAJĄCE aktywnej pary (cel = baza).
    // WNIOSEK: nie ma znanej drogi, by zobaczyć atak na kolonię spoza aktywnej pary.
    // Jedyny globalny sygnał to licznik na pasku misji (obsługuje go barExcess).
    async fetchList(own) {
      try {
        const res = await fetchT(this.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
        if (!res.ok) return { ok: false, rows: [] };
        const html = await res.text();
        Session.tried();
        if (looksLoggedOut(res, html)) { Session.lost(); return { ok: false, rows: [], loggedOut: true }; }
        Session.ok();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const trs = [...doc.querySelectorAll("tr[class*='row-mission-type-']")];
        return { ok: true, rows: trs.map(tr => this.classify(tr, own)) };
      } catch { return { ok: false, rows: [] }; }
    },
    readEvents(own) {
      const trs = [...document.querySelectorAll("#fleet-movement-content tr[class*='row-mission-type-'], #layoutFleetMovements tr[class*='row-mission-type-']")];
      return trs.map(tr => this.classify(tr, own));
    },
    // v3.36.0 (zgłoszenie właściciela 29.08 20:56 + lekcja Atheny v2.74.0 z 05.08 23:08:
    // „wiersze listy flot renderują się DOPIERO po rozwinięciu"): zwinięty pasek misji
    // pokazuje samą LICZBĘ lotów („13 Missions: 13 Own · Type: Expedition") — bez
    // współrzędnych i bez czasów. Wtedy jedynym źródłem celu zostaje lista ruchów,
    // a ta na forku pokazuje tylko aktywną parę: atak na inną kolonię schodzi do
    // ślepego alarmu (60 s zwłoki), a własne powroty w ogóle nie mają zegara.
    // Rozwijamy panel sami — jednym kliknięciem w pasek, najwyżej raz na minutę.
    // SYNCHRONICZNIE i bez czekania na render: to jest gorąca ścieżka obrony, a każdy
    // dodatkowy `await` poszerza okno, w którym dwa przebiegi mogą podjąć tę samą
    // decyzję (E2E 29.08: dwie identyczne ewakuacje w jednym scenariuszu). Klikamy
    // i wracamy — wiersze przeczyta następny przebieg, 20 s później.
    ensureOpen() {
      const st = Store.get("events_open", {}) || {};
      if (this.readEvents(new Set()).length) { if (st.at) Store.set("events_open", {}); return false; }
      const bar = Bar.read();
      if (!bar || !bar.total) return false;                       // nie ma żadnych lotów = nie ma czego rozwijać
      // v3.42.0 (zrzuty 15:31–17:50): kontener `#layoutFleetMovements` ISTNIEJE i jest PUSTY
      // — `<div class="content" id="fleet-movement-content"></div>` bez ani jednego wiersza.
      // To nie jest panel „zwinięty", tylko panel, którego fork NIE WYPEŁNIA na stronach,
      // po których bot się porusza. Nie ma czego rozwijać, więc przestajemy w to klikać:
      // pięć godzin prób co 10 minut nie dało ani jednego wiersza. Zostaje jedno zdanie
      // do logu i uczciwa informacja w panelu, że kolonie są poza nadzorem.
      const wrap0 = document.querySelector("#layoutFleetMovements");
      const content0 = document.getElementById("fleet-movement-content");
      if (wrap0 && content0 && !content0.children.length) {
        Store.set("events_open", { at: Date.now(), tried: 0, dumped: true, emptyPanel: true });
        if (!Once.said("events_empty", 6 * 3600e3)) log("[LOTY] panel „Events” jest na tej stronie PUSTY (nie zwinięty) — gra go tu nie wypełnia. Nie klikam w niego; ataki na kolonie muszą iść innym źródłem.", "warn");
        return false;
      }
      if (Date.now() - (st.at || 0) < 30e3) return false;         // jedna próba na pół minuty
      // v3.37.0 (zrzut właściciela 29.08 21:57): kliknięcie w licznik misji NIE
      // napełniło listy — kontener `#fleet-movement-content` był obecny i PUSTY,
      // czyli fork dociąga wiersze dopiero na właściwe kliknięcie. Nie zgadujemy
      // jednego selektora: próbujemy kilku kandydatów, po jednym na przebieg,
      // i mówimy w logu, w co klikamy. Gdy żaden nie zadziała — zrzut markupu
      // paska (tego jeszcze nie mieliśmy) i prośba o jedno ręczne rozwinięcie.
      const mine = (e) => e.closest("#ogx3-panel");
      const clickable = (e) => {
        if (!e || mine(e) || e.offsetParent === null) return false;
        const href = e.getAttribute && e.getAttribute("href");
        return !(href && href !== "#" && !/^javascript:/i.test(href));          // nic, co nawiguje
      };
      const barEl = [...document.querySelectorAll("a, button, div, span, td, h2, h3")].find(e => {
        if (!clickable(e) || e.children.length > 3) return false;
        const t = (e.textContent || "").replace(/\s+/g, " ").trim();
        return t.length < 120 && /\d+\s*Missions?\s*:/i.test(t);
      });
      const wrap = document.querySelector("#layoutFleetMovements");
      // v3.39.2 (owner 30.08: „bot ma sam sobie radzić ze wszystkim" — i ma rację):
      // do 3.39.1 kandydaci opierali się na liczniku „N Missions:", a zrzut z 09:58:06
      // pokazał, że heurystyka trafiała w `<div id="header">`, czyli w GÓRNĄ NAWIGACJĘ.
      // Fork ma na stronie floty jawny przełącznik „Fleet movements" (widoczny na
      // zrzucie ekranu ownera) — szukamy go wprost po tekście, zanim zaczniemy zgadywać.
      const byText = (re) => [...document.querySelectorAll("a, button, div, span, td, h2, h3, .title")]
        .filter(e => clickable(e) && e.children.length <= 3)
        .find(e => { const t = (e.textContent || "").replace(/\s+/g, " ").trim(); return t.length < 60 && re.test(t); });
      const fmBtn = byText(/fleet\s*movements?/i);
      const cands = [
        { el: fmBtn, why: "przycisk „Fleet movements”" },
        { el: fmBtn && fmBtn.parentElement, why: "rodzic przycisku „Fleet movements”" },
        { el: barEl, why: "licznik misji" },
        { el: barEl && barEl.parentElement, why: "rodzic licznika misji" },
        { el: wrap && wrap.querySelector(".header .title"), why: "nagłówek „Events”" },
        { el: wrap && wrap.querySelector(".header"), why: "pasek nagłówka listy lotów" },
        { el: wrap, why: "cały kontener listy lotów" },
      ].filter(c => clickable(c.el));
      const tried = st.tried || 0;
      if (tried >= cands.length) {
        // v3.39.2: dawniej bot poddawał się i prosił operatora o ręczne rozwinięcie
        // (a potem milczał 6 h). To jest jego robota, nie operatora: po wyczerpaniu
        // kandydatów czekamy 10 minut i próbujemy CAŁĄ listę od nowa — strona floty
        // bywa renderowana inaczej niż przegląd, więc następne wejście może trafić.
        if (Date.now() - (st.at || 0) < 10 * 60e3) return false;
        // v3.40.1: dumpa dostawaliśmy raz na 6 h, więc po każdej poprawce trzeba było
        // czekać pół dnia na dane. Diagnostyka ma być szybka: raz na 30 minut.
        if (!Once.said("events_dom", 30 * 60e3)) {
          // v3.40.0: zrzucamy KONTENER listy lotów, a nie górną nawigację — poprzedni
          // zrzut (09:58:06) pokazał `<div id="header">`, czyli menu gry, i był bezużyteczny
          // do znalezienia właściwego przełącznika.
          const dump = (wrap && wrap.outerHTML) || (fmBtn && fmBtn.outerHTML) || (document.querySelector("#fleet-movement-content") || {}).outerHTML || (barEl && (barEl.parentElement || barEl).outerHTML) || "brak kontenera listy lotów";
          log(`[LOTY DOM] żadne z ${cands.length} kliknięć nie rozwinęło listy lotów (strona: ${page()}) — próbuję dalej co 10 min. Kontener listy: ${String(dump).replace(/\s+/g, " ").slice(0, 1500)}`, "warn");
        }
        Store.set("events_open", { at: Date.now(), tried: 0, dumped: true });
        return false;
      }
      const pick = cands[tried];
      Store.set("events_open", { at: Date.now(), tried: tried + 1 });
      log(`[LOTY] lista lotów zwinięta — klikam w ${pick.why} (próba ${tried + 1}/${cands.length}).`, "info");
      try { pick.el.click(); } catch { return false; }
      const n = this.readEvents(new Set()).length;
      if (n) { log(`[LOTY] lista rozwinięta — widzę ${n} wierszy ze współrzędnymi (${pick.why}).`, "success"); Store.set("events_open", {}); }
      return true;
    },
  };

  // Hangar na stronie /fleet: [data-ship-type][data-ship-quantity].
  const Hangar = {
    // v3.24.0 (właściciel 29.08: „nie chcę, żeby przeskakiwało po planetach"):
    // hangar da się odczytać BEZ ruszania strony operatora — pasek planet ma linki
    // z identyfikatorem planety (?planet=UUID), więc pobieramy tę stronę fetchem
    // i parsujemy w pamięci. Nawigacja zostaje wyłącznie jako awaryjne wyjście,
    // gdy fork odda coś, czego nie umiemy przeczytać (wtedy: zrzut do logu).
    async scanRemote(k, body) {
      const el = PlanetBar.anchor(k, body);
      const href = el && (el.getAttribute("href") || "");
      const m = href && href.match(/[?&]planet=([^&#"']+)/i);   // fork używa UUID, ale nie zakładamy formatu
      if (!m) return null;
      // v3.47.0 (owner 31.08, trzeci raz: „ciągle przełącza bot po planetach"; Error
      // „Planet change has been detected" o 10:12): fetch `?planet=UUID` PRZEŁĄCZA
      // aktywną planetę PO STRONIE SERWERA — fork trzyma wybór w sesji. „Cichy" odczyt
      // był więc cichy tylko w tej karcie; operatorowi rozjeżdżał grę bez żadnej
      // nawigacji. Zasada: przed odczytem zapamiętujemy UUID ciała, na którym STOI
      // OPERATOR, a po odczycie przywracamy je drugim fetchem. Nie umiemy przywrócić
      // (brak kotwicy aktywnego ciała) → NIE czytamy wcale: lepszy ślepy hangar niż
      // wyrwana planeta.
      let restore = null;
      {
        const act = PlanetBar.active();
        if (act && !(act.key === k && act.body === body)) {
          const ea = PlanetBar.anchor(act.key, act.body);
          const ma = ea && ((ea.getAttribute("href") || "").match(/[?&]planet=([^&#"']+)/i));
          if (!ma) return null;
          if (ma[1] !== m[1]) restore = ma[1];
        }
      }
      try {
        const r = await fetchT(`/fleet?planet=${m[1]}`, { headers: { "X-Requested-With": "XMLHttpRequest" }, credentials: "same-origin" });
        if (restore) { try { await fetchT(`/fleet?planet=${restore}`, { headers: { "X-Requested-With": "XMLHttpRequest" }, credentials: "same-origin" }); restore = null; } catch {} }
        if (!r.ok) return null;
        const html = await r.text();
        if (looksLoggedOut(r, html)) { Session.lost(); return null; }
        const doc = new DOMParser().parseFromString(html, "text/html");
        const ships = [...doc.querySelectorAll("[data-ship-type]")].map(e => ({ type: e.dataset.shipType, qty: parseInt(e.dataset.shipQuantity || "0") || 0 })).filter(x => x.type);
        const txt = doc.body ? doc.body.textContent : "";
        const shipsStep = ships.length > 0 || /no ships|there are no ships|brak statk/i.test(txt) || !!doc.querySelector("#btn-next-fleet2, .ship-item");
        if (!shipsStep) {
          if (!Once.said("scanremote_dom", 6 * 3600e3)) log(`[REKONESANS DOM] pobrana strona floty [${k}] nie wygląda na krok wyboru statków — wracam do wchodzenia na stronę. Fragment: ${txt.replace(/\s+/g, " ").slice(0, 300)}`, "warn");
          return null;
        }
        const total = ships.reduce((x, y) => x + y.qty, 0);
        const fm = txt.match(/Fleets:\s*(\d+)\s*\/\s*(\d+)/);
        const em = txt.match(/Expeditions?:\s*(\d+)\s*\/\s*(\d+)/);
        if (fm || em) { const s0 = Situation.load(); s0.slots = { fleet: fm ? { used: +fm[1], total: +fm[2] } : (s0.slots?.fleet || null), expo: em ? { used: +em[1], total: +em[2] } : (s0.slots?.expo || null), at: Date.now() }; Situation.save(s0); }
        Situation.noteHangar({ key: k, body, total, ships, at: Date.now(), slots: fm ? { used: +fm[1], total: +fm[2] } : null });
        return { key: k, body, total };
      } catch (e) {
        // Główny fetch mógł dojść do serwera, zanim rzucił (timeout w drodze powrotnej)
        // — wybór operatora i tak przywracamy.
        if (restore) { try { await fetchT(`/fleet?planet=${restore}`, { headers: { "X-Requested-With": "XMLHttpRequest" }, credentials: "same-origin" }); } catch {} }
        return null;
      }
    },
    scan() {
      if (page() !== "fleet") return null;
      const a = PlanetBar.active();
      if (!a) {
        // v3.9.0 (audyt): cichy null = bot trwale ślepy na położenie floty i NIKT
        // się o tym nie dowie. Nieznany markup paska planet musi zostawić zrzut.
        if (!Once.said("nosidebar", 30 * 60e3)) {
          log(`[LOT DOM] jestem na /fleet, ale nie rozpoznaję paska planet (a.planet-select/.moon-select). Markup: ${(document.querySelector("#planetList, .planet-list, aside, nav") || document.body).innerHTML.replace(/\s+/g, " ").slice(0, 2000)}`, "error");
          Journal.add("BŁĄD", "Nie rozpoznaję paska planet na stronie Fleet — bot nie wie, gdzie stoi flota. Wyślij log.");
        }
        return null;
      }
      const ships = [...document.querySelectorAll("[data-ship-type]")].map(el => ({ type: el.dataset.shipType, qty: parseInt(el.dataset.shipQuantity || "0") || 0 })).filter(s => s.type);
      const total = ships.reduce((x, s) => x + s.qty, 0);
      const txt = document.body.textContent;
      // Czy to NA PEWNO krok wyboru statków? Zero statków zapisujemy tylko wtedy,
      // gdy gra faktycznie mówi "nie masz tu floty" — nigdy z braku markupu.
      const shipsStep = ships.length > 0
        || /no ships|there are no ships|brak statk|keine schiffe/i.test(txt)
        || !!document.querySelector("#btn-next-fleet2, .ship-item, #shipsChosen");
      if (!shipsStep) {
        if (!Once.said("nofleetstep", 30 * 60e3)) log("[LOT] jestem na /fleet, ale to nie krok wyboru statków (formularz w toku?) — NIE zapisuję pustego hangaru.", "info");
        return null;
      }
      const fm = txt.match(/Fleets:\s*(\d+)\s*\/\s*(\d+)/);
      const em = txt.match(/Expeditions?:\s*(\d+)\s*\/\s*(\d+)/);
      if (fm || em) { const s0 = Situation.load(); s0.slots = { fleet: fm ? { used: +fm[1], total: +fm[2] } : (s0.slots?.fleet || null), expo: em ? { used: +em[1], total: +em[2] } : (s0.slots?.expo || null), at: Date.now() }; Situation.save(s0); }
      const snap = { key: a.key, body: a.body, total, ships, at: Date.now(), slots: fm ? { used: +fm[1], total: +fm[2] } : null };
      Situation.noteHangar(snap);
      return snap;
    },
  };

  const Session = {
    lost() { const s = Store.get("session", {}) || {}; if (!s.lostAt) { s.lostAt = Date.now(); Store.set("session", s); log("[SESJA] gra odpowiada stroną logowania — obrona ŚLEPA. Zaloguj się.", "error"); Journal.add("BŁĄD", "SESJA WYGASŁA — zaloguj się w grze."); } },
    ok() { const st = Store.get("session", {}) || {}; if (st.lostAt) { Store.set("session", {}); log("[SESJA] odzyskana — obrona znów widzi.", "success"); } },
    lostRecently() { const s = Store.get("session", {}) || {}; return !!s.lostAt && Date.now() - s.lostAt < 15 * 60e3; },
    // v3.9.0 (audyt): pomijanie fetchu przy "sesja padła" sprawiało, że NIC nie mogło
    // stwierdzić powrotu sesji — bot czekał sztywne 15 min. Próbujemy dalej, rzadziej.
    retryDue() { const st = Store.get("session", {}) || {}; return Date.now() - (st.triedAt || 0) > 60e3; },
    tried() { const st = Store.get("session", {}) || {}; Store.set("session", { ...st, triedAt: Date.now() }); },
    // 2 min po wykryciu: JEDNA nawigacja na "/" — fork bywa zalogowany po ciasteczku,
    // a tylko AJAX dostał stronę logowania.
    maybeRecover() {
      const st = Store.get("session", {}) || {};
      if (!st.lostAt || Date.now() - st.lostAt < 2 * 60e3) return false;
      if (Date.now() - (st.navAt || 0) < 15 * 60e3) return false;
      if (Fly.mission()) return false;
      Store.set("session", { ...st, navAt: Date.now() });
      log("[SESJA] 2 min od wykrycia wylogowania — próbuję wejść na stronę główną.", "warn");
      setTimeout(() => Nav.go("/", "odzyskiwanie sesji"), 800);
      return true;
    },
  };

  // ═══ SITUATION — jedno źródło prawdy ════════════════════════════════════
  // { pairs: {key:{hasMoon,name}}, hangars: {"key|body":{total,ships,at}}, threats: [{id,dst,dstBody,eta,arriveAt,attack,spy,src,seenAt,source}],
  //   own: [{id,src,dst,dstBody,eta,isReturn,type,seenAt}], flights: [{id?,kind,fromKey,fromBody,toKey,toBody,sentAt,flightMs,recallAt,phase}],
  //   bar: {...,at}, active: {key,body}, updatedAt }
  const Situation = {
    load() { return Store.get("situation", null) || { pairs: {}, hangars: {}, threats: [], own: [], flights: [], bar: null, active: null, updatedAt: 0 }; },
    save(s) { s.updatedAt = Date.now(); Store.set("situation", s); return s; },
    noteHangar(snap) { const s = this.load(); s.hangars[`${snap.key}|${snap.body}`] = { total: snap.total, ships: snap.ships, at: snap.at }; this.save(s); },
    // Zbiera odczyty z DOM + AJAX i buduje nową sytuację (bez decyzji).
    async refresh() {
      const s = this.load();
      const now = Date.now();
      for (const p of PlanetBar.pairs()) s.pairs[p.key] = { hasMoon: p.hasMoon, name: p.name, galaxy: p.galaxy, system: p.system, position: p.position };
      const active = PlanetBar.active(); if (active) s.active = active;
      const own = PlanetBar.ownKeys();
      const bar = Bar.read(); if (bar) s.bar = { ...bar, at: now };
      s.night = nightWindow(CFG.fs, new Date(now));
      Rows.ensureOpen();                // zwinięty pasek misji = zero współrzędnych (v3.36.0)
      const evRows = Rows.readEvents(own);
      const list = (Session.lostRecently() && !Session.retryDue()) ? { ok: false, rows: [] } : await Rows.fetchList(own);
      // v3.50.0: obie sondy diagnostyczne USUNIĘTE — werdykty ostateczne w komentarzu
      // przy Rows (sonda listy przestawiała ownerowi planetę w sesji przy każdej próbie).
      Session.maybeRecover();
      const rows = [...evRows.map(r => ({ ...r, source: "events" })), ...list.rows.map(r => ({ ...r, source: "list" }))];
      // symulacja (panel): syntetyczny wrogi wiersz
      const sim = Store.get("sim", null);
      // v3.39.0: wiersz symulacji nie miał pola `html`, więc test w panelu witał
      // operatora ERROR-em „wrogi wiersz (ATTACK, sim): undefined".
      if (sim && sim.until > now) rows.push({ id: "sim", type: "ATTACK", src: "9:999:9", dst: sim.key, dstBody: sim.body, eta: Math.max(5, Math.round((sim.arriveAt - now) / 1000)), attack: true, spy: false, mine: false, hostile: true, source: "sim", html: "(wiersz z symulacji panelu — TEST, nie prawdziwy atak)" });
      else if (sim) { Store.del("sim"); log("[TEST] symulacja zakończona.", "info"); }
      // zagrożenia: dedup po id albo (dst|A/S|eta/20); pamięć do dolotu (+60 s)
      const seen = new Map();
      for (const t of s.threats) if ((t.arriveAt || 0) + 60e3 > now) seen.set(t.id || `${t.dst}|${t.attack ? "A" : "S"}|${Math.round((t.arriveAt || 0) / 20000)}`, t);
      for (const r of rows) {
        if (r.mine || r.friendly || r.isReturn) continue;
        // v3.9.0 (audyt): wrogi wiersz, którego celu nie umiemy odczytać, znikał BEZ
        // ŚLADU — dokładnie tam, gdzie boli najbardziej. Zrzut zamiast ciszy.
        if ((r.attack || r.spy) && (!r.dst || !own.has(r.dst))) {
          if (r.attack && !Once.said(`badrow|${r.id || r.html.slice(0, 40)}`, 10 * 60e3)) {
            log(`[ATAK DOM] wrogi wiersz, którego CELU nie rozpoznałem (dst=${r.dst || "brak"}): ${r.html}`, "error");
            Journal.add("BŁĄD", `Wrogi wiersz bez rozpoznanego celu (${r.type}) — sprawdź grę i wyślij log.`);
          }
          continue;
        }
        if (!r.attack && !r.spy) continue;
        const arriveAt = now + (r.eta || 0) * 1000;
        const k = r.id || `${r.dst}|${r.attack ? "A" : "S"}|${Math.round(arriveAt / 20000)}`;
        const prev = seen.get(k);
        seen.set(k, { id: r.id || null, dst: r.dst, dstBody: r.dstBody || prev?.dstBody || null, arriveAt, attack: !!r.attack, spy: !!r.spy, src: r.src || prev?.src || null, srcBody: r.srcBody, type: r.type, seenAt: prev?.seenAt || now, lastSeenAt: now, source: r.source, html: r.html });
        if (!prev && r.attack) log(`[ATAK DOM] wrogi wiersz (${r.type}, ${r.source}): ${r.html}`, r.source === "sim" ? "warn" : "error");
      }
      s.threats = [...seen.values()];
      // v3.9.1 (audyt): PASEK JAKO TRZECIE ŹRÓDŁO PRAWDY. Fork gubi na liście ataki
      // z własnego układu — pasek widzi je jako goły licznik. Nadwyżka „pasek minus
      // rozpoznane wiersze" utrzymująca się dłużej niż próg = atak, którego nie widzimy.
      s.barExcess = barExcessState(s.bar, s.threats, Store.get("bar_excess", null), now, CFG);
      Store.set("bar_excess", s.barExcess);
      // v3.53.0 (owner 31.08: „atakujący ręcznie zawrócił flotę — już jest bezpiecznie,
      // nic nie leci, nie ma potrzeby trzymać floty na FS"): WCZEŚNIEJSZY ZAWRÓT.
      // Pamięć zagrożenia do planowanego dolotu chroni przed zwykłym zniknięciem
      // wiersza (nieudany fetch, strona bez listy, przełączona para) — ale pasek
      // misji jest GLOBALNY: świeży odczyt z ZEREM obcych lotów, utrzymany ≥60 s,
      // to dowód zawrotu napastnika, nie artefakt odczytu. Wtedy zdejmujemy
      // zagrożenia przed terminem, a decide() zawraca ucieczkę od razu. Finta
      // (zawrót → natychmiastowa druga wysyłka) nie jest groźna: nowy wiersz ataku
      // wraca do stanu w sekundę, a flota po powrocie jest ratowana normalną ścieżką.
      {
        const barFresh = s.bar && now - (s.bar.at || 0) < 90e3;
        const clear = !!(barFresh && typeof s.bar.total === "number" && (s.bar.foreign || 0) === 0);
        s.hostileClear = clear ? (s.hostileClear && s.hostileClear.since ? s.hostileClear : { since: now }) : null;
        if (s.hostileClear && now - s.hostileClear.since >= 60e3) {
          const before = (s.threats || []).length;
          // v3.53.1 (log 19:26:59: świeżo wykryty atak skasowany w TEJ SAMEJ sekundzie):
          // wiersz widziany na liście w ostatnich 30 s jest ŻYWYM dowodem — pasek
          // sprzed ataku nie może go unieważnić. Zdejmujemy tylko zagrożenia, których
          // lista nie potwierdziła od ≥30 s.
          s.threats = (s.threats || []).filter(t => t.source === "sim" || now - (t.lastSeenAt || 0) < 30e3);
          if (s.threats.length < before) log(`[OBRONA] pasek misji czysty od ≥60 s — napastnik ZAWRÓCIŁ (${before - s.threats.length} zagrożeń zdjętych przed terminem dolotu). Ucieczka może wracać.`, "success");
        }
      }
      // własne loty (z Events — globalne; z listy — aktywna para)
      s.own = rows.filter(r => r.mine).map(r => ({ id: r.id, src: r.src, srcBody: r.srcBody, dst: r.dst, dstBody: r.dstBody, eta: r.eta, arriveAt: now + (r.eta || 0) * 1000, isReturn: r.isReturn, type: r.type, seenAt: now }));
      // v3.62.0 (log 02.09: cztery „całe hangary" z rzędu z identycznym LIGHT_CARGO
      // 1 164 208 — nie wiemy, ile statków gra NAPRAWDĘ wzięła): weryfikacja po
      // wysyłce wymaga liczby statków z wiersza własnego lotu, a tego markupu jeszcze
      // nie znamy. Zrzut raz na 6 h; parser dopiero z dowodu (reguła: nie zgadujemy).
      {
        const ex = rows.find(r => r.mine && !r.isReturn && /EXPEDITION/i.test(r.type));
        if (ex && !Once.said("ownrow_dom", 6 * 3600e3)) log(`[LOT DOM] wiersz WŁASNEJ ekspedycji z listy ruchów (do liczenia statków po wysyłce): ${ex.html}`, "info");
      }
      // v3.35.0 (audyt floty 29.08, ścieżka A5 z Ateny: „Destroy + snajperka powrotów"):
      // `s.own` było parsowane i NIGDY nieużywane, a wiersz powrotu znika z listy w tej
      // samej sekundzie, w której flota ląduje — więc wiedza o lądowaniu ginęła razem
      // z nim. Zapamiętujemy TERMIN każdego własnego powrotu; po jego minięciu obrona
      // wie, że na tym ciele właśnie coś stanęło, i idzie to sprawdzić (a potem odesłać
      // na księżyc), zamiast czekać na przypadkowy odczyt hangaru.
      {
        const land = { ...(this.load().landings || {}) };
        for (const o of s.own) {
          // v3.46.0 (test 31.08 09:06: „wróciła własna flota na księżyc [1:217:8]",
          // a flota wylądowała na [1:217:6] moon): wiersz POWROTNY trzyma w `dst`
          // PIERWOTNY CEL lotu, a wracająca flota ląduje w PUNKCIE STARTU — lądowanie
          // zapisujemy pod `src`. Ciało bierzemy z naszego wpisu lotu (bot wie, skąd
          // wysyłał); ciało z wiersza to tylko rezerwa, bo komórka źródła nie zawsze
          // znaczy księżyc tak czytelnie jak komórka celu.
          if (!o.isReturn || !(o.src || o.dst)) continue;
          const lkKey = o.src || o.dst;
          const fl = (s.flights || []).find(f => f.fromKey === lkKey && f.phase !== "done");
          const body = (fl && fl.fromBody) || (o.src ? o.srcBody : o.dstBody) || "planet";
          const lk = `${lkKey}|${body}`;
          if (!land[lk] || o.arriveAt > land[lk]) land[lk] = o.arriveAt;
        }
        for (const [lk, at] of Object.entries(land)) if (now - at > 60 * 60e3) delete land[lk];
        s.landings = land;
      }
      // v3.7.2 (audyt): refresh() czeka na AJAX listy ruchów, więc obiekt załadowany
      // przed awaitem jest już nieaktualny — inna karta (albo Hangar.scan po
      // przeładowaniu) mogła w tym czasie dopisać świeży odczyt hangaru albo slotów.
      // Zapisujemy SCALAJĄC: nasze wyliczenia + wszystko, co przyszło w międzyczasie.
      {
        const cur = this.load();
        for (const [hk, hv] of Object.entries(cur.hangars || {})) {
          const mine = s.hangars[hk];
          if (!mine || (hv.at || 0) > (mine.at || 0)) s.hangars[hk] = hv;
        }
        if (cur.slots && (!s.slots || (cur.slots.at || 0) > (s.slots.at || 0))) s.slots = cur.slots;
        // loty obronne dopisane w międzyczasie (np. przez Fly po udanej wysyłce) nie mogą zniknąć
        for (const f of (cur.flights || [])) if (!(s.flights || []).some(x => x.fromKey === f.fromKey && x.sentAt === f.sentAt)) (s.flights = s.flights || []).push(f);
        // v3.52.0: rejestr powrotów dopisany przez Fly w trakcie tego refresha też zostaje
        for (const e of (cur.expected || [])) if (!(s.expected || []).some(x => x.fromKey === e.fromKey && x.sentAt === e.sentAt)) (s.expected = s.expected || []).push(e);
      }
      // v3.52.0 (owner 31.08): REJESTR POWROTÓW — utrzymanie. Wpis `pending` starszy
      // niż 10 min = wysyłka bez potwierdzenia (lustro reguły `flights`), wpis godzinę
      // po lądowaniu = historia. Wiersz POWROTNY z listy ruchów niesie DOKŁADNY zegar,
      // więc nadpisuje nasz szacunek (lot tam + postój + lot z powrotem), o ile trafia
      // w okno ±3 min tego samego ciała startu.
      {
        const exp = (s.expected || []).filter(e => !(e.pending && now - (e.sentAt || 0) > 10 * 60e3) && now - (e.returnAt || 0) < 60 * 60e3);
        for (const o of s.own) {
          if (!o.isReturn) continue;
          const lkKey = o.src || o.dst; if (!lkKey) continue;
          let best = null;
          for (const e of exp) if (e.fromKey === lkKey && !e.pending && Math.abs(e.returnAt - o.arriveAt) < 3 * 60e3 && (!best || Math.abs(e.returnAt - o.arriveAt) < Math.abs(best.returnAt - o.arriveAt))) best = e;
          if (best) best.returnAt = o.arriveAt;
        }
        s.expected = exp;
      }
      // loty wysłane przez nas: zamknij te, których hangar-cel/źródło już pełny (hangar > zegar)
      // v3.9.0 (audyt): lot domykał się WYŁĄCZNIE po zapełnieniu hangaru ŹRÓDŁA.
      // Dla lotu planeta→księżyc ("dom = księżyc") źródło zostaje puste na zawsze,
      // więc wpis wisiał 12 h i przez cały ten czas decide() uznawał parę za
      // "w locie" — czyli po pierwszej rutynowej akcji bot przestawał bronić tej pary.
      // Teraz: lot z zawrotem domyka hangar ŹRÓDŁA (flota wróciła), lot bez zawrotu
      // (dom/swap) domyka hangar CELU (flota doleciała).
      s.flights = (s.flights || []).filter(f => {
        // v3.10.2 (audyt regresji): `pending` znaczy "klik wykonany, czekam na
        // potwierdzenie" — to stan sekundowy. Bez limitu czasu osierocony wpis
        // (klik nawigowal, kod potwierdzajacy nie wykonal sie) zaslepial pare na
        // zawsze. Po 10 min wpis przechodzi w normalne reguly wygaszania.
        if (f.pending && now - f.sentAt < 10 * 60e3) return true;
        if (f.pending) { log(`[LOT] wpis "${f.kind}" [${f.fromKey}]→[${f.toKey}] wisi 10 min bez potwierdzenia — zdejmuję, para wraca pod pełną obronę.`, "warn"); return false; }
        const watchKey = f.recallAt ? `${f.fromKey}|${f.fromBody}` : `${f.toKey}|${f.toBody}`;
        const h = s.hangars[watchKey];
        if (h && h.total > 0 && h.at > f.sentAt + 60e3) {
          // v3.52.0 (audyt powrotów 31.08) + v3.53.1 (incydent 19:29:08 — STRACONY ZAWRÓT
          // 11 mln statków): lot z zawrotem w fazie "launched" NIE MOŻE stać w hangarze
          // źródła przed terminem zawrotu — fizycznie wciąż leci. Statki widziane w źródle
          // to powroty ekspedycji, i to NIEZALEŻNIE od rejestru powrotów (3.52 pytała
          // rejestr, a ten nie znał fal wysłanych przed aktualizacją — fałszywe domknięcie
          // wykasowało wpis i 11 mln statków poleciało 5 h w jedną stronę bez zawrotu).
          // Ręczny zawrót operatora nie cierpi: wykrycie „[OPERATOR] ręczny zawrót"
          // przestawia fazę na "recalled" i wtedy domknięcie hangarem działa normalnie.
          const rescueStillOut = f.recallAt && f.phase === "launched" && h.at < f.recallAt;
          if (!rescueStillOut) { log(`[LOT] domknięty — flota widziana na [${watchKey.replace("|", " ")}] (${h.total.toLocaleString("pl-PL")}).`, "success"); return false; }
          if (!Once.said(`expclose|${f.fromKey}|${f.sentAt}`, 10 * 60e3)) log(`[LOT] hangar [${watchKey.replace("|", " ")}] pełny PRZED terminem zawrotu — to powroty/lądowania, nie ratunek; wpis ZOSTAJE (zawrót planowo).`, "info");
        }
        if (!f.recallAt && now - f.sentAt > 30 * 60e3) { log(`[LOT] ${f.kind} [${f.fromKey}]→[${f.toKey}] przeterminowany (30 min) — zdejmuję wpis, para znów pod pełną obroną.`, "warn"); return false; }
        if (now - f.sentAt > 12 * 3600e3) return false;
        return true;
      });
      return this.save(s);
    },
    // hangar z flotą (świeży <48 h) — gdzie stoi flota.
    // now WCHODZI PARAMETREM: fleetAt jest częścią decyzji, a decyzja musi być
    // czysta i testowalna w dowolnym czasie (macierz test3-decide.js).
    fleetAt(s, k, now = Date.now()) {
      const m = s.hangars[`${k}|moon`], p = s.hangars[`${k}|planet`];
      const fresh = (h) => h && now - h.at < 48 * 3600e3 && h.total > 0;
      if (fresh(m) && (!fresh(p) || m.at >= p.at || m.total >= p.total)) return { body: "moon", total: m.total, at: m.at };
      if (fresh(p)) return { body: "planet", total: p.total, at: p.at };
      return null;
    },
  };

  // Okno nocne z godzin lokalnych. Liczone POZA decide(), żeby decyzja
  // pozostała czysta i testowalna niezależnie od strefy czasowej maszyny.
  function nightWindow(fs, d) {
    if (!fs || !fs.enabled) return { active: false, endsAt: 0 };
    const h = d.getHours(), m = d.getMinutes();
    const start = fs.startHour, end = fs.endHour;
    const inWin = start === end ? false : (start < end ? (h >= start && h < end) : (h >= start || h < end));
    const endD = new Date(d); endD.setMinutes(0, 0, 0); endD.setHours(end);
    if (endD.getTime() <= d.getTime()) endD.setDate(endD.getDate() + 1);
    return { active: inWin, endsAt: endD.getTime(), startHour: start, endHour: end, nowHM: `${h}:${String(m).padStart(2, "0")}` };
  }

  // CZYSTA funkcja: ile obcych lotów widzi pasek ponad to, co rozpoznaliśmy, i jak
  // długo to trwa. Reguła z 2.x: liczby same nie rozstrzygają — rozstrzyga TRWAŁOŚĆ
  // nadwyżki (sondy wracają w minuty, atak wisi), a „Type: Spy" wydłuża próg.
  // v3.10.2: JEDNA definicja "ten wpis lotu nic juz nie znaczy" — uzywana przez
  // decide(), ekspedycje i rekonesans. Wczesniej kazdy modul mial wlasny warunek
  // `phase === "launched"`, wiec lot po nieudanym zawrocie odblokowywal obrone,
  // ale dalej zamrazal odczyty hangarow (czyli obrona i tak nie wiedziala, gdzie flota).
  function flightStale(f, now) {
    if (!f) return true;
    if (f.phase === "recall_failed") return true;
    if (f.pending && now - f.sentAt > 10 * 60e3) return true;
    if (f.recallAt && now > f.recallAt + 60 * 60e3) return true;
    return false;
  }
  const flightsBlocking = (s, now) => (s.flights || []).some(f => f.phase !== "done" && !flightStale(f, now));

  function barExcessState(bar, threats, prev, now, cfg) {
    if (!cfg.barExcess || !bar) return { active: false, count: 0, since: 0 };
    // v3.10.2: pasek odczytany dawno temu nie jest dowodem na nic. Strona bez
    // paska (formularz floty, strona błędu, logowania) zostawia w stanie STARY
    // odczyt — bez tej bramki bot ewakuował flotę na podstawie danych sprzed godziny.
    if (now - (bar.at || 0) > (cfg.barMaxAgeMs || 3 * 60e3)) return { active: false, count: 0, since: 0, stale: true };
    const live = (threats || []).filter(t => t.arriveAt > now);
    const excess = Math.max(0, (bar.foreign || 0) - live.length);
    if (excess <= 0) return { active: false, count: 0, since: 0 };
    const since = (prev && prev.count > 0 && prev.since) ? prev.since : (bar.at || now);
    const hold = bar.spyType ? (cfg.barSpyHoldMs || 5 * 60e3) : (cfg.barHoldMs || 60e3);
    return { active: now - since >= hold, count: excess, since, spyType: !!bar.spyType, waitMs: Math.max(0, hold - (now - since)) };
  }

  // ═══ decide — CZYSTA FUNKCJA ════════════════════════════════════════════
  // Wejście: situation (jak wyżej), cfg, now. Wyjście: { actions:[], alerts:[] }.
  // action: { kind:"fly", fromKey, fromBody, toKey, toBody, why, recall:bool, speed }
  //         { kind:"recall", flightId|fromKey/toKey, why }
  //         { kind:"hold", key, why }
  function decide(s, cfg, now) {
    const actions = [], alerts = [];
    const pairs = s.pairs || {};
    const threatsFor = (k) => (s.threats || []).filter(t => t.dst === k && t.attack && t.arriveAt > now);
    const attackedBodies = (k) => { const b = new Set(); for (const t of threatsFor(k)) b.add(t.dstBody || "unknown"); return b; };
    // v3.10.2 (audyt E2E): wpis lotu z zawrotem domyka się TYLKO zapełnieniem
    // hangaru źródła, więc lot, który wylądował (nie dało się ustawić prędkości)
    // albo którego zawrót zawiódł, wisiał 12 h — a `inFlightFrom` przez cały ten
    // czas kazał obronie tej pary robić `continue`. Cisza przy ataku = utrata floty.
    // Lot przestaje zaślepiać parę, gdy zawrót zawiódł albo minęła godzina od
    // planowanego zawrotu.
    const flightBlind = (f) => flightStale(f, now);
    const inFlightFrom = (k) => (s.flights || []).find(f => f.fromKey === k && f.phase !== "done" && !flightBlind(f));
    // v3.7.0 (audyt 28.08): flota potrafi stać na OBU ciałach pary naraz. fleetAt()
    // zwraca jedno miejsce, więc przy flocie na księżycu (50) i planecie (200 000)
    // oraz ataku w planetę bot mówił „bezpieczna strona" i zostawiał 200 000 pod
    // uderzeniem. Patrzymy na KAŻDE ciało z flotą osobno.
    const fleetsAt = (k) => ["moon", "planet"]
      .map(b => ({ body: b, h: (s.hangars || {})[`${k}|${b}`] }))
      .filter(x => x.h && (x.h.total || 0) > 0 && now - (x.h.at || 0) < 48 * 3600e3)
      .map(x => ({ body: x.body, total: x.h.total, at: x.h.at }));
    const neighbourMoon = (k) => { const c = pairs[k]; if (!c) return null; for (const [ok, o] of Object.entries(pairs)) { if (ok !== k && o.hasMoon && o.galaxy === c.galaxy && o.system === c.system && attackedBodies(ok).size === 0) return ok; } return null; };
    const anyRefuge = (k) => { for (const [ok, o] of Object.entries(pairs)) { if (ok !== k && attackedBodies(ok).size === 0) return { key: ok, body: o.hasMoon ? "moon" : "planet" }; } return null; };
    // v3.52.0 (owner 31.08: „bot ma wiedzieć, co kiedy wraca"): REJESTR POWROTÓW.
    // `s.expected` = loty ekonomii zapisane przy wysyłce (termin powrotu z czasu lotu
    // odczytanego z formularza). Obrona pyta o trzy rzeczy: co wraca na tę parę,
    // czy na danym ciele COŚ wylądowało PO ostatnim odczycie hangaru (wtedy odczyt
    // nie jest już świeży, choćby miał minutę) i które fale wpadną pod uderzenie.
    const returnsFrom = (k) => (s.expected || []).filter(e => e.fromKey === k && !e.pending);
    const landedSince = (k, body, at) => returnsFrom(k).some(e => e.fromBody === body && e.returnAt <= now && e.returnAt > (at || 0))
      || (((s.landings || {})[`${k}|${body}`] || 0) <= now && ((s.landings || {})[`${k}|${body}`] || 0) > (at || 0));
    const incomingBefore = (k, when) => returnsFrom(k).filter(e => e.returnAt > now && e.returnAt < when).sort((a, b) => a.returnAt - b.returnAt);
    const hhmmss = (t) => new Date(t).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    for (const k of Object.keys(pairs)) {
      const th = threatsFor(k);
      const all = fleetsAt(k);
      const fleet = Situation.fleetAt(s, k, now);
      if (!th.length) {
        // cisza: lot ucieczki z tej pary → zawrót po recallAt; brak zagrożeń i flota na planecie z księżycem → wróć na księżyc
        // v3.10.2: do ZAWROTU bierzemy lot niezaleznie od `flightStale` — porzucenie
        // floty w powietrzu jest gorsze niz spozniony zawrot (FS nocny trwa 8 h).
        const f = inFlightFrom(k) || (s.flights || []).find(x => x.fromKey === k && x.kind === "air" && ["launched", "recall_clicked"].includes(x.phase));
        if (f && f.kind === "air" && f.phase === "launched" && f.recallAt && now >= f.recallAt) actions.push({ kind: "recall", flight: f, why: "ataki minęły — zawrót ucieczki" });
        // v3.53.0: napastnik zawrócił (pasek misji globalnie czysty ≥60 s, zagrożenia
        // zdjęte w refresh) → nie czekamy do martwego terminu dolotu. NIGDY dla FS
        // nocnego (f.fs) — on jest sterowany zegarem nocy, nie atakiem, a w nocy
        // pasek jest czysty niemal zawsze.
        else if (f && f.kind === "air" && f.phase === "launched" && !f.fs && f.recallAt && s.hostileClear && now - (s.hostileClear.since || now) >= 60e3) actions.push({ kind: "recall", flight: f, why: "napastnik zawrócił (pasek czysty ≥60 s) — wcześniejszy zawrót ucieczki" });
        // v3.10.2: klik zawrotu bez potwierdzenia (brak wiersza powrotnego) ponawiamy
        // po 2 min — inaczej jeden nieskuteczny klik zostawiał flotę w powietrzu.
        else if (f && f.kind === "air" && f.phase === "recall_clicked" && now - (f.recalledAt || 0) > 2 * 60e3) actions.push({ kind: "recall", flight: f, why: "zawrót bez potwierdzenia — ponawiam" });
        // v3.34.0 (po postawieniu księżyca 29.08 20:28): reguła pytała `fleetAt()`,
        // czyli JEDNO „gdzie mieszka flota" — a to zwraca ciało z większym (albo
        // świeżej odczytanym) hangarem. Gdy gros floty stoi już na księżycu, wracające
        // z ekspedycji fale lądują na PLANECIE i nie ruszają się z niej: fleetAt mówi
        // „moon", więc dom jest domem, nic do roboty. Patrzymy więc wprost na hangar
        // PLANETY: cokolwiek na niej stoi, wraca na księżyc (przy okazji lot zabiera
        // surowce planety — to jedyny dopływ deuteru na księżyc, który sam go nie robi).
        // v3.35.0: wróciła własna flota, a hangaru tego ciała nie czytaliśmy od
        // lądowania — najpierw sprawdź, potem decyduj. Bez tego statki z powrotów
        // czekały na przypadkowy odczyt (do ~8 min stania na planecie).
        // v3.39.1 (WYCOFANE, incydent 30.08 po południu: „ciągle odświeża stronę").
        // 3.39.0 kazała tu prosić o rekonesans hangaru CELU po upływie ETA lotu.
        // Zamiar był dobry (wpis lotu domyka się odczytem hangaru, a ten zależy od
        // listy lotów w grze), ale akcja `recon` trafia do egzekutora zaprojektowanego
        // dla ALARMU: on nawiguje albo klika w pasek planet, czyli PRZEŁĄCZA operatorowi
        // planetę. W rutynowej ciszy — a takich lotów jest kilka na godzinę — to znaczy
        // przeładowanie gry co przebieg. Zamykanie wpisu zostaje więc tam, gdzie było:
        // odczyt hangaru z naturalnych źródeł + `confirmPendingSend()` (v3.39.0), które
        // zdejmuje `pending` po przeładowaniu i to ONO usuwa 10-minutowy zastój.
        // Wracać do tego wyłącznie CICHĄ ścieżką (Hangar.scanRemote, bez nawigacji).
        // v3.52.0: lądowania znamy z DWÓCH źródeł — listy ruchów (`s.landings`, tylko
        // aktywna para) i rejestru powrotów (`s.expected`, każda wysyłka ekonomii).
        // Rejestr domyka lukę: fala wraca na nieaktywną parę i bez niego hangar
        // czekał na przypadkowy odczyt.
        const landMap = { ...(s.landings || {}) };
        for (const e of returnsFrom(k)) if (e.returnAt <= now && now - e.returnAt < 30 * 60e3) { const lk = `${k}|${e.fromBody}`; if (!landMap[lk] || e.returnAt > landMap[lk]) landMap[lk] = e.returnAt; }
        for (const [lk, at] of Object.entries(landMap)) {
          const [lkey, lbody] = lk.split("|");
          if (lkey !== k || at > now || now - at > 30 * 60e3) continue;
          const lh = (s.hangars || {})[lk];
          if (lh && (lh.at || 0) >= at) continue;
          // v3.46.0 (owner 31.08: „nie podoba mi się, że bot sam przeskakuje z planety
          // na planetę" — 09:06:16 wejście na Fleet po rutynowym powrocie): to nie jest
          // alarm, więc `quiet: true` — egzekutor czyta hangar fetchem w tle i ma ZAKAZ
          // nawigacji. Jak cichy odczyt nie wyjdzie, hangar poczeka na naturalną wizytę.
          // v3.58.0 (owner 01.09: „jak najmniej śladów aktywności"): nawet cichy fetch
          // pali znacznik aktywności kolonii. W trybie cichym lądowanie na kolonii —
          // bez lotu obronnego, poza ciałem startu ekspedycji — NIE wymusza odczytu;
          // hangar poczeka na rzadki zwiad kolonii (stealth.colonyHours).
          const lf58 = cfg.expo && cfg.expo.launchFrom;
          const guarded58 = lf58 ? `${lf58.galaxy}:${lf58.system}:${lf58.position}` : null;
          if (cfg.stealth && cfg.stealth.enabled && !f && guarded58 && k !== guarded58) continue;
          actions.push({ kind: "recon", key: k, body: lbody, quiet: true, why: `wróciła własna flota na ${lbody === "moon" ? "księżyc" : "planetę"} [${k}] — sprawdzam hangar` });
          break;
        }
        const hp = (s.hangars || {})[`${k}|planet`];
        // v3.41.0: rutynowe zwożenie na księżyc jest teraz OPCJĄ (domyślnie OFF, decyzja
        // ownera 30.08). Bez niej bot rusza flotą wyłącznie przy ataku — a powrót po
        // ratunku zostaje, bo skoro sam wywiózł flotę na drugie ciało, ma ją odstawić.
        const rescuedAt = (s.rescues || {})[k] || 0;
        const backFromRescue = rescuedAt > 0 && now - rescuedAt < 6 * 3600e3;
        if (!f && pairs[k].hasMoon && hp && (hp.total || 0) > 0 && now - (hp.at || 0) < 30 * 60e3 && (cfg.homeToMoon || backFromRescue)) {
          actions.push({ kind: "fly", fromKey: k, fromBody: "planet", toKey: k, toBody: "moon", why: backFromRescue ? "powrót po ratunku: planeta → księżyc" : "dom = księżyc", speed: 100, recall: false, home: true, backHome: backFromRescue });
          continue;
        }
        // NOCNY FLEET SAVE: w oknie nocnym flota nie stoi w hangarze. Ten sam lot
        // co ucieczka (powolny Deploy + zawrót), tylko wyzwalany zegarem, nie atakiem.
        if (!f && fleet && cfg.fs && cfg.fs.enabled && s.night && s.night.active && fleet.total > 0 && now - (fleet.at || 0) > 60 * 60e3) {
          // v3.10.3: FS na godzinnym odczycie to wysylka floty, ktorej tam moze juz nie byc.
          actions.push({ kind: "recon", key: k, body: fleet.body, why: `FS nocny: odczyt hangaru [${k}] za stary — sprawdzam, zanim wysle flote` });
          continue;
        }
        if (!f && fleet && cfg.fs && cfg.fs.enabled && s.night && s.night.active && fleet.total > 0) {
          const want = cfg.fs.target && cfg.fs.target !== k ? cfg.fs.target : null;
          let dest = null;
          if (want && pairs[want] && attackedBodies(want).size === 0) dest = { key: want, body: pairs[want].hasMoon ? "moon" : "planet" };
          else {
            const home = pairs[k]; let best = -1;
            for (const [ok, o] of Object.entries(pairs)) {
              if (ok === k || attackedBodies(ok).size) continue;
              const d = Math.abs(o.galaxy - home.galaxy) * 1000 + Math.abs(o.system - home.system);   // najdalsza = najdłuższy lot
              if (d > best) { best = d; dest = { key: ok, body: o.hasMoon ? "moon" : "planet" }; }
            }
          }
          if (dest) actions.push({ kind: "fly", fromKey: k, fromBody: fleet.body, toKey: dest.key, toBody: dest.body, why: `FLEET SAVE nocny (${cfg.fs.startHour}:00–${cfg.fs.endHour}:00) → [${dest.key}]`, speed: cfg.fs.speedPct || 10, recall: true, air: true, fs: true, recallAt: s.night.endsAt });
          else alerts.push({ key: k, level: "warn", msg: `FS nocny: brak celu (jedyna kolonia albo wszystkie atakowane)` });
        }
        continue;
      }
      const soonest = Math.min(...th.map(t => t.arriveAt));
      const secs = Math.round((soonest - now) / 1000);
      const firstSeen = Math.min(...th.map(t => t.seenAt));
      // v3.52.0: fale z rejestru lądujące PRZED uderzeniem — dopisywane do alarmów,
      // żeby operator (i push) wiedział, co konkretnie wpada pod atak.
      const inc = incomingBefore(k, soonest);
      const incTxt = inc.length ? ` UWAGA: ${inc.length === 1 ? "własny powrót ląduje" : inc.length + " własne powroty lądują"} PRZED uderzeniem (pierwszy ${hhmmss(inc[0].returnAt)}, ~${inc[0].total.toLocaleString("pl-PL")} szt.).` : "";
      if (!fleet) {
        // v3.39.0 (test na żywo 30.08 09:18): ta gałąź krzyczała „nie wiem, gdzie stoi
        // flota" SZEŚĆ razy pod rząd w trakcie alarmu — choć bot minutę wcześniej sam
        // wysłał z tej pary ratunek i wpis lotu leżał w stanie. Skoro z pary trwa lot,
        // wiemy dokładnie, gdzie jest flota. Ślepotę zgłaszamy tylko wtedy, gdy naprawdę
        // jesteśmy ślepi — inaczej operator uczy się ignorować czerwone linie.
        const fOut = inFlightFrom(k);
        if (fOut) {
          // v3.54.0 (war-game W12): po ratunku hangar jest PUSTY, więc dosłana druga
          // fala ataku trafiała TUTAJ — a przedłużanie zawrotu żyło tylko w gałęzi
          // z flotą w hangarze. Ucieczka wracała 90 s po PIERWSZEJ fali, prosto pod
          // drugą. Extend musi działać niezależnie od stanu hangaru.
          if (fOut.kind === "air" && fOut.phase === "launched" && fOut.recallAt) {
            const lastArrive = Math.max(...th.map(t => t.arriveAt));
            if (lastArrive + cfg.recallBufferSec * 1000 > fOut.recallAt) actions.push({ kind: "extend", flight: fOut, recallAt: lastArrive + cfg.recallBufferSec * 1000, why: "dosłana fala" });
          }
          const land = (fOut.sentAt || 0) + (fOut.flightMs || 0);
          alerts.push({ key: k, level: "warn", throttleMs: 5 * 60e3,
            msg: `atak na [${k}] za ${secs}s — flota już wyleciała (${fOut.kind} → [${fOut.toKey}] ${fOut.toBody === "moon" ? "ksiezyc" : "planeta"}${fOut.flightMs ? `, ląduje ${new Date(land).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}), nie ma czego ratować.${incTxt}` });
        }
        // v3.9.0 (audyt): "nie wiem, gdzie flota" + "nie sprawdzę, bo alarm" = zero
        // akcji przez cały dolot. Gdy jest czas (>90 s), prosimy o rekonesans TEJ pary.
        // v3.39.0: rekonesans zostaje TAKŻE wtedy, gdy z pary trwa lot. „Coś stąd
        // wyleciało" nie znaczy „w hangarze nie ma nic" — mogły dojść nowe statki,
        // a ucieczka sprzed godzin nie jest dowodem na pusty dom.
        else alerts.push({ key: k, level: "error", msg: `atak na [${k}] za ${secs}s — nie wiem, gdzie stoi flota (brak świeżego odczytu hangaru).${incTxt}` });
        // v3.9.2 (E2E): sprawdzamy ciało, w które leci atak (a gdy nieznane — najpierw
        // księżyc, bo tam zwykle mieszka flota). Wcześniej recon zawsze celował
        // w planetę: przy flocie na księżycu bot odczytywał pusty hangar i zostawał
        // z alarmem bez ratunku.
        // Kolejność: najpierw ciało pod atakiem, potem drugie ciało pary. Bez tego
        // drugiego kroku bot po odczytaniu pustej planety zostawał w stanie „nie wiem,
        // gdzie flota" zamiast stwierdzić „flota na księżycu = bezpieczna strona".
        // v3.52.0: odczyt hangaru sprzed lądowania fali NIE jest świeży — bez tego
        // bot czytał pusty hangar raz, uznawał go za aktualny na 15 min i fala
        // lądująca w trakcie dolotu wroga stała pod uderzeniem bez ratunku.
        const fresh = (b) => { const h = (s.hangars || {})[`${k}|${b}`]; return h && now - (h.at || 0) < 15 * 60e3 && !landedSince(k, b, h.at); };
        const order = [...new Set([...attackedBodies(k), (pairs[k] && pairs[k].hasMoon) ? "moon" : "planet", "planet"])]
          .filter(b => (b === "moon" ? (pairs[k] && pairs[k].hasMoon) : b === "planet"));
        const want = order.find(b => !fresh(b)) || order[0] || "planet";
        if (secs > 90) actions.push({ kind: "recon", key: k, body: want, why: `atak, a hangar nieznany — sprawdzam ${want === "moon" ? "księżyc" : "planetę"} [${k}]` });
        continue;
      }
      const bodies = attackedBodies(k);
      const f = inFlightFrom(k);
      if (f) {
        if (f.kind === "air" && f.phase === "launched") { const lastArrive = Math.max(...th.map(t => t.arriveAt)); if (lastArrive + cfg.recallBufferSec * 1000 > f.recallAt) actions.push({ kind: "extend", flight: f, recallAt: lastArrive + cfg.recallBufferSec * 1000, why: "dosłana fala" }); }
        // v3.29.0 (audyt O1): wpis lotu kazał tu ROBIĆ `continue` — czyli atak na parę,
        // z której coś już leci, nie dawał ani alarmu, ani pusha. Fazy "done" nikt
        // nigdy nie ustawia, a faza "recalled" żyje aż do `recallAt + 60 min`, więc
        // przez godzinę po udanym zawrocie para była cicha. Ratować nie ma czego
        // (flota w powietrzu), ale MILCZEĆ nie wolno: wracająca flota może wylądować
        // dokładnie pod uderzenie i tylko właściciel może to rozstrzygnąć.
        else if (f.phase === "recalled" || f.phase === "recall_clicked") alerts.push({ key: k, level: "error", throttleMs: 5 * 60e3, msg: `ATAK na [${k}] za ${secs}s, a flota WRACA z [${f.toKey}] — sprawdź, czy zdąży wylądować po uderzeniu; nie mam czego ratować` });
        else alerts.push({ key: k, level: "error", throttleMs: 5 * 60e3, msg: `ATAK na [${k}] za ${secs}s, a z tej pary trwa lot (${f.kind}/${f.phase}) — flota jest w powietrzu, reaguj ręcznie, jeśli wróci za wcześnie` });
        // v3.52.0 (audyt powrotów 31.08, szczera granica): drugiego ratunku z tej samej
        // pary bot NIE wyśle (jeden wpis lotu na parę — drugi nadpisałby zawrót
        // pierwszego i zostawił flotę na refugium). Ale z rejestru wie, że fale
        // ekspedycji stoją albo staną pod uderzeniem — mówi to wprost, z zegarem.
        {
          const landedHit = [...bodies].filter(b => b !== "unknown").filter(b => landedSince(k, b, ((s.hangars || {})[`${k}|${b}`] || {}).at || 0));
          if (inc.length || landedHit.length) alerts.push({ key: k, level: "error", throttleMs: 60e3,
            msg: `ATAK na [${k}] za ${secs}s: ${landedHit.length ? `fala z powrotu JUŻ stoi na atakowanym ciele (${landedHit.join("/")})` : ""}${landedHit.length && inc.length ? ", a " : ""}${inc.length ? `${inc.length === 1 ? "kolejna fala ląduje" : inc.length + " kolejne fale lądują"} przed uderzeniem (pierwsza ${hhmmss(inc[0].returnAt)}, ~${inc[0].total.toLocaleString("pl-PL")} szt.)` : ""} — trwa już lot ratunkowy, drugiego nie wyślę; zawróć fale albo rozegraj ręcznie` });
        }
        continue;
      }
      // ratujemy z ciała, które JEST pod atakiem; przy dwóch takich — z większego
      const hitBodies = all.filter(x => bodies.has(x.body) || bodies.has("unknown")).sort((a, b) => b.total - a.total);
      if (!hitBodies.length) {
        // v3.52.0 (audyt powrotów 31.08, snajperka powrotów — ścieżka A5 z Atheny):
        // „bezpieczna strona" bywała wnioskiem z odczytu SPRZED lądowania fali —
        // atakowane ciało mogło właśnie przyjąć miliony statków z powrotu ekspedycji,
        // a bot trzymał `hold`, bo hangar czytał godzinę wcześniej pustkę. Lądowanie
        // po odczycie = odczyt nieważny: najpierw rekonesans, decyzja w następnym
        // przebiegu (rescue bierze wtedy CAŁY hangar, więc niczego nie pominie).
        const landedHit = [...bodies].filter(b => b !== "unknown").find(b => landedSince(k, b, ((s.hangars || {})[`${k}|${b}`] || {}).at || 0));
        if (landedHit) {
          alerts.push({ key: k, level: "error", msg: `atak na [${k}] ${landedHit === "moon" ? "księżyc" : "planetę"} za ${secs}s, a PO ostatnim odczycie hangaru wylądowała tam fala z rejestru powrotów — sprawdzam, czy jest co ratować` });
          if (secs > 90) actions.push({ kind: "recon", key: k, body: landedHit, why: `atak, a na ${landedHit === "moon" ? "księżycu" : "planecie"} [${k}] właśnie wylądowała fala — sprawdzam hangar` });
          continue;
        }
        // v3.29.0 (audyt O2): `fleetsAt` przyjmuje odczyty hangaru sprzed nawet 48 h,
        // więc „flota stoi na drugim ciele, jest bezpieczna" potrafiło opierać się na
        // wczorajszej wiedzy. Jeśli sam przestawiłeś flotę, bot uznawał atakowane
        // ciało za puste i milczał. Świeży odczyt (30 min) = decyzja; stary = alarm
        // z pushem i prośba o rekonesans, bo to jest dokładnie stan „nie wiem".
        const freshest = Math.max(...all.map(x => x.at || 0), 0);
        if (now - freshest > 30 * 60e3) {
          alerts.push({ key: k, level: "error", msg: `atak na [${k}] za ${secs}s — hangar czytany ${Math.round((now - freshest) / 60000)} min temu, NIE WIEM, czy flota nadal stoi po bezpiecznej stronie` });
          if (secs > 90) actions.push({ kind: "recon", key: k, body: [...bodies][0] === "moon" ? "moon" : "planet", why: `atak, a dane o hangarze [${k}] sprzed ${Math.round((now - freshest) / 60000)} min — sprawdzam` });
          continue;
        }
        actions.push({ kind: "hold", key: k, why: `atak w ${[...bodies].join("/")}, flota na ${all.map(x => x.body).join("+") || fleet.body} — bezpieczna strona` }); continue;
      }
      const src0 = hitBodies[0];
      if (hitBodies.length > 1) alerts.push({ key: k, level: "warn", msg: `flota na OBU ciałach [${k}] pod atakiem — ratuję najpierw ${src0.body} (${src0.total.toLocaleString("pl-PL")}), drugie ciało w następnym przebiegu` });
      fleet.body = src0.body; fleet.total = src0.total;
      if (now - firstSeen < cfg.confirmMs && secs > cfg.tooLateSec + cfg.confirmMs / 1000) { alerts.push({ key: k, level: "warn", msg: `atak na [${k}] za ${secs}s — potwierdzam ${Math.round((cfg.confirmMs - (now - firstSeen)) / 1000)}s` }); continue; }
      if (secs < cfg.tooLateSec) { alerts.push({ key: k, level: "error", msg: `atak na [${k}] za ${secs}s — ZA PÓŹNO na formularz` }); continue; }
      // wybór ucieczki: sąsiedni księżyc w układzie → drugie ciało pary (nieatakowane) → inna kolonia
      const nb = neighbourMoon(k);
      if (nb) { actions.push({ kind: "fly", fromKey: k, fromBody: fleet.body, toKey: nb, toBody: "moon", why: `atak w ${fleet.body} [${k}] → sąsiedni księżyc`, rescue: true, speed: cfg.airSpeedPct, recall: true, air: true, recallAt: Math.max(...th.map(t => t.arriveAt)) + cfg.recallBufferSec * 1000 }); continue; }
      const other = fleet.body === "moon" ? "planet" : "moon";
      if ((other === "planet" || pairs[k].hasMoon) && !bodies.has(other) && !bodies.has("unknown")) { actions.push({ kind: "fly", fromKey: k, fromBody: fleet.body, toKey: k, toBody: other, why: `atak w ${fleet.body} [${k}] → drugie ciało`, speed: 100, recall: false, rescue: true }); continue; }
      const ref = anyRefuge(k);
      if (ref) { actions.push({ kind: "fly", fromKey: k, fromBody: fleet.body, toKey: ref.key, toBody: ref.body, why: `atak na oba ciała [${k}] → powietrze do [${ref.key}]`, rescue: true, speed: cfg.airSpeedPct, recall: true, air: true, recallAt: Math.max(...th.map(t => t.arriveAt)) + cfg.recallBufferSec * 1000 }); continue; }
      alerts.push({ key: k, level: "error", msg: `atak na [${k}] — brak jakiegokolwiek refugium` });
    }
    for (const f of (s.flights || [])) {
      if (!flightBlind(f)) continue;
      if (f.kind === "air" && ["launched", "recall_clicked"].includes(f.phase)) continue;   // v3.10.2: ten wciąż jest zawracany
      alerts.push({ key: f.fromKey, level: "error", throttleMs: 15 * 60e3, msg: `lot [${f.fromKey}]→[${f.toKey}] ${f.phase === "recall_failed" ? "NIE ZOSTAŁ ZAWRÓCONY" : "dawno po terminie zawrotu"} — sprowadź flotę ręcznie; para znów pod pełną obroną` });
    }
    // ŚLEPY ALARM: pasek widzi obce loty, których nie umiemy przypisać do celu.
    // Nie zgadujemy celu — ratujemy tam, gdzie stoi flota (największy hangar),
    // dokładnie tak, jak 2.x po katastrofie 12.08.
    // v3.29.0 (audyt O3): warunek brzmiał „i nie ma ŻADNEGO rozpoznanego ataku",
    // więc jeden rozpoznany atak na pustą kolonię gasił ślepy alarm dla całej
    // reszty konta — dokładnie wariant, dla którego moduł powstał (12.08 na
    // Athenie). Nadwyżka na pasku i tak odejmuje loty rozpoznane; pary z własnym
    // atakiem obsługuje pętla wyżej, więc tutaj wystarczy je pominąć.
    if (s.barExcess && s.barExcess.active) {
      const withFleet = Object.keys(pairs)
        .map(k => ({ k, f: fleetsAt(k).sort((a, b) => b.total - a.total)[0] }))
        .filter(x => x.f && !inFlightFrom(x.k) && threatsFor(x.k).length === 0)
        .sort((a, b) => b.f.total - a.f.total);
      if (withFleet.length) {
        const t = withFleet[0];
        alerts.push({ key: t.k, level: "error", blind: true, msg: `ŚLEPY ALARM: pasek widzi ${s.barExcess.count} obcych lotów bez rozpoznanego celu od ${Math.round((now - s.barExcess.since) / 1000)}s — bronię [${t.k}] ${t.f.body} (${t.f.total.toLocaleString("pl-PL")} statków)` });
        const nb = neighbourMoon(t.k);
        const dest = nb ? { key: nb, body: "moon" } : anyRefuge(t.k);
        if (dest) actions.push({ kind: "fly", fromKey: t.k, fromBody: t.f.body, toKey: dest.key, toBody: dest.body, why: "ŚLEPY ALARM (pasek widzi atak, listy brak)", speed: cfg.airSpeedPct, recall: true, air: true, blind: true, recallAt: now + 10 * 60e3 });
        else alerts.push({ key: t.k, level: "error", msg: "ŚLEPY ALARM, ale nie mam dokąd uciec — reaguj ręcznie" });
      } else {
        alerts.push({ key: "?", level: "warn", msg: `ŚLEPY ALARM: pasek widzi ${s.barExcess.count} obcych, ale nie wiem, gdzie stoi flota` });
      }
    }
    // v3.7.0 (audyt 28.08): zagrożenie na kolonię, której NIE MA na pasku planet
    // (strona bez sidebara, świeża kolonia, literówka w koordach) nie może zniknąć
    // bez śladu — cisza przy ataku to najgorszy możliwy błąd tego bota.
    const known = new Set(Object.keys(pairs));
    for (const t of (s.threats || [])) {
      if (!t.attack || t.arriveAt <= now || known.has(t.dst)) continue;
      alerts.push({ key: t.dst, level: "error", unknownPair: true, msg: `ATAK na [${t.dst}] ${t.dstBody || "?"} za ${Math.round((t.arriveAt - now) / 1000)}s, a tej kolonii NIE MA na pasku planet — reaguj ręcznie` });
    }
    return { actions, alerts };
  }

  // v3.9.1 (audyt): sufit nawigacji na godzinę — skan galaktyki potrafi zrobić
  // setki żądań w kilka minut, co jest widoczne z drugiej strony. Dotyczy WYŁĄCZNIE
  // ekonomii; obrona i rekonesans nie są liczone ani ograniczane.
  const NavRate = {
    note() { const a = (Store.get("nav_log", []) || []).filter(t => Date.now() - t < 3600e3); a.push(Date.now()); Store.set("nav_log", a); },
    over() { const a = (Store.get("nav_log", []) || []).filter(t => Date.now() - t < 3600e3); return a.length >= (CFG.maxNavPerHour ?? 240); },
  };

  // ═══ HUMANIZER (tylko ekonomia) ═════════════════════════════════════════
  const Human = {
    onBreak() { return Date.now() < (Store.get("break_until", 0) || 0); },
    breakLeftMin() { return Math.max(0, Math.ceil(((Store.get("break_until", 0) || 0) - Date.now()) / 60000)); },
    maybeStart() {
      const h = CFG.human || {};
      if (!h.breaks) return false;
      const now = Date.now();
      // v3.16.0 (29.08 08:20): przerwa „po godzinie pracy" wypadała 13 SEKUND po
      // włączeniu bota rano — bo termin następnej przerwy pochodził z wczorajszego
      // wieczora, a przez noc bot był wyłączony. Przerwa ma imitować człowieka,
      // który się zmęczył pracą; po przestoju nie ma z czego odpoczywać.
      const idle = now - (Store.get("eco_last", 0) || 0);
      Store.set("eco_last", now);
      let next = Store.get("break_next", 0) || 0;
      if (!next || (now >= next && idle > 20 * 60e3)) {
        Store.set("break_next", now + jitter(h.breakEveryMinMin, h.breakEveryMaxMin) * 60e3);
        if (next && !Once.said("break_stale", 60 * 60e3)) log("[PRZERWA] ekonomia stała dłużej niż 20 min (bot wyłączony) — zaległa przerwa przepada, licznik startuje od nowa.", "info");
        return false;
      }
      if (now < next) return false;
      const len = jitter(h.breakLenMinMin, h.breakLenMaxMin) * 60e3;
      Store.set("break_until", now + len);
      Store.set("break_next", now + len + jitter(h.breakEveryMinMin, h.breakEveryMaxMin) * 60e3);
      log(`[PRZERWA] ekonomia pauzuje na ~${Math.round(len / 60000)} min (rytm człowieka). Obrona działa normalnie.`, "info");
      return true;
    },
    // v3.47.0: „operator właśnie gra" (świeże zaufane kliknięcie). Używane przez
    // odczyty W TLE (recon_bg, rekonesans po lądowaniu) — nawet z przywracaniem
    // wyboru planety zostaje ułamek sekundy rozjazdu po stronie serwera, więc gdy
    // grasz, tło po prostu czeka. ALARM tego nie pyta.
    playing(ms = 90e3) { return Date.now() - (Store.get("input_at", 0) || 0) < ms; },
    // Jedyne pytanie, jakie zadaje ekonomia. Obrona NIGDY tego nie pyta.
    economyAllowed(s) {
      if (this.onBreak()) return `przerwa (~${this.breakLeftMin()} min)`;
      if (this.maybeStart()) return "przerwa właśnie się zaczęła";
      if (!CFG.human.economyAtNight && s && s.night && s.night.active) return "okno nocne — ekonomia śpi, flota jest na FS";
      // v3.9.1 (audyt): okno nocne było podpięte pod Fleet Save — przy FS OFF
      // (domyślnie!) ekonomia chodziła 24/7, co jest głośniejsze niż cokolwiek
      // w arytmetyce floty. Cisza ma własne, niezależne okno z jitterem granic.
      if (!CFG.human.economyAtNight && this.quiet()) return "godziny ciszy (konto ma wyglądać na śpiące)";
      // v3.43.0 (owner 30.08 20:31: „dlaczego bot przeskakuje na jakieś inne planety/moony?
      // bez sensu, bardzo mnie to denerwuje"): KAŻDA fala ekspedycji zaczyna się od
      // `[LOT] przełączam na moon [1:217:6]` — czyli wyrywa operatorowi aktywne ciało
      // w środku rozbudowy kolonii, i to przy pięciu falach w serii, kilka razy na godzinę.
      // Rekonesans szanuje to od dawna („grasz — nie przełączam Ci planety"), ekonomia nie.
      // Teraz czeka, aż przestaniesz klikać — ale najwyżej 6 minut, żeby seria ekspedycji
      // nie stanęła na cały wieczór, gdy grasz bez przerwy.
      {
        // Sygnał „gram" bierzemy z PRAWDZIWYCH kliknięć operatora: zdarzenia `isTrusted`
        // generuje wyłącznie przeglądarka na skutek działania człowieka — klik wywołany
        // z kodu (`el.click()`) ma tam false, więc bot nie zablokuje sam sobie ekonomii.
        //
        // v3.44.0: ZDJĘTY SUFIT 6 MINUT. W 3.43.0 bramka po sześciu minutach przepuszczała
        // ekspedycję mimo trwającej gry — i dokładnie to owner zobaczył 30.08 o 22:02
        // („ciągle przełącza planety!"): o 21:55 wysyłka wstrzymana, o 22:02 przepuszczona,
        // bo minął sufit. Ekonomia czeka teraz TAK DŁUGO, JAK GRASZ, i rusza minutę po
        // ostatnim kliknięciu. Cena jest jawna: przy długiej sesji sloty ekspedycji stoją —
        // to świadomy wybór ownera („przenosić flotę ma tylko podczas ataku", 18:04).
        // Obrona i ratunek NIE podlegają tej bramce i działają natychmiast.
        // v3.51.0: bramka STEROWANA przez CFG.human.ecoIdleSec; 0 (domyślne, decyzja
        // ownera 31.08 15:07) = brak czekania — patrz komentarz przy DEFAULTS.human.
        const now2 = Date.now();
        const klik = Store.get("input_at", 0) || 0;
        const cisza = now2 - klik;
        const idleMin = Math.max(0, Math.round((CFG.human.ecoIdleSec ?? 0) / 60));
        if (idleMin > 0 && cisza < idleMin * 60e3) {
          const since = Store.get("eco_wait_since", 0) || 0;
          if (!since) Store.set("eco_wait_since", now2);
          const czeka = Math.round((now2 - (since || now2)) / 60000);
          return czeka >= 1
            ? `grasz — ekonomia czeka od ${czeka} min (ruszy po ${idleMin} min od ostatniego kliknięcia)`
            : "grasz — nie przełączam Ci planety, ekspedycja poczeka";
        }
        if (Store.get("eco_wait_since", 0)) Store.set("eco_wait_since", 0);
      }
      if (NavRate.over()) return `sufit ${CFG.maxNavPerHour} nawigacji/h — ekonomia czeka`;
      return null;
    },
    quiet() {
      const q = CFG.quietHours || {};
      if (!q.enabled || q.startHour === q.endHour) return false;
      const d = new Date();
      // jitter granic per dzień: cisza zaczynająca się co do sekundy o tej samej
      // godzinie jest odciskiem palca (lekcja 2.x v2.12.0).
      const day = d.toISOString().slice(0, 10);
      let j = Store.get("quiet_jitter", null);
      if (!j || j.day !== day) { j = { day, a: Math.round(Math.random() * 40 - 20), b: Math.round(Math.random() * 40 - 20) }; Store.set("quiet_jitter", j); }
      const nowMin = d.getHours() * 60 + d.getMinutes();
      const norm = (m) => ((m % 1440) + 1440) % 1440;
      const a = norm(q.startHour * 60 + j.a), b = norm(q.endHour * 60 + j.b);
      return a < b ? (nowMin >= a && nowMin < b) : (nowMin >= a || nowMin < b);
    },
  };

  // ═══ KSIĘŻYCE (/home/moonformation) ══════════════════════════════════════
  // Fork MA własne „Form a moon" za metal (potwierdzone na Athenie 26.08:
  // [2:21:4] 6000 km za 1,8 bln). Dla 3.0 to nie kaprys: reguła „dom = księżyc",
  // Fleet Save i ucieczka na sąsiedni księżyc są tyle warte, ile masz księżyców.
  // Trzy bezpieczniki, bo moduł WYDAJE surowce bezpowrotnie:
  //   • domyślnie OFF — włącza operator,
  //   • sufit udziału metalu (domyślnie 25%) i średnica dobierana W DÓŁ,
  //   • 3 próby na planetę na dobę i twardy limit nawigacji na próbę.
  const Moon = {
    KM: [8944, 8000, 7000, 6000, 5000, 4000, 3000, 2000, 1000],
    st() { const d = { tries: {}, m: null }; return { ...d, ...(Store.get("moon", d) || d) }; },
    save(v) { Store.set("moon", v); },
    canTry(st, k) {
      const e = (st.tries || {})[k];
      if (!e) return true;
      if (Date.now() - e.at > 24 * 3600e3) return true;
      return e.n < (CFG.moon.maxTries24h || 3) && Date.now() - e.at > 10 * 60e3;
    },
    noteTry(st, k) {
      const t = st.tries || (st.tries = {});
      const e = t[k] && Date.now() - t[k].at < 24 * 3600e3 ? t[k] : { n: 0, at: 0 };
      e.n += 1; e.at = Date.now(); t[k] = e; this.save(st); return e.n;
    },
    metal() {
      const el = document.querySelector(".resource-item-metal, #resources_metal, [class*='metal']");
      const m = el && (el.textContent || "").match(/\d[\d .,']*/);
      const n = m ? parseInt(m[0].replace(/[^\d]/g, ""), 10) : NaN;
      return Number.isFinite(n) ? n : null;
    },
    // Strona formowania: pole średnicy + przycisk „Form a moon" + koszt przy „Requirements".
    formEls() {
      const own = (e) => e.closest("#ogx3-panel");
      const inputs = [...document.querySelectorAll("input")].filter(i => !own(i) && i.offsetParent !== null && /number|text/i.test(i.type || "text"));
      const input = inputs.find(i => /diam|śred|sred/i.test(`${i.id} ${i.name} ${i.className}`)) || inputs.find(i => /^\s*[\d.,]+\s*$/.test(i.value || "")) || inputs[0] || null;
      const btn = [...document.querySelectorAll("a, button, input[type='submit']")].find(e => !own(e) && e.offsetParent !== null && /form\s*a\s*moon|utw[oó]rz\s*ksi/i.test(e.value || e.textContent || "")) || null;
      return { input, btn };
    },
    cost() {
      const t = document.body.textContent || "";
      const i = t.search(/Requirements|Wymagania|Cost|Koszt/i);
      if (i < 0) return null;
      const m = t.slice(i, i + 400).match(/\d{1,3}(?:[ .,]\d{3})+|\d{4,}/);
      return m ? parseInt(m[0].replace(/[^\d]/g, ""), 10) : null;
    },
    async setKm(input, km) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      input.focus();
      if (setter) setter.call(input, String(km)); else input.value = String(km);
      for (const ev of ["input", "change", "keyup"]) input.dispatchEvent(new Event(ev, { bubbles: true }));
      input.blur();
      await sleep(jitter(500, 900));
    },
    target(s) {
      for (const [k, p] of Object.entries(s.pairs || {})) if (!p.hasMoon) return k;
      return null;
    },
    async tick(s) {
      if (!CFG.moon.enabled || Fly.mission()) return false;
      const now = Date.now();
      if ((s.threats || []).some(t => t.attack && t.arriveAt > now)) return false;
      const st = this.st();
      const m = st.m;
      // ── weryfikacja poprzedniej próby: para ma już księżyc? ──
      if (m && now - m.at < 10 * 60e3) {
        if ((s.pairs || {})[m.key]?.hasMoon) {
          st.m = null; this.save(st);
          log(`[KSIĘŻYC] ✅ [${m.key}] ma księżyc (${m.km} km za ${(m.cost || 0).toLocaleString("pl-PL")} metalu).`, "success");
          Journal.add("POWRÓT", `Postawiony księżyc przy [${m.key}] — ${m.km} km.`);
          return false;
        }
        if ((m.navs || 0) >= 4) { st.m = null; this.save(st); log(`[KSIĘŻYC] 4 nawigacje bez efektu przy [${m.key}] — odpuszczam do następnej próby.`, "warn"); return false; }
      } else if (m) { st.m = null; this.save(st); }
      if (Human.economyAllowed(s)) return false;
      const cur = this.st();
      const key0 = cur.m ? cur.m.key : this.target(s);
      if (!key0) { if (!Once.said("moon_none", 6 * 3600e3)) log("[KSIĘŻYC] każda planeta ma już księżyc — nie ma co stawiać.", "info"); return false; }
      if (!cur.m && !this.canTry(cur, key0)) return false;
      const act = s.active;
      // krok 1: stanąć na planecie, przy której stawiamy księżyc
      if (!act || act.key !== key0 || act.body !== "planet") {
        const el = PlanetBar.anchor(key0, "planet");
        if (!el) { if (!Once.said("moon_anchor|" + key0, 3600e3)) log(`[KSIĘŻYC] nie widzę [${key0}] na pasku planet — pomijam.`, "warn"); return false; }
        cur.m = { key: key0, at: now, navs: ((cur.m || {}).navs || 0) + 1 }; this.save(cur);
        log(`[KSIĘŻYC] stawiam księżyc przy [${key0}] — przełączam się na tę planetę.`, "warn");
        Nav.click(el, `księżyc: przełączenie na [${key0}]`);
        return true;
      }
      // krok 2: strona formowania
      if (!/moonformation/i.test(location.pathname)) {
        cur.m = { key: key0, at: now, navs: ((cur.m || {}).navs || 0) + 1 }; this.save(cur);
        Nav.go("/home/moonformation", `księżyc: formularz dla [${key0}]`);
        return true;
      }
      const { input, btn } = this.formEls();
      if (!input || !btn) {
        this.noteTry(cur, key0);
        log(`[KSIĘŻYC DOM] nie rozpoznaję strony formowania (input:${!!input}, przycisk:${!!btn}). Markup: ${(document.querySelector("#content, .content, main") || document.body).innerHTML.replace(/\s+/g, " ").slice(0, 1500)}`, "error");
        cur.m = null; this.save(cur);
        return false;
      }
      const metal = this.metal();
      // v3.22.0 (audyt): przy nieodczytanym metalu budzet byl null, a warunek
      // "budget == null || c <= budget" przepuszczal PIERWSZA srednice z listy (8944 km).
      // Nieznany stan konta nie moze znaczyc "wydaj ile chcesz" — wtedy nie budujemy.
      if (metal == null) {
        const curX = this.st(); this.noteTry(curX, key0); curX.m = null; this.save(curX);
        log("[KSIEZYC] nie odczytalem stanu metalu — nie ryzykuje zakupu najwiekszej srednicy.", "error");
        log("[KSIEZYC DOM] pasek surowcow: " + ((document.querySelector(".resource-item-metal, #resources_metal, [class*='metal']") || document.body).outerHTML || "").replace(/\s+/g, " ").slice(0, 300), "warn");
        return false;
      }
      const budget = Math.floor(metal * Math.min(1, Math.max(0.01, CFG.moon.maxMetalShare ?? 0.25)));
      let picked = null;
      for (const km of this.KM) {
        if (km < (CFG.moon.minKm || 1000)) break;
        await this.setKm(input, km);
        const c = this.cost();
        if (c == null) continue;
        if (c <= budget) { picked = { km, cost: c }; break; }
      }
      if (!picked) {
        const n = this.noteTry(cur, key0);
        log(`[KSIĘŻYC] za drogo: metal ${metal == null ? "?" : metal.toLocaleString("pl-PL")}, budżet ${budget == null ? "?" : budget.toLocaleString("pl-PL")} (${Math.round((CFG.moon.maxMetalShare || .25) * 100)}%) — żadna średnica ≥ ${CFG.moon.minKm} km się nie mieści (próba ${n}).`, "warn");
        cur.m = null; this.save(cur);
        return false;
      }
      const n = this.noteTry(cur, key0);
      cur.m = { key: key0, at: Date.now(), navs: (cur.m || {}).navs || 0, km: picked.km, cost: picked.cost }; this.save(cur);
      log(`[KSIĘŻYC] [${key0}]: ${picked.km} km za ${picked.cost.toLocaleString("pl-PL")} metalu (mam ${metal == null ? "?" : metal.toLocaleString("pl-PL")}, sufit ${Math.round((CFG.moon.maxMetalShare || .25) * 100)}%) — próba ${n}. Klikam „Form a moon".`, "success");
      Journal.add("RATUNEK", `Stawiam księżyc przy [${key0}]: ${picked.km} km za ${picked.cost.toLocaleString("pl-PL")} metalu.`);
      Nav.click(btn, `księżyc: formowanie ${picked.km} km przy [${key0}]`);
      return true;
    },
  };

  // ═══ BONUS ONLINE (antymateria + punkty Akademii) ═══════════════════════
  // Fork stawia w menu link <a href="/home/onlinebonus" id="btn-online-bonus">.
  // Odbiór = zwykła NAWIGACJA pod ten adres (2.x v2.17.1: klik przegrywał wyścig
  // z innymi modułami, nawigacja jest atomowa). Trzy pułapki z Atheny, których
  // pilnujemy: napis z odliczaniem („Online bonus 04:12") to NIE jest bonus do
  // odbioru, wyszarzony wpis też nie, a klik trzeba potwierdzić na następnej
  // stronie — inaczej bot „odbiera" w kółko ten sam, nieklikalny przycisk.
  const Bonus = {
    st() { const d = { claims: [], nextTry: 0, pending: 0, fails: 0 }; return { ...d, ...(Store.get("bonus", d) || d) }; },
    save(v) { Store.set("bonus", v); },
    today(st) { const t0 = new Date(); t0.setHours(0, 0, 0, 0); return (st.claims || []).filter(t => t >= t0.getTime()).length; },
    find() {
      const own = (e) => e.closest("#ogx3-panel");
      const byId = document.getElementById("btn-online-bonus");
      if (byId && !own(byId)) return byId;
      const byHref = [...document.querySelectorAll("a[href*='onlinebonus'], a[href*='online-bonus']")].find(e => !own(e));
      if (byHref) return byHref;
      return [...document.querySelectorAll("a, button")].find(e => !own(e) && e.offsetParent !== null && /^(online bonus|bonus online)\b/i.test((e.textContent || "").replace(/\s+/g, " ").trim())) || null;
    },
    // v3.30.0: strona bez menu gry (ekran po wysyłce floty, krok formularza, "/")
    // to nie jest dowód, że bonusu nie ma. Zamiast czekać na przypadkową wizytę
    // na stronie z menu, dociągamy /home w TLE — dokładnie tak, jak ekspedycja
    // dociąga hangar (bez ruszania stroną właściciela). Odczyt najwyżej co 2 min.
    async findRemote() {
      this.probed = false;
      const at = Store.get("bonus_probe_at", 0) || 0;
      if (Date.now() - at < 2 * 60e3) return null;
      Store.set("bonus_probe_at", Date.now());
      try {
        // BEZ nagłówka XMLHttpRequest: fork oddaje wtedy sam fragment treści, a
        // przycisk bonusu siedzi w MENU, poza nim. Z nagłówkiem sonda zawsze
        // wracała pusta (log 29.08: „brak przycisku" co 30 min mimo bonusu).
        const r = await fetchT("/home", { credentials: "same-origin" });
        if (!r.ok || /\/auth\/login/.test(r.url || "")) return null;
        const doc = new DOMParser().parseFromString(await r.text(), "text/html");
        // v3.31.0: "menu sprawdzone, przycisku nie ma" to inny stan niż "nie udało
        // się sprawdzić" — właściciel ma prawo wiedzieć, że bot NAPRAWDĘ patrzył.
        this.probed = true;
        return doc.getElementById("btn-online-bonus")
          || doc.querySelector("a[href*='onlinebonus'], a[href*='online-bonus']")
          || [...doc.querySelectorAll("a, button")].find(e => /^(online bonus|bonus online)\b/i.test((e.textContent || "").replace(/\s+/g, " ").trim()))
          || null;
      } catch { return null; }
    },
    claimable(el) {
      if (!el) return { ok: false, why: "brak przycisku" };
      const label = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (/\d{1,2}:\d{2}/.test(label)) return { ok: false, why: `odliczanie („${label}")`, wait: 5 * 60e3 };
      if (el.classList.contains("disabled") || el.getAttribute("aria-disabled") === "true" || el.disabled) return { ok: false, why: "wyszarzony", wait: 10 * 60e3 };
      return { ok: true, label };
    },
    async tick(s) {
      if (!CFG.bonus.enabled || Fly.mission()) return false;
      const now = Date.now();
      const st = this.st();
      // ── potwierdzenie poprzedniego odbioru (stempel przeżył nawigację) ──
      if (st.pending) {
        const gone = this.claimable(this.find());
        if (!gone.ok) {   // przycisk zniknął albo pokazuje odliczanie = bonus wzięty
          st.claims = [...(st.claims || []).filter(t => now - t < 48 * 3600e3), now];
          st.pending = 0; st.fails = 0; st.nextTry = now + Math.max(1, CFG.bonus.gapMin) * 60e3;
          this.save(st);
          log(`[BONUS] odebrany — antymateria + punkty Akademii. Dziś: ${this.today(st)}.`, "success");
          return false;
        }
        st.pending = 0; st.fails = (st.fails || 0) + 1;
        st.nextTry = now + Math.max(1, CFG.bonus.retryMin) * 60e3;
        this.save(st);
        log(`[BONUS] kliknięcie nie odebrało bonusu (przycisk dalej aktywny, próba ${st.fails}) — wracam za ${CFG.bonus.retryMin} min.`, "warn");
        return false;
      }
      if ((s.threats || []).some(t => t.attack && t.arriveAt > now)) return false;   // alarm ma pierwszeństwo
      if (now < (st.nextTry || 0)) return false;
      // v3.14.0 (zgłoszenie 28.08 23:26: „nie zbiera bonusu jak na Athenie"):
      // bonus wpadał pod ciszę nocną ekonomii (23:00–05:00) i milczał. Ale cisza ma
      // sprawiać, że konto WYGLĄDA na śpiące — a gdy operator sam klika po grze,
      // konto jest jawnie online. Wtedy jeden klik w menu gry niczego nie zdradza.
      const why = Human.economyAllowed(s);
      if (why) {
        const playing = Date.now() - (Store.get("manual_at", 0) || 0) < 10 * 60e3;
        // v3.43.1 (log 21:43:04): nowa bramka „grasz" z 3.43.0 zablokowała też BONUS
        // ONLINE — a to jest jeden klik w link w menu gry, nie przełączanie planety,
        // i wpada rzadko (antymateria + punkty Akademii). Skoro operator i tak klika,
        // konto jest jawnie online i ten klik niczego nie kosztuje. Zwolniony z bramki.
        if (!(playing && /godziny ciszy|okno nocne/.test(why)) && !/grasz —/.test(why)) {
          if (!Once.said("bonus_wait|" + why.slice(0, 14), 60 * 60e3)) log(`[BONUS] nie odbieram teraz: ${why}.`, "info");
          return false;
        }
      }
      let el = this.find();
      let c = this.claimable(el);
      if (!c.ok && c.why === "brak przycisku") {
        const remote = await this.findRemote();
        // Element z DOMParsera nie jest w drzewie strony — kliknąć go nie sposób,
        // więc bierzemy go tylko wtedy, gdy niesie adres do nawigacji.
        if (remote && remote.getAttribute && remote.getAttribute("href")) { el = remote; c = this.claimable(remote); if (c.ok) { c.label = (c.label || "Online bonus") + " (widziany w /home)"; c.remote = true; } }
        else if (!remote && this.probed) c = { ok: false, why: "bonus jeszcze nie wrócił (menu /home sprawdzone)" };
      }
      if (!c.ok) {
        // v3.27.0 (zgłoszenie 29.08 13:25: „bot nie klika online bonus, na Athenie
        // działało"): BRAK przycisku na stronie to nie powód do karencji — bot tika
        // także na stronach bez menu gry (kroki formularza floty, ekrany po wysyłce),
        // a każde takie tiknięcie odsuwało próbę o 10 MINUT. Przy ekspedycjach co parę
        // minut bonus nie wracał praktycznie nigdy, a log milczał (dławik 6 h).
        // Athena odsuwała próbę TYLKO dla wyszarzenia (10 min) i odliczania (5 min);
        // „nie widzę przycisku" znaczyło po prostu „spróbuj na następnej stronie".
        if (c.wait) { st.nextTry = now + c.wait; this.save(st); }
        if (!Once.said("bonus|" + c.why, 60 * 60e3)) log(`[BONUS] nie odbieram: ${c.why}${c.wait ? ` — wracam za ${Math.round(c.wait / 60000)} min` : " (spróbuję na następnej stronie)"}.`, "info");
        return false;
      }
      if (!Once.said("bonus_markup", 24 * 3600e3)) log(`[BONUS DOM] ${el.outerHTML.replace(/\s+/g, " ").slice(0, 300)}`, "info");
      st.pending = now; this.save(st);
      const href = el.tagName === "A" ? (el.getAttribute("href") || "") : "";
      if (c.remote && !href) { st.pending = 0; this.save(st); return false; }
      log(`[BONUS] odbieram bonus online („${c.label}").`, "success");
      if (href && href !== "#" && !/^javascript:/i.test(href)) { Nav.go(c.remote ? href : (el.href || href), "bonus online (antymateria + punkty Akademii)"); return true; }
      Nav.click(el, "bonus online (antymateria + punkty Akademii)");
      return true;
    },
  };

  // ═══ EKSPEDYCJE (Odkrywca) ══════════════════════════════════════════════
  // Cel: pozycja 16 układu bazy. Id misji uczymy się RAZ z wiersza 16 dowolnej
  // strony galaktyki (fork ma własną numerację — nie zgadujemy).
  const ExpoLink = {
    get() { return Store.get("expo_link", null); },
    learn() {
      if (page() !== "galaxy" || this.get()) return;
      for (const item of document.querySelectorAll(".galaxy-item")) {
        const idx = item.querySelector(".planet-index");
        if (!idx || idx.textContent.trim() !== "16") continue;
        const a = item.querySelector("a[href*='/fleet']");
        if (!a) { log(`[EXPO] wiersz 16 bez linku /fleet — markup: ${item.innerHTML.replace(/\s+/g, " ").slice(0, 600)}`, "warn"); return; }
        const href = a.getAttribute("href");
        const mission = (href.match(/[?&]mission=(\d+)/) || [])[1] || null;
        Store.set("expo_link", { href, mission: mission ? parseInt(mission) : null, at: Date.now() });
        log(`[EXPO] link ekspedycji wyuczony: ${href} (mission=${mission ?? "?"})`, "success");
        return;
      }
    },
  };

  // CZYSTA funkcja: czy i czym wysłać falę. Wejście = sytuacja + config + czas
  // + stan serii. Wyjście: null albo { toKey, ships:[{type,qty}], duration, last }.
  // v3.38.0: rozmiar fali liczy DZIELNIK MALEJĄCY — `floor(ilość / ile fal zostało)`
  // z AKTUALNEGO hangaru. Do 3.37 liczby były ZAMRAŻANE na starcie serii (port z 2.x),
  // żeby kolejne fale nie dzieliły reszty i seria nie wygasała. Cena: powroty, które
  // lądują w trakcie serii, nie trafiały do fal 2..N-1 i CAŁA nadwyżka spadała na falę
  // domykającą (zgłoszenie 30.08 „wysłał trzecią flotę, a bardzo dużo zostało": hangar
  // urósł w środku serii z 41 711 do 197 408 szt., a fale słały porcję zamrożoną przy
  // 41 711). Dzielnik malejący daje fale równe TAK SAMO jak zamrażanie, gdy nic nie
  // wraca (600/3 = 200 = zamrożone 200), a gdy wraca — rozkłada to natychmiast.
  // Fala domykająca serię albo ostatni wolny slot nadal zabiera CAŁY hangar.
  function expoPlan(s, cfg, now, burst) {
    const e = cfg.expo || {};
    if (!e.enabled) return { skip: "wyłączone" };
    if ((s.threats || []).some(t => t.attack && t.arriveAt > now)) return { skip: "alarm — obrona ma pierwszeństwo" };
    if (flightsBlocking(s, now)) return { skip: "ratunek w powietrzu" };
    const homeKey = e.launchFrom ? key(e.launchFrom) : (s.active && s.active.key);
    if (!homeKey) return { skip: "nie wiem, skąd startować" };
    const pair = (s.pairs || {})[homeKey];
    if (!pair) return { skip: `[${homeKey}] nie ma na pasku planet` };
    const body = (s.hangars[`${homeKey}|moon`]?.total > 0 && pair.hasMoon) ? "moon" : "planet";
    const h = s.hangars[`${homeKey}|${body}`];
    if (!h || now - h.at > 15 * 60e3) return { skip: `hangar [${homeKey}] ${body} nieznany/stary — najpierw rekonesans` };
    // v3.10.2: odczyt slotów starszy niż 30 min to zgadywanie, nie wiedza.
    const slotsFresh = s.slots && now - (s.slots.at || 0) < 30 * 60e3;
    // v3.63.0 (log 02.09 14:42: „ekspedycje 8/8 — czekam na powroty", a pasek gry
    // „1 Missions: 1 Own" — 7 fal wylądowało 14:26–14:32, lecz odczyt slotów ze strony
    // floty z 14:19 obowiązywał do 14:49 i bot stał pół godziny z pełnym hangarem):
    // liczba slotów jest czytana TYLKO ze strony floty, a pasek misji jest GLOBALNY
    // i odświeżany co przebieg. Każda ekspedycja w locie to co najmniej jeden własny
    // lot na pasku, więc „N Own" jest GÓRNYM ograniczeniem zajętych slotów — starszy
    // odczyt slotów nie może twierdzić więcej niż pasek.
    const expoRaw = slotsFresh ? s.slots.expo : null, fleet = slotsFresh ? s.slots.fleet : null;
    const barFresh = s.bar && typeof s.bar.own === "number" && now - (s.bar.at || 0) < 5 * 60e3;
    const expo = (expoRaw && barFresh && s.bar.own < expoRaw.used) ? { ...expoRaw, used: s.bar.own, fromBar: true } : expoRaw;
    const cap = Math.max(1, Math.min(e.waves || 1, expo?.total || e.waves || 1));
    if (expo && expo.used >= cap) return { skip: `ekspedycje ${expo.used}/${expo.total} (limit fal ${cap}) — czekam na powroty` };
    if (burst && burst.lastSendAt && now - burst.lastSendAt < (burst.gapMs || e.gapMinSec * 1000)) return { skip: "odstęp między falami" };
    const excl = (e.excludeTypes || []).map(t => String(t).toUpperCase());
    const avail = (h.ships || []).filter(x => x.qty > 0 && !excl.includes(String(x.type).toUpperCase()));
    if (!avail.length) return { skip: "brak statków do wysłania (poza wykluczeniami)" };
    const waves = Math.max(1, e.waves || 1);
    const inSeries = (burst && burst.waves === waves && (burst.sent || 0) < waves) ? (burst.sent || 0) : 0;
    const left = Math.max(1, waves - inSeries);   // ile fal serii jeszcze zostało
    const lastOfBurst = waves === 1 || inSeries >= waves - 1 || (expo && expo.total && expo.used >= cap - 1);
    const share = (qty) => Math.floor(qty / left);
    // ── OSTATNIA fala serii zabiera CAŁY hangar ──
    // Udział fali to dzielenie w dół, więc po wszystkich falach w hangarze
    // zostaje reszta z zaokrąglenia plus produkcja z czasu serii. Fala
    // domykająca zabiera to wszystko, żeby flota nie stała w domu do powrotu.
    // v3.26.0 dopisała tu sufit 3× udziału (port SWEEP_CAP_X z 2.x, gdzie
    // chronił flotę bojową zaparkowaną po porannym FS). v3.28.0 GO ZDEJMUJE:
    // na Genesis nie ma FS ani floty parkowanej w domu — wszystko poza
    // `excludeTypes` jest flotą ekspedycyjną, a sufit zostawiał ją bezczynnie
    // w hangarze (log 29.08 13:26: ostatnia fala 4/4 wzięła 1236 pancerników
    // zamiast całej reszty). Statki, które mają zostać w domu, wpisuje się do
    // wykluczeń — to jedyny właściwy hamulec na tym uniwersum.
    const ships = avail.map(x => ({ type: x.type, qty: lastOfBurst ? x.qty : share(x.qty) })).filter(x => x.qty > 0);
    if (!ships.length) return { skip: `flota za mała na ${waves} fal (zostało ${left}) — zmniejsz liczbę fal` };
    // v3.7.1 (audyt): rezerwa slotów istnieje po to, żeby RATUNEK miał czym lecieć.
    // Na starcie uniwersum jest 1 slot floty, więc rezerwa 1 blokowałaby ekspedycje
    // na zawsze. Ale gdy fala zabiera CAŁY hangar, ratować nie ma już czego —
    // wtedy rezerwa jest bezprzedmiotowa i wolno zająć ostatni slot.
    const takesAll = avail.every(a => (ships.find(x => x.type === a.type)?.qty || 0) >= a.qty);
    // v3.29.0 (audyt E2): odkąd fala domykająca bierze CAŁY hangar, `takesAll` jest
    // prawdziwe niemal zawsze — a wtedy rezerwa slotów w panelu nie robiła NIC.
    // „Ratować nie ma czego" jest prawdą tylko wtedy, gdy poza tym ciałem nie stoi
    // nigdzie indziej żadna flota (na innych planetach stoją transportery i one
    // też potrzebują slotu, żeby uciec). Sprawdzamy to na znanych hangarach.
    const fleetElsewhere = Object.entries(s.hangars || {})
      .some(([kk, hh]) => kk !== `${homeKey}|${body}` && (hh?.total || 0) > 0 && now - (hh.at || 0) < 48 * 3600e3);
    if ((!takesAll || fleetElsewhere) && fleet && fleet.total && fleet.total - fleet.used <= (e.slotReserve || 0)) {
      return { skip: `wolne sloty floty ≤ rezerwa (${e.slotReserve}) — fala zostawiłaby flotę bez slotu na ucieczkę` };
    }
    const [g, sy] = homeKey.split(":");
    // v3.62.0 (log 02.09 08:55–09:04: od 2. fali każda „domyka serię", a log nie mówił
    // DLACZEGO): powód fali domykającej i odczyt slotów idą do wpisu lotu — następny
    // taki log rozstrzygnie, czy to sloty z gry, licznik serii czy konfiguracja.
    const lastWhy = waves === 1 ? "seria = 1 fala"
      : inSeries >= waves - 1 ? `ostatnia fala serii ${inSeries + 1}/${waves}`
      : lastOfBurst ? `ostatni wolny slot ekspedycji (${expo.used}/${expo.total}, limit fal ${cap})` : "";
    const slotsTxt = expo ? `sloty ekspedycji ${expo.used}/${expo.total}${expo.fromBar ? ` (odczyt ${expoRaw.used}/${expoRaw.total} przycięty do ${s.bar.own} własnych lotów z paska)` : ""}` : "sloty nieznane";
    return { toKey: `${g}:${sy}:16`, fromKey: homeKey, fromBody: body, ships, last: !!lastOfBurst, waves, lastWhy, slotsTxt,
      duration: { minutes: e.discoverer40 ? 40 : 0, hours: Math.max(1, e.holdingHours || 1) } };
  }

  const Expo = {
    burst() { return Store.get("burst", null); },
    // v3.48.0 (owner 31.08: „przed chwilą znowu przeskoczył"): fale ekspedycji MUSZĄ
    // przestawić aktywne ciało (formularz floty tego wymaga), ale po domknięciu serii
    // operator ma zastać kartę tam, gdzie ją zostawił. Wpis `eco_return` robi Fly przy
    // pierwszym przełączeniu; tu, gdy seria stoi (czekam na powroty / pusty hangar),
    // bot odprowadza kartę z powrotem — TYLKO jeśli operator od tamtej pory nie kliknął.
    maybeReturnOperator(reason) {
      const r = Store.get("eco_return", null); if (!r) return false;
      if (!/czekam na powroty|brak statków/.test(String(reason || ""))) return false;
      Store.del("eco_return");
      if (Date.now() - (r.at || 0) > 30 * 60e3) return false;
      if ((Store.get("input_at", 0) || 0) !== (r.input || 0)) return false;   // operator już sam klika — nie mieszamy
      let to = r.url;
      if (r.uuid && !/[?&]planet=/.test(to)) to += (to.includes("?") ? "&" : "?") + "planet=" + r.uuid;
      const here = location.pathname + location.search;
      if (here === to || here === r.url) return false;
      log(`[LOT] seria domknięta — wracam na stronę, na której byłeś (${r.url}).`, "info");
      Nav.go(to, "powrót na stronę operatora po serii ekspedycji");
      return true;
    },
    async tick(s) {
      ExpoLink.learn();
      if (Fly.mission() || !CFG.expo.enabled) return false;
      const why = Human.economyAllowed(s);
      if (why) { if (!Once.said("human|" + why.slice(0, 12), 10 * 60e3)) log(`[EXPO] wstrzymane: ${why}`, "info"); return false; }
      const now = Date.now();
      const b = this.burst();
      const p = expoPlan(s, CFG, now, b);
      if (p.skip) {
        // v3.25.0: „hangar nieznany/stary" to jedyny skip, który bot może usunąć SAM —
        // i robi to po cichu (fetch strony floty tej planety), bez przełączania Ci strony.
        if (/hangar .* nieznany\/stary/.test(p.skip) && !Once.said("expo_pull", 60e3)) {
          const hk = CFG.expo.launchFrom ? key(CFG.expo.launchFrom) : (s.active && s.active.key);
          const pr = hk ? (s.pairs || {})[hk] : null;
          const hb = (pr && pr.hasMoon && (s.hangars[`${hk}|moon`]?.total > 0)) ? "moon" : "planet";
          if (hk) {
            const got = await Hangar.scanRemote(hk, hb);
            if (got) { log(`[EXPO] dociągnąłem hangar [${hk}] ${hb} w tle (${got.total.toLocaleString("pl-PL")} szt.) — wysyłka w następnym przebiegu.`, "info"); return false; }
          }
        }
        this.maybeReturnOperator(p.skip);
        if (!Once.said("expo|" + p.skip, 10 * 60e3)) log(`[EXPO] ${p.skip}`, "info");
        return false;
      }
      // v3.49.0 (pytanie ownera 31.08: „czy zachowanie bota jest naturalne i admin nie
      // zwróci uwagi?"): serie NIE ruszają jak w zegarku. Między ZAKOŃCZONĄ serią
      // a następną losowa przerwa 5–20 min (`restMinMin`/`restMaxMin`), liczona od
      // chwili, gdy wysyłka znów jest MOŻLIWA (sloty wolne, plan bez skipów) — nie od
      // domknięcia serii, bo wtedy i tak nic nie może lecieć. Fale WEWNĄTRZ serii bez
      // zmian (60–90 s). Pierwsza seria po włączeniu ekspedycji bez przerwy (brak
      // wcześniejszego burst) — włącznik ma działać od ręki.
      {
        const rMax = CFG.expo.restMaxMin ?? 0;   // 0 = wyłączone (decyzja ownera 31.08)
        const inSeries = b && b.waves && (b.sent || 0) > 0 && (b.sent || 0) < (p.waves || 1);
        if (rMax > 0 && !inSeries && b && (b.sent || 0) > 0) {
          const r = Store.get("expo_rest", null);
          if (!r) {
            const until = now + jitter(Math.min(CFG.expo.restMinMin ?? 0, rMax), rMax) * 60e3;
            Store.set("expo_rest", { until });
            log(`[EXPO] przerwa między seriami ~${Math.max(1, Math.round((until - now) / 60000))} min — seria nie rusza jak w zegarku.`, "info");
            return false;
          }
          if (now < r.until) return false;
          Store.del("expo_rest");
        }
      }
      // v3.48.0: pierwsza akcja SERII (jeszcze przed nauką linku i przed misją) zapamiętuje,
      // gdzie jest operator — każda późniejsza nawigacja serii (galaktyka, przełączenie,
      // formularz, powrót na /) zabiera mu kartę, więc tu jest ostatni prawdziwy adres.
      if (!Store.get("eco_return", null)) {
        const act0 = PlanetBar.active();
        const ea0 = act0 && PlanetBar.anchor(act0.key, act0.body);
        const mu0 = ea0 && ((ea0.getAttribute("href") || "").match(/[?&]planet=([^&#"']+)/i));
        Store.set("eco_return", { url: location.pathname + location.search, uuid: mu0 ? mu0[1] : null, at: Date.now(), input: Store.get("input_at", 0) || 0 });
      }
      const link = ExpoLink.get();
      if (!link || !link.mission) {
        // v3.9.2 (E2E): bot czekał, aż operator sam wejdzie na galaktykę. Teraz idzie
        // tam RAZ (z dławikiem 10 min), odczytuje id misji z wiersza 16 i wraca do gry.
        if (page() === "galaxy") { ExpoLink.learn(); return false; }
        if (Once.said("expo|golearn", 10 * 60e3)) return false;
        const [g, sy] = String(p.fromKey || "").split(":");
        if (!g || !sy) return false;
        log("[EXPO] nie znam jeszcze id misji ekspedycji — zaglądam raz na galaktykę bazy.", "info");
        NavRate.note();
        Nav.go(`/galaxy?x=${g}&y=${sy}`, "ekspedycje: nauka id misji z galaktyki");
        return true;
      }
      if (Fly.blocked({ fromKey: p.fromKey, toKey: p.toKey })) {
        if (!Once.said(`expoblk|${p.fromKey}`, 5 * 60e3)) log(`[EXPO] trasa [${p.fromKey}]→[${p.toKey}] w karencji po nieudanym locie — czekam.`, "warn");
        return false;
      }
      const sent = (b && b.waves === p.waves && !p.last) ? (b.sent || 0) + 1 : (p.last ? 0 : 1);
      const total = p.ships.reduce((n, x) => n + x.qty, 0);
      // v3.10.2 (audyt regresji): licznik fali zapisywany PRZED Fly.start — odmowa
      // startu (trwa inna misja) i tak zjadala fale z serii. Najpierw start, potem licznik.
      const started = Fly.start({ kind: "expedition", fromKey: p.fromKey, fromBody: p.fromBody, toKey: p.toKey, toBody: "planet",
        why: `ekspedycja ${p.last ? `(domyka serię — cały hangar: ${p.lastWhy})` : `(fala ${sent}/${p.waves})`} — ${total.toLocaleString("pl-PL")} szt., ${p.slotsTxt}`, speed: 100, plan: p.ships,
        missionType: "EXPEDITION", takeResources: false, duration: p.duration, missionId: link.mission });
      if (!started) return false;
      // v3.38.0: `sizes` zniknęło — rozmiar fali liczy dzielnik malejący z bieżącego
      // hangaru, więc stanem serii jest sam licznik wysłanych fal.
      Store.set("burst", { waves: p.waves, sent: p.last ? 0 : sent, lastSendAt: now, gapMs: jitter(CFG.expo.gapMinSec, CFG.expo.gapMaxSec) * 1000 });
      return true;
    },
  };

  // ═══ MINING ASTEROID (specyfika tego forka: pozycja 17) ═════════════════
  // Zakresy poszukiwań przychodzą z /galaxy/Partial_AsteroidLocation (modal
  // „Find asteroids"), a sama asteroida żyje krótko (data-asteroid-disappear),
  // więc liczy się cykl: skanuj → znajdź → wyślij minery, zanim zniknie.
  // Parsery przeniesione z 2.x bez zmian logiki.
  const Aster = {
    RANGES_URL: "/galaxy/Partial_AsteroidLocation",
    st() { return Store.get("aster", { ranges: [], rangesAt: 0, idx: 0, sys: null, lastScanAt: 0, sentAt: 0, sentTo: null }) || {}; },
    save(v) { Store.set("aster", v); },
    parseRanges(html) {
      const coords = []; const re = /\[(\d+):(\d+):(\d+)\]/g; let m;
      while ((m = re.exec(html)) !== null) coords.push({ galaxy: +m[1], system: +m[2] });
      const out = [];
      for (let i = 0; i + 1 < coords.length; i += 2) {
        const a = coords[i], b = coords[i + 1];
        if (a.galaxy === b.galaxy) out.push({ galaxy: a.galaxy, startSystem: Math.min(a.system, b.system), endSystem: Math.max(a.system, b.system) });
      }
      return out.sort((x, y) => x.galaxy - y.galaxy || x.startSystem - y.startSystem);
    },
    async fetchRanges() {
      try {
        const r = await fetchT(this.RANGES_URL, { headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" }, credentials: "same-origin" });
        if (!r.ok) { log(`[ASTER] zakresy: HTTP ${r.status}`, "warn"); return null; }
        const html = await r.text();
        if (looksLoggedOut(r, html)) { Session.lost(); return null; }
        if (!/galaxy-asteroid-modal|asteroid-modal-desc|playerAste/i.test(html)) { log("[ASTER] odpowiedź to nie modal asteroid — pomijam.", "warn"); return null; }
        const ranges = this.parseRanges(html);
        log(ranges.length ? `[ASTER] zakresy: ${ranges.map(x => `[${x.galaxy}:${x.startSystem}-${x.endSystem}]`).join(", ")}` : "[ASTER] brak zakresów (zbadaj technologię / brak wyników).", "info");
        return ranges;
      } catch (e) { log(`[ASTER] zakresy: ${e.message}`, "warn"); return null; }
    },
    // Wiersz 17 aktualnej strony galaktyki → { fleetUrl, ttl } albo null.
    readRow17() {
      for (const item of document.querySelectorAll(".galaxy-item")) {
        const idx = item.querySelector(".planet-index");
        if (!idx || idx.textContent.trim() !== "17") continue;
        const ttlEl = item.querySelector("[data-asteroid-disappear]");
        const ttl = ttlEl ? (parseInt(ttlEl.getAttribute("data-asteroid-disappear") || "0", 10) || 0) : 0;
        const link = item.querySelector("a.btn-asteroid, a[href*='mission=12']");
        if (link) return { fleetUrl: link.getAttribute("href") || "", ttl };
        if (ttl > 0) { const um = location.href.match(/[?&]x=(\d+)[\s\S]*?[?&]y=(\d+)/); return um ? { fleetUrl: `/fleet?x=${um[1]}&y=${um[2]}&z=17&mission=12`, ttl } : null; }
        return null;   // wiersz jest, asteroidy nie ma („Find asteroids")
      }
      return null;
    },
    // Dziennik asteroid (2.x: /home/Partial_AsteroidJournal). Uczymy się, ILE
    // asteroida daje — rozmiar floty liczymy z percentyla próbek, nie ze średniej,
    // żeby te większe nie zostawały niedowiezione. Nieznany markup = zrzut, nie zgadywanie.
    JOURNAL_URL: "/home/Partial_AsteroidJournal",
    async learnYield(st, now) {
      if (CFG.aster.expectedRes) return st;                       // ustawione ręcznie
      if (now - (st.yieldsAt || 0) < 30 * 60e3) return st;
      try {
        const r = await fetchT(this.JOURNAL_URL, { headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" }, credentials: "same-origin" });
        if (!r.ok) return { ...st, yieldsAt: now };
        const html = await r.text();
        if (looksLoggedOut(r, html)) { Session.lost(); return st; }
        const rows = html.split(/<\/tr>|<\/li>|<\/div>\s*<div/i);
        const out = [];
        for (const row of rows) {
          const nums = (row.replace(/<[^>]+>/g, " ").match(/\d{1,3}(?:[ .,]\d{3})+|\d{4,}/g) || [])
            .map(x => parseInt(x.replace(/[^\d]/g, ""), 10)).filter(n => n >= 1000);
          if (nums.length) out.push(nums.reduce((a, b) => a + b, 0));
        }
        if (!out.length) {
          if (!Once.said("aster_journal_dom", 24 * 3600e3)) log(`[ASTER DOM] nie rozpoznaję dziennika asteroid — nie umiem oszacować urobku, więc lecą wszystkie minery. Markup: ${html.replace(/\s+/g, " ").slice(0, 1200)}`, "warn");
          return { ...st, yieldsAt: now };
        }
        const ys = out.slice(0, CFG.aster.sampleSize || 20);
        log(`[ASTER] dziennik: ${ys.length} raportów, mediana ${Math.round(ys.slice().sort((a, b) => a - b)[Math.floor(ys.length / 2)]).toLocaleString("pl-PL")} surowców.`, "info");
        return { ...st, yields: ys, yieldsAt: now };
      } catch (e) { return { ...st, yieldsAt: now }; }
    },
    expected(st) {
      if (CFG.aster.expectedRes) return CFG.aster.expectedRes;
      const ys = (st.yields || []).slice().sort((a, b) => a - b);
      if (!ys.length) return 0;
      const i = Math.min(ys.length - 1, Math.floor((ys.length - 1) * (CFG.aster.percentile || 85) / 100));
      return ys[i];
    },
    // Ile minerów wysłać: tyle, ile uniesie spodziewany urobek (+ zapas).
    // Brak danych (pojemność albo urobek) = zachowanie sprzed 3.15: leci całość.
    size(st, available) {
      const cargo = CFG.aster.cargoPerMiner || st.cargo || 0;
      const exp = this.expected(st);
      if (!cargo || !exp) return { qty: available, why: "brak danych o ładowni/urobku — lecą wszystkie" };
      const need = Math.ceil(exp * (CFG.aster.buffer || 1.15) / cargo);
      const qty = Math.max(CFG.aster.minMiners || 1, Math.min(available, need));
      return { qty, need, why: `urobek ~${exp.toLocaleString("pl-PL")} × zapas ${CFG.aster.buffer} ÷ ${cargo.toLocaleString("pl-PL")}/miner = ${need}` };
    },
    // Ile slotów floty wolno jeszcze zająć (0 = żadnego).
    freeSlots(s) {
      const f = s.slots && s.slots.fleet;
      if (!f || !f.total) return 1;                                // brak wiedzy: pozwól na jeden
      return Math.max(0, f.total - f.used - (CFG.aster.slotReserve || 0));
    },
    // Pojemność ładowni JEDNEGO minera — bez niej nie da się dobrać wielkości floty
    // pod urobek. Formularz pokazuje „Cargo space X / Y" tylko na jednym ze swoich
    // kroków, więc wołamy to na każdym: czego nie złapie krok 1, złapie krok 2 lub 3.
    learnCargo(m) {
      if (CFG.aster.cargoPerMiner) return;
      const st0 = Store.get("aster", {}) || {};
      if (st0.cargo) return;
      try {
        const t = (document.querySelector("#content, .content, form") || document.body).textContent || "";
        // „Cargo space 0 / 1.000.000" — pojemność jest po UKOŚNIKU; pierwsza liczba to
        // ile już załadowano (zwykle 0), więc czytanie jej dawało cap=0 i cichy powrót.
        const cm = t.match(/cargo\s*space[^\d]{0,20}[\d .,]*\/\s*([\d .,]+)/i)
          || t.match(/ładown[^\d]{0,20}[\d .,]*\/\s*([\d .,]+)/i)
          || t.match(/cargo\s*space[^\d]{0,20}([\d .,]+)/i)
          || t.match(/ładown[^\d]{0,20}([\d .,]+)/i);
        const qty = (m.plan || []).reduce((a, x) => a + (x.qty || 0), 0);
        if (!cm) { if (!Once.said("aster_cargo_dom", 24 * 3600e3)) log("[ASTER DOM] nie widzę pojemności ładowni na formularzu — bez tego lecą wszystkie minery. Tekst: " + t.replace(/\s+/g, " ").slice(-400), "warn"); return; }
        const cap = parseInt(String(cm[1]).replace(/[^\d]/g, ""), 10);
        if (!Number.isFinite(cap) || cap <= 0 || qty <= 0) return;
        const per = Math.floor(cap / qty);
        if (per <= 0) return;
        st0.cargo = per; Store.set("aster", st0);
        log("[ASTER] nauczone: 1 miner uniesie " + per.toLocaleString("pl-PL") + " surowców (" + cap.toLocaleString("pl-PL") + " na " + qty + " szt.).", "success");
      } catch {}
    },
    // 2.x: DispatchedAsteroids. Bez tego przy lotach RÓWNOLEGŁYCH druga fala potrafi
    // polecieć na tę samą asteroidę, którą właśnie zabiera pierwsza — a fork wystawia
    // asteroidy w tych samych koordach co kilkanaście minut, więc trafienie jest częste.
    locked(st, key) { const l = (st.locks || {})[key] || 0; return l > Date.now(); },
    lock(st, key) { const l = { ...(st.locks || {}) }; for (const k of Object.keys(l)) if (l[k] < Date.now()) delete l[k]; l[key] = Date.now() + (CFG.aster.lockMin || 60) * 60e3; return { ...st, locks: l }; },
    // 2.x pomijało zakresy, do których lot trwa dłużej niż maxFlightMinutes. Wzór
    // z Atheny (max(11, 11 + Δ/15) minut) jest tylko ZGRUBNY — na Genesis czas lotu
    // i tak czytamy z formularza — ale wystarczy, żeby nie skanować drugiego końca
    // galaktyki i nie palić na to nawigacji.
    tooFar(homeKey, target) {
      const cap = CFG.aster.maxFlightMin || 0;
      if (!cap || !homeKey) return false;
      const [hg, hs] = homeKey.split(":").map(Number);
      if (hg !== target.galaxy) return true;
      const est = Math.max(11, Math.ceil(11 + Math.abs(hs - target.system) / 15));
      return est > cap;
    },
    nextSystem(st) {
      const rs = st.ranges || []; if (!rs.length) return null;
      const r = rs[(st.idx || 0) % rs.length];
      const sys = (st.sys && st.sys >= r.startSystem && st.sys <= r.endSystem) ? st.sys : r.startSystem;
      return { galaxy: r.galaxy, system: sys, range: r };
    },
    advance(st) {
      const rs = st.ranges || []; if (!rs.length) return st;
      const r = rs[(st.idx || 0) % rs.length];
      const nx = (st.sys || r.startSystem) + 1;
      if (nx > r.endSystem) return { ...st, idx: ((st.idx || 0) + 1) % rs.length, sys: null };
      return { ...st, sys: nx };
    },
    async tick(s) {
      if (!CFG.aster.enabled || Fly.mission()) return false;
      const why = Human.economyAllowed(s);
      if (why) { if (!Once.said("aster|" + why.slice(0, 12), 10 * 60e3)) log(`[ASTER] wstrzymane: ${why}`, "info"); return false; }
      if ((s.threats || []).some(t => t.attack && t.arriveAt > Date.now())) return false;
      let st = this.st();
      const now = Date.now();
      // v3.15.0: było sztywne 5 minut przerwy po każdej wysyłce — czyli jeden lot
      // minerów na 5 min, gdy gra wystawia 3–6 asteroid na godzinę. Teraz liczy się
      // to, co naprawdę ogranicza: wolne sloty floty i krótki odstęp między startami.
      if (st.sentAt && now - st.sentAt < (CFG.aster.parallel ? (CFG.aster.gapSec ?? 20) : 300) * 1000) return false;
      if (now - (st.lastScanAt || 0) < (CFG.aster.scanGapSec ?? 6) * 1000) return false;   // ?? nie ||: 0 znaczy „bez odstępu"
      // minery muszą być w hangarze bazy
      const homeKey = CFG.aster.launchFrom ? key(CFG.aster.launchFrom) : (s.active && s.active.key);
      const hm = homeKey ? (s.hangars[`${homeKey}|moon`] || s.hangars[`${homeKey}|planet`]) : null;
      const miners = hm ? (hm.ships || []).find(x => String(x.type).toUpperCase() === "ASTEROID_MINER") : null;
      if (!miners || miners.qty <= 0) { if (!Once.said("aster|nominers", 15 * 60e3)) log("[ASTER] brak minerów w hangarze bazy (albo są w locie) — nie skanuję.", "info"); return false; }
      if (this.freeSlots(s) <= 0) { if (!Once.said("aster|slots", 10 * 60e3)) log(`[ASTER] wszystkie sloty floty zajęte (rezerwa ${CFG.aster.slotReserve}) — czekam na powroty.`, "info"); return false; }
      st = await this.learnYield(st, now);
      const plan = this.size(st, miners.qty);
      // Lot mniejszy niż połowa docelowego niewiele zbierze (urobek limituje ładownia
      // CAŁEJ floty), więc resztka czeka na powroty zamiast lecieć na pół gwizdka.
      if (plan.need && CFG.aster.partialRatio && miners.qty < plan.need * CFG.aster.partialRatio) {
        if (!Once.said("aster|partial", 10 * 60e3)) log(`[ASTER] w hangarze ${miners.qty} minerów, a sensowny lot to ${plan.need} — czekam na powroty (próg ${Math.round(CFG.aster.partialRatio * 100)}%).`, "info");
        return false;
      }
      if (!(st.ranges || []).length || now - (st.rangesAt || 0) > 30 * 60e3) {
        const r = await this.fetchRanges();
        if (!r) return false;
        st = { ...st, ranges: r, rangesAt: now, idx: 0, sys: null };
        this.save(st);
        if (!r.length) return false;
      }
      // jesteśmy na stronie galaktyki skanowanego układu? sprawdź wiersz 17
      // pauza po pełnym obiegu bez łupu (2.x: scanIntervalMin) — inaczej bot kręci
      // galaktyką bez końca co kilka sekund
      if (st.idleUntil && now < st.idleUntil) return false;
      let target = this.nextSystem(st);
      if (!target) return false;
      // pomiń układy za daleko i te, na które już leci flota
      let skipped = 0;
      while (target && (this.tooFar(homeKey, target) || this.locked(st, `${target.galaxy}:${target.system}`))) {
        st = this.advance(st);
        skipped++;
        if (skipped > 60) {   // pełny obieg bez kandydata: odpocznij zamiast kręcić
          st.idleUntil = now + (CFG.aster.idleScanMin || 15) * 60e3;
          this.save(st);
          if (!Once.said("aster|idle", 30 * 60e3)) log(`[ASTER] cały obieg zakresów odpada (za daleko albo flota już tam leci) — pauza ${CFG.aster.idleScanMin} min.`, "info");
          return false;
        }
        target = this.nextSystem(st);
      }
      if (!target) return false;
      if (skipped) this.save(st);
      const onThat = page() === "galaxy" && new RegExp(`[?&]x=${target.galaxy}(?:&|$)`).test(location.search) && new RegExp(`[?&]y=${target.system}(?:&|$)`).test(location.search);
      if (onThat) {
        const hit = this.readRow17();
        st = { ...this.advance(st), lastScanAt: now };
        if (hit && hit.fleetUrl) {
          const min = Math.max(60, CFG.aster.minTtlSec || 300);
          if (hit.ttl && hit.ttl < min) { log(`[ASTER] [${target.galaxy}:${target.system}:17] znika za ${hit.ttl}s — za mało czasu, skanuję dalej.`, "info"); this.save(st); return false; }
          log(`[ASTER] ZNALEZIONA asteroida [${target.galaxy}:${target.system}:17] (TTL ${hit.ttl || "?"}s) — wysyłam ${plan.qty.toLocaleString("pl-PL")} z ${miners.qty.toLocaleString("pl-PL")} minerów (${plan.why}).`, "success");
          this.save(this.lock({ ...st, sentAt: now, sentTo: `${target.galaxy}:${target.system}:17` }, `${target.galaxy}:${target.system}`));
          const astKey = `${target.galaxy}:${target.system}:17`;
          if (Fly.blocked({ fromKey: homeKey, toKey: astKey })) { if (!Once.said(`astblk|${astKey}`, 5 * 60e3)) log(`[ASTER] trasa [${homeKey}]→[${astKey}] w karencji po nieudanym locie — czekam.`, "warn"); return false; }
          return Fly.start({ kind: "asteroid", fromKey: homeKey, fromBody: (s.hangars[`${homeKey}|moon`]?.total > 0 ? "moon" : "planet"),
            toKey: `${target.galaxy}:${target.system}:17`, toBody: "planet", why: `mining asteroidy [${target.galaxy}:${target.system}:17]`,
            speed: 100, plan: [{ type: "ASTEROID_MINER", qty: plan.qty }], missionType: "ASTEROID", takeResources: false, missionId: 12, directUrl: hit.fleetUrl,
            ttl: hit.ttl || 0, ttlAt: now });
        }
        this.save(st);
        return false;
      }
      this.save({ ...st, lastScanAt: now });
      NavRate.note();
      Nav.go(`/galaxy?x=${target.galaxy}&y=${target.system}`, `mining: skan układu [${target.galaxy}:${target.system}]`);
      return true;
    },
  };

  // ═══ ZŁOM (recyklery) ═══════════════════════════════════════════════════
  // Ekspedycje zostawiają złom na poz. 16, a bitwa obronna — przy samej bazie.
  // Recyklery świadomie NIE latają na ekspedycje, żeby zawsze było czym zbierać.
  const Debris = {
    findLink(baseKey) {
      const pos = parseInt((baseKey || "").split(":")[2] || "0") || 0;
      const wanted = [16, pos].filter(Boolean);
      for (const item of document.querySelectorAll(".galaxy-item")) {
        const idx = parseInt(item.querySelector(".planet-index")?.textContent || "0") || 0;
        if (!wanted.includes(idx)) continue;
        const cell = item.querySelector(".col-debris, .galaxy-col.col-debris");
        if (!cell) continue;
        // v3.59.0 (pierwszy bojowy zbiór 01.09 22:32, „Invalid mission type"):
        // na Genesis komórka złomu NIE ma linku wprost — cały dymek (nagłówek
        // „Debris field", ilości surowców i link Recycle z NUMEREM MISJI) siedzi
        // w atrybucie data-tooltip-content. Misję na tym forku ustawia parametr
        // URL-a (ekspedycje: mission=1 z linku galaktyki) — konstruowany adres
        // bez numeru misji gra odrzuciła. Czytamy więc link i ROZMIAR złomu z dymka.
        // v3.61.0 (noc 01/02.09, ~15 pustych lotów, raporty 0/0): komórka DF
        // pokazuje też IKONĘ własnej floty lecącej na tę pozycję
        // (fleetActionIcon, zrzut 04:37) — „niepusta komórka" NIE znaczy „złom
        // jest". Dowodem złomu jest wyłącznie dymek „Debris field" albo link.
        let amount = 0, tipHref = null, sawTip = false;
        for (const te of cell.querySelectorAll("[data-tooltip-content]")) {
          const raw = te.getAttribute("data-tooltip-content") || "";
          if (!/debris/i.test(raw)) continue;
          sawTip = true;
          try {
            const tdoc = new DOMParser().parseFromString(raw, "text/html");
            const ta2 = tdoc.querySelector("a[href*='/fleet']");
            if (ta2 && !tipHref) tipHref = ta2.getAttribute("href");
            // v3.60.0 (pełny zrzut dymka 22:53): surowce w dymku mają IKONKI
            // zamiast etykiet (słowo „metal" siedzi tylko w ścieżce obrazka) —
            // textContent to sam nagłówek i liczby, przy czym sąsiednie liczby
            // SKLEJAJĄ się bez spacji. Wzorzec grupowany d.ddd.ddd tnie je
            // poprawnie („…708.2501.646…" = 708.250 | 1.646…), a małych liczb
            // z CSS nie łapie (wymaga separatora tysięcy).
            const txt = (tdoc.body && tdoc.body.textContent) || "";
            for (const mm of txt.matchAll(/\d{1,3}(?:[.,]\d{3})+/g)) amount += parseInt(String(mm[0]).replace(/[^\d]/g, ""), 10) || 0;
            if (!ta2 && !Once.said("debris_tip", 6 * 3600e3)) log(`[ZŁOM] dymek pola złomu bez linku zbierania — pełna treść: ${raw.replace(/\s+/g, " ").slice(0, 1500)}`, "warn");
          } catch {}
        }
        const a = cell.querySelector("a[href*='/fleet']");
        if (a) return { href: a.getAttribute("href"), pos: idx, amount };
        if (tipHref) return { href: tipHref, pos: idx, amount, viaTip: true };
        const rel = cell.querySelector("[rel^='debris']")?.getAttribute("rel");
        const tip = rel ? document.getElementById(rel) : null;
        const ta = tip?.querySelector("a[href*='/fleet']");
        if (ta) return { href: ta.getAttribute("href"), pos: idx, amount };
        // Bez dymka „Debris field" i bez linku = w komórce jest coś innego
        // (ikona własnej floty) — na tej pozycji ZŁOMU NIE MA.
        if (!sawTip) continue;
        if (!Once.said("debris_dom", 6 * 3600e3)) log(`[ZŁOM] pole złomu bez linku (poz. ${idx}) — markup: ${(cell.innerHTML || "").replace(/\s+/g, " ").slice(0, 500)}`, "info");
        const [g, sy] = (baseKey || "").split(":");
        return { href: `/fleet?x=${g}&y=${sy}&z=${idx}`, pos: idx, noLink: true, amount, viaTip: true };
      }
      return null;
    },
    async tick(s) {
      if (!CFG.debris.enabled || Fly.mission()) return false;
      if (Human.economyAllowed(s)) return false;
      if ((s.threats || []).some(t => t.attack && t.arriveAt > Date.now())) return false;
      const now = Date.now();
      // v3.61.0 (noc 01/02.09: ~15 wysyłek, raporty 0/0): zbieracze lecą 30 min,
      // a kontrola chodzi co 20 — bot dosyłał kolejne floty, zanim pierwsza
      // dotarła. Gdy zbieracze są W DRODZE (rejestr powrotów zna termin dolotu),
      // nie ma po co ani latać, ani odwiedzać galaktyki.
      if ((s.expected || []).some(e => e.kind === "debris" && now < (e.sentAt || 0) + (e.flightMs || 0) + 60e3)) return false;
      // v3.56.0 (parytet z Atheną, HomeBase.expo): PZ po piratach ląduje na
      // poz. 16 układu STARTU ekspedycji, nie aktywnej pary — przy przypiętym
      // „startuj z" [1:217:6] bot zaglądał do układu aktywnego ciała i złom
      // leżał. Recyklery też mieszkają przy flocie ekspedycyjnej (2.x v2.84.0).
      const homeKey = (CFG.expo && CFG.expo.launchFrom) ? key(CFG.expo.launchFrom) : (s.active && s.active.key); if (!homeKey) return false;
      const hm = s.hangars[`${homeKey}|moon`] || s.hangars[`${homeKey}|planet`];
      const rec = hm ? (hm.ships || []).find(x => String(x.type).toUpperCase() === "RECYCLER") : null;
      if (!rec || rec.qty <= 0) return false;
      const [g, sy] = homeKey.split(":");
      const onGal = page() === "galaxy" && new RegExp(`[?&]x=${g}(?:&|$)`).test(location.search) && new RegExp(`[?&]y=${sy}(?:&|$)`).test(location.search);
      // v3.57.0 (owner 01.09: „za często sprawdza PZ — raz na 20 minut wystarczy"):
      // stempel „ponów za 60 s" kazał botowi wracać na galaktykę CO MINUTĘ, gdy
      // operator klikał po grze i zabierał stronę zanim odczyt się dokonał
      // (log 20:23–20:26: trzy nawigacje w 2,5 min). Teraz pełny okres stemplowany
      // PRZY nawigacji; świeży znacznik debris_go pozwala dokończyć odczyt po
      // przeładowaniu, a wizyta przepadła (operator zabrał kartę) NIE jest
      // ponawiana — następna dopiero za everyMin.
      const last = Store.get("debris_at", 0) || 0;
      const goAt = Store.get("debris_go", 0) || 0;
      const arrived = onGal && now - goAt < 3 * 60e3;
      if (!arrived && now - last < (CFG.debris.everyMin || 20) * 60e3) return false;
      if (!onGal) { Store.set("debris_at", now); Store.set("debris_go", now); NavRate.note(); Nav.go(`/galaxy?x=${g}&y=${sy}`, "złom: sprawdzam pole szczątków"); return true; }
      Store.set("debris_at", now); Store.set("debris_go", 0);
      const hit = this.findLink(homeKey);
      if (!hit) return false;
      if (Fly.blocked({ fromKey: homeKey, toKey: `${g}:${sy}:${hit.pos}` })) { if (!Once.said(`debblk|${hit.pos}`, 5 * 60e3)) log(`[ZŁOM] trasa [${homeKey}]→[${g}:${sy}:${hit.pos}] w karencji po nieudanym locie — czekam.`, "warn"); return false; }
      // v3.59.0 (owner 01.09: bot chciał wysłać WSZYSTKIE 1,63 mln recyklerów na
      // 30-minutowy lot — moon zostałby bez statków do wywiezienia surowców przy
      // ataku, a paliwo kosztowałoby 35 mln deuteru): wysyłamy tyle, ile udźwignie
      // złom (+10% marginesu), reszta pilnuje domu. Ładowność 125 000/recykler
      // POTWIERDZONA na żywo (zrzut 22:34: 203 820 375 000 / 1 630 563). Rozmiar
      // złomu nieznany (dymek bez liczb) = 20% hangaru, nigdy całość.
      // v3.61.0: dymek JEST, ale nie zdradza ilości (albo pokazuje zera —
      // pole właśnie zebrane) → nie wysyłamy w ciemno; unknownShare zostaje
      // tylko dla ścieżek bez dymka (link wprost / rel, styl Atheny).
      if (hit.viaTip && !(hit.amount > 0)) {
        if (!Once.said(`debempty|${hit.pos}`, 30 * 60e3)) log(`[ZŁOM] poz. ${hit.pos}: dymek pola bez ilości surowców (pole puste albo nieczytelne) — nie wysyłam w ciemno.`, "info");
        return false;
      }
      const cargo = CFG.debris.cargoPerRecycler || 125_000;
      const qty = hit.amount > 0
        ? Math.min(rec.qty, Math.max(1, Math.ceil(hit.amount * 1.1 / cargo)))
        : Math.max(1, Math.floor(rec.qty * (CFG.debris.unknownShare ?? 0.2)));
      log(`[ZŁOM] pole złomu na poz. ${hit.pos}${hit.amount ? ` (~${hit.amount.toLocaleString("pl-PL")} surowców)` : " (rozmiar nieznany)"} — wysyłam ${qty.toLocaleString("pl-PL")} z ${rec.qty.toLocaleString("pl-PL")} recyklerów.`, "success");
      return Fly.start({ kind: "debris", fromKey: homeKey, fromBody: (s.hangars[`${homeKey}|moon`]?.total > 0 ? "moon" : "planet"),
        toKey: `${g}:${sy}:${hit.pos}`, toBody: "debris", why: `zbieranie złomu [${g}:${sy}:${hit.pos}]`, speed: 100,
        plan: [{ type: "RECYCLER", qty }], missionType: "COLLECT", takeResources: false, directUrl: hit.href });
    },
  };

  // ═══ Fly — jeden wykonawca lotu ════════════════════════════════════════
  // Misja w Store "mission": { kind:"fly", fromKey, fromBody, toKey, toBody, speed, step, startedAt, air, recallAt, why }
  const Fly = {
    MISSIONS: ["DEPLOY", "DEPLOYMENT", "STATION", "STATIONING"],
    mission() { return Store.get("mission", null); },
    url(m) { if (m.directUrl) return m.directUrl; const [g, sy, po] = m.toKey.split(":"); return `/fleet?x=${g}&y=${sy}&z=${po}${m.missionId ? "&mission=" + m.missionId : ""}`; },
    start(a) {
      if (this.mission()) return false;
      Store.set("mission", { ...a, step: "switch", startedAt: Date.now() });
      if (a.kind !== "expedition" && a.kind !== "asteroid" && a.kind !== "debris") Journal.add("RATUNEK", `Start lotu: [${a.fromKey}] ${a.fromBody} → [${a.toKey}] ${a.toBody} (${a.why})`);
      log(`[LOT] ${a.why}: [${a.fromKey}] ${a.fromBody} → [${a.toKey}] ${a.toBody}, ${a.speed}%`, "warn");
      return true;
    },
    abort(why, opts = {}) {
      const m = this.mission(); Store.del("mission");
      if (!m) return;
      // v3.10.2: przerwana misja nie moze zostawiac wpisu `pending` w stanie obrony.
      try { const sA = Situation.load(); const n0 = (sA.flights || []).length; sA.flights = (sA.flights || []).filter(f => !(f.fromKey === m.fromKey && f.pending)); if ((sA.flights || []).length !== n0) Situation.save(sA); } catch {}
      if (opts.quiet) { log(`[LOT] przerwany: ${why}`, "warn"); const blq = Store.get("fly_block", {}) || {}; blq[`${m.fromKey}>${m.toKey}`] = Date.now() + 3 * 60e3; Store.set("fly_block", blq); return; }
      log(`[LOT] przerwany: ${why}`, "error");
      Journal.add("BŁĄD", `Lot [${m.fromKey}]→[${m.toKey}] przerwany: ${why}`);
      // v3.9.0 (audyt): bez karencji decide() wystawiał tę samą akcję w następnym
      // ticku i całość leciała w kółko co 5 min. Ta trasa odpoczywa 3 min.
      const bl = Store.get("fly_block", {}) || {};
      bl[`${m.fromKey}>${m.toKey}`] = Date.now() + 3 * 60e3;
      Store.set("fly_block", bl);
    },
    // Zawrót ma sens tylko dla lotu, który JESZCZE LECI w terminie zawrotu.
    recallOf(mm) {
      const r = mm.recallAt || 0;
      if (!r || !mm.flightMs) return r;
      return (Date.now() + mm.flightMs < r) ? 0 : r;     // doleci wcześniej = wyląduje
    },
    // v3.62.0: JEDNO miejsce domykające wysyłkę — wołane po kliku (gdy strona jeszcze
    // stoi) ALBO po przeładowaniu z adresem fleetSendSuccessfully (na tym forku to
    // ścieżka normalna). Idempotentne: confirmPendingSend() mógł już zdjąć `pending`
    // z wpisów, więc niczego nie dopisujemy drugi raz; skład floty przychodzi ze
    // stempla `last_send`, bo po przeładowaniu formularza już nie ma.
    confirmed(m, info = {}) {
      const eco = ["expedition", "asteroid", "debris"].includes(m.kind);
      const s = Situation.load();
      // TYLKO loty obronne trafiają do `flights` (v3.2.0): ekspedycja tam wpisana
      // znaczyłaby dla decide() „ta para jest już w locie" i zablokowałaby ratunek.
      if (!eco) {
        const f0 = (s.flights || []).find(f => f.fromKey === m.fromKey && f.pending);
        // czas lotu bywa znany dopiero TERAZ (v3.10.3) — razem z nim przeliczamy termin zawrotu
        if (f0) { delete f0.pending; if (m.flightMs) { f0.flightMs = m.flightMs; f0.recallAt = this.recallOf({ ...m, flightMs: m.flightMs }); } }
        else if (!(s.flights || []).some(f => f.fromKey === m.fromKey && (f.sentAt || 0) >= (m.startedAt || 0))) {
          s.flights = [...(s.flights || []), { kind: m.air ? "air" : (m.home ? "home" : "swap"), fs: !!m.fs, fromKey: m.fromKey, fromBody: m.fromBody, toKey: m.toKey, toBody: m.toBody, sentAt: Date.now(), flightMs: m.flightMs || 0, recallAt: this.recallOf(m), phase: "launched", tries: 0 }];
        }
      }
      // rejestr powrotów (v3.52.0): wpis przestaje być `pending`, powrót raz do logu
      {
        const e0 = (s.expected || []).find(e => e.pending && e.fromKey === m.fromKey)
          || (s.expected || []).filter(e => e.fromKey === m.fromKey && (e.sentAt || 0) >= (m.startedAt || 0)).pop();
        if (e0) {
          delete e0.pending;
          if (!Once.said(`powrot|${e0.fromKey}|${e0.sentAt}`, 3600e3)) log(`[POWRÓT] zapamiętany: ${(e0.total || 0).toLocaleString("pl-PL")} szt. (${e0.kind}) wróci na [${e0.fromKey}] ${e0.fromBody === "moon" ? "księżyc" : "planetę"} ~${new Date(e0.returnAt).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}.`, "info");
        }
      }
      Situation.save(s);
      if (!eco) emptySourceHangar(m.fromKey, m.fromBody, "wysyłka potwierdzona");
      // v3.41.0: ewakuacja (swap/air) zostawia stempel — dzięki niemu wolno potem odstawić
      // flotę na księżyc, nawet gdy rutynowe zwożenie jest wyłączone.
      if (!m.home && !eco) { try { const sR = Situation.load(); sR.rescues = sR.rescues || {}; sR.rescues[m.fromKey] = Date.now(); Situation.save(sR); } catch {} }
      Store.del("mission");
      const what = info.loaded || "(skład nieznany)";
      const types = info.loaded ? info.loaded.split(", ").length : 0;
      if (m.kind === "expedition") log(`[EXPO] fala wysłana: ${what} → [${m.toKey}]`, "success");
      else if (m.kind === "debris") log(`[ZŁOM] recyklery wysłane: ${what} → [${m.toKey}]`, "success");
      else if (m.kind === "asteroid") log(`[ASTER] minery wysłane: ${what} → [${m.toKey}]`, "success");
      else Journal.add(m.home ? "POWRÓT" : "RATUNEK", `WYSŁANO: [${m.fromKey}] ${m.fromBody} → [${m.toKey}] ${m.toBody} (${types} typów statków)${m.air ? `, zawrót ~${new Date(m.recallAt).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}` : ""}`);
    },
    // v3.10.2 (audyt E2E): 3-minutowa karencja po nieudanej próbie lotu była dłuższa
    // niż typowy dolot ataku, a decide() deterministycznie wystawia tę samą trasę —
    // czyli po jednym potknięciu bot stał bezczynnie do uderzenia. Lot RATUNKOWY
    // ponawiamy po 45 s; karencja 3 min zostaje dla lotów rutynowych i ekonomii.
    blocked(a) {
      const bl = Store.get("fly_block", {}) || {};
      const until = bl[`${a.fromKey}>${a.toKey}`] || 0;
      if (!until) return false;
      if (a.air || a.rescue) return until - 2 * 60e3 - 15e3 > Date.now();
      return until > Date.now();
    },
    // v3.12.0 (incydent 28.08 22:17–22:22): misja krążyła „przełącz ciało → otwórz
    // formularz → znowu nie ta planeta" przez pełne 5 minut, robiąc ~30 przeładowań
    // strony, po czym umarła na limicie czasu. Limit czasu jest ZA PÓŹNY: liczy się
    // liczba nawigacji, bo każda z nich to przeładowanie gry. Sufit przerywa pętlę
    // po 6 krokach — normalny lot potrzebuje 2–3.
    NAV_MAX: 6,
    bumpNav(m) { m.navs = (m.navs || 0) + 1; Store.set("mission", m); },
    async tick() {
      const m = this.mission(); if (!m) return;
      // v3.17.1: misja sprzed dłuższej przerwy (wyłączony bot, aktualizacja skryptu)
      // to nie jest NIEUDANA próba — to śmieć po poprzedniej sesji. Karencja 3 min
      // na tę trasę kosztowała wtedy operatora kolejne minuty czekania na ekspedycję
      // (29.08 09:22: „przerwany: 5 min bez potwierdzenia" → „trasa w karencji").
      if (Date.now() - m.startedAt > 15 * 60e3) { Store.del("mission"); log(`[LOT] porzucona misja sprzed ${Math.round((Date.now() - m.startedAt) / 60000)} min (bot był wyłączony) — sprzątam bez karencji.`, "warn"); return; }
      if (Date.now() - m.startedAt > 5 * 60e3) return this.abort("5 min bez potwierdzenia wysyłki");
      if ((m.navs || 0) >= this.NAV_MAX) return this.abort(`${this.NAV_MAX} nawigacji bez otwarcia formularza — pętla przełączania ciał (krok „${m.step}", cel ${this.url(m)})`);
      try {
        if (m.step === "switch") {
          const a = PlanetBar.active();
          if (a && a.key === m.fromKey && a.body === m.fromBody) { m.step = "form"; this.bumpNav(m); Nav.go(this.url(m), `lot: formularz [${m.fromKey}]→[${m.toKey}]`); return; }
          const el = PlanetBar.anchor(m.fromKey, m.fromBody);
          if (!el) return this.abort(`brak [${m.fromKey}] ${m.fromBody} na pasku planet`);
          // v3.48.0 (owner 31.08: „przed chwilą znowu przeskoczył"): zanim EKONOMIA
          // zabierze operatorowi aktywne ciało pod formularz floty, zapamiętujemy,
          // GDZIE był — po domknięciu serii Expo.maybeReturnOperator() odprowadzi go
          // z powrotem, o ile w międzyczasie sam nie kliknął. Ratunek tego nie robi.
          if (["expedition", "asteroid", "debris"].includes(m.kind) && !Store.get("eco_return", null)) {
            // Sam adres strony może nie nieść planety (menu gry daje np. /building/resource
            // bez ?planet=) — bierzemy też UUID aktywnego ciała, żeby powrót przywrócił
            // nie tylko stronę, ale i planetę operatora.
            const act0 = PlanetBar.active();
            const ea0 = act0 && PlanetBar.anchor(act0.key, act0.body);
            const mu0 = ea0 && ((ea0.getAttribute("href") || "").match(/[?&]planet=([^&#"']+)/i));
            Store.set("eco_return", { url: location.pathname + location.search, uuid: mu0 ? mu0[1] : null, at: Date.now(), input: Store.get("input_at", 0) || 0 });
          }
          log(`[LOT] przełączam na ${m.fromBody} [${m.fromKey}]`, "info"); m.step = "switch_wait"; this.bumpNav(m); Nav.click(el, `lot: przełączenie na ${m.fromBody} [${m.fromKey}]`); return;
        }
        if (m.step === "switch_wait") { const a = PlanetBar.active(); if (a && a.key === m.fromKey && a.body === m.fromBody) { m.step = "form"; this.bumpNav(m); Nav.go(this.url(m), `lot: formularz [${m.fromKey}]→[${m.toKey}]`); } return; }
        if (m.step === "form") {
          // v3.9.0 (audyt): jeśli klik "Send fleet" przeładował stronę, misja zostaje
          // w Store — bez tej bramki bot wysłałby DRUGĄ identyczną falę.
          // v3.22.0 (audyt 29.08, potwierdzone logiem 09:27:03 "juz poszla 81s temu"):
          // bramka anty-duplikat powstala dla RATUNKU (jeden lot na pare), a fale
          // ekspedycji leca z tego samego ciala na ten sam cel co 60-90 s — wiec kasowala
          // fale 2..N po cichu. 2.x wypinalo z niej ekspedycje wprost. Dla ekonomii
          // zostaje waskie okno 20 s: chroni przed podwojnym klikiem po przeladowaniu,
          // ale nie zjada serii.
          // v3.62.0 (log 02.09, każda wysyłka: „już poszła 2s temu — nie powtarzam"):
          // na tym forku „Send fleet" ZAWSZE przeładowuje stronę, zanim wykona się kod
          // po kliku — więc bramka czasowa poniżej była ścieżką normalną, a nie awaryjną,
          // i wszystko, co miało się stać po wysyłce (log „fala wysłana", stempel
          // ewakuacji, rejestr powrotów), po prostu nie działo się nigdy. Do tego okno
          // 20 s dla ekspedycji: wolniejsze ładowanie strony sukcesu = ta sama fala
          // wypełniona i wysłana DRUGI raz. Potwierdzenie ma iść z DOWODU: adres
          // fleetSendSuccessfully + stempel wysyłki TEJ misji (nie starszy niż jej start).
          {
            const lsOk = Store.get("last_send", null);
            if (lsOk && lsOk.toKey === m.toKey && lsOk.from === m.fromKey && lsOk.kind === m.kind && (lsOk.at || 0) >= (m.startedAt || 0) && location.href.includes("fleetSendSuccessfully")) {
              log(`[LOT] gra potwierdziła wysyłkę [${m.fromKey}]→[${m.toKey}] (adres fleetSendSuccessfully) — „Send fleet" przeładował stronę, zanim bot zdążył to zapisać.`, "info");
              this.confirmed(m, { loaded: lsOk.loaded || "" });
              return;
            }
          }
          const ECO_KINDS = ["expedition", "asteroid", "debris"];
          // v3.61.0 (podwójna wysyłka złomu 05:19+05:20): okno 20 s jest dla FAL
          // ekspedycji (ta sama trasa co 60–90 s); złom nigdy nie powtarza trasy
          // w minutach — dostaje pełne 3 minuty jak loty obronne.
          const guardMs = m.kind === "debris" ? 3 * 60e3 : ECO_KINDS.includes(m.kind) ? 20e3 : 3 * 60e3;
          const ls = Store.get("last_send", null);
          if (ls && Date.now() - ls.at < guardMs && ls.toKey === m.toKey && ls.from === m.fromKey) {
            log(`[LOT] wysyłka do [${m.toKey}] już poszła ${Math.round((Date.now() - ls.at) / 1000)}s temu — nie powtarzam.`, "warn");
            // v3.39.0: skoro wiemy, że wysyłka poszła, zdejmujemy `pending` z wpisu lotu.
            // Kod robiący to po kliku nie wykonał się, bo „Send fleet" przeładował stronę.
            try {
              const sD = Situation.load();
              const fD = (sD.flights || []).find(x => x.fromKey === m.fromKey && x.pending);
              if (fD) { delete fD.pending; if (m.flightMs) fD.flightMs = m.flightMs; Situation.save(sD); log(`[LOT] wpis lotu [${fD.fromKey}]→[${fD.toKey}] potwierdzony (wysyłka już poszła).`, "success"); }
            } catch {}
            // v3.39.2: samo skasowanie misji NIE wystarczy — decide() wystawi tę samą
            // trasę w następnym przebiegu, bramka znów ją zetnie i tak w kółko, po jednej
            // nawigacji na obrót (sztorm 09:59). Trasa idzie w karencję na resztę okna
            // bramki: egzekutor mówi wtedy „w karencji — czekam" i NIE nawiguje.
            // TYLKO dla lotów obronnych: fale ekspedycji lecą tą samą trasą co 60–90 s,
            // więc karencja zjadłaby serię (złapane przez E2E „fala 2 też wyszła").
            if (!ECO_KINDS.includes(m.kind)) {
              emptySourceHangar(m.fromKey, m.fromBody, "bramka anty-duplikat");
              try { const blG = Store.get("fly_block", {}) || {}; blG[`${m.fromKey}>${m.toKey}`] = ls.at + guardMs; Store.set("fly_block", blG); } catch {}
            }
            Store.del("mission"); return;
          }
          if (page() !== "fleet") { navGuard(m, this); return; }
          Store.set("form_nav", null);
          if (this._busy) return; this._busy = true;
          try { await this.form(m); } finally { this._busy = false; }
        }
      } catch (e) { this.abort(`błąd: ${e.message}`); }
    },
    // v3.17.0 (incydent 29.08 08:38 i 08:42): formularz był wypełniony, zielony
    // „Next" widoczny na ekranie, a bot go NIE ZNAJDOWAŁ i po 25 s przerywał lot —
    // bo szukał wyłącznie wewnątrz #content, a na tym forku przycisk stoi w stopce
    // formularza, poza tym kontenerem. Teraz szukamy w trzech podejściach, od
    // najostrożniejszego: dokładny tekst w #content → dokładny tekst gdziekolwiek
    // (poza panelem i paskiem planet) → krótki przycisk ZAWIERAJĄCY tekst.
    findButton(text) {
      const want = String(text).trim().toLowerCase();
      const alt = { next: ["next", "dalej", "weiter", "continue"], "send fleet": ["send fleet", "wyślij flotę", "wyslij flote", "send"] }[want] || [want];
      const ok = (el) => el.offsetParent !== null && !el.closest("#ogx3-panel") && !el.closest(".planet-select, .moon-select, .sidebar, nav");
      const label = (el) => String(el.value || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const area = document.querySelector("#content, .content, main, #fleet, .fleet-content, .fleet-form") || document.body;
      const sel = "a, button, input[type='submit'], input[type='button'], [role='button']";
      const inArea = [...area.querySelectorAll(sel)].filter(ok);
      const anywhere = [...document.querySelectorAll(sel)].filter(ok);
      const exact = (list) => list.find(el => alt.includes(label(el)));
      const loose = (list) => list.find(el => { const l = label(el); return l.length <= 24 && alt.some(a => l.includes(a)); });
      return exact(inArea) || exact(anywhere) || loose(inArea) || loose(anywhere) || null;
    },
    isDisabled(el) { return !el || el.disabled || el.classList.contains("disabled") || el.getAttribute("aria-disabled") === "true"; },
    async clickWhenEnabled(text, maxMs = 25000) {
      const t0 = Date.now();
      // Rozróżnienie z 2.x (v2.66.3): „przycisk był, ale WYŁĄCZONY" to zupełnie inna
      // usterka niż „przycisku nie ma" — pierwsze znaczy, że gra nie przyjmuje floty
      // (np. brak deuteru), drugie, że nie trafiamy w markup.
      let seen = null, saidWait = false;
      while (Date.now() - t0 < maxMs) {
        const b = this.findButton(text);
        if (b) seen = b;
        if (b && !this.isDisabled(b)) {
          if (saidWait) log(`[LOT] przycisk „${text}" ożył po ${((Date.now() - t0) / 1000).toFixed(1)}s — klikam.`, "info");
          b.click();
          log(`[LOT] klik „${text}" (<${b.tagName.toLowerCase()}${b.id ? " id=" + b.id : ""}>)`, "info");
          return true;
        }
        if (b && !saidWait) { saidWait = true; log(`[LOT] przycisk „${text}" jest wyłączony — czekam, zamiast klikać w martwy element.`, "info"); }
        await sleep(400);
      }
      // Bez listy KANDYDATÓW ten błąd był nie do rozwiązania z logu: wiadomo było
      // tylko, że „nie ma przycisku", a nie jak ten przycisk wygląda w markupie.
      const cands = [...document.querySelectorAll("a, button, input[type='submit'], input[type='button'], [role='button']")]
        .filter(el => el.offsetParent !== null && !el.closest("#ogx3-panel"))
        .map(el => `<${el.tagName.toLowerCase()}${el.id ? " id=" + el.id : ""}${el.className ? " class=\"" + String(el.className).slice(0, 40) + "\"" : ""}${el.disabled ? " DISABLED" : ""}>${String(el.value || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30)}`)
        .slice(0, 25).join(" | ");
      const txt = (document.querySelector("#content, .content, form") || document.body).textContent.replace(/\s+/g, " ").trim();
      log(seen
        ? `[LOT] przycisk „${text}" BYŁ na stronie, ale przez ${maxMs / 1000}s pozostał WYŁĄCZONY — gra nie przyjmuje tej floty. KANDYDACI: ${cands}`
        : `[LOT] przycisku „${text}" NIE MA na stronie (${maxMs / 1000}s). KANDYDACI: ${cands}`, "error");
      log(`[LOT] tekst formularza: …${txt.slice(-300)}`, "error");
      return false;
    },
    async form(m) {
      const a = PlanetBar.active();
      if (!a || a.key !== m.fromKey || a.body !== m.fromBody) { m.step = "switch"; Store.set("mission", m); return; }
      if (m.navs) { m.navs = 0; Store.set("mission", m); }   // formularz stoi na WŁAŚCIWEJ planecie = realny postęp
      await sleep(jitter(1200, 2200));
      // krok 1: statki — wszystko (ratunek) albo plan (ekspedycja)
      const els = [...document.querySelectorAll("[data-ship-type]")];
      const snap = Hangar.scan();
      if (!snap || snap.total === 0) { log(`[LOT] hangar ${m.fromBody} [${m.fromKey}] pusty — nic do wysłania.`, "warn"); Store.del("mission"); return; }
      const loaded = [];
      let loadedTotal = 0;   // v3.52.0: rejestr powrotów chce wiedzieć, ILE statków wraca
      const want = m.plan ? new Map(m.plan.map(p => [String(p.type).toUpperCase(), p.qty])) : null;
      for (const el of els) {
        const type = String(el.dataset.shipType || "").toUpperCase();
        const have = parseInt(el.dataset.shipQuantity || "0") || 0; if (!have) continue;
        const qty = want ? Math.min(want.get(type) || 0, have) : have;
        if (qty <= 0) continue;
        const item = el.closest(".ship-item") || el.parentElement;
        const input = item?.querySelector("input.numberFormatInput, input[type='text'], input[type='number']");
        if (!input) continue; setInput(input, qty); loadedTotal += qty; loaded.push(`${el.dataset.shipType}×${qty.toLocaleString("pl-PL")}`);
        if (want) await sleep(jitter(120, 380));   // człowiek wypełnia pola po kolei, nie w jednej milisekundzie
      }
      // v3.9.0 (audyt, incydent 2.x 05.08 23:22): formularz przelicza się po każdym
      // input/change i potrafi WYZEROWAĆ pole wpisane chwilę wcześniej — log mówił
      // "załadowane 1,38 mld", a statki zostały w domu. Czytamy pola z powrotem.
      if (loaded.length) {
        for (let round = 0; round < 2; round++) {
          let fixed = 0;
          for (const el of els) {
            const type = String(el.dataset.shipType || "").toUpperCase();
            const have = parseInt(el.dataset.shipQuantity || "0") || 0; if (!have) continue;
            const qty = want ? Math.min(want.get(type) || 0, have) : have;
            if (qty <= 0) continue;
            const item = el.closest(".ship-item") || el.parentElement;
            const input = item?.querySelector("input.numberFormatInput, input[type='text'], input[type='number']");
            if (!input) continue;
            const cur = parseInt(String(input.value || "0").replace(/[^0-9]/g, "")) || 0;
            if (cur !== qty) { setInput(input, qty); fixed++; }
          }
          if (!fixed) break;
          log(`[LOT] formularz zgubił ${fixed} pól statków — wpisuję ponownie (runda ${round + 1}/2).`, "warn");
          await sleep(jitter(300, 600));
        }
      }
      if (!loaded.length) {
        // v3.38.0 (log 30.08, 05:06 i 06:51): plan fali powstaje na odczycie hangaru
        // sprzed nawigacji. Gdy do formularza zostaną WYŁĄCZNIE statki spoza planu
        // (recyklery, minery, kolonizatory), żadne pole się nie wypełni — ale to nie
        // jest nieznany markup, tylko nieaktualny plan. Do 3.37 leciał z tego ERROR,
        // wpis „BŁĄD" w dzienniku i push „⚠️ Obrona: BŁĄD" na telefon o piątej rano.
        const stale = !!want && els.length > 0 && !els.some(el =>
          (parseInt(el.dataset.shipQuantity || "0") || 0) > 0 &&
          (want.get(String(el.dataset.shipType || "").toUpperCase()) || 0) > 0);
        if (stale) {
          log(`[LOT] plan nieaktualny — w hangarze ${m.fromBody} [${m.fromKey}] zostały tylko statki spoza planu (${els.map(e => `${e.dataset.shipType}(${e.dataset.shipQuantity})`).join(", ")}). Odpuszczam falę.`, "warn");
          return this.abort("plan nieaktualny — w hangarze tylko statki spoza planu", { quiet: true });
        }
        log(`[LOT DOM] nie znalazłem pól statków. Statki: ${els.map(e => `${e.dataset.shipType}(${e.dataset.shipQuantity})`).join(", ")} | HTML: ${(document.querySelector("#content, .content") || document.body).innerHTML.replace(/\s+/g, " ").slice(0, 1500)}`, "error");
        return this.abort("brak pól statków");
      }
      log(`[LOT] załadowano: ${loaded.join(", ")}`, "info");
      await sleep(jitter(400, 800));
      if (m.missionType === "ASTEROID") Aster.learnCargo(m);
      if (!(await this.clickWhenEnabled("Next"))) return this.abort("Next (krok 1) martwy");
      // krok 2: cel (koordy, ciało), prędkość
      const t0 = Date.now(); while (Date.now() - t0 < 8000 && !document.getElementById("fleet2_target_x")) await sleep(400);
      const [g, sy, po] = m.toKey.split(":");
      const fx = document.getElementById("fleet2_target_x"), fy = document.getElementById("fleet2_target_y"), fz = document.getElementById("fleet2_target_z");
      if (fx && fy && fz && `${fx.value}:${fy.value}:${fz.value}` !== m.toKey) { setInput(fx, g); setInput(fy, sy); setInput(fz, po); log(`[LOT] koordy celu ustawione na [${m.toKey}]`, "info"); await sleep(600); }
      const inSidebar = (el) => !!el.closest(".planet-select, .moon-select, .sidebar, nav, #ogx3-panel");
      const wantType = m.toBody === "moon" ? "2" : m.toBody === "debris" ? "3" : "1";
      const btn = [...document.querySelectorAll(`[data-planet-type="${wantType}"]`)].filter(el => !inSidebar(el))[0];
      if (btn) { btn.click(); log(`[LOT] cel: ${m.toBody === "moon" ? "KSIĘŻYC" : m.toBody === "debris" ? "ZŁOM" : "PLANETA"}`, "info"); await sleep(jitter(500, 900)); }
      else { log(`[LOT DOM] brak przełącznika ciała (data-planet-type=${wantType}); panel celu: ${(document.getElementById("target_planet_type_container") || document.body).innerHTML.replace(/\s+/g, " ").slice(0, 1200)}`, "warn"); }
      if (m.speed && m.speed !== 100) {
        let ok = false; const txt = (e) => (e.textContent || "").trim();
        for (const h of [...document.querySelectorAll("a, span, button, div, td, li")].filter(e => txt(e) === "100" && e.offsetParent !== null && !e.closest("#ogx3-panel"))) {
          const kids = [...(h.parentElement?.children || [])]; const texts = kids.map(txt);
          if (!(texts.includes("10") && texts.includes("50"))) continue;
          const t = kids.find(k => txt(k) === String(m.speed)); if (t) { t.click(); ok = true; } break;
        }
        // v3.9.0 (audyt): powolny lot to CAŁY sens ucieczki i FS — przy 100% flota
        // dolatuje i ląduje zamiast wisieć. Nieustawiona prędkość to nie drobiazg.
        log(`[LOT] prędkość ${m.speed}%: ${ok ? "ustawiona" : "NIE USTAWIONA — lecę z domyślną, lot będzie krótki"}`, ok ? "info" : "error");
        if (!ok && !Once.said("speed_fail", 30 * 60e3)) { Journal.add("BŁĄD", `Nie znalazłem suwaka prędkości — lot [${m.fromKey}]→[${m.toKey}] leci z domyślną prędkością (krótko). Sprawdź zrzut w logu.`); log(`[LOT DOM] okolica suwaka prędkości: ${(document.querySelector("#target_planet_type_container")?.closest("form") || document.querySelector("#content, .content") || document.body).innerHTML.replace(/\s+/g, " ").slice(0, 2000)}`, "error"); }
        await sleep(jitter(700, 1100));
      }
      const ft = document.body.textContent.match(/Duration\s*of\s*flight[^0-9]{0,40}?(\d{1,3}):(\d{2})(?::(\d{2}))?/i);
      if (ft) {
        m.flightMs = ft[3] !== undefined ? (+ft[1] * 3600 + +ft[2] * 60 + +ft[3]) * 1000 : (+ft[1] * 60 + +ft[2]) * 1000;
        log(`[LOT] czas lotu ${Math.round(m.flightMs / 1000)} s`, "info");
        // v3.10.2: zawrót ma sens tylko wtedy, gdy flota JESZCZE LECI. Lot krótszy niż
        // termin zawrotu wyląduje na kolonii docelowej — wtedy nie udajemy, że wisi
        // w powietrzu: kasujemy zawrót, a wpis domknie hangar CELU (flota widziana).
        if (m.kind === "asteroid" && m.ttl) {
          const left = (m.ttl * 1000) - (Date.now() - (m.ttlAt || Date.now()));
          if (left < m.flightMs * 1.1) {
            log(`[ASTER] asteroida znika za ${Math.round(left / 1000)} s, a lot trwa ${Math.round(m.flightMs / 1000)} s — NIE wysyłam minerów, skanuję dalej.`, "warn");
            return this.abort("asteroida zniknie przed dolotem", { quiet: true });
          }
        }
        if (m.recallAt && Date.now() + m.flightMs < m.recallAt) {
          log(`[LOT] lot trwa ${Math.round(m.flightMs / 1000)} s i doleci przed terminem zawrotu — flota WYLĄDUJE na [${m.toKey}] ${m.toBody}; zawrotu nie planuję.`, "warn");
          m.landing = true; m.recallAt = 0;
          Store.set("mission", m);
        }
      }
      if (m.missionType === "ASTEROID") Aster.learnCargo(m);
      if (!(await this.clickWhenEnabled("Next"))) return this.abort("Next (krok 2) martwy");
      // krok 3: misja Deploy, surowce − rezerwa
      const t1 = Date.now(); while (Date.now() - t1 < 8000 && !this.findButton("Send fleet")) await sleep(400);
      const missions = [...document.querySelectorAll(".mission-item, [class*='mission-item']")];
      const nameOf = (el) => `${el.className || ""} ${el.textContent || ""}`.toUpperCase();
      // v3.60.0 (drugi odrzucony zbiór 22:53, zrzut kafla ownera): na tym forku
      // „Collect" (data-mission-type=13) to zbieranie surowców z WŁASNEJ planety
      // („only possible for planets/moons of your own empire") — do złomu służy
      // osobny kafel „Recycle". COLLECT był pierwszy na liście i bot dusił złą
      // misję → „Invalid mission type". Klik w kafel DZIAŁA (klasa `selected`
      // w zrzucie), więc wystarczy właściwa kolejność: RECYCL, nigdy COLLECT.
      const wanted = m.missionType === "EXPEDITION" ? ["EXPEDITION", "EKSPEDYCJ"] : m.missionType === "ASTEROID" ? ["ASTEROID_MINING", "ASTEROID"] : m.missionType === "COLLECT" ? ["RECYCL", "HARVEST"] : this.MISSIONS;
      let picked = null; for (const w of wanted) { picked = missions.find(x => nameOf(x).includes(w)); if (picked) break; }
      if (!picked) { log(`[LOT DOM] brak misji ${wanted[0]}. Dostępne: ${missions.map(x => `${(x.textContent || "").trim().slice(0, 20)}[${x.className}]`).join(", ") || "NONE"}`, "error"); return this.abort(`brak misji ${wanted[0]}`); }
      // v3.59.0 (incydent 22:32 „Invalid mission type" — owner: „chyba zabrakło
      // naduszenia w button Recycle"): klik w kontener misji mógł nie trafić
      // w element z handlerem. Duszenie idzie w najbardziej klikalny element
      // (kotwica/przycisk w środku albo nad kontenerem), z logiem CO kliknięto;
      // przy złomie raz zrzucamy markup kafla misji na wypadek kolejnej odmowy.
      const pickTarget = picked.matches("a, button") ? picked : (picked.querySelector("a, button, img") || picked.closest("a, button") || picked);
      pickTarget.click();
      log(`[LOT] misja: „${(picked.textContent || "").trim().slice(0, 24)}" (${picked.className}${pickTarget !== picked ? `, klik w <${pickTarget.tagName.toLowerCase()}>` : ""})`, "info");
      if (m.kind === "debris" && !Once.said("collect_dom", 6 * 3600e3)) log(`[ZŁOM DOM] kafel misji: ${(picked.outerHTML || "").replace(/\s+/g, " ").slice(0, 600)}`, "info");
      await sleep(jitter(400, 800));
      // czas trwania ekspedycji: Odkrywca = „40 min"; gdy tej opcji nie ma — godziny
      if (m.duration) {
        const sel = [...document.querySelectorAll("select")].find(x => [...x.options].some(o => /min|hour|godz|\bh\b/i.test(o.textContent || "")));
        const opts = sel ? [...sel.options] : [...document.querySelectorAll("[class*='duration'] a, [class*='duration'] li, [id*='duration'] option")];
        const txt = (o) => (o.textContent || "").replace(/\s+/g, " ").trim();
        let hit = null, minutesHit = false;
        if (m.duration.minutes > 0) {
          hit = opts.find(o => { const t = txt(o); const mm = t.match(/^(\d+)\s*min/i); if (mm && +mm[1] === m.duration.minutes) return true; const hh = t.match(/^(\d+[.,]\d+)\s*(h|hour|godz)/i); if (hh && hh[1].replace(",", ".").startsWith(String((m.duration.minutes / 60).toFixed(2)).slice(0, 3))) return true; return String(o.value ?? "") === String(m.duration.minutes) && /min/i.test(t); }) || null;
          minutesHit = !!hit;
        }
        if (!hit) hit = opts.find(o => { const t = txt(o); return !/min/i.test(t) && (t.match(/^(\d+)\b/) || [])[1] === String(m.duration.hours); }) || null;
        if (m.duration.minutes > 0 && !minutesHit && !Once.said("disc40", 15 * 60e3)) log(`[ODKRYWCA] brak opcji „${m.duration.minutes} min" (dostępne: ${opts.map(txt).join(", ") || "brak"}) — klasa to nie Odkrywca? Wysyłam na ${m.duration.hours} h.`, "warn");
        if (hit) { if (sel) { sel.value = hit.value; sel.dispatchEvent(new Event("change", { bubbles: true })); } else hit.click(); log(`[EXPO] czas trwania: ${txt(hit)}`, "info"); await sleep(jitter(400, 700)); }
        else if (!Once.said("dur_dom", 15 * 60e3)) log(`[EXPO DOM] nie znalazłem wyboru czasu trwania: ${(document.querySelector("#content, .content") || document.body).innerHTML.replace(/\s+/g, " ").slice(0, 1500)}`, "warn");
        // v3.52.0: rejestr powrotów potrzebuje czasu postoju FAKTYCZNIE ustawionego
        // w formularzu (40 min tylko wtedy, gdy opcja Odkrywcy naprawdę kliknięta).
        m.holdMs = hit ? (minutesHit ? m.duration.minutes * 60e3 : m.duration.hours * 3600e3) : (m.duration.hours || 1) * 3600e3;
      }
      if (m.takeResources !== false) {
        const allRes = document.querySelector("a.btn-all-res, .btn-all-res");
        if (allRes) allRes.click(); else [...document.querySelectorAll("a.btn-res-full, .btn-res-full")].forEach(b => b.click());
        await sleep(jitter(400, 700));
        await this.applyReserve();
      }
      const send = this.findButton("Send fleet") || [...document.querySelectorAll("a, button, input[type='submit']")].find(el => /send fleet/i.test(el.value || el.textContent || "") && el.offsetParent !== null);
      if (!send) return this.abort("brak przycisku Send fleet");
      const shipsBefore = snap.total;
      // v3.9.0 (audyt): "Send fleet" potrafi nawigować NATYCHMIAST — kod po kliku
      // może nigdy się nie wykonać. Lot obronny zapisujemy PRZED klikiem (inaczej
      // flota ucieka bez zaplanowanego zawrotu i zostaje na refugium na stałe),
      // a stempel wysyłki blokuje powtórzenie tej samej fali po przeładowaniu.
      // v3.52.0 (owner 31.08: „bot ma mapować każdą wysłaną flotę i wiedzieć, kiedy
      // wraca"): REJESTR POWROTÓW — loty ekonomii zapisujemy OSOBNO od `flights`
      // (lekcja v3.2.0: ekspedycja w `flights` zaślepia obronę pary). Powrót liczymy
      // z czasu lotu ODCZYTANEGO z formularza (lot tam + postój + lot z powrotem),
      // nie ze wzoru; bez odczytu czasu lotu wpisu nie ma. Zapis PRZED klikiem
      // (Send potrafi nawigować natychmiast), potwierdzenie po — jak `flights`.
      if ((m.kind === "expedition" || m.kind === "asteroid" || m.kind === "debris") && m.flightMs) {
        const sE = Situation.load();
        sE.expected = [...(sE.expected || []), { kind: m.kind, fromKey: m.fromKey, fromBody: m.fromBody, total: loadedTotal, sentAt: Date.now(), flightMs: m.flightMs, holdMs: m.holdMs || 0, returnAt: Date.now() + 2 * m.flightMs + (m.holdMs || 0), pending: true }].slice(-40);
        Situation.save(sE);
      }
      if (m.kind !== "expedition" && m.kind !== "asteroid" && m.kind !== "debris") {
        const sPre = Situation.load();
        sPre.flights = (sPre.flights || []).filter(f => f.fromKey !== m.fromKey);
        sPre.flights.push({ kind: m.air ? "air" : (m.home ? "home" : "swap"), fs: !!m.fs, fromKey: m.fromKey, fromBody: m.fromBody, toKey: m.toKey, toBody: m.toBody, sentAt: Date.now(), flightMs: m.flightMs || 0, recallAt: this.recallOf(m), phase: "launched", tries: 0, pending: true });
        Situation.save(sPre);
      }
      // v3.62.0: skład floty w stemplu — po przeładowaniu to jedyne źródło dla logu „fala wysłana"
      Store.set("last_send", { at: Date.now(), toKey: m.toKey, kind: m.kind, from: m.fromKey, loaded: loaded.join(", "), total: loadedTotal });
      if (m.missionType === "ASTEROID") Aster.learnCargo(m);
      // v3.62.0: klik przez Nav.click — przeładowanie po „Send fleet" ma w linii startowej
      // powód „bot: wysyłka", a nie „otwarte ręcznie" (i nie udaje klikania operatora).
      log("[LOT] Send fleet kliknięty.", "success");
      Nav.click(send, `wysyłka floty [${m.fromKey}]→[${m.toKey}] (Send fleet)`);
      // potwierdzenie: URL fleetSendSuccessfully albo hangar pusty
      await sleep(jitter(3000, 4500));
      const okUrl = location.href.includes("fleetSendSuccessfully");
      const after = page() === "fleet" ? Hangar.scan() : null;
      const ok = okUrl || (after && after.total < shipsBefore * 0.05);
      if (!ok) {
        const err = document.querySelector(".error, .alert, .modal.show, [class*='error']");
        log(`[LOT] wysyłka NIE potwierdzona (${err ? (err.textContent || "").trim().slice(0, 160) : "brak komunikatu"})`, "error");
        // v3.10.2: sprzatanie wpisu `pending` bylo NIEOSIAGALNE (stalo za tym returnem).
        const sBad = Situation.load();
        sBad.flights = (sBad.flights || []).filter(f => !(f.fromKey === m.fromKey && f.pending));
        sBad.expected = (sBad.expected || []).filter(e => !(e.fromKey === m.fromKey && e.pending));   // v3.52.0: rejestr powrotów też
        Situation.save(sBad);
        return this.abort("brak potwierdzenia wysyłki");
      }
      // v3.62.0: całe domknięcie wysyłki w jednym miejscu (wspólne z drogą po przeładowaniu)
      this.confirmed(m, { loaded: loaded.join(", ") });
      // v3.48.0: po fali DOMYKAJĄCEJ serię nie będzie kolejnej przez ~40 min — zamiast
      // zostawiać operatora na stronie głównej, bot odprowadza kartę tam, gdzie był
      // (o ile od startu serii sam nie kliknął).
      if (okUrl && /domyka serię/.test(m.why || "") && Expo.maybeReturnOperator("czekam na powroty")) return;
      if (okUrl) Nav.go("/", "po wysyłce floty — powrót na stronę główną");
    },
    async applyReserve() {
      const reserve = Number(CFG.deutReserve) || 0; if (!reserve) return;
      try {
        const fulls = [...document.querySelectorAll("a.btn-res-full, .btn-res-full")]; if (fulls.length < 3) return;
        const rowOf = (f) => { let r = f.parentElement; while (r && r.parentElement && r.parentElement.querySelectorAll("a.btn-res-full, .btn-res-full").length === 1) r = r.parentElement; return r || f.parentElement; };
        const full = fulls.find(f => /deut/i.test((rowOf(f)?.textContent || "") + " " + (rowOf(f)?.querySelector("input")?.name || ""))) || fulls[2];
        const input = rowOf(full)?.querySelector("input[name*='deut' i]") || rowOf(full)?.querySelector("input"); if (!input) return;
        const cur = parseInt((input.value || "0").replace(/[^\d]/g, "")) || 0;
        setInput(input, Math.max(0, cur - reserve));
        log(`[LOT] rezerwa deuteru: zostawiam ${Math.min(cur, reserve).toLocaleString("pl-PL")}, zabieram ${Math.max(0, cur - reserve).toLocaleString("pl-PL")}`, "info");
        await sleep(300);
      } catch (e) { log(`[LOT] rezerwa: ${e.message}`, "warn"); }
    },
    // Zawrót: przycisk a.x_btn_fleet_return w liście ruchów (aktywna para = źródło lotu).
    async recall(f0) {
      // v3.9.0 (audyt): `f` przychodziło z decide() (referencja do obiektu z INNEGO
      // odczytu), a zapisywaliśmy świeżo załadowany stan — mutacje phase/tries nigdy
      // nie trafiały na dysk. Efekt: zawrót klikany w kółko, lot nigdy nie domknięty.
      // Pracujemy na obiekcie z ZAPISYWANEGO stanu.
      const s = Situation.load();
      let f = (s.flights || []).find(x => x.fromKey === f0.fromKey && x.toKey === f0.toKey && (x.sentAt === f0.sentAt || !f0.sentAt));
      // v3.10.2: fallback `|| f0` przywracal dokladnie ten blad, ktory naprawialismy —
      // mutacje na obiekcie spoza `s`, ktore nigdy nie trafialy na dysk. Jesli lotu nie
      // ma w stanie, DOPISUJEMY go, zeby zapis mial co utrwalic.
      if (!f) { f = { ...f0 }; s.flights = [...(s.flights || []), f]; }
      const a = PlanetBar.active();
      if (!a || a.key !== f.fromKey) {
        const el = PlanetBar.anchor(f.fromKey, f.fromBody);
        if (el) { log(`[ZAWRÓT] przełączam na [${f.fromKey}] ${f.fromBody}`, "info"); el.click(); return; }
        // v3.10.2 (audyt E2E): bez kotwicy na pasku funkcja wracała CICHO i bez
        // licznika — bot próbował w nieskończoność, operator nie wiedział o niczym.
        f.tries = (f.tries || 0) + 1;
        if (f.tries >= 5) { f.phase = "recall_failed"; Journal.add("BŁĄD", `Nie mogę przełączyć się na [${f.fromKey}] — zawróć flotę ręcznie.`); }
        Situation.save(s);
        log(`[ZAWRÓT] brak [${f.fromKey}] ${f.fromBody} na pasku planet (${f.tries}/5)`, "warn");
        return;
      }
      let html = ""; try { const r = await fetchT(Rows.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } }); if (r.ok) html = await r.text(); } catch {}
      const doc = new DOMParser().parseFromString(html, "text/html");
      const trs = [...doc.querySelectorAll("tr[class*='row-mission-type-']")];
      const ours = trs.filter(tr => /DEPLOY|STATION/i.test(tr.className) && (tr.textContent || "").includes(`[${f.toKey}]`) && (tr.textContent || "").includes(`[${f.fromKey}]`));
      const back = ours.find(tr => /return/i.test(tr.className));
      if (back) { f.phase = "recalled"; f.recalledAt = f.recalledAt || Date.now(); Situation.save(s); log(`[ZAWRÓT] ✅ lot [${f.fromKey}]→[${f.toKey}] już WRACA.`, "success"); Journal.add("POWRÓT", `Zawrót potwierdzony: flota wraca na [${f.fromKey}].`); return; }
      const row = ours.find(tr => !/return/i.test(tr.className));
      if (!row) { f.tries = (f.tries || 0) + 1; f.recalledAt = Date.now(); if (f.tries >= 5) { f.phase = "recall_failed"; Journal.add("BŁĄD", `Nie widzę lotu [${f.fromKey}]→[${f.toKey}] na liście — zawróć ręcznie.`); } Situation.save(s); log(`[ZAWRÓT] brak wiersza lotu (${f.tries}/5). Wiersze: ${trs.map(tr => tr.className.replace(/\s+/g, " ") + " :: " + (tr.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100)).join(" || ").slice(0, 1200)}`, "warn"); return; }
      const id = row.getAttribute("data-fleet-id") || "";
      let live = id ? document.querySelector(`a.x_btn_fleet_return[data-fleet-id="${id}"]`) : document.querySelector("a.x_btn_fleet_return");
      if (!live) { for (const t of [...document.querySelectorAll("a, button, div, span")].filter(e => e.offsetParent !== null && !e.closest("#ogx3-panel") && /fleet\s*movements|^events$|\d+\s*Missions?/i.test((e.textContent || "").trim()))) { t.click(); for (let i = 0; i < 8 && !live; i++) { await sleep(500); live = id ? document.querySelector(`a.x_btn_fleet_return[data-fleet-id="${id}"]`) : document.querySelector("a.x_btn_fleet_return"); } if (live) break; } }
      if (!live) { if (page() !== "fleet") { Nav.go("/fleet", `zawrót lotu [${f.fromKey}]→[${f.toKey}]`); return; } f.tries = (f.tries || 0) + 1; Situation.save(s); log(`[ZAWRÓT] brak przycisku zawracania (${f.tries}/5)`, "warn"); return; }
      const w = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window; const orig = w.confirm;
      try { w.confirm = () => true; live.click(); await sleep(800); } finally { try { w.confirm = orig; } catch {} }
      // v3.10.2 (audyt E2E): stan "recalled" ustawiany od razu po kliknięciu był
      // WIARĄ, nie wiedzą — a decide() ponawia zawrót tylko dla "launched", więc
      // nieskuteczny klik nie doczekał się drugiej próby. Teraz klik daje stan
      // przejściowy, a potwierdzeniem jest dopiero wiersz powrotny na liście ruchów.
      f.phase = "recall_clicked"; f.recalledAt = Date.now(); Situation.save(s);
      log(`[ZAWRÓT] kliknięty dla [${f.fromKey}]→[${f.toKey}] — czekam na potwierdzenie wierszem powrotnym.`, "success");
      Journal.add("POWRÓT", `Zawrót wysłany: flota wraca na [${f.fromKey}].`);
    },
  };

  // ═══ KARTA PRZY ŻYCIU ═══════════════════════════════════════════════════
  // Przeglądarka dławi timery w kartach w tle (~1/min), a laptop zasypia —
  // obrona chodząca co 20 s przestaje wtedy istnieć dokładnie wtedy, gdy jest
  // potrzebna. Dwa niezależne środki z 2.x: Screen Wake Lock (nie usypia
  // ekranu/systemu, gdy karta widoczna) i CICHY dźwięk (karta odtwarzająca
  // audio nie jest dławiona w tle). Bez uprawnień, bez plików.
  const Wake = {
    _lock: null, _ctx: null, _busy: false,
    async ensure() {
      try {
        // v3.39.0: ensure() woła i pętla obrony, i visibilitychange. Bez zamka dwa
        // wywołania wchodziły w `await request()` równolegle i powstawały DWIE blokady
        // z dwoma listenerami — stąd podwójne „[WAKE] blokada uśpienia zwolniona.".
        if ("wakeLock" in navigator && document.visibilityState === "visible" && !this._busy && (!this._lock || this._lock.released)) {
          this._busy = true;
          try {
            this._lock = await navigator.wakeLock.request("screen");
            this._lock.addEventListener?.("release", () => log("[WAKE] blokada uśpienia zwolniona.", "warn"));
            if (!Once.said("wake_on", 6 * 3600e3)) log("[WAKE] blokada uśpienia aktywna — komputer nie zaśnie, póki karta z grą jest widoczna.", "info");
          } finally { this._busy = false; }
        }
      } catch (e) { if (!Once.said("wake_err", 3600e3)) log(`[WAKE] nie udało się zablokować uśpienia: ${e.message}`, "warn"); }
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!this._ctx) {
          this._ctx = new Ctx();
          const o = this._ctx.createOscillator(), g = this._ctx.createGain();
          g.gain.value = 0.0001; o.frequency.value = 20; o.connect(g); g.connect(this._ctx.destination); o.start();
          if (!Once.said("wake_audio", 6 * 3600e3)) log("[WAKE] karta trzymana przy życiu cichym dźwiękiem — w tle nie zostanie zdławiona.", "info");
        }
        if (this._ctx.state === "suspended") await this._ctx.resume();
      } catch {}
    },
  };

  // ═══ RAPORT STARTOWY (kalibracja na nowym uni) ══════════════════════════
  // Na Genesis nie wiemy, czy fork ma ten sam markup co Athena. Zamiast prosić
  // operatora o klikanie zrzutów w środku startu serwera: bot sam, przy
  // pierwszym kontakcie z każdą stroną, zbiera komplet dowodów do jednego
  // raportu, a operator kopiuje go JEDNYM przyciskiem.
  const Calib = {
    need() { return Store.get("calib_done", false) !== true; },
    get() { return Store.get("calib", {}) || {}; },
    put(part, data) { const c = this.get(); if (c[part]) return; c[part] = { at: Date.now(), data: String(data).slice(0, 4000) }; Store.set("calib", c); log(`[KALIBRACJA] zebrano: ${part} (${Object.keys(c).length}/4). Gdy będzie komplet — klik „Kopiuj raport startowy".`, "info"); this.check(); },
    check() {
      const c = this.get();
      if (["planetBar", "bar", "events", "fleetPage"].every(k => c[k])) {
        Store.set("calib_done", true);
        log("[KALIBRACJA] KOMPLET — kliknij przycisk kopiowania raportu startowego i wyślij go do Claude'a. Do tego czasu zostaw tryb Obserwator.", "success");
        // v3.46.0 (push 31.08 09:02:36): gotowy raport to nie awaria — wpis „BŁĄD"
        // fałszował dziennik obrony (i bilans po przerwie), a na telefonie wyglądał
        // jak „⚠️ Obrona: BŁĄD". Push idzie wprost, bez wpisu do dziennika.
        Notifier.push("📋 Raport startowy gotowy (Genesis)", "Skopiuj raport z panelu i wyślij Claude'owi (potwierdzenie parserów).", "default", "clipboard");
      }
    },
    collect() {
      if (!this.need()) return;
      try {
        const bar = document.querySelector("a.planet-select, .planet-select");
        if (bar) this.put("planetBar", (bar.closest("ul, div, nav, aside") || bar.parentElement).outerHTML.replace(/\s+/g, " "));
        const b = Bar.read();
        if (b) this.put("bar", `parse=${JSON.stringify(b)} | tekst=${document.body.textContent.replace(/\s+/g, " ").match(/.{0,80}Missions?.{0,220}/i)?.[0] || "(brak segmentu Missions)"}`);
        const ev = document.querySelector("#fleet-movement-content, #layoutFleetMovements");
        if (ev && (ev.textContent || "").trim().length > 20) this.put("events", ev.outerHTML.replace(/\s+/g, " "));
        if (page() === "fleet") {
          const ships = [...document.querySelectorAll("[data-ship-type]")];
          const one = ships[0] ? (ships[0].closest(".ship-item") || ships[0].parentElement).outerHTML.replace(/\s+/g, " ") : "(brak [data-ship-type])";
          this.put("fleetPage", `statki=${ships.length} (${ships.map(e => e.dataset.shipType).join(",")}) | pierwszy wiersz=${one} | pola celu=${["fleet2_target_x", "fleet2_target_y", "fleet2_target_z"].map(id => id + ":" + (document.getElementById(id) ? "jest" : "BRAK")).join(", ")} | data-planet-type=${document.querySelectorAll("[data-planet-type]").length} | mission-item=${[...document.querySelectorAll(".mission-item, [class*='mission-item']")].map(m => (m.textContent || "").trim().slice(0, 14) + "[" + m.className + "]").join(", ") || "BRAK"} | btn-all-res=${document.querySelector("a.btn-all-res, .btn-all-res") ? "jest" : "BRAK"}`);
        }
      } catch (e) { log(`[KALIBRACJA] błąd zbierania: ${e.message}`, "warn"); }
    },
    report() {
      const c = this.get();
      const head = `RAPORT STARTOWY OGameX 3 v${VERSION} · ${HOST} · ${new Date().toLocaleString("pl-PL")}\nPary: ${JSON.stringify(PlanetBar.pairs())}\nAktywne: ${JSON.stringify(PlanetBar.active())}\nPasek: ${JSON.stringify(Bar.read())}\n`;
      const parts = ["planetBar", "bar", "events", "fleetPage"].map(k => `\n──── ${k} ${c[k] ? "" : "(BRAK — odwiedź odpowiednią stronę)"}\n${c[k]?.data || ""}`).join("");
      return head + parts;
    },
  };

  // v3.12.0: krok „form" nawigował na adres formularza BEZ ŚLADU w logu. Gdy fork
  // oddawał pod tym adresem stronę, której page() nie uznaje za „fleet" (przekierowanie,
  // strona błędu, brak celu), bot krążył: wejście → nie fleet → wejście… przez całe
  // 5 minut do abortu, w logu tylko linie startowe. Teraz druga taka próba pod rząd
  // jest głośna, trzecia przerywa misję zamiast kręcić stroną.
  function navGuard(m, fly) {
    const k = `${m.fromKey}>${m.toKey}`;
    const g = Store.get("form_nav", null) || {};
    const tries = (g.key === k && Date.now() - (g.at || 0) < 3 * 60e3) ? (g.tries || 0) + 1 : 1;
    Store.set("form_nav", { key: k, at: Date.now(), tries });
    if (tries >= 3) { Store.set("form_nav", null); return fly.abort(`formularz nie otwiera się pod ${fly.url(m)} (3 próby) — fork oddaje inną stronę`); }
    if (tries === 2) log(`[LOT] drugi raz wchodzę na ${fly.url(m)}, a to nie jest strona floty — jeśli powtórzy się raz jeszcze, przerywam lot.`, "warn");
    fly.bumpNav(m);
    Nav.go(fly.url(m), `lot: formularz [${m.fromKey}]→[${m.toKey}] (próba ${tries})`);
  }

  // ═══ REKONESANS HANGARÓW ════════════════════════════════════════════════
  // Bez tego cała obrona jest ślepa: decide() zna położenie floty WYŁĄCZNIE
  // z odczytów hangaru (strona /fleet), a 3.0 — inaczej niż 2.x z ekspedycjami
  // i miningiem — nie ma innego powodu, żeby tam wchodzić. Więc chodzi sam:
  // odświeża aktywną parę, a gdy ta jest świeża — przełącza się na kolejne
  // ciało bez świeżego odczytu (round-robin). Nigdy w trakcie misji ani alarmu:
  // obrona ma pierwszeństwo przed nawigacją.
  const Recon = {
    st() { return Store.get("recon", { at: 0, idx: 0 }) || { at: 0, idx: 0 }; },
    bodiesOf(s) {
      const all = [];
      for (const [k, p] of Object.entries(s.pairs || {})) { all.push([k, "planet"]); if (p.hasMoon) all.push([k, "moon"]); }
      if ((CFG.reconMode || "fleet") === "all") return all;
      const lf = CFG.expo && CFG.expo.launchFrom ? key(CFG.expo.launchFrom) : null;
      // v3.21.0 (właściciel 29.08): „flota jest zawsze tam, skąd wysyłane są ekspedycje,
      // na innych planetach najwyżej są transportery". Skoro tak, rekonesans nie ma po
      // co przeklikiwać się po koloniach — gdy ciało startowe jest USTAWIONE, pilnuje
      // wyłącznie jego. Kolonie z paroma transporterami nie są warte przełączania planety.
      // (Alarm to osobna ścieżka: przy ataku bot i tak wejdzie na atakowane ciało.)
      if (lf) return all.filter(([k]) => k === lf);
      // Bez przypiętego ciała startowego: tylko te, na których bot WIDZIAŁ flotę.
      return all.filter(([k, b]) => { const h = (s.hangars || {})[`${k}|${b}`]; return !!(h && h.total > 0); });
    },
    async tick(s) {
      if (!CFG.recon || Fly.mission()) return false;
      const now = Date.now();
      // v3.9.0 (audyt): sondy szpiegowskie lecą non stop, a wpadały do tej samej
      // bramki co ataki — rekonesans stawał na zawsze, hangary się starzały i bot
      // przestawał wiedzieć, gdzie stoi flota. Blokuje tylko ATAK.
      if ((s.threats || []).some(t => t.attack && t.arriveAt > now)) return false;
      // v3.40.0 (audyt obrony 30.08): rekonesans pilnuje tylko ciała startowego, więc bot
      // NIE WIEDZIAŁ, co stoi na pozostałych 13 koloniach — a bez tego nawet wykryty atak
      // kończy się „nie wiem, gdzie stoi flota" i ratunek nie rusza. Czytamy je CICHO:
      // fetch strony floty w tle, zero nawigacji, zero przełączania Twojej planety.
      // Jedno ciało na przebieg, nie częściej niż raz na minutę, każde ciało raz na 45 min.
      // To NIE jest akcja `recon` z decide() — tamta nawiguje i to ona zrobiła sztorm 09:59.
      // v3.47.0: gdy operator gra, tło czeka — fetch `?planet=` przestawia sesję
      // po stronie serwera (patrz scanRemote) i nawet z przywróceniem zostaje okno
      // rozjazdu. Kolonie doczytamy, gdy odejdzie od klawiatury.
      if (!Human.playing()) {
        const bg = Store.get("recon_bg", { at: 0, idx: 0 }) || { at: 0, idx: 0 };
        if (now - (bg.at || 0) > 60e3) {
          const covered = new Set(this.bodiesOf(s).map(([k, b]) => `${k}|${b}`));
          const rest = [];
          for (const [k, p] of Object.entries(s.pairs || {})) {
            for (const b of (p.hasMoon ? ["planet", "moon"] : ["planet"])) {
              const hk = `${k}|${b}`;
              if (covered.has(hk)) continue;
              const h = (s.hangars || {})[hk];
              // v3.58.0: w trybie cichym kolonia jest odpytywana rzadko — każdy taki
              // fetch pali jej znacznik aktywności w galaktyce (transportery na
              // koloniach i tak prawie się nie zmieniają).
              const ttlBg = (CFG.stealth && CFG.stealth.enabled) ? (CFG.stealth.colonyHours || 8) * 3600e3 : (CFG.reconEmptyMs || 45 * 60e3);
              if (h && now - (h.at || 0) < ttlBg) continue;
              rest.push([k, b]);
            }
          }
          if (rest.length) {
            const [bk, bb] = rest[(bg.idx || 0) % rest.length];
            Store.set("recon_bg", { at: now, idx: (bg.idx || 0) + 1 });
            const got = await Hangar.scanRemote(bk, bb);
            if (got && got.total > 0 && !Once.said(`bg|${bk}|${bb}`, 6 * 3600e3)) {
              log(`[REKONESANS] kolonia ${bb} [${bk}] odczytana w tle: ${got.total.toLocaleString("pl-PL")} szt. — teraz wiem, że tam coś stoi.`, "info");
            }
          }
        }
      }
      if (flightsBlocking(s, Date.now())) return false;    // lot w powietrzu: nie kręcimy stroną
      const st = this.st();
      if (now - (st.at || 0) < 90e3) return false;                              // najwyżej raz na 90 s
      const manual = Store.get("manual_at", 0) || 0;
      if (now - manual < 45e3 && now - (st.at || 0) < 5 * 60e3) {
        if (!Once.said("recon_manual", 5 * 60e3)) log("[REKONESANS] grasz — nie przełączam Ci planety. Wrócę, gdy przestaniesz klikać (najdalej za 5 min).", "info");
        return false;
      }
      const stale = (k, b) => {
        const h = s.hangars[`${k}|${b}`];
        if (!h) return true;                                        // nigdy nie widziane
        const ttl = (h.total > 0) ? CFG.reconMs : (CFG.reconEmptyMs || CFG.reconMs);
        return now - h.at > ttl;
      };
      // v3.23.0 (zgłoszenie 29.08 12:08: „ciągle przeskakuje na inne planety w zakładce
      // flota"): ta gałąź odświeżała hangar ciała, na którym AKURAT JESTEŚ — więc gdy
      // klikałeś budynki na kolonii, bot wyrywał Cię na jej zakładkę Flota. Ograniczenie
      // z v3.21.0 dotyczyło tylko listy obiegowej. Teraz: sam z siebie wchodzi na Fleet
      // WYŁĄCZNIE dla ciał z listy (przypięte ciało startowe albo ciała z flotą);
      // dla każdego innego czyta hangar tylko wtedy, gdy i tak jesteś na /fleet.
      const allowed = new Set(this.bodiesOf(s).map(([k, b]) => `${k}|${b}`));
      const a = s.active;
      if (a && stale(a.key, a.body)) {
        if (page() === "fleet") { Hangar.scan(); return false; }                // już jesteśmy — darmowy odczyt
        // Wyjątek na rozruch: gdy nie ma jeszcze CZEGO pilnować (nic nie przypięte
        // i żadnego hangaru z flotą), bot musi raz odczytać ciało, na którym stoisz —
        // inaczej nigdy nie dowie się, gdzie jest flota, i obrona zostaje ślepa.
        if (allowed.size === 0 || allowed.has(`${a.key}|${a.body}`)) {
          Store.set("recon", { ...st, at: now });
          // v3.24.0: najpierw próba CICHA — pobranie strony floty w tle, bez ruszania
          // strony, na której siedzi operator.
          const quiet = await Hangar.scanRemote(a.key, a.body);
          if (quiet) { log(`[REKONESANS] hangar ${a.body} [${a.key}] odczytany w tle (${quiet.total.toLocaleString("pl-PL")} szt.) — bez przełączania strony.`, "info"); return false; }
          log(`[REKONESANS] sprawdzam hangar ${a.body} [${a.key}] — bez tego nie wiem, gdzie stoi flota.`, "info");
          const [g, sy, po] = a.key.split(":");
          Nav.go(`/fleet?x=${g}&y=${sy}&z=${po}`, `rekonesans hangaru ${a.body} [${a.key}]`);
          return true;
        }
        if (!Once.said("recon_skip_active", 30 * 60e3)) log(`[REKONESANS] jesteś na [${a.key}] — to nie jest ciało, które pilnuję, więc nie otwieram Ci zakładki Flota.`, "info");
      }
      const list = this.bodiesOf(s).filter(([k, b]) => stale(k, b));
      if (!list.length) return false;
      const [k, b] = list[(st.idx || 0) % list.length];
      const el = PlanetBar.anchor(k, b);
      if (!el) { Store.set("recon", { at: now, idx: (st.idx || 0) + 1 }); return false; }
      Store.set("recon", { at: now, idx: (st.idx || 0) + 1 });
      const quiet2 = await Hangar.scanRemote(k, b);
      if (quiet2) { log(`[REKONESANS] hangar ${b} [${k}] odczytany w tle (${quiet2.total.toLocaleString("pl-PL")} szt.) — bez przełączania planety.`, "info"); return false; }
      log(`[REKONESANS] przechodzę na ${b} [${k}], żeby odczytać hangar.`, "info");
      el.click();
      return true;
    },
  };

  // ═══ PĘTLA OBRONY ═══════════════════════════════════════════════════════
  let running = false;
  // v3.39.0 (incydent 30.08 09:18): klik „Send fleet" NAWIGUJE NATYCHMIAST, więc kod,
  // który po udanej wysyłce zdejmuje `pending` z wpisu lotu, często nigdy się nie
  // wykonuje. Wpis wisiał wtedy do 10-minutowego timeoutu i przez ten czas decide()
  // uznawał parę za „w locie": ratunek trwał 106 s, a flota siedziała na planecie
  // 10 minut i ekspedycje stały. Po przeładowaniu dowód wysyłki daje sama gra —
  // adres /fleet?fleetSendSuccessfully.
  // v3.39.2 (sztorm 30.08 09:59:20–09:59:47, ~90 przeładowań /fleet w 27 s):
  // lot „dom = księżyc" zabiera CAŁY hangar planety, ale nasz zapis hangaru ŹRÓDŁA
  // zostawał niezmieniony — dalej mówił „na planecie stoi 460 tys. statków". Gdy wpis
  // lotu został domknięty odczytem hangaru CELU (a od 3.39.0 dzieje się to w sekundy,
  // nie po 10 min), decide() natychmiast wystawiał TEN SAM lot jeszcze raz, bramka
  // anty-duplikat go blokowała, misja znikała — i całość od nowa, przy czym każda
  // iteracja to jedna nawigacja. Skoro wiemy, że flota wyleciała, źródło jest puste.
  function emptySourceHangar(fromKey, fromBody, why) {
    try {
      const s = Situation.load();
      const hk = `${fromKey}|${fromBody}`;
      const h = s.hangars[hk];
      if (!h || (h.total || 0) === 0) return;
      s.hangars[hk] = { total: 0, ships: [], at: Date.now() };
      Situation.save(s);
      log(`[LOT] hangar ${fromBody} [${fromKey}] wyzerowany — flota z niego wyleciała (${why}).`, "info");
    } catch {}
  }

  function confirmPendingSend() {
    try {
      if (!location.href.includes("fleetSendSuccessfully")) return;
      const ls = Store.get("last_send", null); if (!ls) return;
      const s = Situation.load();
      const f = (s.flights || []).find(x => x.pending && x.fromKey === ls.from && Math.abs((x.sentAt || 0) - ls.at) < 60e3);
      // v3.52.0: rejestr powrotów potwierdzamy tą samą drogą — wysyłka ekonomii też
      // potrafi nawigować przed wykonaniem kodu potwierdzającego.
      const e = (s.expected || []).find(x => x.pending && x.fromKey === ls.from && Math.abs((x.sentAt || 0) - ls.at) < 60e3);
      if (!f && !e) return;
      if (e) delete e.pending;
      if (f) delete f.pending;
      Situation.save(s);
      if (f) {
        log(`[LOT] wysyłka [${f.fromKey}]→[${f.toKey}] potwierdzona przez grę po przeładowaniu — wpis nie czeka na timeout.`, "success");
        emptySourceHangar(f.fromKey, f.fromBody, "potwierdzenie po przeładowaniu");
      }
    } catch {}
  }

  // v3.45.0 (priorytet ownera 30.08: „najważniejsze, żeby obronił flotę gdy ktoś zaatakuje"):
  // do tej pory bot dowiadywał się, że czegoś mu brakuje, DOPIERO przy ataku — a wtedy jest
  // za późno na dyskusję, czy hangar jest świeży i czy push w ogóle włączony. Ta funkcja
  // sprawdza warunki obrony NA SUCHO, zanim cokolwiek się stanie, i mówi o brakach wprost.
  // Nic nie nawiguje i nic nie wysyła — czyta tylko stan.
  function defenceReadiness(s) {
    const braki = [];
    const now = Date.now();
    if (!CFG.enabled) braki.push("bot WYŁĄCZONY");
    if (!CFG.autoRescue) braki.push("auto-ratunek OFF — będę tylko alarmował, nie ruszę flotą");
    if (Session.lostRecently()) braki.push("SESJA WYGASŁA — zaloguj się");
    if (!Notifier.enabled()) braki.push("push OFF — nie dostaniesz alarmu na telefon");
    const guard = (CFG.expo && CFG.expo.launchFrom) ? key(CFG.expo.launchFrom) : (s.active && s.active.key);
    if (!guard) braki.push("nie wiem, którego ciała pilnować (brak paska planet)");
    else {
      const hm = (s.hangars || {})[`${guard}|moon`], hp = (s.hangars || {})[`${guard}|planet`];
      const swiezy = [hm, hp].some(h => h && now - (h.at || 0) < 30 * 60e3);
      if (!swiezy) braki.push(`hangar [${guard}] nieczytany od ponad 30 min — nie wiem, gdzie stoi flota`);
      else if (!Situation.fleetAt(s, guard, now)) {
        // v3.46.0 (test 31.08 09:01:37): pusty hangar w trakcie WŁASNEGO ratunku/zawrotu
        // to nie brak gotowości — bot sam wysłał flotę w powietrze i wie, gdzie ona jest.
        const wLocie = (s.flights || []).some(f => (f.fromKey === guard || f.toKey === guard) && f.phase !== "done" && !flightStale(f, now));
        if (!wLocie) braki.push(`na [${guard}] nie widzę żadnej floty (cała w powietrzu?)`);
      }
    }
    if (Object.keys(s.pairs || {}).length < 2) braki.push("jedna kolonia — nie ma dokąd uciec");
    if (Store.get("hb_ok", null) === false) braki.push("strażnik (watchdog) nie odpowiada — zawieszona karta nie zostanie ożywiona");
    return braki;
  }

  async function defenceTick() {
    if (running || !CFG.enabled) return; running = true;
    try {
      if (errorPageGuard()) return;
      if (!TabLock.acquire()) return;
      Store.set("last_tick", Date.now());
      Heartbeat.ping();
      confirmPendingSend();
      Wake.ensure();
      Calib.collect();
      if (page() === "fleet") Hangar.scan();
      const s = await Situation.refresh();
      const { actions, alerts } = decide(s, CFG, Date.now());
      for (const a of alerts) {
        // v3.40.0 (test ownera 10:23–10:25): ten sam alert poszedł OSIEM razy mimo
        // dławika 5 min, bo w kluczu siedziało odliczanie („za 107s", „za 87s"…) —
        // każda sekunda tworzyła nowy klucz. Cyfry z klucza wypadają; para (`a.key`)
        // nadal rozdziela alarmy z różnych kolonii.
        const k = `alert|${a.key}|${a.msg.replace(/\d+/g, "#").slice(0, 60)}`;
        if (Once.said(k, a.throttleMs || 60e3)) continue;
        log(`[OBRONA] ${a.msg}`, a.level === "error" ? "error" : "warn");
        if ((a.unknownPair || a.blind) && !Once.said(`push|${a.key}`, 5 * 60e3)) Journal.add("ATAK", a.msg);   // v3.7.0: nieznana kolonia → push na telefon
      }
      // Samokontrola to przegląd okresowy, nie sprawdzian na każdym przebiegu: raz na 5 minut.
      // (Pakiet E2E pokazał to od razu — dodatkowa praca w KAŻDYM ticku przesuwała czas
      // rzeczywisty na tyle, że 20-sekundowa bramka anty-duplikat ekspedycji zdążyła wygasnąć
      // i przechodziła trzecia fala. Tanio i rzadko zamiast drogo i ciągle.)
      if (Date.now() - (Store.get("ready_at", 0) || 0) > 5 * 60e3) {
        Store.set("ready_at", Date.now());
        const braki = defenceReadiness(s);
        if (braki.length) {
          if (!Once.said("gotowosc|" + braki.join("|").slice(0, 60), 60 * 60e3)) log(`[GOTOWOŚĆ] obrona NIE jest w pełni gotowa: ${braki.join("; ")}.`, "error");
        } else if (!Once.said("gotowosc_ok", 6 * 3600e3)) {
          log("[GOTOWOŚĆ] obrona gotowa: bot ON, auto-ratunek ON, hangar świeży, jest dokąd uciec, push włączony.", "success");
        }
      }
      const attacks = (s.threats || []).filter(t => t.attack && t.arriveAt > Date.now());
      if (attacks.length) { const k = `atak|${attacks.map(t => t.id || t.dst).join(",")}`; if (!Once.said(k, 10 * 60e3)) Journal.add("ATAK", attacks.map(t => `${t.type} → [${t.dst}] ${t.dstBody || "?"} za ${Math.round((t.arriveAt - Date.now()) / 1000)}s (${t.source})`).join("; ")); }
      // v3.10.2 (audyt E2E): lot EKONOMICZNY w toku blokował cały przebieg obrony
      // (`if (Fly.mission()) return`) aż do timeoutu 5 min — tyle, ile trwa typowy
      // dolot ataku. Ekonomia nigdy nie może stać na drodze ratunku: przy realnym
      // zagrożeniu albo gotowej akcji obronnej przerywamy ją natychmiast.
      const ECO = ["expedition", "asteroid", "debris"];
      const mNow = Fly.mission();
      if (mNow && ECO.includes(mNow.kind)) {
        const urgent = (s.threats || []).some(t => t.attack && t.arriveAt > Date.now())
          || actions.some(a => a.kind === "fly" || a.kind === "recall");
        if (urgent) Fly.abort("ALARM — obrona ma pierwszeństwo przed ekonomią", { quiet: true });
      }
      await Fly.tick();
      if (Fly.mission()) return;
      // v3.10.2 (audyt regresji): kolejnosc akcji szla za kolejnoscia par na pasku,
      // a `recon` konczy przebieg nawigacja. Para atakowana za 70 s czekala na
      // rekonesans pary atakowanej za 400 s. Ratunek ma bezwzgledne pierwszenstwo.
      const RANK = { fly: 0, recall: 1, extend: 2, hold: 3, recon: 4 };
      actions.sort((x, y) => (RANK[x.kind] ?? 9) - (RANK[y.kind] ?? 9));
      const hasRescue = actions.some(a => (a.kind === "fly" && (a.rescue || a.blind)) || a.kind === "recall");
      for (const a of actions) {
        if (a.kind === "recon") {
          // rekonesans nawiguje, wiec nigdy nie wolno mu wyprzedzic ratunku
          if (hasRescue && CFG.autoRescue) { continue; }
          // v3.46.0 (owner 31.08: „bot sam przeskakuje z planety na planetę"): rekonesans
          // po LĄDOWANIU własnego lotu to rutyna, nie alarm — wolno mu WYŁĄCZNIE cichą
          // ścieżkę (fetch w tle, zero nawigacji i zero przełączania planety operatora).
          if (a.quiet) {
            // v3.47.0: gdy operator gra, nawet cichy odczyt czeka (fetch `?planet=`
            // przestawia sesję po stronie serwera — Error „Planet change" 31.08 10:12).
            if (Human.playing()) continue;
            const bq = a.body || "planet";
            if (!Once.said(`qrecon|${a.key}|${bq}`, 5 * 60e3)) {
              const got = await Hangar.scanRemote(a.key, bq);
              log(`[OBRONA] ${a.why} — ${got ? `odczytany w tle (${got.total.toLocaleString("pl-PL")} szt.), bez przełączania planety` : "cichy odczyt nie wyszedł, poczekam na naturalny odczyt hangaru"}.`, "info");
            }
            continue;
          }
          // v3.9.0: WYJĄTEK od zasady "przy alarmie nie nawigujemy" — skoro nie wiemy,
          // gdzie stoi flota, to bez tego jednego wejścia na /fleet i tak nic nie zrobimy.
          const body = a.body || "planet";
          const act = Situation.load().active;
          if (act && act.key === a.key && act.body === body && page() === "fleet") {
            Hangar.scan();
            const g2 = Store.get("alarm_scan", {}) || {}; if (g2[`${a.key}|${body}`]) { delete g2[`${a.key}|${body}`]; Store.set("alarm_scan", g2); }   // odczyt się udał
            continue;
          }
          // v3.12.0: to wejście na Fleet było JEDYNĄ nawigacją obrony bez żadnego
          // limitu — przy ataku i hangarze, którego nie da się odczytać (fork oddaje
          // inną stronę), bot przeładowywał grę w kółko dokładnie wtedy, gdy miał
          // ratować flotę. Trzy próby, potem alarm do operatora zamiast kręcenia stroną.
          {
            const kk = `${a.key}|${body}`;
            const g2 = Store.get("alarm_scan", {}) || {};
            const r2 = g2[kk] && Date.now() - g2[kk].at < 10 * 60e3 ? g2[kk] : { n: 0, at: 0 };
            if (r2.n >= 3) {
              if (!Once.said(`alarmscan|${kk}`, 10 * 60e3)) {
                log(`[OBRONA] trzeci raz wszedłem na Fleet po hangar [${a.key}] ${body} i nadal go nie widzę — przestaję przeładowywać grę. Sprawdź ręcznie, gdzie stoi flota.`, "error");
                Journal.add("BŁĄD", `Nie mogę odczytać hangaru [${a.key}] ${body} mimo 3 prób przy ALARMIE — sprawdź grę.`);
              }
              continue;
            }
            g2[kk] = { n: r2.n + 1, at: Date.now() }; Store.set("alarm_scan", g2);
          }
          log(`[OBRONA] ${a.why} — wchodzę na Fleet.`, "warn");
          if (act && act.key === a.key && act.body === body) { const [g, sy, po] = a.key.split(":"); Nav.go(`/fleet?x=${g}&y=${sy}&z=${po}`, `odczyt hangaru [${a.key}] po alarmie`); return; }
          const el = PlanetBar.anchor(a.key, body) || PlanetBar.anchor(a.key, "planet");
          if (el) { Nav.click(el, `odczyt hangaru [${a.key}] ${body} po alarmie`); return; }
          continue;
        }
        if (a.kind === "hold") { if (!Once.said(`hold|${a.key}`, 120e3)) log(`[OBRONA] [${a.key}]: ${a.why} — nie ruszam floty.`, "info"); continue; }
        if (a.kind === "extend") { const s2 = Situation.load(); const f = (s2.flights || []).find(x => x.fromKey === a.flight.fromKey && x.phase === "launched"); if (f && f.recallAt < a.recallAt) { f.recallAt = a.recallAt; Situation.save(s2); log(`[LOT] ${a.why} — zawrót przesunięty na ${new Date(a.recallAt).toLocaleTimeString("pl-PL")}`, "warn"); } continue; }
        if (!CFG.autoRescue) { if (!Once.said(`obs|${a.kind}|${a.fromKey || a.flight?.fromKey}`, 60e3)) log(`[OBSERWATOR] zrobiłbym: ${a.kind} ${a.why || ""} — auto-ratunek OFF.`, "warn"); continue; }
        if (a.kind === "recall") { await Fly.recall(a.flight); break; }
        if (a.kind === "fly") {
          if (Fly.blocked(a)) { if (!Once.said(`blk|${a.fromKey}${a.toKey}`, 60e3)) log(`[LOT] trasa [${a.fromKey}]→[${a.toKey}] w karencji po nieudanej próbie — czekam.`, "warn"); continue; }
          if (Fly.start(a)) { await Fly.tick(); } break;
        }
      }
      // v3.7.3 (audyt): ekonomia w WŁASNYM try — błąd w ekspedycjach/miningu/złomie
      // nie może przerwać przebiegu obrony ani wywalić pętli.
      if (!actions.some(a => a.kind === "fly" || a.kind === "recall")) {
        try { if (!(await Recon.tick(s)) && !(await Bonus.tick(s)) && !(await Moon.tick(s)) && !(await Expo.tick(s)) && !(await Aster.tick(s))) await Debris.tick(s); }
        catch (e) { log(`[EKONOMIA] błąd modułu: ${e.message} — obrona działa dalej.`, "warn"); }
      }
      Store.set("tick_fails", 0);
    } catch (e) {
      // v3.7.3: powtarzający się błąd rdzenia obrony = ŚLEPY BOT. Po 3 z rzędu
      // krzyczymy na telefon, zamiast logować w nieskończoność do pustego pokoju.
      const n = (Store.get("tick_fails", 0) || 0) + 1;
      Store.set("tick_fails", n);
      log(`[OBRONA] błąd pętli (${n}): ${e.message}`, "error");
      if (n === 3) Journal.add("BŁĄD", `Obrona nie kończy przebiegu 3× z rzędu (${e.message}) — bot może być ŚLEPY. Sprawdź grę.`);
    }
    finally { running = false; try { UI.renderStatus(); } catch {} }
  }
  const Once = { said(k, ms) { const m = Store.get("once", {}) || {}; if (Date.now() - (m[k] || 0) < ms) return true; m[k] = Date.now(); for (const x of Object.keys(m)) if (Date.now() - m[x] > 24 * 3600e3) delete m[x]; Store.set("once", m); return false; } };
  // v3.9.0 (audyt 28.08, defekt KRYTYCZNY): id karty losowane przy KAŻDYM ładowaniu
  // strony, a bot nawiguje na każdym kroku ratunku — więc po pierwszej nawigacji
  // nowa instancja widziała "cudzy" świeży lock i milczała 90 s. Bot blokował sam
  // siebie. Id żyje w sessionStorage: przetrwa nawigacje TEJ karty, inne dla innej.
  const TabLock = {
    KEY: "ogx3_lock",
    id() { try { let v = sessionStorage.getItem("ogx3_tab"); if (!v) { v = Math.random().toString(36).slice(2); sessionStorage.setItem("ogx3_tab", v); } return v; } catch { return "single"; } },
    acquire() {
      try {
        const me = this.id();
        const raw = localStorage.getItem(this.KEY);
        const l = raw ? JSON.parse(raw) : null;
        const age = l ? Date.now() - (l.at || 0) : Infinity;
        const visible = document.visibilityState === "visible";
        if (l && l.id !== me && age < ((visible && !l.visible) ? 45e3 : 90e3)) {
          if (!Once.said("lock", 5 * 60e3)) log("[KARTA] inna karta prowadzi bota — ta jest pasywna (przejmie, gdy tamta zamilknie).", "info");
          return false;
        }
        localStorage.setItem(this.KEY, JSON.stringify({ id: me, at: Date.now(), visible }));
        return true;
      } catch { return true; }
    },
  };
  // v3.7.3: NADZORCA. Jeśli pętla obrony nie odbiła się przez 3 min (zdławiona
  // karta, zawieszony await, wyjątek poza łańcuchem), strona idzie w reload —
  // martwy bot, który wygląda na żywego, to najgorszy stan (lekcja 2.x).
  function watchdog() {
    if (!CFG.enabled) return;                       // bot wyłączony ręcznie = cisza jest w porządku
    const last = Store.get("last_tick", 0) || 0;
    if (!last || Date.now() - last < 3 * 60e3) return;
    if (Fly.mission()) return;
    const at = Store.get("watchdog_at", 0) || 0;
    if (Date.now() - at < 10 * 60e3) return;
    Store.set("watchdog_at", Date.now());
    log(`[NADZORCA] pętla obrony milczy od ${Math.round((Date.now() - last) / 60000)} min — przeładowuję stronę.`, "error");
    Journal.add("BŁĄD", "Pętla obrony milczała 3 min — przeładowanie strony (nadzorca).");
    setTimeout(() => Nav.go("/", "nadzorca: pętla obrony milczała"), 1500);
  }

  // v3.9.1 (audyt): fork serwuje własną stronę błędu bez UI gry. 2.x stał na niej
  // GODZINAMI (incydent 03.08 ×2). Wykrycie + powrót do gry, z dławikiem.
  function errorPageGuard() {
    const url = location.href;
    const txt = (document.body.textContent || "").slice(0, 400);
    const bad = /aspxerrorpath|\/Error\//i.test(url) || (/Error occurred|Page not found|Wystąpił błąd|Internal Server Error|Service Unavailable|\b50[0-3]\b/i.test(txt) && !document.querySelector("a.planet-select, .planet-select"));
    if (!bad) return false;
    const at = Store.get("errpage_at", 0) || 0;
    if (Date.now() - at < 2 * 60e3) return true;
    Store.set("errpage_at", Date.now());
    log("[BŁĄD STRONY] jestem na stronie błędu gry — wracam na stronę główną.", "error");
    const back = [...document.querySelectorAll("a, button")].find(e => /back to game|wróć|powrót/i.test(e.textContent || ""));
    setTimeout(() => { if (back) back.click(); else Nav.go("/", "powrót ze strony błędu gry"); }, 1200);
    return true;
  }

    // v3.30.0 (log 29.08 13:26–15:52): keepalive parkował bota na "/" — stronie BEZ
  // menu gry. Bot bezczynny siedzi tam między ekspedycjami, więc `Bonus.find()`
  // NIGDY nie widział przycisku ("brak przycisku" co 30 min w logu), a bonus
  // wpadał tylko wtedy, gdy właściciel sam klikał po grze. Parkujemy na /home.
  function keepalive() { const last = Store.get("last_load", 0) || 0; if (!Fly.mission() && last && Date.now() - last > 10 * 60e3) { log("[KEEPALIVE] przeładowanie (10 min bez nawigacji).", "info"); Nav.go("/home", "keepalive: 10 min bez nawigacji"); } }

  // ═══ PANEL ══════════════════════════════════════════════════════════════
  // v3.11.0 (UX): powrót do wyglądu panelu z Ateny (2.x) — właściciel: „stary był
  // ładny i nie przesłaniał". Trzy grzechy panelu 3.0, które to naprawia:
  //   1. 300 px + left:8 zasłaniało menu gry (Overview…Simulators). 232 px kończy
  //      się PRZED menu (pomiar z 2.65.3 na 13,6" MacBooku właściciela).
  //   2. Wszystko rozwinięte na stałe → pół ekranu nawigacji. Teraz: PASEK STANU
  //      na wierzchu (5 linii = 5 odpowiedzi bez klikania), ustawienia w zwiniętych
  //      sekcjach (AUDYT-UX-PANEL-2026-08-03.md, „stan na wierzchu, ustawienia w środku").
  //   3. Nie dało się go odsunąć ani zwinąć — nagłówek jest przeciągalny, „_" zwija
  //      do samego nagłówka; pozycja, zwinięcie i otwarte sekcje przeżywają przeładowanie.
  // ID przycisków i pól są te same co w 3.10.x — handlery i testy E2E bez zmian.
  const UI = {
    el: null,
    build() {
      if (document.getElementById("ogx3-panel")) return;
      const d = document.createElement("div"); d.id = "ogx3-panel";
      d.innerHTML = `
        <style>
          #ogx3-panel{position:fixed;top:10px;left:10px;width:232px;background:rgba(0,10,30,.92);border:1px solid #1a5276;border-radius:8px;color:#e0e0e0;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,.6);user-select:none;max-height:calc(100vh - 20px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
          #ogx3-panel.alarm{border-color:#e74c3c;box-shadow:0 0 0 1px #e74c3c66,0 4px 20px rgba(0,0,0,.6)}
          #ogx3-panel .hd{background:linear-gradient(135deg,#1a5276,#0d2f4f);padding:8px 10px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center;cursor:move;font-weight:bold;font-size:13px;color:#5dade2}
          #ogx3-panel.alarm .hd{background:linear-gradient(135deg,#7a1e1e,#3d0f0f);color:#ffb3b3}
          #ogx3-panel .hd .v{font-size:9px;color:#7f8c8d;font-weight:normal}
          #ogx3-panel .min{cursor:pointer;font-size:16px;color:#9fb3c2;line-height:1;padding:0 4px}
          #ogx3-panel .min:hover{color:#fff}
          #ogx3-panel .strip{padding:7px 10px 6px;border-bottom:1px solid #1a5276;font-size:11px;line-height:1.6}
          #ogx3-panel .row{display:flex;gap:5px;align-items:baseline}
          #ogx3-panel .row .ico{width:15px;flex:none;text-align:center}
          #ogx3-panel .row .lbl{width:58px;flex:none;color:#8fa8b8}
          #ogx3-panel .row .val{color:#d7e2ea;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
          #ogx3-panel .row.ok .val{color:#6fcf97}
          #ogx3-panel .row.busy .val{color:#f2b25c}
          #ogx3-panel .row.alert .val{color:#ff6b6b;font-weight:700}
          #ogx3-panel .row.dim .val{color:#7f8c8d}
          #ogx3-panel .body{padding:8px 10px 10px}
          #ogx3-panel .act{display:flex;gap:4px;margin-bottom:6px}
          #ogx3-panel .sec{margin-bottom:4px;background:rgba(255,255,255,.03);border-radius:4px;border-left:3px solid #1a5276}
          #ogx3-panel .sec.open{border-left-color:#27ae60}
          #ogx3-panel .sec-t{padding:4px 8px;font-size:11px;color:#b9c9d4;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:6px}
          #ogx3-panel .sec-t:hover{color:#fff}
          #ogx3-panel .sec-t .arr{display:inline-block;width:9px;color:#5dade2}
          #ogx3-panel .sec-t>span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
          #ogx3-panel .sec-t .tail{color:#7f8c8d;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:74px;flex:none}
          #ogx3-panel .sec-b{display:none;padding:2px 8px 7px;font-size:11px;line-height:1.5}
          #ogx3-panel .sec.open .sec-b{display:block}
          #ogx3-panel .sec-b .line{margin:4px 0;display:flex;gap:4px;flex-wrap:wrap;align-items:center}
          #ogx3-panel .note{color:#8fa8b8;font-size:10px;margin-top:3px}
          #ogx3-panel input{background:rgba(0,0,0,.35);border:1px solid #2b4a66;color:#e0e0e0;border-radius:3px;padding:1px 4px;font-size:11px}
          #ogx3-panel .ogx3-btn{background:rgba(255,255,255,.1);color:#ccc;border:1px solid #555;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:10.5px}
          #ogx3-panel .ogx3-btn:hover{background:rgba(255,255,255,.2);color:#fff}
          #ogx3-panel #ogx3-on{padding:3px 12px;border:none;border-radius:4px;font-weight:bold;font-size:12px;color:#fff;cursor:pointer}
          #ogx3-panel #ogx3-save{background:#c0392b;color:#fff;border-color:#e74c3c;font-weight:bold;flex:1;font-size:10px;padding:4px 2px;white-space:nowrap}
          #ogx3-panel #ogx3-home{flex:1;font-size:10px;padding:4px 2px;white-space:nowrap}
          #ogx3-panel .jr{margin:2px 0;font-size:10px;line-height:1.35;color:#b7c4cd}
          #ogx3-panel .jr b{color:#5dade2;font-weight:600}
          #ogx3-panel .jr.ATAK b,#ogx3-panel .jr.BŁĄD b{color:#ff6b6b}
          #ogx3-panel .jr.RATUNEK b,#ogx3-panel .jr.POWRÓT b{color:#6fcf97}
          #ogx3-panel #ogx3-status{white-space:pre-wrap;font-size:10px;line-height:1.4;color:#b7c4cd}
          #ogx3-panel #ogx3-log{max-height:180px;overflow-y:auto;font:10px/1.35 ui-monospace,monospace;background:rgba(0,0,0,.3);padding:5px;border-radius:4px;margin-top:4px}
        </style>
        <div class="hd" id="ogx3-hd">
          <span>OGameX 3 <span class="v">v${VERSION}</span></span>
          <span style="display:flex;gap:6px;align-items:center"><button id="ogx3-on"></button><span class="min" id="ogx3-min" title="Zwiń / rozwiń panel">_</span></span>
        </div>
        <div class="strip" id="ogx3-strip">
          <div class="row" id="ogx3-r-def"><span class="ico">🛡</span><span class="lbl">Obrona</span><span class="val">—</span></div>
          <div class="row" id="ogx3-r-fleet"><span class="ico">🛰</span><span class="lbl">Flota</span><span class="val">—</span></div>
          <div class="row" id="ogx3-r-expo"><span class="ico">🚀</span><span class="lbl">Ekspedycje</span><span class="val">—</span></div>
          <div class="row" id="ogx3-r-ret"><span class="ico">↩</span><span class="lbl">Powroty</span><span class="val">—</span></div>
          <div class="row" id="ogx3-r-min"><span class="ico">⛏</span><span class="lbl">Mining</span><span class="val">—</span></div>
          <div class="row" id="ogx3-r-fs"><span class="ico">🌙</span><span class="lbl">Fleet Save</span><span class="val">—</span></div>
        </div>
        <div class="body" id="ogx3-body">
          <div class="act"><button id="ogx3-save" class="ogx3-btn">RATUJ FLOTĘ TERAZ</button><button id="ogx3-home" class="ogx3-btn">WRÓĆ NA BAZĘ</button></div>
          <div class="sec" data-sec="def"><div class="sec-t"><span><span class="arr">▸</span> Ustawienia: Obrona</span><span class="tail" id="ogx3-t-def"></span></div><div class="sec-b">
            <div class="line"><button id="ogx3-auto" class="ogx3-btn"></button><button id="ogx3-recon" class="ogx3-btn"></button></div>
            <div class="line"><button id="ogx3-h2m" class="ogx3-btn"></button></div>
            <div class="line"><button id="ogx3-push" class="ogx3-btn"></button><button id="ogx3-voice" class="ogx3-btn"></button><button id="ogx3-pushtest" class="ogx3-btn">Test push</button></div>
            <div class="line">Rezerwa deuteru <input id="ogx3-res" style="width:74px" /></div>
            <div class="line">Prędkość ucieczki <input id="ogx3-spd" style="width:32px" />%</div>
            <div class="note">ntfy: <span id="ogx3-topic"></span></div>
          </div></div>
          <div class="sec" data-sec="expo"><div class="sec-t"><span><span class="arr">▸</span> Ustawienia: Ekspedycje</span><span class="tail" id="ogx3-t-expo"></span></div><div class="sec-b">
            <div class="line"><button id="ogx3-expo" class="ogx3-btn"></button><button id="ogx3-disc" class="ogx3-btn"></button></div>
            <div class="line">fale <input id="ogx3-waves" style="width:30px" /> · rezerwa slotów <input id="ogx3-slotres" style="width:26px" /></div>
            <div class="line">startuj z <input id="ogx3-expo-from" style="width:70px" placeholder="g:s:p" /></div>
            <div class="note" id="ogx3-expo-st"></div>
          </div></div>
          <div class="sec" data-sec="fs"><div class="sec-t"><span><span class="arr">▸</span> Ustawienia: Fleet Save</span><span class="tail" id="ogx3-t-fs"></span></div><div class="sec-b">
            <div class="line"><button id="ogx3-fs" class="ogx3-btn"></button> od <input id="ogx3-fs-a" style="width:24px" />:00 do <input id="ogx3-fs-b" style="width:24px" />:00</div>
            <div class="note" id="ogx3-fs-st"></div>
          </div></div>
          <div class="sec" data-sec="eco"><div class="sec-t"><span><span class="arr">▸</span> Ustawienia: Ekonomia</span><span class="tail" id="ogx3-t-eco"></span></div><div class="sec-b">
            <div class="line"><button id="ogx3-aster" class="ogx3-btn"></button><button id="ogx3-deb" class="ogx3-btn"></button><button id="ogx3-bonus" class="ogx3-btn"></button></div>
            <div class="line"><button id="ogx3-quiet" class="ogx3-btn"></button></div>
            <div class="note" id="ogx3-bonus-st"></div>
            <div class="line"><button id="ogx3-moon" class="ogx3-btn"></button> ≤ <input id="ogx3-moon-share" style="width:26px" />% metalu</div>
            <div class="note" id="ogx3-moon-st"></div>
            <div class="note" id="ogx3-aster-st"></div>
            <div class="line"><button id="ogx3-quiet" class="ogx3-btn"></button> od <input id="ogx3-quiet-a" style="width:24px" />:00 do <input id="ogx3-quiet-b" style="width:24px" />:00</div>
            <div class="line"><button id="ogx3-breaks" class="ogx3-btn"></button></div>
            <div class="line">gdy klikasz: fala czeka <input id="ogx3-idle" style="width:26px" /> min ciszy (0 = leci od razu)</div>
            <div class="note" id="ogx3-human-st"></div>
          </div></div>
          <div class="sec" data-sec="jr"><div class="sec-t"><span><span class="arr">▸</span> Dziennik obrony</span><span class="tail" id="ogx3-t-jr"></span></div><div class="sec-b"><div id="ogx3-journal"></div></div></div>
          <div class="sec" data-sec="det"><div class="sec-t"><span><span class="arr">▸</span> Szczegóły stanu</span></div><div class="sec-b"><div id="ogx3-status"></div></div></div>
          <div class="sec" data-sec="tools"><div class="sec-t"><span><span class="arr">▸</span> Narzędzia i testy</span></div><div class="sec-b">
            <div class="line"><button id="ogx3-sim-moon" class="ogx3-btn">TEST: atak na księżyc</button><button id="ogx3-sim-planet" class="ogx3-btn">TEST: atak na planetę</button></div>
            <div class="line"><button id="ogx3-dump" class="ogx3-btn">Zrzut DOM</button><button id="ogx3-report" class="ogx3-btn">Kopiuj raport</button><button id="ogx3-abort" class="ogx3-btn">Przerwij lot</button></div>
          </div></div>
          <div class="sec" data-sec="log"><div class="sec-t"><span><span class="arr">▸</span> Log</span><span class="tail" id="ogx3-t-log"></span></div><div class="sec-b">
            <div class="line"><button id="ogx3-copy" class="ogx3-btn">Kopiuj</button><button id="ogx3-clear" class="ogx3-btn">Wyczyść</button></div>
            <div id="ogx3-log"></div>
          </div></div>
        </div>`;
      document.body.appendChild(d); this.el = d;
      const $ = (id) => document.getElementById(id);

      // ── pozycja, zwinięcie i otwarte sekcje przeżywają przeładowanie ────────
      const pos = Store.get("ui_pos", null);
      if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        const maxL = Math.max(0, (window.innerWidth || 1200) - 60), maxT = Math.max(0, (window.innerHeight || 800) - 40);
        d.style.left = Math.min(Math.max(0, pos.left), maxL) + "px";
        d.style.top = Math.min(Math.max(0, pos.top), maxT) + "px";
      }
      const open = new Set(Store.get("ui_open", []) || []);
      for (const sec of d.querySelectorAll(".sec")) {
        if (open.has(sec.dataset.sec)) { sec.classList.add("open"); sec.querySelector(".arr").textContent = "▾"; }
        sec.querySelector(".sec-t").onclick = () => {
          const on = sec.classList.toggle("open");
          sec.querySelector(".arr").textContent = on ? "▾" : "▸";
          const s = new Set(Store.get("ui_open", []) || []);
          on ? s.add(sec.dataset.sec) : s.delete(sec.dataset.sec);
          Store.set("ui_open", [...s]);
          if (on && sec.dataset.sec === "jr") this.renderJournal();
        };
      }
      this.setMin(Store.get("ui_min", false) === true);
      $("ogx3-min").onclick = () => this.setMin(!(Store.get("ui_min", false) === true));

      // przeciąganie za nagłówek (pozycja zapisana po puszczeniu myszy)
      { let drag = false, sx = 0, sy = 0, sl = 0, st = 0;
        $("ogx3-hd").addEventListener("mousedown", (e) => { if (e.target.closest("button, .min")) return; const r = d.getBoundingClientRect(); drag = true; sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top; e.preventDefault(); });
        document.addEventListener("mousemove", (e) => { if (!drag) return; d.style.left = (sl + e.clientX - sx) + "px"; d.style.top = (st + e.clientY - sy) + "px"; d.style.right = "auto"; });
        document.addEventListener("mouseup", () => { if (!drag) return; drag = false; const r = d.getBoundingClientRect(); Store.set("ui_pos", { left: Math.round(r.left), top: Math.round(r.top) }); }); }

      $("ogx3-on").onclick = () => { CFG.enabled = !CFG.enabled; saveCfg(); if (CFG.enabled) Store.set("last_tick", Date.now()); log(`Bot ${CFG.enabled ? "ON" : "OFF"}`, "info"); this.renderStatus(); };
      $("ogx3-auto").onclick = () => { CFG.autoRescue = !CFG.autoRescue; saveCfg(); log(`Auto-ratunek ${CFG.autoRescue ? "ON — bot RUSZA flotą" : "OFF — obserwator"}`, "warn"); this.renderStatus(); };
      $("ogx3-h2m").onclick = () => { CFG.homeToMoon = !CFG.homeToMoon; saveCfg(); log(CFG.homeToMoon ? "Zwożenie floty planeta→księżyc: ON (bot będzie konsolidował flotę)" : "Zwożenie floty planeta→księżyc: OFF — flota rusza się tylko przy ataku (i wraca po ratunku)", "warn"); this.renderStatus(); };
      $("ogx3-push").onclick = () => { Store.set("ntfy_on", !Notifier.enabled()); this.renderStatus(); };
      $("ogx3-voice").onclick = () => { Store.set("voice_on", !Store.get("voice_on", false)); this.renderStatus(); };
      // v3.19.0: trzy stany zamiast dwóch — „tylko flota" (domyślny), „wszystkie", OFF.
      $("ogx3-recon").onclick = () => {
        const cur = !CFG.recon ? "off" : (CFG.reconMode === "all" ? "all" : "fleet");
        const next = cur === "fleet" ? "all" : cur === "all" ? "off" : "fleet";
        CFG.recon = next !== "off"; CFG.reconMode = next === "all" ? "all" : "fleet"; saveCfg();
        log(next === "fleet" ? "Rekonesans: TYLKO ciała z flotą (bot nie objeżdża pustych planet)"
          : next === "all" ? "Rekonesans: WSZYSTKIE ciała po kolei (będzie przełączał planety)"
          : "Rekonesans OFF — bot nie będzie wiedział, gdzie stoi flota", next === "off" ? "warn" : "info");
        this.renderStatus();
      };
      $("ogx3-deb").onclick = () => { CFG.debris.enabled = !CFG.debris.enabled; saveCfg(); log(`Zbieranie złomu ${CFG.debris.enabled ? "ON" : "OFF"}`, "info"); this.renderStatus(); };
      $("ogx3-quiet").onclick = () => { CFG.stealth.enabled = !CFG.stealth.enabled; saveCfg(); log(CFG.stealth.enabled ? `Tryb cichy ON — kolonie odpytywane raz na ${CFG.stealth.colonyHours || 8} h (mniej śladów aktywności w galaktyce).` : "Tryb cichy OFF — zwiad kolonii co 45 min (świeższe hangary, więcej śladów).", "info"); this.renderStatus(); };
      $("ogx3-aster").onclick = () => { CFG.aster.enabled = !CFG.aster.enabled; saveCfg(); log(`Mining asteroid ${CFG.aster.enabled ? "ON" : "OFF"}`, "info"); this.renderStatus(); };
      $("ogx3-bonus").onclick = () => { CFG.bonus.enabled = !CFG.bonus.enabled; saveCfg(); log(`Bonus online ${CFG.bonus.enabled ? "ON — bot odbiera antymaterię i punkty Akademii" : "OFF"}`, "info"); this.renderStatus(); };
      $("ogx3-moon").onclick = () => { CFG.moon.enabled = !CFG.moon.enabled; saveCfg(); log(`Stawianie księżyców ${CFG.moon.enabled ? `ON — bot WYDA do ${Math.round(CFG.moon.maxMetalShare * 100)}% metalu na księżyc` : "OFF"}`, CFG.moon.enabled ? "warn" : "info"); this.renderStatus(); };
      $("ogx3-moon-share").value = String(Math.round((CFG.moon.maxMetalShare || .25) * 100));
      $("ogx3-moon-share").onchange = (e) => { CFG.moon.maxMetalShare = Math.max(0.01, Math.min(1, (parseInt(e.target.value) || 25) / 100)); saveCfg(); this.renderStatus(); };
      // v3.14.0: ekspedycje domyślnie startują z AKTYWNEJ planety — a to znaczy
      // „z tej, na której akurat klikasz". Pole przypina jedno ciało na stałe.
      { const lf = CFG.expo.launchFrom; $("ogx3-expo-from").value = lf ? `${lf.galaxy}:${lf.system}:${lf.position}` : ""; }
      $("ogx3-expo-from").onchange = (e) => {
        const v = String(e.target.value || "").trim();
        if (!v) { CFG.expo.launchFrom = null; saveCfg(); log("[EXPO] ekspedycje startują z aktywnej planety (pole puste).", "info"); return; }
        const m = v.match(/^(\d+)\s*[:.]\s*(\d+)\s*[:.]\s*(\d+)$/);
        if (!m) { alert("Wpisz koordynaty w formacie g:s:p, np. 1:217:6"); e.target.value = ""; return; }
        CFG.expo.launchFrom = { galaxy: +m[1], system: +m[2], position: +m[3] }; saveCfg();
        log(`[EXPO] ekspedycje startują odtąd z [${m[1]}:${m[2]}:${m[3]}] — niezależnie od tego, gdzie klikasz.`, "info");
      };
      // v3.32.0 (pytanie właściciela 29.08: „jak wyłączyć nocną przerwę?"):
      // cisza nocna i przerwy kawowe siedziały wyłącznie w kodzie — jedyną drogą
      // do ich zdjęcia było grzebanie w GM storage. Teraz obie są w panelu.
      $("ogx3-quiet").onclick = () => { CFG.quietHours.enabled = !CFG.quietHours.enabled; saveCfg(); log(`Cisza nocna ekonomii ${CFG.quietHours.enabled ? `ON (${CFG.quietHours.startHour}:00–${CFG.quietHours.endHour}:00 ±20 min)` : "OFF — ekonomia pracuje całą dobę"}`, "info"); this.renderStatus(); };
      $("ogx3-quiet-a").value = String(CFG.quietHours.startHour); $("ogx3-quiet-a").onchange = (e) => { CFG.quietHours.startHour = Math.max(0, Math.min(23, parseInt(e.target.value) || 23)); saveCfg(); this.renderStatus(); };
      $("ogx3-quiet-b").value = String(CFG.quietHours.endHour); $("ogx3-quiet-b").onchange = (e) => { CFG.quietHours.endHour = Math.max(0, Math.min(23, parseInt(e.target.value) || 5)); saveCfg(); this.renderStatus(); };
      // Wyłączenie przerw kasuje także tę TRWAJĄCĄ — inaczej „OFF" zaczynałoby
      // działać dopiero po kwadransie i wyglądało jak niedziałający przycisk.
      $("ogx3-breaks").onclick = () => { CFG.human.breaks = !CFG.human.breaks; Store.set("break_until", 0); Store.set("break_next", 0); saveCfg(); log(`Przerwy „kawowe" ${CFG.human.breaks ? `ON (co ${CFG.human.breakEveryMinMin}–${CFG.human.breakEveryMaxMin} min na ${CFG.human.breakLenMinMin}–${CFG.human.breakLenMaxMin} min)` : "OFF — ekonomia bez przerw"}`, "info"); this.renderStatus(); };
      // v3.51.0 (owner 15:07: „nie musi czekać aż przestanę klikać"): próg bramki „grasz"
      // jest jawny w panelu — 0 = fale lecą od razu, N = czekaj N minut ciszy.
      $("ogx3-idle").value = String(Math.round((CFG.human.ecoIdleSec ?? 0) / 60));
      $("ogx3-idle").onchange = (e) => { const m2 = Math.max(0, Math.min(60, parseInt(e.target.value) || 0)); CFG.human.ecoIdleSec = m2 * 60; saveCfg(); log(m2 > 0 ? `Ekonomia czeka ${m2} min ciszy po Twoim kliknięciu, zanim ruszy falą.` : "Ekonomia NIE czeka, aż przestaniesz klikać — fala może przejąć kartę w trakcie gry.", "info"); this.renderStatus(); };
      $("ogx3-fs").onclick = () => { CFG.fs.enabled = !CFG.fs.enabled; saveCfg(); log(`Fleet Save nocny ${CFG.fs.enabled ? `ON (${CFG.fs.startHour}:00–${CFG.fs.endHour}:00)` : "OFF"}`, "info"); this.renderStatus(); };
      $("ogx3-fs-a").value = String(CFG.fs.startHour); $("ogx3-fs-a").onchange = (e) => { CFG.fs.startHour = Math.max(0, Math.min(23, parseInt(e.target.value) || 23)); saveCfg(); this.renderStatus(); };
      $("ogx3-fs-b").value = String(CFG.fs.endHour); $("ogx3-fs-b").onchange = (e) => { CFG.fs.endHour = Math.max(0, Math.min(23, parseInt(e.target.value) || 7)); saveCfg(); this.renderStatus(); };
      $("ogx3-expo").onclick = () => {
        CFG.expo.enabled = !CFG.expo.enabled; saveCfg();
        // v3.16.0: włączenie modułu ręcznie kasuje trwającą przerwę kawową — operator
        // właśnie powiedział, czego chce, a przerwa i tak dotyczy tylko ekonomii.
        if (CFG.expo.enabled && Human.onBreak()) { Store.set("break_until", 0); Store.set("break_next", Date.now() + jitter(CFG.human.breakEveryMinMin, CFG.human.breakEveryMaxMin) * 60e3); log("[PRZERWA] przerwana ręcznie — włączyłeś ekspedycje.", "info"); }
        log(`Ekspedycje ${CFG.expo.enabled ? "ON" : "OFF"}`, "info"); this.renderStatus();
      };
      $("ogx3-disc").onclick = () => { CFG.expo.discoverer40 = !CFG.expo.discoverer40; saveCfg(); log(`Odkrywca (40 min) ${CFG.expo.discoverer40 ? "ON" : "OFF — ekspedycje na " + CFG.expo.holdingHours + " h"}`, "info"); this.renderStatus(); };
      $("ogx3-waves").value = String(CFG.expo.waves); $("ogx3-waves").onchange = (e) => { CFG.expo.waves = Math.max(1, parseInt(e.target.value) || 1); saveCfg(); Store.del("burst"); log(`Fale ekspedycji: ${CFG.expo.waves} (seria liczona od nowa)`, "info"); };
      $("ogx3-slotres").value = String(CFG.expo.slotReserve); $("ogx3-slotres").onchange = (e) => { CFG.expo.slotReserve = Math.max(0, parseInt(e.target.value) || 0); saveCfg(); };
      $("ogx3-res").value = String(CFG.deutReserve || 0); $("ogx3-res").onchange = (e) => { CFG.deutReserve = parseInt(String(e.target.value).replace(/[^\d]/g, "")) || 0; saveCfg(); log(`Rezerwa deuteru: ${CFG.deutReserve.toLocaleString("pl-PL")}`, "info"); };
      $("ogx3-spd").value = String(CFG.airSpeedPct); $("ogx3-spd").onchange = (e) => { CFG.airSpeedPct = Math.max(1, Math.min(100, parseInt(e.target.value) || 10)); saveCfg(); };
      const sim = (body) => { const a = PlanetBar.active(); if (!a) return alert("Nie widzę aktywnej planety."); Store.set("sim", { key: a.key, body, arriveAt: Date.now() + 150e3, until: Date.now() + 180e3 }); log(`[TEST] symulacja: atak na ${body === "moon" ? "KSIĘŻYC" : "PLANETĘ"} [${a.key}], dolot 150 s. Auto-ratunek: ${CFG.autoRescue ? "ON (flota poleci!)" : "OFF (tylko decyzja w logu)"}`, "error"); defenceTick(); };
      $("ogx3-sim-moon").onclick = () => sim("moon"); $("ogx3-sim-planet").onclick = () => sim("planet");
      $("ogx3-dump").onclick = () => { const ev = document.querySelector("#fleet-movement-content, #layoutFleetMovements"); log(`[DOM] pasek planet: ${JSON.stringify(PlanetBar.pairs().slice(0, 6))} … aktywne: ${JSON.stringify(PlanetBar.active())}`, "info"); log(`[DOM] pasek misji: ${JSON.stringify(Bar.read())}`, "info"); log(`[DOM] Events (${ev ? "jest" : "BRAK"}): ${(ev?.outerHTML || "").replace(/\s+/g, " ").slice(0, 2500)}`, "info"); if (page() === "fleet") log(`[DOM] hangar: ${JSON.stringify(Hangar.scan())}`, "info"); };
      $("ogx3-report").onclick = () => { Calib.collect(); const r = Calib.report(); navigator.clipboard?.writeText(r).then(() => log("[KALIBRACJA] raport skopiowany do schowka — wklej go Claude'owi.", "success"), () => log(r, "info")); };
      $("ogx3-pushtest").onclick = () => Notifier.push("Test OGameX 3", "Powiadomienia działają. Temat: " + Notifier.topic(), "default", "white_check_mark");
      $("ogx3-abort").onclick = () => Fly.abort("operator");
      // Ręczna dźwignia na wypadek, gdy bot NIE WIDZI ataku (ślepy pasek, nieznany
      // markup) albo operator zwyczajnie wie lepiej. Używa tej samej decyzji co
      // automat — podstawiamy wirtualne zagrożenie w ciało, gdzie stoi flota.
      $("ogx3-save").onclick = async () => {
        const s0 = Situation.load(); const a0 = s0.active;
        if (!a0) return alert("Nie widzę aktywnej planety — otwórz przegląd i spróbuj ponownie.");
        const f = Situation.fleetAt(s0, a0.key, Date.now());
        if (!f) return alert(`Nie widzę floty na [${a0.key}] — wejdź raz na zakładkę Fleet, żeby bot odczytał hangar.`);
        const virt = JSON.parse(JSON.stringify(s0));
        virt.threats = [{ id: "manual", dst: a0.key, dstBody: f.body, arriveAt: Date.now() + 5 * 60e3, attack: true, spy: false, seenAt: 0, source: "operator", type: "ATTACK" }];
        const { actions } = decide(virt, CFG, Date.now());
        const act = actions.find(x => x.kind === "fly");
        if (!act) return alert("Nie mam dokąd uciec (jedyna kolonia albo wszystko atakowane). Zobacz log.");
        log(`[OPERATOR] ręczny ratunek: ${act.why}`, "warn");
        if (Fly.start({ ...act, why: "RĘCZNY ratunek operatora" })) { await Fly.tick(); }
      };
      $("ogx3-home").onclick = async () => {
        const s0 = Situation.load();
        const f = (s0.flights || []).find(x => ["launched", "recall_clicked", "recall_failed"].includes(x.phase));
        if (f) { log(`[OPERATOR] ręczny zawrót lotu [${f.fromKey}]→[${f.toKey}]`, "warn"); await Fly.recall(f); return; }
        const a0 = s0.active;
        const home = a0 && (s0.pairs || {})[a0.key];
        const fleet = a0 ? Situation.fleetAt(s0, a0.key, Date.now()) : null;
        if (home && home.hasMoon && fleet && fleet.body === "planet") {
          log("[OPERATOR] ręczny powrót planeta → księżyc", "warn");
          if (Fly.start({ kind: "home", fromKey: a0.key, fromBody: "planet", toKey: a0.key, toBody: "moon", why: "RĘCZNY powrót na księżyc", speed: 100, home: true })) await Fly.tick();
          return;
        }
        alert("Nie widzę lotu do zawrócenia ani floty na planecie pary z księżycem. Sprawdź panel — „Szczegóły stanu”, pole „Loty”.");
      };
      $("ogx3-copy").onclick = () => { const t = logEntries.map(e => `[${e.time}] [${e.type.toUpperCase()}] ${e.msg}`).join("\n"); navigator.clipboard?.writeText(t); };
      $("ogx3-clear").onclick = () => { logEntries = []; Store.set("log", []); this.renderLog(); };
      this.renderStatus(); this.renderLog();
    },
    // Zwinięty panel = sam nagłówek (pasek stanu też znika — właściciel chciał
    // móc go zupełnie usunąć z drogi). Alarm rozwija panel z powrotem.
    setMin(on) {
      Store.set("ui_min", !!on);
      const b = document.getElementById("ogx3-body"), s = document.getElementById("ogx3-strip"), m = document.getElementById("ogx3-min");
      if (b) b.style.display = on ? "none" : "block";
      if (s) s.style.display = on ? "none" : "block";
      if (m) { m.textContent = on ? "▫" : "_"; m.title = on ? "Rozwiń panel" : "Zwiń panel"; }
    },
    setRow(id, cls, text) {
      const el = document.getElementById(id); if (!el) return;
      el.className = "row" + (cls ? " " + cls : "");
      el.querySelector(".val").textContent = text;
    },
    renderJournal() {
      const el = document.getElementById("ogx3-journal"); if (!el) return;
      const j = (Store.get("journal", []) || []).slice(0, 25);
      el.innerHTML = j.length
        ? j.map(e => `<div class="jr ${e.kind}"><b>${new Date(e.at).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })} ${e.kind}</b> ${String(e.msg).replace(/</g, "&lt;")}</div>`).join("")
        : `<div class="jr">(pusto — bot nic jeszcze nie zgłosił)</div>`;
    },
    renderStatus() {
      if (!this.el) return; const $ = (id) => document.getElementById(id);
      const s = Situation.load(); const now = Date.now();
      const th = (s.threats || []).filter(t => t.arriveAt > now);
      const atk = th.filter(t => t.attack);

      // ── nagłówek i przełączniki ──────────────────────────────────────────
      $("ogx3-on").textContent = CFG.enabled ? "ON" : "OFF"; $("ogx3-on").style.background = CFG.enabled ? "#27ae60" : "#e74c3c";
      $("ogx3-auto").textContent = CFG.autoRescue ? "Auto-ratunek ON" : "Obserwator (bez ruchu)"; $("ogx3-auto").style.background = CFG.autoRescue ? "#1e6b3a" : "#5a4a1e";
      { const lf0 = CFG.expo && CFG.expo.launchFrom ? `${CFG.expo.launchFrom.galaxy}:${CFG.expo.launchFrom.system}:${CFG.expo.launchFrom.position}` : null;
        const mode = !CFG.recon ? "OFF" : (CFG.reconMode === "all" ? "wszystkie" : (lf0 ? `tylko [${lf0}]` : "tylko flota"));
        $("ogx3-recon").textContent = `Rekonesans: ${mode}`;
        $("ogx3-recon").style.background = CFG.recon ? "rgba(255,255,255,.1)" : "#6b1e1e"; }
      $("ogx3-h2m").textContent = CFG.homeToMoon ? "Zwożenie na księżyc ON" : "Flota rusza się TYLKO przy ataku";
      $("ogx3-h2m").style.background = CFG.homeToMoon ? "#5a4a1e" : "#1e6b3a";
      $("ogx3-push").textContent = `Push ${Notifier.enabled() ? "ON" : "OFF"}`;
      $("ogx3-voice").textContent = `Głos ${Store.get("voice_on", false) ? "ON" : "OFF"}`;
      $("ogx3-deb").textContent = `Złom ${CFG.debris.enabled ? "ON" : "OFF"}`; $("ogx3-deb").style.background = CFG.debris.enabled ? "#1e6b3a" : "rgba(255,255,255,.1)";
      $("ogx3-quiet").textContent = CFG.stealth && CFG.stealth.enabled ? `Tryb cichy ON (kolonie co ${CFG.stealth.colonyHours || 8} h)` : "Tryb cichy OFF (kolonie co 45 min)";
      $("ogx3-quiet").style.background = CFG.stealth && CFG.stealth.enabled ? "#1e6b3a" : "rgba(255,255,255,.1)";
      $("ogx3-aster").textContent = `Mining ${CFG.aster.enabled ? "ON" : "OFF"}`; $("ogx3-aster").style.background = CFG.aster.enabled ? "#1e6b3a" : "rgba(255,255,255,.1)";
      $("ogx3-bonus").textContent = `Bonus ${CFG.bonus.enabled ? "ON" : "OFF"}`; $("ogx3-bonus").style.background = CFG.bonus.enabled ? "#1e6b3a" : "rgba(255,255,255,.1)";
      { const b0 = Bonus.st(); $("ogx3-bonus-st").textContent = CFG.bonus.enabled ? `bonus online: dziś ${Bonus.today(b0)}${b0.claims && b0.claims.length ? ` · ostatni ${new Date(b0.claims[b0.claims.length - 1]).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}` : ""}` : ""; }
      $("ogx3-moon").textContent = `Księżyce ${CFG.moon.enabled ? "ON" : "OFF"}`; $("ogx3-moon").style.background = CFG.moon.enabled ? "#5a4a1e" : "rgba(255,255,255,.1)";
      { const s1 = Situation.load(); const bez = Object.entries(s1.pairs || {}).filter(([, p]) => !p.hasMoon).length;
        $("ogx3-moon-st").textContent = CFG.moon.enabled ? `planet bez księżyca: ${bez} · WYDAJE METAL` : `planet bez księżyca: ${bez} (moduł wyłączony)`; }
      $("ogx3-quiet").textContent = `Cisza nocna ${CFG.quietHours.enabled ? "ON" : "OFF"}`; $("ogx3-quiet").style.background = CFG.quietHours.enabled ? "#1e6b3a" : "rgba(255,255,255,.1)";
      // v3.50.1: pełna etykieta — owner szukał „przerwy kawowej" i nie kojarzył skrótu „Przerwy".
      $("ogx3-breaks").textContent = `Przerwy kawowe ${CFG.human.breaks ? "ON" : "OFF"}`; $("ogx3-breaks").style.background = CFG.human.breaks ? "#1e6b3a" : "rgba(255,255,255,.1)";
      $("ogx3-human-st").textContent = (CFG.quietHours.enabled || CFG.human.breaks)
        ? `ekonomia śpi: ${[CFG.quietHours.enabled ? `${CFG.quietHours.startHour}:00–${CFG.quietHours.endHour}:00` : null, CFG.human.breaks ? (Human.onBreak() ? `przerwa (~${Human.breakLeftMin()} min)` : "przerwy co " + CFG.human.breakEveryMinMin + "–" + CFG.human.breakEveryMaxMin + " min") : null].filter(Boolean).join(" · ")} (obrona czuwa zawsze)`
        : "ekonomia pracuje całą dobę, bez przerw";
      $("ogx3-fs").textContent = `FS ${CFG.fs.enabled ? "ON" : "OFF"}`; $("ogx3-fs").style.background = CFG.fs.enabled ? "#1e6b3a" : "rgba(255,255,255,.1)";
      $("ogx3-expo").textContent = `Ekspedycje ${CFG.expo.enabled ? "ON" : "OFF"}`; $("ogx3-expo").style.background = CFG.expo.enabled ? "#1e6b3a" : "rgba(255,255,255,.1)";
      $("ogx3-disc").textContent = `Odkrywca 40 min ${CFG.expo.discoverer40 ? "ON" : "OFF"}`;
      $("ogx3-topic").textContent = Notifier.topic();

      // ── PASEK STANU: pięć linii = pięć odpowiedzi bez klikania ───────────
      const night = nightWindow(CFG.fs, new Date());
      const aster = Store.get("aster", {}) || {};
      const burst = Store.get("burst", null);
      const eSl = s.slots?.expo, fSl = s.slots?.fleet;
      const m = Fly.mission();
      const flights = (s.flights || []);

      if (Session.lostRecently()) this.setRow("ogx3-r-def", "alert", "SESJA WYGASŁA — zaloguj się");
      else if (!CFG.enabled) this.setRow("ogx3-r-def", "dim", "bot WYŁĄCZONY");
      else if (atk.length) this.setRow("ogx3-r-def", "alert", atk.map(t => `ATAK → [${t.dst}] ${t.dstBody === "moon" ? "☾" : "◍"} ${Math.max(0, Math.round((t.arriveAt - now) / 1000))}s`).join(" · "));
      else if (th.length) this.setRow("ogx3-r-def", "busy", `sonda → [${th[0].dst}] ${Math.max(0, Math.round((th[0].arriveAt - now) / 1000))}s`);
      // v3.40.0 (audyt obrony 30.08): w 3.39.0 ostrzeżenie o zwiniętej liście lotów
      // ZASŁANIAŁO stan obrony — operator przestał widzieć najważniejszą informację
      // w całym panelu („czy jest czysto"). Ostrzeżenie idzie OBOK stanu, nigdy zamiast.
      else {
        // v3.42.0: „lista lotów zwinięta" było MYLĄCE — panel Events nie jest zwinięty,
        // tylko pusty, i nie da się go rozwinąć. Prawda brzmi: ataki na kolonie inne niż
        // aktywna są dla bota niewidoczne. Operator ma to widzieć wprost.
        const slepy = !!(Store.get("events_open", null) || {}).dumped;
        const ile = Math.max(0, Object.keys(s.pairs || {}).length - 1);
        this.setRow("ogx3-r-def", slepy ? "busy" : (CFG.autoRescue ? "ok" : "busy"),
          `czysto · ${CFG.autoRescue ? "auto-ratunek" : "obserwator"}${slepy ? ` · ⚠ ${ile} kolonii bez nadzoru` : ""}`);
      }
      this.el.classList.toggle("alarm", atk.length > 0 || Session.lostRecently());
      if (atk.length && Store.get("ui_min", false) === true) this.setMin(false);   // alarm rozwija panel

      { const a0 = s.active;
        const h = a0 ? Situation.fleetAt(s, a0.key, now) : null;
        const air = flights.filter(f => ["launched", "recall_clicked", "recall_failed"].includes(f.phase));
        if (m) this.setRow("ogx3-r-fleet", "busy", `MISJA ${m.step} [${m.fromKey}]→[${m.toKey}]`);
        else if (air.length) this.setRow("ogx3-r-fleet", "busy", `w powietrzu: [${air[0].fromKey}]→[${air[0].toKey}] ${air[0].phase}`);
        else if (h) this.setRow("ogx3-r-fleet", "ok", `[${a0.key}] ${h.body === "moon" ? "☾" : "◍"} ${h.total.toLocaleString("pl-PL")} szt.`);
        else this.setRow("ogx3-r-fleet", "dim", a0 ? `[${a0.key}] — wejdź na Fleet` : "nie widzę planety"); }

      // v3.20.0: Athena pokazywała „następna fala za ~Ns" — bez tego nie wiadomo,
      // czy bot czeka, czy stoi. Powód bierzemy z tej samej funkcji, która decyduje.
      const expoNext = (() => {
        if (!CFG.expo.enabled) return "OFF";
        try {
          const why = Human.economyAllowed(s);
          if (why) return why.startsWith("przerwa") ? why : why.slice(0, 22);
          const rr = Store.get("expo_rest", null);
          if (rr && rr.until > now) return `przerwa między seriami ${Math.ceil((rr.until - now) / 60000)} min`;
          const p = expoPlan(s, CFG, now, burst);
          if (p && p.skip) {
            if (/odstęp między falami/.test(p.skip) && burst && burst.lastSendAt) {
              const left = Math.max(0, (burst.lastSendAt + (burst.gapMs || 0)) - now);
              return `następna za ${Math.ceil(left / 1000)} s`;
            }
            if (/czekam na powroty|ekspedycje \d/.test(p.skip)) return p.skip.replace("— czekam na powroty", "").trim();   // v3.22.0: NIE ukrywamy "(limit fal N)" — to jedyne miejsce, gdzie widac, ze bot blokuje sie wlasnym ustawieniem
            if (/rekonesans/.test(p.skip)) return "czekam na odczyt hangaru";
            return p.skip.slice(0, 26);
          }
          return "fala gotowa";
        } catch { return ""; }
      })();
      { const st = `${eSl ? eSl.used + "/" + eSl.total : "?"} · fl ${fSl ? fSl.used + "/" + fSl.total : "?"}${expoNext ? " · " + expoNext : ""}`;
        this.setRow("ogx3-r-expo", CFG.expo.enabled ? "ok" : "dim", CFG.expo.enabled ? st : `OFF · ${st}`);
        $("ogx3-expo-st").textContent = `sloty: expo ${eSl ? eSl.used + "/" + eSl.total : "?"}, floty ${fSl ? fSl.used + "/" + fSl.total : "?"}${burst && burst.sent ? ` · seria ${burst.sent}/${burst.waves}` : ""}`;
        $("ogx3-t-expo").textContent = CFG.expo.enabled ? (CFG.expo.discoverer40 ? "ON · 40 min" : "ON") : "OFF"; }

      // v3.52.0: rejestr powrotów w panelu — operator widzi to samo, co obrona.
      { const exp = (s.expected || []).filter(e => !e.pending && e.returnAt > now).sort((a, b) => a.returnAt - b.returnAt);
        const sum = exp.reduce((t, e) => t + (e.total || 0), 0);
        this.setRow("ogx3-r-ret", exp.length ? "ok" : "dim", exp.length
          ? `${exp.length} lot(y), ${sum.toLocaleString("pl-PL")} szt. · najbliższy ${new Date(exp[0].returnAt).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}`
          : "nic nie wraca"); }

      { const txt = CFG.aster.enabled ? `zakresy ${(aster.ranges || []).length}${aster.sentTo ? ` · ost. [${aster.sentTo}]` : ""}` : "wyłączony";
        this.setRow("ogx3-r-min", CFG.aster.enabled ? "ok" : "dim", txt);
        $("ogx3-aster-st").textContent = CFG.aster.enabled ? `zakresy: ${(aster.ranges || []).length}${aster.sentTo ? ` · ostatnio: [${aster.sentTo}]` : ""}` : "";
        $("ogx3-t-eco").textContent = `${CFG.aster.enabled ? "M ON" : "M OFF"} · ${CFG.debris.enabled ? "Z ON" : "Z OFF"}`; }

      { const fsTxt = !CFG.fs.enabled ? "wyłączony" : (night.active ? `NOC — zawrót ${new Date(night.endsAt).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}` : `dzień (${night.nowHM}) · ${CFG.fs.startHour}:00–${CFG.fs.endHour}:00`);
        this.setRow("ogx3-r-fs", !CFG.fs.enabled ? "dim" : (night.active ? "busy" : "ok"), fsTxt);
        $("ogx3-fs-st").textContent = fsTxt;
        $("ogx3-t-fs").textContent = CFG.fs.enabled ? `${CFG.fs.startHour}–${CFG.fs.endHour}` : "OFF"; }

      $("ogx3-t-def").textContent = CFG.autoRescue ? "auto-ratunek" : "obserwator";
      { const j = (Store.get("journal", []) || [])[0];
        $("ogx3-t-jr").textContent = j ? `${new Date(j.at).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })} ${j.kind}` : "pusto";
        if (this.el.querySelector('.sec[data-sec="jr"]')?.classList.contains("open")) this.renderJournal(); }

      // ── szczegóły (zwinięte): pełny stan jak w 3.10.x ────────────────────
      const fleetsTxt = Object.entries(s.hangars || {}).filter(([, h]) => h.total > 0 && now - h.at < 48 * 3600e3).sort((a, b) => b[1].total - a[1].total).slice(0, 4).map(([k, h]) => `${k.replace("|", " ")}: ${h.total.toLocaleString("pl-PL")} (${new Date(h.at).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })})`).join("\n  ");
      const fl = flights.map(f => `${f.kind} [${f.fromKey}]→[${f.toKey}] ${f.phase}${f.recallAt ? " zawrót " + new Date(f.recallAt).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : ""}`).join("\n  ");
      $("ogx3-status").textContent = `Aktywne: ${s.active ? `${s.active.body} [${s.active.key}]` : "?"} · pary: ${Object.keys(s.pairs || {}).length} · pasek: ${s.bar ? `${s.bar.foreign} obcych${s.bar.barType ? " (" + s.bar.barType + ")" : ""}` : "?"}\nZagrożenia: ${th.length ? th.map(t => `${t.attack ? "ATAK" : "sonda"} → [${t.dst}] ${t.dstBody || "?"} za ${Math.round((t.arriveAt - now) / 1000)}s`).join("; ") : "brak"}\nHangary:\n  ${fleetsTxt || "(wejdź na Fleet)"}\nLoty: ${fl ? "\n  " + fl : "brak"}${m ? `\nMISJA: ${m.step} [${m.fromKey}]→[${m.toKey}]` : ""}${Session.lostRecently() ? "\nSESJA WYGASŁA" : ""}`;
    },
    renderLog() {
      const el = document.getElementById("ogx3-log");
      const tail = document.getElementById("ogx3-t-log");
      if (tail) tail.textContent = logEntries[0] ? `${logEntries[0].time} ${logEntries[0].msg}`.slice(0, 42) : "pusto";
      if (!el) return;
      const col = { error: "#ff7b7b", warn: "#ffd56b", success: "#7bff9b", info: "#dfe8f5" };
      el.innerHTML = logEntries.slice(0, 150).map(e => `<div style="color:${col[e.type] || "#dfe8f5"}">${e.time} ${e.msg.replace(/</g, "&lt;")}</div>`).join("");
    },
  };

  // ═══ START ══════════════════════════════════════════════════════════════
  // Eksport do testów (node): globalThis.OGX3 gdy brak DOM.
  if (typeof document === "undefined" || typeof window === "undefined") { globalThis.OGX3 = { decide, Situation, Bar, Rows, DEFAULTS }; return; }
  // eksport do testu E2E (test3-e2e.js uruchamia TEN kod na sztucznej grze w jsdom)
  // busy(): czy defenceTick WŁAŚNIE trwa — startowy tick odpala się bez await, więc
  // harness E2E musi umieć poczekać, aż bot skończy krok, zamiast zgadywać stałym sleepem.
  try { window.__OGX3 = { decide, Situation, Bar, Rows, Fly, CFG, Store, defenceTick, expoPlan, barExcessState, PlanetBar, Hangar, UI, Recon, Human, busy: () => running }; } catch {}
  Store.set("last_load", Date.now());
  // v3.40.0: flaga „nie umiem rozwinąć listy lotów" nie może przeżyć aktualizacji —
  // każda nowa wersja przynosi nowych kandydatów do kliknięcia i musi dostać czystą kartę.
  // v3.43.1: przy nowej wersji kasujemy ZATRZASKI diagnostyki. Sonda listy zapisała
  // 20:05:53 werdykt `done: true, works: true` na podstawie fałszywego alarmu (błąd
  // poprawiony w 3.42.1) — i przez ten zatrzask NIGDY BY SIĘ JUŻ NIE URUCHOMIŁA,
  // zostawiając w stanie bzdurę. Nowa wersja = czysta karta dla obu latch-y.
  { const pv = Store.get("ver", ""); if (pv !== VERSION) { Store.set("ver", VERSION); Store.del("events_open"); Store.del("mv_probe"); Store.del("re_probe"); Store.del("expo_rest");   // mv/re_probe: sprzątanie po usuniętych sondach
      // v3.51.0: stare domyślne 5 min bramki „grasz" migrujemy na 0 (owner 31.08 15:07:
      // „nie musi czekać aż przestanę klikać"); wartość ustawiona ręcznie inaczej zostaje.
      if (CFG.human && CFG.human.ecoIdleSec === 300) { CFG.human.ecoIdleSec = 0; saveCfg(); }
  } }
  // v3.9.0 (audyt): wyjątek w kodzie startowym oznaczał, że setInterval(defenceTick)
  // nigdy się nie zarejestruje — panel wygląda żywo, bot nie żyje. Każdy krok osobno.
  try { UI.build(); } catch (e) { console.error("[OGX3] panel:", e); }
  // v3.12.0: linia startowa bez adresu była bezużyteczna przy pętli przeładowań
  // (28.08 22:17: dziesięć identycznych linii i zero wiedzy, co je wywołało).
  {
    const nl = Store.get("nav_last", null);
    const fresh = nl && Date.now() - nl.at < 20e3;
    log(`OGameX Assistant 3 v${VERSION} — ${CFG.enabled ? "ON" : "OFF"}, ${CFG.autoRescue ? "AUTO-RATUNEK" : "OBSERWATOR"}, ${location.pathname}${location.search || ""}${fresh ? ` ← bot: ${nl.why}` : " ← otwarte ręcznie"}`, "info");
    // v3.39.0 (log 30.08 08:49–08:50): jedna nawigacja bota tłumaczyła KAŻDE
    // przeładowanie przez następne 20 s — także te, które operator wyklikał sam.
    // Cztery strony pod rząd dostawały etykietę „bot: keepalive", a detektor [TEMPO]
    // zgłaszał nieistniejącą pętlę. Nawigacja bota powoduje dokładnie JEDNO
    // przeładowanie, więc jej ślad zużywa się po pierwszym użyciu.
    if (fresh) { try { Store.del("nav_last"); } catch {} }
    const loads = (Store.get("loads", []) || []).filter(x => Date.now() - (x.t || x) < 60e3).map(x => (typeof x === "number" ? { t: x, bot: false } : x));
    loads.push({ t: Date.now(), bot: !!fresh, why: fresh ? String(nl.why || "") : "" }); Store.set("loads", loads.slice(-20));
    // v3.20.0: normalna wysyłka floty to 4 przeładowania pod rząd (przełącz ciało →
    // formularz → wysyłka → potwierdzenie) i alarm zapalał się na NIEJ (29.08 11:05).
    // Pętla to nie „dużo nawigacji", tylko TEN SAM powód w kółko.
    const bots = loads.filter(x => x.bot);
    const same = bots.reduce((m, x) => { const k = String(x.why || "").slice(0, 28); m[k] = (m[k] || 0) + 1; return m; }, {});
    const worst = Object.entries(same).sort((a, b) => b[1] - a[1])[0];
    if (worst && worst[1] >= 4 && !Once.said("tempo", 60e3)) {
      log(`[TEMPO] ten sam powód ${worst[1]}× w ostatniej minucie: „${worst[0]}". To wygląda na pętlę — pokaż tę linię Claude'owi.`, "warn");
    }
    if (!fresh) Store.set("manual_at", Date.now());   // operator sam klika po grze
  }
  // v3.45.0 (pytanie ownera: „czy jak ktoś mnie w nocy zaatakuje, to rano zobaczę to w logach?"):
  // zwykły log mieści 400 wpisów, czyli w nocy jakieś 8–10 godzin — po długiej przerwie może
  // się przewinąć. Dziennik obrony trzyma 600 wpisów WYŁĄCZNIE obronnych, więc przetrwa.
  // Po każdej dłuższej ciszy wypisujemy z niego podsumowanie na samej górze logu.
  {
    const ostatni = Store.get("last_tick", 0) || 0;
    const przerwa = Date.now() - ostatni;
    if (ostatni && przerwa > 3 * 3600e3) {
      const godz = Math.round(przerwa / 3600e3);
      // TYLKO wpisy z okresu przerwy — starsze opisują poprzednią sesję i wprowadzałyby w błąd.
      const j = (Store.get("journal", []) || []).filter(x => (x.at || 0) >= ostatni);
      const ile = (k) => j.filter(x => x.kind === k).length;
      if (j.length) {
        log(`[PODSUMOWANIE] bot milczał ${godz} h. W dzienniku obrony z tego czasu: ${ile("ATAK")} × ATAK, ${ile("RATUNEK")} × ratunek, ${ile("POWRÓT")} × powrót, ${ile("BŁĄD")} × błąd.`, ile("ATAK") ? "error" : "info");
        for (const x of j.filter(x => x.kind === "ATAK" || x.kind === "BŁĄD").slice(0, 6)) {
          log(`[PODSUMOWANIE] ${new Date(x.at).toLocaleString("pl-PL")} ${x.kind}: ${x.msg}`, "warn");
        }
      } else {
        log(`[PODSUMOWANIE] bot milczał ${godz} h i NIC nie zapisało się w dzienniku obrony. Uwaga: jeśli bot był wyłączony albo karta zamknięta, to nie znaczy „spokojnie" — znaczy „nie patrzyłem". Jedynym pewnym źródłem jest wtedy raport bojowy w wiadomościach gry.`, "warn");
      }
    }
  }
  try { if (page() === "fleet") Hangar.scan(); } catch (e) { log(`[START] odczyt hangaru: ${e.message}`, "warn"); }
  try { Wake.ensure(); Calib.collect(); } catch (e) { log(`[START] wake/kalibracja: ${e.message}`, "warn"); }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") Wake.ensure(); });
  // v3.43.0: ślad PRAWDZIWEJ aktywności operatora. `isTrusted` jest true wyłącznie dla
  // zdarzeń wygenerowanych przez przeglądarkę na skutek działania człowieka — klik
  // wywołany z kodu (`el.click()`, którym bot obsługuje formularz floty) ma tam false.
  // Dzięki temu bot nigdy nie uzna własnej wysyłki za „operator gra".
  for (const ev of ["click", "keydown", "wheel"]) {
    try { document.addEventListener(ev, (e) => { if (e && e.isTrusted) Store.set("input_at", Date.now()); }, { capture: true, passive: true }); } catch {}
  }
  defenceTick();
  setInterval(defenceTick, CFG.tickMs);
  setInterval(keepalive, 60e3);
  setInterval(watchdog, 60e3);
  // aktualizacja z repo
  setInterval(() => { try { GM_xmlhttpRequest({ method: "GET", url: "https://raw.githubusercontent.com/Mitjano/ogamex-userscript/main/ogamex-3.user.js?t=" + Date.now(), onload: (r) => { const v = (String(r.responseText || "").match(/@version\s+([\d.]+)/) || [])[1]; if (v && v !== VERSION && !Once.said("update|" + v, 3600e3)) log(`[UPDATE] repo ma v${v}, tu chodzi v${VERSION} — Tampermonkey → Sprawdź aktualizacje.`, "error"); } }); } catch {} }, 15 * 60e3);
})();
