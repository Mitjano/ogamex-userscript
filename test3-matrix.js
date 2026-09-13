// ─────────────────────────────────────────────────────────────────────────
//  MACIERZ BOJOWA — czy bot ZAWSZE obroni flotę?
// ─────────────────────────────────────────────────────────────────────────
// Powstała po stracie z nocy 13.09 i pytaniu właściciela: „ciągle mam obawy, że
// coś jest nie tak i bot nie obroni floty". Poprzednie audyty czytały kod i za
// każdym razem coś znajdowały — ten plik odpowiada LICZBĄ zamiast opinią.
//
// Metoda: generujemy kombinacje realnych warunków (typ ataku × czas dolotu ×
// stan pamięci bota o hangarze × sygnał lądowania × lot w powietrzu × dostępne
// refugium), puszczamy przez PRAWDZIWĄ funkcję decide() i konfrontujemy wynik
// z niezależnym SĘDZIĄ, który zna PRAWDĘ scenariusza (ile floty naprawdę stoi
// pod uderzeniem). Sędzia nie zagląda do kodu bota — pyta tylko: „skoro tam
// stoi flota, jest czas i jest dokąd uciec, to czy bot ruszył?".
//
//   node test3-matrix.js
//   node test3-matrix.js -v     (wypisz każdy przypadek, nie tylko porażki)

const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "ogamex-3.user.js"), "utf8").replace(/\r\n/g, "\n");

function bodyOf(sig) {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error(`nie znalazłem ${sig}`);
  const open = src.indexOf("{", i + sig.length - 1);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(open + 1, j); }
  }
  throw new Error(`nie domknąłem ${sig}`);
}
const Situation = { fleetAt: new Function("s", "k", "now", bodyOf("fleetAt(s, k, now = Date.now()) {")) };
const flightStale = new Function("f", "now", bodyOf("function flightStale(f, now) {"));
const flightsBlocking = (st, now) => (st.flights || []).some(f => f.phase !== "done" && !flightStale(f, now));
const decide = new Function("Situation", "flightStale", "flightsBlocking",
  `return function decide(s, cfg, now) {${bodyOf("function decide(s, cfg, now) {")}}`)(Situation, flightStale, flightsBlocking);

const CFG = { confirmMs: 20000, tooLateSec: 40, airSpeedPct: 3, recallBufferSec: 90, hangarTrustMs: 10 * 60e3 };
const NOW = 1_700_000_000_000;
const KEY = "3:272:7";                         // atakowana para (baza z księżycem)
const VERBOSE = process.argv.includes("-v");

// ── WYMIARY MACIERZY ──────────────────────────────────────────────────────
const TYPY = [
  { id: "ATTACK", type: "ATTACK", dstBody: "moon" },
  { id: "DESTROY", type: "DESTROY", dstBody: "moon" },
  { id: "ATTACK-planeta", type: "ATTACK", dstBody: "planet" },
  { id: "ACS-bez-ciała", type: "ACS", dstBody: null },     // wiersz bez rozpoznanego ciała
];
const CZASY = [
  { id: "45s", sec: 45 }, { id: "120s", sec: 120 },
  { id: "600s", sec: 600 }, { id: "3000s", sec: 3000 },
];
// `stoi` = PRAWDA scenariusza: ile floty naprawdę jest pod uderzeniem.
// `wpis` = co bot ma w pamięci (może kłamać — na tym polega cały problem).
const HANGARY = [
  { id: "świeży-z-flotą", stoi: 120e6, wpis: { total: 120e6, ago: 30e3, ships: [{ type: "BATTLESHIP", qty: 120e6 }] } },
  { id: "świeży-sama-rezerwa", stoi: 43, wpis: { total: 43, ago: 30e3, ships: [{ type: "DEATH_STAR", qty: 43 }] } },
  { id: "przeterminowany-z-flotą", stoi: 120e6, wpis: { total: 120e6, ago: 45 * 60e3, ships: [{ type: "BATTLESHIP", qty: 120e6 }] } },
  { id: "wyzerowany-po-ucieczce", stoi: 0, wpis: { total: 0, ago: 5 * 60e3, ships: [] } },
  { id: "rezerwa-a-wróciła-fala", stoi: 120e6, wpis: { total: 43, ago: 6 * 60e3, ships: [{ type: "DEATH_STAR", qty: 43 }] }, falaPo: true },
  { id: "pusty-a-wróciła-fala", stoi: 120e6, wpis: { total: 0, ago: 6 * 60e3, ships: [] }, falaPo: true },
  { id: "brak-wpisu", stoi: 0, wpis: null },
];
const LOTY = [
  { id: "nic-nie-leci", lot: false },
  { id: "ucieczka-w-powietrzu", lot: true },
];
const REFUGIA = [
  { id: "sąsiedni-księżyc", sasiad: true, inna: true },
  { id: "tylko-inna-kolonia", sasiad: false, inna: true },
  { id: "brak-refugium", sasiad: false, inna: false },
];

