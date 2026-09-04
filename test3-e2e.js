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
    this.debris16 = false;    // czy na poz. 16 (ekspedycje) lezy PZ po piratach
    this.fleetIcon16 = false; // ikona WLASNEJ floty w kolumnie DF poz. 16 (to nie zlom!)
    this.loggedOut = false;   // gra oddaje strone logowania
    this.cargoPerMiner = 25_000;     // ile uniesie JEDEN miner (bot ma się tego nauczyć)
    this.asteroidYield = 500_000;    // typowy urobek asteroidy w dzienniku
    this.metal = 3_800_000_000;      // pasek surowców (moduł księżyców liczy z niego budżet)
    this.moonKmCost = 300_000;       // koszt metalu za 1 km średnicy (atrapa cennika forka)
    this.nextOutsideContent = false;   // „Next" w stopce, POZA #content (jak na Genesis)
    this.bonus = false;       // zielony „Online bonus" w menu (antymateria + punkty Akademii)
    this.bonusClaims = 0;
    this.fleetUrlHijack = false;  // /fleet?x=..&y=..&z=.. przestawia AKTYWNA planete (realne zachowanie forka)
    this.errorPage = false;   // gra oddaje strone bledu
    this.moonLinks = false;   // v3.65.0: pasek daje księżycowi własny ?planet=UUID-moon (jak fork) — cichy odczyt hangaru księżyca
  }
  // wlasne loty w liscie ruchow — z przyciskiem zawracania (fork: a.x_btn_fleet_return)
  ownRowsHtml(onlyActive) {
    return this.sent.map((s, i) => ({ s, i }))
      .filter(({ s }) => s.inFlight && (!onlyActive || s.from === this.active.key || s.to === this.active.key))
      .map(({ s, i }) => `<tr class="row-mission-type-${s.type || "DEPLOY"}${s.returning ? " row-fleet-return" : ""}" data-fleet-id="own${i}">
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
  uuidOf(p) { return p.uuid || ("uuid-" + p.key); }
  planetBarHtml() {
    return `<ul id="planetList">` + this.pairs.map(p => {
      const sel = p.key === this.active.key;
      const pSel = sel && this.active.body === "planet" ? " selected" : "";
      const mSel = sel && this.active.body === "moon" ? " selected" : "";
      return `<li><a href="/fleet?planet=${this.uuidOf(p)}" class="planet-select${pSel}" data-key="${p.key}">${p.name} [${p.key}]</a>` +
             (p.moon ? `<a href="${this.moonLinks ? "/fleet?planet=" + this.uuidOf(p) + "-moon" : "#"}" class="moon-select${mSel}" data-key="${p.key}">Moon</a>` : "") + `</li>`;
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
      ${this.nextOutsideContent ? "" : '<a class="btn-continue" id="btn-next-fleet2">Next</a>'}
    </div>${this.nextOutsideContent ? '<div class="form-footer"><span>Selected fleet points: 31.272</span><button id="btn-next-fleet2" class="btn btn-success">Next</button></div>' : ""}`;
  }
  step2Html() {
    return `<div id="content">
      <div id="target_planet_type_container">
        <input id="fleet2_target_x" value=""><input id="fleet2_target_y" value=""><input id="fleet2_target_z" value="">
        <a data-planet-type="1" class="planet-icon">Planet</a><a data-planet-type="2" class="moon-icon">Moon</a><a data-planet-type="3">Debris</a>
      </div>
      ${this.noSpeeds ? "" : '<div class="speeds"><a>10</a><a>50</a><a>100</a></div>'}
      <div>Cargo space: 0 / ${(Object.entries(this.formShips).reduce((a, [ty, q]) => a + (ty === "ASTEROID_MINER" ? q * this.cargoPerMiner : q * 5000), 0)).toLocaleString("de-DE")}</div>
      <div>Duration of flight (one way): ${((sec) => sec >= 3600
        ? `${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor(sec % 3600 / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`
        : `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`)(Math.round(this.flightSec * 100 / (this.formSpeed || 100)))}</div>
      ${this.deadNext > 0 ? "" : '<a class="btn-continue" id="btn-next-fleet3">Next</a>'}
    </div>`;
  }
  step3Html() {
    return `<div id="content">
      <a class="mission-item DEPLOY">Deploy</a><a class="mission-item EXPEDITION">Expedition</a><a class="mission-item ATTACK">Attack</a>
      <a class="mission-item ASTEROID_MINING">Asteroid mining</a><a class="mission-item COLLECT" data-mission-type="13">Collect</a><a class="mission-item RECYCLE" data-mission-type="8">Recycle</a>
      <a class="btn-all-res">Wszystkie surowce</a>
      <a class="btn-res-full">max</a><a class="btn-res-full">max</a><div><a class="btn-res-full">max deuter</a><input name="deuterium" value="500000"></div>
      <a class="btn-continue" id="btn-submit-fleet">Send fleet</a>
    </div>`;
  }
  metalHtml() { return `<div class="resource-item-metal">${this.metal.toLocaleString("de-DE")}</div>`; }
  moonFormHtml() {
    const km = this.formKm || 8944;
    return `<div id="content"><input id="diameter" type="text" value="${km}" />
      <div>Requirements: ${(km * this.moonKmCost).toLocaleString("de-DE")} Metal</div>
      <a id="btn-form-moon" href="#">Form a moon</a></div>`;
  }
  bonusMenu() { return `<nav id="menu"><a href="/home/onlinebonus" id="btn-online-bonus">Online bonus</a></nav>`; }
  // `menuOnlyOnHome` odwzorowuje fork: strona "/" (tam parkuje keepalive) i kroki
  // formularza floty nie mają menu gry, więc przycisku bonusu na nich NIE MA.
  bonusHtml() { return this.bonus && !(this.menuOnlyOnHome && this.page !== "home") ? this.bonusMenu() : ""; }
  bodyHtml() {
    if (this.loggedOut) return this.loginHtml();
    if (this.errorPage) return `<div class="error-page"><h1>Error occurred</h1><p>Runtime Error — Internal Server Error</p><a href="/">Back to game</a></div>`;
    // v3.36.0: fork pokazuje wiersze lotów DOPIERO po rozwinięciu paska misji —
    // zwinięty daje samą liczbę („13 Missions: 13 Own"), bez współrzędnych i czasów.
    const misje = this.threats.length + (this.ownFlights || []).length;
    const barTxt = `<div id="mission-bar">${misje} Missions: ${(this.ownFlights || []).length} Own${this.threats.length ? ` ${this.threats.length} Hostile` : ""}</div>`;
    const events = this.eventsCollapsed
      ? `${this.bonusHtml()}${barTxt}`
      : `${this.bonusHtml()}<table id="fleet-movement-content"><tbody>${this.rowsHtml(false)}${this.ownRowsHtml(false)}</tbody></table>`;
    let main = "";
    if (this.page === "fleet") main = this.formStep === 0 ? this.fleetPageHtml() : this.formStep === 1 ? this.step2Html() : this.step3Html();
    else if (this.page === "galaxy") {
      const q = new URLSearchParams((this.query || "").replace(/^\?/, ""));
      const gx = q.get("x") || "1", sy = q.get("y") || "100";
      main = `
        <div class="galaxy-item"><span class="planet-index">5</span>
          <div class="galaxy-col col-debris">${this.debris ? `<a href="/fleet?x=${gx}&y=${sy}&z=5&mission=8">Debris 120.000</a>` : ""}</div>
        </div>
        <div class="galaxy-item"><span class="planet-index">16</span><a href="/fleet?x=${gx}&y=${sy}&z=16&mission=15">Expedition</a>
          <div class="galaxy-col col-debris">${this.fleetIcon16 ? `<div class="fleetActionIcon fleetActionFriendly"></div>` : ""}${this.debris16 ? `<div class="tooltip_sticky" data-tooltip-content="&lt;div&gt;Debris field&lt;/div&gt;&lt;span&gt;1.200.000.000&lt;/span&gt;&lt;span&gt;800.000.000&lt;/span&gt;"></div>` : ""}</div>
        </div>
        <div class="galaxy-item"><span class="planet-index">17</span>
          ${this.asteroid ? `<span data-asteroid-disappear="${this.asteroidTtl}"></span><a class="btn-asteroid" href="/fleet?x=${gx}&y=${sy}&z=17&mission=12">Asteroid</a>` : "<span>Find asteroids</span>"}
        </div>`;
    }
    else if (/moonformation/.test(this.page)) main = this.moonFormHtml();
    else main = `<div id="overview">Overview</div>`;
    return `${this.metalHtml()}${this.planetBarHtml()}${this.missionBarHtml()}${events}${main}`;
  }
}

// ─── URUCHOMIENIE BOTA NA ATRAPIE (jedno "załadowanie strony") ───────────
// v3.66.0: KAŻDE `load()` to nowe okno jsdom, a stare nigdy nie było zamykane —
// jego `setInterval`y żyły do końca procesu. Przy zegarach 20-sekundowych nikt
// tego nie zauważył; zegar dolotu chodzi 4× na sekundę i przy kilkudziesięciu
// martwych oknach zestaw zwalniał tak, że przestawał się kończyć (a martwe okna
// pisały do tego samego magazynu, co żywy scenariusz). W przeglądarce robi to
// sama gra — przeładowanie strony zabija timery. Tutaj musimy to zrobić ręcznie.
let poprzednieOkno = null;
function load(game, { cfg = {}, ticks = 1 } = {}) {
  if (poprzednieOkno) { try { poprzednieOkno.close(); } catch {} poprzednieOkno = null; }
  const url = `https://genesis.ogamex.net/${game.page}${game.query}`;
  const dom = new JSDOM(`<!doctype html><html><body>${game.bodyHtml()}</body></html>`, { url, pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window;
  // GM storage + magazyny przeglądarki (trwałe między załadowaniami)
  w.GM_getValue = (k, d) => (game.store.has(k) ? game.store.get(k) : d);
  w.GM_setValue = (k, v) => game.store.set(k, v);
  // v3.33.0: push na telefon był dotąd zaślepiony na głucho — audyt (T2) wytknął,
  // że NIC go nie sprawdza. Teraz atrapa zapisuje każdy wysłany push.
  game.pushes = game.pushes || [];
  w.GM_xmlhttpRequest = (o) => { game.pushes.push({ url: o && o.url, title: o && o.headers && o.headers.Title, priority: o && o.headers && o.headers.Priority, body: o && o.data }); if (o && o.onload) o.onload({ status: 200 }); };
  const mkStorage = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
  Object.defineProperty(w, "sessionStorage", { value: mkStorage(game.session), configurable: true });
  Object.defineProperty(w, "localStorage", { value: mkStorage(game.local), configurable: true });
  // fetch: lista ruchów widzi TYLKO aktywną parę (tak jak fork)
  w.fetch = async (u) => ((game.fetches = game.fetches || []).push(String(u)), { ok: true, redirected: !!game.loggedOut, url: game.loggedOut ? "/auth/login" : u, status: 200,
    text: async () => game.loggedOut ? game.loginHtml()
      : u.includes("fleetmovementlist") ? `<table><tbody>${game.rowsHtml(true)}${game.ownRowsHtml(true)}</tbody></table>`
      : /^\/fleet\?planet=/.test(String(u)) ? (() => {
          const id0 = String(u).split("planet=")[1], isMoon = /-moon$/.test(id0), id = id0.replace(/-moon$/, "");
          const p = game.pairs.find(x => (x.uuid || ("uuid-" + x.key)) === id) || game.pairs[0];
          const prev = game.active; game.active = { key: p.key, body: isMoon ? "moon" : "planet" };
          const html = game.fleetPageHtml(); game.active = prev; return html;
        })()
      : /^\/home(\?|$)/.test(String(u)) ? (game.bonus ? game.bonusMenu() : "<div id='overview'>Overview</div>")
      : /AsteroidJournal/i.test(u) ? `<table><tbody>${Array.from({ length: 6 }, () => `<tr><td>Asteroid</td><td>${game.asteroidYield.toLocaleString("de-DE")}</td></tr>`).join("")}</tbody></table>`
      : "<div class='galaxy-asteroid-modal'>[1:31:1] [1:51:9]</div>" });
  // nawigacja
  const nav = (to) => {
    game.navigations.push(to);
    // odbiór bonusu online = zwykła nawigacja pod /home/onlinebonus; gra zabiera
    // wtedy przycisk z menu (tak działa fork: bonus znika do następnego cyklu)
    if (/\/home\/onlinebonus/.test(String(to))) { game.bonusClaims++; game.bonus = false; game.page = "home"; game.query = ""; if (w.__fakeLoc) { w.__fakeLoc.href = "https://genesis.ogamex.net/home"; w.__fakeLoc.pathname = "/home"; w.__fakeLoc.search = ""; } return; }
    const [pth, q] = String(to).split("?");
    game.page = pth.replace(/^\//, "") || "home";
    game.query = q ? "?" + q : "";
    if (game.page === "fleet") game.formStep = 0;
    // Incydent 28.08 22:17: adres formularza niesie koordy CELU, a fork ustawia po
    // nich aktywna planete. Bot widzial wtedy „to nie moja planeta", wracal do kroku
    // „switch" i kręcił stroną w kółko az do limitu 5 minut (~30 przeladowan).
    if (game.fleetUrlHijack && game.page === "fleet") {
      const q2 = new URLSearchParams((game.query || "").replace(/^\?/, ""));
      const x = q2.get("x"), y = q2.get("y"), z = q2.get("z");
      if (x && y && z) {
        const k = `${x}:${y}:${z}`;
        const mine = game.pairs.find(p => p.key === k);
        // koordy własnej planety = zwykłe przełączenie; obca pozycja (16 = ekspedycja,
        // 17 = asteroida) = fork siada na planecie głównej, NIE na planecie startu
        game.active = mine ? { key: k, body: "planet" } : { key: game.pairs[0].key, body: "planet" };
      }
    }
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
  w.document.addEventListener("input", (ev) => {
    if (ev.target && ev.target.id === "diameter") {
      game.formKm = parseInt(String(ev.target.value || "").replace(/[^\d]/g, ""), 10) || 0;
      const box = w.document.querySelector("#content div");
      if (box) box.textContent = `Requirements: ${(game.formKm * game.moonKmCost).toLocaleString("de-DE")} Metal`;
    }
  }, true);
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
    if (id === "mission-bar" || id === "bar") {  // klik w pasek misji rozwija listę lotów (gra ma jeden pasek)
      game.eventsCollapsed = false;
      w.document.body.innerHTML = game.bodyHtml();
      return;
    }
    if (id === "diameter" || (el.id === "diameter")) { return; }
    if (id === "btn-form-moon") {
      const inp = w.document.getElementById("diameter");
      const km = parseInt((inp && inp.value || "0").replace(/[^\d]/g, ""), 10) || 0;
      const cost = km * game.moonKmCost;
      if (cost > game.metal) { game.moonRefused = (game.moonRefused || 0) + 1; return; }   // gra odmawia: za mało metalu
      game.metal -= cost;
      const p = game.pairs.find(x => x.key === game.active.key);
      if (p) p.moon = true;
      game.moonBuilt = { key: game.active.key, km, cost };
      nav("/home");
      w.document.body.innerHTML = game.bodyHtml();
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
  poprzednieOkno = w;
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
      if (st.hostileClear && st.hostileClear.since) st.hostileClear.since -= ms;
      for (const e of st.expected || []) { if (e.sentAt) e.sentAt -= ms; if (e.returnAt) e.returnAt -= ms; }
      for (const lk of Object.keys(st.expoLandings || {})) st.expoLandings[lk] = st.expoLandings[lk].map(t => t - ms);
      if (st.expoHome && st.expoHome.at) st.expoHome.at -= ms;
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
    // Czas na dokonczenie krokow bota (jego wlasne pauzy sa 150x krotsze).
    // UWAGA (31.08): probowalismy tu czekac na `busy()` bota (startowy defenceTick
    // odpala sie bez await i staly sleep bywa za krotki) — ale kazdy wariant zmienial
    // FAZE calego pakietu i deterministycznie psul inne scenariusze (17/18/21: misje-
    // zombie z martwych okien odswiezaly karencje tras w WSPOLNYM stanie). Wracamy do
    // historycznych 140 ms; mruganie sc. 28 pod obciazeniem to znany koszt.
    await new Promise(r => setTimeout(r, 140));
    try { inst.w.eval("if (typeof logEntries !== 'undefined') {}"); } catch {}
    if (process.env.DIAG2) {
      try { const st2 = inst.api.Situation.load(); console.log("      decyzja:", JSON.stringify(inst.api.decide(st2, inst.api.CFG, Date.now())).slice(0, 300), "| CFG.autoRescue:", inst.api.CFG.autoRescue, "| misja:", JSON.stringify(inst.api.Fly.mission()), "| eco:", JSON.stringify(inst.api.Human && inst.api.Human.economyAllowed(st2)), "| moonSt:", JSON.stringify(inst.api.Store.get("moon", null))); } catch (e) { console.log("      decyzja rzuciła:", e.message); }
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

function game_store_dump(g) { const o = {}; for (const [k, v] of g.store) if (/aster|situation|mission/.test(k)) o[k.split("ogx3_")[1]] = String(v).slice(0, 300); return JSON.stringify(o, null, 1); }
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
    // v3.33.0 (obawa właściciela 29.08: „czy alarm o ataku w ogóle dojdzie?"):
    // dotąd NIC nie sprawdzało pusha — GM_xmlhttpRequest był zaślepiony na głucho.
    const atak = (g.pushes || []).filter(p => /ATAK/.test(p.title || ""));
    check("atak wysyła push na telefon", atak.length >= 1, JSON.stringify((g.pushes || []).map(p => p.title)));
    check("push o ataku ma priorytet urgent (przebija tryb cichy)", atak[0] && atak[0].priority === "urgent", atak[0] && atak[0].priority);
    check("push idzie na ntfy.sh, na temat konta", atak[0] && /^https:\/\/ntfy\.sh\/ogamex3-/.test(atak[0].url || ""), atak[0] && atak[0].url);
  }

  console.log("\n── 2b. DWA ATAKI NA RÓŻNE KOLONIE: drugi push NIE jest dławiony ──");
  {
    // Klucz: drugi atak przychodzi PÓŹNIEJ, w oknie 5 min od pierwszego. Dławik
    // liczony po samym rodzaju („ATAK") uciszał go w całości — telefon milczał
    // dokładnie wtedy, gdy sytuacja się pogarszała.
    const g = new Game({ threats: [{ id: "a1", src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 300 }] });
    await run(g, { cfg: { autoRescue: false, expo: { enabled: false } }, loads: 8, ticksPerLoad: 3 });
    g.threats.push({ id: "a2", src: "9:9:8", dst: "1:100:9", dstBody: "moon", eta: 280 });
    await run(g, { cfg: { autoRescue: false, expo: { enabled: false } }, loads: 8, ticksPerLoad: 3 });
    const tresci = (g.pushes || []).filter(p => /ATAK/.test(p.title || "")).map(p => p.body || "").join(" || ");
    check("drugi atak (inna kolonia, minutę później) TEŻ idzie na telefon", /1:100:5/.test(tresci) && /1:100:9/.test(tresci), tresci.slice(0, 300) || "brak pushy");
  }


  console.log("\n── 2c. ZWINIĘTY PASEK MISJI: bot sam rozwija listę lotów ──");
  {
    // Zgłoszenie właściciela 29.08 20:56 (i lekcja Atheny v2.74.0): zwinięty pasek
    // pokazuje samą liczbę lotów — „13 Missions: 13 Own" — bez współrzędnych i czasów.
    // Bez rozwinięcia atak na inną kolonię schodzi do ślepego alarmu (60 s zwłoki).
    const g = new Game({ threats: [{ id: "z1", src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 300 }] });
    g.eventsCollapsed = true;
    const { logs } = await run(g, { cfg: { autoRescue: true, expo: { enabled: false } }, loads: 10, ticksPerLoad: 3 });
    check("bot zauważył zwiniętą listę i kliknął w kandydata", logs.some(m => /lista lotów zwinięta — klikam w/.test(m)), logs.slice(0, 6).join(" | "));
    check("po rozwinięciu widzi wiersze ze współrzędnymi", logs.some(m => /lista rozwinięta/.test(m)), logs.filter(m => /LOTY/.test(m)).slice(0, 4).join(" | "));
    check("i ratuje flotę tak samo jak przy rozwiniętej liście", g.sent.length === 1 && g.sent[0].from === "1:100:5", JSON.stringify(g.sent));
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

  console.log("\n── 9b. POWRÓT WŁASNEGO LOTU: lądowanie zapisane na ŹRÓDLE, nie na pierwotnym celu ──");
  {
    // Test na żywo 31.08 09:06: bot ogłosił „wróciła własna flota na księżyc [1:217:8]"
    // (pierwotny CEL zawróconego ratunku) i poszedł sprawdzać hangar nie tego ciała,
    // na którym flota faktycznie wylądowała ([1:217:6] moon — punkt startu). Wiersz
    // powrotny trzyma w celu PIERWOTNY cel lotu, a flota wraca do punktu startu.
    const g = new Game();
    g.sent.push({ from: "1:100:5", fromBody: "moon", to: "1:100:9", toBody: "moon", mission: "Deploy", ships: { LIGHT_FIGHTER: 10 }, inFlight: true, returning: true, eta: 120 });
    await run(g, { cfg: { autoRescue: true, expo: { enabled: false }, recon: false }, loads: 2, ticksPerLoad: 2 });
    const st = JSON.parse(g.store.get("genesis.ogamex.net:ogx3_situation") || "{}");
    const keys = Object.keys(st.landings || {});
    check("lądowanie powrotu zapisane pod ŹRÓDŁEM lotu", keys.some(k => k.startsWith("1:100:5|")), JSON.stringify(st.landings));
    check("a nie pod pierwotnym celem", !keys.some(k => k.startsWith("1:100:9|")), JSON.stringify(st.landings));
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

  console.log("\n── 15. FLEET SAVE (v3.68.0, port z Atheny): wyjście OD RAZU, zawrót na skonfigurowaną godzinę ──");
  {
    // v3.68.0: FS nie ma już okna — leci natychmiast, o DOWOLNEJ porze. returnHour parę
    // godzin w przyszłości wystarcza za dowód, że to NIE jest okno startowe.
    // v3.68.1 (audyt): `(H + 2) % 24` zawijało się między 22:00 a 23:59 na 0/1 — czyli
    // na godzinę JUŻ MINIONĄ dziś, więc `fsReturnAt` przeskakiwał na jutro (~25 h) i oba
    // scenariusze FS padały deterministycznie w tym oknie doby. Liczymy godzinę z zegara
    // przesuniętego o 2 h, zamiast liczyć modulo na samej liczbie.
    const H = new Date(Date.now() + 2 * 3600e3).getHours();
    const cfg = {
      autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1,
      fs: { enabled: true, returnHour: H, returnMinute: 0, speedPct: 10 },
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
    check("FS wyprowadził flotę OD RAZU, bez czekania na okno", g.sent.length === 1, JSON.stringify(g.sent));
    check("na NAJDALSZĄ kolonię (najdłuższy lot = najtrudniej trafić), gdy brak stałego celu", !!fs && fs.to === "5:200:3", JSON.stringify(fs));
    check("powoli (10%) — im wolniej, tym dłużej flota poza domem", g.formSpeed === 10, String(g.formSpeed));
    check("misja to stacjonowanie, nie atak", !!fs && /Deploy/i.test(fs.mission || ""), fs && fs.mission);
    const st = JSON.parse(g.store.get("genesis.ogamex.net:ogx3_situation") || "{}");
    const f = (st.flights || [])[0];
    // v3.68.1 (audyt): `recallAt > Date.now()` przechodziło dla DOWOLNEJ przyszłości —
    // także dla błędu, który kosztował Fleet Save sens: klikania zawrotu dopiero O
    // GODZINIE POWROTU. Zawrócona flota wraca tyle, ile już leciała, więc żeby być w
    // domu o T, zawrót musi paść w POŁOWIE drogi między startem a T.
    const homeAt = (() => { const d = new Date(); d.setHours(cfg.fs.returnHour, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); return d.getTime(); })();
    const mid = f ? (f.sentAt + homeAt) / 2 : 0;
    check("zawrót zaplanowany na POŁOWĘ drogi, żeby flota była w domu o skonfigurowanej godzinie",
      !!f && f.recallAt < homeAt && Math.abs(f.recallAt - mid) < 5 * 60e3,
      f && `recallAt=${new Date(f.recallAt).toISOString()} połowa=${new Date(mid).toISOString()} dom=${new Date(homeAt).toISOString()}`);
    // Godzina powrotu minęła: termin zawrotu minął
    advance(g, 3 * 3600e3);
    const r2 = await run(g, { cfg, loads: 10, ticksPerLoad: 2 });
    check("o skonfigurowanej godzinie bot ZAWRACA flotę sam", !!(g.sent[0] && g.sent[0].returning), JSON.stringify(g.sent[0]));
    check("i mówi o tym w dzienniku", r2.logs.some(m => /ZAWRÓT/.test(m)), r2.logs.slice(0, 5).join(" | "));
  }

  console.log("\n── 15b. FLEET SAVE (v3.68.0, port z Atheny): miner zostaje w domu, gdy mining pracuje; cel stały ──");
  {
    // v3.68.1 (audyt): `(H + 2) % 24` zawijało się między 22:00 a 23:59 na 0/1 — czyli
    // na godzinę JUŻ MINIONĄ dziś, więc `fsReturnAt` przeskakiwał na jutro (~25 h) i oba
    // scenariusze FS padały deterministycznie w tym oknie doby. Liczymy godzinę z zegara
    // przesuniętego o 2 h, zamiast liczyć modulo na samej liczbie.
    const H = new Date(Date.now() + 2 * 3600e3).getHours();
    const cfg = {
      autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1,
      aster: { enabled: true }, debris: { enabled: false },
      fs: { enabled: true, returnHour: H, returnMinute: 0, speedPct: 10, target: "1:100:9" },
      human: { breaks: false, economyAtNight: true },
    };
    const g = new Game({
      pairs: [
        { key: "1:100:5", name: "Baza", moon: true },
        { key: "1:100:9", name: "Cel", moon: true },
        // v3.68.1 (audyt): bez trzeciej, DALSZEJ pary „najdalsza kolonia" wypadała
        // dokładnie na cel stały — asercja niżej przechodziła nawet wtedy, gdy kod
        // całkowicie ignorował `cfg.fs.target` (potwierdzone testem mutacyjnym).
        { key: "5:200:3", name: "Daleka", moon: true },
      ],
      hangars: { "1:100:5|moon": { BATTLESHIP: 700, ASTEROID_MINER: 50 } },
    });
    g.flightSec = 4 * 3600;                     // FS musi WISIEĆ w powietrzu do godziny powrotu
    const { logs } = await run(g, { cfg, loads: 25, ticksPerLoad: 3 });
    const fs = g.sent[0];
    check("FS poleciał na STAŁY skonfigurowany cel, nie najdalszą kolonię", !!fs && fs.to === "1:100:9", JSON.stringify(fs));
    check("wziął pancerniki", !!fs && fs.ships && fs.ships.BATTLESHIP === 700, JSON.stringify(fs && fs.ships));
    check("miner ZOSTAŁ w domu (mining pracuje — port z Atheny)", !!fs && fs.ships && !fs.ships.ASTEROID_MINER, JSON.stringify(fs && fs.ships));
    // v3.68.1 (audyt): zerowanie hangaru było pomijane w całości, gdy lot niósł
    // wykluczenia — stan udawał wtedy PEŁNĄ flotę w domu przez 48 h („flota-duch":
    // drugi FS z pustego księżyca, a przy ataku ratunek floty, której nie ma).
    // Hangar źródła ma pokazywać dokładnie to, co naprawdę zostało: same minery.
    const st15b = JSON.parse(g.store.get("genesis.ogamex.net:ogx3_situation") || "{}");
    const h15b = (st15b.hangars || {})["1:100:5|moon"];
    check("hangar źródła po locie pokazuje TYLKO zostawionego minera (nie kłamie w żadną stronę)",
      !!h15b && h15b.total === 50 && (h15b.ships || []).length === 1 && h15b.ships[0].type === "ASTEROID_MINER",
      JSON.stringify(h15b));
    // Sam stan hangaru to za mało: sztuczna gra i tak odświeża go przy kolejnym wejściu
    // na /fleet, więc asercja wyżej przechodzi nawet wtedy, gdy bot w ogóle nie domknął
    // wysyłki (potwierdzone mutacją). Dowodem, że domknięcie ZASZŁO i zostawiło minera,
    // jest linia logu — pojawia się wyłącznie ze ścieżki z `keepTypes`.
    check("bot ZAPISAŁ, że domknął wysyłkę zostawiając minera w domu (nie wyzerował hangaru w ciemno)",
      logs.some(m => /w domu zostaje .*ASTEROID_MINER/.test(m)), logs.filter(m => /hangar/.test(m)).slice(0, 3).join(" | "));
  }

  console.log("\n── 15c. FLEET SAVE NIGDY NIE WYWŁASZCZA RATUNKU (audyt przed merge v3.68.1) ──");
  {
    // Kolejność akcji szła za kolejnością par na pasku, a pętla robi `break` po PIERWSZYM
    // locie — cicha para z Fleet Save potrafiła więc zabrać jedyny lot obrony i zostawić
    // atakowaną flotę pod uderzeniem. Do 3.67 kolizja istniała tylko w oknie nocnym;
    // odkąd FS startuje o każdej porze, okno to 24/7.
    const H = new Date(Date.now() + 2 * 3600e3).getHours();
    const cfg = {
      autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1,
      fs: { enabled: true, returnHour: H, returnMinute: 0, speedPct: 10 },
      human: { breaks: false, economyAtNight: true },
    };
    const g = new Game({
      pairs: [
        { key: "1:100:5", name: "Cicha", moon: true },
        { key: "9:300:2", name: "Atakowana", moon: true },
        { key: "5:200:3", name: "Daleka", moon: true },
      ],
      hangars: { "1:100:5|moon": { BATTLESHIP: 700 }, "9:300:2|moon": { BATTLESHIP: 5000 } },
      threats: [{ src: "9:9:9", dst: "9:300:2", dstBody: "moon", eta: 300 }],
    });
    g.flightSec = 4 * 3600;
    const { logs } = await run(g, { cfg, loads: 25, ticksPerLoad: 3 });
    const first = g.sent[0];
    check("pierwszy lot to RATUNEK atakowanej pary, nie Fleet Save cichej", !!first && first.from === "9:300:2", JSON.stringify(g.sent));
    check("atakowana flota faktycznie opuściła ciało pod ostrzałem", !!first && first.ships && (first.ships.BATTLESHIP || 0) === 5000, JSON.stringify(first && first.ships));
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

  console.log("\n── 26. PĘTLA NAWIGACJI: adres formularza przestawia aktywną planetę ──");
  {
    // Incydent Genesis 28.08 22:17–22:22: ekspedycja z KOLONII, adres formularza
    // niesie koordy celu (poz. 16), a fork siada wtedy na planecie głównej. Bot
    // widział „to nie moja planeta", wracał do kroku „switch", klikał kolonię,
    // znowu wchodził na formularz… ~30 przeładowań gry, w logu SAME linie startowe
    // (powody ginęły w 800-ms debounce zapisu logu), koniec dopiero na limicie 5 min.
    // moon:{enabled:false} — v3.67.0 zmieniło domyślne WŁĄCZONE; ten scenariusz testuje
    // PĘTLĘ NAWIGACJI ekspedycji, a "Kolonia" bez księżyca w fixture jest tu przypadkowa
    // (nie przedmiotem testu) — bez wyłączenia moduł Moon wchodziłby jej w drogę.
    const cfg = { autoRescue: true, expo: { enabled: true, waves: 1 }, recon: true, reconMs: 300000, moon: { enabled: false }, human: { breaks: false, economyAtNight: true } };
    const g = new Game({
      pairs: [{ key: "1:100:5", name: "Baza", moon: true }, { key: "1:100:9", name: "Kolonia", moon: false }],
      hangars: { "1:100:9|planet": { LARGE_CARGO: 40 } },
      active: { key: "1:100:9", body: "planet" },     // ekspedycja startuje z KOLONII, dom to [1:100:5]
    });
    g.fleetUrlHijack = true;
    const rA = await run(g, { cfg, loads: 40, ticksPerLoad: 2 });
    const rB = await run(g, { cfg, loads: 40, ticksPerLoad: 2 });   // cichy odczyt hangaru konczy przebieg — wznawiamy
    const logs = rA.logs.concat(rB.logs);
    check("bot PRZERWAŁ pętlę zamiast kręcić stroną 5 minut", logs.some(m => /pętla przełączania ciał|nie jest stroną floty|formularz nie otwiera/.test(m)), logs.filter(m => /LOT|EXPO/.test(m)).slice(0, 8).join(" | "));
    check("i zrobił to w kilkunastu nawigacjach, nie w trzydziestu", g.navigations.length <= 20, "nawigacji: " + g.navigations.length);
    check("powód nawigacji przeżył przeładowanie (log nie jest już niemy)", logs.some(m => /przełączam na|formularz \[/.test(m)), logs.filter(m => /LOT/.test(m)).slice(0, 6).join(" | "));
  }

  console.log("\n── 27. BONUS ONLINE: antymateria + punkty Akademii ──");
  {
    // Moduł przeniesiony z 2.x (OnlineBonus). Trzy pułapki z Atheny: odbiór przez
    // NAWIGACJĘ (klik przegrywał wyścig z innymi modułami), napis z odliczaniem to
    // nie jest bonus, a odbiór trzeba potwierdzić na następnej stronie.
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: false, human: { breaks: false, economyAtNight: true } };
    const g = new Game({ hangars: { "1:100:5|moon": { BATTLESHIP: 10 } } });
    g.bonus = true;
    const { logs } = await run(g, { cfg, loads: 12, ticksPerLoad: 2 });
    check("bot odebrał bonus (nawigacja pod /home/onlinebonus)", g.bonusClaims === 1, "odbiorów: " + g.bonusClaims + " | " + logs.filter(m => /BONUS/.test(m)).slice(0, 4).join(" | "));
    check("i potwierdził odbiór po przeładowaniu", logs.some(m => /\[BONUS\] odebrany/.test(m)), logs.filter(m => /BONUS/.test(m)).slice(0, 4).join(" | "));
    check("nie klika w kółko, gdy bonusu nie ma", g.bonusClaims === 1, "odbiorów: " + g.bonusClaims);

    // odliczanie „Online bonus 04:12" = jeszcze nie ma czego odbierać
    const g2 = new Game({ hangars: { "1:100:5|moon": { BATTLESHIP: 10 } } });
    g2.bonus = true;
    g2.bonusHtml = () => `<nav id="menu"><a href="/home/onlinebonus" id="btn-online-bonus">Online bonus 04:12</a></nav>`;
    const r2 = await run(g2, { cfg, loads: 8, ticksPerLoad: 2 });
    check("odliczanie NIE jest odbierane", g2.bonusClaims === 0, "odbiorów: " + g2.bonusClaims);

    // Zgłoszenie 28.08 23:26: „nie zbiera bonusu jak na Athenie". Powód: cisza nocna
    // ekonomii (23:00–05:00). Cisza ma udawać śpiące konto — ale gdy operator KLIKA
    // po grze, konto jest jawnie online i jeden klik w menu niczego nie zdradza.
    const h = new Date().getHours();
    const quiet = { enabled: true, startHour: h, endHour: (h + 2) % 24 };
    const cfgQ = { ...cfg, quietHours: quiet, human: { breaks: false, economyAtNight: false } };

    const g3 = new Game({ hangars: { "1:100:5|moon": { BATTLESHIP: 10 } } });
    g3.bonus = true;
    g3.store.set("genesis.ogamex.net:ogx3_manual_at", JSON.stringify(Date.now()));   // operator właśnie klikał
    await run(g3, { cfg: cfgQ, loads: 10, ticksPerLoad: 2 });
    check("w ciszy nocnej, ale gdy GRASZ — bonus jest odbierany", g3.bonusClaims === 1, "odbiorów: " + g3.bonusClaims);

    // Ustępstwo dotyczy WYŁĄCZNIE ciszy nocnej. Inne bramki (tu: sufit nawigacji/h)
    // nadal wstrzymują odbiór — i od teraz mówią o tym w logu, zamiast milczeć.
    // (Symulator nie potrafi udać „konto śpi": każde przeładowanie bez powodu bota
    //  JEST kliknięciem operatora, więc śpiące konto testujemy inną bramką.)
    const g4 = new Game({ hangars: { "1:100:5|moon": { BATTLESHIP: 10 } } });
    g4.bonus = true;
    g4.store.set("genesis.ogamex.net:ogx3_nav_log", JSON.stringify(Array.from({ length: 300 }, () => Date.now())));
    const r4 = await run(g4, { cfg, loads: 8, ticksPerLoad: 2 });
    check("inna bramka niż cisza (sufit nawigacji) wstrzymuje odbiór", g4.bonusClaims === 0, "odbiorów: " + g4.bonusClaims);
    check("i bot pisze, dlaczego nie odbiera (koniec cichego nicnierobienia)", r4.logs.some(m => /\[BONUS\] nie odbieram teraz/.test(m)), r4.logs.filter(m => /BONUS/.test(m)).slice(0, 4).join(" | "));
    check("i bot mówi dlaczego", r2.logs.some(m => /odliczanie/.test(m)), r2.logs.filter(m => /BONUS/.test(m)).slice(0, 4).join(" | "));

    // Zgłoszenie 29.08 13:25: „bot nie klika online bonus". Bot tika także na
    // stronach BEZ menu gry (kroki formularza floty, ekran po wysyłce), a każde
    // takie tiknięcie odsuwało próbę o 10 minut — przy ekspedycjach co parę minut
    // bonus nie wracał praktycznie nigdy. Brak przycisku to nie kara, tylko
    // „spróbuj na następnej stronie".
    const g5 = new Game({ hangars: { "1:100:5|moon": { BATTLESHIP: 10 } } });
    g5.bonus = false;                       // strona bez menu gry
    const r5a = await run(g5, { cfg, loads: 6, ticksPerLoad: 2 });
    g5.bonus = true;                        // menu wróciło, bonus czeka
    await run(g5, { cfg, loads: 6, ticksPerLoad: 2 });
    check("brak przycisku nie blokuje odbioru na następnej stronie", g5.bonusClaims === 1, "odbiorów: " + g5.bonusClaims);
    check("i brak przycisku nie jest karany karencją", !r5a.logs.some(m => /brak przycisku.*wracam za/.test(m)), r5a.logs.filter(m => /BONUS/.test(m)).slice(0, 3).join(" | "));

    // Log 29.08 13:26–15:52: bot bezczynny stoi na stronie BEZ menu gry (keepalive
    // parkował go na "/"), więc `find()` co 30 min pisał „brak przycisku", a bonus
    // wpadał tylko wtedy, gdy właściciel sam klikał po grze. Menu dociągamy w tle.
    const g6 = new Game({ hangars: { "1:100:5|moon": { BATTLESHIP: 10 } } });
    g6.bonus = true; g6.menuOnlyOnHome = true; g6.page = "fleet";   // strona bez menu
    const r6 = await run(g6, { cfg, loads: 8, ticksPerLoad: 2 });
    check("bonus odebrany, choć na bieżącej stronie nie ma menu gry", g6.bonusClaims === 1, "odbiorów: " + g6.bonusClaims + " | " + r6.logs.filter(m => /BONUS/.test(m)).slice(0, 4).join(" | "));
    check("i bot mówi, że zobaczył go w /home", r6.logs.some(m => /widziany w \/home/.test(m)), r6.logs.filter(m => /BONUS/.test(m)).slice(0, 4).join(" | "));

    // v3.31.0: gdy bot dociągnął /home i przycisku tam NIE MA, mówi to wprost —
    // „brak przycisku" brzmiało jak ślepota bota, a to gra jeszcze nie dała bonusu.
    const g7 = new Game({ hangars: { "1:100:5|moon": { BATTLESHIP: 10 } } });
    g7.bonus = false; g7.menuOnlyOnHome = true; g7.page = "fleet";
    const r7 = await run(g7, { cfg, loads: 6, ticksPerLoad: 2 });
    check("sprawdzone /home bez bonusu = inny komunikat niż ślepota", r7.logs.some(m => /jeszcze nie wrócił/.test(m)), r7.logs.filter(m => /BONUS/.test(m)).slice(0, 3).join(" | "));

    // keepalive nie może parkować bota na stronie bez menu gry
    check("keepalive przeładowuje na /home, nie na \"/\"", /Nav\.go\("\/home", "keepalive/.test(SRC), (SRC.match(/keepalive: 10 min[^)]*/) || [""])[0]);
  }

  console.log("\n── 28. KSIĘŻYCE: stawianie za metal (moduł WYDAJE surowce) ──");
  {
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: false, bonus: { enabled: false }, moon: { enabled: true, maxMetalShare: 0.25, minKm: 2000, maxTries24h: 3 }, human: { breaks: false, economyAtNight: true } };
    const g = new Game({
      pairs: [{ key: "1:100:5", name: "Baza", moon: true }, { key: "1:100:9", name: "Kolonia", moon: false }],
      hangars: { "1:100:5|moon": { BATTLESHIP: 10 } },
      active: { key: "1:100:5", body: "moon" },
    });
    g.metal = 3_800_000_000;     // budżet 25% = 950 mln → mieści się 3000 km (900 mln), nie 4000 (1,2 mld)
    const { logs } = await run(g, { cfg, loads: 20, ticksPerLoad: 2 });
    check("bot postawił księżyc przy planecie bez księżyca", !!g.moonBuilt && g.moonBuilt.key === "1:100:9", JSON.stringify(g.moonBuilt) + " | " + logs.filter(m => /KSIĘŻYC/.test(m)).slice(0, 5).join(" | "));
    check("zmieścił się w suficie 25% metalu", !!g.moonBuilt && g.moonBuilt.cost <= 950_000_000, JSON.stringify(g.moonBuilt));
    // v3.67.0: NAJMNIEJSZA średnica spełniająca minKm (tu 2000, jawnie skonfigurowane w
    // cfg tego testu), nie największa przystępna — cena nie jest już kryterium wyboru.
    check("wybrał NAJMNIEJSZĄ średnicę (minKm=2000), nie największą przystępną (3000)", !!g.moonBuilt && g.moonBuilt.km === 2000, JSON.stringify(g.moonBuilt));
    check("gra nigdy nie odmówiła (bot nie klikał ponad stan)", !g.moonRefused, "odmów: " + (g.moonRefused || 0));
    check("i zameldował sukces", logs.some(m => /\[KSIĘŻYC\] ✅/.test(m)), logs.filter(m => /KSIĘŻYC/.test(m)).slice(0, 5).join(" | "));

    // za mało metalu = ani jednego kliknięcia
    const g2 = new Game({
      pairs: [{ key: "1:100:5", name: "Baza", moon: true }, { key: "1:100:9", name: "Kolonia", moon: false }],
      hangars: { "1:100:5|moon": { BATTLESHIP: 10 } },
      active: { key: "1:100:5", body: "moon" },
    });
    g2.metal = 1_000_000;        // budżet 250 tys. — nawet 2000 km (600 mln) nie wchodzi
    let r2 = await run(g2, { cfg, loads: 35, ticksPerLoad: 3 });   // ciasny budżet loadów bywał źródłem mrugania
    // Heurystyka końca pętli run() („bot nie nawigował = koniec") potrafi uciąć przebieg
    // ZANIM bot dojdzie do werdyktu na stronie formularza (mruganie zależne od obciążenia
    // maszyny). Drugie podejście = ta sama gra i ten sam stan, po prostu więcej czasu —
    // dokładnie to, co bot dostaje w prawdziwej przeglądarce.
    if (!r2.logs.some(m => /za drogo/.test(m))) { const r2b = await run(g2, { cfg, loads: 20, ticksPerLoad: 3 }); r2 = { logs: [...r2.logs, ...r2b.logs] }; }
    check("przy pustej kasie NIE stawia księżyca", !g2.moonBuilt, JSON.stringify(g2.moonBuilt));
    check("i mówi wprost, że za drogo", r2.logs.some(m => /za drogo/.test(m)), r2.logs.filter(m => /KSIĘŻYC/.test(m)).slice(0, 5).join(" | "));

    // moduł WYŁĄCZONY (domyślnie) = zero ruchu
    const g3 = new Game({
      pairs: [{ key: "1:100:5", name: "Baza", moon: true }, { key: "1:100:9", name: "Kolonia", moon: false }],
      hangars: { "1:100:5|moon": { BATTLESHIP: 10 } },
      active: { key: "1:100:5", body: "moon" },
    });
    await run(g3, { cfg: { ...cfg, moon: { enabled: false } }, loads: 10, ticksPerLoad: 2 });
    check("wyłączony moduł nie wydaje ani jednego metalu", !g3.moonBuilt && g3.metal === 3_800_000_000, JSON.stringify(g3.moonBuilt));
  }

  console.log("\n── 29. MINERY JAK NA ATHENIE: rozmiar floty pod urobek + loty równoległe ──");
  {
    // 3.0 wysyłało WSZYSTKIE minery na jedną asteroidę i czekało na powrót. Gra
    // ogranicza urobek pojemnością ładowni floty, więc nadmiar leciał pusty zamiast
    // obrabiać kolejne asteroidy. Tu: urobek 500 tys., miner unosi 25 tys. →
    // sensowna fala to ceil(500k × 1,15 / 25k) = 23 minery, reszta leci dalej.
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1, bonus: { enabled: false },
      aster: { enabled: true, scanGapSec: 0, minTtlSec: 60, parallel: true, buffer: 1.15, percentile: 85, sampleSize: 20, minMiners: 1, slotReserve: 1, partialRatio: 0.5, gapSec: 0 },
      human: { breaks: false, economyAtNight: true } };
    const g = new Game({ hangars: { "1:100:5|moon": { ASTEROID_MINER: 100 } } });
    g.asteroid = true; g.asteroidTtl = 3600; g.flightSec = 120;
    // pojemność minera bot poznaje przy pierwszym locie — tu zaczynamy od stanu „już wie",
    // żeby sprawdzić sam dobór wielkości floty (naukę sprawdza osobny warunek niżej)
    g.store.set("genesis.ogamex.net:ogx3_aster", JSON.stringify({ cargo: 25000 }));
    g.slots = { fleet: { used: 0, total: 8 }, expo: { used: 0, total: 6 } };
    const { logs } = await run(g, { cfg, loads: 40, ticksPerLoad: 2 });
    const mining = g.sent.filter(x => /17$/.test(String(x.to || "")));
    check("wysłał FLOTĘ POD UROBEK, nie wszystkie minery", !!mining.length && mining[0].ships.ASTEROID_MINER === 23, JSON.stringify(mining.map(x => x.ships)));
    check("resztą minerów obrobił kolejną asteroidę (lot równoległy)", mining.length >= 2, "lotów minerów: " + mining.length);
    check("i nie przekroczył wolnych slotów floty", mining.length <= 7, "lotów: " + mining.length + " przy 8 slotach i rezerwie 1");

    // nauka pojemności: bez zasianego cargo bot ma się jej nauczyć z formularza
    const g5 = new Game({ hangars: { "1:100:5|moon": { ASTEROID_MINER: 40 } } });
    g5.asteroid = true; g5.asteroidTtl = 3600; g5.flightSec = 120;
    const r5 = await run(g5, { cfg, loads: 30, ticksPerLoad: 2 });
    check("uczy się pojemności ładowni minera z formularza floty", r5.logs.some(m => m.includes("1 miner uniesie") && m.replace(/\D/g, "").includes("25000")), r5.logs.filter(m => /ASTER/.test(m)).slice(0, 8).join(" | "));
    if (process.env.DIAG29) { console.log("   STAN ASTER:", game_store_dump(g)); console.log("   WSZYSTKIE LOGI:"); logs.slice(0, 25).forEach(m => console.log("     ", m.slice(0, 160))); console.log("   NAWIGACJE:", g.navigations.slice(0, 10)); }
  }

  console.log("\n── 30. PRZERWA KAWOWA nie może wypaść zaraz po włączeniu bota ──");
  {
    // 29.08 08:20:12 — właściciel włączył ekspedycje o 08:19, a 13 sekund później
    // bot zameldował „ekonomia pauzuje na ~13 min". Termin przerwy pochodził
    // z poprzedniego wieczora (bot był w nocy wyłączony), więc zaległa przerwa
    // odpaliła się natychmiast. Przerwa imituje zmęczenie pracą — po przestoju
    // nie ma z czego odpoczywać.
    const cfg = { autoRescue: true, recon: true, reconMs: 300000, bonus: { enabled: false },
      expo: { enabled: true, waves: 1 }, aster: { enabled: false },
      human: { breaks: true, breakEveryMinMin: 35, breakEveryMaxMin: 65, breakLenMinMin: 5, breakLenMaxMin: 15, economyAtNight: true } };

    const g = new Game({ hangars: { "1:100:5|moon": { LARGE_CARGO: 20 } } });
    g.store.set("genesis.ogamex.net:ogx3_break_next", JSON.stringify(Date.now() - 60e3));   // przerwa „zaległa" z wczoraj
    g.store.set("genesis.ogamex.net:ogx3_eco_last", JSON.stringify(Date.now() - 60 * 60e3)); // ekonomia stała godzinę
    const { logs } = await run(g, { cfg, loads: 25, ticksPerLoad: 2 });
    check("po nocnym przestoju bot NIE zaczyna od przerwy", !logs.some(m => /ekonomia pauzuje/.test(m)), logs.filter(m => /PRZERWA|EXPO/.test(m)).slice(0, 5).join(" | "));
    check("i mówi, że zaległa przerwa przepada", logs.some(m => /zaległa przerwa przepada/.test(m)), logs.filter(m => /PRZERWA/.test(m)).slice(0, 4).join(" | "));
    check("ekspedycja poleciała zamiast czekać kwadrans", g.sent.some(x => /16$/.test(String(x.to || ""))), JSON.stringify(g.sent.map(x => x.to)));

    // kontrola: gdy ekonomia PRACOWAŁA i termin minął, przerwa ma normalnie wypaść
    const g2 = new Game({ hangars: { "1:100:5|moon": { LARGE_CARGO: 20 } } });
    g2.store.set("genesis.ogamex.net:ogx3_break_next", JSON.stringify(Date.now() - 60e3));
    g2.store.set("genesis.ogamex.net:ogx3_eco_last", JSON.stringify(Date.now() - 60e3));    // pracowała przed chwilą
    const r2 = await run(g2, { cfg, loads: 12, ticksPerLoad: 2 });
    check("po godzinie pracy przerwa nadal działa", r2.logs.some(m => /ekonomia pauzuje/.test(m)), r2.logs.filter(m => /PRZERWA/.test(m)).slice(0, 4).join(" | "));
  }

  console.log("\n── 31. PRZYCISK NEXT POZA #content (Genesis) ──");
  {
    // Incydent 29.08 08:38 i 08:42: formularz wypełniony (55/23/346/451 statków),
    // zielony „Next" widoczny na ekranie — a bot po 25 s przerywał lot z „przycisk
    // niedostępny". Szukał wyłącznie wewnątrz #content, a na tym forku przycisk
    // stoi w stopce formularza, poza tym kontenerem. 2.x miało fallback na całą
    // stronę i dlatego „na Athenie działało bardzo dobrze".
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1, human: { breaks: false, economyAtNight: true } };
    const g = new Game({
      hangars: { "1:100:5|moon": { BATTLESHIP: 600 } },
      threats: [{ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 400 }],
    });
    g.nextOutsideContent = true;              // „Next" tylko w stopce, poza #content
    const { logs } = await run(g, { cfg, loads: 30, ticksPerLoad: 3 });
    check("bot znajduje Next w stopce i wysyla flote", g.sent.length >= 1, JSON.stringify(g.sent.map(x => x.from + "->" + x.to + " " + JSON.stringify(x.ships))));
    check("kolejne kliki nie wysylaja PUSTYCH flot", g.sent.filter(x => Object.keys(x.ships || {}).length > 0).length === 1, JSON.stringify(g.sent.map(x => x.ships)));
    check("nie melduje falszywie braku przycisku", !logs.some(m => /NIE MA na stronie|pozostał WYŁĄCZONY/.test(m)), logs.filter(m => /przycisk/.test(m)).slice(0, 3).join(" | "));
  }

  console.log("\n── 32. REKONESANS: koniec objazdu wszystkich planet ──");
  {
    // Decyzja właściciela 29.08: „nie chcę, żeby tak przeskakiwało co planetę i
    // sprawdzało statki". Domyślny tryb „fleet" odwiedza tylko ciała, na których
    // bot WIDZIAŁ flotę (plus ciało startowe ekspedycji i to, na którym akurat
    // jesteś). Alarm to osobna ścieżka i nadal wolno mu wejść wszędzie.
    const cfg = { autoRescue: true, expo: { enabled: false }, bonus: { enabled: false },
      recon: true, reconMode: "fleet", reconMs: 1, human: { breaks: false, economyAtNight: true } };
    const g = new Game({
      pairs: [{ key: "1:100:5", name: "Baza", moon: true }, { key: "1:100:9", name: "Kolonia", moon: true }, { key: "1:100:3", name: "Druga", moon: false }],
      hangars: { "1:100:5|moon": { BATTLESHIP: 600 } },
      active: { key: "1:100:5", body: "moon" },
    });
    const { logs } = await run(g, { cfg, loads: 25, ticksPerLoad: 2 });
    const hops = logs.filter(m => /REKONESANS\] przechodzę na/.test(m));
    check("bot NIE objeżdża pustych kolonii", !hops.some(m => /1:100:9|1:100:3/.test(m)), hops.slice(0, 4).join(" | "));
    check("ale zna hangar tam, gdzie stoi flota", logs.some(m => /sprawdzam hangar|1:100:5/.test(m)) || g.navigations.some(n => /z=5/.test(String(n))), g.navigations.slice(0, 6).join(","));

    // tryb „all" = dawne zachowanie, dla kogoś, kto tego chce
    const g2 = new Game({
      pairs: [{ key: "1:100:5", name: "Baza", moon: true }, { key: "1:100:9", name: "Kolonia", moon: true }],
      hangars: { "1:100:5|moon": { BATTLESHIP: 600 } },
      active: { key: "1:100:5", body: "moon" },
    });
    const r2 = await run(g2, { cfg: { ...cfg, reconMode: "all" }, loads: 25, ticksPerLoad: 2 });
    // Kontrola trybu „all" na poziomie decyzji, nie zegara: symulator nie zmieści
    // 90-sekundowego dławika rekonesansu w kilku sekundach przebiegu.
    const inst = load(g2, { cfg });
    const sit = inst.api.Situation.load();
    inst.api.CFG.reconMode = "fleet";
    const nFleet = inst.api.Recon.bodiesOf(sit).length;
    inst.api.CFG.reconMode = "all";
    const nAll = inst.api.Recon.bodiesOf(sit).length;
    check("tryb WSZYSTKIE obejmuje więcej ciał niż tryb tylko-flota", nAll > nFleet, "fleet=" + nFleet + " all=" + nAll);
  }

  console.log("\n── 33. REKONESANS PRZYPIETY DO CIALA STARTOWEGO ──");
  {
    // Właściciel 29.08: „flota jest zawsze tam, skąd wysyłane są ekspedycje, na innych
    // planetach najwyżej są transportery". Gdy ciało startowe jest ustawione, rekonesans
    // pilnuje TYLKO jego — nawet kolonia z transporterami nie jest warta przełączania planety.
    const cfg = { autoRescue: true, bonus: { enabled: false }, aster: { enabled: false },
      expo: { enabled: false, launchFrom: { galaxy: 1, system: 100, position: 5 } },
      recon: true, reconMode: "fleet", reconMs: 1, human: { breaks: false, economyAtNight: true } };
    const g = new Game({
      pairs: [{ key: "1:100:5", name: "Baza", moon: true }, { key: "1:100:9", name: "Kolonia", moon: false }],
      hangars: { "1:100:5|moon": { BATTLESHIP: 600 }, "1:100:9|planet": { SMALL_CARGO: 8 } },  // kolonia z transporterami
      active: { key: "1:100:5", body: "moon" },
    });
    const inst = load(g, { cfg });
    const sit = inst.api.Situation.load();
    const bodies = inst.api.Recon.bodiesOf(sit).map(([k, b]) => k + "|" + b);
    check("rekonesans pilnuje wylacznie ciala startowego", bodies.every(x => x.startsWith("1:100:5")), JSON.stringify(bodies));
    check("kolonia z transporterami NIE trafia na liste", !bodies.some(x => x.startsWith("1:100:9")), JSON.stringify(bodies));
    const { logs } = await run(g, { cfg, loads: 20, ticksPerLoad: 2 });
    check("i w praktyce nie przelacza sie na kolonie", !logs.some(m => /przechodzę na .*1:100:9/.test(m)), logs.filter(m => /REKONESANS/.test(m)).slice(0, 4).join(" | "));
  }

  console.log("\n── 34. SERIA FAL: bramka anty-duplikat nie moze zjadac fali 2 ──");
  {
    // Audyt 29.08 + log gracza 09:27:03 „wysyłka do [1:217:16] już poszła 81s temu —
    // nie powtarzam": bramka pisana dla ratunku (3 min, ta sama para → ten sam cel)
    // kasowała kolejne fale ekspedycji, bo wszystkie lecą stamtąd samego na poz. 16.
    const cfg = { autoRescue: true, recon: true, reconMs: 300000, bonus: { enabled: false }, aster: { enabled: false },
      expo: { enabled: true, waves: 2, gapMinSec: 0, gapMaxSec: 0, slotReserve: 0 },
      human: { breaks: false, economyAtNight: true } };
    const g = new Game({ hangars: { "1:100:5|moon": { LARGE_CARGO: 40, LIGHT_FIGHTER: 20 } } });
    g.slots = { fleet: { used: 0, total: 8 }, expo: { used: 0, total: 4 } };
    const r1 = await run(g, { cfg, loads: 25, ticksPerLoad: 3 });
    check("(warunek wstepny) fala 1 poszla", g.sent.filter(x => /16$/.test(String(x.to || ""))).length === 1, JSON.stringify(g.sent.map(x => x.to)));
    // W grze odstep miedzy falami to 60-90 s; symulator nie czeka minuty, wiec
    // przesuwamy zegar o 30 s — wiecej niz okno 20 s, ktore zostawilismy ekonomii.
    advance(g, 30e3);
    const r2 = await run(g, { cfg, loads: 25, ticksPerLoad: 3 });
    const expo = g.sent.filter(x => /16$/.test(String(x.to || "")));
    const logs = r1.logs.concat(r2.logs);
    check("fala 2 tez wyszla (bramka nie zjada serii)", expo.length >= 2, "fal: " + expo.length + " | " + logs.filter(m => /EXPO/.test(m)).slice(0, 4).join(" | "));
    // ...ale bramka nadal ma chronic przed WYSLANIEM TEJ SAMEJ fali dwa razy
    check("bramka nadal chroni przed podwojna wysylka tej samej fali", expo.length === 2, "fal: " + expo.length);
  }

  console.log("\n── 35. NIE WYRYWA OPERATORA NA ZAKLADKE FLOTA OBCEJ PLANETY ──");
  {
    // Zgloszenie 29.08 12:08: „ciagle przeskakuje na inne planety w zakladce flota".
    // Gałąź „odswiez hangar ciala, na ktorym akurat jestes" nie podlegala ograniczeniu
    // z v3.21.0 — wiec gdy operator klikal budynki na kolonii, bot wyrywal go na jej Fleet.
    const cfg = { autoRescue: true, bonus: { enabled: false }, aster: { enabled: false },
      expo: { enabled: false, launchFrom: { galaxy: 1, system: 100, position: 5 } },
      recon: true, reconMode: "fleet", reconMs: 1, human: { breaks: false, economyAtNight: true } };
    const g = new Game({
      pairs: [{ key: "1:100:5", name: "Baza", moon: true }, { key: "1:100:9", name: "Kolonia", moon: false }],
      hangars: { "1:100:5|moon": { BATTLESHIP: 600 } },
      active: { key: "1:100:9", body: "planet" },   // operator siedzi na kolonii
    });
    g.page = "building/resource";                    // ...i klika budynki, nie flote
    const { logs } = await run(g, { cfg, loads: 20, ticksPerLoad: 2 });
    const yanks = g.navigations.filter(n => /^\/fleet\?x=1&y=100&z=9/.test(String(n)));
    check("bot NIE otwiera zakladki Flota kolonii, na ktorej jestes", yanks.length === 0, JSON.stringify(g.navigations.slice(0, 6)));
    check("i mowi, dlaczego tego nie robi", logs.some(m => /nie otwieram Ci zakładki Flota/.test(m)), logs.filter(m => /REKONESANS/.test(m)).slice(0, 3).join(" | "));
  }

  console.log("\n── 36. HANGAR CZYTANY W TLE — bez przelaczania planety (model Atheny) ──");
  {
    // Athena nie miala cyklicznego rekonesansu: FleetRecon.scan() odpalal sie tylko,
    // gdy bot i tak byl na stronie floty. 3.0 dorobilo objazd planet i to on wkurzal
    // operatora. Patrol jest teraz domyslnie OFF, a ekspedycja dociaga hangar fetchem.
    // moon:{enabled:false} — v3.67.0 zmieniło domyślne WŁĄCZONE; oba ciała fixture są tu
    // bez księżyca PRZYPADKOWO (test dotyczy cichego dociągania hangaru ekspedycji, nie
    // Moon), bez wyłączenia moduł Moon zjadłby tick ekonomii, zanim doszłoby do Expo.
    const cfg = { autoRescue: true, recon: false, bonus: { enabled: false }, aster: { enabled: false }, moon: { enabled: false },
      expo: { enabled: true, waves: 1, launchFrom: { galaxy: 1, system: 100, position: 5 } },
      human: { breaks: false, economyAtNight: true } };
    const g = new Game({
      pairs: [{ key: "1:100:5", name: "Baza", moon: false }, { key: "1:100:9", name: "Kolonia", moon: false }],
      hangars: { "1:100:5|planet": { LARGE_CARGO: 30 } },
      active: { key: "1:100:9", body: "planet" },     // operator siedzi na innej kolonii
    });
    g.page = "building/resource";
    const r36a = await run(g, { cfg, loads: 30, ticksPerLoad: 3 });
    const r36b = await run(g, { cfg, loads: 30, ticksPerLoad: 3 });
    const logs = r36a.logs.concat(r36b.logs);
    check("bot dociagnal hangar w tle, bez przelaczania planety", logs.some(m => /dociągnąłem hangar .* w tle|odczytany w tle/.test(m)), logs.filter(m => /EXPO|REKONESANS/.test(m)).slice(0, 5).join(" | "));
    check("i nie wszedl na zakladke Flota kolonii operatora", !g.navigations.some(n => /^\/fleet\?x=1&y=100&z=9/.test(String(n))), JSON.stringify(g.navigations.slice(0, 6)));
    check("ekspedycja i tak poleciala", g.sent.some(x => /16$/.test(String(x.to || ""))), JSON.stringify(g.sent.map(x => x.to)));
    // v3.47.0 (Error „Planet change has been detected" 31.08 10:12): fetch `?planet=UUID`
    // przestawia aktywna planete PO STRONIE SERWERA — po odczycie innego ciala bot musi
    // drugim fetchem przywrocic cialo, na ktorym stoi operator.
    const fp = (g.fetches || []).filter(u => /\/fleet\?planet=/.test(u));
    check("po cichym odczycie bot PRZYWRACA planete operatora (fork trzyma wybor w sesji)",
      fp.some((u, i) => u.includes("uuid-1:100:5") && fp.slice(i + 1).some(v => v.includes("uuid-1:100:9"))), JSON.stringify(fp.slice(0, 8)));
    // v3.48.0 (owner 31.08: „przed chwila znowu przeskoczyl"): fala ekspedycji musiala
    // przelaczyc cialo pod formularz — po domknieciu serii bot ODPROWADZA karte na strone
    // i planete operatora (operator w E2E nie klika, wiec warunek „nie kliknal" trzyma).
    check("po serii ekspedycji bot wraca na strone i planete operatora",
      g.navigations.some(n => /building\/resource\?planet=uuid-1:100:9/.test(String(n))), JSON.stringify(g.navigations.slice(-6)));
  }

  console.log("\n── 37. REJESTR POWROTÓW (v3.52.0): fala zmapowana przy wysyłce, lądująca pod atak = ratunek ──");
  {
    // Owner 31.08: „bot ma mapować każdą wysłaną flotę i wiedzieć, kiedy wraca".
    // Snajperka powrotów (ścieżka A5 z Atheny): napastnik celuje w księżyc tuż po
    // lądowaniu fali. Przed 3.52 bot czytał pusty hangar RAZ, uznawał odczyt za świeży
    // przez 15 min i fala lądująca w trakcie dolotu wroga stała pod uderzeniem.
    const cfg = { autoRescue: true, recon: true, reconMs: 1, bonus: { enabled: false }, aster: { enabled: false },
      expo: { enabled: true, waves: 1, gapMinSec: 0, gapMaxSec: 0, slotReserve: 0 },
      human: { breaks: false, economyAtNight: true } };
    const g = new Game({ hangars: { "1:100:5|moon": { LIGHT_FIGHTER: 900, SMALL_CARGO: 100 } } });
    g.slots = { fleet: { used: 0, total: 8 }, expo: { used: 0, total: 4 } };
    await run(g, { cfg, loads: 25, ticksPerLoad: 3 });
    check("(warunek wstępny) ekspedycja poleciała", g.sent.some(x => /16$/.test(String(x.to || ""))), JSON.stringify(g.sent.map(x => x.to)));
    const K = "genesis.ogamex.net:ogx3_situation";
    const st = JSON.parse(g.store.get(K) || "{}");
    const e = (st.expected || [])[0];
    check("wysyłka ZMAPOWANA w rejestrze powrotów (potwierdzona, pełna liczba statków)", !!e && !e.pending && e.fromKey === "1:100:5" && e.fromBody === "moon" && e.total === 1000, JSON.stringify(st.expected));
    check("termin powrotu = lot tam + postój + lot z powrotem (czas z FORMULARZA)", !!e && e.flightMs > 0 && Math.abs((e.returnAt - e.sentAt) - (2 * e.flightMs + (e.holdMs || 0))) < 2000, JSON.stringify(e));
    check("ekspedycja nadal POZA flights (rejestr nie zaślepia obrony)", (st.flights || []).length === 0, JSON.stringify(st.flights));
    // CHIRURGIA STANU: fala „wylądowała" minutę temu — statki wracają do hangaru atrapy,
    // ale odczyt hangaru w stanie bota pochodzi SPRZED lądowania (dokładnie okno snajperki).
    if (e) e.returnAt = Date.now() - 60e3;
    st.hangars["1:100:5|moon"] = { total: 0, at: Date.now() - 5 * 60e3, ships: [] };
    g.store.set(K, JSON.stringify(st));
    g.hangars["1:100:5|moon"] = { LIGHT_FIGHTER: 900, SMALL_CARGO: 100 };
    g.threats.push({ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 300 });
    const { logs } = await run(g, { cfg: { ...cfg, expo: { enabled: false } }, loads: 30, ticksPerLoad: 3 });
    const rescue = g.sent.find(x => x.from === "1:100:5" && /Deploy/i.test(x.mission || ""));
    check("bot ponownie odczytał hangar (odczyt sprzed lądowania ≠ świeży) i URATOWAŁ falę", !!rescue, JSON.stringify(g.sent) + " | " + logs.filter(m => /REKONESANS|fala|ratun/i.test(m)).slice(0, 5).join(" | "));
    check("ratunek poszedł na sąsiedni księżyc, nie na atakowaną parę", !rescue || (rescue.to === "1:100:9" && rescue.toBody === "moon"), JSON.stringify(rescue));
  }

  console.log("\n── 38. WCZEŚNIEJSZY ZAWRÓT (v3.53.0): napastnik zawrócił → flota nie czeka do martwego terminu ──");
  {
    // Owner 31.08 (prawdziwy atak 18:48): napastnik ręcznie zawrócił, pasek czysty,
    // a bot trzymał ucieczkę w powietrzu do planowanego dolotu. Pasek misji jest
    // GLOBALNY — zero obcych utrzymane ≥60 s to dowód zawrotu, nie artefakt.
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: true, reconMs: 1 };
    // eta 600 s: zawrót (dolot+90 s bufora = 690 s) wypada PRZED lądowaniem ucieczki
    // (810 s przy 10%), więc lot realnie wisi w powietrzu z zaplanowanym zawrotem —
    // przy dłuższym dolocie wroga recallOf() słusznie robi z ucieczki lądowanie.
    const g = new Game({ threats: [{ src: "9:9:9", dst: "1:100:5", dstBody: "moon", eta: 600 }] });
    await run(g, { cfg, loads: 10, ticksPerLoad: 3 });
    check("(warunek wstępny) ewakuacja poszła", g.sent.length === 1, JSON.stringify(g.sent));
    // v3.53.1 (incydent 19:29:08 na żywo): fala ekspedycji wylądowała na źródle ratunku
    // i „domknęła" wpis lotu — bot zapomniał o 11 mln statków i NIGDY ich nie zawrócił.
    // Symulacja: hangar źródła pełny (świeży odczyt) PRZED terminem zawrotu → wpis zostaje.
    advance(g, 90e3);
    {
      const K0 = "genesis.ogamex.net:ogx3_situation";
      const st0 = JSON.parse(g.store.get(K0) || "{}");
      st0.hangars["1:100:5|moon"] = { total: 500, at: Date.now(), ships: [] };
      g.store.set(K0, JSON.stringify(st0));
    }
    const rMid = await run(g, { cfg, loads: 3, ticksPerLoad: 2 });
    const stGuard = JSON.parse(g.store.get("genesis.ogamex.net:ogx3_situation") || "{}");
    check("fala w hangarze źródła NIE domyka lotu ratunku przed terminem zawrotu", (stGuard.flights || []).some(f => f.phase === "launched"), JSON.stringify(stGuard.flights) + " | " + rMid.logs.filter(m => /LOT/.test(m)).slice(0, 3).join(" | "));
    g.threats = [];                    // napastnik ZAWRÓCIŁ — wiersze i pasek czyste, dolot miał być za ~10 min
    await run(g, { cfg, loads: 4, ticksPerLoad: 2 });   // refresh łapie czysty pasek (start okna 60 s)
    const stMid = JSON.parse(g.store.get("genesis.ogamex.net:ogx3_situation") || "{}");
    check("chwilę po zniknięciu wroga bot JESZCZE nie zawraca (okno 60 s)", !(g.sent[0] && g.sent[0].returning), JSON.stringify(g.sent[0]));
    check("sygnał czystego paska zapisany", !!(stMid.hostileClear && stMid.hostileClear.since), JSON.stringify(stMid.hostileClear));
    advance(g, 2 * 60e3);              // minęły 2 min ciszy — wciąż PRZED planowanym dolotem (recallAt daleko)
    const { logs } = await run(g, { cfg, loads: 8, ticksPerLoad: 2 });
    check("bot zdjął zagrożenia przed terminem (napastnik ZAWRÓCIŁ w logu)", logs.some(m => /napastnik ZAWRÓCIŁ/.test(m)), logs.filter(m => /OBRONA|ZAWR/.test(m)).slice(0, 5).join(" | "));
    check("i KLIKNĄŁ wcześniejszy zawrót ucieczki", !!(g.sent[0] && g.sent[0].returning), JSON.stringify(g.sent[0]));
    const st2 = JSON.parse(g.store.get("genesis.ogamex.net:ogx3_situation") || "{}");
    const f2 = (st2.flights || [])[0];
    check("stan lotu przeszedł w zawrót", !f2 || ["recall_clicked", "recalled"].includes(f2.phase), JSON.stringify(st2.flights));
  }

  console.log("\n── 39. ZŁOM (v3.56.0): PZ po piratach leży w układzie STARTU ekspedycji, nie aktywnej pary ──");
  {
    // Ekspedycje przypięte do [1:217:6], operator gra na [1:100:5] — złom po
    // piratach leży na [1:217:16]. Do v3.55 zbieracz zaglądał do układu AKTYWNEJ
    // pary (1:100) i PZ leżało godzinami; parytet z Atheną (HomeBase.expo).
    // v3.57.0: stempel okresu pada PRZY nawigacji (znacznik debris_go domyka
    // odczyt po przeładowaniu) — bot odwiedza galaktykę RAZ na everyMin, a nie
    // co 60 s, gdy operator zabiera stronę (log ownera 20:23–20:26).
    const cfg = { autoRescue: true, recon: false, debris: { enabled: true, everyMin: 20 },
      expo: { enabled: false, launchFrom: { galaxy: 1, system: 217, position: 6 } },
      human: { breaks: false, economyAtNight: true } };
    const g = new Game({
      pairs: [{ key: "1:100:5", name: "Baza", moon: true }, { key: "1:217:6", name: "Ekspo", moon: true }],
      hangars: { "1:217:6|moon": { RECYCLER: 200000, LIGHT_FIGHTER: 50 } },
      active: { key: "1:100:5", body: "planet" },
    });
    // v3.61.0: w kolumnie DF wisi ikona WŁASNEJ floty lecącej na 16 (ekspedycje!),
    // a recyklery lecą 30 min — jak na żywo w nocy 01/02.09 (15 pustych lotów).
    g.fleetIcon16 = true;
    g.flightSec = 1826;
    // hangar bazy ekspedycyjnej znany (w produkcji pilnuje go rekonesans v3.21.0)
    g.store.set("genesis.ogamex.net:ogx3_situation", JSON.stringify({ pairs: {}, hangars: {
      "1:217:6|moon": { total: 200050, at: Date.now(), ships: [{ type: "RECYCLER", qty: 200000 }, { type: "LIGHT_FIGHTER", qty: 50 }] },
    }, threats: [], own: [], flights: [], bar: null, active: null, updatedAt: Date.now() }));
    await run(g, { cfg, loads: 6, ticksPerLoad: 2 });
    check("bot zajrzał na galaktykę układu startu ekspedycji (1:217), nie aktywnej pary (1:100)",
      g.navigations.some(u => /galaxy\?x=1&y=217/.test(u)) && !g.navigations.some(u => /galaxy\?x=1&y=100/.test(u)),
      JSON.stringify(g.navigations.slice(0, 8)));
    check("ikona WŁASNEJ floty w kolumnie DF to nie złom — zero wysyłek", g.sent.length === 0, JSON.stringify(g.sent));
    g.debris16 = true;
    advance(g, 21 * 60e3);
    const { logs } = await run(g, { cfg, loads: 10, ticksPerLoad: 2 });
    // v3.60.0: na tym forku „Collect" (mission 13) zbiera z WŁASNEJ planety —
    // złom zbiera misja „Recycle"; dymek bez linku i bez etykiet (ikonki+liczby).
    const zl = g.sent.find(s => /Recycle/i.test(s.mission || ""));
    check("recyklery poleciały misją RECYCLE (nie Collect-z-własnej-planety)", !!zl && !g.sent.some(s => s.mission === "Collect"), JSON.stringify(g.sent) + " | " + logs.filter(m => /ZŁOM|LOT/.test(m)).slice(0, 6).join(" | "));
    check("z bazy ekspedycyjnej [1:217:6] (księżyc)", !!zl && zl.from === "1:217:6" && zl.fromBody === "moon", JSON.stringify(zl));
    check("na poz. 16 celem typu ZŁOM", !!zl && zl.to === "1:217:16" && zl.toBody === "debris", JSON.stringify(zl));
    // v3.59.0: złom 2 mld × 1,1 / 125 000 = 17 600 recyklerów — reszta (91%)
    // zostaje w domu, żeby przy ataku było czym wywieźć surowce.
    check("wysłały TYLE ILE TRZEBA (17 600 z 200 000), nic poza recyklerami", !!zl && zl.ships.RECYCLER === 17600 && !zl.ships.LIGHT_FIGHTER, JSON.stringify(zl && zl.ships));
    // toLocaleString("pl-PL") używa twardych spacji — porównujemy same cyfry.
    check("rozmiar złomu policzony z SAMYCH LICZB dymka (ikonki zamiast etykiet)", logs.some(m => m.includes("surowców") && m.replace(/[^\d]/g, "").includes("2000000000")), logs.filter(m => /ZŁOM/.test(m)).slice(0, 4).join(" | "));
    const stZl = JSON.parse(g.store.get("genesis.ogamex.net:ogx3_situation") || "{}");
    check("lot po złom NIE jest lotem obronnym (nie zablokuje ratunku)", (stZl.flights || []).length === 0, JSON.stringify(stZl.flights));
    // v3.61.0: zbieracze lecą 30 min, kontrola co 20 — kolejny cykl NIE dosyła,
    // póki pierwsza flota nie dotrze (rejestr powrotów zna termin dolotu).
    advance(g, 21 * 60e3);
    await run(g, { cfg, loads: 6, ticksPerLoad: 2 });
    check("zbieracze W DRODZE (lot 30 min) — kolejna kontrola NIE dosyła", g.sent.filter(x => /Recycle/i.test(x.mission || "")).length === 1, JSON.stringify(g.sent.map(x => x.mission)));
    advance(g, 15 * 60e3);
    await run(g, { cfg, loads: 8, ticksPerLoad: 2 });
    check("po DOLOCIE zbieraczy świeże pole = nowa wysyłka", g.sent.filter(x => /Recycle/i.test(x.mission || "")).length === 2, JSON.stringify(g.sent.map(x => x.mission)));
    check("galaktyka odwiedzana tylko, gdy jest po co (2 wizyty w całym scenariuszu)", g.navigations.filter(u => /galaxy\?x=1&y=217/.test(u)).length === 2, JSON.stringify(g.navigations.filter(u => /galaxy/.test(u))));
  }

  console.log("\n── 40. „Ekspedycje OFF” W TRAKCIE misji gasi zaplanowaną falę (v3.64.0, incydent 03.09 06:56) ──");
  {
    // Na żywo: fala zaplanowana 06:53:46, operator kliknął „Ekspedycje OFF" 06:56:05,
    // a maszyna lotu i tak dokończyła wysyłkę 06:56:38 (BATTLESHIP×344 994) — bo
    // Fly.tick nigdzie nie sprawdzał przełącznika po starcie misji.
    const cfgOn = { autoRescue: true, expo: { enabled: true, waves: 1 }, recon: true, reconMs: 300000, human: { breaks: false, economyAtNight: true } };
    const g = new Game();
    // faza 1: pojedyncze załadowania, aż misja ekspedycji stoi w store, ale NIC nie poszło
    let planned = false;
    for (let i = 0; i < 12 && !planned && g.sent.length === 0; i++) {
      const inst = load(g, { cfg: cfgOn });
      try { await inst.tick(1); } catch (e) { console.log("!! TICK RZUCIŁ:", e && e.message); }
      await new Promise(r => setTimeout(r, 140));
      planned = (g.store.get("genesis.ogamex.net:ogx3_mission") || "null") !== "null";
    }
    check("(warunek wstępny) misja zaplanowana, fala JESZCZE nie wysłana", planned && g.sent.length === 0, `misja=${String(g.store.get("genesis.ogamex.net:ogx3_mission")).slice(0, 120)}, wysyłek=${g.sent.length}`);
    // faza 2: operator klika „Ekspedycje OFF" — kolejne przeładowania NIE dosyłają fali
    const { logs } = await run(g, { cfg: { expo: { enabled: false } }, loads: 8, ticksPerLoad: 2 });
    check("fala NIE poszła po wyłączeniu", g.sent.length === 0, JSON.stringify(g.sent));
    check("misja zdjęta (bez karencji trasy)", (g.store.get("genesis.ogamex.net:ogx3_mission") || "null") === "null", String(g.store.get("genesis.ogamex.net:ogx3_mission")));
    check("bot mówi wprost, że przerwał przez przełącznik", logs.some(m => /wyłączyłeś ekspedycje w trakcie misji/.test(m)), logs.filter(m => /LOT|EXPO/.test(m)).slice(0, 6).join(" | "));
  }

  console.log("\n── 41. Pusty księżyc po fali domykającej + OPÓŹNIONY powrót ekspedycji (v3.65.0, log 03.09 08:58) ──");
  {
    // Na żywo: fala domykająca zostawiła na księżycu 0, bot odświeżał odtąd PLANETĘ
    // (0 szt.), a gdy ~50 mln statków wylądowało na księżycu, mówił „brak statków" —
    // do ręcznego wejścia operatora na /fleet. Do tego gra opóźnia powroty o godziny,
    // rejestr powrotów (60 min po wyliczonym terminie) już ich nie zna, a wiersz
    // ekspedycji w liście ruchów (bez klasy „return") zna sekundę lądowania.
    const cfg = { autoRescue: true, recon: false, debris: { enabled: false }, human: { breaks: false, economyAtNight: true },
      expo: { enabled: true, waves: 1, slotReserve: 0, launchFrom: { galaxy: 1, system: 217, position: 6 } } };
    const g = new Game({
      pairs: [{ key: "1:100:5", name: "Baza", moon: true }, { key: "1:217:6", name: "Ekspo", moon: true }],
      hangars: { "1:217:6|moon": { LIGHT_FIGHTER: 5000 }, "1:217:6|planet": {} },   // flota WŁAŚNIE wylądowała na księżycu
      active: { key: "1:100:5", body: "planet" },
    });
    g.moonLinks = true;
    g.slots = { fleet: { used: 0, total: 20 }, expo: { used: 0, total: 10 } };
    const K = "genesis.ogamex.net:ogx3_situation";
    // stan jak 03.09 08:58: księżyc 0 sprzed 16 h (fala domykająca), planeta 0 świeża, rejestr powrotów pusty (karta była zamknięta)
    g.store.set(K, JSON.stringify({ pairs: {}, hangars: {
      "1:217:6|moon": { total: 0, at: Date.now() - 16 * 3600e3, ships: [] },
      "1:217:6|planet": { total: 0, at: Date.now() - 60e3, ships: [] },
    }, threats: [], own: [], flights: [], expected: [], bar: null, active: null, updatedAt: Date.now() }));
    // run() kończy pętlę, gdy bot nie nawiguje — a cichy odczyt hangaru NIE nawiguje,
    // więc fala rusza dopiero w kolejnym wywołaniu (jak na żywo: „wysyłka w następnym przebiegu").
    const r1 = { logs: [] };
    for (let i = 0; i < 5 && !g.sent.some(x => /Expedition/i.test(x.mission || "")); i++) { const rr = await run(g, { cfg, loads: 10, ticksPerLoad: 2 }); r1.logs.push(...rr.logs); }
    check("bot dociągnął w tle hangar KSIĘŻYCA (nie planety) i zobaczył flotę", r1.logs.some(m => /dociągnąłem hangar \[1:217:6\] moon w tle/.test(m)) && !r1.logs.some(m => /dociągnąłem hangar \[1:217:6\] planet/.test(m)), r1.logs.filter(m => /EXPO|REKONESANS|LOT/.test(m)).slice(0, 8).join(" | "));
    const ex1 = g.sent.find(s => /Expedition/i.test(s.mission || ""));
    check("fala poleciała z księżyca [1:217:6] bez pomocy operatora", !!ex1 && ex1.from === "1:217:6" && ex1.fromBody === "moon" && ex1.ships.LIGHT_FIGHTER === 5000, JSON.stringify(g.sent));
    check("żadnego „brak statków do wysłania” (objaw incydentu)", !r1.logs.some(m => /brak statków do wysłania/.test(m)), r1.logs.filter(m => /brak statków/.test(m)).join(" | "));

    // Część 2: ekspedycja wraca Z OPÓŹNIENIEM — rejestr powrotów pusty (jak po zamkniętej
    // karcie), w liście ruchów wiersz EXPEDITION bez klasy „return", odliczanie 5 s.
    if (ex1) { ex1.type = "EXPEDITION"; ex1.eta = 5; ex1.to = "1:217:16"; }
    { const st = JSON.parse(g.store.get(K) || "{}"); st.expected = []; g.store.set(K, JSON.stringify(st)); }
    await run(g, { cfg, loads: 3, ticksPerLoad: 2 });     // bot widzi wiersz i zapisuje termin lądowania
    const stA = JSON.parse(g.store.get(K) || "{}");
    check("termin lądowania z wiersza ekspedycji trafił do stanu pod KSIĘŻYC startu", Array.isArray((stA.expoLandings || {})["1:217:6|moon"]) && stA.expoLandings["1:217:6|moon"].length === 1, JSON.stringify(stA.expoLandings) + " own=" + JSON.stringify(stA.own));
    // 2 min później: flota wylądowała (wiersz zniknął), na księżycu stoi 3000 myśliwców,
    // a ostatni odczyt księżyca (po wysyłce: 0) jest sprzed lądowania.
    advance(g, 120e3);
    if (ex1) ex1.inFlight = false;
    g.hangars["1:217:6|moon"] = { LIGHT_FIGHTER: 3000 };
    {
      const st = JSON.parse(g.store.get(K) || "{}");
      st.hangars["1:217:6|moon"] = { total: 0, ships: [], at: Date.now() - 120e3 };
      st.hangars["1:217:6|planet"] = { total: 0, ships: [], at: Date.now() - 120e3 };
      g.store.set(K, JSON.stringify(st));
    }
    const r2 = { logs: [] };
    for (let i = 0; i < 5 && g.sent.filter(x => /Expedition/i.test(x.mission || "")).length < 2; i++) { const rr = await run(g, { cfg, loads: 10, ticksPerLoad: 2 }); r2.logs.push(...rr.logs); }
    check("po lądowaniu bot CICHO odczytał hangar księżyca (fetch w tle, zero nawigacji operatora)", r2.logs.some(m => /wróciła własna flota na księżyc \[1:217:6\].*odczytany w tle/.test(m)), r2.logs.filter(m => /OBRONA|EXPO|REKONESANS/.test(m)).slice(0, 8).join(" | "));
    const exps = g.sent.filter(s => /Expedition/i.test(s.mission || ""));
    check("i od razu poszła kolejna fala z powrotów (3000 myśliwców z księżyca)", exps.length === 2 && exps[1].ships.LIGHT_FIGHTER === 3000 && exps[1].fromBody === "moon", JSON.stringify(g.sent.map(s => [s.mission, s.from, s.fromBody, s.ships])));
  }

  console.log("\n── 42. „Ekspedycje OFF” kliknięte w INNEJ karcie gasi falę w tej (v3.65.0, owner 03.09 12:18) ──");
  {
    // Owner: „ekspedycje miałem wyłączone, a bot wysłał całą serię". CFG żyje w pamięci
    // każdej karty osobno; karta ze starym stanem (ON) tykała dalej, a jej zapis z panelu
    // nadpisywał wyłączenie. Teraz każdy przebieg zaczyna od stempla zapisu w schowku.
    const cfgOn = { autoRescue: true, expo: { enabled: true, waves: 1, slotReserve: 0 }, recon: false, debris: { enabled: false }, human: { breaks: false, economyAtNight: true } };
    const g = new Game();
    const KC = "genesis.ogamex.net:ogx3_cfg";
    const KAT = "genesis.ogamex.net:ogx3_cfg_saved_at";     // v3.65.1: stempel ŻYJE OSOBNO od cfg (patrz niżej)
    const a = load(g, { cfg: cfgOn });                       // karta A: ekspedycje ON w pamięci
    // karta B tej samej przeglądarki klika „Ekspedycje OFF" — NOWSZY zapis w schowku
    { const st = JSON.parse(g.store.get(KC) || "{}"); st.expo = { ...(st.expo || {}), enabled: false }; g.store.set(KC, JSON.stringify(st)); g.store.set(KAT, JSON.stringify(Date.now() + 1000)); }
    try { await a.tick(3); } catch (e) { console.log("!! TICK RZUCIŁ:", e && e.message); }
    await new Promise(r => setTimeout(r, 200));
    const lg = JSON.parse(g.store.get("genesis.ogamex.net:ogx3_log") || "[]").map(e => e.msg);
    check("karta A przejęła wyłączenie z karty B (wpis w logu)", lg.some(m => /\[CFG\] ustawienia zmienione w innej karcie.*ekspedycje OFF/.test(m)), lg.slice(0, 6).join(" | "));
    check("karta A NIE wysłała fali ani nie zaplanowała misji", g.sent.length === 0 && (g.store.get("genesis.ogamex.net:ogx3_mission") || "null") === "null", JSON.stringify(g.sent) + " misja=" + String(g.store.get("genesis.ogamex.net:ogx3_mission")).slice(0, 80));
    check("CFG w pamięci karty A = OFF (panel pokaże prawdę)", a.api.CFG.expo.enabled === false);
    a.api.saveCfg();
    check("zapis z panelu stempluje czas w KLUCZU OSOBNYM od cfg (inne karty go przejmą)", (JSON.parse(g.store.get(KAT) || "0")) > 0, g.store.get(KAT));

    // v3.65.1 (log 03.09 13:07–14:37: „[CFG] ustawienia zmienione w innej karcie" po
    // KAŻDYM przeładowaniu przez 90 minut, choć nikt nic nie zmieniał): stempel żył w
    // `CFG.savedAt`, a CFG jest budowany OD ZERA z DEFAULTS przy KAŻDYM przeładowaniu
    // strony (ten fork nawiguje = przeładowuje grę = ponownie wstrzykuje skrypt) — pętla
    // po DEFAULTS kopiowała ze schowka tylko klucze obecne w DEFAULTS, `savedAt` nim nie
    // jest, więc ginął co przeładowanie i syncCfg zawsze widział „nowszy" zapis. Test:
    // wiele KOLEJNYCH „przeładowań" (osobne load()) z TYM SAMYM zapisanym configiem —
    // ani jednego spurious wpisu w logu.
    const g3 = new Game();
    load(g3, { cfg: cfgOn }).api.saveCfg();                  // jeden prawdziwy zapis, jak klik w panelu
    for (let i = 0; i < 8; i++) { const inst = load(g3, {}); try { await inst.tick(2); } catch {} }
    const lg3 = JSON.parse(g3.store.get("genesis.ogamex.net:ogx3_log") || "[]").map(e => e.msg);
    check("8 kolejnych przeładowań BEZ zmiany ustawień → zero spurious „[CFG] zmienione”", !lg3.some(m => /\[CFG\] ustawienia zmienione w innej karcie/.test(m)), lg3.filter(m => /CFG/.test(m)).join(" | "));
    // kontrola: bez wyłączenia w schowku ta sama karta wysyła normalnie
    const g2 = new Game();
    g2.moonLinks = true;                                   // bez recon bot czyta hangar księżyca tylko cichym fetchem
    const r2 = { logs: [] };
    for (let i = 0; i < 5 && !g2.sent.some(x => /Expedition/i.test(x.mission || "")); i++) { const rr = await run(g2, { cfg: cfgOn, loads: 10, ticksPerLoad: 2 }); r2.logs.push(...rr.logs); }
    check("(kontrola) bez wyłączenia fala idzie jak dotąd", g2.sent.some(x => /Expedition/i.test(x.mission || "")), JSON.stringify(g2.sent) + " | " + r2.logs.filter(m => /EXPO|CFG/.test(m)).slice(0, 5).join(" | "));
  }

  console.log("\n── 43. KSIĘŻYCE v3.67.0: domyślnie WŁĄCZONE+NAJMNIEJSZA (1000 km), E7 pomija zablokowaną parę, auto-powrót floty po odbudowie ──");
  {
    // moon celowo NIE nadpisany w cfg → wystawia PRAWDZIWE DEFAULTS (enabled:true, minKm:1000).
    const cfg = { autoRescue: true, expo: { enabled: false }, recon: false, bonus: { enabled: false }, aster: { enabled: false }, debris: { enabled: false }, human: { breaks: false, economyAtNight: true } };
    const g = new Game({
      pairs: [
        { key: "1:100:5", name: "Baza", moon: true },
        { key: "1:100:9", name: "Zablokowana", moon: false },   // E7: już przy limicie prób — target() ma ją pominąć
        { key: "1:100:8", name: "Kolonia", moon: false },        // ma dostać księżyc PIERWSZA
      ],
      hangars: { "1:100:5|moon": { BATTLESHIP: 10 }, "1:100:8|planet": { BATTLESHIP: 500 } },
      active: { key: "1:100:5", body: "moon" },
    });
    g.metal = 2_000_000_000;   // budżet 25% = 500 mln — 1000 km (300 mln) starcza z zapasem
    g.store.set("genesis.ogamex.net:ogx3_moon", JSON.stringify({ tries: { "1:100:9": { n: 3, at: Date.now() } }, m: null }));
    // Skrót testowy: bot "wie" o flocie na [1:100:8] planet ze świeżego odczytu (normalnie
    // przyszłoby ze skanu /fleet) — bez tego auto-powrót nie miałby czego sprawdzić, bo
    // moduł Moon nigdy sam nie odwiedza zakładki Flota.
    g.store.set("genesis.ogamex.net:ogx3_situation", JSON.stringify({
      pairs: {}, threats: [], own: [], flights: [], bar: null, active: null, updatedAt: Date.now(),
      hangars: { "1:100:8|planet": { total: 500, ships: [{ type: "BATTLESHIP", qty: 500 }], at: Date.now() } },
    }));
    const { logs } = await run(g, { cfg, loads: 30, ticksPerLoad: 2 });
    check("E7: pominął zablokowaną parę [1:100:9] i postawił księżyc przy [1:100:8]", !!g.moonBuilt && g.moonBuilt.key === "1:100:8", JSON.stringify(g.moonBuilt) + " | " + logs.filter(m => /KSIĘŻYC/.test(m)).slice(0, 6).join(" | "));
    check("domyślnie NAJMNIEJSZA średnica (1000 km) bez nadpisania w cfg", !!g.moonBuilt && g.moonBuilt.km === 1000, JSON.stringify(g.moonBuilt));
    check("po odbudowie bot JEDNORAZOWO zwiózł flotę z planety na nowy księżyc (Deploy)",
      g.sent.some(x => x.to === "1:100:8" && x.toBody === "moon" && x.mission === "Deploy"),
      JSON.stringify(g.sent.map(x => ({ to: x.to, toBody: x.toBody, mission: x.mission }))) + " | " + logs.filter(m => /KSIĘŻYC|zwożę/.test(m)).slice(0, 4).join(" | "));
  }

  console.log(`\n${fails ? fails + " FAIL — NIE WYPYCHAJ" : "E2E: wszystko OK"}  (${checks} sprawdzeń)`);
  process.exit(fails ? 1 : 0);
})();
