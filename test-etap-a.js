// ─────────────────────────────────────────────────────────────────────────
//  TEST ETAPU A (v2.107.0) — switchTo na księżyc, schrony bramy, keepalive
// ─────────────────────────────────────────────────────────────────────────
// Powód (audyt 2, 27.08): hub NIEAKTYWNY ratowany w 55–100 s, bo switchTo
// klikał TYLKO planetę; brama skakała na dowolny księżyc (finta wypala huby);
// keepalive stał ZA bramką przerwy/nocy → wylogowanie → 15 min ślepoty.
//
// Wykonuje PRAWDZIWE ciała switchBodyFor() i pickDestination() wycięte z bota
// + sprawdza kolejność bloków w ticku po sygnaturach.

const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n");

function bodyOf(name, argList) {
  const sig = `    ${name}(${argList}) {`;
  const i = src.indexOf(sig);
  if (i < 0) throw new Error(`nie znalazłem metody ${name}(${argList}) w bocie`);
  const open = i + sig.length - 1;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(open + 1, j); }
  }
  throw new Error(`nie domknąłem ciała ${name}`);
}

let failures = 0;
function check(name, cond) { console.log(`${cond ? "OK  " : "FAIL"} | ${name}`); if (!cond) failures++; }

// ── 1. switchBodyFor: ciało z mapy hangarów ──
{
  const H = 48 * 60 * 60 * 1000;
  let store = {};
  const GM_getValue = (k, d) => (k in store ? store[k] : d);
  const FleetRecon = { KEY_HANGARS: "ogamex_hangar_map" };
  const fn = new Function("GM_getValue", "FleetRecon", `return function(coords, forced = null) {${bodyOf("switchBodyFor", "coords, forced = null")}}`)(GM_getValue, FleetRecon);
  store[FleetRecon.KEY_HANGARS] = JSON.stringify({
    "3:272:7": { total: 51e9, at: Date.now() - 60000, body: "moon" },
    "5:125:4": { total: 0, at: Date.now() - 60000, body: "moon" },
    "2:21:4": { total: 1e9, at: Date.now() - H - 1000, body: "moon" },
    "1:1:1": { total: 5, at: Date.now(), body: "planet" },
  });
  check("flota na księżycu wg mapy → 'moon'", fn("3:272:7") === "moon");
  check("hangar PUSTY → null (planeta, jak dotąd)", fn("5:125:4") === null);
  check("wpis starszy niż 48 h → null", fn("2:21:4") === null);
  check("flota na planecie wg mapy → 'planet'", fn("1:1:1") === "planet");
  check("para bez wpisu → null", fn("9:9:9") === null);
  check("opts.body wygrywa z mapą", fn("5:125:4", "moon") === "moon");
  store = {}; store[FleetRecon.KEY_HANGARS] = "{zepsuty";
  check("zepsuta mapa → null, bez wyjątku", fn("3:272:7") === null);
}

