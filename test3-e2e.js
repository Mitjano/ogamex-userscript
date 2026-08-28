// ═════════════════════════════════════════════════════════════════════════
//  TEST E2E 3.x — PRAWDZIWY kod bota uruchomiony na SZTUCZNEJ grze (jsdom)
// ═════════════════════════════════════════════════════════════════════════
// Powód: `test3-decide.js` sprawdza decyzje (czysta funkcja) i wzorce w źródle.
// NIE sprawdzał maszyny lotu: klikania formularza, przeładowań strony w środku
// misji, zapisu lotu, zawrotu. A to tam mieszkały defekty K2/K3/K6 z audytu.
// Tu odpala się CAŁY plik ogamex-3.user.js na atrapie gry, która zachowuje się
// jak fork .NET: pasek planet, pasek misji, panel Events, lista ruchów po AJAX
// i trzykrokowy formularz floty. Nawigacja = ponowne wykonanie skryptu, tak jak
// w przeglądarce (stan musi przeżyć w GM storage).
//
//   node test3-e2e.js

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "ogamex-3.user.js"), "utf8");

let fails = 0, checks = 0;
const check = (name, cond, extra = "") => { checks++; console.log(`${cond ? "OK  " : "FAIL"} | ${name}${cond ? "" : " → " + extra}`); if (!cond) fails++; };

