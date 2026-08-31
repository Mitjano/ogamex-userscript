// ═════════════════════════════════════════════════════════════════════════
//  TEST PANELU 3.x (UX) — czy panel buduje sie, pokazuje stan i daje sie schowac
// ═════════════════════════════════════════════════════════════════════════
// Powod: UI.build() jest w try/catch — wyjatek w panelu jest CICHY (bot zyje,
// panel pusty). Dodatkowo v3.11.0 przywrocila UX z Ateny: 232 px (nie zasłania
// menu gry), przeciaganie, zwijanie, sekcje zwiniete domyslnie, pasek stanu.
// Ten test pilnuje, zeby kolejna zmiana panelu tego nie zerwala.
//
//   node test3-ui.js
const fs = require("fs"), path = require("path"), { JSDOM } = require("jsdom");
// v3.46.0: ścieżka była ZAHARDKODOWANA na katalog z Maca — na każdej innej
// maszynie zestaw wywalał się ENOENT-em, zanim cokolwiek sprawdził.
const SRC = fs.readFileSync(path.join(__dirname, "ogamex-3.user.js"), "utf8");
const store = new Map();
const html = `<!doctype html><html><body>
 <div id="planetList">
   <a class="planet-select" data-planet-id="1" href="/overview?x=1&y=217&z=6"><span class="planet-name">Baza</span><span class="planet-koords">[1:217:6]</span></a>
   <a class="moon-select" data-planet-id="2" href="/overview?x=1&y=217&z=6"></a>
 </div>
 <div id="fleet-movement-content"></div></body></html>`;
const dom = new JSDOM(html, { url: "https://genesis.ogamex.net/overview", pretendToBeVisual: true, runScripts: "outside-only" });
const w = dom.window;
let panelErr = null;
w.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
w.GM_setValue = (k, v) => store.set(k, v);
w.GM_xmlhttpRequest = () => {};
w.GM_info = { script: { version: "3.11.0" } };
w.alert = () => {};
w.console.error = (...a) => { if (String(a[0]).includes("panel")) panelErr = a.join(" "); };
w.eval(SRC);

let fails = 0;
const ck = (n, c, extra = "") => { console.log(`${c ? "OK  " : "FAIL"} | ${n}${c ? "" : " → " + extra}`); if (!c) fails++; };
const D = w.document, $ = (id) => D.getElementById(id);

ck("panel zbudowany bez wyjątku", !panelErr, panelErr || "");
const p = $("ogx3-panel");
ck("panel jest w DOM", !!p);
ck("szerokość 232 px (nie zasłania menu gry)", w.getComputedStyle(p).width === "232px", w.getComputedStyle(p).width);
ck("nagłówek przeciągalny (cursor:move)", w.getComputedStyle($("ogx3-hd")).cursor === "move", w.getComputedStyle($("ogx3-hd")).cursor);

const rows = ["def", "fleet", "expo", "min", "fs"].map(k => $("ogx3-r-" + k));
ck("pasek stanu ma 5 wierszy", rows.every(Boolean));
const vals = rows.map(r => r && r.querySelector(".val").textContent);
ck("wszystkie wiersze maja tresc", vals.every(v => v && v !== "—"), JSON.stringify(vals));
console.log("     pasek:", vals.map((v, i) => ["🛡", "🛰", "🚀", "⛏", "🌙"][i] + " " + v).join(" | "));

// sekcje: domyślnie zwinięte, klik otwiera i zapisuje
const sec = p.querySelector('.sec[data-sec="expo"]');
ck("sekcje domyślnie zwinięte", !sec.classList.contains("open"));
ck("ustawienia ukryte przed klikiem", w.getComputedStyle(sec.querySelector(".sec-b")).display === "none");
sec.querySelector(".sec-t").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
ck("klik w tytuł rozwija sekcję", sec.classList.contains("open"));
ck("rozwinięcie zapisane w GM storage", JSON.stringify([...store.keys()]).includes("ui_open") && String(store.get("genesis.ogamex.net:ogx3_ui_open")).includes("expo"), String(store.get("genesis.ogamex.net:ogx3_ui_open")));

// minimalizacja
$("ogx3-min").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
ck("zwijanie chowa ciało panelu", $("ogx3-body").style.display === "none");
ck("zwijanie chowa też pasek stanu", $("ogx3-strip").style.display === "none");
ck("zwinięcie zapisane", store.get("genesis.ogamex.net:ogx3_ui_min") === "true", String(store.get("genesis.ogamex.net:ogx3_ui_min")));
$("ogx3-min").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
ck("ponowny klik rozwija", $("ogx3-body").style.display === "block");

// wszystkie ID przycisków z 3.10.x nadal istnieją (handlery i testy po ID)
const IDS = "on auto push voice recon deb aster fs fs-a fs-b expo disc waves slotres res spd sim-moon sim-planet dump report pushtest abort save home copy clear log status topic expo-st fs-st aster-st".split(" ");
const missing = IDS.filter(i => !$("ogx3-" + i));
ck("wszystkie pola/przyciski z 3.10.x na miejscu", missing.length === 0, "brakuje: " + missing.join(", "));

// v3.32.0: cisza nocna i przerwy kawowe muszą dać się wyłączyć BEZ grzebania
// w GM storage (pytanie właściciela 29.08: „jak wyłączyć nocną przerwę?").
const RYTM = "quiet quiet-a quiet-b breaks human-st".split(" ");
const brakRytm = RYTM.filter(i => !$("ogx3-" + i));
ck("rytm człowieka (cisza nocna + przerwy) sterowalny z panelu", brakRytm.length === 0, "brakuje: " + brakRytm.join(", "));
$("ogx3-quiet").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
ck("klik wyłącza ciszę nocną i zapisuje to w configu", /"enabled":false/.test(JSON.stringify(JSON.parse(store.get("genesis.ogamex.net:ogx3_cfg") || "{}").quietHours || {})), String(store.get("genesis.ogamex.net:ogx3_cfg")).slice(0, 200));
$("ogx3-breaks").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
ck("klik wyłącza przerwy kawowe i kasuje trwającą", JSON.parse(store.get("genesis.ogamex.net:ogx3_cfg") || "{}").human.breaks === false && Number(store.get("genesis.ogamex.net:ogx3_break_until")) === 0, String(store.get("genesis.ogamex.net:ogx3_break_until")));

// alarm: czerwona ramka + rozwinięcie zwiniętego panelu
$("ogx3-min").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));   // zwiń
const api = w.__OGX3;
const s = api.Situation.load();
s.threats = [{ id: "t1", dst: "1:217:6", dstBody: "moon", arriveAt: Date.now() + 120e3, attack: true, type: "ATTACK", source: "test" }];
api.Situation.save(s);
api.UI.renderStatus();
ck("alarm maluje panel na czerwono", p.classList.contains("alarm"));
ck("alarm rozwija zwinięty panel", $("ogx3-body").style.display === "block");
ck("wiersz Obrona krzyczy ATAK", $("ogx3-r-def").className.includes("alert") && $("ogx3-r-def").querySelector(".val").textContent.includes("ATAK"), $("ogx3-r-def").querySelector(".val").textContent);
console.log("     alarm:", $("ogx3-r-def").querySelector(".val").textContent);

console.log(fails ? `\nNIE: ${fails} sprawdzeń padło` : "\nPANEL OK — wszystko przeszło");
process.exit(fails ? 1 : 0);
