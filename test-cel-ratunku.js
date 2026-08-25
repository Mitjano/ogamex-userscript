// ─────────────────────────────────────────────────────────────────────────
//  TEST PO KATASTROFIE 12.08 13:10 — utrata floty głównej na [2:277:8]
// ─────────────────────────────────────────────────────────────────────────
// Ten test istnieje, żeby DWA błędy, które kosztowały flotę, nie mogły
// wrócić po cichu w żadnej przyszłej wersji:
//
//   1. Ratunek bez znanego celu bronił „aktywnej pary" — czyli kolonii,
//      przy której bot akurat PRACOWAŁ (v2.84 sam przełącza ciała przy
//      wysyłkach górniczych), a nie tej, na której MIESZKA flota.
//      Obrona sprzątała księżyc minerów, gdy atak leciał na dom floty.
//
//   2. Odczyt paska misji nie zostawiał śladu — strony galaktyki nie
//      renderują paska, a lista ruchów tego forka NIE ODDAJE wierszy
//      ataków z własnego układu, więc „czysta" lista kasowała obraz
//      ataku przy każdym przebiegu. 99 sekund ślepoty.
//
// Test sprawdza ŹRÓDŁO (plik bota), nie kopię logiki — jeśli ktoś usunie
// któryś z bezpieczników, ten plik ma paść na CI zanim padnie flota.

const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n") /* CRLF checkout (autocrlf) nie moze psuc markerow z \n */;

let fails = 0;
const must = (name, cond) => {
  if (!cond) { fails++; console.log(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
};

// ── wytnij ciało MoonSave.run (wzorzec klamer z test-kolejka) ──
function bodyOf(sig) {
  const i = src.indexOf(sig);
  if (i < 0) return null;
  const open = i + sig.length - 1;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(open + 1, j); }
  }
  return null;
}

console.log("\n── 1. RATUNEK BEZ CELU BRONI DOMU FLOTY ──");

const runBody = bodyOf("async run({ manual = false, sweep = false, auto = false, reason = \"manual\", where = null, queued = false } = {}) {");
must("MoonSave.run istnieje i ma niepuste ciało (>1000 znaków)", !!runBody && runBody.length > 1000);
must("dom floty czytany z expeditions.launchFrom",
  !!runBody && /fleetHome\s*=\s*CONFIG\.expeditions\?\.launchFrom/.test(runBody));
