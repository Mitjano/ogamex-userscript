// ==UserScript==
// @name         OGameX Assistant 3 (Genesis)
// @namespace    https://github.com/Mitjano/ogamex-userscript
// @version      3.0.1
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
  const VERSION = "3.0.1";
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
        if (!f && fleet && fleet.body === "planet" && pairs[k].hasMoon && now - fleet.at < 30 * 60e3) actions.push({ kind: "fly", fromKey: k, fromBody: "planet", toKey: k, toBody: "moon", why: "dom = księżyc", speed: 100, recall: false, home: true });
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

  // ═══ Fly — jeden wykonawca lotu ════════════════════════════════════════
  // Misja w Store "mission": { kind:"fly", fromKey, fromBody, toKey, toBody, speed, step, startedAt, air, recallAt, why }
  const Fly = {
    MISSIONS: ["DEPLOY", "DEPLOYMENT", "STATION", "STATIONING"],
    mission() { return Store.get("mission", null); },
    start(a) {
      if (this.mission()) return false;
      Store.set("mission", { ...a, step: "switch", startedAt: Date.now() });
      Journal.add("RATUNEK", `Start lotu: [${a.fromKey}] ${a.fromBody} → [${a.toKey}] ${a.toBody} (${a.why})`);
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
          if (a && a.key === m.fromKey && a.body === m.fromBody) { m.step = "form"; Store.set("mission", m); location.replace(`/fleet?x=${m.toKey.split(":")[0]}&y=${m.toKey.split(":")[1]}&z=${m.toKey.split(":")[2]}`); return; }
          const el = PlanetBar.anchor(m.fromKey, m.fromBody);
          if (!el) return this.abort(`brak [${m.fromKey}] ${m.fromBody} na pasku planet`);
          log(`[LOT] przełączam na ${m.fromBody} [${m.fromKey}]`, "info"); m.step = "switch_wait"; Store.set("mission", m); el.click(); return;
        }
        if (m.step === "switch_wait") { const a = PlanetBar.active(); if (a && a.key === m.fromKey && a.body === m.fromBody) { m.step = "form"; Store.set("mission", m); location.replace(`/fleet?x=${m.toKey.split(":")[0]}&y=${m.toKey.split(":")[1]}&z=${m.toKey.split(":")[2]}`); } return; }
        if (m.step === "form") {
          if (page() !== "fleet") { location.replace(`/fleet?x=${m.toKey.split(":")[0]}&y=${m.toKey.split(":")[1]}&z=${m.toKey.split(":")[2]}`); return; }
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
      // krok 1: wszystkie statki
      const els = [...document.querySelectorAll("[data-ship-type]")];
      const snap = Hangar.scan();
      if (!snap || snap.total === 0) { log(`[LOT] hangar ${m.fromBody} [${m.fromKey}] pusty — nic do wysłania.`, "warn"); Store.del("mission"); return; }
      const loaded = [];
      for (const el of els) {
        const qty = parseInt(el.dataset.shipQuantity || "0") || 0; if (!qty) continue;
        const item = el.closest(".ship-item") || el.parentElement;
        const input = item?.querySelector("input.numberFormatInput, input[type='text'], input[type='number']");
        if (!input) continue; setInput(input, qty); loaded.push(`${el.dataset.shipType}×${qty.toLocaleString("pl-PL")}`);
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
      let picked = null; for (const w of this.MISSIONS) { picked = missions.find(x => nameOf(x).includes(w)); if (picked) break; }
      if (!picked) { log(`[LOT DOM] brak misji Deploy/Station. Dostępne: ${missions.map(x => `${(x.textContent || "").trim().slice(0, 20)}[${x.className}]`).join(", ") || "NONE"}`, "error"); return this.abort("brak misji stacjonowania"); }
      picked.click(); await sleep(jitter(400, 800));
      const allRes = document.querySelector("a.btn-all-res, .btn-all-res");
      if (allRes) allRes.click(); else [...document.querySelectorAll("a.btn-res-full, .btn-res-full")].forEach(b => b.click());
      await sleep(jitter(400, 700));
      await this.applyReserve();
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
      s.flights = (s.flights || []).filter(f => f.fromKey !== m.fromKey);
      s.flights.push({ kind: m.air ? "air" : (m.home ? "home" : "swap"), fromKey: m.fromKey, fromBody: m.fromBody, toKey: m.toKey, toBody: m.toBody, sentAt: Date.now(), flightMs: m.flightMs || 0, recallAt: m.recallAt || 0, phase: "launched", tries: 0 });
      Situation.save(s);
      Store.del("mission");
      Journal.add(m.home ? "POWRÓT" : "RATUNEK", `WYSŁANO: [${m.fromKey}] ${m.fromBody} → [${m.toKey}] ${m.toBody} (${loaded.length} typów statków)${m.air ? `, zawrót ~${new Date(m.recallAt).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}` : ""}`);
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
      if (!actions.some(a => a.kind === "fly" || a.kind === "recall")) await Recon.tick(s);
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
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button id="ogx3-sim-moon" class="ogx3-btn">TEST: atak na księżyc</button>
          <button id="ogx3-sim-planet" class="ogx3-btn">TEST: atak na planetę</button>
          <button id="ogx3-dump" class="ogx3-btn">Zrzut DOM</button>
          <button id="ogx3-pushtest" class="ogx3-btn">Test push</button>
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
      $("ogx3-res").value = String(CFG.deutReserve || 0); $("ogx3-res").onchange = (e) => { CFG.deutReserve = parseInt(String(e.target.value).replace(/[^\d]/g, "")) || 0; saveCfg(); log(`Rezerwa deuteru: ${CFG.deutReserve.toLocaleString("pl-PL")}`, "info"); };
      $("ogx3-spd").value = String(CFG.airSpeedPct); $("ogx3-spd").onchange = (e) => { CFG.airSpeedPct = Math.max(1, Math.min(100, parseInt(e.target.value) || 10)); saveCfg(); };
      const sim = (body) => { const a = PlanetBar.active(); if (!a) return alert("Nie widzę aktywnej planety."); Store.set("sim", { key: a.key, body, arriveAt: Date.now() + 150e3, until: Date.now() + 180e3 }); log(`[TEST] symulacja: atak na ${body === "moon" ? "KSIĘŻYC" : "PLANETĘ"} [${a.key}], dolot 150 s. Auto-ratunek: ${CFG.autoRescue ? "ON (flota poleci!)" : "OFF (tylko decyzja w logu)"}`, "error"); defenceTick(); };
      $("ogx3-sim-moon").onclick = () => sim("moon"); $("ogx3-sim-planet").onclick = () => sim("planet");
      $("ogx3-dump").onclick = () => { const ev = document.querySelector("#fleet-movement-content, #layoutFleetMovements"); log(`[DOM] pasek planet: ${JSON.stringify(PlanetBar.pairs().slice(0, 6))} … aktywne: ${JSON.stringify(PlanetBar.active())}`, "info"); log(`[DOM] pasek misji: ${JSON.stringify(Bar.read())}`, "info"); log(`[DOM] Events (${ev ? "jest" : "BRAK"}): ${(ev?.outerHTML || "").replace(/\s+/g, " ").slice(0, 2500)}`, "info"); if (page() === "fleet") log(`[DOM] hangar: ${JSON.stringify(Hangar.scan())}`, "info"); };
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
  defenceTick();
  setInterval(defenceTick, CFG.tickMs);
  setInterval(keepalive, 60e3);
  // aktualizacja z repo
  setInterval(() => { try { GM_xmlhttpRequest({ method: "GET", url: "https://raw.githubusercontent.com/Mitjano/ogamex-userscript/main/ogamex-3.user.js?t=" + Date.now(), onload: (r) => { const v = (String(r.responseText || "").match(/@version\s+([\d.]+)/) || [])[1]; if (v && v !== VERSION && !Once.said("update|" + v, 3600e3)) log(`[UPDATE] repo ma v${v}, tu chodzi v${VERSION} — Tampermonkey → Sprawdź aktualizacje.`, "error"); } }); } catch {} }, 15 * 60e3);
})();
