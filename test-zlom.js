// ─────────────────────────────────────────────────────────────────────────
//  TEST ZBIERANIA ZŁOMU PO EKSPEDYCJACH  (v2.99.3)
// ─────────────────────────────────────────────────────────────────────────
// Powód: 25.08 na [3:272:16] leżało 81 mld metalu / 31 mld kryształu po
// walce z obcymi, a bot „zaglądał co 20 min" i nic nie wysyłał. Wizyta
// (visit) jeździła na galaktykę bazy głównie przy NIEaktywnym skanie, a
// sprawdzenie po dojeździe (tryCollectHere) żyło tylko w gałęzi „skan
// AKTYWNY" — wizyta lądowała na stronie i nic nie robiła.
//
// Test wykonuje PRAWDZIWE ciało findDebrisLink() wyjęte z pliku bota
// (na sztucznym DOM) i sprawdza strukturę init()/ticka na źródle.

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

// ── sztuczny DOM: wiersze galaktyki ─────────────────────────────────────
function el(attrs = {}, children = [], html = "") {
  const node = {
    attrs, children, innerHTML: html, textContent: attrs.text || "",
    getAttribute: (k) => attrs[k] ?? null,
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } };
      walk(this); return out;
    },
  };
  return node;
}
function matches(n, sel) {
  return sel.split(",").some(s => {
    s = s.trim();
    if (s === ".planet-index") return n.attrs.cls === "planet-index";
    if (s === ".col-debris" || s === ".galaxy-col.col-debris") return n.attrs.cls === "col-debris";
    if (s === ".galaxy-item") return n.attrs.cls === "galaxy-item";
    if (s === "a[href*='/fleet']") return n.attrs.tag === "a" && String(n.attrs.href || "").includes("/fleet");
    if (s === "[rel^='debris']") return String(n.attrs.rel || "").startsWith("debris");
    return false;
  });
}
function row(idx, debrisCell) {
  return el({ cls: "galaxy-item" }, [el({ cls: "planet-index", text: String(idx) }), ...(debrisCell ? [debrisCell] : [])]);
}
function run(rows, byId = {}) {
  const logs = [];
  const document = {
    querySelectorAll: (sel) => (sel === ".galaxy-item" ? rows : []),
    getElementById: (id) => byId[id] || null,
  };
  const ctx = { document, GM_getValue: () => "1", GM_setValue() {}, log: (m) => logs.push(m) };
  const fn = new Function("document", "GM_getValue", "GM_setValue", "log", "base", "return (function(){" + bodyOf("findDebrisLink", "") + "}).call({ base })");
  const res = fn(document, ctx.GM_getValue, ctx.GM_setValue, ctx.log, () => ({ galaxy: 3, system: 272, position: 7 }));
  return { res, logs };
}

// 1. link w komórce → zwracany wprost
{
  const cell = el({ cls: "col-debris" }, [el({ tag: "a", href: "/fleet?x=3&y=272&z=16&mission=8" })], "<a>Recycle</a>");
  const { res } = run([row(15), row(16, cell), row(17)]);
  check("link zbierania w komórce poz. 16 → href z linku", res === "/fleet?x=3&y=272&z=16&mission=8");
}
// 2. tooltip poza komórką (rel → id)
{
  const cell = el({ cls: "col-debris" }, [el({ tag: "a", href: "#", rel: "debris3_272_16" })], "<a rel>x</a>");
  const tip = el({}, [el({ tag: "a", href: "/fleet?x=3&y=272&z=16&type=3" })]);
  const { res } = run([row(16, cell)], { debris3_272_16: tip });
  check("link w tooltipie wskazanym przez rel → href z tooltipa", res === "/fleet?x=3&y=272&z=16&type=3");
}
// 3. złom widoczny, brak jakiegokolwiek linku → fallback na same koordy
{
  const cell = el({ cls: "col-debris" }, [], "<span class='microdebris'></span>");
  const { res, logs } = run([row(16, cell)]);
  check("złom bez linku → /fleet po koordach poz. 16", res === "/fleet?x=3&y=272&z=16");
  check("… i wpis w logu o fallbacku", logs.some(l => /bez linku/.test(l)));
}
// 4. pusta komórka 16, złom przy bazie (poz. 7) → link z poz. 7
{
  const c16 = el({ cls: "col-debris" }, [], "");
  const c7 = el({ cls: "col-debris" }, [], "<span></span>");
  const { res } = run([row(7, c7), row(16, c16)]);
  check("pusta 16, złom przy pozycji bazy → koordy pozycji bazy", res === "/fleet?x=3&y=272&z=7");
}
// 5. nic nigdzie → null
{
  const { res } = run([row(16, el({ cls: "col-debris" }, [], "  ")), row(17)]);
  check("brak złomu → null", res === null);
}

// ── struktura: sprawdzenie NIE zależy od stanu skanu ─────────────────────
{
  const initStart = src.indexOf("  function init()");
  const initSrc = src.slice(initStart);
  const universal = initSrc.indexOf('GameState.getCurrentPage() === "galaxy") {\n      try { if (DebrisCollector.tryCollectHere()) return; } catch {}');
  const scanBranch = initSrc.indexOf("Resuming galaxy scan...");
  check("init(): tryCollectHere na galaktyce PRZED gałęzią „skan aktywny”", universal > 0 && universal < scanBranch);
  check("tick: tryCollectHere na galaktyce przed shouldVisit", /getCurrentPage\(\) === "galaxy" && DebrisCollector\.tryCollectHere\(\)\) return; \} catch \{\}\n\s+if \(DebrisCollector\.shouldVisit\(\)\)/.test(src));
}
// ── recyklery: niewiedza ≠ zero ──────────────────────────────────────────
{
  const rh = bodyOf("recyclersHome", "");
  check("recyclersHome(): brak zwiadu → null (nie 0)", /if \(!recon\?\.ships\) return null;/.test(rh) && /catch \{ return null; \}/.test(rh));
  // zwiad zapisuje ships jako TABLICĘ [{type, qty}] — wykonaj prawdziwe ciało
  const rhFn = new Function("document", "GM_getValue", "return (function(){" + rh + "}).call({})");
  const noDom = { querySelectorAll: () => [] };
  check("recyclersHome(): tablica ze zwiadu → liczba recyklerów", rhFn(noDom, () => JSON.stringify({ ships: [{ type: "ASTEROID_MINER", qty: 5 }, { type: "RECYCLER", qty: 7898922610 }] })) === 7898922610);
  check("recyclersHome(): tablica bez recyklerów → 0", rhFn(noDom, () => JSON.stringify({ ships: [{ type: "ASTEROID_MINER", qty: 5 }] })) === 0);
  check("recyclersHome(): brak zwiadu → null", rhFn(noDom, () => "null") === null);
  const sv = bodyOf("shouldVisit", "");
  check("shouldVisit(): blokuje tylko przy PEWNYM zerze recyklerów", /recyclersHome\(\) === 0\) return false/.test(sv) && !/recyclersHome\(\) <= 0/.test(sv));
}

// v2.99.5: strażnicy duplikatu (lokalny + 2× serwerowy) omijają recycle
{
  const guards = (src.match(/mission\.fleetSave \|\| mission\.recycle\) \? null : await fleetAlreadyFlyingTo/g) || []).length;
  check("strażnik serwerowy duplikatu omija recycle (2 miejsca)", guards === 2);
  check("strażnik lokalny duplikatu omija recycle", /!mission\.fleetSave && !mission\.recycle\) try \{/.test(src));
}

console.log(failures ? `\n${failures} FAIL` : "\nWSZYSTKO OK");
process.exit(failures ? 1 : 0);
