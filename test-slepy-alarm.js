// ─────────────────────────────────────────────────────────────────────────
//  TEST ŚLEPEGO ALARMU — WYMUSZONY PRZEGLĄD  (v2.99.1)
// ─────────────────────────────────────────────────────────────────────────
// Powód: 20.08 03:59→04:49 alarm po ataku (4×50 mld BC) wisiał ŚLEPY przez
// 50 minut — straż wyczerpała 20 zamiatań, bot stał na /galaxy (bez paska
// misji), lista ruchów nie oddawała odczytu, a zdjęła go dopiero przypadkowa
// sonda szpiegowska. Flota czekała na refugium ~70 min dłużej niż trzeba.
// Od 2.99.1 ślepa obrona po BLIND_NAV_MS sama nawiguje na "/" po wzrok.
//
// Test wykonuje PRAWDZIWE ciało check() wyjęte z pliku bota.

const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n");

function bodyOf(name, argList) {
  const sig = `    ${name}(${argList}) {`;
  const i = src.indexOf(sig);
  if (i < 0) throw new Error(`nie znalazłem metody ${name}(${argList}) w bocie`);
  const open = i + sig.length - 1;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, j);
    }
  }
  throw new Error(`nie domknąłem ciała ${name}`);
}

const body = bodyOf("check", "{ emergencyOnly = false } = {}");
if (body.length < 500) throw new Error(`ciało check() ma ${body.length} znaków — parser urwał funkcję`);