// ─── ATRAPA GRY ──────────────────────────────────────────────────────────
class Game {
  constructor(opts = {}) {
    this.store = new Map();          // GM storage — przeżywa "przeładowania"
    this.session = new Map();        // sessionStorage — przeżywa nawigacje karty
    this.local = new Map();          // localStorage
    this.pairs = opts.pairs || [{ key: "1:100:5", name: "Baza", moon: true }, { key: "1:100:9", name: "Kolonia", moon: true }];
    this.hangars = opts.hangars || { "1:100:5|moon": { LIGHT_FIGHTER: 900, SMALL_CARGO: 100 } };
    this.active = opts.active || { key: "1:100:5", body: "moon" };
    this.threats = opts.threats || [];      // [{src,dst,dstBody,eta,type}]
    this.page = "home";
    this.query = "";
    this.sent = [];                          // wysłane floty
    this.navigations = [];
    this.slots = { fleet: { used: 0, total: 8 }, expo: { used: 0, total: 6 } };
    this.formStep = 0;
    this.formShips = {};
    this.formTarget = null;
    this.formBody = "planet";
    this.formMission = null;
    this.ghosts = 0;          // obce floty widoczne TYLKO na pasku (test slepego alarmu)
    this.hideBar = false;     // strona bez paska misji (formularz, blad, logowanie)
    this.noSpeeds = false;    // formularz bez suwaka predkosci
    this.deadNext = 0;        // ile razy krok 2 ma byc BEZ przycisku „Next"
    this.hijackForm = false;  // operator przelacza planete w srodku formularza
    this.formSpeed = null;    // ostatnio klinieta predkosc
    this.flightSec = 81;      // czas lotu pokazywany w kroku 2
    this.asteroid = false;    // czy w skanowanym ukladzie jest asteroida (wiersz 17)
    this.asteroidTtl = 3600;  // ile sekund do jej zniknięcia
    this.debris = false;      // czy przy bazie lezy zlom
    this.loggedOut = false;   // gra oddaje strone logowania
    this.errorPage = false;   // gra oddaje strone bledu
  }
  // wlasne loty w liscie ruchow — z przyciskiem zawracania (fork: a.x_btn_fleet_return)
  ownRowsHtml(onlyActive) {
    return this.sent.map((s, i) => ({ s, i }))
      .filter(({ s }) => s.inFlight && (!onlyActive || s.from === this.active.key || s.to === this.active.key))
      .map(({ s, i }) => `<tr class="row-mission-type-DEPLOY${s.returning ? " row-fleet-return" : ""}" data-fleet-id="own${i}">
         <td data-remaining-seconds="${s.eta || 600}">10:00</td>
         <td><span class="fleet-source-coords">[${s.from}]</span> Ja</td>
         <td><a href="#">[${s.to}]</a> ${s.toBody === "moon" ? '<img src="/img/moon-icon.png">Moon' : "Planet"}</td>
         <td><a class="x_btn_fleet_return" data-fleet-id="own${i}" href="#">R</a></td>
       </tr>`).join("");
  }
  // flota wraca do hangaru zrodla (przylot po zawrocie)
  land(i) {
    const f = this.sent[i]; if (!f) return;
    f.inFlight = false; f.landed = true;
    const key = `${f.from}|${f.fromBody}`;
    const h = this.hangars[key] || (this.hangars[key] = {});
    for (const [t, q] of Object.entries(f.ships)) h[t] = (h[t] || 0) + q;
    this.slots.fleet.used = Math.max(0, this.slots.fleet.used - 1);
  }
  loginHtml() { return `<form id="login" action="/auth/login"><input type="password" name="password"><button>Login</button></form>`; }
  hangarOf() { return this.hangars[`${this.active.key}|${this.active.body}`] || {}; }
  // ── HTML poszczególnych stron (kształt wzorowany na forku) ──
  planetBarHtml() {
    return `<ul id="planetList">` + this.pairs.map(p => {
      const sel = p.key === this.active.key;
      const pSel = sel && this.active.body === "planet" ? " selected" : "";
      const mSel = sel && this.active.body === "moon" ? " selected" : "";
      return `<li><a href="#" class="planet-select${pSel}" data-key="${p.key}">${p.name} [${p.key}]</a>` +
             (p.moon ? `<a href="#" class="moon-select${mSel}" data-key="${p.key}">Moon</a>` : "") + `</li>`;
    }).join("") + `</ul>`;
  }
  missionBarHtml() {
    if (this.hideBar) return "";
    const hostile = this.threats.length + this.ghosts;
    const own = this.sent.filter(s => s.inFlight).length;
    if (!hostile && !own) return `<div id="bar">No fleet movement</div>`;
    return `<div id="bar">${hostile + own} Missions: ${own} Own ${hostile} Hostile Next: 05:00 Type: ${hostile ? "Attack" : "Deploy"}</div>`;
  }
  rowsHtml(onlyActive) {
    return this.threats.filter(t => !onlyActive || t.dst === this.active.key).map(t =>
      `<tr class="row-mission-type-${t.type || "ATTACK"} row-hostile-mission" data-fleet-id="${t.id || "t1"}">
         <td data-remaining-seconds="${t.eta}">05:00</td>
         <td><span class="fleet-source-coords">[${t.src || "9:9:9"}]</span> Wróg</td>
         <td><a href="#">[${t.dst}]</a> ${t.dstBody === "moon" ? '<img src="/img/moon-icon.png">Moon' : "Planet"}</td>
       </tr>`).join("");
  }
  fleetPageHtml() {
    const h = this.hangarOf();
    const ships = Object.entries(h).filter(([, q]) => q > 0).map(([t, q]) =>
      `<div class="ship-item"><span data-ship-type="${t}" data-ship-quantity="${q}"></span><input class="numberFormatInput" type="text" value="0"></div>`).join("");
    return `<div id="content">
      <div>Fleets: ${this.slots.fleet.used} / ${this.slots.fleet.total} Expeditions: ${this.slots.expo.used} / ${this.slots.expo.total}</div>
      <div id="step1">${ships || "There are no ships on this planet at this time."}</div>
      <a class="btn-continue" id="btn-next-fleet2">Next</a>
    </div>`;
  }
  step2Html() {
    return `<div id="content">
      <div id="target_planet_type_container">
        <input id="fleet2_target_x" value=""><input id="fleet2_target_y" value=""><input id="fleet2_target_z" value="">
        <a data-planet-type="1" class="planet-icon">Planet</a><a data-planet-type="2" class="moon-icon">Moon</a><a data-planet-type="3">Debris</a>
      </div>
      ${this.noSpeeds ? "" : '<div class="speeds"><a>10</a><a>50</a><a>100</a></div>'}
      <div>Duration of flight (one way): ${((sec) => sec >= 3600
        ? `${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor(sec % 3600 / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`
        : `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`)(Math.round(this.flightSec * 100 / (this.formSpeed || 100)))}</div>
      ${this.deadNext > 0 ? "" : '<a class="btn-continue" id="btn-next-fleet3">Next</a>'}
    </div>`;
  }
  step3Html() {
    return `<div id="content">
      <a class="mission-item DEPLOY">Deploy</a><a class="mission-item EXPEDITION">Expedition</a><a class="mission-item ATTACK">Attack</a>
      <a class="mission-item ASTEROID_MINING">Asteroid mining</a><a class="mission-item COLLECT">Collect</a>
      <a class="btn-all-res">Wszystkie surowce</a>
      <a class="btn-res-full">max</a><a class="btn-res-full">max</a><div><a class="btn-res-full">max deuter</a><input name="deuterium" value="500000"></div>
      <a class="btn-continue" id="btn-submit-fleet">Send fleet</a>
    </div>`;
  }
  bodyHtml() {
    if (this.loggedOut) return this.loginHtml();
    if (this.errorPage) return `<div class="error-page"><h1>Error occurred</h1><p>Runtime Error — Internal Server Error</p><a href="/">Back to game</a></div>`;
    const events = `<table id="fleet-movement-content"><tbody>${this.rowsHtml(false)}${this.ownRowsHtml(false)}</tbody></table>`;
    let main = "";
    if (this.page === "fleet") main = this.formStep === 0 ? this.fleetPageHtml() : this.formStep === 1 ? this.step2Html() : this.step3Html();
    else if (this.page === "galaxy") {
      const q = new URLSearchParams((this.query || "").replace(/^\?/, ""));
      const gx = q.get("x") || "1", sy = q.get("y") || "100";
      main = `
        <div class="galaxy-item"><span class="planet-index">5</span>
          <div class="galaxy-col col-debris">${this.debris ? `<a href="/fleet?x=${gx}&y=${sy}&z=5&mission=8">Debris 120.000</a>` : ""}</div>
        </div>
        <div class="galaxy-item"><span class="planet-index">16</span><a href="/fleet?x=${gx}&y=${sy}&z=16&mission=15">Expedition</a></div>
        <div class="galaxy-item"><span class="planet-index">17</span>
          ${this.asteroid ? `<span data-asteroid-disappear="${this.asteroidTtl}"></span><a class="btn-asteroid" href="/fleet?x=${gx}&y=${sy}&z=17&mission=12">Asteroid</a>` : "<span>Find asteroids</span>"}
        </div>`;
    }
    else main = `<div id="overview">Overview</div>`;
    return `${this.planetBarHtml()}${this.missionBarHtml()}${events}${main}`;
  }
}

// ─── URUCHOMIENIE BOTA NA ATRAPIE (jedno "załadowanie strony") ───────────
function load(game, { cfg = {}, ticks = 1 } = {}) {
  const url = `https://genesis.ogamex.net/${game.page}${game.query}`;
  const dom = new JSDOM(`<!doctype html><html><body>${game.bodyHtml()}</body></html>`, { url, pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window;
  // GM storage + magazyny przeglądarki (trwałe między załadowaniami)
  w.GM_getValue = (k, d) => (game.store.has(k) ? game.store.get(k) : d);
  w.GM_setValue = (k, v) => game.store.set(k, v);
  w.GM_xmlhttpRequest = () => {};
  const mkStorage = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
  Object.defineProperty(w, "sessionStorage", { value: mkStorage(game.session), configurable: true });
  Object.defineProperty(w, "localStorage", { value: mkStorage(game.local), configurable: true });
  // fetch: lista ruchów widzi TYLKO aktywną parę (tak jak fork)
  w.fetch = async (u) => ({ ok: true, redirected: !!game.loggedOut, url: game.loggedOut ? "/auth/login" : u, status: 200,
    text: async () => game.loggedOut ? game.loginHtml()
      : u.includes("fleetmovementlist") ? `<table><tbody>${game.rowsHtml(true)}${game.ownRowsHtml(true)}</tbody></table>`
      : "<div class='galaxy-asteroid-modal'>[1:31:1] [1:51:9]</div>" });
  // nawigacja
  const nav = (to) => {
    game.navigations.push(to);
    const [pth, q] = String(to).split("?");
    game.page = pth.replace(/^\//, "") || "home";
    game.query = q ? "?" + q : "";
    if (game.page === "fleet") game.formStep = 0;
    // Adres MUSI isc za nawigacja: bot potwierdza wysylke m.in. po `fleetSendSuccessfully`
    // w URL. Bez tego potwierdzenie opieralo sie na przypadkowym odczycie hangaru.
    if (w.__fakeLoc) {
      w.__fakeLoc.href = `https://genesis.ogamex.net/${game.page}${game.query}`;
      w.__fakeLoc.pathname = "/" + game.page;
      w.__fakeLoc.search = game.query;
    }
  };
  // jsdom nie pozwala podmienić window.location — podstawiamy ją przez parametr
  // funkcji opakowującej (shadowing), więc kod bota widzi naszą atrapę nawigacji.
  w.__fakeLoc = { href: url, host: "genesis.ogamex.net", hostname: "genesis.ogamex.net", origin: "https://genesis.ogamex.net", protocol: "https:", pathname: "/" + game.page, search: game.query, replace: nav, assign: nav, reload: () => nav("/" + game.page) };
  // Bot celowo robi ludzkie przerwy (1-2 s na krok formularza). W teście skracamy
  // JE SAME, nie logikę: zegar symulatora biegnie 150× szybciej (24 scenariusze
  // musza zmiescic sie w rozsadnym czasie).
  const realST = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms, ...a) => realST(fn, Math.min(Math.max(0, (ms || 0) / 150), 20), ...a);
  // jsdom nie liczy layoutu, więc offsetParent zawsze === null i bot słusznie
  // uznawałby WSZYSTKIE elementy za niewidoczne. Udajemy widoczność.
  Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return this.ownerDocument && this.ownerDocument.body; }, configurable: true });
  w.navigator.wakeLock = { request: async () => ({ addEventListener() {}, released: false }) };
  w.AudioContext = function () { return { state: "running", resume: async () => {}, createOscillator: () => ({ frequency: {}, connect() {}, start() {}, stop() {} }), createGain: () => ({ gain: {}, connect() {} }), destination: {} }; };
  w.alert = () => {};
  // ── zachowanie gry: kliknięcia w formularzu i pasku planet ──
  w.document.addEventListener("click", (ev) => {
    const el = ev.target;
    if (process.env.DIAG3) console.log("      KLIK:", el.id || el.className || el.tagName, "| krok:", game.formStep);
    const cls = String(el.className || ""), id = String(el.id || "");
    if (cls.includes("planet-select") || cls.includes("moon-select")) {
      game.active = { key: el.getAttribute("data-key"), body: cls.includes("moon-select") ? "moon" : "planet" };
      nav("/" + game.page);
      return;
    }
    if (el.parentElement && String(el.parentElement.className || "").includes("speeds")) {
      game.formSpeed = parseInt((el.textContent || "0").replace(/[^\d]/g, "")) || null;
      // Gra przelicza SAM czas lotu (AJAX) — przerenderowanie calego formularza
      // kasowaloby wpisane koordy celu, czego prawdziwa gra nie robi.
      const secs = Math.round(game.flightSec * 100 / (game.formSpeed || 100));
      const dur = [...w.document.querySelectorAll("div")].find(d => /Duration of flight/i.test(d.textContent || "") && d.children.length === 0);
      if (dur) dur.textContent = `Duration of flight (one way): ${secs >= 3600
        ? `${String(Math.floor(secs / 3600)).padStart(2, "0")}:${String(Math.floor(secs % 3600 / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`
        : `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`}`;
      return;
    }
    if (id === "btn-next-fleet2") {
      if (game.hijackForm) {                     // operator klika inna planete w srodku misji
        game.hijackForm = false;
        game.active = { key: game.pairs[1].key, body: "moon" };
        nav("/" + game.page);
        return;
      }
      game.formShips = {};
      for (const it of w.document.querySelectorAll(".ship-item")) {
        const t = it.querySelector("[data-ship-type]")?.getAttribute("data-ship-type");
        const v = parseInt((it.querySelector("input")?.value || "0").replace(/[^\d]/g, "")) || 0;
        if (t && v > 0) game.formShips[t] = v;
      }
      game.formStep = 1; w.document.body.innerHTML = game.bodyHtml(); return;
    }
    if (id === "btn-next-fleet3") {
      const g = w.document.getElementById("fleet2_target_x")?.value, s2 = w.document.getElementById("fleet2_target_y")?.value, p2 = w.document.getElementById("fleet2_target_z")?.value;
      game.formTarget = [g, s2, p2].join(":");
      game.formStep = 2; w.document.body.innerHTML = game.bodyHtml(); return;
    }
    if (el.getAttribute && el.getAttribute("data-planet-type")) { game.formBody = { 1: "planet", 2: "moon", 3: "debris" }[el.getAttribute("data-planet-type")]; return; }
    if (cls.includes("mission-item")) { game.formMission = (el.textContent || "").trim(); return; }
    if (cls.includes("x_btn_fleet_return")) {
      const i = parseInt(String(el.getAttribute("data-fleet-id") || "").replace("own", ""));
      if (game.sent[i]) game.sent[i].returning = true;
      w.document.body.innerHTML = game.bodyHtml();
      return;
    }
    if (id === "btn-submit-fleet") {
      // wysyłka: hangar źródła pustoszeje, gra przekierowuje (jak fork)
      const src = `${game.active.key}|${game.active.body}`;
      const h = game.hangars[src] || {};
      for (const [t, q] of Object.entries(game.formShips)) { h[t] = Math.max(0, (h[t] || 0) - q); if (!h[t]) delete h[t]; }
      game.hangars[src] = h;
      game.sent.push({ from: game.active.key, fromBody: game.active.body, to: game.formTarget, toBody: game.formBody, mission: game.formMission, ships: { ...game.formShips }, inFlight: true });
      game.slots.fleet.used++;
      nav("/home?fleetSendSuccessfully=1");
      w.document.body.innerHTML = game.bodyHtml();     // gra przeladowala strone: formularza juz nie ma
      return;
    }
  }, true);
  // wstrzyknięcie PRAWDZIWEGO kodu bota
  w.__runBot = new w.Function("location", SRC);
  try { w.__runBot(w.__fakeLoc); } catch (e) { console.log("!! BŁĄD PRZY STARCIE BOTA:", e && e.message); console.log(String((e && e.stack) || "").split("\n").slice(0, 5).join("\n")); }
  const api = w.__OGX3;
  if (!api) { console.log("DIAG: __OGX3 brak; panel:", !!w.document.getElementById("ogx3-panel"), "| klucze store:", [...game.store.keys()].slice(0,5)); }
  if (api && Object.keys(cfg).length) { for (const [k, v] of Object.entries(cfg)) { if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(api.CFG[k], v); else api.CFG[k] = v; } api.Store.set("cfg", api.CFG); }
  return { w, api, dom, async tick(n = ticks) { for (let i = 0; i < n; i++) await api.defenceTick(); } };
}

// Przewiniecie zegara: bot trzyma czasy bezwzglednie w GM storage, wiec „uplyw
// czasu" symulujemy cofajac znaczniki (sentAt/recallAt/seenAt/since/at) o `ms`.
// Zamiast wylaczac zabezpieczenia czasowe — pozwalamy im minac.
function advance(game, ms) {
  const K = "genesis.ogamex.net:ogx3_situation";
  try {
    const st = JSON.parse(game.store.get(K) || "null");
    if (st) {
      for (const t of st.threats || []) { t.seenAt -= ms; t.arriveAt -= ms; if (t.lastSeenAt) t.lastSeenAt -= ms; }
      for (const f of st.flights || []) { f.sentAt -= ms; if (f.recallAt) f.recallAt -= ms; }
      if (st.barExcess && st.barExcess.since) st.barExcess.since -= ms;
      if (st.bar && st.bar.at) st.bar.at -= ms;
      game.store.set(K, JSON.stringify(st));
    }
  } catch {}
  for (const k of [...game.store.keys()]) {
    if (!/ogx3_(mission|last_send|bar_excess|once|nav|human|session|aster|debris|expo|burst|errpage|last_)/.test(k)) continue;
    try {
      const v = JSON.parse(game.store.get(k));
      if (typeof v === "number") { game.store.set(k, JSON.stringify(v - ms)); continue; }
      if (v && typeof v === "object") {
        for (const f of ["at", "since", "startedAt", "until", "lostAt", "triedAt", "lastScanAt", "sentAt", "rangesAt", "lastSendAt"]) if (typeof v[f] === "number") v[f] -= ms;
        game.store.set(k, JSON.stringify(v));
      }
    } catch {}
  }
}

// „przeglądarka": ładuje stronę, robi ticki, i tak dopóki bot nawiguje
async function run(game, { cfg, loads = 25, ticksPerLoad = 3 } = {}) {
  const logs = [];
  for (let i = 0; i < loads; i++) {
    const before = game.navigations.length;
    // symulacja UPŁYWU CZASU: bot czeka ~20 s na potwierdzenie zagrożenia (ochrona
    // przed artefaktami paska). Cofamy `seenAt`, zamiast wyłączać tę ochronę.
    if (i > 0) {
      try {
        const k = "genesis.ogamex.net:ogx3_situation";
        const st = JSON.parse(game.store.get(k) || "null");
        if (st && st.threats) { for (const t of st.threats) t.seenAt -= 30000; game.store.set(k, JSON.stringify(st)); }
      } catch {}
    }
    const inst = load(game, { cfg });
    try { await inst.tick(ticksPerLoad); } catch (e) { console.log("!! TICK RZUCIŁ:", e && e.message); }
    await new Promise(r => setTimeout(r, 140));   // czas na dokonczenie krokow bota (jego wlasne pauzy sa 150x krotsze)
    try { inst.w.eval("if (typeof logEntries !== 'undefined') {}"); } catch {}
    if (process.env.DIAG2) {
      try { const st2 = inst.api.Situation.load(); console.log("      decyzja:", JSON.stringify(inst.api.decide(st2, inst.api.CFG, Date.now())).slice(0, 300), "| CFG.autoRescue:", inst.api.CFG.autoRescue, "| misja:", JSON.stringify(inst.api.Fly.mission())); } catch (e) { console.log("      decyzja rzuciła:", e.message); }
      const st = JSON.parse(game.store.get("genesis.ogamex.net:ogx3_situation") || "null");
      const lg = JSON.parse(game.store.get("genesis.ogamex.net:ogx3_log") || "[]");
      console.log(`   [load ${i}] strona=${game.page} pary=${st ? Object.keys(st.pairs || {}).length : "?"} zagr=${st ? (st.threats || []).length : "?"} hangary=${st ? Object.keys(st.hangars || {}).length : "?"} log=${lg.length} nawig=${game.navigations.length}`);
      lg.slice(0, 3).forEach(e => console.log("      ", e.msg.slice(0, 120)));
    }
    try { for (const e of JSON.parse(game.store.get("genesis.ogamex.net:ogx3_log") || "[]")) logs.push(e.msg); } catch {}
    // Koniec dopiero, gdy bot nie nawigowal, nie ma rozpoczetej misji ANI nie czeka
    // na potwierdzenie zagrozenia. Bez tego ostatniego warunku petla konczyla sie
    // w trakcie 20-sekundowego potwierdzania ataku i test mierzyl wlasna niecierpliwosc.
    const busy = (game.store.get("genesis.ogamex.net:ogx3_mission") || "null") !== "null";
    let waiting = false;
    try {
      const st = JSON.parse(game.store.get("genesis.ogamex.net:ogx3_situation") || "null");
      waiting = !!(st && (st.threats || []).some(t => t.attack && t.arriveAt > Date.now()));
      waiting = waiting || !!(st && st.barExcess && st.barExcess.count > 0);
    } catch {}
    if (game.navigations.length === before && !busy && !waiting) break;
  }
  return { logs: [...new Set(logs)] };
}

(async () => {
  console.log("\n════ E2E: PRAWDZIWY BOT NA SZTUCZNEJ GRZE ════");

  console.log("\n── 1. CISZA: bot nie rusza flotą bez powodu ──");
  {
    const g = new Game();
    await run(g, { cfg: { autoRescue: true, expo: { enabled: false }, recon: false } });
    check("zero wysyłek, gdy nic nie leci", g.sent.length === 0, JSON.stringify(g.sent));
  }

  console.log("\n── 2. ATAK NA KSIĘŻYC Z FLOTĄ → pełna ścieżka ewakuacji ──");
  {
    const g = new Game({ threats: [{ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 300 }] });
    const { logs } = await run(g, { cfg: { autoRescue: true, expo: { enabled: false } }, loads: 10, ticksPerLoad: 3 });
    const s = g.sent[0];
    check("bot WYSŁAŁ flotę", g.sent.length === 1, JSON.stringify(g.sent));
    check("wyleciała z atakowanego księżyca", s && s.from === "1:100:5" && s.fromBody === "moon", JSON.stringify(s));
    check("poleciała na sąsiedni KSIĘŻYC w układzie, nie na atakowaną parę", s && s.to === "1:100:9" && s.toBody === "moon", JSON.stringify(s));
    check("zabrała CAŁY hangar", s && s.ships.LIGHT_FIGHTER === 900 && s.ships.SMALL_CARGO === 100, JSON.stringify(s && s.ships));
    check("misja to stacjonowanie (Deploy), nie atak", s && /Deploy/i.test(s.mission || ""), s && s.mission);
    check("hangar źródła jest pusty po wysyłce", Object.keys(g.hangars["1:100:5|moon"] || {}).length === 0, JSON.stringify(g.hangars["1:100:5|moon"]));
    const st = JSON.parse(g.store.get("genesis.ogamex.net:ogx3_situation") || "{}");
    const f = (st.flights || [])[0];
    check("lot ZAPISANY w stanie (bez tego nie ma zawrotu)", !!f && f.fromKey === "1:100:5", JSON.stringify(st.flights));
    check("zaplanowany zawrót po przejściu ataku", !!f && f.recallAt > Date.now(), f && new Date(f.recallAt).toISOString());
    check("wpis nie został 'pending' (wysyłka potwierdzona)", !!f && !f.pending, JSON.stringify(f));
    check("dziennik obrony zawiera wpis o ewakuacji", logs.some(m => /WYSŁANO/.test(m)) || logs.some(m => /Send fleet kliknięty/.test(m)), logs.slice(0, 6).join(" | "));
  }

  console.log("\n── 3. ATAK NA PLANETĘ przy flocie na księżycu → BEZ RUCHU ──");
  {
    const g = new Game({ threats: [{ src: "9:9:9", dst: "1:100:5", dstBody: "planet", eta: 300 }] });
    const { logs } = await run(g, { cfg: { autoRescue: true, expo: { enabled: false } }, loads: 20, ticksPerLoad: 3 });
    check("flota nie drgnęła", g.sent.length === 0, JSON.stringify(g.sent));
    check("bot powiedział wprost, że to bezpieczna strona", logs.some(m => /bezpieczna strona/.test(m)), logs.slice(0, 5).join(" | "));
  }

  console.log("\n── 4. TRYB OBSERWATORA: alarm bez ruchu floty ──");
  {
    const g = new Game({ threats: [{ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 300 }] });
    const { logs } = await run(g, { cfg: { autoRescue: false, expo: { enabled: false } }, loads: 20, ticksPerLoad: 3 });
    check("obserwator NIE rusza flotą", g.sent.length === 0, JSON.stringify(g.sent));
    check("ale mówi, co by zrobił", logs.some(m => /OBSERWATOR/.test(m)), logs.slice(0, 5).join(" | "));
  }

  console.log("\n── 5. DWIE KARTY: druga nie dubluje wysyłki ──");
  {
    const g = new Game({ threats: [{ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 300 }] });
    const a = load(g, { cfg: { autoRescue: true, expo: { enabled: false } } });
    const bSession = new Map();
    const gb = Object.create(g); gb.session = bSession;      // druga karta = inna sesja
    await a.tick(2);
    const b = load(gb, { cfg: { autoRescue: true, expo: { enabled: false } } });
    await b.tick(2);
    check("druga karta ustępuje (jeden lider)", g.sent.length <= 1, `wysyłek: ${g.sent.length}`);
  }

  console.log("\n── 6. NAWIGACJA NIE GUBI MISJI (defekt K1/K6 z audytu) ──");
  {
    const g = new Game({ threats: [{ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 300 }] });
    await run(g, { cfg: { autoRescue: true, expo: { enabled: false } }, loads: 30, ticksPerLoad: 1 });
    check("mimo wielu przeładowań ewakuacja doszła do skutku", g.sent.length === 1, `wysyłek: ${g.sent.length}, nawigacji: ${g.navigations.length}`);
    check("nie wysłał floty dwa razy", g.sent.length < 2, JSON.stringify(g.sent.map(s => s.to)));
  }

  console.log("\n── 7. ATAK NA DRUGĄ KOLONIĘ (lista ruchów jej nie pokazuje — tylko Events) ──");
  {
    const g = new Game({
      hangars: { "1:100:5|moon": { LIGHT_FIGHTER: 10 }, "1:100:9|moon": { BATTLESHIP: 5000 } },
      active: { key: "1:100:5", body: "moon" },
      threats: [{ src: "9:9:9", dst: "1:100:9", dstBody: "moon", eta: 300 }],
    });
    // bot musi najpierw poznać hangar drugiej kolonii — rekonesans włączony
    const { logs } = await run(g, { cfg: { autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1 }, loads: 30, ticksPerLoad: 2 });
    const s = g.sent.find(x => x.from === "1:100:9");
    check("bot zauważył atak na NIEAKTYWNĄ kolonię", logs.some(m => /1:100:9/.test(m)), logs.slice(0, 8).join(" | "));
    check("i wyprowadził stamtąd flotę", !!s, JSON.stringify(g.sent));
  }

  console.log("\n── 8. EKSPEDYCJA nie blokuje obrony ──");
  {
    const g = new Game();
    const { logs } = await run(g, { cfg: { autoRescue: true, expo: { enabled: true, waves: 1 }, recon: true, reconMs: 300000, human: { breaks: false, economyAtNight: true } }, loads: 25, ticksPerLoad: 2 });
    if (process.env.DIAG) { console.log("   LOG (expo):"); logs.filter(m => /EXPO|LOT|galax/i.test(m)).slice(0, 12).forEach(m => console.log("     ", m.slice(0, 150))); console.log("   NAWIGACJE:", g.navigations.slice(0, 8)); }
    const expo = g.sent.find(s => /Expedition/i.test(s.mission || ""));
    const st = JSON.parse(g.store.get("genesis.ogamex.net:ogx3_situation") || "{}");
    check("ekspedycja poleciała", !!expo, JSON.stringify(g.sent.map(s => s.mission)));
    check("i NIE zapisała się jako lot obronny (nie zablokuje ratunku)", (st.flights || []).length === 0, JSON.stringify(st.flights));
  }

  console.log("\n── 9. ZAWRÓT: atak minął → bot klika zawracanie → lot domknięty po powrocie floty ──");
  {
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1 };
    const g = new Game({ threats: [{ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 300 }] });
    await run(g, { cfg, loads: 10, ticksPerLoad: 3 });
    check("(warunek wstępny) ewakuacja poszła", g.sent.length === 1, JSON.stringify(g.sent));
    g.threats = [];                     // atak przeszedł
    advance(g, 15 * 60e3);              // minęło 15 min — czas na zawrót
    const r2 = await run(g, { cfg, loads: 8, ticksPerLoad: 2 });
    check("bot KLIKNĄŁ zawracanie lotu", !!(g.sent[0] && g.sent[0].returning), JSON.stringify(g.sent[0]));
    const st2 = JSON.parse(g.store.get("genesis.ogamex.net:ogx3_situation") || "{}");
    const f2 = (st2.flights || [])[0];
    check("stan lotu przeszedł w zawrót (nie klika w kółko)", !f2 || ["recall_clicked", "recalled"].includes(f2.phase), JSON.stringify(st2.flights));
    check("dziennik mówi o zawrocie", r2.logs.some(m => /ZAWRÓT/.test(m)), r2.logs.filter(m => /LOT|ZAWR|recall/i.test(m)).slice(0, 10).join(" | "));
    g.land(0);                          // flota wraca na księżyc
    advance(g, 10 * 60e3);
    await run(g, { cfg, loads: 8, ticksPerLoad: 2 });
    const st3 = JSON.parse(g.store.get("genesis.ogamex.net:ogx3_situation") || "{}");
    check("po powrocie floty wpis lotu ZDJĘTY (para znowu broniona)", (st3.flights || []).length === 0, JSON.stringify(st3.flights));
    check("bot nie wysłał floty drugi raz bez powodu", g.sent.length === 1, JSON.stringify(g.sent.map(x => x.to)));
  }

  console.log("\n── 10. ŚLEPY ALARM: pasek widzi obcych, których nie ma na liście ──");
  {
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1 };
    const g = new Game({ hangars: { "1:100:5|moon": { BATTLESHIP: 300 } } });
    g.ghosts = 3;                                   // 3 obce floty widoczne TYLKO na pasku
    await run(g, { cfg, loads: 6, ticksPerLoad: 2 });
    check("przez pierwszą minutę NIE ucieka (nadwyżka musi być trwała)", g.sent.length === 0, JSON.stringify(g.sent));
    advance(g, 3 * 60e3);                           // nadwyżka utrzymuje się 3 min
    const { logs } = await run(g, { cfg, loads: 12, ticksPerLoad: 3 });
    check("po progu trwałości bot RATUJE flotę w ciemno", g.sent.length === 1, JSON.stringify(g.sent));
    check("i mówi wprost, że to ślepy alarm", logs.some(m => /ŚLEPY ALARM/.test(m)), logs.slice(0, 6).join(" | "));
    check("ratunek wyszedł z ciała z największą flotą", !!g.sent[0] && g.sent[0].from === "1:100:5" && g.sent[0].fromBody === "moon", JSON.stringify(g.sent[0]));
  }

  console.log("\n── 11. UTRATA SESJI: gra oddaje stronę logowania ──");
  {
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1 };
    const g = new Game();                                  // spokój: bot poznaje układ i hangar
    await run(g, { cfg, loads: 6, ticksPerLoad: 2 });
    const sentBefore = g.sent.length;
    g.loggedOut = true;                                    // sesja pada, a chwilę potem leci atak
    g.threats = [{ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 600 }];
    const { logs } = await run(g, { cfg, loads: 6, ticksPerLoad: 2 });
    check("bot WYKRYWA wylogowanie i krzyczy", logs.some(m => /SESJA/.test(m)), logs.slice(0, 8).join(" | "));
    check("nie udaje, że wysłał flotę ze strony logowania", g.sent.length === sentBefore, JSON.stringify(g.sent));
    g.loggedOut = false;                                  // operator się zalogował
    advance(g, 5 * 60e3);
    await run(g, { cfg, loads: 14, ticksPerLoad: 3 });
    check("po powrocie sesji obrona znowu działa", g.sent.length > sentBefore, `wysłek: ${g.sent.length}`);
  }

  console.log("\n── 12. DWA ATAKI NARAZ: ucieczka nie może prowadzić na drugie atakowane ciało ──");
  {
    const g = new Game({
      pairs: [
        { key: "1:100:5", name: "Baza", moon: true },
        { key: "1:100:9", name: "Druga", moon: true },
        { key: "1:100:12", name: "Schron", moon: true },
      ],
      hangars: { "1:100:5|moon": { BATTLESHIP: 400 }, "1:100:9|moon": { CRUISER: 200 } },
      threats: [
        { src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 500, id: "t1" },
        { src: "9:9:8", dst: "1:100:9", dstBody: "moon", eta: 520, id: "t2" },
      ],
    });
    await run(g, { cfg: { autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1 }, loads: 40, ticksPerLoad: 3 });
    const a = g.sent.find(x => x.from === "1:100:5"), b = g.sent.find(x => x.from === "1:100:9");
    check("uratował flotę z pierwszej atakowanej pary", !!a, JSON.stringify(g.sent));
    check("uratował też z drugiej atakowanej pary", !!b, JSON.stringify(g.sent));
    check("żadna ucieczka NIE poleciała na atakowane ciało", g.sent.every(x => !(x.to === "1:100:5" && x.toBody === "moon") && !(x.to === "1:100:9" && x.toBody === "moon")), JSON.stringify(g.sent.map(x => x.to + "|" + x.toBody)));
    check("obie poleciały do nieatakowanego schronu", g.sent.length >= 2 && g.sent.every(x => x.to === "1:100:12"), JSON.stringify(g.sent.map(x => x.to)));
  }

  console.log("\n── 13. ATAK W TRAKCIE MISJI EKONOMICZNEJ: obrona przerywa ekonomię ──");
  {
    // Klucz: misja ekonomiczna trzyma `mission` w Store, a defenceTick kończył przebieg
    // przy KAŻDEJ trwającej misji. Wstrzykujemy taką misję wprost i sprawdzamy, czy atak
    // ją przerwie — bez zgadywania, czy test trafi w milisekundowe okno.
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1 };
    const g = new Game({ hangars: { "1:100:5|moon": { LIGHT_FIGHTER: 500, SMALL_CARGO: 50 } } });
    await run(g, { cfg, loads: 8, ticksPerLoad: 2 });                       // bot poznaje hangar
    check("(warunek wstępny) w spokoju nic nie wysyła", g.sent.length === 0, JSON.stringify(g.sent));
    g.store.set("genesis.ogamex.net:ogx3_mission", JSON.stringify({
      kind: "expedition", fromKey: "1:100:5", fromBody: "moon", toKey: "1:100:16", toBody: "planet",
      speed: 100, why: "ekspedycja", step: "switch", startedAt: Date.now(),
    }));
    g.threats = [{ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 300 }];
    const { logs } = await run(g, { cfg, loads: 25, ticksPerLoad: 3 });
    const rescue = g.sent.find(x => /Deploy/i.test(x.mission || ""));
    check("bot PRZERWAŁ misję ekonomiczną przy alarmie", logs.some(m => /obrona ma pierwszeństwo/i.test(m)), logs.slice(0, 8).join(" | "));
    check("i wykonał RATUNEK mimo trwającej ekonomii", !!rescue, JSON.stringify(g.sent.map(x => (x.mission || "?") + "→" + x.to)));
    check("ratunek nie poleciał na atakowane ciało", !rescue || !(rescue.to === "1:100:5" && rescue.toBody === "moon"), JSON.stringify(rescue));
  }

  console.log("\n── 14. NIEZNANY HANGAR: cisza jest zakazana ──");
  {
    const g = new Game({
      hangars: { "1:100:5|moon": { LIGHT_FIGHTER: 10 } },
      active: { key: "1:100:5", body: "moon" },
      threats: [{ src: "9:9:9", dst: "1:100:9", dstBody: "moon", eta: 600 }],
    });
    const { logs } = await run(g, { cfg: { autoRescue: true, expo: { enabled: false }, recon: false }, loads: 8, ticksPerLoad: 2 });
    check("bot NIE milczy — melduje, że nie wie, gdzie stoi flota", logs.some(m => /nie wiem, gdzie stoi flota|hangar nieznany|nieznan/i.test(m)), logs.slice(0, 8).join(" | "));
    check("i nie zmyśla wysyłki z pary, której nie zna", !g.sent.some(x => x.from === "1:100:9"), JSON.stringify(g.sent));
  }

  console.log("\n── 15. FS NOCNY: wyjście floty wieczorem i zawrót o świcie ──");
  {
    const H = new Date().getHours();
    const cfg = {
      autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1,
      fs: { enabled: true, startHour: H, endHour: (H + 1) % 24, speedPct: 10 },
      human: { breaks: false, economyAtNight: true },
    };
    const g = new Game({
      pairs: [
        { key: "1:100:5", name: "Baza", moon: true },
        { key: "1:100:9", name: "Bliska", moon: true },
        { key: "5:200:3", name: "Daleka", moon: true },
      ],
      hangars: { "1:100:5|moon": { BATTLESHIP: 700 } },
    });
    g.flightSec = 4 * 3600;                     // FS na 10% do innej galaktyki = godziny
    const { logs } = await run(g, { cfg, loads: 25, ticksPerLoad: 3 });
    const fs = g.sent[0];
    check("FS wyprowadził flotę na noc", g.sent.length === 1, JSON.stringify(g.sent));
    check("na NAJDALSZĄ kolonię (najdłuższy lot = najtrudniej trafić)", !!fs && fs.to === "5:200:3", JSON.stringify(fs));
    check("powoli (10%) — żeby zużyć minimum deuteru", g.formSpeed === 10, String(g.formSpeed));
    check("misja to stacjonowanie, nie atak", !!fs && /Deploy/i.test(fs.mission || ""), fs && fs.mission);
    const st = JSON.parse(g.store.get("genesis.ogamex.net:ogx3_situation") || "{}");
    const f = (st.flights || [])[0];
    check("z zaplanowanym zawrotem o świcie", !!f && f.recallAt > Date.now(), f && new Date(f.recallAt).toISOString());
    // Świt: termin zawrotu minął
    advance(g, 3 * 3600e3);
    const r2 = await run(g, { cfg, loads: 10, ticksPerLoad: 2 });
    check("o świcie bot ZAWRACA flotę sam", !!(g.sent[0] && g.sent[0].returning), JSON.stringify(g.sent[0]));
    check("i mówi o tym w dzienniku", r2.logs.some(m => /ZAWRÓT/.test(m)), r2.logs.slice(0, 5).join(" | "));
  }

  console.log("\n── 16. STRONA BŁĘDU GRY: bot wraca do gry zamiast zamierać ──");
  {
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: false };
    const g = new Game();
    g.errorPage = true; g.page = "Error"; g.query = "?aspxerrorpath=/home";
    const { logs } = await run(g, { cfg, loads: 4, ticksPerLoad: 2 });
    check("bot rozpoznał stronę błędu", logs.some(m => /BŁĄD STRONY/.test(m)), logs.slice(0, 5).join(" | "));
    check("i nie ruszył flotą na ślepo", g.sent.length === 0, JSON.stringify(g.sent));
    g.errorPage = false; g.page = "home"; g.query = "";     // gra wróciła do siebie
    g.threats = [{ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 400 }];
    advance(g, 5 * 60e3);
    await run(g, { cfg: { ...cfg, recon: true, reconMs: 1 }, loads: 20, ticksPerLoad: 3 });
    check("po powrocie gry obrona działa normalnie", g.sent.length === 1, JSON.stringify(g.sent));
  }

