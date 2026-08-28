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
  }
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
    const hostile = this.threats.length;
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
      <div class="speeds"><a>10</a><a>50</a><a>100</a></div>
      <div>Duration of flight (one way): 01:21</div>
      <a class="btn-continue" id="btn-next-fleet3">Next</a>
    </div>`;
  }
  step3Html() {
    return `<div id="content">
      <a class="mission-item DEPLOY">Deploy</a><a class="mission-item EXPEDITION">Expedition</a><a class="mission-item ATTACK">Attack</a>
      <a class="btn-all-res">Wszystkie surowce</a>
      <a class="btn-res-full">max</a><a class="btn-res-full">max</a><div><a class="btn-res-full">max deuter</a><input name="deuterium" value="500000"></div>
      <a class="btn-continue" id="btn-submit-fleet">Send fleet</a>
    </div>`;
  }
  bodyHtml() {
    const events = `<table id="fleet-movement-content"><tbody>${this.rowsHtml(false)}</tbody></table>`;
    let main = "";
    if (this.page === "fleet") main = this.formStep === 0 ? this.fleetPageHtml() : this.formStep === 1 ? this.step2Html() : this.step3Html();
    else if (this.page === "galaxy") main = `<div class="galaxy-item"><span class="planet-index">16</span><a href="/fleet?x=1&y=100&z=16&mission=15">Expedition</a></div>`;
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
  w.fetch = async (u) => ({ ok: true, redirected: false, url: u, status: 200,
    text: async () => u.includes("fleetmovementlist") ? `<table><tbody>${game.rowsHtml(true)}</tbody></table>` : "<div class='galaxy-asteroid-modal'>[1:31:1] [1:51:9]</div>" });
  // nawigacja
  const nav = (to) => { game.navigations.push(to); const [pth, q] = String(to).split("?"); game.page = pth.replace(/^\//, "") || "home"; game.query = q ? "?" + q : ""; if (game.page === "fleet") game.formStep = 0; };
  // jsdom nie pozwala podmienić window.location — podstawiamy ją przez parametr
  // funkcji opakowującej (shadowing), więc kod bota widzi naszą atrapę nawigacji.
  w.__fakeLoc = { href: url, host: "genesis.ogamex.net", hostname: "genesis.ogamex.net", origin: "https://genesis.ogamex.net", protocol: "https:", pathname: "/" + game.page, search: game.query, replace: nav, assign: nav, reload: () => nav("/" + game.page) };
  // Bot celowo robi ludzkie przerwy (1-2 s na krok formularza). W teście skracamy
  // JE SAME, nie logikę: zegar symulatora biegnie 40× szybciej.
  const realST = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms, ...a) => realST(fn, Math.min(Math.max(0, (ms || 0) / 40), 30), ...a);
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
    if (id === "btn-next-fleet2") {
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
    if (id === "btn-submit-fleet") {
      // wysyłka: hangar źródła pustoszeje, gra przekierowuje (jak fork)
      const src = `${game.active.key}|${game.active.body}`;
      const h = game.hangars[src] || {};
      for (const [t, q] of Object.entries(game.formShips)) { h[t] = Math.max(0, (h[t] || 0) - q); if (!h[t]) delete h[t]; }
      game.hangars[src] = h;
      game.sent.push({ from: game.active.key, fromBody: game.active.body, to: game.formTarget, toBody: game.formBody, mission: game.formMission, ships: { ...game.formShips }, inFlight: true });
      game.slots.fleet.used++;
      nav("/home?fleetSendSuccessfully=1");
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
    await new Promise(r => setTimeout(r, 250));
    try { inst.w.eval("if (typeof logEntries !== 'undefined') {}"); } catch {}
    if (process.env.DIAG2) {
      try { const st2 = inst.api.Situation.load(); console.log("      decyzja:", JSON.stringify(inst.api.decide(st2, inst.api.CFG, Date.now())).slice(0, 300), "| CFG.autoRescue:", inst.api.CFG.autoRescue, "| misja:", JSON.stringify(inst.api.Fly.mission())); } catch (e) { console.log("      decyzja rzuciła:", e.message); }
      const st = JSON.parse(game.store.get("genesis.ogamex.net:ogx3_situation") || "null");
      const lg = JSON.parse(game.store.get("genesis.ogamex.net:ogx3_log") || "[]");
      console.log(`   [load ${i}] strona=${game.page} pary=${st ? Object.keys(st.pairs || {}).length : "?"} zagr=${st ? (st.threats || []).length : "?"} hangary=${st ? Object.keys(st.hangars || {}).length : "?"} log=${lg.length} nawig=${game.navigations.length}`);
      lg.slice(0, 3).forEach(e => console.log("      ", e.msg.slice(0, 120)));
    }
    try { for (const e of JSON.parse(game.store.get("genesis.ogamex.net:ogx3_log") || "[]")) logs.push(e.msg); } catch {}
    // koniec dopiero, gdy bot nie nawigował ANI nie ma rozpoczętej misji lotu
    const busy = (game.store.get("genesis.ogamex.net:ogx3_mission") || "null") !== "null";
    if (game.navigations.length === before && !busy) break;
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

  console.log(`\n${fails ? fails + " FAIL — NIE WYPYCHAJ" : "E2E: wszystko OK"}  (${checks} sprawdzeń)`);
  process.exit(fails ? 1 : 0);
})();