must("run() wybiera cel przez resolveRescueTarget (czystą funkcję)",
  !!runBody && /this\.resolveRescueTarget\(\{/.test(runBody));

// ── v2.87.0: MACIERZ na PRAWDZIWEJ funkcji (nie regex, nie kopia) ──
const rrtBody = bodyOf("    resolveRescueTarget({ where, watchAt, manual, fleetHome, activePair }) {");
must("resolveRescueTarget istnieje", !!rrtBody && rrtBody.length > 40);
const rrt = new Function("o", "const { where, watchAt, manual, fleetHome, activePair } = o;\n" + rrtBody);
const FH = "DOM", AP = "AKTYWNA", XX = "CEL", WA = "STRAŻ";
must("macierz: jawny cel wygrywa ze wszystkim",
  rrt({ where: XX, watchAt: WA, manual: false, fleetHome: FH, activePair: AP }) === XX);
must("macierz: kolonia strzeżona przed domem floty",
  rrt({ where: null, watchAt: WA, manual: false, fleetHome: FH, activePair: AP }) === WA);
must("macierz: AUTOMAT bez celu → DOM FLOTY (zabójczy porządek z 13:10 odwrócony)",
  rrt({ where: null, watchAt: null, manual: false, fleetHome: FH, activePair: AP }) === FH);
must("macierz: automat bez domu floty → aktywna para",
  rrt({ where: null, watchAt: null, manual: false, fleetHome: null, activePair: AP }) === AP);
must("macierz: ręczny RATUJ → para operatora, nie dom floty",
  rrt({ where: null, watchAt: null, manual: true, fleetHome: FH, activePair: AP }) === AP);
must("macierz: ręczny RATUJ bez pary → dom floty",
  rrt({ where: null, watchAt: null, manual: true, fleetHome: FH, activePair: null }) === FH);
must("macierz: nic nie wiadomo → null (coordsOf dośle bazę)",
  rrt({ where: null, watchAt: null, manual: false, fleetHome: null, activePair: null }) === null);
must("ślepa ścieżka paska syntetyzuje cel = dom floty (switch-first)",
  /if \(!target\) \{\s*\n\s*const fh = CONFIG\.expeditions\?\.launchFrom;/.test(src));
must("lot międzykolonijny celuje w KSIĘŻYC celu",
  !!runBody && /crossColony \? "moon"/.test(runBody));
must("uzbrojona straż PYTA ucieczkę w powietrze przy ataku na oba ciała (v2.87.1)",
  /bodiesNow\.length >= 2 && AirSave\.decideFor\(wNow\.at\) === "air"/.test(src));
must("przełączanie pary celuje po KOORDACH z tekstu kotwicy (v2.87.2)",
  /anchorByCoords = b \? HomeBase\.pairAnchor\(b\) : null/.test(src));
must("formularz ratunku/powrotu NIGDY nie wysyła z obcej kolonii (v2.87.2)",
  /floty z obcej kolonii NIE ruszam/.test(src) && /mission\.moonSave && mission\.atCoords/.test(src));

console.log("\n── 1b. LĄDOWANIE WG REALNEGO CZASU LOTU (v2.86.5) ──");

must("ratunek zapisuje czas lotu do misji (mission.flightMs)",
  /mission\.moonSave && capturedFlightMs > 0 && !mission\.flightMs/.test(src));
must("straż dostaje lastFlightMs po potwierdzonej wysyłce",
  /lastFlightMs: \(pmSnap && pmSnap\.flightMs\) \|\| w\.lastFlightMs \|\| 0/.test(src));
must("powrót czeka na lądowanie wg realnego czasu (nie 130 s na sztywno)",
  /Math\.max\(130000, \(w\.lastFlightMs \|\| 0\) \+ 60000\)/.test(src));

console.log("\n── 2. ODCZYT PASKA ZOSTAWIA ŚLAD I WYGRYWA Z LISTĄ ──");

must("udany odczyt paska zapisuje cache (ogamex_bar_cache)",
  /GM_setValue\("ogamex_bar_cache"/.test(src));
must("strona bez paska czyta cache z TTL 3 min",
  /ogamex_bar_cache[\s\S]{0,200}?3 \* 60 \* 1000/.test(src));
// v2.102.3 (ATAK 25.08 16:22): sondy WYLĄDOWANE (eta≈0) nie mogą tłumaczyć obcych
// z paska — liczą się tylko ataki + sondy W LOCIE. 2 sondy Ibry maskowały ACS,
// alarm zszedł, auto-powrót wiózł flotę pod uderzenie.
must("pasek WYGRYWA nadwyżką ponad ATAKI (sondy tylko opóźniają potwierdzenie) — v2.102.4",
  /barEff\.foreign > listForeign/.test(src) && /\(ev\.attacks \|\| 0\) \+ \(CONFIG\.threatAlarm\?\.barCountsProbes \? \(ev\.spies \|\| 0\) : 0\)/.test(src) && /probeWaitUntil = \(ev\.at \|\| Date\.now\(\)\)/.test(src));
must("widziany dolot ataku (ogamex_atk_until) blokuje zdjęcie alarmu i powrót — v2.102.3",
  /prev\.count > 0 && Date\.now\(\) < \(parseInt\(GM_getValue\("ogamex_atk_until"/.test(src) && /until && Date\.now\(\) < until \+ 60 \* 1000/.test(src));
must("sonda policzona przez listę NIE robi ataku (foreign = ataki + nadwyżka)",
  /foreign: \(ev\.attacks \|\| 0\) \+ missing/.test(src));

console.log("\n── 3. PANEL EVENTS — TRZECIE ŹRÓDŁO (v2.88.0) ──");

must("panel czytany sprawdzonym kształtem (tr.eventFleet + data-mission-type)",
  /querySelectorAll\("tr\.eventFleet\[data-mission-type\]"\)/.test(src));
must("wiersze panelu dołączają do klasyfikacji (blitz/air-save z automatu)",
  /panel Events dołożył/.test(src) && /if \(pr\.attack\) attacks\.push\(pr\); else if \(pr\.spy\) spies\.push\(pr\);/.test(src));
must("odczyt panelu żyje 3 min jako cache (strony bez panelu nie ślepną)",
  /ogamex_events_panel_cache/.test(src));
must("nieznany markup = jednorazowy zrzut [EVENTS DOM], nie zgadywanie",
  /\[EVENTS DOM\] panel Events bez znanych wierszy/.test(src));
must("niepewna numeracja misji wyłącza TYLKO kształt liczbowy (klasyfikacja nazwami zostaje)",
  /GM_getValue\("ogamex_mission_numbering_warned", ""\) !== "1"/.test(src));
// ── v2.88.2 (lekcja 16:10: zrzut spalony na pustym kontenerze z symulacji) ──
must("panel forka czytany kontenerem #fleet-movement-content przez PRAWDZIWY classifyRow",
  /#fleet-movement-content tr\[class\*='row-mission-type-'\]/.test(src) &&
  /FleetMovements\.classifyRow\(tr, own\)/.test(src));
must("zrzut [EVENTS DOM] nie odpala się na symulacji ani bez obcych",
  /bar\.sim \|\| bar\.foreign < 1/.test(src));
must("pusty kontener NIE pali jednorazowego zrzutu",
  /children\.length === 0\) return;/.test(src));
must("zrzut przezbrojony po fałszywym spaleniu 16:10 (nowy klucz)",
  /ogamex_events_panel_dumped_v2882/.test(src));

console.log("\n── 4. PASEK BEZ „OWN” + STRAŻNICY WERSJI I DOMU (v2.88.1) ──");
// INCYDENT 15:24: pasek „2 Missions: 2 Hostile" (zero własnych lotów) nie
// przechodził przez regex wymagający „X Own" → read()=null → bot ślepy
// dokładnie wtedy, gdy cała flota stała w domu. Zero alarmu, zero pusha.

const pbBody = bodyOf("    parseBar(text) {");
must("parseBar istnieje (czysta funkcja)", !!pbBody && pbBody.length > 100);
const pb = new Function("text", pbBody);
const pbEq = (a, e) => !!a && a.total === e.total && a.own === e.own && a.foreign === e.foreign;
must("pasek 15:24: „2 Missions: 2 Hostile' (zero własnych) = 2 wrogów, NIE null",
  pbEq(pb("2 Missions: 2 Hostile Next: 04:15 Type: ACS Attack"), { total: 2, own: 0, foreign: 2 }));
must("pasek 13:09: „13 Missions: 12 Own' = 1 obcy",
  pbEq(pb("13 Missions: 12 Own"), { total: 13, own: 12, foreign: 1 }));
must("pasek: „5 Missions: 3 Own, 2 Hostile' = 2 wrogów (Hostile = twarda liczba)",
  pbEq(pb("5 Missions: 3 Own, 2 Hostile"), { total: 5, own: 3, foreign: 2 }));
must("pasek: Friendly nie jest wrogiem (bez jawnego Hostile)",
  pbEq(pb("2 Missions: 1 Own, 1 Friendly"), { total: 2, own: 1, foreign: 0 }));
must("pasek: strona bez paska = null (ślepota, nie „czysto')",
  pb("Overview Server properties Online players: 283") === null);
must("read() używa parseBar (stary regex z wymaganym Own zniknął z read)",
  /const out = this\.parseBar\(document\.body\.textContent\);/.test(src));

const nwBody = bodyOf("    newer(remote, local) {");
must("UpdateWatch.newer istnieje", !!nwBody);
const nw = new Function("remote", "local", nwBody);
must("wersje: 2.88.1 > 2.88.0", nw("2.88.1", "2.88.0") === true);
must("wersje: 2.9.0 NIE jest nowsze niż 2.88.0 (segmenty, nie leksykalnie)", nw("2.9.0", "2.88.0") === false);
must("wersje: równe = nie nowsze", nw("2.88.1", "2.88.1") === false);
must("strażnik wersji tyka w pętli obrony i ma @connect do repo",
  /UpdateWatch\.tick\(\)/.test(src) && /@connect\s+raw\.githubusercontent\.com/.test(src));
must("przestarzała wersja idzie do dziennika jako BŁĄD (dziennik sam pushuje)",
  /Bot PRZESTARZAŁY: repo v/.test(src));

const hvBody = bodyOf("    homeVerdict({ map, homeKey }) {");
must("homeVerdict istnieje (czysta decyzja)", !!hvBody);
const hv = new Function("o", "const { map, homeKey } = o;\n" + hvBody);
must("dom floty: wielka flota poza polem „Start ekspedycji' = alarm",
  (hv({ map: { "2:277:8": { total: 7.5e9, max: 7.5e9 }, "5:67:9": { total: 2e11, max: 2e11 } }, homeKey: "2:277:8" }) || {}).key === "5:67:9");
must("dom floty: księżyc minerów obok floty głównej NIE alarmuje",
  hv({ map: { "5:67:9": { total: 2e11, max: 2e11 }, "3:272:7": { total: 7.5e9, max: 7.5e9 } }, homeKey: "5:67:9" }) === null);
must("dom floty: dom chwilowo pusty (max 48 h pamięta flotę) NIE alarmuje",
  hv({ map: { "5:67:9": { total: 0, max: 2e11 }, "3:272:7": { total: 7.5e9, max: 7.5e9 } }, homeKey: "5:67:9" }) === null);
must("dom floty: drobnica poniżej 1 mld nie alarmuje",
  hv({ map: { "5:67:9": { total: 0, max: 0 }, "1:1:1": { total: 5e8, max: 5e8 } }, homeKey: "5:67:9" }) === null);
must("strażnik domu wołany przy każdym skanie floty", /this\.homeGuard\(snap\);/.test(src));

console.log(fails ? `\nCEL RATUNKU: ${fails} BEZPIECZNIKÓW BRAK — NIE WYPUSZCZAĆ` : "\nCEL RATUNKU: WSZYSTKIE BEZPIECZNIKI NA MIEJSCU");
process.exit(fails ? 1 : 0);
