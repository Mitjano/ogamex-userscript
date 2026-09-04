// ═════════════════════════════════════════════════════════════════════════
//  ZEGAR DOLOTU (v3.66.0) — czy godzina uderzenia jest DOKLADNA
// ═════════════════════════════════════════════════════════════════════════
// Powod: gra pokazuje samo odliczanie, i to na stronie, ktora bot co chwile
// przeladowuje. Operator planuje wysylke recyklerow na SEKUNDY po uderzeniu,
// wiec zawyzony zegar = cudzy zlom, a zanizony = zbieracze w srodku bitwy.
// Ten zestaw pilnuje czterech rzeczy, na ktorych stoi cala dokladnosc:
//   1. zastygly `data-remaining-seconds` nie moze zawyzyc dolotu,
//   2. pozniejszy (gorszy) odczyt nie moze przesunac kotwicy do przodu,
//   3. tylko przeskok o DOKLADNIE 1 s jest kotwica precyzyjna,
//   4. fala ACS = jeden alarm przed pierwsza i jeden sygnal po ostatniej.
// (Bez polskich znakow w asercjach — polski cudzyslow otwierajacy zamykany
//  zwyklym " zdazyl juz raz wysadzic ten plik.)
//
//   node test3-zegar.js
const fs = require("fs"), path = require("path"), { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "ogamex-3.user.js"), "utf8");
const store = new Map();

const dwa = (n) => String(n).padStart(2, "0");
const stempel = (d) => `${dwa(d.getDate())}.${dwa(d.getMonth() + 1)}.${d.getFullYear()} ${dwa(d.getHours())}:${dwa(d.getMinutes())}:${dwa(d.getSeconds())}`;

const html = `<!doctype html><html><body>
 <div id="planetList">
   <a class="planet-select" data-planet-id="1" href="/overview?x=1&y=217&z=6"><span class="planet-name">Baza</span><span class="planet-koords">[1:217:6]</span></a>
   <a class="moon-select" data-planet-id="2" href="/overview?x=1&y=217&z=6"></a>
 </div>
 <span id="zegar">01.01.2026 00:00:00</span>
 <div id="fleet-movement-content"><table><tbody id="tb"></tbody></table></div>
</body></html>`;
const dom = new JSDOM(html, { url: "https://genesis.ogamex.net/", pretendToBeVisual: true, runScripts: "outside-only" });
const w = dom.window;
w.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
w.GM_setValue = (k, v) => store.set(k, v);
w.GM_xmlhttpRequest = () => {};
w.GM_info = { script: { version: "3.66.0" } };
w.alert = () => {};
w.eval(SRC);

let fails = 0;
const ck = (n, c, extra = "") => { console.log(`${c ? "OK  " : "FAIL"} | ${n}${c ? "" : " -> " + extra}`); if (!c) fails++; };
const D = w.document;
const api = w.__OGX3;
const { Impact, Clock, Rows, PlanetBar } = api;
const own = () => PlanetBar.ownKeys();
const eta1 = () => Rows.readEvents(own())[0].eta;

const wiersz = (id, attr, txt) =>
  `<tr class="row-mission-type-ATTACK row-hostile-mission" data-fleet-id="${id}">
     <td data-remaining-seconds="${attr}">${txt}</td>
     <td><span class="fleet-source-coords">[1:217:3]</span> Wrog</td>
     <td><a href="#">[1:217:6]</a> <img src="/img/moon-icon.png">Moon</td>
   </tr>`;
const wstaw = (h) => { D.getElementById("tb").innerHTML = h; };

console.log("---- 1. ile zostalo: atrybut kontra licznik na ekranie");
wstaw(wiersz("f1", 213, "03:33"));
ck("zgodny atrybut i licznik = 213 s", eta1() === 213, String(eta1()));

// Sedno sprawy: bot siedzi na stronie wczytanej 9 minut temu. Fork wpisuje
// `data-remaining-seconds` przy RENDERZE, a tyka sam napis: atrybut mowi
// "jeszcze 10 minut", ekran mowi "jeszcze minuta". Zawyzenie tutaj oznacza
// recyklery wyslane 9 minut po czasie, czyli cudzy zlom.
wstaw(wiersz("f2", 600, "01:00"));
ck("zastygly atrybut (600 s) przegrywa z licznikiem (01:00)", eta1() === 60, String(eta1()));

wstaw(wiersz("f3", 45, "12:00"));
ck("licznik NIE ma prawa zawyzyc - wygrywa mniejszy atrybut (45 s)", eta1() === 45, String(eta1()));

