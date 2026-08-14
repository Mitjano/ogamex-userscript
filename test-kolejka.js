// ─────────────────────────────────────────────────────────────────────────
//  TEST KOLEJKI RATUNKÓW  (v2.78.0)
// ─────────────────────────────────────────────────────────────────────────
// Ten test istnieje z jednego powodu: właściciel boi się, że nowa funkcja
// zepsuje ratunek, który 7.08 o 10:41 zadziałał na żywo (46 s od wykrycia
// do floty w powietrzu). Dlatego NAJPIERW zamraża dzisiejsze zachowanie,
// a dopiero potem sprawdza nową ścieżkę.
//
// Jak każdy test w tym repo: wyciąga PRAWDZIWE ciało funkcji z pliku bota
// i wykonuje je. Test na przepisanej kopii logiki jest wart tyle, co brak
// testu — kopia może się rozjechać z oryginałem i nikt tego nie zauważy.

const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n") /* CRLF checkout (autocrlf) nie moze psuc markerow z \n */;

// ── wyciągnij ciało metody po nazwie (liczenie klamer) ──────────────────
function bodyOf(name, argList) {
  const sig = `    ${name}(${argList}) {`;
  const i = src.indexOf(sig);
  if (i < 0) throw new Error(`nie znalazłem metody ${name}(${argList}) w bocie`);
  // Klamrę CIAŁA bierzemy z końca sygnatury, nie pierwszą z brzegu: przy
  // argumencie destrukturyzowanym `({ a, b })` pierwsza klamra po nazwie
  // należy do listy argumentów i licznik zamykał się na niej.
  const open = i + sig.length - 1;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, j);
    }
  }
  throw new Error(`nie domknąłem ciała ${name}`);
}

const nextTarget = new Function("o", bodyOf("nextTarget", "{ targets, guarded, done }")
  .replace(/^\s*/, "const { targets, guarded, done } = o;\n"));
const verdict = new Function("s", bodyOf("verdict", "s"));

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`  ✗ ${name}\n      dostałem: ${JSON.stringify(got)}\n      oczekiwane: ${JSON.stringify(want)}`); }
  else console.log(`  ✓ ${name}`);
};

console.log("\n── A. WYBÓR KOLEJNEJ KOLONII ──");

eq("jedyny cel = ten już pilnowany → nic do roboty",
  nextTarget({ targets: ["3:272:7"], guarded: "3:272:7", done: [] }), null);

eq("drugi atak na INNĄ kolonię → bierzemy ją",
  nextTarget({ targets: ["3:272:7", "2:151:8"], guarded: "3:272:7", done: [] }), "2:151:8");

eq("kolonia już uratowana w tym alarmie → pomijamy",
  nextTarget({ targets: ["3:272:7", "2:151:8"], guarded: "3:272:7", done: ["2:151:8"] }), null);

eq("trzeci atak, druga już zrobiona → bierzemy trzecią",
  nextTarget({ targets: ["3:272:7", "2:151:8", "4:297:9"], guarded: "3:272:7", done: ["2:151:8"] }), "4:297:9");

eq("cel spoza pilnowanej listy, gdy straż nie zna koordów (guarded=null)",
  nextTarget({ targets: ["2:151:8"], guarded: null, done: [] }), "2:151:8");

eq("brak celów → null (nigdy nie zgadujemy kolonii)",
  nextTarget({ targets: [], guarded: "3:272:7", done: [] }), null);

eq("śmieci w liście celów nie wywracają wyboru",
  nextTarget({ targets: [null, "", "2:151:8"], guarded: "3:272:7", done: [] }), "2:151:8");

eq("ta sama kolonia dwa razy w liście → tylko raz",
  nextTarget({ targets: ["2:151:8", "2:151:8"], guarded: "3:272:7", done: ["2:151:8"] }), null);

console.log("\n── B. NADZORCA: DZISIEJSZE ZACHOWANIE MA ZOSTAĆ NIETKNIĘTE ──");
// Te cztery przypadki opisują stan z 7.08 10:41, który przeszedł na żywo.
// Jeśli którykolwiek padnie, kolejka zepsuła podstawową obronę.
const G = 90 * 1000;
const base = { expected: true, armed: false, saves: 0, pendingRescue: false, decisionAgeMs: null, aliveMs: 0, graceMs: G };

