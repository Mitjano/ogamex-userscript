// ==UserScript==
// @name         OGameX Assistant 3 (Genesis)
// @namespace    https://github.com/Mitjano/ogamex-userscript
// @version      3.5.0
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
  const VERSION = "3.5.0";
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
  const Journal = {
    add(kind, msg) {
      const j = Store.get("journal", []) || [];
      j.unshift({ at: Date.now(), kind, msg: String(msg).slice(0, 400) });
      if (j.length > 600) j.length = 600;
      Store.set("journal", j);
      Notifier.fromJournal(kind, msg);
    },
  };
  const Notifier = {
    THROTTLE: { ATAK: 5 * 60e3, RATUNEK: 2 * 60e3, POWRÓT: 5 * 60e3, BŁĄD: 5 * 60e3 },
    topic() { let t = Store.get("ntfy_topic", ""); if (!t) { t = "ogamex3-" + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8); Store.set("ntfy_topic", t); } return t; },
    enabled() { return Store.get("ntfy_on", true) !== false; },
    throttled(kind) { const last = Store.get("ntfy_last", {}) || {}; if (Date.now() - (last[kind] || 0) < (this.THROTTLE[kind] || 5 * 60e3)) return true; last[kind] = Date.now(); Store.set("ntfy_last", last); return false; },
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
      if (kind === "ATAK") { if (this.throttled("ATAK")) return; this.push("⚔️ ATAK (Genesis)", m, "urgent", "rotating_light"); this.speak("Uwaga! Atak na bazę!", 3); }
      else if (kind === "RATUNEK" && /WYS[ŁL]ANO|wysłan/i.test(m)) { if (this.throttled("RATUNEK")) return; this.push("🛟 Flota ewakuowana (Genesis)", m, "default", "shield"); }
      else if (kind === "BŁĄD") { if (this.throttled("BŁĄD")) return; this.push("⚠️ Obrona: BŁĄD (Genesis)", m, "high", "warning"); }
      else if (kind === "POWRÓT" && /wróci|wysłan/i.test(m)) { if (this.throttled("POWRÓT")) return; this.push("✅ Flota w domu (Genesis)", m, "min", "white_check_mark"); }
    },
  };

  // ─── Konfiguracja ────────────────────────────────────────────────────────
  const DEFAULTS = {
    enabled: true,          // pętla obrony chodzi
    autoRescue: false,      // false = OBSERWATOR (alarmuje, nie rusza flotą). Włącz w panelu po potwierdzeniu markupu.
    deutReserve: 0,         // zostaje na ciele przy każdym locie (Athena: 100 mld; Genesis start: 0)
    airSpeedPct: 10,        // ucieczka w powietrze: prędkość
    confirmMs: 20000,       // potwierdzenie zagrożenia przed ruchem (artefakty paska)
    tooLateSec: 40,         // dolot krótszy = nie zdążymy z formularzem (tylko alarm)
    recallBufferSec: 90,    // zawrót: ostatni dolot + bufor
    tickMs: 20000,
    recon: true,            // rekonesans hangarów (bez niego bot NIE WIE, gdzie stoi flota)
    reconMs: 8 * 60e3,      // jak stary może być odczyt hangaru, zanim pójdziemy sprawdzić
    // ── HUMANIZER ──
    // Przerwy dotyczą WYŁĄCZNIE ekonomii. W 2.x przerwa kawowa usypiała cały
    // scheduler razem z keepalive (audyt A8: droga do wylogowania i 15 min
    // ślepoty). Tu obrona, rekonesans i keepalive chodzą zawsze.
    human: { breaks: true, breakEveryMinMin: 35, breakEveryMaxMin: 65, breakLenMinMin: 5, breakLenMaxMin: 15, economyAtNight: false },
    // ── NOCNY FLEET SAVE ──
    // Klasyczna obrona: gdy śpisz, flota nie stoi w hangarze. Używa TEJ SAMEJ
    // maszyny lotu co ratunek (lot + zawrót), więc nie ma drugiego stanu.
    fs: { enabled: false, startHour: 23, endHour: 7, speedPct: 10, target: null },
    // ── EKONOMIA (etap 2) ──
    aster: { enabled: false, scanGapSec: 6, minTtlSec: 300, launchFrom: null },
    expo: {
      enabled: false,       // włącz w panelu, gdy obrona potwierdzona na żywo
      waves: 1,             // podział floty na fale (start uni: 1; przy dużej flocie 8-14)
      discoverer40: true,   // KLASA ODKRYWCA: ekspedycje 40 min zamiast 1 h (+ obroty, + łup)
      holdingHours: 1,      // gdy opcji „40 min" nie ma (inna klasa)
      gapMinSec: 60, gapMaxSec: 90,
      slotReserve: 1,       // ile slotów floty zostaje wolnych (ratunek, ręczna gra)
      excludeTypes: ["ASTEROID_MINER", "COLONY_SHIP", "DEATH_STAR", "RECYCLER", "AVATAR"],
      launchFrom: null,     // {galaxy,system,position} — null = aktywna para
    },
  };
  const CFG = Object.assign({}, DEFAULTS, Store.get("cfg", {}) || {});
  const saveCfg = () => Store.set("cfg", CFG);

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
    async fetchList(own) {
      try {
        const res = await fetchT(this.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
        if (!res.ok) return { ok: false, rows: [] };
        const html = await res.text();
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
  };

  // Hangar na stronie /fleet: [data-ship-type][data-ship-quantity].
  const Hangar = {
    scan() {
      if (page() !== "fleet") return null;
      const a = PlanetBar.active(); if (!a) return null;
      const ships = [...document.querySelectorAll("[data-ship-type]")].map(el => ({ type: el.dataset.shipType, qty: parseInt(el.dataset.shipQuantity || "0") || 0 })).filter(s => s.type);
      const total = ships.reduce((x, s) => x + s.qty, 0);
      const txt = document.body.textContent;
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
    ok() { const s = Store.get("session", {}) || {}; if (s.lostAt) Store.set("session", {}); },
    lostRecently() { const s = Store.get("session", {}) || {}; return !!s.lostAt && Date.now() - s.lostAt < 15 * 60e3; },
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
      const evRows = Rows.readEvents(own);
      const list = Session.lostRecently() ? { ok: false, rows: [] } : await Rows.fetchList(own);
      const rows = [...evRows.map(r => ({ ...r, source: "events" })), ...list.rows.map(r => ({ ...r, source: "list" }))];
      // symulacja (panel): syntetyczny wrogi wiersz
      const sim = Store.get("sim", null);
      if (sim && sim.until > now) rows.push({ id: "sim", type: "ATTACK", src: "9:999:9", dst: sim.key, dstBody: sim.body, eta: Math.max(5, Math.round((sim.arriveAt - now) / 1000)), attack: true, spy: false, mine: false, hostile: true, source: "sim" });
      else if (sim) { Store.del("sim"); log("[TEST] symulacja zakończona.", "info"); }
      // zagrożenia: dedup po id albo (dst|A/S|eta/20); pamięć do dolotu (+60 s)
      const seen = new Map();
      for (const t of s.threats) if ((t.arriveAt || 0) + 60e3 > now) seen.set(t.id || `${t.dst}|${t.attack ? "A" : "S"}|${Math.round((t.arriveAt || 0) / 20000)}`, t);
      for (const r of rows) {
        if (r.mine || r.friendly || !r.dst || (!r.attack && !r.spy) || r.isReturn) continue;
        if (!own.has(r.dst)) continue;
        const arriveAt = now + (r.eta || 0) * 1000;
        const k = r.id || `${r.dst}|${r.attack ? "A" : "S"}|${Math.round(arriveAt / 20000)}`;
        const prev = seen.get(k);
        seen.set(k, { id: r.id || null, dst: r.dst, dstBody: r.dstBody || prev?.dstBody || null, arriveAt, attack: !!r.attack, spy: !!r.spy, src: r.src || prev?.src || null, srcBody: r.srcBody, type: r.type, seenAt: prev?.seenAt || now, lastSeenAt: now, source: r.source, html: r.html });
        if (!prev && r.attack) log(`[ATAK DOM] wrogi wiersz (${r.type}, ${r.source}): ${r.html}`, "error");
      }
      s.threats = [...seen.values()];
      // własne loty (z Events — globalne; z listy — aktywna para)
      s.own = rows.filter(r => r.mine).map(r => ({ id: r.id, src: r.src, dst: r.dst, dstBody: r.dstBody, eta: r.eta, arriveAt: now + (r.eta || 0) * 1000, isReturn: r.isReturn, type: r.type, seenAt: now }));
      // loty wysłane przez nas: zamknij te, których hangar-cel/źródło już pełny (hangar > zegar)
      s.flights = (s.flights || []).filter(f => {
        const homeH = s.hangars[`${f.fromKey}|${f.fromBody}`];
        if (homeH && homeH.total > 0 && homeH.at > f.sentAt + 60e3) { log(`[LOT] domknięty — hangar [${f.fromKey}] ${f.fromBody} pełny (${homeH.total.toLocaleString("pl-PL")}).`, "success"); return false; }
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
    const inFlightFrom = (k) => (s.flights || []).find(f => f.fromKey === k && f.phase !== "done");
    const neighbourMoon = (k) => { const c = pairs[k]; if (!c) return null; for (const [ok, o] of Object.entries(pairs)) { if (ok !== k && o.hasMoon && o.galaxy === c.galaxy && o.system === c.system && attackedBodies(ok).size === 0) return ok; } return null; };
    const anyRefuge = (k) => { for (const [ok, o] of Object.entries(pairs)) { if (ok !== k && attackedBodies(ok).size === 0) return { key: ok, body: o.hasMoon ? "moon" : "planet" }; } return null; };

    for (const k of Object.keys(pairs)) {
      const th = threatsFor(k);
      const fleet = Situation.fleetAt(s, k, now);
      if (!th.length) {
        // cisza: lot ucieczki z tej pary → zawrót po recallAt; brak zagrożeń i flota na planecie z księżycem → wróć na księżyc
        const f = inFlightFrom(k);
        if (f && f.kind === "air" && f.phase === "launched" && now >= f.recallAt) actions.push({ kind: "recall", flight: f, why: "ataki minęły — zawrót ucieczki" });
        if (!f && fleet && fleet.body === "planet" && pairs[k].hasMoon && now - fleet.at < 30 * 60e3) { actions.push({ kind: "fly", fromKey: k, fromBody: "planet", toKey: k, toBody: "moon", why: "dom = księżyc", speed: 100, recall: false, home: true }); continue; }
        // NOCNY FLEET SAVE: w oknie nocnym flota nie stoi w hangarze. Ten sam lot
        // co ucieczka (powolny Deploy + zawrót), tylko wyzwalany zegarem, nie atakiem.
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
      if (!fleet) { alerts.push({ key: k, level: "info", msg: `atak na [${k}] za ${secs}s — hangar nieznany/pusty wg mapy` }); continue; }
      const bodies = attackedBodies(k);
      const f = inFlightFrom(k);
      if (f) { if (f.kind === "air" && f.phase === "launched") { const lastArrive = Math.max(...th.map(t => t.arriveAt)); if (lastArrive + cfg.recallBufferSec * 1000 > f.recallAt) actions.push({ kind: "extend", flight: f, recallAt: lastArrive + cfg.recallBufferSec * 1000, why: "dosłana fala" }); } continue; }
      const fleetHit = bodies.has(fleet.body) || bodies.has("unknown");
      if (!fleetHit) { actions.push({ kind: "hold", key: k, why: `atak w ${[...bodies].join("/")}, flota na ${fleet.body} — bezpieczna strona` }); continue; }
      if (now - firstSeen < cfg.confirmMs && secs > cfg.tooLateSec + cfg.confirmMs / 1000) { alerts.push({ key: k, level: "warn", msg: `atak na [${k}] za ${secs}s — potwierdzam ${Math.round((cfg.confirmMs - (now - firstSeen)) / 1000)}s` }); continue; }
      if (secs < cfg.tooLateSec) { alerts.push({ key: k, level: "error", msg: `atak na [${k}] za ${secs}s — ZA PÓŹNO na formularz` }); continue; }
      // wybór ucieczki: sąsiedni księżyc w układzie → drugie ciało pary (nieatakowane) → inna kolonia
      const nb = neighbourMoon(k);
      if (nb) { actions.push({ kind: "fly", fromKey: k, fromBody: fleet.body, toKey: nb, toBody: "moon", why: `atak w ${fleet.body} [${k}] → sąsiedni księżyc`, speed: cfg.airSpeedPct, recall: true, air: true, recallAt: Math.max(...th.map(t => t.arriveAt)) + cfg.recallBufferSec * 1000 }); continue; }
      const other = fleet.body === "moon" ? "planet" : "moon";
      if ((other === "planet" || pairs[k].hasMoon) && !bodies.has(other) && !bodies.has("unknown")) { actions.push({ kind: "fly", fromKey: k, fromBody: fleet.body, toKey: k, toBody: other, why: `atak w ${fleet.body} [${k}] → drugie ciało`, speed: 100, recall: false }); continue; }
      const ref = anyRefuge(k);
      if (ref) { actions.push({ kind: "fly", fromKey: k, fromBody: fleet.body, toKey: ref.key, toBody: ref.body, why: `atak na oba ciała [${k}] → powietrze do [${ref.key}]`, speed: cfg.airSpeedPct, recall: true, air: true, recallAt: Math.max(...th.map(t => t.arriveAt)) + cfg.recallBufferSec * 1000 }); continue; }
      alerts.push({ key: k, level: "error", msg: `atak na [${k}] — brak jakiegokolwiek refugium` });
    }
    return { actions, alerts };
  }

  // ═══ HUMANIZER (tylko ekonomia) ═════════════════════════════════════════
  const Human = {
    onBreak() { return Date.now() < (Store.get("break_until", 0) || 0); },
    breakLeftMin() { return Math.max(0, Math.ceil(((Store.get("break_until", 0) || 0) - Date.now()) / 60000)); },
    maybeStart() {
      const h = CFG.human || {};
      if (!h.breaks) return false;
      const now = Date.now();
      let next = Store.get("break_next", 0) || 0;
      if (!next) { Store.set("break_next", now + jitter(h.breakEveryMinMin, h.breakEveryMaxMin) * 60e3); return false; }
      if (now < next) return false;
      const len = jitter(h.breakLenMinMin, h.breakLenMaxMin) * 60e3;
      Store.set("break_until", now + len);
      Store.set("break_next", now + len + jitter(h.breakEveryMinMin, h.breakEveryMaxMin) * 60e3);
      log(`[PRZERWA] ekonomia pauzuje na ~${Math.round(len / 60000)} min (rytm człowieka). Obrona działa normalnie.`, "info");
      return true;
    },
    // Jedyne pytanie, jakie zadaje ekonomia. Obrona NIGDY tego nie pyta.
    economyAllowed(s) {
      if (this.onBreak()) return `przerwa (~${this.breakLeftMin()} min)`;
      if (this.maybeStart()) return "przerwa właśnie się zaczęła";
      if (!CFG.human.economyAtNight && s && s.night && s.night.active) return "okno nocne — ekonomia śpi, flota jest na FS";
      return null;
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
  // Reguły z 2.x (kupione incydentami): rozmiar fali ZAMROŻONY na serię (inaczej
  // każda kolejna dzieli resztę i seria wygasa), a fala domykająca serię lub
  // ostatni wolny slot zabiera CAŁY hangar (inaczej reszta z zaokrągleń stoi w domu).
  function expoPlan(s, cfg, now, burst) {
    const e = cfg.expo || {};
    if (!e.enabled) return { skip: "wyłączone" };
    if ((s.threats || []).some(t => t.arriveAt > now)) return { skip: "alarm — obrona ma pierwszeństwo" };
    if ((s.flights || []).some(f => f.phase === "launched")) return { skip: "ratunek w powietrzu" };
    const homeKey = e.launchFrom ? key(e.launchFrom) : (s.active && s.active.key);
    if (!homeKey) return { skip: "nie wiem, skąd startować" };
    const pair = (s.pairs || {})[homeKey];
    if (!pair) return { skip: `[${homeKey}] nie ma na pasku planet` };
    const body = (s.hangars[`${homeKey}|moon`]?.total > 0 && pair.hasMoon) ? "moon" : "planet";
    const h = s.hangars[`${homeKey}|${body}`];
    if (!h || now - h.at > 15 * 60e3) return { skip: `hangar [${homeKey}] ${body} nieznany/stary — najpierw rekonesans` };
    const expo = s.slots?.expo, fleet = s.slots?.fleet;
    const cap = Math.max(1, Math.min(e.waves || 1, expo?.total || e.waves || 1));
    if (expo && expo.used >= cap) return { skip: `ekspedycje ${expo.used}/${expo.total} (limit fal ${cap}) — czekam na powroty` };
    if (fleet && fleet.total && fleet.total - fleet.used <= (e.slotReserve || 0)) return { skip: `wolne sloty floty ≤ rezerwa (${e.slotReserve})` };
    if (burst && burst.lastSendAt && now - burst.lastSendAt < (burst.gapMs || e.gapMinSec * 1000)) return { skip: "odstęp między falami" };
    const excl = (e.excludeTypes || []).map(t => String(t).toUpperCase());
    const avail = (h.ships || []).filter(x => x.qty > 0 && !excl.includes(String(x.type).toUpperCase()));
    if (!avail.length) return { skip: "brak statków do wysłania (poza wykluczeniami)" };
    const waves = Math.max(1, e.waves || 1);
    const frozen = burst && burst.waves === waves && burst.sizes && (burst.sent || 0) < waves ? burst.sizes : null;
    const lastOfBurst = waves === 1 || (frozen && (burst.sent || 0) >= waves - 1) || (expo && expo.total && expo.used >= cap - 1);
    const share = (qty) => { const raw = Math.floor(qty / waves); if (raw <= 0) return qty >= waves ? raw : (waves === 1 ? qty : 0); return raw; };
    const ships = avail.map(x => ({ type: x.type, qty: lastOfBurst ? x.qty : (frozen?.[x.type] !== undefined ? Math.min(frozen[x.type], x.qty) : share(x.qty)) })).filter(x => x.qty > 0);
    if (!ships.length) return { skip: `flota za mała na ${waves} fal — zmniejsz liczbę fal` };
    const [g, sy] = homeKey.split(":");
    return { toKey: `${g}:${sy}:16`, fromKey: homeKey, fromBody: body, ships, last: !!lastOfBurst, waves,
      duration: { minutes: e.discoverer40 ? 40 : 0, hours: Math.max(1, e.holdingHours || 1) } };
  }

  const Expo = {
    burst() { return Store.get("burst", null); },
    async tick(s) {
      ExpoLink.learn();
      if (Fly.mission() || !CFG.expo.enabled) return false;
      const why = Human.economyAllowed(s);
      if (why) { if (!Once.said("human|" + why.slice(0, 12), 10 * 60e3)) log(`[EXPO] wstrzymane: ${why}`, "info"); return false; }
      const now = Date.now();
      const b = this.burst();
      const p = expoPlan(s, CFG, now, b);
      if (p.skip) { if (!Once.said("expo|" + p.skip, 10 * 60e3)) log(`[EXPO] ${p.skip}`, "info"); return false; }
      const link = ExpoLink.get();
      if (!link || !link.mission) {
        if (!Once.said("expo|link", 15 * 60e3)) log("[EXPO] nie znam id misji ekspedycji — wejdź RAZ na dowolną stronę Galaxy, bot odczyta ją z wiersza 16.", "warn");
        return false;
      }
      const sizes = {}; for (const x of p.ships) sizes[x.type] = x.qty;
      const sent = (b && b.waves === p.waves && !p.last) ? (b.sent || 0) + 1 : (p.last ? 0 : 1);
      Store.set("burst", p.last ? { waves: p.waves, sizes: null, sent: 0, lastSendAt: now, gapMs: jitter(CFG.expo.gapMinSec, CFG.expo.gapMaxSec) * 1000 }
                                : { waves: p.waves, sizes: (b && b.sizes && b.waves === p.waves) ? b.sizes : sizes, sent, lastSendAt: now, gapMs: jitter(CFG.expo.gapMinSec, CFG.expo.gapMaxSec) * 1000 });
      return Fly.start({ kind: "expedition", fromKey: p.fromKey, fromBody: p.fromBody, toKey: p.toKey, toBody: "planet",
        why: `ekspedycja ${p.last ? "(domyka serię — cały hangar)" : `(1/${p.waves} floty)`}`, speed: 100, plan: p.ships,
        missionType: "EXPEDITION", takeResources: false, duration: p.duration, missionId: link.mission });
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
      if ((s.threats || []).some(t => t.arriveAt > Date.now())) return false;
      let st = this.st();
      const now = Date.now();
      if (st.sentAt && now - st.sentAt < 5 * 60e3) return false;                 // po wysyłce daj lot rozpocząć
      if (now - (st.lastScanAt || 0) < (CFG.aster.scanGapSec || 6) * 1000) return false;
      // minery muszą być w hangarze bazy
      const homeKey = CFG.aster.launchFrom ? key(CFG.aster.launchFrom) : (s.active && s.active.key);
      const hm = homeKey ? (s.hangars[`${homeKey}|moon`] || s.hangars[`${homeKey}|planet`]) : null;
      const miners = hm ? (hm.ships || []).find(x => String(x.type).toUpperCase() === "ASTEROID_MINER") : null;
      if (!miners || miners.qty <= 0) { if (!Once.said("aster|nominers", 15 * 60e3)) log("[ASTER] brak minerów w hangarze bazy (albo są w locie) — nie skanuję.", "info"); return false; }
      if (!(st.ranges || []).length || now - (st.rangesAt || 0) > 30 * 60e3) {
        const r = await this.fetchRanges();
        if (!r) return false;
        st = { ...st, ranges: r, rangesAt: now, idx: 0, sys: null };
        this.save(st);
        if (!r.length) return false;
      }
      // jesteśmy na stronie galaktyki skanowanego układu? sprawdź wiersz 17
      const target = this.nextSystem(st);
      if (!target) return false;
      const onThat = page() === "galaxy" && new RegExp(`[?&]x=${target.galaxy}(?:&|$)`).test(location.search) && new RegExp(`[?&]y=${target.system}(?:&|$)`).test(location.search);
      if (onThat) {
        const hit = this.readRow17();
        st = { ...this.advance(st), lastScanAt: now };
        if (hit && hit.fleetUrl) {
          const min = Math.max(60, CFG.aster.minTtlSec || 300);
          if (hit.ttl && hit.ttl < min) { log(`[ASTER] [${target.galaxy}:${target.system}:17] znika za ${hit.ttl}s — za mało czasu, skanuję dalej.`, "info"); this.save(st); return false; }
          log(`[ASTER] ZNALEZIONA asteroida [${target.galaxy}:${target.system}:17] (TTL ${hit.ttl || "?"}s) — wysyłam ${miners.qty.toLocaleString("pl-PL")} minerów.`, "success");
          this.save({ ...st, sentAt: now, sentTo: `${target.galaxy}:${target.system}:17` });
          return Fly.start({ kind: "asteroid", fromKey: homeKey, fromBody: (s.hangars[`${homeKey}|moon`]?.total > 0 ? "moon" : "planet"),
            toKey: `${target.galaxy}:${target.system}:17`, toBody: "planet", why: `mining asteroidy [${target.galaxy}:${target.system}:17]`,
            speed: 100, plan: [{ type: "ASTEROID_MINER", qty: miners.qty }], missionType: "ASTEROID", takeResources: false, missionId: 12, directUrl: hit.fleetUrl });
        }
        this.save(st);
        return false;
      }
      this.save({ ...st, lastScanAt: now });
      location.replace(`/galaxy?x=${target.galaxy}&y=${target.system}`);
      return true;
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
      if (a.kind !== "expedition" && a.kind !== "asteroid") Journal.add("RATUNEK", `Start lotu: [${a.fromKey}] ${a.fromBody} → [${a.toKey}] ${a.toBody} (${a.why})`);
      log(`[LOT] ${a.why}: [${a.fromKey}] ${a.fromBody} → [${a.toKey}] ${a.toBody}, ${a.speed}%`, "warn");
      return true;
    },
    abort(why) { const m = this.mission(); Store.del("mission"); if (m) { log(`[LOT] przerwany: ${why}`, "error"); Journal.add("BŁĄD", `Lot [${m.fromKey}]→[${m.toKey}] przerwany: ${why}`); } },
    async tick() {
      const m = this.mission(); if (!m) return;
      if (Date.now() - m.startedAt > 5 * 60e3) return this.abort("5 min bez potwierdzenia wysyłki");
      try {
        if (m.step === "switch") {
          const a = PlanetBar.active();
          if (a && a.key === m.fromKey && a.body === m.fromBody) { m.step = "form"; Store.set("mission", m); location.replace(this.url(m)); return; }
          const el = PlanetBar.anchor(m.fromKey, m.fromBody);
          if (!el) return this.abort(`brak [${m.fromKey}] ${m.fromBody} na pasku planet`);
          log(`[LOT] przełączam na ${m.fromBody} [${m.fromKey}]`, "info"); m.step = "switch_wait"; Store.set("mission", m); el.click(); return;
        }
        if (m.step === "switch_wait") { const a = PlanetBar.active(); if (a && a.key === m.fromKey && a.body === m.fromBody) { m.step = "form"; Store.set("mission", m); location.replace(this.url(m)); } return; }
        if (m.step === "form") {
          if (page() !== "fleet") { location.replace(this.url(m)); return; }
          if (this._busy) return; this._busy = true;
          try { await this.form(m); } finally { this._busy = false; }
        }
      } catch (e) { this.abort(`błąd: ${e.message}`); }
    },
    findButton(text) {
      const area = document.querySelector("#content, .content, main, #fleet, .fleet-content, .fleet-form") || document.body;
      return [...area.querySelectorAll("a, button, input[type='submit']")].find(el => (el.value || el.textContent || "").trim() === text && el.offsetParent !== null && !el.closest("#ogx3-panel")) || null;
    },
    isDisabled(el) { return !el || el.disabled || el.classList.contains("disabled") || el.getAttribute("aria-disabled") === "true"; },
    async clickWhenEnabled(text, maxMs = 25000) {
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) { const b = this.findButton(text); if (b && !this.isDisabled(b)) { b.click(); log(`[LOT] klik „${text}"`, "info"); return true; } await sleep(400); }
      const txt = (document.querySelector("#content, .content, form") || document.body).textContent.replace(/\s+/g, " ").trim();
      log(`[LOT] przycisk „${text}" niedostępny przez ${maxMs / 1000}s. Tekst formularza: …${txt.slice(-300)}`, "error");
      return false;
    },
    async form(m) {
      const a = PlanetBar.active();
      if (!a || a.key !== m.fromKey || a.body !== m.fromBody) { m.step = "switch"; Store.set("mission", m); return; }
      await sleep(jitter(1200, 2200));
      // krok 1: statki — wszystko (ratunek) albo plan (ekspedycja)
      const els = [...document.querySelectorAll("[data-ship-type]")];
      const snap = Hangar.scan();
      if (!snap || snap.total === 0) { log(`[LOT] hangar ${m.fromBody} [${m.fromKey}] pusty — nic do wysłania.`, "warn"); Store.del("mission"); return; }
      const loaded = [];
      const want = m.plan ? new Map(m.plan.map(p => [String(p.type).toUpperCase(), p.qty])) : null;
      for (const el of els) {
        const type = String(el.dataset.shipType || "").toUpperCase();
        const have = parseInt(el.dataset.shipQuantity || "0") || 0; if (!have) continue;
        const qty = want ? Math.min(want.get(type) || 0, have) : have;
        if (qty <= 0) continue;
        const item = el.closest(".ship-item") || el.parentElement;
        const input = item?.querySelector("input.numberFormatInput, input[type='text'], input[type='number']");
        if (!input) continue; setInput(input, qty); loaded.push(`${el.dataset.shipType}×${qty.toLocaleString("pl-PL")}`);
        if (want) await sleep(jitter(120, 380));   // człowiek wypełnia pola po kolei, nie w jednej milisekundzie
      }
      if (!loaded.length) { log(`[LOT DOM] nie znalazłem pól statków. Statki: ${els.map(e => `${e.dataset.shipType}(${e.dataset.shipQuantity})`).join(", ")} | HTML: ${(document.querySelector("#content, .content") || document.body).innerHTML.replace(/\s+/g, " ").slice(0, 1500)}`, "error"); return this.abort("brak pól statków"); }
      log(`[LOT] załadowano: ${loaded.join(", ")}`, "info");
      await sleep(jitter(400, 800));
      if (!(await this.clickWhenEnabled("Next"))) return this.abort("Next (krok 1) martwy");
      // krok 2: cel (koordy, ciało), prędkość
      const t0 = Date.now(); while (Date.now() - t0 < 8000 && !document.getElementById("fleet2_target_x")) await sleep(400);
      const [g, sy, po] = m.toKey.split(":");
      const fx = document.getElementById("fleet2_target_x"), fy = document.getElementById("fleet2_target_y"), fz = document.getElementById("fleet2_target_z");
      if (fx && fy && fz && `${fx.value}:${fy.value}:${fz.value}` !== m.toKey) { setInput(fx, g); setInput(fy, sy); setInput(fz, po); log(`[LOT] koordy celu ustawione na [${m.toKey}]`, "info"); await sleep(600); }
      const inSidebar = (el) => !!el.closest(".planet-select, .moon-select, .sidebar, nav, #ogx3-panel");
      const wantType = m.toBody === "moon" ? "2" : "1";
      const btn = [...document.querySelectorAll(`[data-planet-type="${wantType}"]`)].filter(el => !inSidebar(el))[0];
      if (btn) { btn.click(); log(`[LOT] cel: ${m.toBody === "moon" ? "KSIĘŻYC" : "PLANETA"}`, "info"); await sleep(jitter(500, 900)); }
      else { log(`[LOT DOM] brak przełącznika ciała (data-planet-type=${wantType}); panel celu: ${(document.getElementById("target_planet_type_container") || document.body).innerHTML.replace(/\s+/g, " ").slice(0, 1200)}`, "warn"); }
      if (m.speed && m.speed !== 100) {
        let ok = false; const txt = (e) => (e.textContent || "").trim();
        for (const h of [...document.querySelectorAll("a, span, button, div, td, li")].filter(e => txt(e) === "100" && e.offsetParent !== null && !e.closest("#ogx3-panel"))) {
          const kids = [...(h.parentElement?.children || [])]; const texts = kids.map(txt);
          if (!(texts.includes("10") && texts.includes("50"))) continue;
          const t = kids.find(k => txt(k) === String(m.speed)); if (t) { t.click(); ok = true; } break;
        }
        log(`[LOT] prędkość ${m.speed}%: ${ok ? "ustawiona" : "NIE ustawiona (lecę z domyślną)"}`, ok ? "info" : "warn");
        await sleep(jitter(700, 1100));
      }
      const ft = document.body.textContent.match(/Duration\s*of\s*flight[^0-9]{0,40}?(\d{1,3}):(\d{2})(?::(\d{2}))?/i);
      if (ft) { m.flightMs = ft[3] !== undefined ? (+ft[1] * 3600 + +ft[2] * 60 + +ft[3]) * 1000 : (+ft[1] * 60 + +ft[2]) * 1000; log(`[LOT] czas lotu ${Math.round(m.flightMs / 1000)} s`, "info"); }
      if (!(await this.clickWhenEnabled("Next"))) return this.abort("Next (krok 2) martwy");
      // krok 3: misja Deploy, surowce − rezerwa
      const t1 = Date.now(); while (Date.now() - t1 < 8000 && !this.findButton("Send fleet")) await sleep(400);
      const missions = [...document.querySelectorAll(".mission-item, [class*='mission-item']")];
      const nameOf = (el) => `${el.className || ""} ${el.textContent || ""}`.toUpperCase();
      const wanted = m.missionType === "EXPEDITION" ? ["EXPEDITION", "EKSPEDYCJ"] : m.missionType === "ASTEROID" ? ["ASTEROID_MINING", "ASTEROID"] : this.MISSIONS;
      let picked = null; for (const w of wanted) { picked = missions.find(x => nameOf(x).includes(w)); if (picked) break; }
      if (!picked) { log(`[LOT DOM] brak misji ${wanted[0]}. Dostępne: ${missions.map(x => `${(x.textContent || "").trim().slice(0, 20)}[${x.className}]`).join(", ") || "NONE"}`, "error"); return this.abort(`brak misji ${wanted[0]}`); }
      picked.click(); await sleep(jitter(400, 800));
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
      send.click(); log(`[LOT] Send fleet kliknięty.`, "success");
      // potwierdzenie: URL fleetSendSuccessfully albo hangar pusty
      await sleep(jitter(3000, 4500));
      const okUrl = location.href.includes("fleetSendSuccessfully");
      const after = page() === "fleet" ? Hangar.scan() : null;
      const ok = okUrl || (after && after.total < shipsBefore * 0.05);
      if (!ok) { const err = document.querySelector(".error, .alert, .modal.show, [class*='error']"); log(`[LOT] wysyłka NIE potwierdzona (${err ? (err.textContent || "").trim().slice(0, 160) : "brak komunikatu"})`, "error"); return this.abort("brak potwierdzenia wysyłki"); }
      const s = Situation.load();
      // v3.2.0: TYLKO loty obronne trafiają do `flights`. Ekspedycja tam wpisana
      // znaczyłaby dla decide() „ta para jest już w locie" i zablokowałaby ratunek
      // — dokładnie ten rodzaj sprzężenia, przez który 2.x gubił flotę.
      if (m.kind !== "expedition" && m.kind !== "asteroid") {
        s.flights = (s.flights || []).filter(f => f.fromKey !== m.fromKey);
        s.flights.push({ kind: m.air ? "air" : (m.home ? "home" : "swap"), fromKey: m.fromKey, fromBody: m.fromBody, toKey: m.toKey, toBody: m.toBody, sentAt: Date.now(), flightMs: m.flightMs || 0, recallAt: m.recallAt || 0, phase: "launched", tries: 0 });
      }
      Situation.save(s);
      Store.del("mission");
      if (m.kind === "expedition") log(`[EXPO] fala wysłana: ${loaded.join(", ")} → [${m.toKey}]`, "success");
      else if (m.kind === "asteroid") log(`[ASTER] minery wysłane: ${loaded.join(", ")} → [${m.toKey}]`, "success");
      else Journal.add(m.home ? "POWRÓT" : "RATUNEK", `WYSŁANO: [${m.fromKey}] ${m.fromBody} → [${m.toKey}] ${m.toBody} (${loaded.length} typów statków)${m.air ? `, zawrót ~${new Date(m.recallAt).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}` : ""}`);
      if (okUrl) location.replace("/");
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
    async recall(f) {
      const s = Situation.load();
      const a = PlanetBar.active();
      if (!a || a.key !== f.fromKey) { const el = PlanetBar.anchor(f.fromKey, f.fromBody); if (el) { log(`[ZAWRÓT] przełączam na [${f.fromKey}] ${f.fromBody}`, "info"); el.click(); } return; }
      let html = ""; try { const r = await fetchT(Rows.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } }); if (r.ok) html = await r.text(); } catch {}
      const doc = new DOMParser().parseFromString(html, "text/html");
      const trs = [...doc.querySelectorAll("tr[class*='row-mission-type-']")];
      const ours = trs.filter(tr => /DEPLOY|STATION/i.test(tr.className) && (tr.textContent || "").includes(`[${f.toKey}]`) && (tr.textContent || "").includes(`[${f.fromKey}]`));
      const back = ours.find(tr => /return/i.test(tr.className));
      if (back) { f.phase = "recalled"; f.recalledAt = f.recalledAt || Date.now(); Situation.save(s); log(`[ZAWRÓT] ✅ lot [${f.fromKey}]→[${f.toKey}] już WRACA.`, "success"); Journal.add("POWRÓT", `Zawrót potwierdzony: flota wraca na [${f.fromKey}].`); return; }
      const row = ours.find(tr => !/return/i.test(tr.className));
      if (!row) { f.tries = (f.tries || 0) + 1; if (f.tries >= 5) { f.phase = "recall_failed"; Journal.add("BŁĄD", `Nie widzę lotu [${f.fromKey}]→[${f.toKey}] na liście — zawróć ręcznie.`); } Situation.save(s); log(`[ZAWRÓT] brak wiersza lotu (${f.tries}/5). Wiersze: ${trs.map(tr => tr.className.replace(/\s+/g, " ") + " :: " + (tr.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100)).join(" || ").slice(0, 1200)}`, "warn"); return; }
      const id = row.getAttribute("data-fleet-id") || "";
      let live = id ? document.querySelector(`a.x_btn_fleet_return[data-fleet-id="${id}"]`) : document.querySelector("a.x_btn_fleet_return");
      if (!live) { for (const t of [...document.querySelectorAll("a, button, div, span")].filter(e => e.offsetParent !== null && !e.closest("#ogx3-panel") && /fleet\s*movements|^events$|\d+\s*Missions?/i.test((e.textContent || "").trim()))) { t.click(); for (let i = 0; i < 8 && !live; i++) { await sleep(500); live = id ? document.querySelector(`a.x_btn_fleet_return[data-fleet-id="${id}"]`) : document.querySelector("a.x_btn_fleet_return"); } if (live) break; } }
      if (!live) { if (page() !== "fleet") { location.replace("/fleet"); return; } f.tries = (f.tries || 0) + 1; Situation.save(s); log(`[ZAWRÓT] brak przycisku zawracania (${f.tries}/5)`, "warn"); return; }
      const w = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window; const orig = w.confirm;
      try { w.confirm = () => true; live.click(); await sleep(800); } finally { try { w.confirm = orig; } catch {} }
      f.phase = "recalled"; f.recalledAt = Date.now(); Situation.save(s);
      log(`[ZAWRÓT] kliknięty dla [${f.fromKey}]→[${f.toKey}].`, "success"); Journal.add("POWRÓT", `Zawrót wysłany: flota wraca na [${f.fromKey}].`);
    },
  };

  // ═══ KARTA PRZY ŻYCIU ═══════════════════════════════════════════════════
  // Przeglądarka dławi timery w kartach w tle (~1/min), a laptop zasypia —
  // obrona chodząca co 20 s przestaje wtedy istnieć dokładnie wtedy, gdy jest
  // potrzebna. Dwa niezależne środki z 2.x: Screen Wake Lock (nie usypia
  // ekranu/systemu, gdy karta widoczna) i CICHY dźwięk (karta odtwarzająca
  // audio nie jest dławiona w tle). Bez uprawnień, bez plików.
  const Wake = {
    _lock: null, _ctx: null,
    async ensure() {
      try {
        if ("wakeLock" in navigator && document.visibilityState === "visible" && (!this._lock || this._lock.released)) {
          this._lock = await navigator.wakeLock.request("screen");
          this._lock.addEventListener?.("release", () => log("[WAKE] blokada uśpienia zwolniona.", "warn"));
          if (!Once.said("wake_on", 6 * 3600e3)) log("[WAKE] blokada uśpienia aktywna — komputer nie zaśnie, póki karta z grą jest widoczna.", "info");
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
        Journal.add("BŁĄD", "Raport startowy Genesis gotowy — skopiuj z panelu i wyślij (potwierdzenie parserów).");
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
      const out = [];
      for (const [k, p] of Object.entries(s.pairs || {})) { out.push([k, "planet"]); if (p.hasMoon) out.push([k, "moon"]); }
      return out;
    },
    async tick(s) {
      if (!CFG.recon || Fly.mission()) return false;
      const now = Date.now();
      if ((s.threats || []).some(t => t.arriveAt > now)) return false;          // alarm = zero nawigacji
      if ((s.flights || []).some(f => f.phase === "launched")) return false;    // lot w powietrzu: nie kręcimy stroną
      const st = this.st();
      if (now - (st.at || 0) < 90e3) return false;                              // najwyżej raz na 90 s
      const stale = (k, b) => { const h = s.hangars[`${k}|${b}`]; return !h || now - h.at > CFG.reconMs; };
      const a = s.active;
      if (a && stale(a.key, a.body)) {
        if (page() === "fleet") { Hangar.scan(); return false; }                // już jesteśmy — wystarczy odczyt
        Store.set("recon", { ...st, at: now });
        log(`[REKONESANS] sprawdzam hangar ${a.body} [${a.key}] — bez tego nie wiem, gdzie stoi flota.`, "info");
        const [g, sy, po] = a.key.split(":");
        location.replace(`/fleet?x=${g}&y=${sy}&z=${po}`);
        return true;
      }
      const list = this.bodiesOf(s).filter(([k, b]) => stale(k, b));
      if (!list.length) return false;
      const [k, b] = list[(st.idx || 0) % list.length];
      const el = PlanetBar.anchor(k, b);
      if (!el) { Store.set("recon", { at: now, idx: (st.idx || 0) + 1 }); return false; }
      Store.set("recon", { at: now, idx: (st.idx || 0) + 1 });
      log(`[REKONESANS] przechodzę na ${b} [${k}], żeby odczytać hangar.`, "info");
      el.click();
      return true;
    },
  };

  // ═══ PĘTLA OBRONY ═══════════════════════════════════════════════════════
  let running = false;
  async function defenceTick() {
    if (running || !CFG.enabled) return; running = true;
    try {
      if (!TabLock.acquire()) return;
      Store.set("last_tick", Date.now());
      Wake.ensure();
      Calib.collect();
      if (page() === "fleet") Hangar.scan();
      const s = await Situation.refresh();
      const { actions, alerts } = decide(s, CFG, Date.now());
      for (const a of alerts) { const k = `alert|${a.key}|${a.msg.slice(0, 40)}`; if (!Once.said(k, 60e3)) log(`[OBRONA] ${a.msg}`, a.level === "error" ? "error" : "warn"); }
      const attacks = (s.threats || []).filter(t => t.attack && t.arriveAt > Date.now());
      if (attacks.length) { const k = `atak|${attacks.map(t => t.id || t.dst).join(",")}`; if (!Once.said(k, 10 * 60e3)) Journal.add("ATAK", attacks.map(t => `${t.type} → [${t.dst}] ${t.dstBody || "?"} za ${Math.round((t.arriveAt - Date.now()) / 1000)}s (${t.source})`).join("; ")); }
      await Fly.tick();
      if (Fly.mission()) return;
      for (const a of actions) {
        if (a.kind === "hold") { if (!Once.said(`hold|${a.key}`, 120e3)) log(`[OBRONA] [${a.key}]: ${a.why} — nie ruszam floty.`, "info"); continue; }
        if (a.kind === "extend") { const s2 = Situation.load(); const f = (s2.flights || []).find(x => x.fromKey === a.flight.fromKey && x.phase === "launched"); if (f && f.recallAt < a.recallAt) { f.recallAt = a.recallAt; Situation.save(s2); log(`[LOT] ${a.why} — zawrót przesunięty na ${new Date(a.recallAt).toLocaleTimeString("pl-PL")}`, "warn"); } continue; }
        if (!CFG.autoRescue) { if (!Once.said(`obs|${a.kind}|${a.fromKey || a.flight?.fromKey}`, 60e3)) log(`[OBSERWATOR] zrobiłbym: ${a.kind} ${a.why || ""} — auto-ratunek OFF.`, "warn"); continue; }
        if (a.kind === "recall") { await Fly.recall(a.flight); break; }
        if (a.kind === "fly") { if (Fly.start(a)) { await Fly.tick(); } break; }
      }
      if (!actions.some(a => a.kind === "fly" || a.kind === "recall")) { if (!(await Recon.tick(s)) && !(await Expo.tick(s))) await Aster.tick(s); }
    } catch (e) { log(`[OBRONA] błąd pętli: ${e.message}`, "error"); }
    finally { running = false; try { UI.renderStatus(); } catch {} }
  }
  const Once = { said(k, ms) { const m = Store.get("once", {}) || {}; if (Date.now() - (m[k] || 0) < ms) return true; m[k] = Date.now(); for (const x of Object.keys(m)) if (Date.now() - m[x] > 3600e3) delete m[x]; Store.set("once", m); return false; } };
  const TabLock = {
    ID: Math.random().toString(36).slice(2),
    acquire() { try { const raw = localStorage.getItem("ogx3_lock"); const l = raw ? JSON.parse(raw) : null; if (l && l.id !== this.ID && Date.now() - l.at < 90e3) return false; localStorage.setItem("ogx3_lock", JSON.stringify({ id: this.ID, at: Date.now() })); return true; } catch { return true; } },
  };
  function keepalive() { const last = Store.get("last_load", 0) || 0; if (!Fly.mission() && last && Date.now() - last > 10 * 60e3) { log("[KEEPALIVE] przeładowanie (10 min bez nawigacji).", "info"); location.replace("/"); } }

  // ═══ PANEL ══════════════════════════════════════════════════════════════
  const UI = {
    el: null,
    build() {
      if (document.getElementById("ogx3-panel")) return;
      const d = document.createElement("div"); d.id = "ogx3-panel";
      d.style.cssText = "position:fixed;top:8px;left:8px;width:300px;max-height:95vh;overflow:auto;z-index:99999;background:#0b1220;color:#dfe8f5;font:12px/1.35 system-ui,sans-serif;border:1px solid #2b3a55;border-radius:8px;padding:8px;box-shadow:0 4px 18px rgba(0,0,0,.6)";
      d.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center"><b>OGameX 3 <span style="opacity:.6">v${VERSION}</span></b><button id="ogx3-on" class="ogx3-btn"></button></div>
        <div id="ogx3-status" style="margin:6px 0;white-space:pre-wrap"></div>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button id="ogx3-auto" class="ogx3-btn"></button>
          <button id="ogx3-push" class="ogx3-btn"></button>
          <button id="ogx3-voice" class="ogx3-btn"></button>
          <button id="ogx3-recon" class="ogx3-btn"></button>
        </div>
        <div style="margin:6px 0">Rezerwa deuteru <input id="ogx3-res" style="width:120px" /> · prędkość ucieczki <input id="ogx3-spd" style="width:36px" />%</div>
        <div style="margin:6px 0;border-top:1px solid #2b3a55;padding-top:6px">
          <b>Fleet Save nocny</b> <button id="ogx3-fs" class="ogx3-btn"></button> od <input id="ogx3-fs-a" style="width:26px" />:00 do <input id="ogx3-fs-b" style="width:26px" />:00 · <span id="ogx3-fs-st" style="opacity:.75"></span>
        </div>
        <div style="margin:6px 0;border-top:1px solid #2b3a55;padding-top:6px">
          <b>Mining asteroid</b> <button id="ogx3-aster" class="ogx3-btn"></button> <span id="ogx3-aster-st" style="opacity:.75"></span>
        </div>
        <div style="margin:6px 0;border-top:1px solid #2b3a55;padding-top:6px">
          <b>Ekspedycje</b> <button id="ogx3-expo" class="ogx3-btn"></button> <button id="ogx3-disc" class="ogx3-btn"></button><br>
          fale <input id="ogx3-waves" style="width:34px" /> · rezerwa slotów <input id="ogx3-slotres" style="width:30px" /> · <span id="ogx3-expo-st" style="opacity:.75"></span>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button id="ogx3-sim-moon" class="ogx3-btn">TEST: atak na księżyc</button>
          <button id="ogx3-sim-planet" class="ogx3-btn">TEST: atak na planetę</button>
          <button id="ogx3-dump" class="ogx3-btn">Zrzut DOM</button>
          <button id="ogx3-pushtest" class="ogx3-btn">Test push</button>
          <button id="ogx3-report" class="ogx3-btn">Kopiuj raport startowy</button>
          <button id="ogx3-abort" class="ogx3-btn">Przerwij lot</button>
        </div>
        <div style="margin-top:6px;opacity:.7;font-size:11px">ntfy: <span id="ogx3-topic"></span></div>
        <div style="margin-top:6px;display:flex;justify-content:space-between"><b>Log</b><span><button id="ogx3-copy" class="ogx3-btn">Copy</button> <button id="ogx3-clear" class="ogx3-btn">Clear</button></span></div>
        <div id="ogx3-log" style="max-height:38vh;overflow:auto;font:11px/1.3 ui-monospace,monospace;margin-top:4px"></div>
        <style>.ogx3-btn{background:#1c2a44;color:#dfe8f5;border:1px solid #33507a;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:11px}.ogx3-btn:hover{background:#274070}</style>`;
      document.body.appendChild(d); this.el = d;
      const $ = (id) => document.getElementById(id);
      $("ogx3-on").onclick = () => { CFG.enabled = !CFG.enabled; saveCfg(); log(`Bot ${CFG.enabled ? "ON" : "OFF"}`, "info"); this.renderStatus(); };
      $("ogx3-auto").onclick = () => { CFG.autoRescue = !CFG.autoRescue; saveCfg(); log(`Auto-ratunek ${CFG.autoRescue ? "ON — bot RUSZA flotą" : "OFF — obserwator"}`, "warn"); this.renderStatus(); };
      $("ogx3-push").onclick = () => { Store.set("ntfy_on", !Notifier.enabled()); this.renderStatus(); };
      $("ogx3-voice").onclick = () => { Store.set("voice_on", !Store.get("voice_on", false)); this.renderStatus(); };
      $("ogx3-recon").onclick = () => { CFG.recon = !CFG.recon; saveCfg(); log(`Rekonesans hangarów ${CFG.recon ? "ON" : "OFF — bot nie będzie wiedział, gdzie stoi flota"}`, CFG.recon ? "info" : "warn"); this.renderStatus(); };
      $("ogx3-aster").onclick = () => { CFG.aster.enabled = !CFG.aster.enabled; saveCfg(); log(`Mining asteroid ${CFG.aster.enabled ? "ON" : "OFF"}`, "info"); this.renderStatus(); };
      $("ogx3-fs").onclick = () => { CFG.fs.enabled = !CFG.fs.enabled; saveCfg(); log(`Fleet Save nocny ${CFG.fs.enabled ? `ON (${CFG.fs.startHour}:00–${CFG.fs.endHour}:00)` : "OFF"}`, "info"); this.renderStatus(); };
      $("ogx3-fs-a").value = String(CFG.fs.startHour); $("ogx3-fs-a").onchange = (e) => { CFG.fs.startHour = Math.max(0, Math.min(23, parseInt(e.target.value) || 23)); saveCfg(); this.renderStatus(); };
      $("ogx3-fs-b").value = String(CFG.fs.endHour); $("ogx3-fs-b").onchange = (e) => { CFG.fs.endHour = Math.max(0, Math.min(23, parseInt(e.target.value) || 7)); saveCfg(); this.renderStatus(); };
      $("ogx3-expo").onclick = () => { CFG.expo.enabled = !CFG.expo.enabled; saveCfg(); log(`Ekspedycje ${CFG.expo.enabled ? "ON" : "OFF"}`, "info"); this.renderStatus(); };
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
      $("ogx3-copy").onclick = () => { const t = logEntries.map(e => `[${e.time}] [${e.type.toUpperCase()}] ${e.msg}`).join("\n"); navigator.clipboard?.writeText(t); };
      $("ogx3-clear").onclick = () => { logEntries = []; Store.set("log", []); this.renderLog(); };
      this.renderStatus(); this.renderLog();
    },
    renderStatus() {
      if (!this.el) return; const $ = (id) => document.getElementById(id);
      $("ogx3-on").textContent = CFG.enabled ? "ON" : "OFF"; $("ogx3-on").style.background = CFG.enabled ? "#1e6b3a" : "#6b1e1e";
      $("ogx3-auto").textContent = CFG.autoRescue ? "Auto-ratunek ON" : "Obserwator (auto-ratunek OFF)"; $("ogx3-auto").style.background = CFG.autoRescue ? "#1e6b3a" : "#5a4a1e";
      $("ogx3-aster").textContent = `Mining ${CFG.aster.enabled ? "ON" : "OFF"}`; $("ogx3-aster").style.background = CFG.aster.enabled ? "#1e6b3a" : "#1c2a44";
      { const a0 = Store.get("aster", {}) || {}; $("ogx3-aster-st").textContent = CFG.aster.enabled ? `zakresy: ${(a0.ranges || []).length}${a0.sentTo ? ` · ostatnio: [${a0.sentTo}]` : ""}` : ""; }
      $("ogx3-fs").textContent = `FS ${CFG.fs.enabled ? "ON" : "OFF"}`; $("ogx3-fs").style.background = CFG.fs.enabled ? "#1e6b3a" : "#1c2a44";
      { const n = nightWindow(CFG.fs, new Date()); $("ogx3-fs-st").textContent = CFG.fs.enabled ? (n.active ? `NOC — flota powinna być w powietrzu, zawrót ${new Date(n.endsAt).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}` : `dzień (${n.nowHM})`) : "wyłączony"; }
      $("ogx3-expo").textContent = `Ekspedycje ${CFG.expo.enabled ? "ON" : "OFF"}`; $("ogx3-expo").style.background = CFG.expo.enabled ? "#1e6b3a" : "#1c2a44";
      $("ogx3-disc").textContent = `Odkrywca 40 min ${CFG.expo.discoverer40 ? "ON" : "OFF"}`;
      { const s0 = Situation.load(); const b = Store.get("burst", null); const e = s0.slots?.expo, f = s0.slots?.fleet;
        $("ogx3-expo-st").textContent = `sloty: expo ${e ? e.used + "/" + e.total : "?"}, floty ${f ? f.used + "/" + f.total : "?"}${b && b.sent ? ` · seria ${b.sent}/${b.waves}` : ""}`; }
      $("ogx3-push").textContent = `Push ${Notifier.enabled() ? "ON" : "OFF"}`; $("ogx3-voice").textContent = `Głos ${Store.get("voice_on", false) ? "ON" : "OFF"}`; $("ogx3-recon").textContent = `Rekonesans ${CFG.recon ? "ON" : "OFF"}`; $("ogx3-recon").style.background = CFG.recon ? "#1c2a44" : "#6b1e1e"; $("ogx3-topic").textContent = Notifier.topic();
      const s = Situation.load(); const now = Date.now();
      const th = (s.threats || []).filter(t => t.arriveAt > now);
      const fleets = Object.entries(s.hangars || {}).filter(([, h]) => h.total > 0 && now - h.at < 48 * 3600e3).sort((a, b) => b[1].total - a[1].total).slice(0, 4).map(([k, h]) => `${k.replace("|", " ")}: ${h.total.toLocaleString("pl-PL")} (${new Date(h.at).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })})`).join("\n  ");
      const fl = (s.flights || []).map(f => `${f.kind} [${f.fromKey}]→[${f.toKey}] ${f.phase}${f.recallAt ? " zawrót " + new Date(f.recallAt).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : ""}`).join("\n  ");
      const m = Fly.mission();
      $("ogx3-status").textContent = `Aktywne: ${s.active ? `${s.active.body} [${s.active.key}]` : "?"} · pary: ${Object.keys(s.pairs || {}).length} · pasek: ${s.bar ? `${s.bar.foreign} obcych${s.bar.barType ? " (" + s.bar.barType + ")" : ""}` : "?"}\nZagrożenia: ${th.length ? th.map(t => `${t.attack ? "ATAK" : "sonda"} → [${t.dst}] ${t.dstBody || "?"} za ${Math.round((t.arriveAt - now) / 1000)}s`).join("; ") : "brak"}\nHangary:\n  ${fleets || "(wejdź na Fleet)"}\nLoty: ${fl ? "\n  " + fl : "brak"}${m ? `\nMISJA: ${m.step} [${m.fromKey}]→[${m.toKey}]` : ""}${Session.lostRecently() ? "\nSESJA WYGASŁA" : ""}`;
    },
    renderLog() { const el = document.getElementById("ogx3-log"); if (!el) return; const col = { error: "#ff7b7b", warn: "#ffd56b", success: "#7bff9b", info: "#dfe8f5" }; el.innerHTML = logEntries.slice(0, 150).map(e => `<div style="color:${col[e.type] || "#dfe8f5"}">${e.time} ${e.msg.replace(/</g, "&lt;")}</div>`).join(""); },
  };

  // ═══ START ══════════════════════════════════════════════════════════════
  // Eksport do testów (node): globalThis.OGX3 gdy brak DOM.
  if (typeof document === "undefined" || typeof window === "undefined") { globalThis.OGX3 = { decide, Situation, Bar, Rows, DEFAULTS }; return; }
  try { window.__OGX3 = { decide, Situation, Bar, Rows, Fly, CFG }; } catch {}
  Store.set("last_load", Date.now());
  UI.build();
  log(`OGameX Assistant 3 v${VERSION} — ${CFG.enabled ? "ON" : "OFF"}, ${CFG.autoRescue ? "AUTO-RATUNEK" : "OBSERWATOR"}, ${HOST}`, "info");
  if (page() === "fleet") Hangar.scan();
  Wake.ensure(); Calib.collect();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") Wake.ensure(); });
  defenceTick();
  setInterval(defenceTick, CFG.tickMs);
  setInterval(keepalive, 60e3);
  // aktualizacja z repo
  setInterval(() => { try { GM_xmlhttpRequest({ method: "GET", url: "https://raw.githubusercontent.com/Mitjano/ogamex-userscript/main/ogamex-3.user.js?t=" + Date.now(), onload: (r) => { const v = (String(r.responseText || "").match(/@version\s+([\d.]+)/) || [])[1]; if (v && v !== VERSION && !Once.said("update|" + v, 3600e3)) log(`[UPDATE] repo ma v${v}, tu chodzi v${VERSION} — Tampermonkey → Sprawdź aktualizacje.`, "error"); } }); } catch {} }, 15 * 60e3);
})();