const MIN = 60 * 1000;
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "OK  " : "FAIL"} | ${name}`);
  if (!cond) failures++;
}

// Harness: jedno środowisko na scenariusz — GM w Mapie, ślepa strona
// (read→null), zdarzenia przeterminowane, cache paska pusty.
function runScenario({ alarmActive, armed, gm = {}, moonRunning = false }) {
  const store = new Map(Object.entries(gm));
  const navs = [];
  const loc = { pathname: "/galaxy", replace(url) { navs.push(url); } };
  const self = {
    KEY: "ogamex_threat",
    KEY_CANDIDATE: "ogamex_threat_candidate",
    KEY_SEEN: "ogamex_threat_last_seen",
    KEY_SEEN_AT: "ogamex_threat_last_seen_at",
    KEY_SIGHT_AT: "ogamex_threat_sight_at",
    KEY_BLIND_NAV_AT: "ogamex_threat_blind_nav_at",
    BLIND_NAV_MS: 5 * MIN,
    EVENT_MAX_AGE_MS: 90 * 1000,
    CONFIRM_MS: 25 * 1000,
    SELF_SEND_BLIND_MS: 20 * 1000,
    dumpEventsFromDom() {},
    dumpBaseRowOnce() {},
    fetchBaseRowOnce() { return Promise.resolve(); },
    maybeVisitBaseForMoon() {},
    dumpMarkupOnce() { return Promise.resolve(); },
    notify() {},
    read() { return null; },                    // strona bez paska misji
    events() { return null; },                  // zero odczytu zdarzeń
    active() { return alarmActive; },
    state() { return alarmActive ? { count: 4, seenAt: Date.now() - 30 * MIN, firstAt: Date.now() - 30 * MIN } : null; },
    clear() { store.set(this.KEY, "null"); },
  };
  const fn = new Function(
    "CONFIG", "GM_getValue", "GM_setValue", "ThreatLog", "log", "location",
    "window", "MoonSave", "updateStatusUI", "Notification", "SessionWatch", "ScanState",
    `return function({ emergencyOnly = false } = {}) {${body}};`
  )(
    { threatAlarm: { enabled: true } },
    (k, d) => (store.has(k) ? store.get(k) : d),
    (k, v) => store.set(k, v),
    { add() {} },
    () => {},
    loc,
    { location: loc },
    { watch: () => ({ armed }), running: moonRunning },
    () => {},
    undefined,
    { lostRecently: () => false },          // v2.102.0: sesja żywa
    { load: () => null }                    // v2.102.0: skan nieaktywny
  );
  fn.call(self, {});
  return { navs, store };
}

// 1. Alarm aktywny + ślepota od zawsze (SIGHT_AT=0) → wymuszona nawigacja na "/"
{
  const { navs, store } = runScenario({ alarmActive: true, armed: false });
  check("ślepy AKTYWNY alarm nawiguje na \"/\" po wzrok", navs.length === 1 && navs[0] === "/");
  check("wymuszony przegląd stempluje własny zegar (KEY_BLIND_NAV_AT)", !!parseInt(store.get("ogamex_threat_blind_nav_at") || "0"));
}

// 2. Sama straż (armed, alarm już zgasł) też nie może zostać ślepa
{
  const { navs } = runScenario({ alarmActive: false, armed: true });
  check("uzbrojona straż bez alarmu też wymusza przegląd", navs.length === 1 && navs[0] === "/");
}

// 3. Dławik: ostatni wymuszony przegląd <5 min temu → bez nawigacji
{
  const { navs } = runScenario({
    alarmActive: true, armed: true,
    gm: { ogamex_threat_blind_nav_at: String(Date.now() - 2 * MIN) },
  });
  check("drugi wymuszony przegląd przed upływem 5 min NIE rusza", navs.length === 0);
}

// 4. Świeży autorytatywny odczyt (SIGHT_AT < 5 min) → obrona jeszcze nie jest „ślepa"
{
  const { navs } = runScenario({
    alarmActive: true, armed: false,
    gm: { ogamex_threat_sight_at: String(Date.now() - 2 * MIN) },
  });
  check("2 min od dobrego odczytu to nie ślepota — bez nawigacji", navs.length === 0);
}

// 5. Bez alarmu i bez straży ślepa strona jest legalna (skan galaktyki)
{
  const { navs } = runScenario({ alarmActive: false, armed: false });
  check("bez uzbrojonej obrony ślepa strona NIE wymusza niczego", navs.length === 0);
}

// 6. Trwający ratunek (pending_mission) ma pierwszeństwo — nie wyrywać mu strony
{
  const { navs } = runScenario({
    alarmActive: true, armed: true,
    gm: { pending_mission: JSON.stringify({ type: "moon_save_direct" }) },
  });
  check("pending_mission blokuje wymuszony przegląd (ratunek ma stronę)", navs.length === 0);
}

// 7. Autorytatywny odczyt paska aktualizuje KEY_SIGHT_AT
{
  const store = new Map();
  const loc2 = { pathname: "/", replace() { throw new Error("czysty odczyt nie nawiguje"); } };
  const self = {
    KEY: "ogamex_threat", KEY_CANDIDATE: "ogamex_threat_candidate",
    KEY_SEEN: "ogamex_threat_last_seen", KEY_SEEN_AT: "ogamex_threat_last_seen_at",
    KEY_SIGHT_AT: "ogamex_threat_sight_at", KEY_BLIND_NAV_AT: "ogamex_threat_blind_nav_at",
    BLIND_NAV_MS: 5 * MIN, EVENT_MAX_AGE_MS: 90 * 1000, CONFIRM_MS: 25 * 1000, SELF_SEND_BLIND_MS: 20 * 1000,
    dumpEventsFromDom() {}, dumpBaseRowOnce() {}, fetchBaseRowOnce() { return Promise.resolve(); },
    maybeVisitBaseForMoon() {}, dumpMarkupOnce() { return Promise.resolve(); }, notify() {},
    read() { return { total: 3, own: 3, foreign: 0 }; },  // pasek JEST i mówi czysto
    events() { return null; },
    active() { return false; },
    state() { return null; },
    clear() {},
  };
  const fn = new Function(
    "CONFIG", "GM_getValue", "GM_setValue", "ThreatLog", "log", "location",
    "window", "MoonSave", "updateStatusUI", "Notification", "SessionWatch", "ScanState",
    `return function({ emergencyOnly = false } = {}) {${body}};`
  )(
    { threatAlarm: { enabled: true } },
    (k, d) => (store.has(k) ? store.get(k) : d),
    (k, v) => store.set(k, v),
    { add() {} }, () => {},
    loc2, { location: loc2 },
    { watch: () => ({ armed: false }), running: false },
    () => {}, undefined,
    { lostRecently: () => false }, { load: () => null }
  );
  fn.call(self, {});
  check("odczyt Z paskiem stempluje KEY_SIGHT_AT (zegar ślepoty od nowa)", !!parseInt(store.get("ogamex_threat_sight_at") || "0"));
}

if (failures) { console.error(`\n${failures} PRZYPADKÓW PADŁO`); process.exit(1); }
console.log("\nWSZYSTKIE PRZYPADKI PRZESZŁY");
