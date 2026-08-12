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
const src = fs.readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8");

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
must("pasek WYGRYWA tylko NADWYŻKĄ ponad wszystkie obce wiersze listy (ataki+sondy) — v2.87.3",
  /barEff\.foreign > listForeign/.test(src) && /\(ev\.attacks \|\| 0\) \+ \(ev\.spies \|\| 0\)/.test(src));
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
  /\[EVENTS DOM\] panel Events bez tr\.eventFleet/.test(src));
must("niepewna numeracja misji wyłącza panel (nie zamienia sond w ataki)",
  /ogamex_mission_numbering_warned[\s\S]{0,40}return \[\];/.test(src));

console.log(fails ? `\nCEL RATUNKU: ${fails} BEZPIECZNIKÓW BRAK — NIE WYPUSZCZAĆ` : "\nCEL RATUNKU: WSZYSTKIE BEZPIECZNIKI NA MIEJSCU");
process.exit(fails ? 1 : 0);
