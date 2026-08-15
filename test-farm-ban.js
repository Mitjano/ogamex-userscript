// Test czarnej listy farmy (v2.96.0) — WYKONUJE prawdziwy blok FARM-BAN
// (FarmBlacklist + CombatWatch) na sztucznym magazynie i na TEKSCIE z zywego
// serwera (zrzut ownera 15.08: raporty rozbitych atakow na Sith Campeador).
// Regresja tutaj = flota HC dalej rozbija sie o te sama obrone co okrazenie.
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n");

let fail = 0;
const check = (desc, ok) => {
  console.log(`${ok ? "OK  " : "BŁĄD"} | ${desc}`);
  if (!ok) fail++;
};

const m = src.match(/\/\/ ── FARM-BAN-START ──([\s\S]*?)\/\/ ── FARM-BAN-END ──/);
check("blok FARM-BAN-START/END istnieje", !!m);
if (m) {
  const store = {};
  const env = new Function("GM_getValue", "GM_setValue", "log", "fetch", "location", "document",
    `${m[1]}\nreturn { FarmBlacklist, CombatWatch };`)(
    (k, d) => (k in store ? store[k] : d),
    (k, v) => { store[k] = v; },
    () => {}, () => { throw new Error("fetch niedozwolony w tescie"); },
    { pathname: "/galaxy" }, {});
  const { FarmBlacklist, CombatWatch } = env;

  // ── parse() na tekscie 1:1 z ekranu ownera ──
  const text = "Combat report: Delta 11 [4:37:11] 15.08.2026 09:36:11 MCH : 360.000.000 " +
    "Sith Campeador : 0 Resources : 0 Debris field : 288.000.000.000 More details " +
    "Combat report: Alpha 14 [4:36:14] 15.08.2026 09:35:27 MCH : 0 " +
    "Whitej95 : 0 Resources : 41.000.000 Debris field : 0 More details";
  const reports = CombatWatch.parse(text);
  check("parse: 2 raporty z koordami", reports.length === 2 && reports[0].coord === "4:37:11" && reports[1].coord === "4:36:14");
  check("parse: straty atakujacego 360.000.000 (nie data, nie Resources)", reports[0].losses === 360000000);
  check("parse: lup 0 przy rozbitym ataku", reports[0].resources === 0);
  check("parse: udany atak = straty 0, lup 41 mln", reports[1].losses === 0 && reports[1].resources === 41000000);

  // ── _apply: ban tylko przy stratach > 0 ──
  const banned = CombatWatch._apply(reports, "test");
  check("_apply: banuje TYLKO rozbity atak (1 ban)", banned === 1);
  check("czarna lista: [4:37:11] zbanowany", FarmBlacklist.has("4:37:11"));
  check("czarna lista: [4:36:14] (udany atak) wolny", !FarmBlacklist.has("4:36:14"));
  check("ponowny raport nie liczy sie jako nowy ban", CombatWatch._apply(reports, "test") === 0);

  // ── TTL: wpis starszy niz 14 dni wygasa ──
  const d = FarmBlacklist.load();
  d["4:37:11"].at = Date.now() - 15 * 24 * 60 * 60 * 1000;
  FarmBlacklist.save(d);
  check("ban wygasa po TTL 14 dni", !FarmBlacklist.has("4:37:11"));
}

// ── zamrozenia integracji ──
check("collectTargets pomija czarna liste", /if \(FarmBlacklist\.has\(coord\)\) \{ bannedSkip\+\+; return; \}/.test(src));
check("dispatchNext filtruje zbanowane cele w kolejce",
  // v2.97.0 wstawila sortowanie po lupie miedzy filtr a shift() — zamrozony
  // jest sam FILTR (to on chroni przed powrotem na obrone), nie sasiedztwo.
  /let targets = \(st\.targets \|\| \[\]\)\.filter\(t => !FarmedTargets\.has\(t\.coord\) && !FarmBlacklist\.has\(t\.coord\)\);/.test(src));
check("farm.run() dociaga raporty przed decyzja", /await CombatWatch\.run\(\)\.catch\(\(\) => \{\}\);/.test(src));
check("harvestDom wpiety w init (strona wiadomosci)", /CombatWatch\.harvestDom\(\); \} catch \{\}/.test(src));

if (fail) { console.error(`\n${fail} PORAŻKA/EK`); process.exit(1); }
console.log("\nWSZYSTKIE PRZYPADKI PRZESZŁY");
