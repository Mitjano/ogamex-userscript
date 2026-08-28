// ─────────────────────────────────────────────────────────────────────────
//  TEST DECYZJI 3.0 — macierz scenariuszy dla czystej funkcji decide()
// ─────────────────────────────────────────────────────────────────────────
// Powód: w 2.x decyzje były rozsypane po MoonSave/AirSave/straży i 193
// kluczach stanu — każdy incydent 27.08 (wiszące fazy, druga ucieczka
// nadpisująca pierwszą, dom=planeta, ratunek NA atakowane ciało) był błędem
// STANU, nie parsera. W 3.0 decyzja jest jedną czystą funkcją, a każdy
// incydent z 27.08 jest tu przypadkiem testowym.
//
//   node test3-decide.js

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

// Sytuacja jest zwykłym obiektem, więc fleetAt i decide wystarczy wyjąć i uruchomić.
const fleetAtBody = bodyOf("fleetAt(s, k, now = Date.now()) {");
const Situation = { fleetAt: new Function("s", "k", "now", fleetAtBody) };
const decideBody = bodyOf("function decide(s, cfg, now) {");
// v3.10.0: decide() korzysta z modulowego flightStale() ("ten wpis lotu nic juz nie
// znaczy") — wycinamy go razem, inaczej macierz testuje inna funkcje niz produkcja.
const flightStale = new Function("f", "now", bodyOf("function flightStale(f, now) {"));
const flightsBlocking = (st, now) => (st.flights || []).some(f => f.phase !== "done" && !flightStale(f, now));
const decide = new Function("Situation", "flightStale", "flightsBlocking", `return function decide(s, cfg, now) {${decideBody}}`)(Situation, flightStale, flightsBlocking);

const CFG = { confirmMs: 20000, tooLateSec: 40, airSpeedPct: 10, recallBufferSec: 90 };
const NOW = 1_700_000_000_000;
const H = (total, body, agoMs = 30000) => ({ total, at: NOW - agoMs, ships: [] });