eq("świeży alarm = czekamy", verdict({ ...base, aliveMs: 1000 }).state, "waiting");
eq("flota ewakuowana = OK (przebieg z 10:41)", verdict({ ...base, aliveMs: 5 * G, armed: true, saves: 1 }).state, "ok");
eq("jawna decyzja = OK", verdict({ ...base, aliveMs: 5 * G, decisionAgeMs: 1000 }).state, "ok");
eq("cisza przy alarmie = awaria", verdict({ ...base, aliveMs: 5 * G }).state, "STUCK");
eq("straż bez zapisu = awaria", verdict({ ...base, aliveMs: 5 * G, armed: true, saves: 0 }).state, "STUCK");
eq("brak alarmu = nadzorca śpi", verdict({ ...base, expected: false }).state, "off");

console.log("\n── C. NADZORCA WIDZI PORZUCONĄ KOLONIĘ ──");
// Bez tego awaria kolejki byłaby NIEWIDOCZNA: straż uzbrojona + 1 zapis
// wyglądały jak sukces, choć druga kolonia stała bez reakcji.

eq("uratowana jedna, druga porzucona = awaria",
  verdict({ ...base, aliveMs: 5 * G, armed: true, saves: 1, unhandled: 1 }).state, "STUCK");

eq("porzucona kolonia w oknie karencji jeszcze nie alarmuje",
  verdict({ ...base, aliveMs: 1000, armed: true, saves: 1, unhandled: 1 }).state, "ok");

eq("wszystkie kolonie obsłużone = OK",
  verdict({ ...base, aliveMs: 5 * G, armed: true, saves: 1, unhandled: 0 }).state, "ok");

console.log("\n── D. PROMOCJA ODRZUCA PRZESTARZAŁE WPISY (incydent 12.08 23:00) ──");
// Po powrocie z TESTU ALARMU promocja wyjęła wpis TEJ SAMEJ kolonii sprzed
// godzin (bitwa 15:26) z odwrotnym kierunkiem — drugi powrót ruszył
// księżyc→planeta i od wywiezienia całej floty w złą stronę dzieliło go 5 s.
const staleReason = new Function("nx", "justReturned", "now", "maxAgeMs",
  bodyOf("staleReason", "nx, justReturned, now, maxAgeMs"));
const H4 = 4 * 60 * 60 * 1000;
const NOW = 1_755_000_000_000;

eq("świeży wpis innej kolonii → promowany (null = brak powodu odrzucenia)",
  staleReason({ at: "2:151:8", savedAt: NOW - 60_000 }, "3:272:7", NOW, H4), null);

eq("wpis kolonii, która WŁAŚNIE wróciła → odrzucony (scenariusz 23:00)",
  staleReason({ at: "3:272:7", savedAt: NOW - 60_000 }, "3:272:7", NOW, H4) !== null, true);

eq("wpis starszy niż 4 h → odrzucony (alarm dawno wygasł)",
  staleReason({ at: "2:151:8", savedAt: NOW - H4 - 1 }, "3:272:7", NOW, H4) !== null, true);

eq("wpis z koordami-obiektem działa jak stringowy",
  staleReason({ at: { galaxy: 3, system: 272, position: 7 }, savedAt: NOW - 60_000 }, "3:272:7", NOW, H4) !== null, true);

eq("świeży wpis obiektowy innej kolonii → promowany",
  staleReason({ at: { galaxy: 2, system: 151, position: 8 }, savedAt: NOW - 60_000 }, "3:272:7", NOW, H4), null);

eq("wpis bez koordynatów → odrzucony (nigdy nie zgadujemy kolonii)",
  staleReason({ at: null, savedAt: NOW }, null, NOW, H4) !== null, true);

eq("brak justReturned (straż nie zna koordów) nie blokuje świeżego wpisu",
  staleReason({ at: "2:151:8", savedAt: NOW - 60_000 }, null, NOW, H4), null);

console.log(
  fails
    ? `\nKOLEJKA: ${fails} PRZYPADEK/PRZYPADKÓW NIEZDANYCH\n`
    : "\nKOLEJKA: WSZYSTKIE PRZYPADKI PRZESZŁY\n"
);
process.exit(fails ? 1 : 0);