wstaw(wiersz("f4", 3725, "1:02:05"));
ck("licznik godzinowy 1:02:05 czytany poprawnie", eta1() === 3725, String(eta1()));

wstaw(wiersz("f5", 90, "-"));
ck("nieczytelny licznik nie psuje odczytu (zostaje atrybut)", eta1() === 90, String(eta1()));

ck("kazdy odczyt niesie wlasny stempel czasu (readAt)", Math.abs(Rows.readEvents(own())[0].readAt - Date.now()) < 2000);

console.log("\n---- 2. kotwica dolotu: najwczesniejszy odczyt wygrywa");
Impact.save({});
const T = Date.now();
Impact.note([{ id: "k1", eta: 100, readAt: T, attack: true, dst: "1:217:6", dstBody: "moon", type: "ATTACK" }]);
const kotwica = Impact.all().k1.at;
ck("dolot = stempel odczytu + ile zostalo", Math.abs(kotwica - (T + 100000)) < 50, String(kotwica - T));

Impact.note([{ id: "k1", eta: 100, readAt: T + 30000, attack: true, dst: "1:217:6", type: "ATTACK" }]);
ck("odczyt ze STAREJ strony (zawyzony) nie przesuwa dolotu", Impact.all().k1.at === kotwica, String(Impact.all().k1.at - kotwica));

Impact.note([{ id: "k1", eta: 65, readAt: T + 30000, attack: true, dst: "1:217:6", type: "ATTACK" }]);
ck("swiezszy odczyt przesuwa dolot WCZESNIEJ", Math.abs(Impact.all().k1.at - (T + 95000)) < 50, String(Impact.all().k1.at - T));

Impact.anchor("k1", T + 90000, true, {});
ck("kotwica precyzyjna nadpisuje zwykla", Impact.all().k1.at === T + 90000 && Impact.all().k1.precise === true);
Impact.note([{ id: "k1", eta: 10, readAt: T + 30000, attack: true, dst: "1:217:6", type: "ATTACK" }]);
ck("zwykly odczyt nie rusza juz kotwicy precyzyjnej", Impact.all().k1.at === T + 90000, String(Impact.all().k1.at - T));

// Wiersz ACS nie zdradza zrodla (ma "Players: 1/1"), zwykly wiersz zdradza.
// Ubozszy odczyt nie moze skasowac tego, co juz wiemy o celu.
Impact.note([{ id: "k1", eta: 10, readAt: T, attack: true, dst: "1:217:6", src: null, type: "ATTACK" }]);
ck("ubozszy odczyt nie kasuje znanego celu", Impact.all().k1.dst === "1:217:6" && Impact.all().k1.dstBody === "moon", JSON.stringify(Impact.all().k1));

console.log("\n---- 3. probnik na ekranie lapie przeskok licznika");
Impact.save({}); Impact.live.clear(); Impact.obce.clear();
wstaw(wiersz("p1", 120, "02:00"));
Impact.sample();
ck("nowy wrogi wiersz od razu trafia do zegara", !!Impact.all().p1, JSON.stringify(Impact.all()));
{
  const cd = D.querySelector("[data-remaining-seconds]");
  cd.setAttribute("data-remaining-seconds", "119"); cd.textContent = "01:59";
  const tPrzeskok = Date.now();
  Impact.sample();
  const v = Impact.all().p1;
  ck("przeskok o DOKLADNIE 1 s kotwiczy precyzyjnie", !!v && v.precise === true, JSON.stringify(v));
  ck("precyzyjny dolot zgadza sie co do sekundy", !!v && Math.abs(v.at - (tPrzeskok + 119000)) < 1000, v ? String(v.at - tPrzeskok) : "brak");
}
// Przerysowanie tabeli przez gre potrafi zmienic licznik o kilka sekund naraz:
// to nie jest uplyw czasu i nie wolno z tego robic kotwicy precyzyjnej.
Impact.save({}); Impact.live.clear(); Impact.obce.clear();
wstaw(wiersz("p2", 120, "02:00"));
Impact.sample();
{
  const c2 = D.querySelector("[data-remaining-seconds]");
  c2.setAttribute("data-remaining-seconds", "111"); c2.textContent = "01:51";
  Impact.sample();
  ck("skok o 9 s (przerysowanie) NIE jest kotwica precyzyjna", !!Impact.all().p2 && !Impact.all().p2.precise, JSON.stringify(Impact.all().p2));
}

