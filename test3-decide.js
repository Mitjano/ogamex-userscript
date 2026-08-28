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
const decide = new Function("Situation", `return function decide(s, cfg, now) {${decideBody}}`)(Situation);

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
  check("brak wiedzy o hangarze → alarm, nie ruszamy floty", r.actions.length === 0 && r.alerts.length === 1, JSON.stringify(r));
  const s2 = base({ hangars: { "3:272:7|moon": { total: 0, at: NOW - 30000, ships: [] } }, threats: [threat("3:272:7", "moon", 300)] });
  check("hangar pusty → alarm, zero lotów", decide(s2, CFG, NOW).actions.length === 0);
  const s3 = base({ hangars: { "3:272:7|moon": H(1e12, "moon", 50 * 3600e3) }, threats: [threat("3:272:7", "moon", 300)] });
  check("odczyt hangaru starszy niż 48 h → nie ufamy, tylko alarm", decide(s3, CFG, NOW).actions.length === 0);
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
  check("rekonesans stoi przy zagrożeniu", /threats[\s\S]{0,80}?arriveAt > now\)\) return false/.test(recon));
  check("rekonesans stoi, gdy lot jest w powietrzu", /phase === "launched"\)\) return false/.test(recon));
  check("rekonesans ma własny dławik (nie nawiguje co tick)", /now - \(st\.at \|\| 0\) < 90e3\) return false/.test(recon));
  check("pętla woła rekonesans TYLKO gdy nie ma lotu/zawrotu", /if \(!actions\.some\(a => a\.kind === "fly" \|\| a\.kind === "recall"\)\) \{ if \(!\(await Recon\.tick\(s\)\)\) await Expo\.tick\(s\); \}/.test(src));
  check("hangar odczytywany przy każdej wizycie na /fleet", (src.match(/page\(\) === "fleet"\) Hangar\.scan\(\)/g) || []).length >= 2);
}


// ═════════════════════════════════════════════════════════════════════════
//  EKSPEDYCJE (v3.2.0) — czysta funkcja expoPlan(); klasa ODKRYWCA
// ═════════════════════════════════════════════════════════════════════════
const expoBody = bodyOf("function expoPlan(s, cfg, now, burst) {");
const expoPlan = new Function("key", `return function expoPlan(s, cfg, now, burst) {${expoBody}}`)((c) => c && Number.isFinite(c.galaxy) ? `${c.galaxy}:${c.system}:${c.position}` : (typeof c === "string" ? c : null));
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
  check("lot ekspedycji nie trafia do flights", /if \(m\.kind !== "expedition"\) \{[\s\S]{0,400}?s\.flights\.push/.test(src), "brak wyłączenia expedition z flights");
  check("ekonomia woła się po obronie i rekonesansie", /if \(!\(await Recon\.tick\(s\)\)\) await Expo\.tick\(s\)/.test(src));
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

console.log("");
console.log(fails ? fails + " FAIL — NIE WYPYCHAJ" : "TESTY 3.0: wszystko OK");
process.exit(fails ? 1 : 0);
