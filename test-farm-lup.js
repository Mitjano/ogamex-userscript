// Test priorytetu lupu (v2.97.0) — WYKONUJE blok FARM-YIELD na sztucznym
// magazynie i na wierszach 1:1 z Dziennika Grabiezy ownera (zrzut 15.08).
// Regresja = farm mieli drobnice, a limit atakow/dobe przepala sie na
// celach 20x chudszych.
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n");

let fail = 0;
const check = (desc, ok) => {
  console.log(`${ok ? "OK  " : "BŁĄD"} | ${desc}`);
  if (!ok) fail++;
};

const m = src.match(/\/\/ ── FARM-YIELD-START ──([\s\S]*?)\/\/ ── FARM-YIELD-END ──/);
check("blok FARM-YIELD istnieje", !!m);
if (m) {
  const store = {};
  const { FarmYieldDB, PlunderWatch } = new Function("GM_getValue", "GM_setValue", "log", "fetch", "location", "document",
    `${m[1]}\nreturn { FarmYieldDB, PlunderWatch };`)(
    (k, d) => (k in store ? store[k] : d),
    (k, v) => { store[k] = v; },
    () => {}, () => { throw new Error("fetch zabroniony"); },
    { pathname: "/galaxy" }, { body: { textContent: "" } });

  // ── parse() na wierszach 1:1 ze zrzutu ──
  const text = "Mission date Player Coordinates Profit " +
    "15.08.2026 18:15:19 Abutre (i) [4:372:3] +5.107.842.360.031 " +
    "15.08.2026 18:10:25 Ratatosk (i) [4:378:6] +242.317.683.382 " +
    "15.08.2026 18:07:02 LEONIDAS (i) [4:378:1] +619.677.656.487 " +
    "15.08.2026 18:06:01 Faithful Jericho (i) [4:377:15] +1.117.115.472.354";
  const rows = PlunderWatch.parse(text);
  check("parse: 4 wiersze", rows.length === 4);
  check("parse: Abutre [4:372:3] lup 5.107.842.360.031",
    rows[0]?.coord === "4:372:3" && rows[0]?.profit === 5107842360031 && rows[0]?.player === "Abutre");
  check("parse: gracz z dwuczlonowa nazwa (Faithful Jericho)",
    rows[3]?.player === "Faithful Jericho" && rows[3]?.profit === 1117115472354);

  // ── uczenie + dedup ──
  check("_apply: 4 nowe wpisy", PlunderWatch._apply(rows, "test") === 4);
  check("_apply: te same wpisy = 0 (dedup po coord|dacie)", PlunderWatch._apply(rows, "test") === 0);
  check("avg: Abutre = 5,1 bln", FarmYieldDB.avg("4:372:3") === 5107842360031);

  // ── EMA: druga probka usrednia ──
  FarmYieldDB.update("4:378:6", 300000000000, "Ratatosk");
  check("EMA: (242,3 mld + 300 mld)/2", FarmYieldDB.avg("4:378:6") === Math.round((242317683382 + 300000000000) / 2));

  // ── mediana + top + sumy systemow ──
  check("median() zwraca wartosc ze srodka", typeof FarmYieldDB.median() === "number");
  const top = FarmYieldDB.top(2);
  check("top(): Abutre pierwszy", top[0]?.coord === "4:372:3");
  const sums = FarmYieldDB.systemSums();
  check("systemSums: [4:378] = suma dwoch celow", sums["4:378"] === FarmYieldDB.avg("4:378:6") + FarmYieldDB.avg("4:378:1"));
}

// ── zamrozenia integracji ──
check("dispatchNext sortuje po lupie z mediana dla nieznanych",
  /targets\.sort\(\(a, b\) => \(FarmYieldDB\.avg\(b\.coord\) \?\? med\) - \(FarmYieldDB\.avg\(a\.coord\) \?\? med\)\);/.test(src));
check("prog wycina TYLKO znana drobnice (a == null przechodzi)",
  /const a = FarmYieldDB\.avg\(x\.coord\); return a == null \|\| a >= floor;/.test(src));
check("okrazenie po bazie sortowane suma lupow systemu",
  /const ysum = FarmYieldDB\.systemSums\(\);/.test(src));
check("PlunderWatch.run() przed decyzja farmy", /await PlunderWatch\.run\(\)\.catch\(\(\) => \{\}\);/.test(src));
check("harvestDom profilu wpiety w init", /PlunderWatch\.harvestDom\(\); \} catch \{\}/.test(src));
check("panel: pole progu + przycisk TOP CELE",
  /id="ogx-farm-minprofit"/.test(src) && /id="ogx-farm-topdump"/.test(src));

if (fail) { console.error(`\n${fail} PORAŻKA/EK`); process.exit(1); }
console.log("\nWSZYSTKIE PRZYPADKI PRZESZŁY");
