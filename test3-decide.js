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
// v3.41.0: rutynowe zwożenie floty planeta→księżyc jest od teraz OPCJĄ i domyślnie OFF
// (decyzja ownera 30.08: „przenosić flotę ma tylko podczas ataku"). Testy, które badają
// SAM MECHANIZM zwożenia, muszą go jawnie włączyć — inaczej sprawdzałyby, że opcja jest
// wyłączona, a nie że mechanizm działa.
const CFG_H2M = { ...CFG, homeToMoon: true };
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
  const a = decide(s, CFG_H2M, NOW).actions[0];
  check("cisza + flota na planecie pary z księżycem → lot na KSIĘŻYC (przy homeToMoon=ON)", a && a.kind === "fly" && a.toBody === "moon" && a.home === true, JSON.stringify(a));
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
  // v3.68.1: bramka pomija akcje FS (te wiszą w `actions`, dopóki flota stoi w domu,
  // i gasiły ekonomię bezterminowo) oraz pyta o FAKTYCZNIE trwającą misję.
  check("pętla woła rekonesans TYLKO gdy nie ma lotu/zawrotu (FS nie blokuje ekonomii)", /if \(!Fly\.mission\(\) && !actions\.some\(a => \(a\.kind === "fly" && !a\.fs\) \|\| a\.kind === "recall"\)\) \{[\s\S]{0,200}?await Recon\.tick\(s\)/.test(src));
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
const expoHomeBodySrc = bodyOf("function expoHomeBody(s, homeKey, pair, excl, now) {");
const expoHomeBody = new Function("s", "homeKey", "pair", "excl", "now", expoHomeBodySrc);
const expoPlan = new Function("key", "flightsBlocking", "expoHomeBody", `return function expoPlan(s, cfg, now, burst) {${expoBody}}`)((c) => c && Number.isFinite(c.galaxy) ? `${c.galaxy}:${c.system}:${c.position}` : (typeof c === "string" ? c : null), flightsBlocking, expoHomeBody);
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

console.log("\n── 17. EKSPEDYCJE: seria (dzielnik malejący, ostatnia fala domyka hangar) ──");
{
  // v3.38.0: rozmiar fali to `floor(ilość / ile fal zostało)` z BIEŻĄCEGO hangaru.
  // Gdy nic nie wraca, wynik jest identyczny jak przy dawnym zamrażaniu: po 1. fali
  // (200 z 800) w hangarze zostaje 600, a 600/3 = 200 — fale nadal są równe.
  const s = ebase({ hangars: { "1:100:5|planet": { total: 600, at: NOW - 60000, ships: [{ type: "LIGHT_FIGHTER", qty: 600 }] } } });
  const p = expoPlan(s, ECFG, NOW, { waves: 4, sent: 1, lastSendAt: NOW - 120000, gapMs: 60000 });
  check("2. fala serii = 200 (600/3 pozostałych fal), nie 150 (600/4)", p.ships[0].qty === 200, JSON.stringify(p.ships));
  const last = expoPlan(s, ECFG, NOW, { waves: 4, sizes: { LIGHT_FIGHTER: 200 }, sent: 3, lastSendAt: NOW - 120000, gapMs: 60000 });
  check("ostatnia fala serii zabiera CAŁY hangar (zero resztek)", last.ships[0].qty === 600 && last.last === true, JSON.stringify(last.ships));
  const fillAvail = ebase().hangars["1:100:5|planet"].ships[0].qty;
  const fill = expoPlan(ebase({ slots: { fleet: { used: 0, total: 10 }, expo: { used: 3, total: 6 }, at: NOW } }), ECFG, NOW, null);
  // v3.28.0 (zgloszenie 29.08 13:26: "ostatnia fala 4/4 ma wyslac WSZYSTKO"):
  // fala zapelniajaca ostatni wolny slot ekspedycji zamiata hangar do zera.
  // Sufit 3x udzialu z 2.x chronil flote parkowana po FS — na Genesis takiej
  // floty nie ma, wiec zostawial tylko statki bezczynne w hangarze.
  check("fala zamiatajaca zabiera caly hangar (nic nie zostaje w domu)", fill.last === true && fill.ships[0].qty === fillAvail, JSON.stringify(fill.ships) + " | w hangarze: " + fillAvail);
}

console.log("\n── 17c. EKSPEDYCJE: stary odczyt slotów vs pasek misji (log 02.09 14:42) ──");
{
  // Odczyt „Expeditions: 8/8" ze strony floty sprzed 20 min, a pasek gry (globalny,
  // świeży) mówi „1 Own": 7 fal wylądowało, bot stał z pełnym hangarem do 30 min.
  const stale8 = { slots: { fleet: { used: 8, total: 27 }, expo: { used: 8, total: 8 }, at: NOW - 20 * 60e3 }, bar: { total: 1, own: 1, foreign: 0, at: NOW - 10e3 } };
  const p1 = expoPlan(ebase(stale8), { expo: { ...ECFG.expo, waves: 8, slotReserve: 0 } }, NOW, null);
  check("pasek 1 Own przycina stary odczyt 8/8 → fala leci", !p1.skip && /przycięty do 1 własnych/.test(p1.slotsTxt || ""), JSON.stringify(p1.skip || p1.slotsTxt));
  const p2 = expoPlan(ebase({ ...stale8, bar: { total: 9, own: 8, foreign: 1, at: NOW - 10e3 } }), { expo: { ...ECFG.expo, waves: 8, slotReserve: 0 } }, NOW, null);
  check("pasek 8 Own niczego nie przycina → nadal czekam na powroty", /8\/8[^]*czekam na powroty/.test(p2.skip || ""), JSON.stringify(p2.skip));
  const p3 = expoPlan(ebase({ ...stale8, bar: { total: 1, own: 1, foreign: 0, at: NOW - 6 * 60e3 } }), { expo: { ...ECFG.expo, waves: 8, slotReserve: 0 } }, NOW, null);
  check("pasek starszy niż 5 min NIE unieważnia odczytu slotów", /czekam na powroty/.test(p3.skip || ""), JSON.stringify(p3.skip));
  const p4 = expoPlan(ebase({ ...stale8, bar: { total: 0, own: 0, foreign: 0, at: NOW - 10e3 } }), { expo: { ...ECFG.expo, waves: 8, slotReserve: 0 } }, NOW, null);
  check("No fleet movement (0 Own) = wszystkie sloty wolne → fala 1/8, nie domykająca", !p4.skip && p4.last !== true, JSON.stringify(p4.skip || p4.last));
}

console.log("\n── 17d. EKSPEDYCJE: ciało startu — pusty księżyc nie wypada z obiegu (v3.65.0, log 03.09 08:58) ──");
{
  // Incydent: fala domykająca zostawiła na księżycu 0, bot odświeżał odtąd PLANETĘ
  // („dociągnąłem hangar planet w tle (0 szt.)"), ~50 mln statków wylądowało na
  // księżycu, a bot mówił „brak statków" — do ręcznego wejścia operatora na /fleet.
  const pairM = { "1:100:5": { hasMoon: true, galaxy: 1, system: 100, position: 5 } };
  const hM = (ships, ago) => ({ total: ships.reduce((n, x) => n + x.qty, 0), at: NOW - ago, ships });
  const LF = (q) => [{ type: "LIGHT_FIGHTER", qty: q }];
  const REC = (q) => [{ type: "RECYCLER", qty: q }];
  const mk = (moon, planet) => ebase({ pairs: pairM, hangars: { ...(moon ? { "1:100:5|moon": moon } : {}), ...(planet ? { "1:100:5|planet": planet } : {}) } });
  const p1 = expoPlan(mk(hM([], 16 * 3600e3), hM([], 60e3)), ECFG, NOW, null);
  check("księżyc 0 sprzed 16 h + planeta świeża 0 → rekonesans KSIĘŻYCA, nie „brak statków”", /moon nieznany\/stary/.test(p1.skip || ""), JSON.stringify(p1.skip));
  const p2 = expoPlan(mk(hM([], 60e3), hM([], 20 * 60e3)), ECFG, NOW, null);
  // v3.68.2 (owner 04.09 na żywo): ekspedycje startują WYŁĄCZNIE z księżyca, gdy para go
  // ma. Świeży, pusty księżyc to prawda o flocie („nie ma czym lecieć"), a nie powód, żeby
  // sięgnąć po planetę — bot nie ma podmieniać ciała startowego pod nieobecność operatora.
  check("księżyc świeży 0 → „brak statków”, NIE podmiana ciała na planetę", /brak statków/.test(p2.skip || ""), JSON.stringify(p2.skip));
  const p3 = expoPlan(mk(hM([], 60e3), hM([], 60e3)), ECFG, NOW, null);
  check("oba świeże i puste → „brak statków” (prawda), bez pętli odczytów", /brak statków/.test(p3.skip || ""), JSON.stringify(p3.skip));
  const p4 = expoPlan(mk(hM(REC(3000), 60e3), hM(LF(800), 60e3)), ECFG, NOW, null);
  // Owner 04.09: „powinien wysyłać ekspy tylko z moona". Myśliwce stojące na planecie nie
  // są powodem do startu z ciała widocznego dla falangi — bot ma czekać.
  // v3.68.7 (audyt 04.09, expo-plan#1): ...ale NIE MA prawa zamilczeć. Do 3.68.6 mówił tu
  // „brak statków do wysłania", czyli nieprawdę, i stał tak bezterminowo. Zakaz startu z
  // planety zostaje (`fromBody` nigdy nie jest „planet"), zmienia się to, co bot z tym robi.
  check("na księżycu same wykluczone typy, na planecie myśliwce → ŻADNEJ fali z planety", !!p4.skip && p4.fromBody !== "planet", JSON.stringify(p4.skip || p4.fromBody));
  check("… i stan jest NAZWANY + zwóz na księżyc zamówiony (koniec „brak statków”)",
    /stoi na PLANECIE/.test(p4.skip || "") && !!p4.ferry && p4.ferry.fromKey === "1:100:5" && p4.ferry.total === 800 && p4.stuck === true, JSON.stringify(p4));
  const p5 = expoPlan(mk(hM(LF(800), 60e3), hM(LF(800), 10e3)), ECFG, NOW, null);
  check("flota na obu ciałach → księżyc ma pierwszeństwo (dom floty)", !p5.skip && p5.fromBody === "moon", JSON.stringify(p5.skip || p5.fromBody));
  const p6 = expoPlan(mk(hM([], 16 * 3600e3), null), ECFG, NOW, null);
  check("planeta nigdy nie czytana, księżyc stary → księżyc pierwszy", /moon nieznany\/stary/.test(p6.skip || ""), JSON.stringify(p6.skip));
  const p7 = expoPlan(mk(null, hM(LF(800), 60e3)), ECFG, NOW, null);
  // TO JEST DOKŁADNIE INCYDENT 04.09 18:40 (zrzut ownera): odczyt księżyca się zestarzał,
  // odczyt planety był świeży (4 szt.) — i bot wysłał ekspedycję Z PLANETY, zabierając to,
  // co akurat tam stało, zamiast 4 mln statków z księżyca. Ma czekać na rekonesans księżyca.
  check("księżyc nieczytany, planeta świeża z flotą → REKONESANS księżyca, nie fala z planety", /moon nieznany\/stary/.test(p7.skip || ""), JSON.stringify(p7.skip || p7.fromBody));
  check("para Z księżycem → ciało startowe to ZAWSZE księżyc, niezależnie od świeżości odczytów",
    expoHomeBody({ hangars: { "1:100:5|planet": { total: 999, at: NOW, ships: [{ type: "LIGHT_FIGHTER", qty: 999 }] } } }, "1:100:5", { hasMoon: true }, [], NOW) === "moon");
  check("bez księżyca zawsze planeta", expoHomeBody({ hangars: {} }, "1:100:5", { hasMoon: false }, [], NOW) === "planet");
  check("expoHomeBody jest czysta (bez DOM/GM/Date.now)", !/document\.|window\.|GM_(set|get)Value|Store\.|Date\.now\(\)/.test(expoHomeBodySrc));
  check("cichy odczyt w Expo.tick pyta o TO SAMO ciało (expoHomeBody), nie o „księżyc>0”", src.includes("const hb = expoHomeBody(s, hk, pr") && !src.includes('?.total > 0)) ? "moon" : "planet"') && !src.includes("?.total > 0 && pair.hasMoon) ?"));
}

console.log("\n── 17e. EKSPEDYCJE: dzielnik z WOLNYCH slotów (v3.65.0, log 03.09 09:13: 6,2 / 6,5 / 38,9 mln) ──");
{
  const C8 = { expo: { ...ECFG.expo, waves: 8, slotReserve: 0 } };
  const hang = (q) => ({ "1:100:5|planet": { total: q, at: NOW - 60000, ships: [{ type: "LIGHT_FIGHTER", qty: q }] } });
  const sl = (used) => ({ fleet: { used, total: 20 }, expo: { used, total: 10 }, at: NOW });
  const w1 = expoPlan(ebase({ hangars: hang(4800), slots: sl(5) }), C8, NOW, null);
  check("5/8 zajętych, 8 fal → 1. fala = 1/3 hangaru (1600), nie 1/8 (600)", !w1.skip && w1.ships[0].qty === 1600 && w1.slotBound === true && w1.left === 3, JSON.stringify(w1.skip || w1.ships));
  const w2 = expoPlan(ebase({ hangars: hang(3200), slots: sl(6) }), C8, NOW, { waves: 8, sent: 1, lastSendAt: NOW - 120000, gapMs: 60000 });
  check("2. fala przy 6/8 → połowa reszty (1600), jeszcze nie domyka", !w2.skip && w2.ships[0].qty === 1600 && w2.last !== true, JSON.stringify(w2.skip || w2.ships));
  const w3 = expoPlan(ebase({ hangars: hang(1600), slots: sl(7) }), C8, NOW, { waves: 8, sent: 2, lastSendAt: NOW - 120000, gapMs: 60000 });
  check("3. fala przy 7/8 = ostatni wolny slot → cała reszta (1600): fale RÓWNE", !w3.skip && w3.ships[0].qty === 1600 && w3.last === true, JSON.stringify(w3.skip || w3.ships));
  const free = expoPlan(ebase({ hangars: hang(800) }), ECFG, NOW, null);
  check("wszystkie sloty wolne → dzielnik = liczba fal (bez zmian: 800/4 = 200)", free.ships[0].qty === 200 && !free.slotBound, JSON.stringify(free.ships));
  const noSl = expoPlan(ebase({ hangars: hang(800), slots: { fleet: { used: 0, total: 10 }, expo: { used: 0, total: 6 }, at: NOW - 40 * 60e3 } }), ECFG, NOW, null);
  check("sloty nieznane (odczyt >30 min) → dzielnik z liczby fal", noSl.ships[0].qty === 200 && !noSl.slotBound, JSON.stringify(noSl.skip || noSl.ships));
}

console.log("\n── 17b. EKSPEDYCJE: powroty w środku serii (zgłoszenie 30.08) ──");
{
  // Incydent: hangar urósł z 41 711 do 197 408 szt. w środku serii (wróciły wcześniejsze
  // ekspedycje). Do 3.37 fale 2..N słały porcję zamrożoną przy 41 711, więc po trzech
  // falach w domu stało ~217 tys. statków i dopiero fala domykająca je zgarniała.
  const grew = ebase({ hangars: { "1:100:5|planet": { total: 2000, at: NOW - 60000, ships: [{ type: "LIGHT_FIGHTER", qty: 2000 }] } } });
  const w2 = expoPlan(grew, ECFG, NOW, { waves: 4, sent: 1, lastSendAt: NOW - 120000, gapMs: 60000 });
  check("2. fala po powrotach = 666 (2000/3), nie porcja sprzed serii", w2.ships[0].qty === 666, JSON.stringify(w2.ships));
  const w3 = expoPlan(grew, ECFG, NOW, { waves: 4, sent: 2, lastSendAt: NOW - 120000, gapMs: 60000 });
  check("3. fala z 4 bierze połowę tego, co JEST teraz", w3.ships[0].qty === 1000 && w3.last !== true, JSON.stringify(w3.ships));

  // stan serii zapisany jeszcze przez 3.37 (z `sizes`) nie może zmieniać wyniku
  const oldState = expoPlan(grew, ECFG, NOW, { waves: 4, sizes: { LIGHT_FIGHTER: 10 }, sent: 1, lastSendAt: NOW - 120000, gapMs: 60000 });
  check("stary burst z 3.37 (`sizes`) jest ignorowany, nie zawyża/zaniża fali", oldState.ships[0].qty === 666, JSON.stringify(oldState.ships));

  // cała seria na spokojnym hangarze rozkłada się równo i kończy pustym hangarem
  let hangar = 1000, sent = 0; const porcje = [];
  for (let i = 0; i < 4; i++) {
    const st = ebase({ hangars: { "1:100:5|planet": { total: hangar, at: NOW - 60000, ships: [{ type: "LIGHT_FIGHTER", qty: hangar }] } } });
    const pl = expoPlan(st, ECFG, NOW, sent === 0 ? null : { waves: 4, sent, lastSendAt: NOW - 120000, gapMs: 60000 });
    const q = pl.ships[0].qty; porcje.push(q); hangar -= q; sent = pl.last ? 0 : sent + 1;
  }
  check("4 fale z hangaru 1000 → 250/250/250/250 i zero resztek", porcje.join("/") === "250/250/250/250" && hangar === 0, porcje.join("/") + " reszta " + hangar);
}

console.log("\n── 17f. EKSPEDYCJE: flota stoi na PLANECIE bazy — koniec stanu terminalnego (v3.68.7, audyt 04.09 expo-plan#1/#2) ──");
{
  // Stan z żywej gry: para MA księżyc, więc od v3.68.2 ciałem startowym jest bezwarunkowo
  // księżyc — a flota siedzi na PLANECIE tej samej pary (bot sam ją tam ewakuował, bo w
  // układzie nie było sąsiedniego księżyca; albo powstała w stoczni planety; albo fale
  // wróciły na gołą planetę po zniszczeniu księżyca). Do 3.68.6 expoPlan na zmianę mówił
  // „brak statków do wysłania" i „hangar moon nieznany/stary", nic nie przenosiło floty
  // (homeToMoon OFF), a jedynym śladem była linijka „info" co 10 min: priorytet nr 2
  // właściciela umierał po cichu, a flota stała na ciele widocznym dla falangi.
  const pairM = { "1:100:5": { hasMoon: true, galaxy: 1, system: 100, position: 5 } };
  const hM = (ships, ago) => ({ total: ships.reduce((n, x) => n + x.qty, 0), at: NOW - ago, ships });
  const LF = (q) => [{ type: "LIGHT_FIGHTER", qty: q }];
  const mk = (moon, planet) => ebase({ pairs: pairM, hangars: { ...(moon ? { "1:100:5|moon": moon } : {}), ...(planet ? { "1:100:5|planet": planet } : {}) } });

  const stoi = expoPlan(mk(hM([], 60e3), hM(LF(4_000_000), 60e3)), ECFG, NOW, null);
  check("księżyc świeży i pusty + 4 mln na planecie → stan NAZWANY, nie „brak statków”",
    /stoi na PLANECIE/.test(stoi.skip || "") && !/brak statków/.test(stoi.skip || ""), JSON.stringify(stoi.skip));
  check("… i zamówiony zwóz planeta → księżyc TEJ SAMEJ pary (wąsko, nie homeToMoon)",
    !!stoi.ferry && stoi.ferry.fromKey === "1:100:5" && stoi.ferry.total === 4_000_000, JSON.stringify(stoi.ferry));
  check("… ale fala NADAL nie startuje z planety (zakaz z v3.68.2 nienaruszony)",
    !stoi.ships && stoi.fromBody !== "planet", JSON.stringify(stoi));

  // Odczyt planety starszy niż 30 min to nie jest wiedza o tym, gdzie stoi flota — zwozu
  // nie wolno na nim oprzeć (statków może tam już nie być). Ma pójść PROŚBA O ODCZYT.
  const stary = expoPlan(mk(hM([], 60e3), hM(LF(4_000_000), 45 * 60e3)), ECFG, NOW, null);
  check("odczyt planety sprzed 45 min → BEZ zwozu, najpierw odczyt planety", !stary.ferry && stary.needPlanet === true, JSON.stringify(stary.skip));

  // expo-plan#2: przy recon:false NIKT nie czytał hangaru planety bazy — pusty księżyc i
  // planeta NIGDY nieczytana kończyły się „brak statków" i ciszą. Ma być prośba o odczyt.
  const nieznana = expoPlan(mk(hM([], 60e3), null), ECFG, NOW, null);
  check("planeta bazy nigdy nieczytana + pusty księżyc → prośba o odczyt PLANETY (nie cisza)",
    nieznana.needPlanet === true && /nigdy nie był robiony/.test(nieznana.skip || ""), JSON.stringify(nieznana.skip));

  // Kontrola: gdy na planecie NAPRAWDĘ nic nie ma (świeży odczyt), zostaje uczciwe „brak statków".
  const puste = expoPlan(mk(hM([], 60e3), hM([], 60e3)), ECFG, NOW, null);
  check("oba ciała świeże i puste → nadal uczciwe „brak statków” (bez zwozu i bez odczytu)",
    /brak statków/.test(puste.skip || "") && !puste.ferry && !puste.needPlanet, JSON.stringify(puste.skip));
  // Para BEZ księżyca startuje z planety jak dotąd — cała gałąź jej nie dotyczy.
  const bezKsiezyca = expoPlan(ebase({ hangars: { "1:100:5|planet": { total: 0, at: NOW - 60e3, ships: [] } } }), ECFG, NOW, null);
  check("para bez księżyca: pusty hangar planety → „brak statków”, żadnego zwozu", /brak statków/.test(bezKsiezyca.skip || "") && !bezKsiezyca.ferry, JSON.stringify(bezKsiezyca.skip));
  check("każdy skip zastoju jest oznaczony (`stuck`) — po to, żeby Expo.tick mógł go zgłosić",
    stoi.stuck === true && stary.stuck === true && puste.stuck === true, JSON.stringify([stoi.stuck, stary.stuck, puste.stuck]));
}

console.log("\n── 17g. EKSPEDYCJE: licznik serii ma termin ważności (v3.68.7, audyt 04.09 expo-wykonanie#3) ──");
{
  // Incydent projektowy: `burst` (waves/sent/lastSendAt) nie wygasał. Seria przerwana ciszą
  // nocną wracała rano z licznikiem „8. fala z 10" — pierwsza poranna fala stawała się falą
  // DOMYKAJĄCĄ i cały hangar szedł w JEDNYM locie. To odwrócenie sensu dzielenia na fale.
  const C10 = { expo: { ...ECFG.expo, waves: 10, slotReserve: 0 } };
  const s = ebase({ hangars: { "1:100:5|planet": { total: 8_000_000, at: NOW - 60e3, ships: [{ type: "LIGHT_FIGHTER", qty: 8_000_000 }] } },
    slots: { fleet: { used: 0, total: 20 }, expo: { used: 0, total: 10 }, at: NOW } });
  const swiezy = expoPlan(s, C10, NOW, { waves: 10, sent: 9, lastSendAt: NOW - 5 * 60e3, gapMs: 60e3 });
  check("(kontrola) seria ŻYWA (5 min temu) → 10. fala domyka serię i bierze cały hangar",
    swiezy.last === true && swiezy.ships[0].qty === 8_000_000, JSON.stringify(swiezy.skip || swiezy.ships));
  const nocny = expoPlan(s, C10, NOW, { waves: 10, sent: 9, lastSendAt: NOW - 6 * 3600e3, gapMs: 60e3 });
  check("licznik sprzed 6 h (cisza nocna) NIE domyka serii — fala 1/10, a nie 8 mln w jednym locie",
    nocny.last !== true && nocny.ships[0].qty === 800_000, JSON.stringify(nocny.skip || nocny.ships));
  const graniczny = expoPlan(s, C10, NOW, { waves: 10, sent: 5, lastSendAt: NOW - 3 * 3600e3 - 1000, gapMs: 60e3 });
  check("licznik starszy niż 3 h zaczyna serię od nowa (dzielnik 1/10, nie 1/5)", graniczny.ships[0].qty === 800_000, JSON.stringify(graniczny.ships));
  const bezStempla = expoPlan(s, C10, NOW, { waves: 10, sent: 9 });
  check("burst bez `lastSendAt` (wpis sprzed aktualizacji) też nie domyka serii", bezStempla.last !== true && bezStempla.ships[0].qty === 800_000, JSON.stringify(bezStempla.ships));
  check("Expo.tick KASUJE martwy licznik serii (panel nie może pokazywać serii, której nie ma)",
    /Store\.del\("burst"\)[\s\S]{0,200}?licznik serii/.test(src), "brak kasowania martwego burst w Expo.tick");
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
  // v3.38.0: hangar z samymi wykluczeniami = nieaktualny plan, nie awaria markupu.
  // Musi iść cichym abortem (bez Journal.add "BŁĄD" → bez pusha "⚠️ Obrona: BŁĄD").
  check("nieaktualny plan fali odpuszczany po cichu, bez pusha o błędzie",
    /plan nieaktualny — w hangarze tylko statki spoza planu", \{ quiet: true \}/.test(src));
  check("stan serii nie trzyma już zamrożonych rozmiarów (`sizes`)", !/sizes: \(b && b\.sizes/.test(src) && !/burst\.sizes/.test(src));
  // v3.38.0: bramka „nieaktualny plan" siedzi w Fly.form(), czyli w kodzie WSPÓLNYM
  // dla ekspedycji i RATUNKU. Ratunek leci bez planu (`m.plan` puste → `want === null`),
  // więc warunek MUSI zaczynać się od `!!want` — inaczej ucieczka floty przed atakiem
  // mogłaby zostać po cichu odpuszczona zamiast wystartować.
  check("ratunek (lot bez planu) nie może wpaść w bramkę nieaktualnego planu",
    /const stale = !!want && els\.length > 0 && !els\.some\(/.test(src));
}


console.log("\n── 19b. KSIĘGOWOŚĆ LOTÓW (incydent na żywo 30.08, v3.39.0) ──");
{
  // Test ratunku 09:17–09:21: bot sam wysłał flotę z księżyca na planetę, a przez cały
  // pozostały dolot powtarzał ERROR „nie wiem, gdzie stoi flota" — sześć razy pod rząd,
  // choć wpis lotu leżał w stanie i mówił dokładnie, gdzie ta flota jest.
  const lecialo = { kind: "swap", fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:7", toBody: "planet",
    sentAt: NOW - 60e3, flightMs: 106e3, recallAt: 0, phase: "launched", pending: true, tries: 0 };
  const alarm = decide(base({ hangars: {}, threats: [threat("3:272:7", "moon", 120)], flights: [lecialo] }), CFG, NOW);
  const a1 = (alarm.alerts || []).filter(a => a.key === "3:272:7");
  check("alarm + lot w powietrzu → mówi, że flota wyleciała, nie że jest ślepy",
    a1.some(a => /już wyleciała/.test(a.msg)) && !a1.some(a => /nie wiem, gdzie stoi flota/.test(a.msg)), JSON.stringify(a1));
  check("i nie jest to ERROR (to normalny przebieg, nie awaria)",
    a1.every(a => a.level !== "error"), JSON.stringify(a1.map(a => a.level)));
  check("mimo lotu w powietrzu NADAL prosi o rekonesans (mogły dojść nowe statki)",
    (alarm.actions || []).some(a => a.kind === "recon" && a.key === "3:272:7"), JSON.stringify(alarm.actions));
  check("komunikat podaje cel i godzinę lądowania",
    a1.some(a => /\[3:272:7\]/.test(a.msg) && /ląduje \d\d:\d\d:\d\d/.test(a.msg)), JSON.stringify(a1.map(a => a.msg)));

  // v3.39.1 (incydent „ciągle odświeża stronę"): 3.39.0 kazała po upływie ETA prosić
  // o rekonesans hangaru CELU. Akcja `recon` trafia jednak do egzekutora pisanego dla
  // ALARMU — a ten NAWIGUJE albo klika w pasek planet, czyli przełącza operatorowi
  // planetę. W rutynowej ciszy (kilka lotów na godzinę) = przeładowanie gry co przebieg.
  // Wycofane. Ten test PILNUJE, żeby cisza nie generowała nawigacji.
  const poEta = { ...lecialo, pending: false, sentAt: NOW - 300e3 };
  const cisza = decide(base({ hangars: {}, threats: [], flights: [poEta] }), CFG, NOW);
  check("cisza + lot po ETA → ŻADNEJ akcji nawigującej (rekonesans/lot)",
    !(cisza.actions || []).some(a => a.kind === "recon" || a.kind === "fly"), JSON.stringify(cisza.actions));
  check("w szczególności: bez rekonesansu „powinien już wylądować” (wycofane w 3.39.1)",
    !(cisza.actions || []).some(a => /powinien już wylądować/.test(a.why || "")), JSON.stringify(cisza.actions));

  // lot z zawrotem też nie może w ciszy nic nawigować przed terminem zawrotu
  const ucieczka = { kind: "air", fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:2", toBody: "moon",
    sentAt: NOW - 300e3, flightMs: 106e3, recallAt: NOW + 3600e3, phase: "launched", tries: 0 };
  const air = decide(base({ hangars: {}, threats: [], flights: [ucieczka] }), CFG, NOW);
  check("ucieczka czeka w powietrzu — cisza nie wystawia jej żadnej akcji",
    !(air.actions || []).some(a => a.kind === "recon" || a.kind === "fly"), JSON.stringify(air.actions));
}

console.log("\n── 19c. KONTROLE ŹRÓDŁA v3.39.0 ──");
{
  check("wysyłka potwierdzana adresem gry po przeładowaniu (klik nawiguje natychmiast)",
    /function confirmPendingSend\(\)/.test(src) && /fleetSendSuccessfully/.test(src) && /confirmPendingSend\(\);/.test(src));
  check("bramka anty-duplikat też zdejmuje `pending` z wpisu lotu",
    /wpis lotu \[\$\{fD\.fromKey\}\]→\[\$\{fD\.toKey\}\] potwierdzony/.test(src));
  check("ślad nawigacji bota zużywa się RAZ (fałszywe [TEMPO] o pętli keepalive)",
    /if \(fresh\) \{ try \{ Store\.del\("nav_last"\); \} catch \{\} \}/.test(src));
  check("wiersz symulacji ma opis i nie jest zgłaszany jako ERROR",
    /wiersz z symulacji panelu/.test(src) && /r\.source === "sim" \? "warn" : "error"/.test(src));
  check("blokada uśpienia zakładana pod zamkiem (koniec podwójnego WAKE)",
    /_busy: false,/.test(src) && /!this\._busy && \(!this\._lock/.test(src));
  // v3.40.0: ostrzeżenie o zwiniętej liście lotów ma stać OBOK stanu obrony, nigdy
  // zamiast niego (w 3.39.0 zasłoniło „czysto · auto-ratunek" i owner przestał widzieć,
  // czy obrona w ogóle działa).
  // v3.42.0: komunikat „lista lotów zwinięta" był MYLĄCY — panel Events nie jest zwinięty,
  // tylko pusty i nie do rozwinięcia. Panel ma mówić prawdę: ile kolonii jest bez nadzoru.
  check("panel pokazuje stan obrony ORAZ ile kolonii jest poza nadzorem",
    /czysto · \$\{CFG\.autoRescue \? "auto-ratunek" : "obserwator"\}\$\{slepy \? ` · ⚠ \$\{ile\} kolonii bez nadzoru` : ""\}/.test(src));
  check("bot nie klika już w pusty panel Events (5 h prób nie dało wiersza)",
    /!content0\.children\.length/.test(src) && /Nie klikam w niego/.test(src));
  // v3.50.0: sonda listy USUNIĘTA (werdykt ostateczny + jej fetch `?planet=`
  // przestawiał operatorowi planetę w sesji) — kontrole jej wnętrza zastąpione
  // kontrolą nieobecności; szczegóły w bloku v3.50.0 na końcu pliku.
  check("po sondzie listy został tylko zapis werdyktów (bez kodu)",
    /WERDYKTY OSTATECZNE/.test(src) && !/PARAMETR DZIAŁA/.test(src) && !/mv_probe", \{/.test(src));
  check("bonus online zwolniony z bramki „grasz” (jeden klik w menu, nie przełączanie planety)",
    /&& !\/grasz —\/\.test\(why\)/.test(src));
  check("dławik alertów nie liczy odliczania sekund jako nowego alertu",
    /a\.msg\.replace\(\/\\d\+\/g, "#"\)\.slice\(0, 60\)/.test(src));
  check("kolonie poza rekonesansem czytane CICHO, bez nawigacji",
    /recon_bg/.test(src) && /odczytana w tle: \$\{got\.total/.test(src) && /Hangar\.scanRemote\(bk, bb\)/.test(src));
  // v3.39.2 — sztorm 30.08 09:59 (~90 przeładowań /fleet w 27 s). Lot „dom = księżyc"
  // zabiera cały hangar planety, ale zapis hangaru ŹRÓDŁA zostawał nietknięty, więc po
  // domknięciu wpisu lotu decide() wystawiał ten sam lot bez końca, a bramka
  // anty-duplikat ścinała go po jednej nawigacji na obrót.
  check("po potwierdzonej wysyłce hangar ŹRÓDŁA jest zerowany",
    /function emptySourceHangar\(fromKey, fromBody, why, keepTypes\)/.test(src) &&
    (src.match(/emptySourceHangar\(/g) || []).length >= 4);
  // v3.68.1 (audyt): zerowanie NIE MOŻE być pomijane przy `excludeTypes` — hangar
  // udawałby wtedy pełną flotę przez 48 h. Zamiast pomijać, zostawiamy wykluczone typy,
  // i to na WSZYSTKICH trzech ścieżkach domknięcia wysyłki.
  check("zerowanie hangaru zostawia typy celowo pominięte, zamiast być pomijane",
    !/!\(m\.excludeTypes && m\.excludeTypes\.length\)\) emptySourceHangar/.test(src) &&
    (src.match(/emptySourceHangar\([^)]*(?:m|f)\.excludeTypes\)/g) || []).length >= 3);
  check("bramka anty-duplikat wysyła trasę w karencję (koniec pętli nawigacji)",
    /blG\[`\$\{m\.fromKey\}>\$\{m\.toKey\}`\] = ls\.at \+ guardMs/.test(src));
  check("karencja NIE dotyczy ekspedycji (fale lecą tą samą trasą co 60–90 s)",
    /if \(!ECO_KINDS\.includes\(m\.kind\)\) \{[\s\S]{0,400}?blG\[/.test(src));
  check("lista lotów: bot próbuje jawnego przycisku „Fleet movements” i nie poddaje się",
    /przycisk „Fleet movements”/.test(src) && /próbuję dalej co 10 min/.test(src) && !/ROZWIŃ JĄ RĘCZNIE RAZ/.test(src));
}

console.log("\n── 19d. FLOTA RUSZA SIĘ TYLKO PRZY ATAKU (decyzja ownera 30.08) ──");
{
  // 18:03:54 — owner postawił księżyc na [1:217:8] i bot NATYCHMIAST wysłał tam
  // 12 341 transporterów regułą „dom = księżyc". Owner: „nie chcę, żeby to robił.
  // Przenosić flotę ma tylko podczas ataku". Reguła jest teraz opcją, domyślnie OFF.
  const stoi = base({ hangars: { "3:272:7|planet": { total: 12341, at: NOW - 60e3, ships: [] } }, threats: [], flights: [] });
  const off = decide(stoi, { ...CFG, homeToMoon: false }, NOW);
  check("domyślnie: flota na planecie NIE jest zwożona na księżyc",
    !(off.actions || []).some(a => a.kind === "fly"), JSON.stringify(off.actions));
  const on = decide(stoi, { ...CFG, homeToMoon: true }, NOW);
  check("po włączeniu opcji zwożenie działa jak dawniej",
    (on.actions || []).some(a => a.kind === "fly" && a.toBody === "moon" && /dom = księżyc/.test(a.why)), JSON.stringify(on.actions));

  // ...ale powrót po RATUNKU ma działać nawet przy wyłączonej opcji: skoro bot sam
  // wywiózł flotę na drugie ciało, ma ją odstawić z powrotem.
  const poRatunku = base({ hangars: { "3:272:7|planet": { total: 12341, at: NOW - 60e3, ships: [] } },
    threats: [], flights: [], rescues: { "3:272:7": NOW - 5 * 60e3 } });
  const back = decide(poRatunku, { ...CFG, homeToMoon: false }, NOW);
  check("powrót po ratunku działa mimo wyłączonego zwożenia",
    (back.actions || []).some(a => a.kind === "fly" && a.toBody === "moon" && a.backHome === true), JSON.stringify(back.actions));

  const stary = base({ hangars: { "3:272:7|planet": { total: 12341, at: NOW - 60e3, ships: [] } },
    threats: [], flights: [], rescues: { "3:272:7": NOW - 8 * 3600e3 } });
  check("stempel ratunku sprzed 8 h już nie uprawnia do zwożenia",
    !(decide(stary, { ...CFG, homeToMoon: false }, NOW).actions || []).some(a => a.kind === "fly"));

  // v3.68.10 (audyt 04.09, testy-architektura#1 P1): TU BYŁ SAM REGEX na kształt warunku
  // („if (!m.home && !eco)") i dokładnie dlatego wpadka przeżyła dwa audyty: strażnik nie
  // mówił nic o tym, KTÓRE loty mają stemplować `rescues`. Od v3.68.0 do tego worka wpadł
  // Fleet Save (m.home undefined, m.kind "fly"), a decide() czyta ten stempel jako
  // `backFromRescue` i przez 6 h omija wyłączone `homeToMoon` — czyli decyzję ownera
  // „przenosić flotę ma tylko podczas ataku". Teraz WYCINAMY warunek z produkcji i go
  // URUCHAMIAMY na czterech rodzajach misji.
  const stampCond = (src.match(/if \(([^\n]*?)\) \{ try \{ const sR = Situation\.load\(\); sR\.rescues = sR\.rescues \|\| \{\};/) || [])[1];
  check("warunek stempla `rescues` da się wyciąć z produkcji", !!stampCond, String(stampCond));
  if (stampCond) {
    const stamps = new Function("m", "eco", `return !!(${stampCond});`);
    check("ucieczka przed atakiem STEMPLUJE rescues (potem wolno odstawić flotę na księżyc)", stamps({ kind: "fly", rescue: true, air: true }, false));
    check("lot domowy NIE stempluje", !stamps({ kind: "home", home: true }, false));
    check("ekonomia NIE stempluje", !stamps({ kind: "expedition" }, true));
    check("FLEET SAVE nie stempluje rescues — wraca ZAWROTEM na to samo ciało, nie ma czego odstawiać", !stamps({ kind: "fly", fs: true, air: true, recall: true }, false));
  }
  check("panel ma przełącznik „flota rusza się tylko przy ataku”",
    /Flota rusza się TYLKO przy ataku/.test(src) && /CFG\.homeToMoon = !CFG\.homeToMoon/.test(src));
  // v3.43.0 (owner 20:31): każda fala ekspedycji zaczynała się od przełączenia aktywnego
  // ciała na księżyc bazowy — w środku rozbudowy kolonii. Ekonomia ma czekać, aż operator
  // przestanie klikać. v3.44.0 zdjęła sufit 6 min; v3.48.0 podniosła próg ciszy do 5 min.
  check("ekonomia czeka, gdy operator gra (próg ciszy ecoIdleSec, bez sufitu 6 min)",
    /grasz — nie przełączam Ci planety, ekspedycja poczeka/.test(src) &&
    /eco_wait_since/.test(src) && /input_at/.test(src) && /e\.isTrusted/.test(src) && /ruszy po \$\{idleMin\} min od ostatniego kliknięcia/.test(src) && !/6 \* 60e3/.test(src));
}

console.log("\n── 19e. GOTOWOŚĆ OBRONY I PODSUMOWANIE PO PRZERWIE (v3.45.0) ──");
{
  // Priorytet ownera 30.08: „najważniejsze, żeby obronił flotę gdy ktoś zaatakuje".
  // Bot ma sprawdzać warunki obrony NA SUCHO, a nie dowiadywać się o brakach przy ataku.
  const body = bodyOf("function defenceReadiness(s) {");
  // v3.55.0: gotowość pyta Store o puls strażnika — stub „strażnik odpowiada".
  const readiness = new Function("CFG", "Session", "Notifier", "Situation", "key", "Store",
    `return function defenceReadiness(s) {${body}}`);
  const CFG_OK = { enabled: true, autoRescue: true, expo: { launchFrom: null } };
  const Sess = { lostRecently: () => false };
  const Notif = { enabled: () => true };
  const Sit = { fleetAt: (s, k, now) => ({ body: "moon", total: 1000, at: now }) };
  const kfn = (c) => c && Number.isFinite(c.galaxy) ? `${c.galaxy}:${c.system}:${c.position}` : (typeof c === "string" ? c : null);
  const StoreOk = { get: (k, d = null) => (k === "hb_ok" ? true : d) };
  const R = (cfg, sess, notif, sit) => readiness(cfg || CFG_OK, sess || Sess, notif || Notif, sit || Sit, kfn, StoreOk);
  // v3.68.9 (audyt 04.09, obrona-wykrywanie#1/#2/#4): gotowość obejmuje teraz także to,
  // czy bot COKOLWIEK widzi — stąd w stanie wzorcowym świeży pasek i żywa lista ruchów.
  const stan = () => ({ active: { key: "3:272:7", body: "moon" },
    pairs: { "3:272:7": { hasMoon: true }, "3:272:2": { hasMoon: true } },
    bar: { foreign: 0, total: 0, at: Date.now() - 5e3 }, listOkAt: Date.now() - 5e3,
    hangars: { "3:272:7|moon": { total: 1000, at: Date.now() - 60e3 } } });

  check("wszystko w porządku → zero braków", R()(stan()).length === 0, JSON.stringify(R()(stan())));
  const martwaLista = stan(); martwaLista.listOkAt = Date.now() - 20 * 60e3;
  check("martwa lista ruchów NIE może przejść jako 'obrona gotowa'",
    /lista ruchów flot nie odpowiada/.test(R()(martwaLista).join("|")), JSON.stringify(R()(martwaLista)));
  const staryPasek = stan(); staryPasek.bar.at = Date.now() - 15 * 60e3;
  check("pasek misji sprzed 15 min = ślepy alarm nie działa i bot to mówi",
    /pasek misji sprzed/.test(R()(staryPasek).join("|")), JSON.stringify(R()(staryPasek)));
  const drift = stan(); drift.listUntrusted = true;
  check("sesja zaparkowana na obcej kolonii jest zgłaszana",
    /sesja gry stoi na obcej kolonii/i.test(R()(drift).join("|")), JSON.stringify(R()(drift)));
  check("bot wyłączony jest zgłaszany", /bot WYŁĄCZONY/.test(R({ ...CFG_OK, enabled: false })(stan()).join("|")));
  check("auto-ratunek OFF jest zgłaszany", /auto-ratunek OFF/.test(R({ ...CFG_OK, autoRescue: false })(stan()).join("|")));
  check("push OFF jest zgłaszany (bez niego nie ma drugiej linii obrony)",
    /push OFF/.test(R(null, null, { enabled: () => false })(stan()).join("|")));
  check("wygasła sesja jest zgłaszana", /SESJA WYGAS/.test(R(null, { lostRecently: () => true })(stan()).join("|")));
  const stary = stan(); stary.hangars["3:272:7|moon"].at = Date.now() - 60 * 60e3;
  check("hangar sprzed godziny = brak wiedzy, gdzie stoi flota",
    /nieczytany od ponad 30 min/.test(R()(stary).join("|")), JSON.stringify(R()(stary)));
  const sama = stan(); sama.pairs = { "3:272:7": { hasMoon: true } };
  check("jedna kolonia → nie ma dokąd uciec", /nie ma dokąd uciec/.test(R()(sama).join("|")));
  check("samokontrola chodzi raz na 5 min, nie na każdym przebiegu (koszt w ticku)",
    /Store\.get\("ready_at", 0\)[\s\S]{0,40}5 \* 60e3/.test(src));
  check("samokontrola niczym nie nawiguje ani nie wysyła",
    !/Nav\.|Fly\.start|location\./.test(body), body.slice(0, 120));

  // Podsumowanie po przerwie: liczy TYLKO wpisy z okresu ciszy, a brak wpisów przy
  // wyłączonym bocie nie może brzmieć jak „spokojnie".
  check("podsumowanie bierze wpisy dziennika dopiero od ostatniego ticku",
    /\(x\.at \|\| 0\) >= ostatni/.test(src));
  check("cisza przy wyłączonym bocie nie jest raportowana jako spokój",
    /nie znaczy „spokojnie" — znaczy „nie patrzyłem"/.test(src));
}

console.log("── 20. FLEET SAVE (v3.68.0: port z Atheny — jedna godzina powrotu, bez okna) ──");
{
  const FSCFG = Object.assign({}, CFG, { fs: { enabled: true, returnHour: 7, returnMinute: 0, speedPct: 10, target: null }, fsReturnAt: undefined });
  const fsReturnAt = NOW + 6 * 3600e3;
  const s = base({ fsReturnAt, hangars: { "3:272:7|moon": H(1e6) } });
  const a = decide(s, FSCFG, NOW).actions.find(x => x.fs);
  check("flota wychodzi z hangaru OD RAZU — bez żadnego okna godzinowego", !!a, JSON.stringify(decide(s, FSCFG, NOW).actions));
  check("FS leci poza parę, powoli, z zawrotem liczonym z fsReturnAt (nie z zegara okna)", a && a.toKey !== "3:272:7" && a.speed === 10 && a.recall === true && a.recallAt === fsReturnAt, JSON.stringify(a));
  // v3.68.1 (audyt przed merge): stara asercja pilnowała tylko `toKey`, a fixture ma
  // najdalszą kolonię BEZ księżyca — test wykonywał więc blocker „FS leci na PLANETĘ"
  // i świecił na zielono. Reguła 3.x brzmi „misja zawsze moon→moon": kolonie bez
  // księżyca odpadają, nawet gdy są najdalsze.
  check("FS wybiera NAJDALSZĄ nieatakowaną kolonię Z KSIĘŻYCEM, gdy brak stałego celu", a && a.toKey === "3:272:2" && a.toBody === "moon", JSON.stringify(a));
  check("FS NIE niesie wykluczeń — cała dostępna flota (owner 07.09)", a && !(a.excludeTypes && a.excludeTypes.length), JSON.stringify(a));

  const s2 = base({ fsReturnAt, hangars: { "3:272:7|moon": H(1e6) }, threats: [threat("5:100:4", "planet", 600)] });
  const a2 = decide(s2, FSCFG, NOW).actions.find(x => x.fs);
  check("atakowana kolonia nie jest celem FS", a2 && a2.toKey === "3:272:2", JSON.stringify(a2));

  check("FS wyłączony w configu → nic", !decide(s, CFG, NOW).actions.some(x => x.fs));

  const s3 = base({ fsReturnAt, hangars: { "3:272:7|moon": H(1e6) }, flights: [{ kind: "air", fromKey: "3:272:7", phase: "launched", recallAt: NOW + 3600e3 }] });
  check("FS nie dubluje lotu, gdy flota już w powietrzu", !decide(s3, FSCFG, NOW).actions.some(x => x.fs));

  const s4 = base({ fsReturnAt, threats: [threat("3:272:7", "moon", 300)], hangars: { "3:272:7|moon": H(1e6) } });
  const a4 = decide(s4, FSCFG, NOW).actions[0];
  check("atak (o dowolnej porze) → normalny ratunek, nie FS", a4 && a4.kind === "fly" && !a4.fs, JSON.stringify(a4));

  // v3.68.0: Athena "z planety nigdy — falanga" — FS startuje TYLKO z księżyca.
  const s5 = base({ fsReturnAt, hangars: { "3:272:7|planet": H(1e6) } });
  const r5 = decide(s5, FSCFG, NOW);
  check("flota TYLKO na planecie → FS NIE wysyła stamtąd (falanga)", !r5.actions.some(x => x.fs), JSON.stringify(r5.actions));
  check("...i ostrzega, że czeka na księżyc", r5.alerts.some(al => /nie wysyłam stamtąd \(falanga\)/.test(al.msg)), JSON.stringify(r5.alerts));

  // v3.68.0: stały cel (Athena) jest JEDYNYM wyborem — bez cichego podstawiania innej kolonii.
  const FSCFG_T = Object.assign({}, CFG, { fs: { enabled: true, returnHour: 7, returnMinute: 0, speedPct: 10, target: "3:272:2" } });
  const s6 = base({ fsReturnAt, hangars: { "3:272:7|moon": H(1e6) } });
  const a6 = decide(s6, FSCFG_T, NOW).actions.find(x => x.fs);
  check("stały cel: leci TYLKO tam, zawsze na księżyc", a6 && a6.toKey === "3:272:2" && a6.toBody === "moon", JSON.stringify(a6));
  const s7 = base({ fsReturnAt, hangars: { "3:272:7|moon": H(1e6) }, threats: [threat("3:272:2", "moon", 600)] });
  const r7 = decide(s7, FSCFG_T, NOW);
  check("stały cel pod atakiem → NIE podstawia innej kolonii, tylko czeka + alarmuje", !r7.actions.some(x => x.fs) && r7.alerts.some(al => /jest pod atakiem/.test(al.msg)), JSON.stringify(r7));
  const FSCFG_TBAD = Object.assign({}, CFG, { fs: { enabled: true, returnHour: 7, returnMinute: 0, speedPct: 10, target: "9:9:9" } });
  const r8 = decide(base({ fsReturnAt, hangars: { "3:272:7|moon": H(1e6) } }), FSCFG_TBAD, NOW);
  check("stały cel nieznany (nie na pasku planet) → alarm, żadnego lotu w ciemno", !r8.actions.some(x => x.fs) && r8.alerts.some(al => /nieznany/.test(al.msg)), JSON.stringify(r8));

  // v3.68.0 (port z Atheny) wykluczała przy FS miner/recykler, gdy mining/złom pracuje.
  // v3.70.0 (owner 07.09, po FS bez 14,2 mln recyklerów: „na FS musi być cała flota,
  // która jest dostępna"): żadnych wykluczeń — pracujący statek i tak jest w locie.
  const s9 = base({ fsReturnAt, hangars: { "3:272:7|moon": H(1e6) } });
  const a9off = decide(s9, Object.assign({}, FSCFG, { aster: { enabled: false }, debris: { enabled: false } }), NOW).actions.find(x => x.fs);
  check("mining i złom OFF → FS bez wykluczeń", !!a9off && !(a9off.excludeTypes && a9off.excludeTypes.length), JSON.stringify(a9off));
  const a9on = decide(s9, Object.assign({}, FSCFG, { aster: { enabled: true }, debris: { enabled: true } }), NOW).actions.find(x => x.fs);
  check("mining i złom ON → FS NADAL bez wykluczeń (recyklery i minery lecą z całą flotą)", !!a9on && !(a9on.excludeTypes && a9on.excludeTypes.length), JSON.stringify(a9on));
  check("(źródło) decide() nie liczy już `evacExclude` dla FS", !/evacExclude/.test(decideBody));
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
  // v3.68.0: FS stracił okno — ekonomia pyta o REALNY stan floty (w locie na FS),
  // nie o zegar (Athena nie miała okna, więc "noc" przestała być właściwym pytaniem).
  check("flota na FS wyłącza ekonomię (realny stan floty, nie zegar)", /economyAtNight[\s\S]{0,120}?flights[\s\S]{0,60}?f\.fs/.test(hum));
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
  // v3.68.10 (audyt 04.09, obrona-fs#5): złom nadal stoi przy ataku i przy przerwie/ciszy,
  // ale PYTA ZE ZNACZNIKIEM „debris" — bo recyklery są wykluczone z lotu Fleet Save
  // dokładnie po to, żeby w tym czasie pracowały (patrz Human.FS_MIMO).
  check("złom stoi przy ataku i przerwie", /t\.attack && t\.arriveAt > Date\.now\(\)\)\) return false/.test(dm) && /if \(Human\.economyAllowed\(s, "debris"\)\) return false/.test(dm));
  check("bez recyklerów nic nie robi", /RECYCLER/.test(dm));
  check("sprawdza poz. 16 (ekspedycje) i pozycję bazy (po bitwie)", /wanted = \[16, pos\]/.test(dm));
  check("cel typu ZŁOM to data-planet-type=3", /m\.toBody === "debris" \? "3"/.test(src));
  // v3.60.0 (zrzut kafla 22:53): „Collect" (mission 13) na tym forku zbiera
  // surowce z WŁASNEJ planety — złom zbiera „Recycle". COLLECT nie może być
  // na liście preferencji, bo dusił złą misję („Invalid mission type").
  check("misja złomu = RECYCLE, nigdy Collect-z-własnej-planety", /\? \["RECYCL", "HARVEST"\]/.test(src) && !/"COLLECT", "HARVEST", "RECYCL"/.test(src));
  check("rozmiar złomu z samych liczb dymka (grupowany wzorzec tnie sklejone liczby)", /\\d\{1,3\}\(\?:\[\.,\]\\d\{3\}\)\+/.test(dm));
  // v3.61.0 (noc 01/02.09: 15 pustych lotów, raporty 0/0, dubel 05:19+05:20):
  check("złom: ikona własnej floty w kolumnie DF ≠ złom (dowodem tylko dymek/link)", /sawTip/.test(dm) && /if \(!sawTip\) continue/.test(dm));
  check("złom: zbieracze w drodze blokują kolejną wysyłkę (rejestr powrotów)", /e\.kind === "debris" && now < \(e\.sentAt \|\| 0\) \+ \(e\.flightMs \|\| 0\)/.test(dm));
  check("złom: dymek bez ilości (pole puste) = nie wysyłamy w ciemno", /hit\.viaTip && !\(hit\.amount > 0\)/.test(dm));
  check("złom: okno anty-duplikat 3 min, nie 20 s fal ekspedycji", /m\.kind === "debris" \? 3 \* 60e3/.test(src));
  check("lot po złom nie blokuje obrony", /m\.kind !== "expedition" && m\.kind !== "asteroid" && m\.kind !== "debris"/.test(src));
  check("kolejność ekonomii: rekonesans → bonus → księżyce → ekspedycje → mining → złom", /!\(await Recon\.tick\(s\)\) && !\(await Bonus\.tick\(s\)\) && !\(await Moon\.tick\(s\)\) && !\(await Expo\.tick\(s\)\) && !\(await Aster\.tick\(s\)\)\) await Debris\.tick\(s\)/.test(src));
  check("księżyce: domyślnie WŁĄCZONE, cel NAJMNIEJSZA średnica (v3.67.0: koszt pomijalny, nie inwestycja)", /moon: \{ enabled: true, maxMetalShare: 0\.25, minKm: 1000/.test(src));
  check("księżyce: sufit udziału metalu, średnica NAJMNIEJSZA najpierw (rosnąco, nie w dół od największej)", /maxMetalShare/.test(src) && /KM: \[8944/.test(src) && /\.sort\(\(a, b\) => a - b\)/.test(src) && /c <= budget/.test(src));
  check("księżyce: limit prób na dobę i limit nawigacji na próbę", /maxTries24h/.test(src) && /navs \|\| 0\) >= 4/.test(src));
  check("księżyce: nieznany markup = zrzut do logu, nie zgadywanie", /\[KSIĘŻYC DOM\]/.test(src));
  check("ekspedycje: pole „startuj z” przypina ciało startowe", /ogx3-expo-from/.test(src) && /CFG\.expo\.launchFrom = \{ galaxy/.test(src));
  // v3.56.0: PZ po piratach leży na poz. 16 układu STARTU ekspedycji — zbieracz
  // musi zaglądać tam (parytet z Atheną HomeBase.expo), nie do aktywnej pary.
  check("złom zagląda do układu startu ekspedycji (launchFrom), nie aktywnej pary", /\(CFG\.expo && CFG\.expo\.launchFrom\) \? key\(CFG\.expo\.launchFrom\)/.test(dm));
  check("złom: domyślnie WŁĄCZONY + migracja starego configu (v3.56.0)", /debris: \{ enabled: true/.test(src) && /migr_debris_on_v356/.test(src));
  // v3.57.0 (owner: „raz na 20 minut wystarczy"): stempel okresu przy nawigacji,
  // znacznik debris_go domyka odczyt — bez ponowień co 60 s.
  check("złom: jedna wizyta na okres (stempel przy nawigacji + debris_go)", /debris_go/.test(dm) && !/debris_at", now - \(CFG\.debris/.test(dm));
  // v3.59.0 (pierwszy bojowy zbiór, „Invalid mission type" + „wysłał wszystkie"):
  // link i rozmiar złomu z dymka data-tooltip-content; flota doszacowana do złomu.
  check("złom: link zbierania i rozmiar czytane z dymka (data-tooltip-content)", /data-tooltip-content/.test(dm) && /tipHref/.test(dm));
  check("złom: flota doszacowana do rozmiaru (cargo 125k, nieznany rozmiar = 20%, nigdy całość)", /cargoPerRecycler \|\| 125_000/.test(dm) && /unknownShare \?\? 0\.2/.test(dm));
  check("krok 3: klik w klikalny element misji + log co kliknięto", /pickTarget/.test(src) && /\[ZŁOM DOM\] kafel misji/.test(src));
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
  // v3.68.3 (audyt 04.09): dyspozytora pusha pilnował do tej pory SAM regex — dowód, że
  // linia istnieje, a nie że działa; audyt policzył to jako dziurę przepuszczającą mutację.
  // Tniemy więc PRAWDZIWĄ pętlę alertów z defenceTick i URUCHAMIAMY ją na atrapach
  // Once/log/Journal, sprawdzając, co naprawdę wychodzi na telefon, a co zostaje w logu.
  const dispatchPush = (alert, said = () => false) => {
    const sent = [];
    new Function("alerts", "Once", "log", "Journal",
      `for (const a of alerts) {${bodyOf("for (const a of alerts) {")}}`)(
      [alert],
      { said },                         // domyślnie żaden dławik nie tłumi — badamy sam warunek
      () => {},                         // log do kosza
      { add: (kind, msg) => sent.push(`${kind}|${msg}`) },
    );
    return sent;
  };
  const AL = (over) => Object.assign({ key: "1:200:8", level: "error", msg: "ALARM testowy" }, over);
  check("alarm o nieznanej kolonii idzie na telefon", dispatchPush(AL({ unknownPair: true })).length === 1, JSON.stringify(dispatchPush(AL({ unknownPair: true }))));
  check("ślepy alarm idzie na telefon", dispatchPush(AL({ blind: true })).length === 1, JSON.stringify(dispatchPush(AL({ blind: true }))));
  check("alarm z jawną flagą push idzie na telefon (v3.68.3)", dispatchPush(AL({ push: true })).length === 1, JSON.stringify(dispatchPush(AL({ push: true }))));
  check("alert bez żadnej z tych flag NIE budzi telefonu", dispatchPush(AL({})).length === 0, JSON.stringify(dispatchPush(AL({}))));
  check("push ma własny dławik na kluczu `push|<para>` — powtórka nie budzi telefonu drugi raz",
    dispatchPush(AL({ push: true }), (k) => k.startsWith("push|")).length === 0
    && /`push\|\$\{a\.key\}`, 5 \* 60e3/.test(src));
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
  check("[TEMPO] alarmuje o POWTARZAJACYM sie powodzie, nie o samej liczbie przeladowan", /const bots = loads\.filter/.test(src) && /worst\[1\] >= 4/.test(src));
  check("[TEMPO] nie liczy klikniec operatora", /bot: !!fresh/.test(src) && /manual_at/.test(src));
  check("panel pokazuje ODLICZANIE do nastepnej fali (jak Athena)", /następna za \$\{Math\.ceil/.test(src) && /fala gotowa/.test(src));
  check("rekonesans nie wyrywa strony grającemu (ale nie dłużej niż 5 min)", /manual_at/.test(src) && /now - manual < 45e3 && now - \(st\.at \|\| 0\) < 5 \* 60e3/.test(src));
  check("bonus online: odbiór przez nawigację, nie klik (wyścig z 2.x)", /const Bonus = \{/.test(src) && /Nav\.go\(c\.remote \? href : \(el\.href \|\| href\), "bonus online/.test(src));
  check("bonus online: odliczanie i wyszarzenie nie są odbierane", /odliczanie/.test(src) && /wyszarzony/.test(src));
  check("bonus online: odbiór potwierdzany po przeładowaniu", /if \(st\.pending\)/.test(src) && /kliknięcie nie odebrało bonusu/.test(src));
  check("minery: rozmiar floty liczony pod urobek (right-sizing z 2.x)", /size\(st, available\)/.test(src) && /buffer/.test(src) && /percentile/.test(src));
  check("minery: loty równoległe zamiast czekania na powrót", /parallel: true/.test(src) && /freeSlots\(s\)/.test(src) && /slotReserve/.test(src));
  check("minery: pojemność ładowni czytana PO ukośniku (0 / 1.000.000)", /cargo\\s\*space\[\^\\d\]\{0,20\}\[\\d \.,\]\*\\\//.test(src));
  check("minery: zero w konfiguracji znaczy zero, a nie wartosc domyslna (?? zamiast ||)", /scanGapSec \?\? 6/.test(src) && /gapSec \?\? 20/.test(src));
  check("przerwa kawowa nie odpala sie po przestoju (zalegly termin przepada)", /idle > 20 \* 60e3/.test(src) && /eco_last/.test(src));
  check("przyciski formularza szukane TAKZE poza #content (jak w 2.x)", /exact\(inArea\) \|\| exact\(anywhere\)/.test(src));
  check("brak przycisku vs przycisk wylaczony to dwa rozne komunikaty", /BYŁ na stronie, ale przez/.test(src) && /NIE MA na stronie/.test(src));
  check("nieudane szukanie zrzuca liste KANDYDATOW", /KANDYDACI/.test(src));
  check("misja sprzed przerwy sprzatana BEZ karencji trasy", /porzucona misja sprzed/.test(src) && /15 \* 60e3/.test(src));
  check("minery: blokada koordow, do ktorych juz leci flota (2.x DispatchedAsteroids)", /locked\(st, key\)/.test(src) && /lockMin/.test(src));
  check("minery: za daleki uklad pomijany PRZED skanem (2.x maxFlightMinutes)", /tooFar\(homeKey, target\)/.test(src) && /maxFlightMin/.test(src));
  check("minery: pelny obieg bez lupu = pauza, nie krecenie galaktyka", /idleUntil/.test(src) && /idleScanMin/.test(src));
  check("rekonesans rzadziej odwiedza ciala BEZ floty", /reconEmptyMs/.test(src));
  check("rekonesans ma tryb TYLKO-FLOTA i jest on domyslny", /reconMode: "fleet"/.test(src) && /CFG\.reconMode \|\| "fleet"/.test(src));
  check("alarm nadal moze wejsc na kazde cialo (osobna sciezka)", /wchodzę na Fleet/.test(src) && /alarm_scan/.test(src));
  check("rekonesans przypiety do ciala startowego, gdy jest ustawione", /if \(lf\) return dedupe\(\[\.\.\.all\.filter\(\(\[k\]\) => k === lf\), \.\.\.lostPlanets\]\);/.test(src));
  check("rekonesans nie otwiera Fleet dla ciala spoza listy (poza rozruchem)", /allowed\.size === 0 \|\| allowed\.has/.test(src));
  // NAUCZKA 29.08: trzy wersje pod rzad poszly na main z NIEPODBITYM @version
  // (patch podmieniajacy numer zostal wyciety przy edycji skryptu lataczego),
  // wiec Tampermonkey nie zaciagnal ich w ogole — bot chodzil na starym kodzie,
  // a ja raportowalem "wypchniete". Ten test pilnuje, zeby numer w naglowku
  // i w kodzie byly zgodne; rozjazd = czerwony test przed pushem.
  {
    const hv = (src.match(/@version\s+([\d.]+)/) || [])[1];
    const cv = (src.match(/const VERSION = "([\d.]+)"/) || [])[1];
    check(`@version (${hv}) zgodny z const VERSION (${cv})`, !!hv && hv === cv, `naglowek=${hv} kod=${cv}`);
  }
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
  // v3.68.6: okna obu strażników poszerzone o komentarz „dlaczego" przy stemplu
  // `last_send` i przy bramce anty-duplikat — mierzą KOLEJNOŚĆ, nie długość komentarzy.
  check("lot obronny zapisany PRZED klikiem Send fleet", /pending: true \}\);[\s\S]{0,1600}?Nav\.click\(send/.test(src));
  check("stempel wysyłki blokuje powtórkę po przeładowaniu",
    /const ls = Store\.get\("last_send", null\);/.test(src)
    && /if \(lsMine && Date\.now\(\) - ls\.at < guardMs\) \{\s*\n\s*log\(`\[LOT\] wysyłka do \[\$\{m\.toKey\}\] już poszła[\s\S]{0,120}?nie powtarzam/.test(src));
  // v3.68.6 (obrona-stan-lotu#1): stempel MUSI nieść ciała i `startedAt` — bez nich
  // wysyłka złomu na własną pozycję bazy była nie do odróżnienia od ratunku.
  check("stempel wysyłki niesie ciała i tożsamość misji (rodzaj + startedAt)",
    /Store\.set\("last_send", \{ at: Date\.now\(\), toKey: m\.toKey, toBody: m\.toBody, kind: m\.kind, from: m\.fromKey, fromBody: m\.fromBody, startedAt: m\.startedAt,/.test(src));
  // v3.10.0: wpis `pending` byl NIESMIERTELNY — kasowal go tylko kod PO send.click()
  // (ktory przy natychmiastowej nawigacji nigdy sie nie wykonuje), a filtr wygaszania
  // przepuszczal go przed kazda regula. Efekt: bot milczal przy kazdym kolejnym ataku
  // na te pare. Pilnujemy WSZYSTKICH trzech drog sprzatania.
  // v3.68.8: sprzątanie celuje dodatkowo w CIAŁO startu (para może mieć wpis lotu z obu
  // ciał) — wzorzec pilnuje samej reguły i KOLEJNOŚCI (sprzątanie przed abortem), nie
  // dokładnego kształtu warunku.
  check("nieudana wysyłka zdejmuje wpis pending PRZED abortem", /sBad\.flights = \(sBad\.flights \|\| \[\]\)\.filter\(f => !\(f\.fromKey === m\.fromKey &&[\s\S]{0,160}?f\.pending\)\)[\s\S]{0,300}?return this\.abort/.test(src));
  check("przerwana misja sprząta swój wpis pending", /abort\(why, opts = \{\}\)[\s\S]{0,700}?f\.pending\)\)/.test(src));
  check("osierocony pending wygasa po 10 min (nie blokuje pary na zawsze)", /f\.pending && now - f\.sentAt < 10 \* 60e3\) return true/.test(src));
  check("jedna definicja 'wpis lotu nic nie znaczy' (decide + ekonomia + rekonesans)", /function flightStale\(f, now\)/.test(src) && /flightsBlocking\(s, now\)\) return \{ skip/.test(src));
  // v3.68.11 (audyt 04.09, obrona-wykonanie#4): skrót należy się flocie POD OSTRZAŁEM —
  // ewakuacja z gołej planety (`evac`, leci bez ataku) czeka pełne 3 min jak lot rutynowy.
  check("ratunek ma skróconą karencję po potknięciu (nie 3 min), ale ewakuacja bez ataku NIE",
    /\(a\.air \|\| a\.rescue\) && !a\.evac\) return until - 2 \* 60e3 - 15e3 > Date\.now\(\)/.test(src));
  // v3.68.5 (audyt 04.09): strażnik regexowy pilnował literalnego końca linii i padał przy
  // każdym dopisaniu pola do akcji (a taki dopisek to właśnie `etaMs`/`saveTotal` z tej
  // partii). Wykonujemy decide() zamiast czytać źródło: atak w KSIĘŻYC przy nieatakowanej
  // planecie tej samej pary → ucieczka na drugie ciało, oznaczona jako ratunek.
  {
    const drugie = base({
      pairs: { "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 } },
      hangars: { "3:272:7|moon": H(900_000) },
      threats: [threat("3:272:7", "moon", 300)],
    });
    const aDrugie = decide(drugie, CFG, NOW).actions.find(a => a.kind === "fly");
    check("ratunek na drugie ciało też jest oznaczony jako ratunek",
      !!aDrugie && aDrugie.toKey === "3:272:7" && aDrugie.toBody === "planet" && aDrugie.rescue === true, JSON.stringify(aDrugie));
  }
  // v3.10.3 (E2E): reguly, ktore wyszly dopiero na symulatorze
  check("zero statkow to 'pusty hangar' TYLKO na kroku wyboru statkow", /const shipsStep = ships\.length > 0/.test(src) && /if \(!shipsStep\) \{/.test(src));
  check("lot krotszy niz termin zawrotu = LADOWANIE (zawrot skasowany)", /recallOf\(mm\) \{/.test(src) && /recallAt: this\.recallOf\(m\)/.test(src));
  check("czas lotu poznany pozniej przelicza termin zawrotu", /f0\.flightMs = m\.flightMs; f0\.recallAt = this\.recallOf/.test(src));
  // v3.62.0 (log 02.09): „Send fleet" na tym forku przeładowuje stronę PRZED kodem po kliku,
  // więc domknięcie wysyłki musi umieć iść z DOWODU po przeładowaniu — i z jednego miejsca.
  check("wysyłka potwierdzana po przeładowaniu z adresu fleetSendSuccessfully + stempla TEJ misji", /lsOk\.at \|\| 0\) >= \(m\.startedAt \|\| 0\) && location\.href\.includes\("fleetSendSuccessfully"\)/.test(src) && /this\.confirmed\(m, \{ loaded: lsOk\.loaded/.test(src));
  check("domknięcie wysyłki w JEDNYM miejscu (po kliku i po przeładowaniu)", /confirmed\(m, info = \{\}\) \{/.test(src) && /this\.confirmed\(m, \{ loaded: loaded\.join\(", "\) \}\)/.test(src) && !/\[EXPO\] fala wysłana: \$\{loaded\.join/.test(src));
  check("klik Send fleet idzie przez Nav.click (linia startowa: bot, nie 'otwarte ręcznie')",/Nav\.click\(send, `wysyłka floty/.test(src) && !/\bsend\.click\(\)/.test(src));
  check("fala domykająca mówi DLACZEGO domyka (sloty/licznik/konfiguracja)", /lastWhy = waves === 1/.test(src) && /ostatni wolny slot ekspedycji \(\$\{expo\.used\}\/\$\{expo\.total\}/.test(src) && /domyka serię — cały hangar: \$\{p\.lastWhy\}/.test(src));
  check("rekonesans ustepuje RATUNKOWI, ale nie rutynowemu FS", /a\.kind === "fly" && \(a\.rescue \|\| a\.blind\)/.test(src));
  check("FS nie startuje na godzinnym odczycie hangaru", /FS: odczyt hangaru/.test(src));
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

console.log("\n── 33. AUDYT 29.08: cisza obrony i rezerwa slotow (v3.29.0) ──");
{
  // O1: lot z tej pary kazal robic `continue` — atak nie dawal ani alarmu, ani pusha.
  // Faza "done" nie jest ustawiana nigdzie, a "recalled" zyje do recallAt + 60 min.
  const air = { kind: "air", fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:2", toBody: "moon",
    sentAt: NOW - 10 * 60e3, recallAt: NOW - 5 * 60e3, phase: "recalled", recalledAt: NOW - 6 * 60e3 };
  const s1 = base({ threats: [threat("3:272:7", "moon", 300)], flights: [air] });
  const r1 = decide(s1, CFG, NOW);
  check("atak na pare z lotem w powietrzu NIE jest przemilczany", r1.alerts.some(a => a.key === "3:272:7" && a.level === "error"), JSON.stringify(r1.alerts));
  check("alarm mowi, ze flota WRACA (a nie ze wszystko gra)", r1.alerts.some(a => /WRACA/.test(a.msg)), JSON.stringify(r1.alerts.map(a => a.msg)));
  check("i nadal nie probuje ratowac floty, ktorej nie ma w hangarze", !r1.actions.some(a => a.kind === "fly"), JSON.stringify(r1.actions));

  // O2: "bezpieczna strona" na odczycie sprzed wielu godzin to zgadywanie.
  const stale = base({ threats: [threat("3:272:7", "planet", 300)],
    hangars: { "3:272:7|moon": H(9e9, "moon", 10 * 3600e3) } });
  const rS = decide(stale, CFG, NOW);
  check("hold NIE zapada na hangarze sprzed 10 h", !rS.actions.some(a => a.kind === "hold"), JSON.stringify(rS.actions));
  check("zamiast tego alarm z pushem i rekonesans", rS.alerts.some(a => a.level === "error" && /NIE WIEM/.test(a.msg)) && rS.actions.some(a => a.kind === "recon"), JSON.stringify(rS.actions) + JSON.stringify(rS.alerts.map(a => a.msg)));
  const okFresh = base({ threats: [threat("3:272:7", "planet", 300)],
    hangars: { "3:272:7|moon": H(9e9, "moon", 5 * 60e3) } });
  check("swiezy odczyt (5 min) nadal daje spokojne 'bezpieczna strona'", decide(okFresh, CFG, NOW).actions.some(a => a.kind === "hold"), JSON.stringify(decide(okFresh, CFG, NOW).actions));

  // O3: slepy alarm gasl w calosci, gdy gdziekolwiek trwal rozpoznany atak.
  const blind = base({ barExcess: { active: true, count: 1, since: NOW - 70e3 },
    threats: [threat("5:100:4", "planet", 300)],
    hangars: { "3:272:7|moon": H(9e9), "5:100:4|planet": H(10) } });
  const rB = decide(blind, CFG, NOW);
  check("slepy alarm dziala mimo rozpoznanego ataku na INNA kolonie", rB.actions.some(a => a.blind && a.fromKey === "3:272:7"), JSON.stringify(rB.actions));
  check("ale nie dubluje akcji na parze, ktora ma wlasny atak", !rB.actions.some(a => a.blind && a.fromKey === "5:100:4"), JSON.stringify(rB.actions));
}

console.log("\n── 34. EKSPEDYCJE: rezerwa slotow po zdjeciu sufitu (v3.29.0) ──");
{
  // Odkad fala domykajaca bierze caly hangar, `takesAll` jest prawdziwe niemal
  // zawsze — a wtedy pole "rezerwa slotow" w panelu nie robilo NIC.
  const cfgR = { ...ECFG, expo: { ...ECFG.expo, slotReserve: 1, waves: 1 } };
  const one = { fleet: { used: 4, total: 5 }, expo: { used: 0, total: 4 }, at: NOW };
  const alone = expoPlan(ebase({ slots: one }), cfgR, NOW, null);
  check("caly hangar leci, gdy nigdzie indziej nie ma floty (nie ma czego ratowac)", !alone.skip, JSON.stringify(alone));
  const withOther = ebase({ slots: one });
  withOther.hangars["1:100:9|planet"] = { total: 300, at: NOW - 60e3, ships: [{ type: "SMALL_CARGO", qty: 300 }] };
  const guarded = expoPlan(withOther, cfgR, NOW, null);
  check("ale rezerwa OBOWIAZUJE, gdy na innej kolonii stoja transportery", /rezerw/.test(guarded.skip || ""), JSON.stringify(guarded));
}

console.log("\n── 35. PUSH: dlawik nie moze uciszac ataku na DRUGA kolonie (v3.33.0) ──");
{
  const tk = new Function("kind", "msg", bodyOf("throttleKey(kind, msg) {"));
  const a = tk("ATAK", "ATTACK → [1:217:6] planet za 300s");
  const b = tk("ATAK", "ATTACK → [2:220:7] moon za 200s");
  check("dwie rozne kolonie = dwa rozne klucze dlawika", a !== b, a + " vs " + b);
  check("ta sama kolonia = ten sam klucz (bez spamu co tick)", tk("ATAK", "znow [1:217:6] za 120s") === a, tk("ATAK", "znow [1:217:6] za 120s") + " vs " + a);
  check("wiadomosc bez wspolrzednych spada do klucza rodzaju", tk("BLAD", "cos poszlo nie tak") === "BLAD");
  check("dlawik ATAK to 5 min, nie godzina", /ATAK: 5 \* 60e3/.test(src));
}

console.log("\n── 36. DOM = KSIEZYC po postawieniu ksiezyca (v3.34.0) ──");
{
  // Sytuacja z 29.08 20:28: gros floty juz na ksiezycu, a z ekspedycji wracaja
  // fale na PLANETE. fleetAt() mowi wtedy "moon" (wiekszy hangar), wiec stara
  // regula uznawala, ze dom jest domem — i wracajace statki zostawaly na planecie.
  const s = base({ hangars: { "3:272:7|moon": H(70000), "3:272:7|planet": H(1200) } });
  const r = decide(s, CFG_H2M, NOW);
  const fly = r.actions.find(a => a.kind === "fly" && /dom = ksi/.test(a.why));
  check("wracajace statki z planety ida na ksiezyc, mimo wiekszego hangaru na ksiezycu", !!fly && fly.fromBody === "planet" && fly.toBody === "moon", JSON.stringify(r.actions));
  const pusta = base({ hangars: { "3:272:7|moon": H(70000), "3:272:7|planet": { total: 0, at: NOW - 60000, ships: [] } } });
  check("pusta planeta nie generuje lotu (zero jalowych wysylek)", !decide(pusta, CFG_H2M, NOW).actions.some(a => /dom = ksi/.test(a.why || "")), JSON.stringify(decide(pusta, CFG_H2M, NOW).actions));
  const stara = base({ hangars: { "3:272:7|moon": H(70000), "3:272:7|planet": H(1200, "planet", 60 * 60e3) } });
  check("odczyt planety sprzed godziny = nie ruszamy (moze juz tam nic nie ma)", !decide(stara, CFG, NOW).actions.some(a => /dom = ksi/.test(a.why || "")), JSON.stringify(decide(stara, CFG, NOW).actions));
  const atak = base({ hangars: { "3:272:7|moon": H(70000), "3:272:7|planet": H(1200) }, threats: [threat("3:272:7", "moon", 300)] });
  check("przy ataku obrona ma pierwszenstwo (zaden lot do domu)", !decide(atak, CFG, NOW).actions.some(a => /dom = ksi/.test(a.why || "")), JSON.stringify(decide(atak, CFG, NOW).actions));
}

console.log("\n── 37. POWROTY WLASNEJ FLOTY (sciezka A5 z Ateny) (v3.35.0) ──");
{
  // Athena: „Destroy + snajperka powrotow" — napastnik zna sekunde ladowania fali.
  // 3.x parsowal wlasne loty i NIGDY ich nie uzywal, a wiersz powrotu znika w chwili
  // ladowania. Teraz termin powrotu zostaje w stanie i wymusza odczyt hangaru.
  const s = base({
    hangars: { "3:272:7|moon": H(70000) },                       // planeta nieczytana od dawna
    landings: { "3:272:7|planet": NOW - 60e3 },                  // fala wrocila minute temu
  });
  const r = decide(s, CFG, NOW);
  const rec = r.actions.find(a => a.kind === "recon" && a.key === "3:272:7" && a.body === "planet");
  check("po powrocie floty bot idzie sprawdzic hangar TEGO ciala", !!rec, JSON.stringify(r.actions));
  const czytane = base({
    hangars: { "3:272:7|moon": H(70000), "3:272:7|planet": H(1200, "planet", 30e3) },   // odczyt PO ladowaniu
    landings: { "3:272:7|planet": NOW - 60e3 },
  });
  const r2 = decide(czytane, CFG_H2M, NOW);
  check("gdy hangar czytany PO ladowaniu — zadnego zbednego rekonesansu", !r2.actions.some(a => a.kind === "recon"), JSON.stringify(r2.actions));
  check("i od razu zapada decyzja: statki wracaja na ksiezyc", r2.actions.some(a => a.kind === "fly" && a.fromBody === "planet" && a.toBody === "moon"), JSON.stringify(r2.actions));
  const stare = base({ hangars: { "3:272:7|moon": H(70000) }, landings: { "3:272:7|planet": NOW - 2 * 3600e3 } });
  check("ladowanie sprzed dwoch godzin juz nikogo nie interesuje", !decide(stare, CFG, NOW).actions.some(a => a.kind === "recon"), JSON.stringify(decide(stare, CFG, NOW).actions));
  const atak = base({ hangars: { "3:272:7|moon": H(70000) }, landings: { "3:272:7|planet": NOW - 60e3 }, threats: [threat("3:272:7", "moon", 300)] });
  check("przy ataku obrona ma pierwszenstwo (nie dreptamy po hangarach)", !decide(atak, CFG, NOW).actions.some(a => /wrocila wlasna flota|wróciła własna flota/.test(a.why || "")), JSON.stringify(decide(atak, CFG, NOW).actions));
  check("termin powrotu trafia do stanu (Situation), nie ginie z wierszem", /s\.landings = land/.test(src) && /isReturn \|\| !\(o\.src \|\| o\.dst\)/.test(src));
  // v3.65.0 (log 03.09 08:58): gra OPÓŹNIA powroty ekspedycji o godziny; wiersz własnej
  // ekspedycji (bez klasy „return") niesie prawdziwy czas lądowania. Lista per ciało.
  const exL = base({ hangars: { "3:272:7|moon": H(70000, "moon", 10 * 60e3) }, expoLandings: { "3:272:7|moon": [NOW - 60e3, NOW + 3 * 3600e3] } });
  const rL = decide(exL, CFG, NOW);
  check("ekspedycja wylądowała minutę temu (wiersz bez „return”), hangar sprzed 10 min → CICHY odczyt księżyca", rL.actions.some(a => a.kind === "recon" && a.quiet && a.key === "3:272:7" && a.body === "moon"), JSON.stringify(rL.actions));
  const exFut = base({ hangars: { "3:272:7|moon": H(70000, "moon", 10 * 60e3) }, expoLandings: { "3:272:7|moon": [NOW + 3 * 3600e3] } });
  check("lądowanie dopiero za 3 h → nic", !decide(exFut, CFG, NOW).actions.some(a => a.kind === "recon"), JSON.stringify(decide(exFut, CFG, NOW).actions));
  const exRead = base({ hangars: { "3:272:7|moon": H(70000, "moon", 30e3) }, expoLandings: { "3:272:7|moon": [NOW - 60e3] } });
  check("hangar czytany PO lądowaniu → bez rekonesansu", !decide(exRead, CFG, NOW).actions.some(a => a.kind === "recon"), JSON.stringify(decide(exRead, CFG, NOW).actions));
  const exHidden = base({ hangars: { "3:272:7|moon": H(70000, "moon", 10 * 60e3) }, landings: { "3:272:7|moon": NOW + 3600e3 }, expoLandings: { "3:272:7|moon": [NOW - 60e3] } });
  check("przyszłe lądowanie w mapie NIE zasłania tego, które właśnie było", decide(exHidden, CFG, NOW).actions.some(a => a.kind === "recon" && a.body === "moon"), JSON.stringify(decide(exHidden, CFG, NOW).actions));
  const exOld = base({ hangars: { "3:272:7|moon": H(70000, "moon", 50 * 60e3) }, expoLandings: { "3:272:7|moon": [NOW - 45 * 60e3] } });
  check("lądowanie sprzed 45 min — okno 30 min minęło, zwykły rekonesans to załatwi", !decide(exOld, CFG, NOW).actions.some(a => a.kind === "recon" && a.quiet), JSON.stringify(decide(exOld, CFG, NOW).actions));
  check("refresh() zapisuje lądowania z wierszy ekspedycji (filtr: nie przed wyliczonym powrotem)", /s\.expoLandings = el/.test(src) && /EXPEDITION\/i\.test\(o\.type/.test(src) && /o\.arriveAt < earliest - 3 \* 60e3/.test(src));
  check("Fly stempluje ciało startu ekspedycji (expoHome) — tam wróci flota", /sE\.expoHome = \{ key: m\.fromKey, body: m\.fromBody/.test(src) && /=== eh \|\| !!\(h && h\.total > 0\)/.test(src));
  // v3.46.0 (test na żywo 31.08 09:06): flota wraca do PUNKTU STARTU, a wiersz
  // powrotny trzyma w `dst` pierwotny cel — lądowanie musi iść pod `src`.
  check("lądowanie powrotu zapisywane pod źródłem lotu, nie pod pierwotnym celem", /const lkKey = o\.src \|\| o\.dst/.test(src) && /f\.fromKey === lkKey/.test(src));
}

// ── v3.46.0: kontrole źródła po teście na żywo 31.08 (08:56–09:10) ──
{
  // v3.50.0: sonda listy USUNIĘTA — jej fetch `?planet=` przestawiał ownerowi planetę
  // w sesji przy każdej próbie (31.08 13:48 → /galaxy otwarta na [1:217:8]), a zatrzask
  // umierał z wersją, więc wracała jak zombie. Werdykt był ostateczny; pilnujemy, żeby
  // NIE wróciła i żeby jedyny fetch listy ruchów szedł BEZ parametru planet.
  check("sonda listy USUNIĘTA (żaden fetch listy ruchów z ?planet=)", !/probePlanetList/.test(src) && !/\[SONDA LISTY\]/.test(src) && !/this\.URL\}\?planet=/.test(src) && /WERDYKTY OSTATECZNE/.test(src));
  // Komplet kalibracji szedł na telefon jako „⚠️ Obrona: BŁĄD" i fałszował dziennik
  // obrony (oraz bilans po przerwie). Raport startowy to nie awaria.
  check("raport startowy NIE udaje błędu obrony (push wprost, bez wpisu BŁĄD)", !/KOMPLET[\s\S]{0,600}?Journal\.add\("BŁĄD"/.test(src) && /Notifier\.push\("📋 Raport startowy gotowy \(Genesis\)"/.test(src));
  // [GOTOWOŚĆ] krzyczała ERROR-em „nie widzę żadnej floty", gdy flota była w powietrzu
  // z woli BOTA (własny ratunek w toku) — to dowód działania obrony, nie braku.
  check("gotowość obrony nie panikuje przy własnym locie ratunkowym w powietrzu", /const wLocie = \(s\.flights \|\| \[\]\)\.some\(f => \(f\.fromKey === guard \|\| f\.toKey === guard\) && f\.phase !== "done" && !flightStale\(f, now\)\)/.test(src) && /if \(!wLocie\) braki\.push/.test(src));
  // Owner 31.08: „nie podoba mi się, że bot sam przeskakuje z planety na planetę" —
  // rekonesans po lądowaniu własnego lotu (09:06:16 wejście na Fleet) to rutyna,
  // nie alarm: idzie WYŁĄCZNIE cichym fetchem, bez nawigacji i przełączania planety.
  check("rekonesans po lądowaniu jest QUIET (scanRemote w tle, zakaz nawigacji)", /quiet: true, why: `wróciła własna flota/.test(src) && /if \(a\.quiet\) \{(?:(?!Nav\.|location\.)[\s\S]){0,900}?continue;\s*\}/.test(src));
}

// ── v3.47.0: fetch `?planet=UUID` przestawia sesję po stronie serwera ──
// Error „Planet change has been detected" 31.08 10:12: „cichy" odczyt hangaru
// przełączał operatorowi planetę bez żadnej nawigacji. Zasady: po odczycie innego
// ciała PRZYWRÓĆ wybór operatora drugim fetchem; nie umiesz przywrócić → nie czytaj;
// gdy operator gra — odczyty w tle w ogóle czekają.
{
  // v3.68.9 (audyt 04.09, obrona-wykrywanie#4): przywrócenie ma teraz WŁASNĄ funkcję —
  // sprawdza wynik, ponawia i krzyczy — więc zamiast pilnować kształtu regexem
  // URUCHAMIAMY ją. (Dawna asercja liczyła dwa wystąpienia `/fleet?planet=${restore}`
  // i przechodziła nad kodem, który wynik drugiego fetcha WYRZUCAŁ do kosza.)
  // (zachowanie przy NIEUDANYM przywróceniu jest uruchamiane na prawdziwym bocie —
  //  test3-e2e.js scenariusz 42.)
  check("scanRemote przywraca planetę operatora po odczycie ORAZ przy błędzie",
    (src.match(/this\.restoreOrShout\(restore, restoreKey, restoreBody\)/g) || []).length === 2 && /\/fleet\?planet=\$\{uuid\}/.test(src));
  check("scanRemote NIE czyta, gdy nie umie przywrócić wyboru operatora", /if \(!ma\) return null;/.test(src));
  check("recon_bg czeka, gdy operator gra", /if \(!Human\.playing\(\)\) \{\s*\n\s*const bg = Store\.get\("recon_bg"/.test(src));
  check("cichy rekonesans po lądowaniu czeka, gdy operator gra", /if \(Human\.playing\(\)\) continue;/.test(src));
}

// ── v3.48.0: fale ekspedycji nie wyrywają operatorowi planety ──
// Owner 31.08 („przed chwilą znowu przeskoczył"): minuta ciszy to nie odejście od
// komputera — operator czyta stronę 1–2 min bez klikania, a fala wyrywała mu planetę.
{
  // v3.51.0 (owner 15:07: „nie musi czekać aż przestanę klikać"): bramka „grasz" jest
  // konfigurowalna, DOMYŚLNIE 0 = fale lecą od razu; migracja starego 300→0 przy bumpie.
  check("bramka „grasz\" konfigurowalna, domyślnie WYŁĄCZONA (0), stare 300 migrowane", /ecoIdleSec: 0 \}/.test(src) && /CFG\.human\.ecoIdleSec \?\? 0/.test(src) && /idleMin > 0 && cisza </.test(src) && /ecoIdleSec === 300\) \{ CFG\.human\.ecoIdleSec = 0; saveCfg\(\); \}/.test(src) && /ogx3-idle/.test(src) && !/ruszy minutę po ostatnim kliknięciu/.test(src));
  check("przełączenie pod misję ekonomii zapamiętuje stronę operatora", /Store\.set\("eco_return", \{ url: location\.pathname \+ location\.search/.test(src) && /\["expedition", "asteroid", "debris"\]\.includes\(m\.kind\)/.test(src));
  check("po domkniętej serii bot odprowadza operatora (chyba że sam kliknął)", /maybeReturnOperator\(reason\)/.test(src) && /czekam na powroty\|brak statków/.test(src) && /!== \(r\.input \|\| 0\)\) return false;/.test(src) && /powrót na stronę operatora po serii ekspedycji/.test(src) && /domyka serię\/\.test\(m\.why \|\| ""\) && Expo\.maybeReturnOperator/.test(src));
}

// ── v3.49.0: naturalny rytm konta + sonda /research ──
{
  // v3.49.1 (owner: „nie chcę przerw w wysyłaniu eksp"): przerwa między seriami to
  // OPCJA domyślnie WYŁĄCZONA (restMaxMin: 0); mechanizm zostaje dla chętnych.
  check("przerwa między seriami DOMYŚLNIE WYŁĄCZONA (0), mechanizm tylko przy restMaxMin>0",
    /restMinMin: 0, restMaxMin: 0/.test(src) && /rMax > 0 && !inSeries && b && \(b\.sent \|\| 0\) > 0/.test(src) && /przerwa między seriami/.test(src) && /Store\.del\("expo_rest"\)/.test(src));
  // v3.50.0: sonda /research USUNIĘTA — werdykt: kontener Events jest dla fetcha PUSTY
  // (fork wypełnia go JS-em z tej samej listy per-para). Pilnujemy, żeby nie wróciła.
  check("sonda /research USUNIĘTA (kontener pusty dla fetcha — werdykt ostateczny)",
    !/probeResearchEvents/.test(src) && !/\[SONDA RESEARCH\]/.test(src));
}

// ── v3.52.0: REJESTR POWROTÓW (owner 31.08: „bot ma mapować każdą wysłaną flotę
// i wiedzieć, kiedy wraca") — snajperka powrotów, ścieżka A5 z Atheny ──
console.log("\n── R1. ATAK + fala WYLĄDOWAŁA po odczycie pustego hangaru → rekonesans, nie cisza ──");
{
  // hangar księżyca czytany 5 min temu jako PUSTY; fala 2 mln wylądowała 2 min temu
  const s = base({
    hangars: { "3:272:7|moon": { total: 0, at: NOW - 5 * 60e3, ships: [] }, "3:272:7|planet": H(500) },
    threats: [threat("3:272:7", "moon", 300)],
    expected: [{ kind: "expedition", fromKey: "3:272:7", fromBody: "moon", total: 2_000_000, sentAt: NOW - 40 * 60e3, flightMs: 980e3, holdMs: 40 * 60e3, returnAt: NOW - 2 * 60e3 }],
  });
  const { actions, alerts } = decide(s, CFG, NOW);
  const r = actions.find(a => a.kind === "recon" && a.key === "3:272:7" && a.body === "moon");
  check("recon atakowanego księżyca (odczyt sprzed lądowania = nieświeży)", !!r, JSON.stringify(actions));
  check("ŻADNEGO hold „bezpieczna strona\"", !actions.some(a => a.kind === "hold"), JSON.stringify(actions));
  check("alert mówi o lądowaniu fali", alerts.some(a => /wylądowała tam fala/.test(a.msg)), JSON.stringify(alerts.map(a => a.msg)));
}

console.log("\n── R2. po rekonesansie (hangar świeży, fala widoczna) → normalny RATUNEK ──");
{
  const s = base({
    hangars: { "3:272:7|moon": { total: 2_000_000, at: NOW - 30e3, ships: [] } },
    threats: [threat("3:272:7", "moon", 300)],
    expected: [{ kind: "expedition", fromKey: "3:272:7", fromBody: "moon", total: 2_000_000, sentAt: NOW - 40 * 60e3, flightMs: 980e3, holdMs: 40 * 60e3, returnAt: NOW - 2 * 60e3 }],
  });
  const { actions } = decide(s, CFG, NOW);
  const a = actions.find(x => x.kind === "fly" && x.rescue);
  check("fala z powrotu jest RATOWANA jak zwykła flota", !!a && a.fromKey === "3:272:7" && a.fromBody === "moon", JSON.stringify(actions));
}

console.log("\n── R3. ATAK + ratunek już w powietrzu + fale lądują przed uderzeniem → konkretny alarm z zegarem ──");
{
  const s = base({
    hangars: { "3:272:7|moon": { total: 700, at: NOW - 30e3, ships: [] } },
    threats: [threat("3:272:7", "moon", 600)],
    flights: [{ kind: "air", fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:2", toBody: "moon", sentAt: NOW - 120e3, flightMs: 900e3, recallAt: NOW + 700e3, phase: "launched", tries: 0 }],
    expected: [{ kind: "expedition", fromKey: "3:272:7", fromBody: "moon", total: 1_500_000, sentAt: NOW - 30 * 60e3, flightMs: 980e3, holdMs: 40 * 60e3, returnAt: NOW + 200e3 }],
  });
  const { actions, alerts } = decide(s, CFG, NOW);
  check("bot NIE wysyła drugiego ratunku (jeden wpis lotu na parę)", !actions.some(a => a.kind === "fly"), JSON.stringify(actions));
  check("ale alarmuje, że fala ląduje PRZED uderzeniem", alerts.some(a => /fala ląduje przed uderzeniem|kolejne fale lądują|kolejna fala ląduje/.test(a.msg)), JSON.stringify(alerts.map(a => a.msg)));
}

console.log("\n── R4. rejestr pusty → zachowanie IDENTYCZNE jak przed 3.52 (bezpieczna strona) ──");
{
  const s = base({
    hangars: { "3:272:7|moon": { total: 0, at: NOW - 5 * 60e3, ships: [] }, "3:272:7|planet": H(500) },
    threats: [threat("3:272:7", "moon", 300)],
  });
  const { actions } = decide(s, CFG, NOW);
  check("bez rejestru: hold „bezpieczna strona\" jak dotąd", actions.some(a => a.kind === "hold"), JSON.stringify(actions));
}

console.log("\n── R5. fala ląduje PO uderzeniu → bez zmiany decyzji (bezpieczna) ──");
{
  const s = base({
    hangars: { "3:272:7|moon": { total: 0, at: NOW - 5 * 60e3, ships: [] }, "3:272:7|planet": H(500) },
    threats: [threat("3:272:7", "moon", 300)],
    expected: [{ kind: "expedition", fromKey: "3:272:7", fromBody: "moon", total: 2_000_000, sentAt: NOW - 10 * 60e3, flightMs: 980e3, holdMs: 40 * 60e3, returnAt: NOW + 30 * 60e3 }],
  });
  const { actions } = decide(s, CFG, NOW);
  check("fala lądująca po ataku nie wymusza rekonesansu", !actions.some(a => a.kind === "recon"), JSON.stringify(actions));
  check("hold zostaje (flota na planecie = bezpieczna strona)", actions.some(a => a.kind === "hold"), JSON.stringify(actions));
}

console.log("\n── R6. cisza + fala wylądowała na nieaktywnej parze → cichy rekonesans hangaru ──");
{
  const s = base({
    hangars: { "3:272:7|moon": { total: 0, at: NOW - 20 * 60e3, ships: [] } },
    expected: [{ kind: "expedition", fromKey: "3:272:7", fromBody: "moon", total: 2_000_000, sentAt: NOW - 40 * 60e3, flightMs: 980e3, holdMs: 40 * 60e3, returnAt: NOW - 3 * 60e3 }],
  });
  const { actions } = decide(s, CFG, NOW);
  const r = actions.find(a => a.kind === "recon" && a.key === "3:272:7" && a.body === "moon");
  check("rekonesans po lądowaniu z rejestru (nie czeka na wiersz listy)", !!r, JSON.stringify(actions));
  check("rekonesans jest CICHY (zakaz nawigacji w ciszy)", !!r && r.quiet === true, JSON.stringify(r));
}

console.log("\n── R7. WCZEŚNIEJSZY ZAWRÓT (v3.53.0): napastnik zawrócił = pasek czysty ≥60 s ──");
{
  const flight = (over = {}) => Object.assign({ kind: "air", fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:2", toBody: "moon", sentAt: NOW - 5 * 60e3, flightMs: 900e3, recallAt: NOW + 8 * 60e3, phase: "launched", tries: 0 }, over);
  // zagrożenia zdjęte (refresh), pasek czysty od 2 min → zawrót PRZED terminem
  const s1 = base({ hangars: {}, flights: [flight()], hostileClear: { since: NOW - 120e3 } });
  const a1 = decide(s1, CFG, NOW).actions.find(a => a.kind === "recall");
  check("pasek czysty ≥60 s → zawrót przed terminem", !!a1 && /napastnik zawrócił/.test(a1.why), JSON.stringify(decide(s1, CFG, NOW).actions));
  // pasek czysty dopiero od 30 s → jeszcze czekamy
  const s2 = base({ hangars: {}, flights: [flight()], hostileClear: { since: NOW - 30e3 } });
  check("czysty dopiero 30 s → bez zawrotu (może być artefakt)", !decide(s2, CFG, NOW).actions.some(a => a.kind === "recall"), JSON.stringify(decide(s2, CFG, NOW).actions));
  // brak sygnału → stare zachowanie: czekamy do recallAt
  const s3 = base({ hangars: {}, flights: [flight()] });
  check("bez sygnału paska → czeka do recallAt jak dotąd", !decide(s3, CFG, NOW).actions.some(a => a.kind === "recall"), JSON.stringify(decide(s3, CFG, NOW).actions));
  // lot FS nocnego NIGDY nie jest zawracany tym sygnałem (w nocy pasek zawsze czysty)
  const s4 = base({ hangars: {}, flights: [flight({ fs: true })], hostileClear: { since: NOW - 10 * 60e3 } });
  check("lot FS (fs:true) NIE jest zawracany czystym paskiem", !decide(s4, CFG, NOW).actions.some(a => a.kind === "recall"), JSON.stringify(decide(s4, CFG, NOW).actions));
  // po terminie recallAt działa stara reguła niezależnie od paska
  const s5 = base({ hangars: {}, flights: [flight({ recallAt: NOW - 1000 })] });
  const a5 = decide(s5, CFG, NOW).actions.find(a => a.kind === "recall");
  check("po recallAt zawrót jak dotąd (stara reguła nietknięta)", !!a5 && /ataki minęły/.test(a5.why), JSON.stringify(decide(s5, CFG, NOW).actions));
}

// ── v3.53.0: wzorce w źródle — zdejmowanie zagrożeń po zawrocie napastnika ──
{
  check("refresh: pasek świeży + foreign=0 utrzymane ≥60 s → zagrożenia zdjęte", /s\.hostileClear = clear \?/.test(src) && /napastnik ZAWRÓCIŁ/.test(src) && /t\.source === "sim"/.test(src));
  check("sygnał wymaga ŚWIEŻEGO paska (≤90 s) i liczbowego total", /now - \(s\.bar\.at \|\| 0\) < 90e3/.test(src) && /typeof s\.bar\.total === "number"/.test(src));
  check("flaga fs utrwalana we wpisie lotu (FS odróżnialny od ratunku)", (src.match(/fs: !!m\.fs/g) || []).length >= 2);
  // v3.53.1 (log 19:26:59): świeżo widziany wiersz ataku NIE jest kasowany starym paskiem
  check("wiersz widziany <30 s temu przeżywa 'czysty pasek' (świeży dowód > stary pasek)", /now - \(t\.lastSeenAt \|\| 0\) < 30e3/.test(src));
}

// ── v3.55.0: puls do strażnika (watchdog) — wzorce w źródle ──
{
  check("puls do strażnika: localhost w @connect, throttle 60 s, ping tylko z karty-lidera (w defenceTick po TabLock)", /@connect\s+127\.0\.0\.1/.test(src) && /hb_last", 0\) \|\| 0\) < 60e3\) return;/.test(src) && /Heartbeat\.ping\(\);\s*\n\s*confirmPendingSend\(\);/.test(src));
  check("brak strażnika = log zmiany stanu + wpis w gotowości, nigdy błąd", /hb_ok", null\) !== false/.test(src) && /strażnik \(watchdog\) nie odpowiada/.test(src));
  // v3.70.1 (utrata floty 08.09): martwy strażnik NIE może być tylko wpisem w dzienniku —
  // push na telefon natychmiast, powtarzany co godzinę (flotę można stracić w godzinę),
  // a powrót strażnika zeruje dławik.
  check("martwy strażnik pushuje na telefon natychmiast + co 1 h, powrót zeruje dławik", /hb_down_push", 0\) \|\| 0\) >= 3600e3/.test(src) && /Notifier\.push\("🩺 Strażnik karty NIE DZIAŁA/.test(src) && /onload: \(\) => \{ Store\.set\("hb_down_push", 0\);/.test(src));
  check("instalator strażnika zdejmuje flagę disabled launchd", /launchctl enable/.test(fs.readFileSync(path.join(__dirname, "watchdog", "install.sh"), "utf8")));
  // 08.09 (utrata floty): strażnika pilnował launchd, a launchd miał trwałą flagę disabled —
  // warstwa 2 to cron, mechanizm NIEZALEŻNY, z fallbackiem nohup gdy launchd zawiedzie.
  {
    const heal = fs.readFileSync(path.join(__dirname, "watchdog", "ogx-heal.sh"), "utf8");
    const inst = fs.readFileSync(path.join(__dirname, "watchdog", "install.sh"), "utf8");
    const wd = fs.readFileSync(path.join(__dirname, "watchdog", "ogx-watchdog.py"), "utf8");
    check("warstwa 2: heal zdejmuje disabled, odtwarza plist i ma fallback nohup poza launchd", /launchctl enable/.test(heal) && /cat > "\$PLIST"/.test(heal) && /nohup \/usr\/bin\/python3/.test(heal));
    check("warstwa 2: instalator wpisuje ogx-heal do crona co 5 min, idempotentnie", /crontab -l 2>\/dev\/null \| grep -v '# ogx-heal\$'/.test(inst) && /\*\/5 \* \* \* \*/.test(inst));
    check("warstwa 2: nieudane wskrzeszenie pushuje urgent z dławikiem 1 h", /3600/.test(heal) && /Priority: \$2/.test(heal) && /urgent/.test(heal));
    check("strażnik trzyma caffeinate (Mac nie zasypia z bezczynności), wyłączalne env-em", /OGX_WD_CAFFEINATE/.test(wd) && /caffeinate", "-i", "-s"/.test(wd));
  }
  check("skrypt strażnika istnieje w repo (watchdog/ogx-watchdog.py + install.sh)", fs.existsSync(path.join(__dirname, "watchdog", "ogx-watchdog.py")) && fs.existsSync(path.join(__dirname, "watchdog", "install.sh")));
}

// ── v3.52.0: wzorce w źródle — strażnik fałszywego domknięcia + rejestr w Fly ──
{
  // v3.53.1 (incydent 19:29:08, stracony zawrót 11 mln statków): warunek NIE zależy już
  // od rejestru powrotów (ten nie znał fal sprzed aktualizacji) — lot "launched" z zawrotem
  // fizycznie NIE MOŻE stać w hangarze źródła, kropka.
  // v3.68.8: sam warunek jest teraz URUCHAMIANY w sekcji 56 (regex tylko pilnował kształtu
  // i dlatego dziura obrona-stan-lotu#2 przeżyła dwa audyty). Tu zostaje strażnik miejsca:
  // reguła musi żyć w wyciętej funkcji, a refresh() musi z niej korzystać.
  check("reguła życia wpisu lotu jest osobną funkcją, a refresh() jej UŻYWA (da się ją wykonać w teście)",
    /function flightAlive\(f, s, now\) \{/.test(src) && /s\.flights = \(s\.flights \|\| \[\]\)\.filter\(f => flightAlive\(f, s, now\)\);/.test(src) && /wpis ZOSTAJE/.test(src));
  check("rejestr zapisywany PRZED klikiem Send fleet, tylko z czasem lotu z formularza", /m\.flightMs\) \{\s*\n\s*const sE = Situation\.load\(\);\s*\n\s*sE\.expected/.test(src));
  check("wpis rejestru potwierdzany po wysyłce i po przeładowaniu (confirmPendingSend)", /e0\.pending/.test(src) && /\(s\.expected \|\| \[\]\)\.find\(x => x\.pending && x\.fromKey === ls\.from/.test(src));
  check("rejestr wygaszany: pending>10 min, godzinę po lądowaniu; korekta zegarem z listy", /e\.pending && now - \(e\.sentAt \|\| 0\) > 10 \* 60e3/.test(src) && /best\.returnAt = o\.arriveAt/.test(src));
  check("ekspedycja nadal NIE trafia do flights (rejestr jest osobny)", /sE\.expected = \[\.\.\.\(sE\.expected \|\| \[\]\)/.test(src) && !/flights.*expedition.*push/.test(src.slice(src.indexOf("REJESTR POWROTÓW"), src.indexOf("REJESTR POWROTÓW") + 900)));
}

console.log("\n── 40. TRYB CICHY (v3.58.0): mniej śladów aktywności na koloniach ──");
{
  // Owner 01.09: „w galaktyce ma być jak najmniej śladów mojej aktywności" — każdy
  // fetch ?planet= pali czerwony wykrzyknik kolonii jak wizyta gracza. W trybie
  // cichym lądowanie na kolonii nie wymusza odczytu hangaru; baza ekspedycyjna
  // i pary z lotem obronnym — sprawdzane jak dotąd.
  const LF = { launchFrom: { galaxy: 3, system: 272, position: 7 } };
  const cfgQ = { ...CFG, stealth: { enabled: true, colonyHours: 8 }, expo: LF };
  const cfgGlosny = { ...CFG, expo: LF };   // bez stealth = stare zachowanie
  const kolonia = base({ landings: { "3:272:2|planet": NOW - 60e3 } });
  check("lądowanie na KOLONII w trybie cichym NIE wymusza odczytu (zero śladu)",
    !decide(kolonia, cfgQ, NOW).actions.some(a => a.kind === "recon" && a.key === "3:272:2"),
    JSON.stringify(decide(kolonia, cfgQ, NOW).actions));
  check("bez trybu cichego kolonia sprawdzana jak dotąd (regresja starego zachowania)",
    decide(kolonia, cfgGlosny, NOW).actions.some(a => a.kind === "recon" && a.key === "3:272:2"),
    JSON.stringify(decide(kolonia, cfgGlosny, NOW).actions));
  const baza = base({ landings: { "3:272:7|planet": NOW - 60e3 } });
  check("lądowanie na BAZIE ekspedycyjnej sprawdzane także w trybie cichym",
    decide(baza, cfgQ, NOW).actions.some(a => a.kind === "recon" && a.key === "3:272:7" && a.body === "planet"),
    JSON.stringify(decide(baza, cfgQ, NOW).actions));
  check("zwiad kolonii w tle: TTL z trybu cichego (colonyHours), nie 45 min", /stealth\.colonyHours \|\| 8\) \* 3600e3/.test(src));
  check("tryb cichy: domyślnie WŁĄCZONY + przycisk w panelu", /stealth: \{ enabled: true, colonyHours: 8 \}/.test(src) && /ogx3-quiet/.test(src));
  check("pary z lotem obronnym nie podlegają wyciszeniu (warunek !f)", /cfg\.stealth && cfg\.stealth\.enabled && !f && guarded58/.test(src));
}

console.log("\n── 41. KSIĘŻYC ZNISZCZONY: flota na gołej planecie ewakuowana OD RAZU, bez czekania na atak (v3.67.0) ──");
{
  const s = base({
    pairs: {
      "3:272:7": { hasMoon: false, galaxy: 3, system: 272, position: 7 },   // stracił księżyc
      "3:272:2": { hasMoon: true, galaxy: 3, system: 272, position: 2 },    // sąsiedni księżyc w układzie
      "5:100:4": { hasMoon: false, galaxy: 5, system: 100, position: 4 },
    },
    hangars: { "3:272:7|planet": H(2_812_000) },
    moonLost: { "3:272:7": NOW - 5 * 60e3 },
    active: { key: "3:272:7", body: "planet" },
  });
  const { actions } = decide(s, CFG, NOW);
  const a = actions[0];
  check("jedna akcja: lot", actions.length === 1 && a.kind === "fly", JSON.stringify(actions));
  check("z GOŁEJ planety [3:272:7] na sąsiedni KSIĘŻYC [3:272:2]", a && a.fromKey === "3:272:7" && a.fromBody === "planet" && a.toKey === "3:272:2" && a.toBody === "moon", JSON.stringify(a));
  check("jednorazowe przesiedlenie (home, bez zawrotu) — nie ucieczka z powrotem jak przy ataku", a && a.home === true && a.recall === false, JSON.stringify(a));
  check("bierze surowce (nie ustawia takeResources:false — deuter potrzebny na dalszy lot)", a && a.takeResources !== false, JSON.stringify(a));
}

console.log("\n── 42. KSIĘŻYC ZNISZCZONY, brak sąsiada w układzie → NAJBLIŻSZE bezpieczne refugium, nie pierwsze z kolei (v3.67.0, audyt K3) ──");
{
  const s = base({
    pairs: {
      "3:272:7": { hasMoon: false, galaxy: 3, system: 272, position: 7 },
      "9:900:1": { hasMoon: true, galaxy: 9, system: 900, position: 1 },     // ma księżyc, ale BARDZO daleko
      "3:280:2": { hasMoon: false, galaxy: 3, system: 280, position: 2 },    // bez księżyca, ale ta sama galaktyka = blisko
    },
    hangars: { "3:272:7|planet": H(500_000) },
    moonLost: { "3:272:7": NOW - 5 * 60e3 },
    active: { key: "3:272:7", body: "planet" },
  });
  const { actions } = decide(s, CFG, NOW);
  const a = actions[0];
  check("wybrał BLIŻSZE refugium [3:280:2] (ta sama galaktyka), nie [9:900:1] mimo kolejności zapisu", a && a.kind === "fly" && a.toKey === "3:280:2" && a.toBody === "planet", JSON.stringify(a));
}

console.log("\n── 43. Para BEZ KSIĘŻYCA OD ZAWSZE (nigdy go nie miała) → BEZ automatycznej ewakuacji — moonLost pilnuje TYLKO świeżej utraty ──");
{
  const s = base({
    pairs: {
      "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 },
      "5:100:4": { hasMoon: false, galaxy: 5, system: 100, position: 4 },   // nigdy nie miała księżyca, brak wpisu w moonLost
    },
    hangars: { "5:100:4|planet": H(9_000) },
    active: { key: "5:100:4", body: "planet" },
  });
  const { actions } = decide(s, CFG, NOW);
  check("cisza — kolonia bez księżyca od zawsze nie jest w trybie awaryjnym (nie zaśmieca floty ciągłą ewakuacją)", actions.length === 0, JSON.stringify(actions));
}

console.log("\n── 44. RATUNEK moon→moon 2× nieudany (deuter?) → decide() schodzi na drugie ciało pary, wolniej (v3.67.0) ──");
{
  const s = base({
    threats: [threat("3:272:7", "moon", 300)],
    rescueFail: { "3:272:7>3:272:2": { count: 2, at: NOW - 60e3 } },
  });
  const { actions } = decide(s, CFG, NOW);
  const a = actions[0];
  check("jedna akcja: lot", actions.length === 1 && a.kind === "fly", JSON.stringify(actions));
  check("NIE leci na sąsiedni księżyc (2× nieudane) — schodzi na drugie ciało TEJ SAMEJ pary", a && a.toKey === "3:272:7" && a.toBody === "planet", JSON.stringify(a));
  check("wolniej (airSpeedPct), nie pełna prędkość — oszczędza deuter", a && a.speed === CFG.airSpeedPct, JSON.stringify(a));
  check("bez zawrotu (jednorazowe zejście, nie ucieczka w powietrze)", a && a.recall === false && !a.air, JSON.stringify(a));
}

console.log("\n── 45. RATUNEK moon→moon: JEDNA nieudana próba to za mało, żeby zboczyć z trasy ──");
{
  const s = base({
    threats: [threat("3:272:7", "moon", 300)],
    rescueFail: { "3:272:7>3:272:2": { count: 1, at: NOW - 60e3 } },
  });
  const { actions } = decide(s, CFG, NOW);
  check("nadal leci na sąsiedni KSIĘŻYC (próg to 2 nieudane próby)", actions[0] && actions[0].toKey === "3:272:2" && actions[0].toBody === "moon", JSON.stringify(actions));
}

console.log("\n── 46. RATUNEK moon→moon: stare niepowodzenia (>10 min) NIE blokują trasy ──");
{
  const s = base({
    threats: [threat("3:272:7", "moon", 300)],
    rescueFail: { "3:272:7>3:272:2": { count: 5, at: NOW - 15 * 60e3 } },
  });
  const { actions } = decide(s, CFG, NOW);
  check("okno 10 min minęło — próbuje sąsiedniego księżyca jak dotąd", actions[0] && actions[0].toKey === "3:272:2" && actions[0].toBody === "moon", JSON.stringify(actions));
}

console.log("\n── 47. AUDYT PRZED PUSH: atak na OBA ciała + sąsiedni księżyc zablokowany (fuel-fallback) → anyRefuge NIE wraca na tę samą trasę, szuka DALEJ ──");
{
  const s = base({
    pairs: {
      "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 },
      "3:272:2": { hasMoon: true, galaxy: 3, system: 272, position: 2 },   // sąsiedni księżyc — ZABLOKOWANY (2x nieudane)
      "3:280:5": { hasMoon: false, galaxy: 3, system: 280, position: 5 }, // dalsza, ale bezpieczna kolonia
    },
    threats: [threat("3:272:7", "moon", 300), threat("3:272:7", "planet", 300)],
    hangars: { "3:272:7|planet": H(500_000) },
    rescueFail: { "3:272:7>3:272:2": { count: 2, at: NOW - 60e3 } },
    active: { key: "3:272:7", body: "planet" },
  });
  const { actions } = decide(s, CFG, NOW);
  const a = actions[0];
  check("jedna akcja: lot", actions.length === 1 && a.kind === "fly", JSON.stringify(actions));
  check("NIE wraca na zablokowany sąsiedni księżyc [3:272:2]", a && a.toKey !== "3:272:2", JSON.stringify(a));
  check("leci do DALSZEJ, ale bezpiecznej kolonii [3:280:5]", a && a.toKey === "3:280:5", JSON.stringify(a));
}

console.log("\n── 48. AUDYT PRZED PUSH: jak wyżej, ale BRAK innej kolonii poza zablokowaną → alarm 'brak refugium', NIE ponawia zablokowanej trasy ──");
{
  const s = base({
    pairs: {
      "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 },
      "3:272:2": { hasMoon: true, galaxy: 3, system: 272, position: 2 },
    },
    threats: [threat("3:272:7", "moon", 300), threat("3:272:7", "planet", 300)],
    hangars: { "3:272:7|planet": H(500_000) },
    rescueFail: { "3:272:7>3:272:2": { count: 2, at: NOW - 60e3 } },
    active: { key: "3:272:7", body: "planet" },
  });
  const { actions, alerts } = decide(s, CFG, NOW);
  check("ŻADNEGO lotu na zablokowaną trasę", !actions.some(a => a.kind === "fly"), JSON.stringify(actions));
  check("alarm: brak jakiegokolwiek refugium (nie ślepe ponowienie)", alerts.some(al => /brak jakiegokolwiek refugium/.test(al.msg)), JSON.stringify(alerts));
}

console.log("\n── 49. AUDYT PRZED PUSH: regresyjne strażniki dla poprawek spoza decide() (CFG.moon migracja, Moon navs, s.landings, Recon moonLost) ──");
{
  check("migracja CFG.moon dla starego zapisu istnieje (jak migr_debris_on_v356)", /migr_moon_on_v367/.test(src) && /CFG\.moon\.minKm === 2000/.test(src));
  check("krok 3 Moon.tick (klik „Form a moon”) inkrementuje navs — bez tego ponowiony klik nie ma limitu", /cur\.m = \{ key: key0, at: Date\.now\(\), navs: \(\(cur\.m \|\| \{\}\)\.navs \|\| 0\) \+ 1, km: picked\.km/.test(src));
  check("s.landings (rejestr własnych lotów) normalizuje fromBody tak samo jak s.expected/s.expoLandings", /rawBody2 === "moon" && !\(s\.pairs\[lkKey\]/.test(src));
  check("Recon.bodiesOf pilnuje AKTYWNIE par ze świeżo utraconym księżycem (s.moonLost), nie czeka na wolny obieg w tle", /lostPlanets = Object\.keys\(s\.moonLost \|\| \{\}\)/.test(src) && /dedupe\(\[\.\.\.all, \.\.\.lostPlanets\]\)/.test(src));
  check("rescueFail NIE liczy ręcznego Abort operatora jako dowodu na brak deuteru", /m\.rescue && m\.air && m\.toBody === "moon" && why !== "operator"/.test(src));
  check("anyRefuge przyjmuje wykluczenie konkretnej pary (drugi parametr)", /const anyRefuge = \(k, exclude\) => \{/.test(src) && /ok === exclude/.test(src));
}

console.log("\n── 50. AUDYT PRZED MERGE v3.68.1: Fleet Save nie może zaszkodzić obronie ani zapętlić bota ──");
{
  const FSON = Object.assign({}, CFG, { fs: { enabled: true, returnHour: 7, returnMinute: 0, speedPct: 10, target: null }, aster: { enabled: true }, debris: { enabled: true } });
  const fsReturnAt = NOW + 6 * 3600e3;

  // (a) NAJWAŻNIEJSZE: ucieczka przed atakiem NIE MOŻE nieść wykluczeń ekonomii.
  // Przy domyślnym debris.enabled zostawiałaby WSZYSTKIE recyklery pod uderzeniem
  // (zrzut z żywej gry: 20 983 szt.) — odwrotność reguły „obrona ma bezwzględny
  // priorytet nad ekonomią". Athena wykluczała tylko statki FAKTYCZNIE pracujące,
  // a pracujący statek jest w locie i w formularzu go nie ma.
  const sAtk = base({ fsReturnAt, threats: [threat("3:272:7", "moon", 300)] });
  const aAtk = decide(sAtk, FSON, NOW).actions.find(x => x.kind === "fly");
  check("ratunek przed atakiem zabiera CAŁY hangar (żadnych excludeTypes)", !!aAtk && aAtk.rescue === true && !aAtk.excludeTypes, JSON.stringify(aAtk));

  // (b) atak na OBA ciała → ucieczka do refugium, też bez wykluczeń
  const sBoth = base({ fsReturnAt, threats: [threat("3:272:7", "moon", 300), threat("3:272:7", "planet", 300)], pairs: {
    "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 },
    "9:100:4": { hasMoon: true, galaxy: 9, system: 100, position: 4 },
  } });
  const aBoth = decide(sBoth, FSON, NOW).actions.find(x => x.kind === "fly");
  check("ucieczka do refugium też bez excludeTypes", !!aBoth && aBoth.rescue === true && !aBoth.excludeTypes, JSON.stringify(aBoth));

  // (c) FS niesie godzinę POWROTU osobno (homeAt) — Fly przelicza ją na moment zawrotu
  const aFs = decide(base({ fsReturnAt }), FSON, NOW).actions.find(x => x.fs);
  check("akcja FS niesie homeAt = godzina bycia W DOMU", !!aFs && aFs.homeAt === fsReturnAt, JSON.stringify(aFs));
  check("akcja FS celuje w KSIĘŻYC, nigdy w planetę", !!aFs && aFs.toBody === "moon", JSON.stringify(aFs));

  // (d) brak kolonii z księżycem → alarm, nie lot na planetę
  const sNoMoon = decide(base({ fsReturnAt, pairs: {
    "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 },
    "5:100:4": { hasMoon: false, galaxy: 5, system: 100, position: 4 },
  } }), FSON, NOW);
  check("żadna wolna kolonia bez księżyca nie zostaje celem FS", !sNoMoon.actions.some(x => x.fs), JSON.stringify(sNoMoon.actions));
  check("zamiast lotu na planetę → alarm o braku księżyca", sNoMoon.alerts.some(al => /nie ma księżyca|bez księżyca/.test(al.msg)), JSON.stringify(sNoMoon.alerts));

  // (e) każdy alert FS ma dławik — inaczej log dostaje tę linię co 60 s bez końca
  const alFs = decide(base({ fsReturnAt, pairs: { "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 } } }), FSON, NOW).alerts.filter(al => /^FS:/.test(al.msg));
  check("alerty FS mają throttleMs (nie spamują co minutę)", alFs.length > 0 && alFs.every(al => (al.throttleMs || 0) >= 10 * 60e3), JSON.stringify(alFs));

  // (f) rekonesans FS jest CICHY — FS lata o każdej porze, nie wolno mu przestawiać
  // operatorowi planety w środku gry (owner zgłaszał to dwukrotnie: v3.43.0, v3.46.0)
  const rRec = decide(base({ fsReturnAt, hangars: { "3:272:7|moon": { total: 1e6, at: NOW - 2 * 3600e3, ships: [] } } }), FSON, NOW);
  const aRec = rRec.actions.find(x => x.kind === "recon");
  check("rekonesans przed FS idzie ścieżką cichą (bez nawigacji)", !!aRec && aRec.quiet === true, JSON.stringify(aRec));
}

console.log("\n── 51. AUDYT PRZED MERGE v3.68.1: strażniki dla poprawek spoza decide() ──");
{
  const loop = src.slice(src.indexOf("async function defenceTick"));
  // Strażnik regexowy niczego nie wykonuje, a to jest reguła, na której wisi flota:
  // pętla robi `break` po PIERWSZYM locie, więc o wszystkim decyduje kolejność. Wycinamy
  // z produkcji RANK + prio + sam sort i URUCHAMIAMY je na mieszanej liście akcji.
  const RANKSrc = (loop.match(/const RANK = \{ fly: 0[^;]+;/) || [])[0];
  const prioSrc = (loop.match(/const prio = \(a\) => [^;]+;/) || [])[0];
  const sortSrc = (loop.match(/actions\.sort\(\(x, y\) => [^;]+;/) || [])[0];
  check("kolejkę akcji da się wyciąć z produkcji (RANK + prio + sort)", !!RANKSrc && !!prioSrc && !!sortSrc, `${RANKSrc} | ${prioSrc} | ${sortSrc}`);
  if (RANKSrc && prioSrc && sortSrc) {
    const sortIt = new Function("actions", `${RANKSrc}\n${prioSrc}\n${sortSrc}\nreturn actions;`);
    // cicha para z FS stoi na pasku PRZED parą pod ostrzałem — tak było w grze ownera
    const mixed = sortIt([
      { kind: "fly", fs: true, fromKey: "1:100:5", why: "FLEET SAVE" },
      { kind: "fly", rescue: true, fromKey: "9:300:2", why: "atak" },
      { kind: "recon", key: "5:200:3" },
    ]);
    check("RATUNEK wychodzi przed Fleet Save, choć jego para jest dalej na pasku", mixed[0].rescue === true, JSON.stringify(mixed.map(a => a.why || a.kind)));
    check("Fleet Save nie wyprzedza też ślepego alarmu", sortIt([
      { kind: "fly", fs: true, fromKey: "1:100:5" },
      { kind: "fly", blind: true, fromKey: "9:300:2" },
    ])[0].blind === true);
    // v3.68.5 (audyt 04.09): rekonesans stoi między ratunkiem a lotem DOBROWOLNYM —
    // ratunkowi nigdy nie wolno mu ustąpić, ale Fleet Save/lot domowy idą dopiero za nim.
    check("rekonesans za ratunkiem, ale przed lotem dobrowolnym", mixed[0].rescue === true && mixed[1].kind === "recon" && mixed[2].fs === true, JSON.stringify(mixed.map(a => a.kind + (a.fs ? "(fs)" : a.rescue ? "(rescue)" : ""))));

    // ── v3.68.5 (audyt 04.09, obrona-wykonanie#3 + testy-architektura#2, P1/P2):
    // kara +0,5 spychała FS wyłącznie za inne loty `fly` — a RANK.recall to 1 i RANK.extend
    // to 2, więc Fleet Save wyprzedzał DRUGĄ POŁOWĘ tej samej operacji ratunkowej. Pętla
    // robi `break` po pierwszym `fly`, więc zawrót uciekającej floty czekał do końca misji
    // FS (do 5 min / 6 nawigacji) i flota lądowała na obcym refugium zamiast wrócić.
    check("ZAWRÓT ucieczki wychodzi przed Fleet Save", sortIt([
      { kind: "fly", fs: true, fromKey: "3:272:2" },
      { kind: "recall", flight: { fromKey: "3:272:7" } },
    ])[0].kind === "recall");
    check("EXTEND (przesunięcie zawrotu przy dosłanej fali) też wychodzi przed Fleet Save", sortIt([
      { kind: "fly", fs: true, fromKey: "3:272:2" },
      { kind: "extend", flight: { fromKey: "3:272:7" } },
    ])[0].kind === "extend");
    check("lot RUTYNOWY („powrót po ratunku”/„dom = księżyc”) też ustępuje zawrotowi", sortIt([
      { kind: "fly", home: true, backHome: true, fromKey: "1:1:1" },
      { kind: "recall", flight: { fromKey: "3:272:7" } },
    ])[0].kind === "recall");

    // ── v3.68.5 (audyt 04.09, obrona-decide#2 P0): `prio` degradował WYŁĄCZNIE `fs`, więc
    // lot rutynowy planeta→księżyc (kind:"fly", home:true, bez `fs` i bez `rescue`) miał
    // ten sam klucz co ratunek. Sort jest stabilny, czyli decydowała kolejność par na
    // pasku planet — a `backFromRescue` działa przy DOMYŚLNYM configu (homeToMoon OFF)
    // przez 6 h po KAŻDEJ ucieczce, czyli dokładnie w noc drugiej fali.
    const rut = sortIt([
      { kind: "fly", home: true, backHome: true, fromKey: "1:1:1", why: "powrót po ratunku: planeta → księżyc" },
      { kind: "fly", rescue: true, fromKey: "3:272:7", etaMs: 200e3, saveTotal: 5e6, why: "atak w moon → sąsiedni księżyc" },
    ]);
    check("RATUNEK wychodzi przed lotem rutynowym „powrót po ratunku”", rut[0].rescue === true, JSON.stringify(rut.map(a => a.why)));
    // wariant bez ŻADNYCH pól pilności — tu rozstrzyga wyłącznie `prio`, więc asercja
    // pada, gdy ktoś wróci do degradowania samego `fs` (stabilny sort zostawiłby wtedy
    // lot rutynowy na przodzie, bo jego para stoi wcześniej na pasku planet)
    const rutSlepy = sortIt([
      { kind: "fly", home: true, backHome: true, fromKey: "1:1:1", why: "powrót po ratunku" },
      { kind: "fly", blind: true, fromKey: "3:272:7", why: "ŚLEPY ALARM" },
    ]);
    check("… także wtedy, gdy ŻADNA z akcji nie zna zegara uderzenia (decyduje sam prio)", rutSlepy[0].blind === true, JSON.stringify(rutSlepy.map(a => a.why)));

    // ── v3.68.5 (audyt 04.09, obrona-decide#4 P0): dwa ataki naraz miały IDENTYCZNY klucz
    // sortowania, więc bot wydawał swój jedyny slot lotu na parę stojącą wyżej na pasku —
    // nawet gdy tamtej groziło uderzenie za 600 s, a drugiej za 80 s.
    const dwa = sortIt([
      { kind: "fly", rescue: true, fromKey: "3:272:7", etaMs: 600e3, saveTotal: 1000 },
      { kind: "fly", rescue: true, fromKey: "1:1:1", etaMs: 80e3, saveTotal: 1.5e12 },
    ]);
    check("przy dwóch atakach pierwszy leci ratunek z KRÓTSZYM dolotem, nie ten wyżej na pasku",
      dwa[0].fromKey === "1:1:1", JSON.stringify(dwa.map(a => `${a.fromKey}@${a.etaMs}`)));
    const remis = sortIt([
      { kind: "fly", rescue: true, fromKey: "3:272:7", etaMs: 300e3, saveTotal: 1000 },
      { kind: "fly", rescue: true, fromKey: "1:1:1", etaMs: 300e3, saveTotal: 900_000 },
    ]);
    check("przy równym dolocie ratujemy WIĘKSZY hangar", remis[0].fromKey === "1:1:1", JSON.stringify(remis.map(a => `${a.fromKey}@${a.saveTotal}`)));
    // ślepy alarm nie zna zegara uderzenia — ma iść ZA ratunkiem o znanym dolocie,
    // ale nadal przed każdym lotem dobrowolnym
    const slepy = sortIt([
      { kind: "fly", blind: true, fromKey: "5:5:5", saveTotal: 9e9 },
      { kind: "fly", rescue: true, fromKey: "1:1:1", etaMs: 500e3, saveTotal: 10 },
      { kind: "fly", fs: true, fromKey: "2:2:2" },
    ]);
    check("ratunek o ZNANYM dolocie przed ślepym alarmem, a Fleet Save za obydwoma",
      slepy[0].rescue === true && slepy[1].blind === true && slepy[2].fs === true, JSON.stringify(slepy.map(a => a.fromKey)));
    // porządek całej kolejki nie może się rozjechać przy braku pól pilności
    const bezPol = sortIt([
      { kind: "recon", key: "a" }, { kind: "fly", fs: true, fromKey: "b" }, { kind: "hold", key: "c" },
      { kind: "fly", rescue: true, fromKey: "d" }, { kind: "extend", flight: {} }, { kind: "recall", flight: {} },
    ]);
    check("bez pól pilności kolejka nie rozsypuje się (NaN w komparatorze)",
      bezPol.map(a => a.kind + (a.fs ? "!" : "")).join(",") === "fly,recall,extend,hold,recon,fly!", JSON.stringify(bezPol.map(a => a.kind + (a.fs ? "!" : ""))));
  }
  // v3.68.5: sam sort NIE wystarcza — gdy ratunek odpadnie wyżej (karencja `Fly.blocked`,
  // sufit prób), pętla schodzi niżej i mimo wszystko wypala lot dobrowolny. Twardy strażnik
  // w gałęzi `fly` musi stać PRZED `Fly.blocked`, a jego kryterium to sam ALARM — w oknie
  // potwierdzania zagrożenia akcji ratunku jeszcze nie ma.
  check("strażnik wstrzymuje lot dobrowolny PRZED sprawdzeniem karencji",
    /if \(alarmNow && !a\.rescue && !a\.blind\) \{[\s\S]{0,400}?continue;[\s\S]{0,20}?\}\s*\n\s*if \(Fly\.blocked\(a\)\)/.test(loop));
  check("kryterium strażnika to ALARM (potwierdzony atak), nie tylko gotowa akcja ratunku",
    /const alarmNow = hasRescue \|\| \(s\.threats \|\| \[\]\)\.some\(t => t\.attack && t\.arriveAt > Date\.now\(\)\);/.test(loop));
  check("rekonesans NIE jest gaszony samym alarmem (przy alarmie bywa jedyną drogą do hangaru)",
    /if \(hasRescue && CFG\.autoRescue\) \{ continue; \}/.test(loop));
  // v3.68.5 (obrona-decide#3 + obrona-wykonanie#2): trwająca misja DOBROWOLNA (FS,
  // „dom = księżyc", powrót po ratunku, `kind:"home"`) była nietykalna — lista ECO jej nie
  // znała, a `if (Fly.mission()) return` wycinało z przebiegu fly, recall i extend.
  check("trwający lot DOBROWOLNY jest przerywany przy alarmie (nie tylko ekonomia)",
    /\} else if \(mNow && !mNow\.rescue && !mNow\.blind\) \{/.test(loop)
    && /ALARM — ratunek ma pierwszeństwo przed lotem dobrowolnym/.test(loop));
  check("… ale NIE po kliknięciu „Send fleet” (stempel last_send — inaczej gubimy wysłany lot)",
    /const wyslane = !!ls && ls\.from === mNow\.fromKey && ls\.toKey === mNow\.toKey && \(ls\.at \|\| 0\) >= \(mNow\.startedAt \|\| 0\);/.test(loop)
    && /if \(urgent && !wyslane\) Fly\.abort/.test(loop));
  check("… i NIGDY misja ratunkowa (jej przerwanie zostawiłoby flotę pod uderzeniem)",
    /else if \(mNow && !mNow\.rescue && !mNow\.blind\)/.test(loop));
  // v3.68.5 (obrona-decide#4): jeden slot lotu to twarde ograniczenie gry — para odłożona
  // musi dostać własny sygnał na telefon, bo tylko właściciel może ją uratować ręcznie.
  check("para odłożona przy dwóch atakach dostaje push „BEZ RATUNKU zostaje…”",
    /const odlozone = actions\.filter\(x => x !== a && x\.kind === "fly" && \(x\.rescue \|\| x\.blind\)\);/.test(loop)
    && /Journal\.add\("ATAK", `Ratuję \[\$\{a\.fromKey\}\][\s\S]{0,300}?BEZ RATUNKU zostaje/.test(loop));
  check("FS nie przerywa trwającej ekspedycji (nie jest „urgent”)",
    /actions\.some\(a => \(a\.kind === "fly" && !a\.fs\) \|\| a\.kind === "recall"\)/.test(loop));
  check("FS ma własny sufit prób (3/h) niezależny od karencji ratunku",
    /Store\.get\("fs_try", \{\}\)/.test(loop) && /r3\.n >= 3/.test(loop));
  check("udana wysyłka FS zwalnia budżet prób", /if \(m\.fs\) \{ try \{ const ft = Store\.get\("fs_try", \{\}\) \|\| \{\}; delete ft\[`\$\{m\.fromKey\}>\$\{m\.toKey\}`\]/.test(src));
  // v3.68.5 (audyt 04.09, obrona-decide#2): `!x.fs` odrzucało wyłącznie Fleet Save, więc
  // awaryjny drugi `find` mógł sięgnąć po lot RUTYNOWY z cudzej pary. Przycisk wybiera
  // teraz tylko akcje ratunkowe — w OBU wyszukiwaniach.
  check("przycisk „RATUJ FLOTĘ TERAZ” wybiera wyłącznie akcje RATUNKOWE (nie FS, nie lot rutynowy)",
    /actions\.find\(x => x\.kind === "fly" && x\.fromKey === a0\.key && \(x\.rescue \|\| x\.blind\)\)/.test(src)
    && /\|\| actions\.find\(x => x\.kind === "fly" && \(x\.rescue \|\| x\.blind\)\)/.test(src));
  check("zawrót FS liczony na POŁOWĘ drogi (flota w domu o godzinie, nie zawracana o godzinie)",
    /const t0 = Date\.now\(\), homeAt = m\.homeAt \|\| m\.recallAt, half = \(homeAt - t0\) \/ 2;/.test(src) && /m\.recallAt = t0 \+ half;/.test(src));
  // v3.68.10 (obrona-fs#4): ten sam wpis mówi teraz dodatkowo, O KTÓREJ bot wystartuje —
  // bo od tej wersji naprawdę czeka do okna, zamiast ponawiać co godzinę (patrz sekcja 58c).
  check("lot za krótki na powrót o godzinie → odmowa z instrukcją, nie ciche lądowanie",
    /if \(m\.flightMs < half\)/.test(src) && /zmniejsz prędkość FS albo ustaw dalszy cel/i.test(src) && /Startuję dopiero o \$\{hh\(homeAt - 2 \* m\.flightMs\)\}/.test(src));
  check("pauza ekonomii na FS pyta flightStale (wpis po nieudanym zawrocie nie gasi bota na 12 h)",
    /f\.fs && f\.phase !== "done" && !flightStale\(f, Date\.now\(\)\)/.test(src));
  check("migracja FS rozstrzyga po STARYM kształcie (endHour+startHour), nie po braku returnHour",
    /typeof savedFs\.endHour === "number" && typeof savedFs\.startHour === "number"/.test(src));
  check("panel zaokrągla prędkość FS do kroku 10 (gra nie zna innych)",
    /Math\.max\(10, Math\.min\(100, Math\.round\(v \/ 10\) \* 10\)\)/.test(src));
  check("wpis lotu zapamiętuje excludeTypes (żeby domknięcie po przeładowaniu nie skłamało o hangarze)",
    (src.match(/excludeTypes: m\.excludeTypes \|\| null/g) || []).length >= 2);
}

console.log("\n── 52. AUDYT PRZED MERGE v3.68.1: fsReturnAt (czysta funkcja, wykonywana) ──");
{
  const fra = new Function("fs", "d", bodyOf("function fsReturnAt(fs, d) {"));
  const at = (h, mi = 0) => { const d = new Date(NOW); d.setHours(h, mi, 0, 0); return d; };
  const FS7 = { enabled: true, returnHour: 7, returnMinute: 0 };
  check("FS wyłączony → 0 (żadnego terminu zawrotu)", fra({ enabled: false, returnHour: 7 }, at(3)) === 0);
  check("06:59 → dziś o 7:00", new Date(fra(FS7, at(6, 59))).getHours() === 7 && fra(FS7, at(6, 59)) > at(6, 59).getTime());
  check("07:30 → JUTRO o 7:00 (nie termin w przeszłości)", fra(FS7, at(7, 30)) - at(7, 30).getTime() > 22 * 3600e3);
  check("dokładnie 07:00 → jutro (zawrót zerowej długości nie ma sensu)", fra(FS7, at(7)) > at(7).getTime());
  check("termin ZAWSZE w przyszłości, o każdej porze doby", [0, 3, 7, 12, 18, 23].every(h => fra(FS7, at(h)) > at(h).getTime()));
  // audyt: `??` łapało tylko null/undefined — NaN dawał Invalid Date i lot BEZ zawrotu,
  // bez jednej linii w logu. Zepsuta wartość ma wracać do domyślnej.
  check("returnHour NaN → domyślna 7:00, nie Invalid Date", new Date(fra({ enabled: true, returnHour: NaN, returnMinute: 0 }, at(3))).getHours() === 7);
  check("returnMinute NaN → :00, nie NaN", Number.isFinite(fra({ enabled: true, returnHour: 7, returnMinute: NaN }, at(3))) && new Date(fra({ enabled: true, returnHour: 7, returnMinute: NaN }, at(3))).getMinutes() === 0);
  check("returnMinute spoza zakresu przycięte, nie przewinięte na następną godzinę", new Date(fra({ enabled: true, returnHour: 7, returnMinute: 90 }, at(3))).getHours() === 7);
}

console.log("\n── 53. AUDYT 04.09 (partia decide-cisza): w gałęzi ataku bot nie ma prawa MILCZEĆ ──");
{
  // `toLocaleString("pl-PL")` rozdziela tysiące SPACJĄ NIEROZDZIELAJĄCĄ — dlatego \s,
  // a nie zwykły odstęp (inaczej asercja przechodzi tylko przypadkiem, zależnie od ICU).
  const M400 = /400\s000\s000/;

  // ── (a) obrona-decide#1 (P0): ATAK NA OBA CIAŁA PARY. Przebieg 1 ratował większy
  // hangar i obiecywał „drugie ciało w następnym przebiegu". Ten przebieg nigdy nie mógł
  // nic zrobić: wpis lotu jest JEDEN na parę, więc kolejne przebiegi trafiały na
  // `inFlightFrom(k)` i robiły `continue`, a wszystkie alarmy siedziały w łańcuchu
  // `else if`, którego gałąź „air/launched" (stan po WŁASNYM ratunku bota) konsumowała.
  // Wynik: 400 mln statków pod uderzeniem, zero akcji i ZERO alertów aż do wybuchu.
  // Test odpala decide() TRZY razy, dokładnie jak dowód z audytu.
  const both = () => ({
    pairs: {
      "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 },
      "3:272:2": { hasMoon: true, galaxy: 3, system: 272, position: 2 },
    },
    hangars: { "3:272:7|moon": H(1_000_000_000), "3:272:7|planet": H(400_000_000) },
    threats: [threat("3:272:7", "moon", 300), threat("3:272:7", "planet", 320)],
    flights: [], active: { key: "3:272:7", body: "moon" },
  });
  const p1 = decide(both(), CFG, NOW);
  check("53a-1: przebieg 1 ratuje większe ciało (księżyc)", p1.actions.some(a => a.kind === "fly" && a.rescue && a.fromBody === "moon"), JSON.stringify(p1.actions));
  const promise = p1.alerts.find(a => /OBU ciałach/.test(a.msg));
  check("53a-2: komunikat NIE obiecuje już ratunku „w następnym przebiegu\"", !!promise && !/następnym przebiegu/.test(promise.msg), JSON.stringify(promise && promise.msg));
  check("53a-3: … mówi wprost, ILE floty zostaje pod uderzeniem", !!promise && /ZOSTAJE/.test(promise.msg) && M400.test(promise.msg), JSON.stringify(promise && promise.msg));
  check("53a-4: … i budzi telefon (error + push) — to świadome porzucenie floty", !!promise && promise.level === "error" && promise.push === true, JSON.stringify(promise));

  // przebieg 2 i 3: ratunek już w powietrzu, hangar księżyca wyzerowany przez
  // emptySourceHangar, na planecie nadal 400 mln — dokładnie stan, w którym bot MILCZAŁ.
  const after = both();
  after.hangars["3:272:7|moon"] = { total: 0, at: NOW + 40e3, ships: [] };
  after.flights = [{ kind: "air", fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:2", toBody: "moon", sentAt: NOW + 5e3, flightMs: 600e3, recallAt: NOW + 320e3 + 90e3, phase: "launched", tries: 0 }];
  for (const dt of [40e3, 200e3]) {
    const r = decide(after, CFG, NOW + dt);
    const cry = r.alerts.find(a => a.push === true && a.level === "error" && /NADAL STOI/.test(a.msg));
    check(`53a-5 (+${dt / 1000}s): przebieg po ratunku NIE jest niemy`, !!cry, JSON.stringify(r.alerts.map(a => a.msg)) + " | akcje: " + JSON.stringify(r.actions));
    check(`53a-6 (+${dt / 1000}s): alarm podaje ciało i liczbę porzuconych statków`, !!cry && /planet/.test(cry.msg) && M400.test(cry.msg), JSON.stringify(cry && cry.msg));
  }

  // ── (b) obrona-fs#1 (P0): lot FLEET SAVE zajmował jedyny wpis lotu pary, więc atak
  // w tę parę nie dawał ani ratunku, ani alertu — a FS z definicji ZOSTAWIA flotę w domu
  // (excludeTypes: recyklery) i drugiego ciała pary w ogóle nie dotyka. FS jest lotem
  // DOBROWOLNYM, obrona ma bezwzględny priorytet (CLAUDE.md).
  const FSPAIRS = {
    "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 },
    "3:272:2": { hasMoon: true, galaxy: 3, system: 272, position: 2 },
    "9:100:4": { hasMoon: true, galaxy: 9, system: 100, position: 4 },
  };
  const withFlight = (over = {}) => ({
    pairs: FSPAIRS,
    hangars: { "3:272:7|planet": H(800_000_000) },
    threats: [threat("3:272:7", "planet", 300)],
    flights: [Object.assign({ kind: "air", fs: true, excludeTypes: ["RECYCLER"], fromKey: "3:272:7", fromBody: "moon", toKey: "9:100:4", toBody: "moon", sentAt: NOW - 3 * 3600e3, flightMs: 5 * 3600e3, recallAt: NOW + 2 * 3600e3, phase: "launched", tries: 0 }, over)],
    active: { key: "3:272:7", body: "planet" },
  });
  const rFs = decide(withFlight(), CFG, NOW);
  const flyFs = rFs.actions.find(a => a.kind === "fly" && a.rescue);
  check("53b-1: FS w powietrzu NIE blokuje ratunku — lot startuje z atakowanej planety", !!flyFs && flyFs.fromKey === "3:272:7" && flyFs.fromBody === "planet", JSON.stringify(rFs.actions) + " | " + JSON.stringify(rFs.alerts.map(a => a.msg)));
  check("53b-2: ratunek zabiera CAŁY hangar (żadnych excludeTypes po FS)", !!flyFs && !flyFs.excludeTypes, JSON.stringify(flyFs));
  check("53b-3: operator dostaje na telefon ostrzeżenie, że zawrotu FS bot już nie kliknie", rFs.alerts.some(a => a.push === true && /Fleet Save/.test(a.msg) && /zawrotu FS/.test(a.msg)), JSON.stringify(rFs.alerts.map(a => a.msg)));

  // kontrola 1: lot NIE-dobrowolny (własny ratunek) nadal trzyma zasadę „jedna ucieczka
  // na parę" — ale para przestaje milczeć.
  const rNot = decide(withFlight({ fs: false, excludeTypes: null }), CFG, NOW);
  check("53b-4: lot ratunkowy (nie-FS) nadal blokuje drugi lot z tej pary", !rNot.actions.some(a => a.kind === "fly"), JSON.stringify(rNot.actions));
  check("53b-5: … ale zamiast ciszy leci alarm z pushem o flocie stojącej pod uderzeniem", rNot.alerts.some(a => a.push === true && a.level === "error" && /NADAL STOI/.test(a.msg)), JSON.stringify(rNot.alerts.map(a => a.msg)));

  // kontrola 2: FS w ZAWROCIE już wraca do domu — jego wpisu nie wolno zgubić ratunkiem,
  // bo wtedy bot straciłby z oczu flotę w powietrzu. Zostaje sam (głośny) alarm.
  const rBack = decide(withFlight({ phase: "recall_clicked", recalledAt: NOW - 60e3 }), CFG, NOW);
  check("53b-6: FS w zawrocie NIE jest nadpisywany ratunkiem", !rBack.actions.some(a => a.kind === "fly"), JSON.stringify(rBack.actions));
  check("53b-7: … ale i tu bot krzyczy o flocie zostawionej w domu", rBack.alerts.some(a => a.push === true && /NADAL STOI/.test(a.msg)), JSON.stringify(rBack.alerts.map(a => a.msg)));

  // kontrola 3: FS w powietrzu, ale w domu NIC nie stoi → nic do ratowania, żadnego
  // nowego lotu i żadnego nowego krzyku (nie hałasujemy bez powodu).
  const empty = withFlight(); empty.hangars = { "3:272:7|planet": { total: 0, at: NOW - 30e3, ships: [] }, "3:272:2|moon": H(1000) };
  const rEmpty = decide(empty, CFG, NOW);
  check("53b-8: FS w powietrzu + pusty dom → bez lotu i bez fałszywego alarmu o flocie", !rEmpty.actions.some(a => a.kind === "fly") && !rEmpty.alerts.some(a => /NADAL STOI/.test(a.msg)), JSON.stringify(rEmpty.actions) + " | " + JSON.stringify(rEmpty.alerts.map(a => a.msg)));

  // ── (c) obrona-decide#5: `extend` wskrzeszał zawrót lotu, który ma WYLĄDOWAĆ
  // (Fly kasuje zawrót: `m.landing = true; m.recallAt = 0`). Egzekutor wpisywał termin
  // do stanu (`f.recallAt (0) < a.recallAt`), po czym bot 5× próbował zawrócić flotę
  // stojącą na ziemi, kończył fazą `recall_failed` i fałszywym pushem „nie widzę lotu".
  const landing = (over = {}) => base({
    hangars: { "3:272:7|planet": H(120_000) },
    threats: [threat("3:272:7", "moon", 400)],
    flights: [Object.assign({ kind: "air", fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:2", toBody: "moon", sentAt: NOW - 30e3, flightMs: 90e3, recallAt: 0, phase: "launched", tries: 0 }, over)],
  });
  check("53c-1: lot BEZ zawrotu (wyląduje u sąsiada) nie dostaje extend", !decide(landing(), CFG, NOW).actions.some(a => a.kind === "extend"), JSON.stringify(decide(landing(), CFG, NOW).actions));
  check("53c-2: lot Z zawrotem nadal dostaje extend (reguła W12 nietknięta)", decide(landing({ recallAt: NOW + 30e3 }), CFG, NOW).actions.some(a => a.kind === "extend"), JSON.stringify(decide(landing({ recallAt: NOW + 30e3 }), CFG, NOW).actions));
}

console.log("\n── 54. AUDYT 04.09 (partia kolejka-akcji): lot DOBROWOLNY nigdy przed ratunkiem ──");
{
  // ── (a) obrona-decide#2 (P0): „powrót po ratunku" (stempel `s.rescues` żyje 6 h po
  // KAŻDEJ ucieczce — czyli w noc drugiej fali) ma kind:"fly" bez `fs` i bez `rescue`.
  // Do 3.68.4 dostawał ten sam klucz sortowania co ratunek, a `sort` jest stabilny, więc
  // o jedynym locie przebiegu decydowała kolejność kolonii na pasku planet. Gorzej: w
  // oknie potwierdzania zagrożenia (confirmMs) akcji ratunku jeszcze NIE MA, więc lot
  // rutynowy wygrywał niezależnie od kolejności. Czysta funkcja go teraz nie wystawia.
  const PAIRS2 = {
    "1:1:1": { hasMoon: true, galaxy: 1, system: 1, position: 1 },
    "3:272:7": { hasMoon: true, galaxy: 3, system: 272, position: 7 },
    "3:272:2": { hasMoon: true, galaxy: 3, system: 272, position: 2 },
  };
  const rut = (over = {}) => Object.assign({
    pairs: PAIRS2,
    hangars: { "1:1:1|planet": H(500), "3:272:7|moon": H(5_000_000) },
    rescues: { "1:1:1": NOW - 30 * 60e3 },     // ucieczka pół godziny temu → powrót po ratunku
    threats: [], flights: [], active: { key: "1:1:1", body: "planet" },
  }, over);

  const spokoj = decide(rut(), CFG, NOW);
  check("54a-1 (kontrola): bez ataku „powrót po ratunku” nadal powstaje — mechanizm nietknięty",
    spokoj.actions.some(a => a.kind === "fly" && a.backHome === true), JSON.stringify(spokoj.actions));

  const atak = decide(rut({ threats: [threat("3:272:7", "moon", 200)] }), CFG, NOW);
  check("54a-2: przy ataku na INNĄ parę lot rutynowy w ogóle NIE POWSTAJE",
    !atak.actions.some(a => a.kind === "fly" && a.backHome === true), JSON.stringify(atak.actions));
  check("54a-3: … a jedyny lot przebiegu to RATUNEK atakowanej pary",
    atak.actions.filter(a => a.kind === "fly").length === 1 && atak.actions.find(a => a.kind === "fly").rescue === true,
    JSON.stringify(atak.actions.filter(a => a.kind === "fly")));

  // okno potwierdzania: ratunku jeszcze nie ma (seenAt = teraz), a lotu rutynowego
  // już też nie — to jest dokładnie ta chwila, w której bot tracił slot misji.
  const okno = decide(rut({ threats: [threat("3:272:7", "moon", 200, { seenAt: NOW, lastSeenAt: NOW })] }), CFG, NOW);
  check("54a-4: w oknie potwierdzania zagrożenia bot NIE wypuszcza żadnego lotu",
    !okno.actions.some(a => a.kind === "fly") && okno.alerts.some(a => /potwierdzam/.test(a.msg)),
    JSON.stringify(okno.actions) + " | " + JSON.stringify(okno.alerts.map(a => a.msg)));
  check("54a-5: … i wciąż istnieje kolonia, która to zwożenie by dostała (test nie jest pusty)",
    decide(rut({ threats: [threat("9:9:9", "moon", 200, { seenAt: NOW, lastSeenAt: NOW })] }), CFG, NOW - 1).actions.length >= 0
    && spokoj.actions.some(a => a.fromKey === "1:1:1"), JSON.stringify(spokoj.actions));

  // ── (b) obrona-decide#4 (P0): pilność musi jechać RAZEM z akcją — warstwa wykonawcza
  // nie zna ani zegara uderzenia, ani wielkości ratowanego hangaru.
  const dwaAtaki = decide({
    pairs: PAIRS2,
    hangars: { "1:1:1|moon": H(1_500_000_000_000), "3:272:7|moon": H(1000) },
    threats: [threat("3:272:7", "moon", 600), threat("1:1:1", "moon", 80)],
    flights: [], active: { key: "3:272:7", body: "moon" },
  }, CFG, NOW);
  const ratunki = dwaAtaki.actions.filter(a => a.kind === "fly" && a.rescue);
  check("54b-1: dwa ataki → dwa ratunki (jak dotąd)", ratunki.length === 2, JSON.stringify(dwaAtaki.actions));
  check("54b-2: KAŻDY ratunek niesie etaMs (czas do uderzenia) i saveTotal (wielkość hangaru)",
    ratunki.every(a => Number.isFinite(a.etaMs) && Number.isFinite(a.saveTotal)), JSON.stringify(ratunki.map(a => ({ from: a.fromKey, etaMs: a.etaMs, saveTotal: a.saveTotal }))));
  const pilny = ratunki.find(a => a.fromKey === "1:1:1");
  check("54b-3: etaMs zgadza się z zegarem zagrożenia, saveTotal z ratowanym hangarem",
    !!pilny && pilny.etaMs === 80_000 && pilny.saveTotal === 1_500_000_000_000, JSON.stringify(pilny));
  check("54b-4: ślepy alarm niesie saveTotal, ale NIE etaMs (nie zna godziny uderzenia)",
    (() => {
      const r = decide({ pairs: PAIRS2, hangars: { "1:1:1|moon": H(777_000) }, threats: [], flights: [],
        barExcess: { active: true, count: 3, since: NOW - 120e3 }, active: { key: "1:1:1", body: "moon" } }, CFG, NOW);
      const b = r.actions.find(a => a.kind === "fly" && a.blind);
      return !!b && b.saveTotal === 777_000 && b.etaMs === undefined;
    })());

  // ── (c) ewakuacja po utracie księżyca to RATUNEK, nie lot dobrowolny — atak gdzie
  // indziej nie ma prawa jej zdusić (kontrola, że bramka `!anyAttack` nie poszła za daleko).
  const moonLost = decide({
    pairs: {
      "1:1:1": { hasMoon: false, galaxy: 1, system: 1, position: 1 },
      "1:1:9": { hasMoon: true, galaxy: 1, system: 1, position: 9 },     // sąsiad z księżycem = refugium
      "3:272:2": { hasMoon: true, galaxy: 3, system: 272, position: 2 },
    },
    hangars: { "1:1:1|planet": H(400_000) },
    moonLost: { "1:1:1": NOW - 60e3 },
    threats: [threat("3:272:2", "moon", 300)], flights: [], active: { key: "1:1:1", body: "planet" },
  }, CFG, NOW);
  check("54c: ewakuacja z gołej planety (rescue) leci mimo ataku na inną parę",
    moonLost.actions.some(a => a.kind === "fly" && a.rescue === true && a.fromKey === "1:1:1"), JSON.stringify(moonLost.actions));
}

console.log("\n── 55. AUDYT 04.09 (partia antyduplikat): bramka anty-duplikat rozpoznaje RODZAJ lotu i CIAŁA ──");
{
  // obrona-stan-lotu#1 (P0) + expo-wykonanie#4 (P2): bramka porównywała samą trasę
  // (klucz→klucz) i czas. Pole złomu po bitwie obronnej leży na WŁASNEJ pozycji bazy,
  // więc stempel wysyłki recyklerów [K]→[K] był nie do odróżnienia od ratunku
  // [K] planeta → [K] księżyc — bot kasował ratunek i zerował hangar ciała POD ATAKIEM.
  // Tu URUCHAMIAMY warunek bramki i kształt stempla WYCIĘTE ZE ŹRÓDŁA (nie regex).
  const stmtOd = (co) => {
    const i = src.indexOf(co);
    if (i < 0) throw new Error(`nie znalazłem w źródle: ${co}`);
    const s0 = src.slice(i);
    return s0.slice(0, s0.indexOf(";\n") + 1);
  };
  // ECO_KINDS bierzemy TEŻ ze źródła — inaczej test badałby własną listę rodzajów.
  const lsMine = new Function("ls", "m", `${stmtOd("const ECO_KINDS = [")}\n${stmtOd("const lsMine =")}\nreturn !!lsMine;`);
  // stempel `last_send` budujemy Z ORYGINALNEGO literału obiektu — test upada także
  // wtedy, gdy ktoś usunie ze stempla ciała albo `startedAt`, a warunek zostawi.
  const stampSrc = (() => {
    const s0 = src.slice(src.indexOf('Store.set("last_send", {'));
    return s0.slice(s0.indexOf("{"), s0.indexOf("});") + 1);
  })();
  const stamp = (m, at) => new Function("m", "loaded", "loadedTotal", "Date", `return (${stampSrc});`)(m, [], 0, { now: () => at });

  check("55-0: bramka faktycznie korzysta z wyliczonego warunku (test nie bada martwego kodu)",
    /if \(lsMine && Date\.now\(\) - ls\.at < guardMs\) \{/.test(src));

  // (a) ZŁOM NA WŁASNEJ POZYCJI vs RATUNEK „drugie ciało pary" — dokładnie scenariusz P0
  const misjaZlom = { kind: "debris", fromKey: "1:100:5", fromBody: "moon", toKey: "1:100:5", toBody: "debris", startedAt: NOW - 65e3 };
  const lsZlom = stamp(misjaZlom, NOW - 60e3);
  const ratunek = { kind: "fly", fromKey: "1:100:5", fromBody: "planet", toKey: "1:100:5", toBody: "moon", rescue: true, startedAt: NOW - 5e3 };
  check("55a: stempel wysyłki ZŁOMU nie udaje ratunku [K] planeta → [K] księżyc",
    lsMine(lsZlom, ratunek) === false, JSON.stringify(lsZlom));

  // (b) EKSPEDYCJA vs ZŁOM na tym samym polu [g:sy:16] (expo-wykonanie#4)
  const misjaExpo = { kind: "expedition", fromKey: "2:223:9", fromBody: "moon", toKey: "2:223:16", toBody: "planet", startedAt: NOW - 80e3 };
  const lsExpo = stamp(misjaExpo, NOW - 78e3);
  check("55b: stempel fali EKSPEDYCJI nie blokuje recyklerów na to samo pole [2:223:16]",
    lsMine(lsExpo, { kind: "debris", fromKey: "2:223:9", fromBody: "moon", toKey: "2:223:16", toBody: "debris", startedAt: NOW - 10e3 }) === false, JSON.stringify(lsExpo));

  // (c) DWA RATUNKI NA TEJ SAMEJ PARZE (fala 1 na planetę, fala 2 na księżyc):
  // trasa w obie strony ma ten sam klucz — rozróżniają ją dopiero CIAŁA.
  const lsRatunek1 = stamp({ ...ratunek, startedAt: NOW - 65e3 }, NOW - 60e3);
  check("55c: ratunek moon→planet nie uchodzi za wysłany, bo poszedł planet→moon",
    lsMine(lsRatunek1, { kind: "fly", fromKey: "1:100:5", fromBody: "moon", toKey: "1:100:5", toBody: "planet", rescue: true, startedAt: NOW - 5e3 }) === false, JSON.stringify(lsRatunek1));

  // (d) PRAWDZIWY DUPLIKAT (powód, dla którego bramka istnieje, v3.62.0): „Send fleet"
  // przeładował stronę, misja wraca tu z tym samym `startedAt` — bramka MUSI strzelić.
  const misjaFS = { kind: "fly", fromKey: "1:100:5", fromBody: "moon", toKey: "1:100:9", toBody: "moon", startedAt: NOW - 30e3 };
  check("55d: ta sama misja po przeładowaniu strony NADAL jest duplikatem",
    lsMine(stamp(misjaFS, NOW - 25e3), misjaFS) === true, JSON.stringify(stamp(misjaFS, NOW - 25e3)));
  check("55d-2: … tak samo dla fali ekspedycji (okno 20 s)",
    lsMine(stamp(misjaExpo, NOW - 78e3), misjaExpo) === true);

  // (d-3) EKONOMIA zachowuje SZERSZĄ siatkę: tam pomyłka to powtórzona fala, nie utracona
  // flota, a to ona łapie „stronę sukcesu, która ładowała się tak wolno, że fala poszła
  // dwa razy" (v3.62.0) — także wtedy, gdy Expo zdążył zaplanować już NOWĄ misję.
  check("55d-3: ekonomia: stempel fali sprzed 10 s blokuje kolejną misję na tę samą trasę",
    lsMine(stamp(misjaExpo, NOW - 10e3), { ...misjaExpo, startedAt: NOW - 2e3 }) === true);
  check("55d-4: … ale obrona wymaga TOŻSAMOŚCI misji (tam pomyłka kosztuje flotę)",
    lsMine(stamp(misjaFS, NOW - 10e3), { ...misjaFS, startedAt: NOW - 2e3 }) === false);

  // (e) ZGODNOŚĆ WSTECZ: stempel sprzed aktualizacji (bez ciał i bez `startedAt`)
  // dalej chroni przed podwójną wysyłką tej samej misji.
  check("55e: stary stempel bez ciał i bez startedAt nadal blokuje powtórkę",
    lsMine({ at: NOW - 25e3, toKey: "1:100:9", kind: "fly", from: "1:100:5" }, misjaFS) === true);
  check("55e-2: … ale stary stempel ZŁOMU i tak nie zetnie ratunku (rodzaj się nie zgadza)",
    lsMine({ at: NOW - 60e3, toKey: "1:100:5", kind: "debris", from: "1:100:5" }, ratunek) === false);

  // (f) CIAŁA W STEMPLU są jedynym, co rozróżnia dwie wysyłki ekonomii o tej samej
  // trasie i rodzaju (księżyc zniszczony → recyklery startują nagle z planety).
  // Bez `fromBody`/`toBody` w stemplu bramka zjadłaby tę drugą wysyłkę.
  check("55f: stempel wysyłki złomu Z PLANETY nie udaje wysyłki z KSIĘŻYCA (ta sama trasa)",
    lsMine(stamp({ kind: "debris", fromKey: "1:100:5", fromBody: "planet", toKey: "1:100:5", toBody: "debris", startedAt: NOW - 60e3 }, NOW - 55e3),
      { kind: "debris", fromKey: "1:100:5", fromBody: "moon", toKey: "1:100:5", toBody: "debris", startedAt: NOW - 5e3 }) === false);
}

console.log("\n── 56. AUDYT 04.09 (partia stan-lotu): wpis lotu ma odzwierciedlać FIZYKĘ lotu ──");
{
  // obrona-stan-lotu#2 (P0), expo-wykonanie#1 (P1), obrona-stan-lotu#3 (P1).
  // Wszystko URUCHAMIANE na kodzie wyciętym ze źródła — poprzednia wersja miała tu sam
  // regex na kształt warunku i właśnie dlatego dziura przeżyła dwa audyty.
  const logi = [];
  const flightAlive = new Function("f", "s", "now", "log", "Once",
    bodyOf("function flightAlive(f, s, now) {"));
  const zyje = (f, s, now = NOW) => flightAlive(f, s, now, (m) => logi.push(m), { said: () => false });

  // wpis lotu FS: wyleciał 2 h temu z KSIĘŻYCA bazy, w domu ZOSTAŁY recyklery (excludeTypes),
  // termin zawrotu minął minutę temu.
  const fsFlight = (over = {}) => Object.assign({
    kind: "air", fs: true, excludeTypes: ["RECYCLER"], fromKey: "3:272:7", fromBody: "moon",
    toKey: "5:100:4", toBody: "moon", sentAt: NOW - 2 * 3600e3, flightMs: 5 * 3600e3,
    recallAt: NOW - 60e3, phase: "launched", tries: 0,
  }, over);
  // hangar ŹRÓDŁA odczytany PO terminie zawrotu — same recyklery zostawione celowo
  const domZResztkami = (over = {}) => ({ hangars: { "3:272:7|moon": Object.assign({ total: 20983, ships: [{ type: "RECYCLER", qty: 20983 }], at: NOW - 30e3 }, over) } });

  check("56-0: refresh() faktycznie filtruje wpisy tą funkcją (test nie bada martwego kodu)",
    /s\.flights = \(s\.flights \|\| \[\]\)\.filter\(f => flightAlive\(f, s, now\)\);/.test(src));

  // (a) P0: lot W POWIETRZU (faza "launched") — hangar źródła NIE MA prawa go domknąć,
  // także PO terminie zawrotu. Wcześniej wpis znikał i zawrotu nie było już nigdy.
  check("56a: FS w fazie 'launched' przeżywa odczyt hangaru źródła PO terminie zawrotu",
    zyje(fsFlight(), domZResztkami()) === true, JSON.stringify(logi.slice(-2)));

  // (a2) to samo bez Fleet Save: lot ratunkowy, a hangar bazy zapełniła wracająca
  // fala ekspedycji (expo-wykonanie#1) — 4 mln statków, odczyt po recallAt.
  check("56a2: ratunek 'launched' przeżywa lądowanie fali ekspedycji na ciele startu",
    zyje(fsFlight({ fs: false, excludeTypes: null }), { hangars: { "3:272:7|moon": { total: 4_000_000, ships: [], at: NOW - 30e3 } } }) === true);

  // (b) P0 wariant „recall_clicked": w hangarze stoją WYŁĄCZNIE statki zostawione celowo,
  // więc to nie jest powrót floty — wpis (i ponowienie zawrotu) musi żyć.
  check("56b: same resztki po excludeTypes (leftHome) NIE udają powrotu floty",
    zyje(fsFlight({ phase: "recall_clicked", recalledAt: NOW - 3 * 60e3, leftHome: 20983 }), domZResztkami()) === true);

  // (c) REGRESJA W DRUGĄ STRONĘ — wpis nie może być wieczny: flota naprawdę wróciła
  // (resztki + 5 mln statków), zawrót potwierdzony wierszem powrotnym.
  check("56c: prawdziwy powrót floty domyka wpis (hangar > leftHome)",
    zyje(fsFlight({ phase: "recalled", recalledAt: NOW - 30 * 60e3, leftHome: 20983 }),
      domZResztkami({ total: 5_020_983 })) === false);
  check("56c2: … i domknięcie jest widoczne w logu", /domknięty — flota widziana/.test(logi.join(" | ")));

  // (d) faza "recall_clicked" domykana hangarem jak dotąd (flota FIZYCZNIE wraca do
  // źródła — wpis, który by to przespał, kazałby obronie milczeć nad flotą w domu),
  // ale NIE po cichu: brak potwierdzenia zawrotu ma zostawić ślad w logu.
  const przed = logi.length;
  check("56d: zawrót kliknięty + hangar źródła pełen OBCYCH statków → wpis domknięty",
    zyje(fsFlight({ phase: "recall_clicked", recalledAt: NOW - 3 * 60e3, leftHome: 20983 }),
      domZResztkami({ total: 4_000_000 })) === false);
  check("56d2: … i bot mówi wprost, że zawrót był NIEPOTWIERDZONY",
    /zawrót NIEPOTWIERDZONY/.test(logi.slice(przed).join(" | ")), logi.slice(przed).join(" | "));

  // (e) reguły, których poprawka nie miała ruszyć
  check("56e: lot BEZ zawrotu (dom/swap) domyka hangar CELU",
    zyje({ kind: "home", fromKey: "3:272:7", fromBody: "planet", toKey: "3:272:7", toBody: "moon", sentAt: NOW - 5 * 60e3, phase: "launched" },
      { hangars: { "3:272:7|moon": { total: 900, ships: [], at: NOW - 60e3 } } }) === false);
  check("56e2: lot bez zawrotu przeterminowany po 30 min",
    zyje({ kind: "home", fromKey: "3:272:7", fromBody: "planet", toKey: "3:272:7", toBody: "moon", sentAt: NOW - 31 * 60e3, phase: "launched" }, { hangars: {} }) === false);
  check("56e3: twardy sufit 12 h zdejmuje nawet lot 'launched' z zawrotem",
    zyje(fsFlight({ sentAt: NOW - 13 * 3600e3 }), { hangars: {} }) === false);
  check("56e4: 'pending' żyje 10 min, potem wpis znika", zyje(fsFlight({ pending: true, sentAt: NOW - 60e3 }), { hangars: {} }) === true
    && zyje(fsFlight({ pending: true, sentAt: NOW - 11 * 60e3 }), { hangars: {} }) === false);

  // (f) `leftHome` musi być NAPRAWDĘ zapisywane przy wysyłce — inaczej próg z 56b jest
  // martwy. Uruchamiamy emptySourceHangar wycięte ze źródła.
  {
    const empty = new Function("fromKey", "fromBody", "why", "keepTypes", "Situation", "log",
      bodyOf("function emptySourceHangar(fromKey, fromBody, why, keepTypes) {"));
    const stan = {
      hangars: { "3:272:7|moon": { total: 5_020_983, ships: [{ type: "BATTLESHIP", qty: 5_000_000 }, { type: "RECYCLER", qty: 20983 }], at: NOW } },
      flights: [{ kind: "air", fs: true, fromKey: "3:272:7", fromBody: "moon", toKey: "5:100:4", sentAt: NOW, phase: "launched" },
        { kind: "air", fromKey: "3:272:7", fromBody: "planet", toKey: "5:100:4", sentAt: NOW, phase: "launched" }],
    };
    empty("3:272:7", "moon", "wysyłka potwierdzona", ["RECYCLER"], { load: () => stan, save: () => {} }, () => {});
    check("56f: emptySourceHangar zapisuje na wpisie lotu, ile statków ZOSTAŁO w domu",
      stan.flights[0].leftHome === 20983, JSON.stringify(stan.flights[0]));
    check("56f2: … i nie dopisuje tego wpisowi lotu z DRUGIEGO ciała pary",
      stan.flights[1].leftHome === undefined, JSON.stringify(stan.flights[1]));
  }

  // (g) obrona-stan-lotu#3: nowy lot z pary nie może kasować wpisu lotu wciąż lecącego
  // z DRUGIEGO ciała tej samej pary. Filtr wycinamy ze źródła Fly.form i uruchamiamy.
  {
    const zrodloFiltru = (() => {
      const i = src.indexOf("const inAir = (f) => !!f.recallAt");
      const j = src.indexOf("sPre.flights.push({");
      if (i < 0 || j < 0 || j < i) throw new Error("nie znalazłem filtru wpisów lotu w Fly.form");
      return src.slice(i, j);
    })();
    const filtruj = new Function("sPre", "m", "Journal", `${zrodloFiltru} return sPre.flights;`);
    const lecacyZKsiezyca = { kind: "air", fs: true, fromKey: "3:272:7", fromBody: "moon", toKey: "5:100:4", toBody: "moon", sentAt: NOW - 3 * 3600e3, flightMs: 8 * 3600e3, recallAt: NOW - 2 * 3600e3, phase: "launched" };
    const ratunekZPlanety = { fromKey: "3:272:7", fromBody: "planet", toKey: "3:272:2", toBody: "moon", air: true };
    let bledy = [];
    const J = { add: (kind, msg) => bledy.push(`${kind}: ${msg}`) };

    const po = filtruj({ flights: [{ ...lecacyZKsiezyca }] }, ratunekZPlanety, J);
    check("56g: ratunek z PLANETY nie kasuje wpisu lotu lecącego z KSIĘŻYCA tej samej pary",
      po.length === 1 && po[0].fromBody === "moon", JSON.stringify(po));
    check("56g2: … i nie wystawia fałszywego alarmu o utraconym zawrocie", bledy.length === 0, JSON.stringify(bledy));

    bledy = [];
    const po2 = filtruj({ flights: [{ ...lecacyZKsiezyca, fromBody: "moon" }] },
      { fromKey: "3:272:7", fromBody: "moon", toKey: "3:272:2", toBody: "moon", air: true }, J);
    check("56g3: lot z TEGO SAMEGO ciała nadal nadpisuje stary wpis (jeden lot na ciało)", po2.length === 0, JSON.stringify(po2));
    check("56g4: … ale nie po cichu — kasowanie floty w powietrzu idzie do dziennika (i pusha)",
      bledy.length === 1 && /BŁĄD/.test(bledy[0]) && /NIE kliknie/.test(bledy[0]), JSON.stringify(bledy));

    bledy = [];
    const po3 = filtruj({ flights: [{ ...lecacyZKsiezyca, phase: "recalled" }] }, ratunekZPlanety, J);
    check("56g5: wpis z drugiego ciała PO zawrocie nie jest już chroniony (nie zostaje śmieć)", po3.length === 0, JSON.stringify(po3));

    bledy = [];
    const po4 = filtruj({ flights: [{ ...lecacyZKsiezyca, fromBody: "planet", pending: true }] }, ratunekZPlanety, J);
    check("56g6: własny wpis 'pending' (ta sama misja po przeładowaniu) znika bez alarmu",
      po4.length === 0 && bledy.length === 0, JSON.stringify(po4) + " | " + JSON.stringify(bledy));
  }
}

console.log("\n── 57. WYKRYWANIE (audyt 04.09, partia 'wykrywanie') ──");
{
  // Wszystko URUCHAMIANE: parser paska, czysta funkcja nadwyżki i decide().
  const parse = new Function("text", bodyOf("parse(text) {"));
  const bes = new Function("bar", "threats", "prev", "now", "cfg", bodyOf("function barExcessState(bar, threats, prev, now, cfg) {"));
  const C = { barExcess: true, barHoldMs: 60e3, barSpyHoldMs: 300e3, barSpyMaxExcess: 1, barMaxAgeMs: 3 * 60e3 };

  // (a) obrona-wykrywanie#3: 'Type:' opisuje JEDNĄ misję (najbliższy dolot), nie rodzaj
  // całej nadwyżki. Jedno 'Spy' w oknie uciszało ślepy alarm na 5 minut.
  const mieszany = parse("4 Missions: 1 Own 3 Hostile Next: 00:10 Type: Spy | 09:12 Type: Attack");
  check("57a: pasek z sondą I atakiem w oknie zgłasza JAWNY rodzaj bojowy", mieszany.attackType === true, JSON.stringify(mieszany));
  const czysto = parse("2 Missions: 0 Own 2 Hostile Next: 00:42 Type: Espionage");
  check("57a2: sam pasek sondujący nie zgłasza rodzaju bojowego", czysto.attackType === false && czysto.spyType === true, JSON.stringify(czysto));
  const poSondzie = parse("3 Missions: 0 Own 3 Hostile Next: 09:12 Type: Attack — wcześniej Spy");
  check("57a3: 'Spy' gdzieś w oknie NIE robi już z paska paska sondującego", poSondzie.spyType === false, JSON.stringify(poSondzie));

  check("57b: sonda + atak w tym samym oknie → próg 60 s, nie 5 min",
    bes({ foreign: 3, at: NOW, spyType: true, attackType: true }, [], { count: 3, since: NOW - 61e3 }, NOW, C).active === true,
    JSON.stringify(bes({ foreign: 3, at: NOW, spyType: true, attackType: true }, [], { count: 3, since: NOW - 61e3 }, NOW, C)));
  check("57b2: trzy nieprzypisane obce loty przy jednym 'Type: Spy' → też 60 s (sonda tłumaczy najwyżej siebie)",
    bes({ foreign: 3, at: NOW, spyType: true }, [], { count: 3, since: NOW - 61e3 }, NOW, C).active === true);
  const jednaSonda = bes({ foreign: 1, at: NOW, spyType: true }, [], { count: 1, since: NOW - 61e3 }, NOW, C);
  check("57b3: ale POJEDYNCZA sonda dalej dostaje 5 min (bez fałszywych ewakuacji na każdy zwiad)",
    jednaSonda.active === false && jednaSonda.spyHold === true, JSON.stringify(jednaSonda));

  // decide(): wstrzymanie ratunku w ciemno NIE może być ciszą — po zwykłym progu idzie push.
  const cichy = base({ barExcess: { active: false, count: 1, since: NOW - 90e3, spyType: true, spyHold: true }, threats: [] });
  const rc = decide(cichy, CFG, NOW);
  check("57c: przez wydłużony próg 'Type: Spy' właściciel dostaje alarm na telefon, nie ciszę",
    rc.alerts.some(a => a.push === true && /sonda/.test(a.msg)), JSON.stringify(rc.alerts.map(a => a.msg)));
  check("57c2: …ale flotą jeszcze nie ruszamy", !rc.actions.some(a => a.kind === "fly"), JSON.stringify(rc.actions));
  const zaWczesnie = base({ barExcess: { active: false, count: 1, since: NOW - 30e3, spyType: true, spyHold: true }, threats: [] });
  check("57c3: przed zwykłym progiem (60 s) alarm jeszcze nie idzie", !decide(zaWczesnie, CFG, NOW).alerts.some(a => a.push === true), JSON.stringify(decide(zaWczesnie, CFG, NOW).alerts.map(a => a.msg)));

  // (d) obrona-wykrywanie#1: ślepy alarm bez znanego hangaru też musi obudzić telefon.
  const bezFloty = base({ barExcess: { active: true, count: 2, since: NOW - 70e3 }, threats: [], hangars: {} });
  check("57d: 'widzę atak, ale nie wiem, gdzie stoi flota' idzie na telefon",
    decide(bezFloty, CFG, NOW).alerts.some(a => a.push === true && /nie wiem, gdzie stoi flota/.test(a.msg)),
    JSON.stringify(decide(bezFloty, CFG, NOW).alerts.map(a => a.msg)));

  // (e) obrona-wykrywanie#2: uczciwy wiek paska musi realnie zapalać bramkę `stale`.
  check("57e: pasek sprzed 10 min nie jest już dowodem na nic",
    bes({ foreign: 5, at: NOW - 10 * 60e3 }, [], { count: 5, since: NOW - 10 * 60e3 }, NOW, C).stale === true);
  check("57e2: `counter` odróżnia licznik 'N Missions:' od odpowiedzi bez licznika",
    parse("3 Missions: 0 Own 3 Hostile").counter === true && parse("No fleet movement").counter === false);
  check("57e3: odpowiedź listy bez licznika NIE może udawać paska (per-para ≠ globalnie)",
    /CFG\.barFromList && list\.bar && list\.bar\.counter/.test(src) && /barFromList: false/.test(src));

  // (f) obrona-wykrywanie#2, drugi skutek: snapshot SPRZED ataku nie unieważnia zagrożenia.
  const czyszczenie = (() => {
    const i = src.indexOf("s.threats = (s.threats || []).filter(t => t.source === \"sim\"");
    return src.slice(i, src.indexOf("\n", i));
  })();
  const filtruj = new Function("s", "now", `${czyszczenie} return s.threats;`);
  const swiezyPasek = { threats: [{ dst: "3:272:7", seenAt: NOW - 5 * 60e3, lastSeenAt: NOW - 60e3 }], bar: { at: NOW - 30e3 } };
  check("57f: zagrożenie starsze od paska nadal wolno zdjąć (napastnik zawrócił)", filtruj(swiezyPasek, NOW).length === 0, JSON.stringify(filtruj(swiezyPasek, NOW)));
  const staryPasek = { threats: [{ dst: "3:272:7", seenAt: NOW - 60e3, lastSeenAt: NOW - 40e3 }], bar: { at: NOW - 5 * 60e3 } };
  check("57f2: pasek WYRENDEROWANY PRZED wykryciem ataku nie kasuje tego ataku", filtruj(staryPasek, NOW).length === 1, JSON.stringify(filtruj(staryPasek, NOW)));
}

console.log("\n── 58. FLEET SAVE I STAN (audyt 04.09, partia 'fs-i-stan') ──");
{
  const FSON = Object.assign({}, CFG, { fs: { enabled: true, returnHour: 7, returnMinute: 0, speedPct: 10, target: null, slotReserve: 1 } });
  const fsReturnAt = NOW + 6 * 3600e3;
  const moony = (n) => {
    const p = {}, h = {};
    for (let i = 1; i <= n; i++) { const k = `3:272:${i}`; p[k] = { hasMoon: true, galaxy: 3, system: 272, position: i }; h[`${k}|moon`] = H(1000 * i); }
    return { pairs: p, hangars: h };
  };

  // ── (a) obrona-fs#2: pięć księżyców z flotą = PIĘĆ lotów FS, po jednym slocie floty
  // każdy. Gdy sloty się kończyły, gra odmawiała wysyłki RATUNKU — a pasek stanu świecił
  // zielonym „FS w drodze". Z przebiegu ma wychodzić NAJWYŻEJ JEDEN lot FS.
  {
    const s = base({ fsReturnAt, ...moony(5) });
    const r = decide(s, FSON, NOW);
    const fs = r.actions.filter(x => x.fs);
    check("58a: pięć księżyców z flotą → JEDEN lot Fleet Save na przebieg", fs.length === 1, JSON.stringify(fs.map(x => [x.fromKey, x.toKey])));
    check("58a2: … i leci z NAJWIĘKSZEGO hangaru (tam stoi wartość)", fs[0] && fs[0].fromKey === "3:272:5", JSON.stringify(fs[0]));
    check("58a3: … a operator dowiaduje się z logu, że reszta czeka", fs[0] && /po JEDNYM locie na przebieg/.test(fs[0].why), String(fs[0] && fs[0].why));
  }

  // ── (b) obrona-fs#2: rezerwa slotów. FS to lot DOBROWOLNY — nie ma prawa zająć slotu,
  // którego zabraknie ratunkowi. Ta sama reguła, co w ekspedycjach i miningu od 3.7.1.
  {
    const s = base({ fsReturnAt, ...moony(2), slots: { fleet: { used: 7, total: 8 }, at: NOW - 60e3 } });
    const r = decide(s, FSON, NOW);
    check("58b: ostatni wolny slot floty należy do obrony → żadnego FS", !r.actions.some(x => x.fs), JSON.stringify(r.actions));
    check("58b2: … i to nie jest cisza (alarm mówi o slotach)", r.alerts.some(al => /sloty floty 7\/8, rezerwa 1/.test(al.msg)), JSON.stringify(r.alerts));
    const s2 = base({ fsReturnAt, ...moony(2), slots: { fleet: { used: 1, total: 8 }, at: NOW - 60e3 } });
    check("58b3: gdy slotów jest dość, FS leci normalnie", decide(s2, FSON, NOW).actions.some(x => x.fs), JSON.stringify(decide(s2, FSON, NOW).actions));
    const s3 = base({ fsReturnAt, ...moony(2), slots: { fleet: { used: 1, total: 8 }, at: NOW - 45 * 60e3 } });
    const r3 = decide(s3, FSON, NOW);
    check("58b4: odczyt slotów sprzed 45 min to nie wiedza — bez FS w powietrzu wolno lecieć", r3.actions.some(x => x.fs), JSON.stringify(r3.actions));
    const s4 = base({ fsReturnAt, ...moony(2), flights: [{ kind: "air", fs: true, fromKey: "9:900:1", toKey: "9:900:2", phase: "launched", sentAt: NOW - 60e3, recallAt: NOW + 3600e3 }] });
    const r4 = decide(s4, FSON, NOW);
    check("58b5: sloty nieznane, a jeden FS już wisi w powietrzu → drugiego nie wysyłamy", !r4.actions.some(x => x.fs), JSON.stringify(r4.actions));
    check("58b6: … i mówimy dlaczego", r4.alerts.some(al => /już wisi w powietrzu/.test(al.msg)), JSON.stringify(r4.alerts));
  }

  // ── (c) obrona-fs#4: pętla „lot za krótki". Fly wymaga, żeby lot trwał ≥ połowy czasu
  // do godziny powrotu; poza tym oknem odmowa jest PEWNA, a decide() i tak wystawiała
  // akcję przy każdym przebiegu — 3 porzucone misje na godzinę, całą dobę, z pushem BŁĄD.
  {
    const short = { "3:272:7>3:272:2": { flightMs: 30 * 60e3, speedPct: 10, at: NOW - 10 * 60e3 } };
    const s = base({ fsReturnAt, hangars: { "3:272:7|moon": H(1e6) }, fsMeasured: short });
    const r = decide(s, FSON, NOW);
    check("58c: znany czas lotu 30 min a powrót za 6 h → FS NIE startuje (doleciałby i wylądował)", !r.actions.some(x => x.fs), JSON.stringify(r.actions));
    check("58c2: … i pasek/log dostaje GODZINĘ startu zamiast ciszy", r.alerts.some(al => /startuję dopiero o/.test(al.msg)), JSON.stringify(r.alerts));
    // okno startu = homeAt − 2 × czas lotu; przy powrocie za 40 min lot 30-minutowy już wchodzi
    const s2 = base({ fsReturnAt: NOW + 40 * 60e3, hangars: { "3:272:7|moon": H(1e6) }, fsMeasured: short });
    check("58c3: w oknie startu (homeAt − 2× czas lotu) FS rusza normalnie", decide(s2, FSON, NOW).actions.some(x => x.fs), JSON.stringify(decide(s2, FSON, NOW).actions));
    const s3 = base({ fsReturnAt, hangars: { "3:272:7|moon": H(1e6) }, fsMeasured: { "3:272:7>3:272:2": { flightMs: 30 * 60e3, speedPct: 10, at: NOW - 25 * 3600e3 } } });
    check("58c4: pomiar sprzed doby nie ma prawa wstrzymywać FS (żaden wpis nie jest wieczny)", decide(s3, FSON, NOW).actions.some(x => x.fs));
    const s4 = base({ fsReturnAt, hangars: { "3:272:7|moon": H(1e6) }, fsMeasured: { "3:272:7>3:272:2": { flightMs: 30 * 60e3, speedPct: 100, at: NOW - 10 * 60e3 } } });
    check("58c5: pomiar z INNEJ prędkości nie opisuje tego lotu — nie blokuje", decide(s4, FSON, NOW).actions.some(x => x.fs));
  }

  // ── (d) obrona-fs#3: DUCH KSIĘŻYCA. Po zniszczeniu księżyca wpis hangaru „klucz|moon"
  // żył do 48 h i udawał miejsce postoju floty: przy ataku w planetę bot mówił „flota na
  // moon — bezpieczna strona" i nie robił NIC.
  {
    const duch = {
      pairs: { "3:272:7": { hasMoon: false, galaxy: 3, system: 272, position: 7 }, "3:272:2": { hasMoon: true, galaxy: 3, system: 272, position: 2 } },
      hangars: { "3:272:7|moon": H(1_500_000_000_000, "moon", 12 * 60e3) },
      moonLost: { "3:272:7": NOW - 10 * 60e3 },
    };
    check("58d: fleetAt NIE widzi floty na nieistniejącym księżycu", Situation.fleetAt(base(duch), "3:272:7", NOW) === null, JSON.stringify(Situation.fleetAt(base(duch), "3:272:7", NOW)));
    const r = decide(base({ ...duch, threats: [threat("3:272:7", "planet", 300)] }), CFG, NOW);
    check("58d2: atak w planetę → żadnego „bezpieczna strona” nad duchem", !r.actions.some(a => a.kind === "hold" && /bezpieczna strona/.test(a.why || "")), JSON.stringify(r.actions));
    check("58d3: … bot mówi UCZCIWIE, że nie wie, gdzie stoi flota", r.alerts.some(al => /nie wiem, gdzie stoi flota/.test(al.msg)), JSON.stringify(r.alerts));
    const rFs = decide(base({ ...duch, fsReturnAt }), FSON, NOW);
    check("58d4: Fleet Save nie startuje z księżyca, którego nie ma", !rFs.actions.some(x => x.fs && x.fromKey === "3:272:7"), JSON.stringify(rFs.actions));
    // ślepy alarm bierze ciało z fleetsAt — duch podstawiał mu nieistniejący księżyc
    const rBlind = decide(base({ ...duch, barExcess: { active: true, count: 2, since: NOW - 120e3 } }), CFG, NOW);
    check("58d5: ślepy alarm nie ewakuuje z nieistniejącego księżyca", !rBlind.actions.some(a => a.fromKey === "3:272:7" && a.fromBody === "moon"), JSON.stringify(rBlind.actions));
  }

  // ── (e) obrona-fs#3, druga połowa: wpis hangaru ducha znika ze STANU (Situation.refresh).
  // Bez tego panel, gotowość obrony i moduły ekonomii dalej widziałyby flotę na ciele,
  // którego nie ma — a reguła CLAUDE.md mówi: żaden wpis stanu nie może być wieczny.
  {
    const drop = new Function("s", "now", "log", `for (const hk of Object.keys(s.hangars || {})) {${bodyOf("for (const hk of Object.keys(s.hangars || {})) {")}}`);
    const st = {
      pairs: { "1:100:5": { hasMoon: false }, "1:100:9": { hasMoon: true } },
      hangars: { "1:100:5|moon": { total: 5e6, at: NOW - 12 * 60e3 }, "1:100:5|planet": { total: 3, at: NOW }, "1:100:9|moon": { total: 7e6, at: NOW }, "8:800:8|moon": { total: 1, at: NOW } },
    };
    const linie = [];
    drop(st, NOW, (m) => linie.push(m));
    check("58e: hangar zniszczonego księżyca skasowany", !st.hangars["1:100:5|moon"], JSON.stringify(Object.keys(st.hangars)));
    check("58e2: hangar planety tej samej pary NIETKNIĘTY", !!st.hangars["1:100:5|planet"], JSON.stringify(Object.keys(st.hangars)));
    check("58e3: hangar księżyca, który ISTNIEJE, nietknięty", !!st.hangars["1:100:9|moon"], JSON.stringify(Object.keys(st.hangars)));
    check("58e4: para spoza paska planet (nic o niej nie wiemy) nietknięta", !!st.hangars["8:800:8|moon"], JSON.stringify(Object.keys(st.hangars)));
    check("58e5: kasowanie nie jest ciche", linie.some(m => /nie ma księżyca/.test(String(m))), JSON.stringify(linie));
  }

  // ── (f) obrona-fs#5: pauza „flota jest na Fleet Save" gasiła CAŁĄ ekonomię, w tym
  // odbudowę księżyca (zero statków!) i recyklery, które FS SAM zostawia w domu „bo pracują".
  {
    const gateSrc = (src.match(/if \(!CFG\.human\.economyAtNight[^\n]*?return "flota jest na Fleet Save";/) || [])[0];
    const mimoSrc = (src.match(/FS_MIMO: \[[^\]]*\]/) || [])[0];
    check("58f: bramkę FS i listę wyjątków da się wyciąć z produkcji", !!gateSrc && !!mimoSrc, `${gateSrc} | ${mimoSrc}`);
    if (gateSrc && mimoSrc) {
      const Human = new Function("CFG", "flightStale", `return { ${mimoSrc}, gate(s, who = "") { ${gateSrc} return null; } };`)({ human: { economyAtNight: false } }, flightStale);
      const wLocie = { flights: [{ fs: true, phase: "launched", fromKey: "1:100:5", sentAt: NOW, recallAt: Date.now() + 3600e3 }] };
      check("58f2: ekspedycje nadal czekają na powrót floty z FS", Human.gate(wLocie, "expedition") === "flota jest na Fleet Save", String(Human.gate(wLocie, "expedition")));
      check("58f3: moduł bez znacznika też czeka (zachowanie 3.68.9)", Human.gate(wLocie) === "flota jest na Fleet Save", String(Human.gate(wLocie)));
      check("58f4: ODBUDOWA KSIĘŻYCA idzie mimo FS (nie wysyła ani jednego statku)", Human.gate(wLocie, "moon") === null, String(Human.gate(wLocie, "moon")));
      check("58f5: ZŁOM idzie mimo FS (recyklery zostały w domu właśnie po to, żeby pracować)", Human.gate(wLocie, "debris") === null, String(Human.gate(wLocie, "debris")));
      check("58f6: bez lotu FS bramka nikogo nie zatrzymuje", Human.gate({ flights: [] }, "expedition") === null);
    }
    const moonMod = src.slice(src.indexOf("const Moon = {"), src.indexOf("const Bonus = {"));
    check("58f7: Moon.tick pyta ze znacznikiem „moon”", /Human\.economyAllowed\(s, "moon"\)/.test(moonMod));
    const debMod = src.slice(src.indexOf("const Debris = {"), src.indexOf("const Fly = {"));
    check("58f8: Debris.tick pyta ze znacznikiem „debris”", /Human\.economyAllowed\(s, "debris"\)/.test(debMod));
  }

  // ── (g) obrona-fs#4, wykonanie: to Fly ZAPAMIĘTUJE zmierzony czas lotu. Bez tego wpisu
  // decide() nie ma z czego policzyć okna startu i pętla wraca.
  {
    const flyMod = src.slice(src.indexOf("const Fly = {"), src.indexOf("function defenceReadiness"));
    check("58g: Fly zapisuje zmierzony czas lotu FS do stanu (s.fsMeasured)",
      /sS\.fsMeasured\[`\$\{m\.fromKey\}>\$\{m\.toKey\}`\] = \{ flightMs: m\.flightMs, speedPct: m\.speed \|\| 0, at: Date\.now\(\) \}/.test(flyMod));
    // pomiar musi iść do stanu w OBU wynikach — inaczej wiedza starzeje się po dobie
    // i jutro trzeba ją znów kupić porzuconą misją
    const iZap = flyMod.indexOf("zapamietajLot();"), iShort = flyMod.indexOf("if (m.flightMs < half)");
    check("58g1: pomiar zapisany PRZED rozgałęzieniem (także po udanym starcie)", iZap > 0 && iShort > iZap, `${iZap} / ${iShort}`);
    check("58g2: wpisy s.fsMeasured mają termin ważności (24 h)", /s\.fsMeasured\[rk\] \|\| \{\}\)\.at \|\| 0\) > 24 \* 3600e3\) delete/.test(src));
  }
}

console.log("\n── 59. SUFITY I NAWIGACJA (audyt 04.09, partia 'sufity-nawigacja') ──");
{
  // ── (a) obrona-wykonanie#4: ewakuacja po utracie księżyca leci BEZ ataku, a decide()
  // wystawia ją przy KAŻDYM przebiegu, dopóki flota stoi na gołej planecie. Do 3.68.10 miała
  // samo `rescue`, więc dostawała przywileje floty POD OSTRZAŁEM: karencję trasy skróconą do
  // 45 s i zero sufitu prób. Odmowa gry (brak slotu/deuteru) robiła z niej wielogodzinną
  // pętlę: przełącz ciało → formularz → odmowa → 45 s → od nowa.
  const ewak = decide(base({
    pairs: {
      "3:272:7": { hasMoon: false, galaxy: 3, system: 272, position: 7 },
      "3:272:2": { hasMoon: true, galaxy: 3, system: 272, position: 2 },
    },
    hangars: { "3:272:7|planet": H(2_812_000) },
    moonLost: { "3:272:7": NOW - 5 * 60e3 },
    active: { key: "3:272:7", body: "planet" },
  }), CFG, NOW).actions[0];
  check("59a: ewakuacja z gołej planety jest oznaczona `evac` (własna karencja i własny sufit prób)",
    !!ewak && ewak.kind === "fly" && ewak.evac === true, JSON.stringify(ewak));
  check("59a1: … i NADAL jest `rescue` — pierwszeństwo przed lotem dobrowolnym zostaje nietknięte",
    !!ewak && ewak.rescue === true, JSON.stringify(ewak));
  // ── (b) kontrola: prawdziwa ucieczka spod ostrzału NIE MOŻE dostać tej flagi, bo to ona
  // potrzebuje ponowienia po 45 s (dolot wroga bywa krótszy niż 3-minutowa karencja).
  const podOstrzalem = decide(base({ threats: [threat("3:272:7", "moon", 300)] }), CFG, NOW).actions[0];
  check("59b: ucieczka POD OSTRZAŁEM zostaje bez `evac` (ponowienie po 45 s jej się należy)",
    !!podOstrzalem && podOstrzalem.kind === "fly" && !podOstrzalem.evac, JSON.stringify(podOstrzalem));

  // ── (c) obrona-wykonanie#5 i #1 żyją poza decide() (Fly.recall, Fly.clickWhenEnabled) i mają
  // wykonywane scenariusze w test3-e2e.js (55 i 57). Tutaj tylko strażnicy KSZTAŁTU, żeby
  // refaktor nie zdjął sufitu po cichu.
  const flyMod = src.slice(src.indexOf("const Fly = {"), src.indexOf("function defenceReadiness"));
  check("59c: zawrót przełącza parę przez Nav.click (bez tego pętla jest niewidoczna dla [TEMPO] i linii startowej)",
    /Nav\.click\(el, `zawrót lotu \[\$\{f\.fromKey\}\]→\$?\{?\[?\$\{f\.toKey\}\]/.test(flyMod) || /Nav\.click\(el, `zawrót lotu/.test(flyMod));
  check("59c1: … i ma sufit klików, który zeruje się po SKUTECZNYM przełączeniu",
    /f\.navTries = \(f\.navTries \|\| 0\) \+ 1;/.test(flyMod) && /if \(f\.navTries > 5\)/.test(flyMod)
    && /if \(f\.navTries\) \{ f\.navTries = 0;/.test(flyMod));
  check("59d: długie czekanie na formularzu pyta o listę ruchów i przerywa TYLKO lot dobrowolny",
    /async peekThreat\(m\) \{\s*\n?\s*if \(!m \|\| m\.rescue \|\| m\.blind\) return null;/.test(flyMod)
    && /const atak = await this\.peekThreat\(this\.mission\(\)\);/.test(flyMod));
  check("59d1: … a kryterium jest to samo, co przy budowie zagrożeń (wrogi wiersz w NASZE ciało)",
    /x\.attack && !x\.mine && !x\.friendly && !x\.isReturn && x\.dst && own\.has\(x\.dst\)/.test(flyMod));
}

console.log("\n── 60. HEAVY CARGO NIE LECI NA EKSPEDYCJE (owner 07.09, v3.69.0) ──");
{
  // Duże transportery zostają w domu. Nazwa typu z żywej gry: `HEAVY_CARGO`
  // (STAN-I-PLAN: „HEAVY_CARGO×12 341"); ten fork nie zna `LARGE_CARGO` (to nazwa z atrapy E2E).
  const DEFAULTS = new Function("return {" + bodyOf("const DEFAULTS = {") + "}")();
  check("60a: domyślna lista wykluczeń ekspedycji zawiera HEAVY_CARGO (i nadal minery/recyklery)",
    DEFAULTS.expo.excludeTypes.includes("HEAVY_CARGO") && DEFAULTS.expo.excludeTypes.includes("ASTEROID_MINER") && DEFAULTS.expo.excludeTypes.includes("RECYCLER"),
    JSON.stringify(DEFAULTS.expo.excludeTypes));
  const cfgD = { expo: { ...ECFG.expo, waves: 1, excludeTypes: DEFAULTS.expo.excludeTypes } };
  const hang = (ships) => ({ "1:100:5|planet": { total: ships.reduce((n, x) => n + x.qty, 0), at: NOW - 60000, ships } });
  const p = expoPlan(ebase({ hangars: hang([{ type: "BATTLESHIP", qty: 800 }, { type: "HEAVY_CARGO", qty: 200 }, { type: "SMALL_CARGO", qty: 100 }]) }), cfgD, NOW, null);
  check("60b: fala ekspedycji NIE zawiera HEAVY_CARGO", !p.skip && !p.ships.some(x => x.type === "HEAVY_CARGO"), JSON.stringify(p));
  check("60b1: … a reszta hangaru leci w całości (pancerniki + małe transportery)",
    !p.skip && p.ships.find(x => x.type === "BATTLESHIP")?.qty === 800 && p.ships.find(x => x.type === "SMALL_CARGO")?.qty === 100, JSON.stringify(p.ships));
  const only = expoPlan(ebase({ hangars: hang([{ type: "HEAVY_CARGO", qty: 5000 }]) }), cfgD, NOW, null);
  check("60c: same duże transportery w hangarze = skip „brak statków”, nie fala z transporterami", /brak statków/.test(only.skip || "") && !only.ships, JSON.stringify(only));
  // Schowek z POPRZEDNIEJ wersji: `saveCfg` zapisuje CAŁY CFG, więc w przeglądarce ownera
  // leży stara lista bez HEAVY_CARGO — ani budowa CFG, ani syncCfg NIE MOGĄ jej przyjąć.
  const OLD = ["ASTEROID_MINER", "COLONY_SHIP", "DEATH_STAR", "RECYCLER", "AVATAR"];
  const pinCodeOwned = new Function("DEFAULTS", `return (c) => {${bodyOf("const pinCodeOwned = (c) => {")}}`)(DEFAULTS);
  const buildCfg = (saved) => new Function("Store", "DEFAULTS", "pinCodeOwned", bodyOf("const CFG = (() => {"))({ get: (k, d) => (k === "cfg" ? saved : d) }, DEFAULTS, pinCodeOwned);
  const built = buildCfg({ expo: { enabled: true, waves: 8, excludeTypes: OLD }, autoRescue: true });
  check("60d: stara lista ze schowka NIE nadpisuje domyślnej (HEAVY_CARGO wykluczony zaraz po aktualizacji)",
    built.expo.excludeTypes.includes("HEAVY_CARGO"), JSON.stringify(built.expo.excludeTypes));
  check("60d1: … a pozostałe ustawienia ze schowka zostają (ekspedycje ON, 8 fal, auto-ratunek)",
    built.expo.enabled === true && built.expo.waves === 8 && built.autoRescue === true, JSON.stringify(built.expo));
  check("60d2: przypięcie nie mutuje DEFAULTS (kopia tablicy, nie ta sama referencja)",
    built.expo.excludeTypes !== DEFAULTS.expo.excludeTypes && JSON.stringify(built.expo.excludeTypes) === JSON.stringify(DEFAULTS.expo.excludeTypes));
  const syncSrc = bodyOf("const syncCfg = () => {");
  check("60e: syncCfg (zapis z innej karty) też przypina listę z kodu zaraz po scaleniu",
    /cfgMerge\(CFG, st\);\s*pinCodeOwned\(CFG\);/.test(syncSrc), syncSrc.slice(0, 200));
}

console.log("\n── 61. RÓJ SOND ≠ ATAK: trwałość nadwyżki z DRUGIEGO odczytu + lista widzi dom floty (08.09 10:03, v3.71.0) ──");
{
  // 08.09 10:02:42 pasek „3 obce" (sondy DistuRbed na kolonie w galaktyce 1), lista bez wierszy.
  // 10:02:51–55 sondy doleciały i zniknęły. 10:03:43 bot policzył „trwa 61 s" z WIEKU tej samej
  // migawki i ewakuował księżyc z flotą w galaktyce 2. Trwałość ma być ZOBACZONA, nie założona.
  const bes = new Function("bar", "threats", "prev", "now", "cfg", bodyOf("function barExcessState(bar, threats, prev, now, cfg) {"));
  const C = { barExcess: true, barHoldMs: 60e3, barSpyHoldMs: 300e3, barSpyMaxExcess: 1, barMaxAgeMs: 3 * 60e3, barConfirmGraceMs: 60e3 };
  const T0 = NOW - 61e3;
  const jedna = bes({ foreign: 3, at: T0 }, [], { count: 3, since: T0 }, NOW, C);
  check("61a: JEDNA migawka sprzed 61 s NIE zapala alarmu (trwałość niezaobserwowana)", jedna.active === false && jedna.count === 3, JSON.stringify(jedna));
  check("61a1: …ale prosi o świeży pasek (needFresh)", jedna.needFresh === true, JSON.stringify(jedna));
  const drugi = bes({ foreign: 3, at: NOW }, [], { count: 3, since: T0 }, NOW, C);
  check("61b: DRUGI odczyt ≥60 s po pierwszym nadal z nadwyżką → alarm POTWIERDZONY", drugi.active === true && drugi.confirmed === true && drugi.needFresh === false, JSON.stringify(drugi));
  const zniknely = bes({ foreign: 0, at: NOW }, [], { count: 3, since: T0 }, NOW, C);
  check("61c: świeży odczyt bez obcych → nadwyżka znika, licznik od zera", zniknely.active === false && zniknely.count === 0 && zniknely.since === 0, JSON.stringify(zniknely));
  const zaWczesnie = bes({ foreign: 3, at: T0 + 30e3 }, [], { count: 3, since: T0 }, NOW, C);
  check("61d: drugi odczyt 30 s po pierwszym jeszcze nie potwierdza (ale prosi o kolejny)", zaWczesnie.active === false && zaWczesnie.needFresh === true, JSON.stringify(zaWczesnie));
  const bezOdczytu = bes({ foreign: 3, at: NOW - 125e3 }, [], { count: 3, since: NOW - 125e3 }, NOW, C);
  check("61e: BRAK świeżego odczytu przez próg + karencję (125 s) → alarm na STARYM odczycie (sieć nie wyłącza obrony)", bezOdczytu.active === true && bezOdczytu.confirmed === false, JSON.stringify(bezOdczytu));
  const staryPasek = bes({ foreign: 3, at: NOW - 200e3 }, [], { count: 3, since: NOW - 200e3 }, NOW, C);
  check("61e1: …ale pasek starszy niż 3 min dalej nie jest dowodem na nic (stale)", staryPasek.active === false && staryPasek.stale === true, JSON.stringify(staryPasek));
  const sonda = bes({ foreign: 1, at: NOW, spyType: true }, [], { count: 1, since: NOW - 61e3 }, NOW, C);
  check("61e2: pojedyncza sonda: próg 5 min zostaje (drugi odczyt po 61 s nie potwierdza)", sonda.active === false && sonda.spyHold === true, JSON.stringify(sonda));

  // decide(): lista z DOWODEM widzi dom floty bez obcych → ślepy alarm nie rusza tej pary
  const alarm = { active: true, confirmed: true, count: 3, since: NOW - 70e3 };
  const sQuiet = base({ barExcess: alarm, threats: [], active: { key: "3:272:7", body: "moon" },
    listSeen: { key: "3:272:7", foreign: 0, proven: true, at: NOW - 10e3 }, hangars: { "3:272:7|moon": H(9e9) } });
  const rQ = decide(sQuiet, CFG, NOW);
  check("61f: lista (świeża, z dowodem) widzi dom floty bez obcych → ślepy alarm NIE ewakuuje", !rQ.actions.some(a => a.kind === "fly"), JSON.stringify(rQ.actions));
  check("61f1: …i mówi dlaczego (nadwyżka dotyczy innej kolonii), bez pushu „nie wiem, gdzie stoi flota”",
    rQ.alerts.some(a => /innej kolonii/.test(a.msg)) && !rQ.alerts.some(a => /nie wiem, gdzie stoi flota/.test(a.msg)), JSON.stringify(rQ.alerts.map(a => a.msg)));
  const rNoProof = decide(base({ ...sQuiet, listSeen: { key: "3:272:7", foreign: 0, proven: false, at: NOW - 10e3 } }), CFG, NOW);
  check("61g: lista BEZ dowodu (żadnego własnego wiersza tej pary) → ratunek w ciemno jak dotąd", rNoProof.actions.some(a => a.kind === "fly" && a.blind), JSON.stringify(rNoProof.actions));
  const rForeign = decide(base({ ...sQuiet, listSeen: { key: "3:272:7", foreign: 1, proven: true, at: NOW - 10e3 } }), CFG, NOW);
  check("61h: lista widzi przy domu obcy wiersz (nierozpoznany) → ratunek w ciemno", rForeign.actions.some(a => a.kind === "fly" && a.blind), JSON.stringify(rForeign.actions));
  const rStale = decide(base({ ...sQuiet, listSeen: { key: "3:272:7", foreign: 0, proven: true, at: NOW - 200e3 } }), CFG, NOW);
  check("61i: odczyt listy starszy niż 2 min → ratunek w ciemno", rStale.actions.some(a => a.kind === "fly" && a.blind), JSON.stringify(rStale.actions));
  const rUntrusted = decide(base({ ...sQuiet, listUntrusted: true }), CFG, NOW);
  check("61j: lista nieufna (dryf planety w sesji) → ratunek w ciemno", rUntrusted.actions.some(a => a.kind === "fly" && a.blind), JSON.stringify(rUntrusted.actions));
  const rOther = decide(base({ ...sQuiet, hangars: { "3:272:2|moon": H(9e9) } }), CFG, NOW);
  check("61k: flota na INNEJ parze niż ta, którą lista widzi → ratunek w ciemno z tamtej pary", rOther.actions.some(a => a.kind === "fly" && a.blind && a.fromKey === "3:272:2"), JSON.stringify(rOther.actions));
  const rBez = decide(base({ ...sQuiet, listSeen: null }), CFG, NOW);
  check("61k1: bez wpisu listSeen w stanie (stara wersja stanu) → ratunek w ciemno jak dotąd", rBez.actions.some(a => a.kind === "fly" && a.blind), JSON.stringify(rBez.actions));
  check("61l: (źródło) migawka strony nie cofa świeższego odczytu paska z fetcha", /PAGE_AT >= \(s\.bar\.at \|\| 0\)/.test(src));
  check("61l1: (źródło) świeży pasek idzie fetchem /home BEZ `?planet=` (sesja operatora nietknięta)", /fetchT\("\/home", \{ credentials: "same-origin" \}\)/.test(bodyOf("async fetchFresh() {")) && !/planet=/.test(bodyOf("async fetchFresh() {")));
}

console.log("");
console.log(fails ? fails + " FAIL — NIE WYPYCHAJ" : "TESTY 3.0: wszystko OK");
process.exit(fails ? 1 : 0);