console.log("\n---- 4. fala ACS: alarm przed pierwsza, sygnal recki po ostatniej");
Impact.save({});
const B = Date.now() + 60000;
Impact.anchor("a1", B, false, { attack: true, dst: "1:217:6", dstBody: "moon", type: "ATTACK" });
Impact.anchor("a2", B + 8000, false, { attack: true, dst: "1:217:6", dstBody: "moon", type: "ATTACK" });
Impact.anchor("a3", B + 16000, false, { attack: true, dst: "1:217:6", dstBody: "moon", type: "ATTACK" });
const L = Impact.list();
ck("ostrzezenie nalezy do PIERWSZEJ fali", Impact.pierwsza(L[0]) && !Impact.pierwsza(L[1]) && !Impact.pierwsza(L[2]));
ck("sygnal recki nalezy do OSTATNIEJ fali", Impact.ostatnia(L[2]) && !Impact.ostatnia(L[0]) && !Impact.ostatnia(L[1]));
Impact.anchor("b1", B, false, { attack: true, dst: "2:224:7", dstBody: "planet", type: "ATTACK" });
{
  const b = Impact.list().find(x => x.id === "b1");
  ck("atak na INNE cialo ma wlasny alarm", Impact.pierwsza(b) && Impact.ostatnia(b));
}

console.log("\n---- 5. zegar serwera z naglowka gry");
{
  const el = D.getElementById("zegar");
  Clock._el = null; Clock._txt = null;
  el.textContent = stempel(new Date(Date.now() + 90000));
  Clock.sample();
  el.textContent = stempel(new Date(Date.now() + 91000));
  Clock.sample();
  const off = Clock.offset();
  ck("offset serwera odczytany z naglowka (~90 s)", Math.abs(off - 90000) < 3000, String(off));
  ck("godzina uderzenia liczona w czasie SERWERA", /\d{1,2}:\d{2}:\d{2}/.test(Clock.hms(B)), Clock.hms(B));
}

console.log("\n---- 6. panel pokazuje GODZINE, nie samo odliczanie");
{
  Impact.save({});
  Impact.anchor("u1", Date.now() + 125000, true, { attack: true, dst: "1:217:6", dstBody: "moon", type: "ATTACK", src: "1:217:3" });
  api.UI.renderStatus();
  api.UI.renderImpact();
  const lista = D.getElementById("ogx3-imp-list");
  const pasek = D.getElementById("ogx3-r-imp");
  const sek = D.querySelector('.sec[data-sec="imp"]');
  ck("sekcja zegara istnieje w panelu", !!lista);
  ck("panel podaje GODZINE uderzenia", !!lista && /\d{1,2}:\d{2}:\d{2}/.test(lista.textContent), lista ? lista.textContent.slice(0, 120) : "brak");
  ck("panel podaje godzine wyslania reckow", !!lista && /recki/i.test(lista.textContent), lista ? lista.textContent.slice(0, 200) : "brak");
  ck("pasek stanu pokazuje dolot", !!pasek && pasek.style.display !== "none" && /\d{1,2}:\d{2}/.test(pasek.textContent), pasek ? pasek.textContent : "brak");
  ck("atak blizej niz 10 min sam rozwija sekcje", !!sek && sek.classList.contains("open"));
  console.log("     panel:", (lista ? lista.textContent : "").replace(/\s+/g, " ").trim().slice(0, 150));
  console.log("     pasek:", pasek ? pasek.textContent.replace(/\s+/g, " ").trim() : "brak");

  // Uderzenie wlasnie spadlo: pasek NIE moze zgasnac, bo to sa dokladnie te
  // dwie minuty, w ktorych operator wysyla recyklery.
  Impact.save({});
  Impact.anchor("u2", Date.now() - 3000, true, { attack: true, dst: "1:217:6", dstBody: "moon", type: "ATTACK" });
  api.UI.renderImpact();
  ck("tuz po uderzeniu pasek wola o recki", pasek.style.display !== "none" && /RECKI/.test(pasek.textContent), pasek.textContent);

  // Cisza = pasek znika, zeby nie udawac zagrozenia, ktorego nie ma.
  Impact.save({});
  api.UI.renderImpact();
  ck("po ustaniu zagrozenia pasek dolotu znika", pasek.style.display === "none", pasek.style.display);
}

console.log(fails ? `\nNIE: ${fails} sprawdzen padlo` : "\nZEGAR OK - wszystko przeszlo");
process.exit(fails ? 1 : 0);