function buduj(typ, czas, hangar, lotWar, ref) {
  const pairs = { [KEY]: { hasMoon: true, galaxy: 3, system: 272, position: 7 } };
  if (ref.sasiad) pairs["3:272:2"] = { hasMoon: true, galaxy: 3, system: 272, position: 2 };
  if (ref.inna) pairs["3:280:4"] = { hasMoon: true, galaxy: 3, system: 280, position: 4 };
  const hangars = {};
  const body = typ.dstBody || "moon";
  if (hangar.wpis) hangars[`${KEY}|${body}`] = { total: hangar.wpis.total, at: NOW - hangar.wpis.ago, ships: hangar.wpis.ships };
  const s = {
    pairs, hangars, own: [], bar: null, active: { key: KEY, body },
    threats: [{ id: "t1", dst: KEY, dstBody: typ.dstBody, arriveAt: NOW + czas.sec * 1000, attack: true,
      seenAt: NOW - 60e3, lastSeenAt: NOW, source: "list", type: typ.type }],
    flights: lotWar.lot ? [{ kind: "air", fromKey: KEY, fromBody: body, toKey: "3:272:2", toBody: "moon",
      id: "lot0", sentAt: NOW - 120e3, flightMs: 3600e3, recallAt: NOW + 1800e3, phase: "launched" }] : [],
    expected: hangar.falaPo ? [{ fromKey: KEY, fromBody: body, toKey: "3:272:16", sentAt: NOW - 40 * 60e3,
      returnAt: NOW - 60e3, flightMs: 600e3, total: hangar.stoi, pending: false }] : [],
  };
  return s;
}

// ── SĘDZIA: zna prawdę scenariusza, nie zna kodu bota ─────────────────────
// Zwraca, czego OCZEKUJEMY. Ratunek jest wymagany, gdy pod uderzeniem NAPRAWDĘ
// stoi flota warta ratowania, jest czas na formularz i jest dokąd lecieć.
function oczekiwanie(typ, czas, hangar, lotWar, ref) {
  const stoiCos = hangar.stoi > 1000;                  // sama rezerwa (43 GS) nie liczy się jako flota
  const jestCzas = czas.sec >= CFG.tooLateSec;
  const jestDokad = ref.sasiad || ref.inna;
  // Drugie ciało tej samej pary jest ZAWSZE dostępnym schronem, gdy atak leci tylko w jedno
  // z nich — bot korzysta z niego, gdy nie ma sąsiedniego księżyca ani innej kolonii. Sędzia
  // musi to wiedzieć, inaczej zgłasza porażkę tam, gdzie bot zachował się poprawnie.
  const drugieCialo = typ.dstBody !== null;
  if (!stoiCos) return { musi: "nic", powod: "pod uderzeniem nie stoi flota warta lotu" };
  if (!jestCzas) return { musi: "alarm", powod: "za mało czasu na formularz — zostaje alarm" };
  if (!jestDokad && !drugieCialo) return { musi: "alarm", powod: "nie ma dokąd uciec — zostaje alarm" };
  return { musi: "ratunek", powod: "flota stoi pod uderzeniem, jest czas i jest dokąd uciec" };
}