  console.log("\n── 17. OPERATOR PRZEŁĄCZA PLANETĘ W ŚRODKU FORMULARZA ──");
  {
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1 };
    const g = new Game({
      hangars: { "1:100:5|moon": { BATTLESHIP: 600 }, "1:100:9|moon": { SMALL_CARGO: 3 } },
      threats: [{ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 400 }],
    });
    g.hijackForm = true;                        // pierwszy klik „Next" = operator zmienia planetę
    const { logs } = await run(g, { cfg, loads: 30, ticksPerLoad: 3 });
    check("bot NIE wysłał floty z cudzej planety", g.sent.every(x => x.from === "1:100:5"), JSON.stringify(g.sent.map(x => x.from + "|" + x.fromBody)));
    check("mimo przerwania dowiózł ratunek do końca", g.sent.length === 1, JSON.stringify(g.sent));
    check("i wyszedł z atakowanego księżyca", !!g.sent[0] && g.sent[0].fromBody === "moon", JSON.stringify(g.sent[0]));
  }

  console.log("\n── 18. POTKNIĘCIE FORMULARZA: ratunek ponawiany po 45 s, nie po 3 min ──");
  {
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1 };
    const g = new Game({
      hangars: { "1:100:5|moon": { BATTLESHIP: 600 } },
      threats: [{ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 400 }],
    });
    g.deadNext = 1;                             // krok 2 bez przycisku „Next" = lot się wysypie
    const r1 = await run(g, { cfg, loads: 25, ticksPerLoad: 3 });
    check("(warunek wstępny) bot zaczął lot, ale formularz go zablokował", g.sent.length === 0 && r1.logs.some(m => /sąsiedni księżyc/.test(m)), r1.logs.slice(0, 6).join(" | "));
    g.deadNext = 0;                             // gra wróciła do siebie
    advance(g, 50e3);                           // minęło 50 s — przy karencji 3 min bot by stał
    await run(g, { cfg, loads: 20, ticksPerLoad: 3 });
    check("po 50 s bot POWTÓRZYŁ ratunek (karencja nie zjada dolotu)", g.sent.length === 1, JSON.stringify(g.sent));
  }

  console.log("\n── 19. NIEAKTUALNY HANGAR: flota nie stoi tam, gdzie bot myśli ──");
  {
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1 };
    const g = new Game({ hangars: { "1:100:5|moon": { BATTLESHIP: 600 } } });
    await run(g, { cfg, loads: 8, ticksPerLoad: 2 });          // bot zapamiętuje flotę na księżycu
    g.hangars["1:100:5|moon"] = {};                            // operator sam przeniósł flotę
    g.hangars["1:100:5|planet"] = { BATTLESHIP: 600 };
    g.threats = [{ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 400 }];
    const { logs } = await run(g, { cfg, loads: 25, ticksPerLoad: 3 });
    check("bot nie wysłał floty z PUSTEGO księżyca", !g.sent.some(x => x.fromBody === "moon"), JSON.stringify(g.sent));
    check("i nie zamilkł — albo melduje pusty hangar, albo bezpieczną stronę", logs.some(m => /pusty|bezpieczna strona|nie wiem, gdzie/i.test(m)), logs.slice(0, 8).join(" | "));
  }

  console.log("\n── 20. NIEŚWIEŻY PASEK nie może wywołać ślepego alarmu ──");
  {
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1 };
    const g = new Game({ hangars: { "1:100:5|moon": { BATTLESHIP: 300 } } });
    g.ghosts = 2;
    await run(g, { cfg, loads: 4, ticksPerLoad: 2 });     // bot widzi nadwyżkę, ale próg jeszcze nie minął
    g.ghosts = 0;
    g.hideBar = true;                                     // strona bez paska: stary odczyt zostaje w stanie
    advance(g, 10 * 60e3);
    const { logs } = await run(g, { cfg, loads: 10, ticksPerLoad: 3 });
    check("bot NIE ewakuuje floty na podstawie starego paska", g.sent.length === 0, JSON.stringify(g.sent));
    check("i nie ogłasza ślepego alarmu z niczego", !logs.some(m => /ŚLEPY ALARM: pasek widzi/.test(m)), logs.slice(0, 6).join(" | "));
  }

  console.log("\n── 21. FORMULARZ BEZ SUWAKA PRĘDKOŚCI ──");
  {
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1 };
    const g = new Game({
      hangars: { "1:100:5|moon": { BATTLESHIP: 600 } },
      threats: [{ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 400 }],
    });
    g.noSpeeds = true;
    const { logs } = await run(g, { cfg, loads: 25, ticksPerLoad: 3 });
    check("ratunek i tak wychodzi (lepiej szybko niż wcale)", g.sent.length === 1, JSON.stringify(g.sent));
    check("bot głośno melduje brak prędkości", logs.some(m => /prędkość.*(NIE USTAWIONA|nie ustawiona)/i.test(m)), logs.slice(0, 8).join(" | "));
    const st = JSON.parse(g.store.get("genesis.ogamex.net:ogx3_situation") || "{}");
    const f = (st.flights || [])[0];
    check("bot nie udaje, że flota wisi w powietrzu — wpis domknie hangar CELU", !!f && f.recallAt === 0, JSON.stringify(f));
    check("i mówi wprost, że flota wyląduje", logs.some(m => /WYLĄDUJE/.test(m)), logs.slice(0, 8).join(" | "));
  }

  console.log("\n── 22. MINING: skan układów → minery na asteroidę (wiersz 17) ──");
  {
    const cfg = {
      autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1,
      aster: { enabled: true, minTtlSec: 300, scanGapSec: 0 },
      human: { breaks: false, economyAtNight: true },
    };
    const g = new Game({ hangars: { "1:100:5|moon": { ASTEROID_MINER: 20, BATTLESHIP: 100 } } });
    g.asteroid = true;
    let logs = (await run(g, { cfg, loads: 15, ticksPerLoad: 2 })).logs;
    for (let i = 0; i < 4 && !g.sent.length; i++) {         // dlawik skanu: 6 s miedzy ukladami
      advance(g, 60e3);
      logs = logs.concat((await run(g, { cfg, loads: 15, ticksPerLoad: 2 })).logs);
    }
    const mine = g.sent.find(x => /Asteroid/i.test(x.mission || ""));
    check("minery poleciały na asteroidę", !!mine, logs.filter(m => /ASTER|LOT/i.test(m)).slice(0, 8).join(" | ") + " || nawig: " + g.navigations.slice(0, 5).join(","));
    check("celem jest pozycja 17", !!mine && /:17$/.test(mine.to || ""), JSON.stringify(mine));
    check("poleciały TYLKO minery (flota bojowa została w domu)", !mine || !mine.ships.BATTLESHIP, JSON.stringify(mine && mine.ships));
    const st = JSON.parse(g.store.get("genesis.ogamex.net:ogx3_situation") || "{}");
    check("lot ekonomiczny NIE trafia do stanu obrony", (st.flights || []).length === 0, JSON.stringify(st.flights));
  }

  console.log("\n── 23. ZŁOM: recyklery na własne pole szczątków ──");
  {
    const cfg = {
      autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1,
      debris: { enabled: true, everyMin: 0 },
      human: { breaks: false, economyAtNight: true },
    };
    const g = new Game({ hangars: { "1:100:5|moon": { RECYCLER: 30, BATTLESHIP: 100 } } });
    g.debris = true;
    let logs = (await run(g, { cfg, loads: 15, ticksPerLoad: 2 })).logs;
    for (let i = 0; i < 4 && !g.sent.length; i++) {
      advance(g, 60e3);
      logs = logs.concat((await run(g, { cfg, loads: 15, ticksPerLoad: 2 })).logs);
    }
    const col = g.sent.find(x => /Collect|Harvest|Recycl/i.test(x.mission || ""));
    check("recyklery poleciały po złom", !!col, logs.filter(m => /ZŁOM|LOT/i.test(m)).slice(0, 8).join(" | ") + " || nawig: " + g.navigations.slice(0, 5).join(","));
    check("celem jest POLE SZCZĄTKÓW, nie planeta", !col || col.toBody === "debris", JSON.stringify(col));
    check("bez floty bojowej", !col || !col.ships.BATTLESHIP, JSON.stringify(col && col.ships));
  }

  console.log("\n── 24. ATAK PRZERYWA MINING (ekonomia nigdy nie wygrywa) ──");
  {
    const cfg = {
      autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1,
      aster: { enabled: true, minTtlSec: 300, scanGapSec: 0 },
      human: { breaks: false, economyAtNight: true },
    };
    const g = new Game({ hangars: { "1:100:5|moon": { ASTEROID_MINER: 20, BATTLESHIP: 400 } } });
    g.asteroid = true;
    await run(g, { cfg, loads: 12, ticksPerLoad: 2 });
    g.threats = [{ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 400 }];
    advance(g, 60e3);
    await run(g, { cfg, loads: 25, ticksPerLoad: 3 });
    const rescue = g.sent.find(x => /Deploy/i.test(x.mission || ""));
    check("ratunek wyszedł mimo włączonego miningu", !!rescue, JSON.stringify(g.sent.map(x => (x.mission || "?") + "→" + x.to)));
    check("i zabrał flotę bojową", !!rescue && rescue.ships.BATTLESHIP === 400, JSON.stringify(rescue && rescue.ships));
  }

  console.log("");
  console.log("── 25. ASTEROIDA ZNIKA PRZED DOLOTEM (Genesis x3 = loty dluzsze niz na Athenie x4) ──");
  {
    const cfg = {
      autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1,
      aster: { enabled: true, minTtlSec: 300, scanGapSec: 6 },
      human: { breaks: false, economyAtNight: true },
    };
    const g = new Game({ hangars: { "1:100:5|moon": { ASTEROID_MINER: 20 } } });
    g.asteroid = true;
    g.asteroidTtl = 420;        // przechodzi filtr wstepny (>5 min)...
    g.flightSec = 900;          // ...ale lot trwa 15 min: minery nie zdaza
    let logs = (await run(g, { cfg, loads: 15, ticksPerLoad: 2 })).logs;
    for (let i = 0; i < 4 && !g.sent.length; i++) {
      advance(g, 60e3);
      logs = logs.concat((await run(g, { cfg, loads: 15, ticksPerLoad: 2 })).logs);
    }
    check("bot NIE wyslal minerow na znikajaca asteroide", g.sent.length === 0, JSON.stringify(g.sent.map(x => (x.mission || "?") + " -> " + x.to)));
    check("i powiedzial dlaczego (czas lotu kontra TTL)", logs.some(m => /znika za .*a lot trwa/.test(m)), logs.filter(m => /ASTER/.test(m)).slice(0, 6).join(" | "));
  }

  console.log(`\n${fails ? fails + " FAIL — NIE WYPYCHAJ" : "E2E: wszystko OK"}  (${checks} sprawdzeń)`);
  process.exit(fails ? 1 : 0);
})();
