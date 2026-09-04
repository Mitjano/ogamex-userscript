// ─────────────────────────────────────────────────────────────────────────
//  WAR-GAME 3.x — symulacja WSZYSTKICH wektorów ataku na decide()
// ─────────────────────────────────────────────────────────────────────────
// Powód (owner 31.08: „przeprowadź audyt, analizę i symulację wszystkich
// możliwych ataków — obrona floty jest najważniejsza"): test3-decide.js
// pilnuje incydentów historycznych, ten plik pilnuje KOMPLETNOŚCI — każdy
// wektor z modelu zagrożeń (AUDYT-ATAKI-2026-08-31.md) ma tu scenariusz
// na prawdziwej funkcji decyzyjnej. Nowy wektor = nowy przypadek TUTAJ.
//
//   node test3-wargame.js

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
const decide = new Function("Situation", "flightStale", "flightsBlocking", `return function decide(s, cfg, now) {${bodyOf("function decide(s, cfg, now) {")}}`)(Situation, flightStale, flightsBlocking);

const CFG = { confirmMs: 20000, tooLateSec: 40, airSpeedPct: 10, recallBufferSec: 90 };
const NOW = 1_700_000_000_000;
const H = (total, agoMs = 30000) => ({ total, at: NOW - agoMs, ships: [] });