// ── PRZEBIEG ──────────────────────────────────────────────────────────────
const porazki = [], slabe = [];
let n = 0, ok = 0;
for (const typ of TYPY) for (const czas of CZASY) for (const hangar of HANGARY) for (const lotWar of LOTY) for (const ref of REFUGIA) {
  n++;
  const s = buduj(typ, czas, hangar, lotWar, ref);
  const exp = oczekiwanie(typ, czas, hangar, lotWar, ref);
  let r;
  try { r = decide(s, CFG, NOW); } catch (e) { porazki.push({ id: `${typ.id}/${czas.id}/${hangar.id}/${lotWar.id}/${ref.id}`, powod: `decide() RZUCIŁ: ${e.message}`, exp }); continue; }
  const fly = (r.actions || []).some(a => a.kind === "fly");
  const recon = (r.actions || []).some(a => a.kind === "recon");
  const alarm = (r.alerts || []).length > 0;
  const push = (r.alerts || []).some(a => a.push || a.blind || a.unknownPair);
  const id = `${typ.id} | ${czas.id} | ${hangar.id} | ${lotWar.id} | ${ref.id}`;

  if (exp.musi === "ratunek") {
    // Ratunek albo — gdy bot nie ma jeszcze pewności — zwiad, który go odblokuje
    // w następnym przebiegu. Milczenie jest porażką zawsze.
    if (fly) ok++;
    else if (recon && czas.sec > 120) { ok++; slabe.push({ id, powod: "zwiad zamiast lotu (odblokuje się w następnym przebiegu)" }); }
    else porazki.push({ id, powod: `flota ${hangar.stoi.toLocaleString("pl-PL")} szt. stoi pod uderzeniem, a bot nie rusza (fly=${fly}, recon=${recon}, alarm=${alarm})`, exp });
  } else if (exp.musi === "alarm") {
    if (alarm) { ok++; if (!push) slabe.push({ id, powod: "alarm bez pusha — właściciel śpi i się nie dowie" }); }
    else porazki.push({ id, powod: "bot milczy, choć nie może uratować floty", exp });
  } else {
    if (fly) { slabe.push({ id, powod: "lot mimo braku floty pod uderzeniem (marnuje slot)" }); ok++; } else ok++;
  }
  if (VERBOSE) console.log(`${exp.musi.padEnd(8)} | fly=${fly?1:0} recon=${recon?1:0} alarm=${alarm?1:0} | ${id}`);
}

console.log(`\n══ MACIERZ BOJOWA: ${n} scenariuszy ══`);
console.log(`Zgodnych z oczekiwaniem: ${ok}/${n}`);
if (slabe.length) {
  console.log(`\n── Słabe punkty (${slabe.length}) — działa, ale nie idealnie ──`);
  const grup = {};
  for (const s of slabe) (grup[s.powod] = grup[s.powod] || []).push(s.id);
  for (const [powod, ids] of Object.entries(grup)) console.log(`  ${ids.length}× ${powod}\n      np. ${ids[0]}`);
}
if (porazki.length) {
  console.log(`\n── PORAŻKI (${porazki.length}) — flota ginie ──`);
  for (const p of porazki.slice(0, 25)) console.log(`  ✗ ${p.id}\n      ${p.powod}`);
  if (porazki.length > 25) console.log(`  …i ${porazki.length - 25} więcej`);
}
console.log(porazki.length ? `\n${porazki.length} PORAŻEK — NIE WYPYCHAJ` : "\nMACIERZ BOJOWA: flota obroniona we wszystkich scenariuszach, w których dało się ją obronić");
process.exit(porazki.length ? 1 : 0);
