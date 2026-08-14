// Test izolacji magazynu per-uni (v2.92.0) — WYKONUJE prawdziwy blok
// UNI-ISO ze źródła na sztucznym magazynie. Tło: izolacja v2.9.0 nadpisywała
// window.GM_*, czego sandbox Tampermonkeya nie widzi — wszystkie uni dzieliły
// jeden magazyn i bot na świeżym koncie (Vega, 14.08) wykonywał stan Atheny.
// Regresja = najgorszy rodzaj awarii: dwa uni po cichu piszą sobie po configu.
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n");

let fail = 0;
const check = (desc, ok) => {
  console.log(`${ok ? "OK  " : "BŁĄD"} | ${desc}`);
  if (!ok) fail++;
};

// ── Zamrożenie kształtu na źródle ──
const capture = src.indexOf("const __gmGetRaw = GM_getValue;");
const iife = src.indexOf("(function () {");
check("oryginały GM_* łapane PRZED IIFE (inaczej TDZ/martwa nadpiska)",
  capture !== -1 && iife !== -1 && capture < iife);
check("zero nadpisywania window.GM_* (martwe w sandboxie TM)",
  !/window\.GM_(set|get)Value\s*=/.test(src));

// ── Wykonanie bloku UNI-ISO na sztucznym magazynie ──
const m = src.match(/\/\/ ── UNI-ISO-START ──([\s\S]*?)\/\/ ── UNI-ISO-END ──/);
check("blok UNI-ISO-START/END istnieje", !!m);
if (m) {
  const makeUni = (host, store) => {
    const rawGet = (k, d) => (k in store ? store[k] : d);
    const rawSet = (k, v) => { store[k] = v; };
    return new Function("__gmGetRaw", "__gmSetRaw", "location",
      `${m[1]}\nreturn { get: GM_getValue, set: GM_setValue };`)(rawGet, rawSet, { host });
  };

  // Wspólny magazyn jak w Tampermonkeyu + stare nieprefiksowane dane Atheny.
  const store = { "ogamex_config": "ATHENA-CONFIG", "ogamex_farm_scan": "ATHENA-FARM" };
  const athena = makeUni("athena.ogamex.net", store);
  const vega = makeUni("vega.ogamex.net", store);

  check("Vega NIE widzi nieprefiksowanych danych Atheny (dostaje default)",
    vega.get("ogamex_config", "DEFAULT") === "DEFAULT");
  check("Athena czyta swoje stare dane przez fallback (migracja bez utraty)",
    athena.get("ogamex_config", "DEFAULT") === "ATHENA-CONFIG");

  vega.set("ogamex_config", "VEGA-CONFIG");
  check("zapis Vegi ląduje pod prefiksem vega.ogamex.net:",
    store["vega.ogamex.net:ogamex_config"] === "VEGA-CONFIG");
  check("zapis Vegi NIE nadpisuje legacy klucza Atheny",
    store["ogamex_config"] === "ATHENA-CONFIG");
  check("po zapisie Vega czyta własną wartość",
    vega.get("ogamex_config", "DEFAULT") === "VEGA-CONFIG");
  check("Athena dalej widzi swoje (izolacja w obie strony)",
    athena.get("ogamex_config", "DEFAULT") === "ATHENA-CONFIG");

  athena.set("ogamex_config", "ATHENA-NOWY");
  check("zapis Atheny idzie pod prefiks i wygrywa z legacy",
    athena.get("ogamex_config", "DEFAULT") === "ATHENA-NOWY" && store["athena.ogamex.net:ogamex_config"] === "ATHENA-NOWY");
  check("świeży klucz na Vedze bez legacy = default (żadnych przecieków)",
    vega.get("ogamex_farm_scan", null) === null);
}

if (fail) { console.error(`\n${fail} PORAŻKA/EK`); process.exit(1); }
console.log("\nWSZYSTKIE PRZYPADKI PRZESZŁY");
