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
must("AUTOMAT bez celu: dom floty PRZED aktywną parą (v2.86.5)",
  !!runBody && /noTargetDefault = manual \? \(HomeBase\.coords\(\) \|\| fleetHome\) : \(fleetHome \|\| HomeBase\.coords\(\)\)/.test(runBody));
must("fallback celu idzie przez noTargetDefault",
  !!runBody && /coordsOf\(where \|\| this\.watch\(\)\.at \|\| noTargetDefault/.test(runBody));
must("„aktywna para” NIGDY przed domem floty (zabójczy porządek z 13:10)",
  !!runBody && !/coordsOf\(where \|\| this\.watch\(\)\.at \|\| HomeBase\.coords\(\)/.test(runBody));
must("ślepa ścieżka paska syntetyzuje cel = dom floty (switch-first)",
  /if \(!target\) \{\s*\n\s*const fh = CONFIG\.expeditions\?\.launchFrom;/.test(src));
must("lot międzykolonijny celuje w KSIĘŻYC celu",
  !!runBody && /crossColony \? "moon"/.test(runBody));

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
must("pasek (żywy lub cache) WYGRYWA, gdy widzi więcej niż lista",
  /barEff\.foreign > ev\.attacks/.test(src));
must("zwycięstwo paska podnosi foreign do liczby z paska",
  /r = \{ \.\.\.r, foreign: barEff\.foreign \}/.test(src));

console.log(fails ? `\nCEL RATUNKU: ${fails} BEZPIECZNIKÓW BRAK — NIE WYPUSZCZAĆ` : "\nCEL RATUNKU: OBA BEZPIECZNIKI NA MIEJSCU");
process.exit(fails ? 1 : 0);