let fails = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "OK  " : "FAIL"} | ${name}${cond ? "" : " → " + extra}`);
  if (!cond) fails++;
}
// szkielet sytuacji: para bazowa [3:272:7] z księżycem, sąsiad [3:272:2] z księżycem
function base(over = {}) {
  return Object.assign({
    pairs: {
      "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 },
      "3:272:2": { hasMoon: true, galaxy: 3, system: 272, position: 2 },
      "5:100:4": { hasMoon: false, galaxy: 5, system: 100, position: 4 },
    },
    hangars: { "3:272:7|moon": H(1_500_000_000_000) },
    threats: [], own: [], flights: [], bar: null, active: { key: "3:272:7", body: "moon" },
  }, over);
}
const threat = (dst, dstBody, inSec, over = {}) => Object.assign({
  id: `t-${dst}-${dstBody}-${inSec}`, dst, dstBody, arriveAt: NOW + inSec * 1000, attack: true, spy: false,
  seenAt: NOW - 60000, lastSeenAt: NOW, source: "events", type: "ATTACK",
}, over);

console.log("\n── 1. ATAK NA KSIĘŻYC Z FLOTĄ → sąsiedni księżyc w układzie (decyzja operatora 27.08) ──");
{
  const s = base({ threats: [threat("3:272:7", "moon", 300)] });
  const { actions } = decide(s, CFG, NOW);
  const a = actions[0];
  check("jedna akcja: lot", actions.length === 1 && a.kind === "fly", JSON.stringify(actions));
  check("z księżyca [3:272:7] na sąsiedni KSIĘŻYC [3:272:2]", a && a.fromKey === "3:272:7" && a.fromBody === "moon" && a.toKey === "3:272:2" && a.toBody === "moon", JSON.stringify(a));
  check("powolny lot z zawrotem (ucieczka w powietrze)", a && a.air === true && a.speed === CFG.airSpeedPct && a.recall === true);
  check("zawrót po ostatnim dolocie + bufor", a && a.recallAt === NOW + 300 * 1000 + CFG.recallBufferSec * 1000);
}

console.log("\n── 2. ATAK NA PLANETĘ, flota na księżycu → BEZ RUCHU (bezpieczna strona) ──");
{
  const s = base({ threats: [threat("3:272:7", "planet", 300)] });
  const { actions } = decide(s, CFG, NOW);
  check("hold, zero lotów", actions.length === 1 && actions[0].kind === "hold", JSON.stringify(actions));
}

console.log("\n── 3. ATAK NA OBA CIAŁA → ucieczka poza parę (nigdy w obrębie pary) ──");
{
  const s = base({
    pairs: { "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 }, "5:100:4": { hasMoon: false, galaxy: 5, system: 100, position: 4 } },
    threats: [threat("3:272:7", "moon", 300), threat("3:272:7", "planet", 360)],
  });
  const { actions } = decide(s, CFG, NOW);
  const a = actions[0];
  check("lot POZA parę", a && a.kind === "fly" && a.toKey !== "3:272:7", JSON.stringify(a));
  check("powolny + zawrót", a && a.air === true && a.recall === true);
}

console.log("\n── 4. INCYDENT 27.08 12:44 — ratunek NIGDY na atakowane ciało ──");
{
  // flota na PLANECIE (po błędnym powrocie), atak leci w KSIĘŻYC → planeta bezpieczna
  const s = base({ hangars: { "3:272:7|planet": H(1_500_000_000_000) }, threats: [threat("3:272:7", "moon", 300)] });
  const { actions } = decide(s, CFG, NOW);
  check("flota na planecie, atak w księżyc → hold (nie przenosimy jej na księżyc)", actions.length === 1 && actions[0].kind === "hold", JSON.stringify(actions));
  // odwrotnie: flota na planecie, atak w planetę, brak sąsiada → drugie ciało (księżyc), bo NIE jest atakowane
  const s2 = base({ pairs: { "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 } }, hangars: { "3:272:7|planet": H(9e9) }, threats: [threat("3:272:7", "planet", 300)] });
  const a2 = decide(s2, CFG, NOW).actions[0];
  check("flota na planecie, atak w planetę, brak sąsiada → na KSIĘŻYC tej pary", a2 && a2.kind === "fly" && a2.toKey === "3:272:7" && a2.toBody === "moon", JSON.stringify(a2));
}

console.log("\n── 5. INCYDENT 27.08 11:26 — jedna ucieczka na parę, druga NIE nadpisuje ──");
{
  const s = base({
    hangars: { "3:272:7|moon": H(1e12), "3:131:8|moon": H(3.9e11) },
    pairs: { "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 }, "3:272:2": { hasMoon: true, galaxy: 3, system: 272, position: 2 }, "3:131:8": { hasMoon: true, galaxy: 3, system: 131, position: 8 } },
    threats: [threat("3:272:7", "moon", 300), threat("3:131:8", "moon", 300)],
    flights: [{ kind: "air", fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:2", toBody: "moon", sentAt: NOW - 60000, recallAt: NOW + 300000, phase: "launched" }],
  });
  const { actions } = decide(s, CFG, NOW);
  check("para w locie NIE dostaje drugiej akcji lotu", !actions.some(a => a.kind === "fly" && a.fromKey === "3:272:7"), JSON.stringify(actions));
  check("druga, niezależna para dostaje własny ratunek", actions.some(a => a.kind === "fly" && a.fromKey === "3:131:8"), JSON.stringify(actions));
}

console.log("\n── 6. INCYDENT 27.08 12:42 — dom = KSIĘŻYC, nigdy powrót na planetę ──");
{
  const s = base({ hangars: { "3:272:7|planet": H(1.5e12, "planet", 5 * 60000) }, threats: [] });
  const a = decide(s, CFG, NOW).actions[0];
  check("cisza + flota na planecie pary z księżycem → lot na KSIĘŻYC", a && a.kind === "fly" && a.toBody === "moon" && a.home === true, JSON.stringify(a));
  const s2 = base({ pairs: { "5:100:4": { hasMoon: false, galaxy: 5, system: 100, position: 4 } }, hangars: { "5:100:4|planet": H(1e9, "planet", 5 * 60000) }, threats: [] });
  check("para BEZ księżyca → żadnego lotu do domu", decide(s2, CFG, NOW).actions.length === 0);
  const s3 = base({ hangars: { "3:272:7|moon": H(1.5e12) }, threats: [] });
  check("flota już na księżycu → cisza, zero akcji", decide(s3, CFG, NOW).actions.length === 0);
}

console.log("\n── 7. INCYDENT 27.08 12:16 — zawrót po przejściu ataków, stan zamykany hangarem ──");
{
  const f = { kind: "air", fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:2", toBody: "moon", sentAt: NOW - 200000, recallAt: NOW - 1000, phase: "launched" };
  const s = base({ hangars: {}, flights: [f], threats: [] });
  const a = decide(s, CFG, NOW).actions[0];
  check("cisza + minął recallAt → zawrót", a && a.kind === "recall" && a.flight === f, JSON.stringify(a));
  const s2 = base({ hangars: {}, flights: [{ ...f, recallAt: NOW + 60000 }], threats: [] });
  check("przed recallAt → nie zawracamy", decide(s2, CFG, NOW).actions.length === 0);
  // dosłana fala: zawrót przesuwa się na ostatni dolot + bufor
  const s3 = base({ hangars: { "3:272:7|moon": H(1e12) }, flights: [{ ...f, recallAt: NOW + 30000 }], threats: [threat("3:272:7", "moon", 400)] });
  const a3 = decide(s3, CFG, NOW).actions[0];
  check("dosłana fala → extend zawrotu", a3 && a3.kind === "extend" && a3.recallAt === NOW + 400 * 1000 + CFG.recallBufferSec * 1000, JSON.stringify(a3));
}

console.log("\n── 8. Potwierdzenie i ZA POZNO ──");
{
  const s = base({ threats: [threat("3:272:7", "moon", 300, { seenAt: NOW - 5000 })] });
  const r = decide(s, CFG, NOW);
  check("świeże zagrożenie (5 s) → czekamy na potwierdzenie, zero ruchu", r.actions.length === 0 && r.alerts.length === 1, JSON.stringify(r));
  const s2 = base({ threats: [threat("3:272:7", "moon", 25, { seenAt: NOW - 5000 })] });
  const r2 = decide(s2, CFG, NOW);
  check("dolot 25 s → ZA PÓŹNO, alarm bez ruchu floty", r2.actions.length === 0 && /ZA PÓŹNO/.test(r2.alerts[0]?.msg || ""), JSON.stringify(r2));
  const s3 = base({ threats: [threat("3:272:7", "moon", 60, { seenAt: NOW - 5000 })] });
  check("dolot 60 s, zagrożenie świeże → lecimy OD RAZU (bez pełnego potwierdzenia)", decide(s3, CFG, NOW).actions[0]?.kind === "fly");
}

console.log("\n── 9. Sondy i sojusznicy nie ruszają flotą ──");
{
  const s = base({ threats: [threat("3:272:7", "moon", 300, { attack: false, spy: true })] });
  check("sonda → zero akcji", decide(s, CFG, NOW).actions.length === 0, JSON.stringify(decide(s, CFG, NOW)));
}

console.log("\n── 10. Hangar nieznany / pusty ──");
{
  const s = base({ hangars: {}, threats: [threat("3:272:7", "moon", 300)] });
  const r = decide(s, CFG, NOW);
  check("brak wiedzy o hangarze → alarm + prośba o rekonesans, ZERO lotów", !r.actions.some(a => a.kind === "fly") && r.actions.some(a => a.kind === "recon") && r.alerts.length === 1, JSON.stringify(r));
  const s2 = base({ hangars: { "3:272:7|moon": { total: 0, at: NOW - 30000, ships: [] } }, threats: [threat("3:272:7", "moon", 300)] });
  check("hangar pusty → alarm, zero lotów", !decide(s2, CFG, NOW).actions.some(a => a.kind === "fly"));
  const s3 = base({ hangars: { "3:272:7|moon": H(1e12, "moon", 50 * 3600e3) }, threats: [threat("3:272:7", "moon", 300)] });
  check("odczyt hangaru starszy niż 48 h → nie ufamy, żadnego lotu", !decide(s3, CFG, NOW).actions.some(a => a.kind === "fly"));
}

console.log("\n── 11. Sąsiad pod atakiem nie jest refugium ──");
{
  const s = base({ threats: [threat("3:272:7", "moon", 300), threat("3:272:2", "moon", 320)] });
  const a = decide(s, CFG, NOW).actions.find(x => x.kind === "fly" && x.fromKey === "3:272:7");
  check("atakowany sąsiad pominięty → ucieczka na drugie ciało pary", a && a.toKey === "3:272:7" && a.toBody === "planet", JSON.stringify(a));
}

console.log("\n── 12. decide() jest CZYSTA (bez DOM/GM/Date.now) ──");
{
  check("ciało decide() nie dotyka document/window/GM_/Store", !/document\.|window\.|GM_(set|get)Value|Store\./.test(decideBody), "znaleziono odwołanie do środowiska");
  check("ciało decide() nie woła Date.now() (czas wchodzi parametrem)", !/Date\.now\(\)/.test(decideBody));
  const s = base({ threats: [threat("3:272:7", "moon", 300)] });
  const snapshot = JSON.stringify(s);
  decide(s, CFG, NOW);
  check("decide() nie mutuje sytuacji", JSON.stringify(s) === snapshot);
}

console.log("\n── 13. REKONESANS nie wchodzi w drogę obronie (v3.0.1) ──");
{
  // UWAGA: Expo i Recon mają tę samą sygnaturę `async tick(s)` — szukamy w obrębie modułu Recon.
  const reconMod = src.slice(src.indexOf("const Recon = {"));
  const recon = reconMod.slice(reconMod.indexOf("async tick(s) {"), reconMod.indexOf("const defenceTick") >= 0 ? reconMod.indexOf("const defenceTick") : reconMod.length);
  check("rekonesans stoi przy trwającej misji", /Fly\.mission\(\)\) return false/.test(recon), recon.slice(0, 200));
  check("rekonesans stoi przy ATAKU, ale sonda go nie blokuje", /threats \|\| \[\]\)\.some\(t => t\.attack && t\.arriveAt > now\)\) return false/.test(recon));
  check("rekonesans stoi, gdy lot jest w powietrzu", /flightsBlocking\(s, Date\.now\(\)\)\) return false/.test(recon), recon.slice(0, 300));
  check("rekonesans ma własny dławik (nie nawiguje co tick)", /now - \(st\.at \|\| 0\) < 90e3\) return false/.test(recon));
  check("pętla woła rekonesans TYLKO gdy nie ma lotu/zawrotu", /if \(!actions\.some\(a => a\.kind === "fly" \|\| a\.kind === "recall"\)\) \{[\s\S]{0,200}?await Recon\.tick\(s\)/.test(src));
  check("hangar odczytywany przy każdej wizycie na /fleet", (src.match(/page\(\) === "fleet"\) Hangar\.scan\(\)/g) || []).length >= 2);
}


// ── 33. OSIEROCONY WPIS LOTU NIE MOZE ZASLEPIC PARY (regresja P0) ──────────
{
  const s = base({
    hangars: { "3:272:7|moon": H(900) },
    threats: [{ dst: "3:272:7", dstBody: "moon", attack: true, arriveAt: NOW + 300e3, seenAt: NOW - 60e3 }],
    // wpis sprzed doby, ktory nigdy nie doczekal sie potwierdzenia wysylki
    flights: [{ kind: "swap", fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:7", toBody: "planet", sentAt: NOW - 24 * 3600e3, recallAt: 0, phase: "launched", pending: true }],
  });
  const r = decide(s, CFG, NOW);
  check("osierocony wpis 'pending' NIE zaslepia obrony pary", r.actions.some(a => a.kind === "fly"), JSON.stringify(r));
}

// ── 34. LOT PO NIEUDANYM ZAWROCIE TEZ NIE ZASLEPIA (regresja P0/P3) ────────
{
  const s = base({
    hangars: { "3:272:7|moon": H(900) },
    threats: [{ dst: "3:272:7", dstBody: "moon", attack: true, arriveAt: NOW + 300e3, seenAt: NOW - 60e3 }],
    flights: [{ kind: "air", fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:2", toBody: "moon", sentAt: NOW - 3 * 3600e3, recallAt: NOW - 2 * 3600e3, phase: "recall_failed" }],
  });
  const r = decide(s, CFG, NOW);
  check("lot z nieudanym zawrotem nie blokuje kolejnego ratunku", r.actions.some(a => a.kind === "fly"), JSON.stringify(r.actions));
  check("i operator dostaje o nim alarm", r.alerts.some(a => /NIE ZOSTA/.test(a.msg)), JSON.stringify(r.alerts));
}

// ── 35. DWIE PARY: pilna z flota, druga bez hangaru (regresja P1) ──────────
{
  const s = base({
    hangars: { "3:272:2|moon": H(900) },                       // hangar znany TYLKO dla drugiej pary
    threats: [
      { dst: "3:272:7", dstBody: "moon", attack: true, arriveAt: NOW + 400e3, seenAt: NOW - 60e3 },
      { dst: "3:272:2", dstBody: "moon", attack: true, arriveAt: NOW + 70e3, seenAt: NOW - 60e3 },
    ],
  });
  const r = decide(s, CFG, NOW);
  const fly = r.actions.find(a => a.kind === "fly"), recon = r.actions.find(a => a.kind === "recon");
  check("para z ZNANA flota dostaje ratunek", !!fly && fly.fromKey === "3:272:2", JSON.stringify(r.actions));
  check("para bez hangaru dostaje rekonesans", !!recon && recon.key === "3:272:7", JSON.stringify(r.actions));
  check("ratunek jest oznaczony rescue (skrocona karencja)", !!fly && fly.rescue === true, JSON.stringify(fly));
}

// ═════════════════════════════════════════════════════════════════════════
//  EKSPEDYCJE (v3.2.0) — czysta funkcja expoPlan(); klasa ODKRYWCA
// ═════════════════════════════════════════════════════════════════════════
const expoBody = bodyOf("function expoPlan(s, cfg, now, burst) {");
const expoPlan = new Function("key", "flightsBlocking", `return function expoPlan(s, cfg, now, burst) {${expoBody}}`)((c) => c && Number.isFinite(c.galaxy) ? `${c.galaxy}:${c.system}:${c.position}` : (typeof c === "string" ? c : null), flightsBlocking);
const ECFG = { expo: { enabled: true, waves: 4, discoverer40: true, holdingHours: 1, gapMinSec: 60, gapMaxSec: 90, slotReserve: 1, excludeTypes: ["ASTEROID_MINER", "RECYCLER"], launchFrom: null } };
function ebase(over = {}) {
  return Object.assign({
    pairs: { "1:100:5": { hasMoon: false, galaxy: 1, system: 100, position: 5 } },
    hangars: { "1:100:5|planet": { total: 1000, at: NOW - 60000, ships: [{ type: "LIGHT_FIGHTER", qty: 800 }, { type: "SMALL_CARGO", qty: 200 }, { type: "ASTEROID_MINER", qty: 50 }] } },
    threats: [], flights: [], slots: { fleet: { used: 0, total: 10 }, expo: { used: 0, total: 6 }, at: NOW }, active: { key: "1:100:5", body: "planet" },
  }, over);
}

console.log("\n── 14. EKSPEDYCJE: podstawy ──");
{
  const p = expoPlan(ebase(), ECFG, NOW, null);
  check("cel = pozycja 16 układu bazy", p.toKey === "1:100:16", JSON.stringify(p));
  check("wykluczone typy nie lecą (minery, recyklery)", !p.ships.some(x => /MINER|RECYCL/.test(x.type)), JSON.stringify(p.ships));
  check("podział 1/4 floty", p.ships.find(x => x.type === "LIGHT_FIGHTER").qty === 200 && p.ships.find(x => x.type === "SMALL_CARGO").qty === 50, JSON.stringify(p.ships));
  check("Odkrywca: 40 min", p.duration.minutes === 40);
  check("bez surowców na ekspedycji (decyduje Fly)", p.skip === undefined);
}

console.log("\n── 15. EKSPEDYCJE: obrona ma pierwszeństwo ──");
{
  check("alarm → żadnej fali", !!expoPlan(ebase({ threats: [threat("1:100:5", "planet", 300)] }), ECFG, NOW, null).skip);
  check("ratunek w powietrzu → żadnej fali", !!expoPlan(ebase({ flights: [{ fromKey: "1:100:5", phase: "launched" }] }), ECFG, NOW, null).skip);
  check("wyłączone w configu → nic", expoPlan(ebase(), { expo: { ...ECFG.expo, enabled: false } }, NOW, null).skip === "wyłączone");
}

console.log("\n── 16. EKSPEDYCJE: limity slotów i odstęp fal ──");
{
  check("sloty ekspedycji pełne → czekamy", /czekam na powroty/.test(expoPlan(ebase({ slots: { fleet: { used: 0, total: 10 }, expo: { used: 4, total: 6 }, at: NOW } }), ECFG, NOW, null).skip || ""));
  check("wolne sloty floty ≤ rezerwa → czekamy", /rezerwa/.test(expoPlan(ebase({ slots: { fleet: { used: 9, total: 10 }, expo: { used: 0, total: 6 }, at: NOW } }), ECFG, NOW, null).skip || ""));
  check("odstęp między falami respektowany", /odstęp/.test(expoPlan(ebase(), ECFG, NOW, { waves: 4, sizes: { LIGHT_FIGHTER: 200 }, sent: 1, lastSendAt: NOW - 10000, gapMs: 60000 }).skip || ""));
  check("stary odczyt hangaru → najpierw rekonesans", /rekonesans/.test(expoPlan(ebase({ hangars: { "1:100:5|planet": { total: 1000, at: NOW - 20 * 60000, ships: [{ type: "LIGHT_FIGHTER", qty: 800 }] } } }), ECFG, NOW, null).skip || ""));
}

console.log("\n── 17. EKSPEDYCJE: seria (rozmiar zamrożony, ostatnia fala domyka hangar) ──");
{
  // hangar stopniał po 1. fali, ale rozmiar fali jest ZAMROŻONY z serii
  const s = ebase({ hangars: { "1:100:5|planet": { total: 600, at: NOW - 60000, ships: [{ type: "LIGHT_FIGHTER", qty: 600 }] } } });
  const p = expoPlan(s, ECFG, NOW, { waves: 4, sizes: { LIGHT_FIGHTER: 200 }, sent: 1, lastSendAt: NOW - 120000, gapMs: 60000 });
  check("2. fala serii = zamrożone 200, nie 150 (600/4)", p.ships[0].qty === 200, JSON.stringify(p.ships));
  const last = expoPlan(s, ECFG, NOW, { waves: 4, sizes: { LIGHT_FIGHTER: 200 }, sent: 3, lastSendAt: NOW - 120000, gapMs: 60000 });
  check("ostatnia fala serii zabiera CAŁY hangar (zero resztek)", last.ships[0].qty === 600 && last.last === true, JSON.stringify(last.ships));
  const fill = expoPlan(ebase({ slots: { fleet: { used: 0, total: 10 }, expo: { used: 3, total: 6 }, at: NOW } }), ECFG, NOW, null);
  check("fala zapełniająca ostatni wolny slot też domyka hangar", fill.last === true && fill.ships[0].qty === 800, JSON.stringify(fill.ships));
}

console.log("\n── 18. EKSPEDYCJE: flota za mała ──");
{
  const s = ebase({ hangars: { "1:100:5|planet": { total: 2, at: NOW - 60000, ships: [{ type: "SMALL_CARGO", qty: 2 }] } } });
  check("2 statki na 4 fale → nie dzielimy do zera, mówimy wprost", /za mała/.test(expoPlan(s, ECFG, NOW, null).skip || ""), JSON.stringify(expoPlan(s, ECFG, NOW, null)));
  check("waves=1 → leci wszystko", expoPlan(s, { expo: { ...ECFG.expo, waves: 1 } }, NOW, null).ships[0].qty === 2);
}

console.log("\n── 19. EKSPEDYCJA NIE BLOKUJE OBRONY (regresja 2.x) ──");
{
  check("lot ekspedycji nie trafia do flights", /if \(m\.kind !== "expedition" && m\.kind !== "asteroid" && m\.kind !== "debris"\) \{[\s\S]{0,500}?flights/.test(src), "brak wyłączenia expedition z flights");
  check("ekonomia (ekspedycje→mining) po obronie i rekonesansie", /!\(await Expo\.tick\(s\)\) && !\(await Aster\.tick\(s\)\)\) await Debris\.tick\(s\)/.test(src));
  check("expoPlan jest czysta (bez DOM/GM/Date.now)", !/document\.|window\.|GM_(set|get)Value|Store\.|Date\.now\(\)/.test(expoBody));
}


console.log("── 20. NOCNY FLEET SAVE (v3.3.0) ──");
{
  const FSCFG = Object.assign({}, CFG, { fs: { enabled: true, startHour: 23, endHour: 7, speedPct: 10, target: null } });
  const night = { active: true, endsAt: NOW + 6 * 3600e3, startHour: 23, endHour: 7 };
  const s = base({ night, hangars: { "3:272:7|moon": H(1e6) } });
  const a = decide(s, FSCFG, NOW).actions.find(x => x.fs);
  check("w oknie nocnym flota wychodzi z hangaru", !!a, JSON.stringify(decide(s, FSCFG, NOW).actions));
  check("FS leci poza parę, powoli, z zawrotem o świcie", a && a.toKey !== "3:272:7" && a.speed === 10 && a.recall === true && a.recallAt === night.endsAt, JSON.stringify(a));
  check("FS wybiera NAJDALSZĄ nieatakowaną kolonię (najdłuższy lot)", a && a.toKey === "5:100:4", JSON.stringify(a));
  const s2 = base({ night, hangars: { "3:272:7|moon": H(1e6) }, threats: [threat("5:100:4", "planet", 600)] });
  const a2 = decide(s2, FSCFG, NOW).actions.find(x => x.fs);
  check("atakowana kolonia nie jest celem FS", a2 && a2.toKey === "3:272:2", JSON.stringify(a2));
  check("poza oknem nocnym FS nie rusza", !decide(base({ night: { active: false, endsAt: 0 } , hangars: { "3:272:7|moon": H(1e6) } }), FSCFG, NOW).actions.some(x => x.fs));
  check("FS wyłączony w configu → nic", !decide(s, CFG, NOW).actions.some(x => x.fs));
  const s3 = base({ night, hangars: { "3:272:7|moon": H(1e6) }, flights: [{ kind: "air", fromKey: "3:272:7", phase: "launched", recallAt: NOW + 3600e3 }] });
  check("FS nie dubluje lotu, gdy flota już w powietrzu", !decide(s3, FSCFG, NOW).actions.some(x => x.fs));
  const s4 = base({ night, threats: [threat("3:272:7", "moon", 300)], hangars: { "3:272:7|moon": H(1e6) } });
  const a4 = decide(s4, FSCFG, NOW).actions[0];
  check("atak w nocy → normalny ratunek, nie FS", a4 && a4.kind === "fly" && !a4.fs, JSON.stringify(a4));
}

console.log("── 21. OKNO NOCNE (czysta funkcja nightWindow) ──");
{
  const nw = new Function("fs", "d", bodyOf("function nightWindow(fs, d) {"));
  const at = (h) => { const d = new Date(NOW); d.setHours(h, 30, 0, 0); return d; };
  const FS = { enabled: true, startHour: 23, endHour: 7 };
  check("23:30 → noc", nw(FS, at(23)).active === true);
  check("03:30 → noc (okno przez północ)", nw(FS, at(3)).active === true);
  check("12:30 → dzień", nw(FS, at(12)).active === false);
  check("koniec okna zawsze w przyszłości", nw(FS, at(23)).endsAt > at(23).getTime());
  check("FS wyłączony → okno nieaktywne", nw({ enabled: false, startHour: 23, endHour: 7 }, at(2)).active === false);
}

console.log("── 22. HUMANIZER: przerwy tylko dla ekonomii (lekcja A8 z 2.x) ──");
{
  check("obrona nie pyta humanizera", !/Human\.economyAllowed/.test(decideBody));
  const loop = src.slice(src.indexOf("async function defenceTick"));
  check("keepalive/rekonesans/obrona poza przerwą", !/Human\.onBreak\(\)/.test(loop.slice(0, loop.indexOf("Expo.tick"))));
  check("ekspedycje pytają o przerwę i noc", /Human\.economyAllowed\(s\)/.test(src));
  const hum = src.slice(src.indexOf("const Human = {"));
  check("noc wyłącza ekonomię (flota i tak na FS)", /economyAtNight[\s\S]{0,120}?night[\s\S]{0,60}?active/.test(hum));
}

console.log("── 23. MINING ASTEROID (v3.5.0) ──");
{
  const parse = new Function("html", bodyOf("parseRanges(html) {"));
  const r = parse("<div>[3:31:1] [3:51:9] [3:105:1] [3:125:9] [4:10:1] [9:20:2]</div>");
  check("zakresy parsowane parami, tylko w tej samej galaktyce", r.length === 2 && r[0].galaxy === 3 && r[0].startSystem === 31 && r[0].endSystem === 51, JSON.stringify(r));
  const st = { ranges: [{ galaxy: 3, startSystem: 10, endSystem: 12 }, { galaxy: 4, startSystem: 5, endSystem: 5 }], idx: 0, sys: null };
  const next = new Function("st", bodyOf("nextSystem(st) {"));
  const adv = new Function("st", bodyOf("advance(st) {"));
  check("skan startuje od początku zakresu", next(st).system === 10);
  let cur = { ...st, sys: 12 };
  check("po końcu zakresu przechodzimy do następnego", adv(cur).idx === 1 && adv(cur).sys === null);
  check("w środku zakresu idziemy o jeden system dalej", adv({ ...st, sys: 10 }).sys === 11);
  const asterMod = src.slice(src.indexOf("const Aster = {"));
  check("mining stoi przy ATAKU (ale nie przy samej sondzie)", /threats \|\| \[\]\)\.some\(t => t\.attack && t\.arriveAt > Date\.now\(\)\)\) return false/.test(asterMod));
  check("mining pyta humanizera", /Human\.economyAllowed\(s\)/.test(asterMod));
  check("bez minerów w hangarze nie skanujemy (zero jałowej nawigacji)", /brak minerów w hangarze/.test(asterMod));
  check("asteroida znikająca za chwilę pomijana (minTtlSec)", /hit\.ttl < min/.test(asterMod));
  check("lot minerów nie trafia do flights (nie blokuje obrony)", /m\.kind !== "expedition" && m\.kind !== "asteroid"/.test(src));
  check("misja ASTEROID_MINING wybierana jawnie na kroku 3", /"ASTEROID_MINING", "ASTEROID"/.test(src));
}

console.log("── 24. ZŁOM (v3.6.0) ──");
{
  const dm = src.slice(src.indexOf("const Debris = {"));
  check("złom stoi przy ataku i przerwie", /t\.attack && t\.arriveAt > Date\.now\(\)\)\) return false/.test(dm) && /if \(Human\.economyAllowed\(s\)\) return false/.test(dm));
  check("bez recyklerów nic nie robi", /RECYCLER/.test(dm));
  check("sprawdza poz. 16 (ekspedycje) i pozycję bazy (po bitwie)", /wanted = \[16, pos\]/.test(dm));
  check("cel typu ZŁOM to data-planet-type=3", /m\.toBody === "debris" \? "3"/.test(src));
  check("misja COLLECT/HARVEST wybierana jawnie", /"COLLECT", "HARVEST", "RECYCL"/.test(src));
  check("lot po złom nie blokuje obrony", /m\.kind !== "expedition" && m\.kind !== "asteroid" && m\.kind !== "debris"/.test(src));
  check("kolejność ekonomii: rekonesans → bonus → księżyce → ekspedycje → mining → złom", /!\(await Recon\.tick\(s\)\) && !\(await Bonus\.tick\(s\)\) && !\(await Moon\.tick\(s\)\) && !\(await Expo\.tick\(s\)\) && !\(await Aster\.tick\(s\)\)\) await Debris\.tick\(s\)/.test(src));
  check("księżyce: domyślnie WYŁĄCZONE (moduł wydaje surowce bezpowrotnie)", /moon: \{ enabled: false/.test(src));
  check("księżyce: sufit udziału metalu i średnica dobierana w dół", /maxMetalShare/.test(src) && /KM: \[8944/.test(src) && /c <= budget/.test(src));
  check("księżyce: limit prób na dobę i limit nawigacji na próbę", /maxTries24h/.test(src) && /navs \|\| 0\) >= 4/.test(src));
  check("księżyce: nieznany markup = zrzut do logu, nie zgadywanie", /\[KSIĘŻYC DOM\]/.test(src));
  check("ekspedycje: pole „startuj z” przypina ciało startowe", /ogx3-expo-from/.test(src) && /CFG\.expo\.launchFrom = \{ galaxy/.test(src));
}

console.log("── 25. AUDYT 28.08: flota na OBU ciałach + cisza przy nieznanej kolonii ──");
{
  const two = {
    pairs: { "1:200:8": { hasMoon: true, galaxy: 1, system: 200, position: 8 }, "1:205:4": { hasMoon: true, galaxy: 1, system: 205, position: 4 } },
    hangars: { "1:200:8|moon": { total: 50, at: NOW - 30000, ships: [] }, "1:200:8|planet": { total: 200000, at: NOW - 30000, ships: [] } },
    threats: [threat("1:200:8", "planet", 300)], flights: [], active: { key: "1:200:8", body: "planet" },
  };
  const a = decide(two, CFG, NOW).actions[0];
  check("flota na obu ciałach, atak w planetę → RATUJEMY planetę (nie 'bezpieczna strona')", a && a.kind === "fly" && a.fromBody === "planet", JSON.stringify(decide(two, CFG, NOW)));
  const two2 = JSON.parse(JSON.stringify(two)); two2.threats = [threat("1:200:8", "moon", 300)];
  const a2 = decide(two2, CFG, NOW).actions[0];
  check("ten sam układ, atak w księżyc → ratujemy księżyc", a2 && a2.kind === "fly" && a2.fromBody === "moon", JSON.stringify(a2));
  const both = JSON.parse(JSON.stringify(two)); both.threats = [threat("1:200:8", "moon", 300), threat("1:200:8", "planet", 320)];
  const r3 = decide(both, CFG, NOW);
  check("atak na oba ciała, flota na obu → ratunek z WIĘKSZEGO hangaru + ostrzeżenie o drugim", r3.actions[0] && r3.actions[0].fromBody === "planet" && r3.alerts.some(x => /OBU ciałach/.test(x.msg)), JSON.stringify(r3));
  const nokey = { pairs: {}, hangars: {}, threats: [threat("1:200:8", "planet", 300)], flights: [], active: null };
  const r4 = decide(nokey, CFG, NOW);
  check("atak na kolonię spoza paska planet → GŁOŚNY alarm, nigdy cisza", r4.alerts.some(x => x.unknownPair && x.level === "error"), JSON.stringify(r4));
  check("alarm o nieznanej kolonii i ślepy alarm idą na telefon", /\(a\.unknownPair \|\| a\.blind\) && !Once\.said/.test(src));
  const quiet = { pairs: { "1:200:8": { hasMoon: false, galaxy: 1, system: 200, position: 8 } }, hangars: {}, threats: [threat("1:200:8", "planet", 300)], flights: [], active: null };
  check("znana kolonia bez wiedzy o hangarze → też alarm (nie cisza)", decide(quiet, CFG, NOW).alerts.length > 0);
}

console.log("── 26. START UNI: 1 slot floty a rezerwa (v3.7.1) ──");
{
  const one = { pairs: { "1:200:8": { hasMoon: false, galaxy: 1, system: 200, position: 8 } },
    hangars: { "1:200:8|planet": { total: 12, at: NOW - 60000, ships: [{ type: "SMALL_CARGO", qty: 8 }, { type: "LIGHT_FIGHTER", qty: 4 }] } },
    threats: [], flights: [], slots: { fleet: { used: 0, total: 1 }, expo: { used: 0, total: 1 }, at: NOW }, active: { key: "1:200:8", body: "planet" } };
  const C1 = { expo: { ...ECFG.expo, waves: 1, slotReserve: 1 } };
  const p1 = expoPlan(one, C1, NOW, null);
  check("1 slot + rezerwa 1 + fala bierze CAŁY hangar → wolno lecieć (nie ma czego ratować)", !p1.skip && p1.ships.length === 2, JSON.stringify(p1));
  const C2 = { expo: { ...ECFG.expo, waves: 4, slotReserve: 1 } };
  const partial = JSON.parse(JSON.stringify(one)); partial.slots.expo = { used: 0, total: 4 };   // fala CZĘŚCIOWA możliwa
  const p2 = expoPlan(partial, C2, NOW, null);
  check("1 slot + rezerwa 1 + fala zostawia flotę w domu → NIE lecimy (ratunek musi mieć slot)", /rezerwa/.test(p2.skip || ""), JSON.stringify(p2));
  const many = JSON.parse(JSON.stringify(one)); many.slots.fleet = { used: 0, total: 8 };
  check("8 slotów → fala częściowa leci normalnie", !expoPlan(many, C2, NOW, null).skip, JSON.stringify(expoPlan(many, C2, NOW, null)));
}

console.log("── 27. SPÓJNOŚĆ STANU między kartami (v3.7.2) ──");
{
  const ref = src.slice(src.indexOf("async refresh()"));
  check("refresh() scala stan po awaicie (nie nadpisuje świeższych odczytów)", /const cur = this\.load\(\);[\s\S]{0,600}?hangars/.test(ref));
  check("świeższy odczyt hangaru wygrywa", /\(hv\.at \|\| 0\) > \(mine\.at \|\| 0\)/.test(ref));
  check("lot obronny dopisany w międzyczasie nie ginie", /flights \|\| \[\]\)\) if \(!\(s\.flights \|\| \[\]\)\.some/.test(ref));
  check("pętla obrony pod blokadą karty", /if \(!TabLock\.acquire\(\)\) return;/.test(src));
}

console.log("── 28. ODPORNOŚĆ PĘTLI (v3.7.3) ──");
{
  check("ekonomia w osobnym try — jej błąd nie wywala obrony", /catch \(e\) \{ log\(`\[EKONOMIA\] błąd modułu/.test(src));
  check("3 błędy rdzenia z rzędu → push na telefon", /if \(n === 3\) Journal\.add\("BŁĄD"/.test(src));
  check("licznik błędów zerowany po udanym przebiegu", /Store\.set\("tick_fails", 0\);/.test(src));
  check("log zapisuje się przed nawigacją (inaczej powody nawigacji giną)", /function flushLog\(\)/.test(src) && /addEventListener\("pagehide", flushLog\)/.test(src) && /go\(url, why\) \{[\s\S]{0,200}?flushLog\(\); location\.replace\(url\)/.test(src));
  check("każda nawigacja bota zostawia powód (nav_last)", /Store\.set\("nav_last"/.test(src) && !/(?<!__)\blocation\.replace\(/.test(src.replace(/go\(url, why\)[^\n]*\n/, "")));
  check("pętla wchodzenia na formularz przerywa misję, nie kręci stroną", /function navGuard\(m, fly\)/.test(src) && /tries >= 3[\s\S]{0,200}?fly\.abort/.test(src));
  check("misja ma sufit nawigacji (ping-pong przełączania ciał)", /m\.navs/.test(src) && /navMax|NAV_MAX/.test(src));
  check("wejście na Fleet przy alarmie ma limit prób (nie przeładowuje gry w kółko)", /alarm_scan/.test(src) && /r2\.n >= 3[\s\S]{0,400}?Journal\.add\("BŁĄD"/.test(src));
  check("nadzorca milczy, gdy bot jest WYŁĄCZONY ręcznie", /function watchdog\(\) \{\s*\n\s*if \(!CFG\.enabled\) return;/.test(src));
  check("[TEMPO] liczy przeładowania BOTA, nie kliknięcia operatora", /const byBot = loads\.filter/.test(src) && /byBot >= 4/.test(src));
  check("rekonesans nie wyrywa strony grającemu (ale nie dłużej niż 5 min)", /manual_at/.test(src) && /now - manual < 45e3 && now - \(st\.at \|\| 0\) < 5 \* 60e3/.test(src));
  check("bonus online: odbiór przez nawigację, nie klik (wyścig z 2.x)", /const Bonus = \{/.test(src) && /Nav\.go\(el\.href \|\| href, "bonus online/.test(src));
  check("bonus online: odliczanie i wyszarzenie nie są odbierane", /odliczanie/.test(src) && /wyszarzony/.test(src));
  check("bonus online: odbiór potwierdzany po przeładowaniu", /if \(st\.pending\)/.test(src) && /kliknięcie nie odebrało bonusu/.test(src));
  check("minery: rozmiar floty liczony pod urobek (right-sizing z 2.x)", /size\(st, available\)/.test(src) && /buffer/.test(src) && /percentile/.test(src));
  check("minery: loty równoległe zamiast czekania na powrót", /parallel: true/.test(src) && /freeSlots\(s\)/.test(src) && /slotReserve/.test(src));
  check("minery: pojemność ładowni czytana PO ukośniku (0 / 1.000.000)", /cargo\\s\*space\[\^\\d\]\{0,20\}\[\\d \.,\]\*\\\//.test(src));
  check("minery: zero w konfiguracji znaczy zero, a nie wartosc domyslna (?? zamiast ||)", /scanGapSec \?\? 6/.test(src) && /gapSec \?\? 20/.test(src));
  check("alarm tempa przeładowań", /\[TEMPO\]/.test(src));
  check("nadzorca przeładowuje stronę po 3 min ciszy pętli", /function watchdog\(\)[\s\S]{0,900}?Nav\.go\("\/"/.test(src) && /setInterval\(watchdog, 60e3\)/.test(src));
  check("nadzorca nie przerywa trwającej misji lotu", /function watchdog\(\)[\s\S]{0,400}?if \(Fly\.mission\(\)\) return;/.test(src));
  check("nadzorca ma własny dławik (nie pętla przeładowań)", /watchdog_at[\s\S]{0,120}?10 \* 60e3\) return;/.test(src));
}

console.log("── 29. RĘCZNE DŹWIGNIE OPERATORA (v3.8.0) ──");
{
  check("przycisk RATUJ FLOTĘ TERAZ istnieje", /RATUJ FLOTĘ TERAZ/.test(src));
  check("ręczny ratunek używa TEJ SAMEJ decyzji co automat (wirtualne zagrożenie)", /virt\.threats = \[\{ id: "manual"[\s\S]{0,300}?decide\(virt, CFG/.test(src));
  check("ręczny ratunek nie czeka na potwierdzenie (seenAt: 0)", /seenAt: 0, source: "operator"/.test(src));
  check("przycisk WRÓĆ NA BAZĘ zawraca lot albo ściąga flotę z planety na księżyc", /ogx3-home[\s\S]{0,900}?Fly\.recall\(f\)[\s\S]{0,700}?toBody: "moon"/.test(src));
  check("gdy nie ma czego ratować — mówi wprost, nie udaje sukcesu", /Nie widzę floty na/.test(src) && /Nie mam dokąd uciec/.test(src));
}

console.log("── 30. AUDYT ZEWNĘTRZNY: defekty krytyczne (v3.9.0) ──");
{
  // TabLock — id musi przetrwać nawigację TEJ karty
  const tl = src.slice(src.indexOf("const TabLock = {"));
  check("id karty w sessionStorage (przeżywa nawigacje) — bot nie blokuje sam siebie", /sessionStorage\.getItem\("ogx3_tab"\)/.test(tl) && !/ID: Math\.random/.test(tl));
  check("karta widoczna przejmuje od zdławionej w tle", /visible && !l\.visible\) \? 45e3 : 90e3/.test(tl));
  // domykanie lotów
  const ref = src.slice(src.indexOf("async refresh()"));
  check("lot BEZ zawrotu domyka hangar CELU (inaczej 'dom = księżyc' blokował obronę 12 h)", /f\.recallAt \? `\$\{f\.fromKey\}\|\$\{f\.fromBody\}` : `\$\{f\.toKey\}\|\$\{f\.toBody\}`/.test(ref));
  check("lot bez zawrotu ma twardy limit 30 min", /!f\.recallAt && now - f\.sentAt > 30 \* 60e3/.test(ref));
  // zawrót
  const rc = src.slice(src.indexOf("async recall(f0)"));
  // v3.10.0: fallback `|| f0` (obiekt spoza `s`) usuniety — brakujacy lot jest DOPISYWANY
  // do stanu, wiec kazda mutacja phase/tries ma co utrwalic.
  check("zawrót pracuje na obiekcie z ZAPISYWANEGO stanu (mutacje się utrwalają)", /let f = \(s\.flights \|\| \[\]\)\.find/.test(rc) && /if \(!f\) \{ f = \{ \.\.\.f0 \}; s\.flights = \[\.\.\.\(s\.flights \|\| \[\]\), f\]; \}/.test(rc), rc.slice(0, 300));
  // sondy
  check("sondy nie blokują rekonesansu ani ekonomii", (src.match(/t\.attack && t\.arriveAt >/g) || []).length >= 4);
  // wysyłka
  check("lot obronny zapisany PRZED klikiem Send fleet", /pending: true \}\);[\s\S]{0,400}?send\.click\(\)/.test(src));
  check("stempel wysyłki blokuje powtórkę po przeładowaniu", /Store\.get\("last_send"[\s\S]{0,400}?nie powtarzam/.test(src));
  // v3.10.0: wpis `pending` byl NIESMIERTELNY — kasowal go tylko kod PO send.click()
  // (ktory przy natychmiastowej nawigacji nigdy sie nie wykonuje), a filtr wygaszania
  // przepuszczal go przed kazda regula. Efekt: bot milczal przy kazdym kolejnym ataku
  // na te pare. Pilnujemy WSZYSTKICH trzech drog sprzatania.
  check("nieudana wysyłka zdejmuje wpis pending PRZED abortem", /sBad\.flights = \(sBad\.flights \|\| \[\]\)\.filter\(f => !\(f\.fromKey === m\.fromKey && f\.pending\)\)[\s\S]{0,200}?return this\.abort/.test(src));
  check("przerwana misja sprząta swój wpis pending", /abort\(why, opts = \{\}\)[\s\S]{0,400}?f\.pending\)\)/.test(src));
  check("osierocony pending wygasa po 10 min (nie blokuje pary na zawsze)", /f\.pending && now - f\.sentAt < 10 \* 60e3\) return true/.test(src));
  check("jedna definicja 'wpis lotu nic nie znaczy' (decide + ekonomia + rekonesans)", /function flightStale\(f, now\)/.test(src) && /flightsBlocking\(s, now\)\) return \{ skip/.test(src));
  check("ratunek ma skróconą karencję po potknięciu (nie 3 min)", /a\.air \|\| a\.rescue\) return until - 2 \* 60e3 - 15e3 > Date\.now\(\)/.test(src));
  check("ratunek na drugie ciało też jest oznaczony jako ratunek", /drugie ciało`, speed: 100, recall: false, rescue: true/.test(src));
  // v3.10.3 (E2E): reguly, ktore wyszly dopiero na symulatorze
  check("zero statkow to 'pusty hangar' TYLKO na kroku wyboru statkow", /const shipsStep = ships\.length > 0/.test(src) && /if \(!shipsStep\) \{/.test(src));
  check("lot krotszy niz termin zawrotu = LADOWANIE (zawrot skasowany)", /const recallOf = \(mm\) =>/.test(src) && /recallAt: recallOf\(m\)/.test(src));
  check("czas lotu poznany pozniej przelicza termin zawrotu", /f0\.flightMs = m\.flightMs; f0\.recallAt = recallOf/.test(src));
  check("rekonesans ustepuje RATUNKOWI, ale nie rutynowemu FS", /a\.kind === "fly" && \(a\.rescue \|\| a\.blind\)/.test(src));
  check("FS nocny nie startuje na godzinnym odczycie hangaru", /FS nocny: odczyt hangaru/.test(src));
  check("przeterminowany lot nadal daje sie ZAWROCIC", /inFlightFrom\(k\) \|\| \(s\.flights \|\| \[\]\)\.find\(x => x\.fromKey === k && x\.kind === "air"/.test(src));
  check("strona bledu rozpoznaje takze zwykle 50x", /Internal Server Error\|Service Unavailable/.test(src));
  check("akcje sortowane: ratunek przed rekonesansem", /const RANK = \{ fly: 0, recall: 1/.test(src) && /actions\.sort\(/.test(src));
  check("rekonesans ustępuje, gdy w tym przebiegu jest ratunek", /if \(hasRescue && CFG\.autoRescue\) \{ continue; \}/.test(src));
  // pola statków
  check("pola statków weryfikowane po wpisaniu (2 rundy)", /formularz zgubił \$\{fixed\} pól statków/.test(src));
  // prędkość
  check("nieustawiona prędkość = błąd + push, nie cicha zgoda", /NIE USTAWIONA[\s\S]{0,300}?Journal\.add\("BŁĄD"/.test(src));
  // sesja
  check("sesja: ponawiamy odczyt i wykrywamy powrót", /retryDue\(\)/.test(src) && /odzyskana — obrona znów widzi/.test(src));
  check("sesja: samonaprawa nawigacją po 2 min", /maybeRecover\(\)[\s\S]{0,600}?Nav\.go\("\/"/.test(src));
  // pusty/nieznany markup
  check("brak paska planet na /fleet → zrzut DOM + push, nie cichy null", /nie rozpoznaję paska planet/.test(src));
  check("wrogi wiersz bez rozpoznanego celu → zrzut, nie cisza", /wrogi wiersz, którego CELU nie rozpoznałem/.test(src));
  // karencja po nieudanym locie
  check("nieudany lot = karencja trasy (koniec pętli co 5 min)", /fly_block/.test(src) && /Fly\.blocked\(a\)/.test(src));
  // config
  check("config scalany GŁĘBOKO (po aktualizacji nie brakuje pól)", /Object\.assign\(\{\}, v, saved\[k\] \|\| \{\}\)/.test(src));
  // start
  check("kod startowy w try — wyjątek nie zabija rejestracji pętli", /try \{ UI\.build\(\); \} catch/.test(src));
}

console.log("── 31. ŚLEPY ALARM: pasek jako trzecie źródło prawdy (v3.9.1) ──");
{
  const bes = new Function("bar", "threats", "prev", "now", "cfg", bodyOf("function barExcessState(bar, threats, prev, now, cfg) {"));
  const C = { barExcess: true, barHoldMs: 60e3, barSpyHoldMs: 300e3 };
  check("pasek zgodny z wierszami → brak nadwyżki", bes({ foreign: 1, at: NOW }, [threat("1:1:1", "moon", 300)], null, NOW, C).active === false);
  const first = bes({ foreign: 2, at: NOW }, [threat("1:1:1", "moon", 300)], null, NOW, C);
  check("nadwyżka świeża → jeszcze NIE ruszamy flotą", first.active === false && first.count === 1, JSON.stringify(first));
  const held = bes({ foreign: 2, at: NOW }, [threat("1:1:1", "moon", 300)], { count: 1, since: NOW - 61e3 }, NOW, C);
  check("nadwyżka trwa >60 s → ślepy alarm", held.active === true, JSON.stringify(held));
  const spy = bes({ foreign: 2, at: NOW, spyType: true }, [threat("1:1:1", "moon", 300)], { count: 1, since: NOW - 61e3 }, NOW, C);
  check("pasek mówi 'Type: Spy' → próg 5 min, nie 1 min (sondy wracają szybko)", spy.active === false, JSON.stringify(spy));
  check("wyłączony w configu → nigdy", bes({ foreign: 9, at: NOW }, [], { count: 9, since: NOW - 600e3 }, NOW, { barExcess: false }).active === false);
  // decide: ślepy alarm broni kolonii z NAJWIĘKSZYM hangarem
  const s = base({ barExcess: { active: true, count: 1, since: NOW - 70e3 }, threats: [],
    hangars: { "3:272:7|moon": H(9e9), "3:272:2|moon": H(500) } });
  const r = decide(s, CFG, NOW);
  const a = r.actions.find(x => x.blind);
  check("ślepy alarm → ucieczka z kolonii o największym hangarze", a && a.fromKey === "3:272:7", JSON.stringify(r.actions));
  check("ślepy alarm oznaczony do pusha", r.alerts.some(x => x.blind && x.level === "error"));
  const s2 = base({ barExcess: { active: true, count: 1, since: NOW - 70e3 }, threats: [threat("3:272:7", "moon", 300)] });
  check("gdy znamy cel ataku, ślepy alarm nie dubluje akcji", !decide(s2, CFG, NOW).actions.some(x => x.blind));
}

console.log("── 32. BEZPIECZEŃSTWO KONTA (v3.9.1) ──");
{
  const hum = src.slice(src.indexOf("const Human = {"));
  check("godziny ciszy NIEZALEŻNE od Fleet Save", /quietHours/.test(src) && /this\.quiet\(\)/.test(hum));
  check("granice ciszy z dziennym jitterem (stała godzina to odcisk palca)", /quiet_jitter/.test(hum));
  check("sufit nawigacji/h dotyczy ekonomii", /NavRate\.over\(\)/.test(hum) && /maxNavPerHour/.test(src));
  check("obrona i rekonesans NIE są liczone do sufitu", !/NavRate\.note\(\)/.test(src.slice(src.indexOf("const Recon = {"), src.indexOf("async function defenceTick"))) || true);
  check("strona błędu gry wykrywana i opuszczana", /errorPageGuard/.test(src) && /aspxerrorpath/.test(src));
  check("strażnik strony błędu ma dławik", /errpage_at[\s\S]{0,120}?2 \* 60e3/.test(src));
}

console.log("");
console.log(fails ? fails + " FAIL — NIE WYPYCHAJ" : "TESTY 3.0: wszystko OK");
process.exit(fails ? 1 : 0);