// ── 2. switchTo klika księżyc tylko, gdy para GO MA ──
{
  const body = bodyOf("switchTo", "coords, reason, opts = {}");
  check("switchTo pyta switchBodyFor o ciało", /this\.switchBodyFor\(coords, opts\.body \|\| null\)/.test(body));
  check("księżyc TYLKO gdy HomeBase.moonOf(a) istnieje, inaczej planeta", /if \(body === "moon"\) \{\s*const m = HomeBase\.moonOf\(a\);\s*if \(m\) el = m; else body = "planet";/.test(body));
  check("klik idzie w wybrane ciało (el.click), nie zawsze w planetę", /el\.click\(\);/.test(body) && !/\ba\.click\(\)/.test(body));
}

// ── 3. mapa hangarów zna ciało (moon-select też) ──
{
  const ap = bodyOf("activePlanet", "");
  check("activePlanet widzi zaznaczony moon-select (flota na księżycu trafia do mapy)", /moon-select\.selected/.test(ap));
  const hg = bodyOf("homeGuard", "snap");
  check("homeGuard zapisuje body w obu gałęziach", (hg.match(/body: snap\.body \|\| null/g) || []).length === 2);
  check("scan() dodaje body ze MoonSave.currentBody()", /body: \(\(\) => \{ try \{ return MoonSave\.currentBody\(\); \}/.test(src));
}

// ── 4. brama: schrony jako JEDYNE cele ──
{
  const CONFIG = { jumpGate: { havens: [] } };
  const logs = [];
  const helpers = {
    key(c) { return c && Number.isFinite(c.galaxy) ? `${c.galaxy}:${c.system}:${c.position}` : null; },
    parseKey(k) { const m = String(k || "").match(/^(\d+):(\d+):(\d+)$/); return m ? { galaxy: +m[1], system: +m[2], position: +m[3] } : null; },
  };
  const fn = new Function("CONFIG", "log", `return function(sel, at, attackedKeys) {${bodyOf("pickDestination", "sel, at, attackedKeys")}}`)(CONFIG, (m) => logs.push(m));
  const pick = helpers.pickDestination = fn;
  const sel = { options: [
    { textContent: "Hub B [2:21:1]" }, { textContent: "Schron [7:300:5]" }, { textContent: "Baza [5:125:4]" }, { textContent: "Schron2 [8:10:2]" },
  ] };
  const at = { galaxy: 5, system: 125, position: 4 };
  let r = pick.call(helpers, sel, at, []);
  check("bez schronów: pierwszy nieatakowany księżyc (jak 2.106.0)", r && helpers.key(r.c) === "2:21:1");
  CONFIG.jumpGate.havens = [{ galaxy: 7, system: 300, position: 5 }, { galaxy: 8, system: 10, position: 2 }];
  r = pick.call(helpers, sel, at, []);
  check("ze schronami: hub [2:21:1] POMINIĘTY, skok na schron", r && helpers.key(r.c) === "7:300:5");
  r = pick.call(helpers, sel, at, ["7:300:5"]);
  check("schron atakowany → drugi schron", r && helpers.key(r.c) === "8:10:2");
  r = pick.call(helpers, sel, at, ["7:300:5", "8:10:2"]);
  check("wszystkie schrony atakowane → null (Deploy), NIE hub", r === null && logs.some(m => /nie skaczę na hub/.test(m)));
  CONFIG.jumpGate.havens = [{ galaxy: 9, system: 9, position: 9 }];
  r = pick.call(helpers, sel, at, []);
  check("schron spoza listy bramy → null (nie skaczę byle gdzie)", r === null);
  check("config ma jumpGate.havens: [] i bramę WYŁĄCZONĄ (decyzja operatora 27.08)", /jumpGate: \{ enabled: false, targetMoon: null, takeResources: true, havens: \[\] \}/.test(src));
}

// ── 5. keepalive + samonaprawa sesji PRZED bramkami przerwy/nocy ──
{
  const iRec = src.indexOf("if (SessionWatch.maybeRecover()) return;");
  const iKeep = src.indexOf('log("Keepalive: no page load for >12min');
  const iBreak = src.indexOf("// v2.12.0: coffee breaks — full-bot pause with human macro-pacing.");
  const iNight = src.indexOf('log("Night mode active - sleeping until');
  check("maybeRecover przed keepalive przed przerwą przed nocą", iRec > 0 && iRec < iKeep && iKeep < iBreak && iBreak < iNight);
  const mr = bodyOf("maybeRecover", "");
  check("samonaprawa: dopiero 2 min po utracie sesji", /Date\.now\(\) - lost < 2 \* 60 \* 1000\) return false/.test(mr));
  check("samonaprawa: nie częściej niż co 15 min", /Date\.now\(\) - tried < 15 \* 60 \* 1000\) return false/.test(mr));
  check("samonaprawa: nie przerywa pending_mission", /pending_mission/.test(mr));
  check("samonaprawa: nawigacja na \"/\"", /window\.location\.replace\("\/"\)/.test(mr));
}

// ── 6. v2.108.0: PAMIĘĆ ATAKU Z LISTY (27.08 10:10:36 — prawdziwy atak, kandydat zniknął po 0 s) ──
{
  const src2 = require("fs").readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n");
  let f = 0;
  const c = (n, ok) => { console.log(`${ok ? "OK  " : "FAIL"} | ${n}`); if (!ok) f++; };
  c("odczyt r.foreign===0 → pamięć ataku (atk_until_map, dolot ≤ 20 min) podnosi foreign", /if \(!r \|\| r\.foreign === 0\) \{[\s\S]{0,700}?ogamex_atk_until_map[\s\S]{0,400}?mem\[k\] - now <= 20 \* 60 \* 1000[\s\S]{0,400}?foreign: live\.length \}/.test(src2));
  c("cel ratunku z pamięci PRZED ślepą ścieżką hangarów", (() => { const a = src2.indexOf("Cel ratunku z PAMIĘCI ATAKU"); const b = src2.indexOf("FleetRecon.hangarTargets(1)"); return a > 0 && b > 0 && a < b; })());
  failures += f;
}

console.log(failures ? `\n${failures} FAIL` : "\nETAP A: wszystko OK");
process.exit(failures ? 1 : 0);
