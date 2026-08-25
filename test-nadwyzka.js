// ─────────────────────────────────────────────────────────────────────────
//  TEST NADWYŻKI PASKA — barExcessDecision  (v2.104.0)
// ─────────────────────────────────────────────────────────────────────────
// Wykonuje PRAWDZIWĄ funkcję ThreatMonitor.barExcessDecision wyciętą z bota
// (blok BAR-EXCESS) na danych z incydentów. Powód: 2.103.3 kotwiczyła
// czekanie „na lądowanie sond" w chwili odczytu (odnawianej co tick) — alarm
// z wylądowanymi sondami nigdy się nie potwierdzał; audyt 25.08 wieczorem.
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n");
const a = src.indexOf("    barExcessDecision({"), b = src.indexOf("    // ── /BAR-EXCESS ──");
if (a < 0 || b < 0) throw new Error("brak bloku BAR-EXCESS");
const fnSrc = src.slice(a, b).trim().replace(/^barExcessDecision/, "function barExcessDecision").replace(/,\s*$/, "");
const decide = new Function(fnSrc + "\nreturn barExcessDecision;")();

let failures = 0;
const check = (n, c) => { console.log(`${c ? "OK  " : "FAIL"} | ${n}`); if (!c) failures++; };
const T = 1_700_000_000_000; // kandydat
const base = { barCached: false, barCountsProbes: false, candidateAt: T, now: T };

let r = decide({ ...base, barForeign: 3, attacks: 0, spies: 3, spiesInFlight: 3, spyMaxEta: 60 });
check("21:34: pasek 3, 3 sondy W LOCIE → nadwyżka 0 (BEZ alarmu)", r.excess === 0 && r.waitUntil === 0);

r = decide({ ...base, barForeign: 1, attacks: 0, spies: 2, spiesInFlight: 0, spyMaxEta: 0 });
check("16:22: pasek 1, 2 sondy WYLĄDOWANE → nadwyżka 1, czekanie 10 s od KANDYDATA", r.excess === 1 && r.waitUntil === T + 10000);
let r2 = decide({ ...base, barForeign: 1, attacks: 0, spies: 2, spiesInFlight: 0, spyMaxEta: 0, now: T + 30000 });
check("16:22 po 30 s: czekanie NIE przesuwa się z odczytem (kotwica = kandydat) → już minęło", r2.waitUntil === T + 10000 && r2.now === undefined && (T + 30000) >= r2.waitUntil);

r = decide({ ...base, barForeign: 1, attacks: 0, spies: 0, spiesInFlight: 0, spyMaxEta: 0 });
check("13:10: pasek 1, lista 0, bez sond → nadwyżka 1, bez czekania (ALARM)", r.excess === 1 && r.waitUntil === 0);

r = decide({ ...base, barForeign: 2, attacks: 0, spies: 1, spiesInFlight: 1, spyMaxEta: 1800 });
check("atak z układu + DALEKA sonda w locie (eta 30 min) → nadwyżka 1, bez czekania (sonda w locie już odjęta)", r.excess === 1 && r.waitUntil === 0);

r = decide({ ...base, barForeign: 2, attacks: 0, spies: 1, spiesInFlight: 0, spyMaxEta: 1800 });
check("nadwyżka 2 > 1 wylądowana sonda → nie może być sondą → bez czekania", r.excess === 2 && r.waitUntil === 0);

r = decide({ ...base, barForeign: 1, attacks: 0, spies: 1, spiesInFlight: 0, spyMaxEta: 1800 });
check("cap: wylądowana sonda z eta 1800 (śmieć) → czekanie ≤ kandydat + 130 s", r.excess === 1 && r.waitUntil === T + 130000);

r = decide({ ...base, barForeign: 3, attacks: 0, spies: 3, spiesInFlight: 0, spyMaxEta: 0, barCached: true });
check("21:34:33 cache paska + sondy wylądowały → nadwyżka ZOSTAJE, krótkie czekanie 20 s na żywy pasek", r.excess === 3 && r.waitUntil === T + 20000);

r = decide({ ...base, barForeign: 2, attacks: 1, spies: 1, spiesInFlight: 1, spyMaxEta: 40 });
check("ACS na liście + sonda w locie: pasek 2 = 1+1 → nadwyżka 0 (atak i tak z listy)", r.excess === 0);

r = decide({ ...base, barForeign: 3, attacks: 0, spies: 3, spiesInFlight: 3, spyMaxEta: 60, barCountsProbes: true });
check("barCountsProbes=true: wszystkie sondy odejmowane → 0", r.excess === 0);

r = decide({ ...base, barForeign: 1, attacks: 0, spies: 2, spiesInFlight: 0, spyMaxEta: 0, candidateAt: 0 });
check("brak kandydata → kotwica = now", r.waitUntil === T + 10000);

check("check() używa barExcessDecision z kandydatem i wpisuje excess=0 w czasie czekania",
  /const bx = barEff \? this\.barExcessDecision\(\{/.test(src) && /candidateAt: candAt/.test(src) && /excess: \(probeWaitUntil && Date\.now\(\) < probeWaitUntil\) \? 0 : barExcess/.test(src));
check("attackBodiesFor: klauzula „nadwyżka = oba ciała” tylko dla pary strzeżonej",
  /w\.armed && RescueQueue\.str\(w\.at\) === key\) \{ out\.add\("moon"\); out\.add\("planet"\); \}/.test(src));

console.log(failures ? `\n${failures} FAIL` : "\nWSZYSTKO OK");
process.exit(failures ? 1 : 0);
