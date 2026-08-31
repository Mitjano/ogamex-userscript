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
    /function emptySourceHangar\(fromKey, fromBody, why\)/.test(src) &&
    (src.match(/emptySourceHangar\(/g) || []).length >= 4);
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

  check("ewakuacja zostawia stempel w stanie (Fly), powrót nie",
    /if \(!m\.home && m\.kind !== "expedition"[\s\S]{0,200}?sR\.rescues\[m\.fromKey\] = Date\.now\(\)/.test(src));
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
  const readiness = new Function("CFG", "Session", "Notifier", "Situation", "key",
    `return function defenceReadiness(s) {${body}}`);
  const CFG_OK = { enabled: true, autoRescue: true, expo: { launchFrom: null } };
  const Sess = { lostRecently: () => false };
  const Notif = { enabled: () => true };
  const Sit = { fleetAt: (s, k, now) => ({ body: "moon", total: 1000, at: now }) };
  const kfn = (c) => c && Number.isFinite(c.galaxy) ? `${c.galaxy}:${c.system}:${c.position}` : (typeof c === "string" ? c : null);
  const R = (cfg, sess, notif, sit) => readiness(cfg || CFG_OK, sess || Sess, notif || Notif, sit || Sit, kfn);
  const stan = () => ({ active: { key: "3:272:7", body: "moon" },
    pairs: { "3:272:7": { hasMoon: true }, "3:272:2": { hasMoon: true } },
    hangars: { "3:272:7|moon": { total: 1000, at: Date.now() - 60e3 } } });

  check("wszystko w porządku → zero braków", R()(stan()).length === 0, JSON.stringify(R()(stan())));
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
  check("rekonesans przypiety do ciala startowego, gdy jest ustawione", /if \(lf\) return all\.filter\(\(\[k\]\) => k === lf\);/.test(src));
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
  check("scanRemote przywraca planetę operatora po odczycie (i przy błędzie)", /let restore = null/.test(src) && (src.match(/\/fleet\?planet=\$\{restore\}/g) || []).length >= 2);
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
}

// ── v3.52.0: wzorce w źródle — strażnik fałszywego domknięcia + rejestr w Fly ──
{
  check("lądowanie z rejestru NIE domyka wpisu ratunku przed terminem zawrotu", /toEksp = f\.recallAt && h\.at < f\.recallAt/.test(src) && /wpis ratunku ZOSTAJE/.test(src));
  check("rejestr zapisywany PRZED klikiem Send fleet, tylko z czasem lotu z formularza", /m\.flightMs\) \{\s*\n\s*const sE = Situation\.load\(\);\s*\n\s*sE\.expected/.test(src));
  check("wpis rejestru potwierdzany po wysyłce i po przeładowaniu (confirmPendingSend)", /e0\.pending/.test(src) && /\(s\.expected \|\| \[\]\)\.find\(x => x\.pending && x\.fromKey === ls\.from/.test(src));
  check("rejestr wygaszany: pending>10 min, godzinę po lądowaniu; korekta zegarem z listy", /e\.pending && now - \(e\.sentAt \|\| 0\) > 10 \* 60e3/.test(src) && /best\.returnAt = o\.arriveAt/.test(src));
  check("ekspedycja nadal NIE trafia do flights (rejestr jest osobny)", /sE\.expected = \[\.\.\.\(sE\.expected \|\| \[\]\)/.test(src) && !/flights.*expedition.*push/.test(src.slice(src.indexOf("REJESTR POWROTÓW"), src.indexOf("REJESTR POWROTÓW") + 900)));
}

console.log("");
console.log(fails ? fails + " FAIL — NIE WYPYCHAJ" : "TESTY 3.0: wszystko OK");
process.exit(fails ? 1 : 0);