let fails = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "OK  " : "FAIL"} | ${name}${cond ? "" : " → " + extra}`);
  if (!cond) fails++;
}
// Baza: para z księżycem [3:272:7], sąsiedni księżyc [3:272:2], daleka kolonia bez księżyca [5:100:4]
function base(over = {}) {
  return Object.assign({
    pairs: {
      "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 },
      "3:272:2": { hasMoon: true, galaxy: 3, system: 272, position: 2 },
      "5:100:4": { hasMoon: false, galaxy: 5, system: 100, position: 4 },
    },
    hangars: { "3:272:7|moon": H(1_500_000) },
    threats: [], own: [], flights: [], bar: null, active: { key: "3:272:7", body: "moon" },
  }, over);
}
const threat = (dst, dstBody, inSec, over = {}) => Object.assign({
  id: `w-${dst}-${dstBody}-${inSec}-${Math.random()}`, dst, dstBody, arriveAt: NOW + inSec * 1000, attack: true, spy: false,
  seenAt: NOW - 60000, lastSeenAt: NOW, source: "list", type: "ATTACK",
}, over);
const flyOf = (r) => r.actions.filter(a => a.kind === "fly");
const has = (r, kind) => r.actions.some(a => a.kind === kind);

console.log("\n════ WAR-GAME: wektory ataku na decide() ════");

console.log("\n── W1. Atak na księżyc z flotą → ucieczka na sąsiedni księżyc (air 10% + zawrót) ──");
{
  const r = decide(base({ threats: [threat("3:272:7", "moon", 300)] }), CFG, NOW);
  const a = flyOf(r)[0];
  check("W1: air na [3:272:2] moon, 10%, z zawrotem po dolocie+90 s", !!a && a.toKey === "3:272:2" && a.toBody === "moon" && a.air === true && a.recall === true && a.recallAt === NOW + 300e3 + 90e3, JSON.stringify(r.actions));
}

console.log("\n── W2. Brak sąsiedniego księżyca → drugie ciało pary (100%, bez zawrotu) ──");
{
  const s = base({ pairs: { "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 } }, threats: [threat("3:272:7", "moon", 300)] });
  const a = flyOf(decide(s, CFG, NOW))[0];
  check("W2: swap moon→planet tej samej pary, speed 100", !!a && a.toKey === "3:272:7" && a.toBody === "planet" && a.speed === 100 && !a.recall, JSON.stringify(a));
}

console.log("\n── W3. Atak na OBA ciała pary → powietrze do innej kolonii ──");
{
  const s = base({
    pairs: { "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 }, "5:100:4": { hasMoon: false, galaxy: 5, system: 100, position: 4 } },
    threats: [threat("3:272:7", "moon", 300), threat("3:272:7", "planet", 320)],
  });
  const a = flyOf(decide(s, CFG, NOW))[0];
  check("W3: air do [5:100:4] planet (refugium), zawrót po OSTATNIM dolocie", !!a && a.toKey === "5:100:4" && a.air === true && a.recallAt === NOW + 320e3 + 90e3, JSON.stringify(a));
}

console.log("\n── W4. WSZYSTKO atakowane → brak refugium = alarm, flota nie leci NA atakowane ciało ──");
{
  const s = base({
    pairs: { "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 }, "5:100:4": { hasMoon: false, galaxy: 5, system: 100, position: 4 } },
    threats: [threat("3:272:7", "moon", 300), threat("3:272:7", "planet", 300), threat("5:100:4", "planet", 300)],
  });
  const r = decide(s, CFG, NOW);
  check("W4: zero lotów (nic nie leci pod uderzenie)", flyOf(r).length === 0, JSON.stringify(r.actions));
  check("W4: alarm „brak refugium\"", r.alerts.some(a => /brak jakiegokolwiek refugium/.test(a.msg)), JSON.stringify(r.alerts.map(a => a.msg)));
}

console.log("\n── W5. Dolot 30 s (wykryty za późno) → ZA PÓŹNO, tylko alarm ──");
{
  const r = decide(base({ threats: [threat("3:272:7", "moon", 30)] }), CFG, NOW);
  check("W5: zero lotów + alarm ZA PÓŹNO", flyOf(r).length === 0 && r.alerts.some(a => /ZA PÓŹNO/.test(a.msg)), JSON.stringify(r.alerts.map(a => a.msg)));
}

console.log("\n── W6. Dolot 50 s, zagrożenie ŚWIEŻE → ratunek NATYCHMIAST (bez 20 s potwierdzania) ──");
{
  // potwierdzanie wolno pominąć, gdy czekanie zjadłoby okno na formularz
  const r = decide(base({ threats: [threat("3:272:7", "moon", 50, { seenAt: NOW })] }), CFG, NOW);
  check("W6: lot mimo świeżego zagrożenia (nie stać nas na 20 s zwłoki)", flyOf(r).length === 1, JSON.stringify(r.actions) + " " + JSON.stringify(r.alerts.map(a => a.msg)));
}

console.log("\n── W7. Dolot 300 s, zagrożenie świeże → 20 s potwierdzenia (artefakty paska nie ruszają floty) ──");
{
  const r = decide(base({ threats: [threat("3:272:7", "moon", 300, { seenAt: NOW })] }), CFG, NOW);
  check("W7: bez lotu, alarm „potwierdzam\"", flyOf(r).length === 0 && r.alerts.some(a => /potwierdzam/.test(a.msg)), JSON.stringify(r.alerts.map(a => a.msg)));
}

console.log("\n── W8. Atak na planetę, flota na księżycu (świeży odczyt) → bezpieczna strona, bez ruchu ──");
{
  const r = decide(base({ threats: [threat("3:272:7", "planet", 300)] }), CFG, NOW);
  check("W8: hold, zero lotów", flyOf(r).length === 0 && has(r, "hold"), JSON.stringify(r.actions));
}

console.log("\n── W9. Jak W8, ale odczyt hangaru sprzed 40 min → NIE WIEM + rekonesans ──");
{
  const r = decide(base({ hangars: { "3:272:7|moon": H(1_500_000, 40 * 60e3) }, threats: [threat("3:272:7", "planet", 300)] }), CFG, NOW);
  check("W9: recon zamiast ślepej wiary + czerwony alarm", has(r, "recon") && r.alerts.some(a => /NIE WIEM/.test(a.msg)), JSON.stringify(r.actions) + JSON.stringify(r.alerts.map(a => a.msg)));
}

console.log("\n── W10. Jak W8, ale fala z rejestru wylądowała na ATAKOWANEJ planecie po jej odczycie → rekonesans ──");
{
  const s = base({
    threats: [threat("3:272:7", "planet", 300)],
    expected: [{ kind: "expedition", fromKey: "3:272:7", fromBody: "planet", total: 2_000_000, sentAt: NOW - 40 * 60e3, flightMs: 900e3, holdMs: 30 * 60e3, returnAt: NOW - 2 * 60e3 }],
  });
  const r = decide(s, CFG, NOW);
  check("W10: recon planety (snajperka powrotów obstawiona)", r.actions.some(a => a.kind === "recon" && a.body === "planet") && !has(r, "hold"), JSON.stringify(r.actions));
}

console.log("\n── W11. Atak, hangar NIEZNANY → rekonesans gdy jest czas; sam alarm, gdy go brak ──");
{
  const rA = decide(base({ hangars: {}, threats: [threat("3:272:7", "moon", 300)] }), CFG, NOW);
  check("W11a: dolot 300 s → recon atakowanego ciała", rA.actions.some(a => a.kind === "recon" && a.body === "moon"), JSON.stringify(rA.actions));
  const rB = decide(base({ hangars: {}, threats: [threat("3:272:7", "moon", 60)] }), CFG, NOW);
  check("W11b: dolot 60 s → bez nawigacji, czerwony alarm", !has(rB, "recon") && rB.alerts.some(a => a.level === "error"), JSON.stringify(rB.actions));
}

console.log("\n── W12. Drugi atak w trakcie ratunku → dosłana fala przedłuża zawrót; bez drugiego lotu ──");
{
  const f = { kind: "air", fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:2", toBody: "moon", sentAt: NOW - 120e3, flightMs: 900e3, recallAt: NOW + 300e3, phase: "launched", tries: 0 };
  const s = base({ hangars: {}, flights: [f], threats: [threat("3:272:7", "moon", 200), threat("3:272:7", "moon", 400)] });
  const r = decide(s, CFG, NOW);
  const ext = r.actions.find(a => a.kind === "extend");
  check("W12: extend zawrotu na ostatni dolot+90 s", !!ext && ext.recallAt === NOW + 400e3 + 90e3, JSON.stringify(r.actions));
  check("W12: zero nowych lotów z tej pary", flyOf(r).length === 0, JSON.stringify(r.actions));
}

console.log("\n── W13. Ratunek w powietrzu + fala z rejestru ląduje PRZED uderzeniem → alarm z zegarem ──");
{
  const f = { kind: "air", fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:2", toBody: "moon", sentAt: NOW - 120e3, flightMs: 900e3, recallAt: NOW + 700e3, phase: "launched", tries: 0 };
  const s = base({
    hangars: { "3:272:7|moon": H(500) }, flights: [f], threats: [threat("3:272:7", "moon", 600)],
    expected: [{ kind: "expedition", fromKey: "3:272:7", fromBody: "moon", total: 1_500_000, sentAt: NOW - 30 * 60e3, flightMs: 900e3, holdMs: 30 * 60e3, returnAt: NOW + 200e3 }],
  });
  const r = decide(s, CFG, NOW);
  check("W13: alarm wymienia fale wpadające pod uderzenie", r.alerts.some(a => /ląduj/.test(a.msg) && /uderzeniem/.test(a.msg)), JSON.stringify(r.alerts.map(a => a.msg)));
}

console.log("\n── W14. Sama sonda → flota NIE drga (decyzja ownera 26.08) ──");
{
  const r = decide(base({ threats: [threat("3:272:7", "moon", 120, { attack: false, spy: true, type: "ESPIONAGE" })] }), CFG, NOW);
  check("W14: zero lotów przy sondzie", flyOf(r).length === 0, JSON.stringify(r.actions));
}

console.log("\n── W15. Sonda + atak razem → ratunek normalnie ──");
{
  const r = decide(base({ threats: [threat("3:272:7", "moon", 120, { attack: false, spy: true, type: "ESPIONAGE" }), threat("3:272:7", "moon", 300)] }), CFG, NOW);
  check("W15: atak przebija sondę, lot idzie", flyOf(r).length === 1, JSON.stringify(r.actions));
}

console.log("\n── W16. ŚLEPY ALARM (pasek widzi, lista nie — katastrofa 12.08 z Atheny) ──");
{
  const s = base({ barExcess: { active: true, count: 2, since: NOW - 120e3 } });
  const r = decide(s, CFG, NOW);
  const a = flyOf(r)[0];
  check("W16: flota ucieka z największego hangaru w powietrze (blind)", !!a && a.blind === true && a.air === true && a.fromKey === "3:272:7", JSON.stringify(r.actions));
  const s2 = base({ hangars: {}, barExcess: { active: true, count: 2, since: NOW - 120e3 } });
  const r2 = decide(s2, CFG, NOW);
  check("W16b: ślepy alarm bez znanego hangaru → uczciwy alarm, nie zgadywanie", flyOf(r2).length === 0 && r2.alerts.some(x => /nie wiem, gdzie stoi flota/.test(x.msg)), JSON.stringify(r2.alerts.map(x => x.msg)));
}

console.log("\n── W17. Atak na kolonię, której NIE MA na pasku planet → alarm (nigdy cisza) ──");
{
  const r = decide(base({ threats: [threat("9:99:9", "planet", 300)] }), CFG, NOW);
  check("W17: czerwony alarm unknownPair", r.alerts.some(a => a.unknownPair && /NIE MA na pasku planet/.test(a.msg)), JSON.stringify(r.alerts.map(a => a.msg)));
}

console.log("\n── W18. Odczyt hangaru starszy niż 48 h → traktowany jak NIEZNANY (recon, nie decyzje na skamielinach) ──");
{
  const r = decide(base({ hangars: { "3:272:7|moon": H(1_500_000, 49 * 3600e3) }, threats: [threat("3:272:7", "moon", 300)] }), CFG, NOW);
  check("W18: recon zamiast lotu na starych danych", has(r, "recon") && flyOf(r).length === 0, JSON.stringify(r.actions));
}

console.log("\n── W19. Wpis lotu po nieudanym zawrocie (recall_failed) NIE zaślepia pary → nowy atak = nowy ratunek ──");
{
  const f = { kind: "air", fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:2", toBody: "moon", sentAt: NOW - 3600e3, flightMs: 900e3, recallAt: NOW - 1800e3, phase: "recall_failed", tries: 5 };
  const r = decide(base({ flights: [f], threats: [threat("3:272:7", "moon", 300)] }), CFG, NOW);
  check("W19: flota z hangaru ratowana mimo wiszącego wpisu", flyOf(r).length === 1, JSON.stringify(r.actions));
  check("W19: osobny alarm o locie do ręcznego sprowadzenia", r.alerts.some(a => /NIE ZOSTAŁ ZAWRÓCONY|po terminie zawrotu/.test(a.msg)), JSON.stringify(r.alerts.map(a => a.msg)));
}

console.log("\n── W20. Dwa ataki na dwie RÓŻNE pary z flotami → dwa ratunki w jednym przebiegu ──");
{
  const s = base({
    hangars: { "3:272:7|moon": H(1_500_000), "5:100:4|planet": H(800_000) },
    threats: [threat("3:272:7", "moon", 300), threat("5:100:4", "planet", 320)],
  });
  const r = decide(s, CFG, NOW);
  check("W20: lot z każdej atakowanej pary", flyOf(r).length === 2 && new Set(flyOf(r).map(a => a.fromKey)).size === 2, JSON.stringify(r.actions));
}

console.log("\n── W21. Flota na OBU ciałach, atak w planetę → ratunek Z PLANETY (nie „bezpieczna strona\" po księżycu) ──");
{
  const s = base({
    hangars: { "3:272:7|moon": H(50), "3:272:7|planet": H(200_000) },
    threats: [threat("3:272:7", "planet", 300)],
  });
  const a = flyOf(decide(s, CFG, NOW))[0];
  check("W21: lot startuje z planety (ciała pod atakiem)", !!a && a.fromBody === "planet", JSON.stringify(a));
}

console.log("\n── W22. Atak przy WŁĄCZONYM Fleet Save → obrona wygrywa z FS (ratunek, nie lot FS) ──");
{
  // v3.68.1 (audyt przed merge): scenariusz karmił decide() polami, których od 3.68 już
  // nie ma (`startHour`/`endHour` zamiast `returnHour`, `night` — FS stracił okno), więc
  // gałąź FS nie mogła się w nim odpalić i strażnik był FAŁSZYWIE ZIELONY. Kolizja jest
  // teraz realna, bo FS startuje o KAŻDEJ porze — i musi być sprawdzona na parze CICHEJ,
  // bo atakowana para do gałęzi FS w ogóle nie wchodzi.
  const cfgFS = { ...CFG, fs: { enabled: true, returnHour: 7, returnMinute: 0, speedPct: 10, target: null }, aster: { enabled: false }, debris: { enabled: false } };
  const s = base({ threats: [threat("3:272:7", "moon", 300)], fsReturnAt: NOW + 6 * 3600e3 });
  const r = decide(s, cfgFS, NOW);
  const a = flyOf(r)[0];
  check("W22: lot z ATAKOWANEJ pary to ratunek, nie Fleet Save", !!a && a.rescue === true && !a.fs, JSON.stringify(r.actions));

  // druga, CICHA para z flotą: FS wolno wystawić, ale ratunek musi zostać w kolejce
  const s2 = base({
    threats: [threat("3:272:2", "moon", 300)],
    hangars: { "3:272:7|moon": { total: 1e6, at: NOW - 30e3, ships: [] }, "3:272:2|moon": { total: 5e6, at: NOW - 30e3, ships: [] } },
    fsReturnAt: NOW + 6 * 3600e3,
  });
  const r2 = decide(s2, cfgFS, NOW);
  const resc = flyOf(r2).find(x => x.rescue), fsAct = flyOf(r2).find(x => x.fs);
  check("W22b: przy ataku na jedną parę ratunek dla niej POWSTAJE, choć druga para chce na FS", !!resc && resc.fromKey === "3:272:2", JSON.stringify(r2.actions));
  check("W22c: Fleet Save cichej pary NIGDY nie celuje w ciało pod atakiem", !fsAct || fsAct.toKey !== "3:272:2", JSON.stringify(fsAct));
}

console.log("\n── W23. Napastnik zawrócił (pasek czysty ≥60 s) → wcześniejszy zawrót; nowy atak w tym stanie = nowy ratunek ──");
{
  const f = { kind: "air", fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:2", toBody: "moon", sentAt: NOW - 300e3, flightMs: 900e3, recallAt: NOW + 600e3, phase: "launched", tries: 0 };
  const r = decide(base({ hangars: {}, flights: [f], hostileClear: { since: NOW - 120e3 } }), CFG, NOW);
  check("W23: recall przed terminem", r.actions.some(a => a.kind === "recall" && /napastnik zawrócił/.test(a.why)), JSON.stringify(r.actions));
  // finta: w tym samym stanie pojawia się NOWY atak → zagrożenie działa normalnie
  const r2 = decide(base({ hostileClear: { since: NOW - 120e3 }, threats: [threat("3:272:7", "moon", 300)] }), CFG, NOW);
  check("W23b: finta nie rozbraja obrony — nowy atak = nowy ratunek", flyOf(r2).length === 1, JSON.stringify(r2.actions));
}

console.log("\n── W24. Atak na kolonię BEZ floty → bez paniki: rekonesans/alarm, cudza flota nie lata bez potrzeby ──");
{
  const s = base({ threats: [threat("5:100:4", "planet", 300)] });
  const r = decide(s, CFG, NOW);
  check("W24: zero lotów (flota na [3:272:7] zostaje w domu)", flyOf(r).length === 0, JSON.stringify(r.actions));
  check("W24: atakowana kolonia dostaje recon (może coś tam stoi)", r.actions.some(a => a.kind === "recon" && a.key === "5:100:4"), JSON.stringify(r.actions));
}

console.log("");
console.log(fails ? fails + " FAIL — NIE WYPYCHAJ" : "WAR-GAME: wszystkie wektory obstawione");
process.exit(fails ? 1 : 0);
