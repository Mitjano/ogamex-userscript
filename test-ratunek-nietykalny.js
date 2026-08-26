// Test „ratunek nietykalny" — pilnuje NAJGORSZEJ regresji, jaką ten bot może
// mieć: obrona wykrywa flotę, ale jej NIE PRZENOSI. W logu wygląda to prawie
// jak sukces (alarm jest, wpisy są), a kończy się utratą floty.
//
// Skąd ten test (07.08.2026, v2.79.0): dołożyliśmy bramki wysyłek
// (DefenceHold/Fuel), które celowo BLOKUJĄ ekspedycje, mining i farmienie
// w oknie obrony. Gdyby taka bramka kiedykolwiek — przy refaktorze, przez
// „ujednolicenie", przez copy-paste — trafiła na ścieżkę RATUNKU, ratunek
// zablokowałby sam siebie: przecież w chwili ratunku alarm TRWA, a na ciele
// zostaje sama rezerwa paliwa. Oba warunki bramek byłyby spełnione.
//
// Test czyta PRAWDZIWE ciała funkcji z pliku bota. Nie zna się na sytuacji
// w grze — sprawdza kontrakt: kto komu wolno powiedzieć „nie wysyłaj".
const fs = require("fs");
const PATH = require("path").join(__dirname, "ogamex-bot.user.js");
const src = fs.readFileSync(PATH, "utf8").replace(/\r\n/g, "\n") /* CRLF checkout (autocrlf) nie moze psuc markerow z \n */;

// Liczenie klamer musi omijać komentarze i stringi — w tym pliku pełno jest
// polskich komentarzy z „{" i szablonów `${...}`, a naiwny licznik urywał
// ciało funkcji w połowie. Ucięte ciało = sprawdzenie, które przechodzi,
// bo NIE DOCZYTAŁO do miejsca z błędem. Dlatego: kopia źródła z komentarzami
// i stringami zamienionymi na spacje (te same offsety!), klamry liczone na
// kopii, treść wycinana z oryginału.
const masked = (() => {
  const out = src.split("");
  let i = 0;
  const N = src.length;
  const blank = (from, to) => { for (let k = from; k < to && k < N; k++) if (out[k] !== "\n") out[k] = " "; };
  // Ostatni znaczący znak — po nim poznajemy, czy „/" zaczyna REGEX czy jest
  // dzieleniem. Bez tego apostrof w regexie (np. /[\d.,\s ']*/ w Fuel.read)
  // udawał początek stringa i zjadał pół pliku razem z klamrami.
  let prev = "";
  const startsRegex = () => prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev) || /\breturn$|\btypeof$|\bcase$/.test(prevWord);
  let prevWord = "";
  while (i < N) {
    const c = src[i], c2 = src[i + 1];
    if (c === "/" && c2 === "/") { const e = src.indexOf("\n", i); const end = e < 0 ? N : e; blank(i, end); i = end; continue; }
    if (c === "/" && c2 === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? N : e + 2; blank(i, end); i = end; continue; }
    if (c === "/" && startsRegex()) {
      let j = i + 1, inClass = false, closed = false;
      while (j < N) {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") break;              // niedomknięty „regex" = to było dzielenie
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) { blank(i, j + 1); prev = "/"; prevWord = ""; i = j + 1; continue; }
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < N) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      blank(i, Math.min(j + 1, N));
      prev = c; prevWord = "";
      i = j + 1;
      continue;
    }
    if (!/\s/.test(c)) {
      prev = c;
      prevWord = /[A-Za-z_$]/.test(c) ? prevWord + c : "";
    }
    i++;
  }
  return out.join("");
})();

function cutBody(marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`nie znalazłem „${marker.trim()}" — funkcja zniknęła albo zmieniła nazwę; test wymaga aktualizacji ŚWIADOMEJ, nie usunięcia`);
  // Klamra CIAŁA = OSTATNIA klamra w linii nagłówka, nie pierwsza po nazwie:
  // przy `returnHome({ byOperator = false } = {}) {` pierwsza otwiera listę
  // parametrów, a liczenie od niej dawało ciało długości 20 znaków — czyli
  // „brak bramki" przechodziło na PUSTCE. Dokładnie ten fałszywy sukces,
  // przed którym ten plik ma chronić.
  const lineStart = src.lastIndexOf("\n", start) + 1;
  const lineEnd = src.indexOf("\n", start);
  const i = masked.lastIndexOf("{", lineEnd < 0 ? masked.length : lineEnd);
  if (i < lineStart) throw new Error(`nie znalazłem klamry ciała w nagłówku „${marker.split("\n")[0].trim()}"`);
  let depth = 0, end = -1;
  for (let j = i; j < masked.length; j++) {
    if (masked[j] === "{") depth++;
    else if (masked[j] === "}") { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end < 0) throw new Error(`nie domknąłem ciała „${marker.trim()}" — parser testu wymaga poprawki`);
  return src.slice(i + 1, end);
}

let bad = 0;
const ok = (cond, desc, detail = "") => {
  if (!cond) bad++;
  console.log(`${cond ? "OK  " : "BŁĄD"} | ${desc}${detail ? ` | ${detail}` : ""}`);
};

// ── 1. Ścieżka ratunku NIE MOŻE pytać bramek wysyłek ──
// Wolno jej je STEMPLOWAĆ (DefenceHold.stamp = „ratunek poszedł, wysyłki
// stoją"), ale nigdy PYTAĆ o zgodę (allows/reason).
const RESCUE = [
  ["MoonSave.autoSaveOnThreat", "    async autoSaveOnThreat() {"],
  ["MoonSave.returnHome", "    async returnHome({ byOperator = false } = {}) {"],
  ["MoonSave.keepPlanetEmpty (straż wielofalowa)", "    async keepPlanetEmpty() {"],
  ["MoonSave.run (sama wysyłka ratunku)", "    async run({ manual = false, sweep = false, auto = false, reason = \"manual\", where = null, queued = false, noGate = false } = {}) {"],
  ["RescueQueue.tryNext (2. kolonia)", "    async tryNext(w) {"],
  ["handlePendingMission (formularz floty)", "  async function handlePendingMission() {"],
];

for (const [name, marker] of RESCUE) {
  const body = cutBody(marker);
  // Bezpiecznik na sam test: ciało krótsze niż 500 znaków to znak, że parser
  // uciął funkcję — a wtedy „nie znalazłem bramki" nic nie znaczy. Test, który
  // przechodzi na pustce, jest gorszy niż brak testu.
  ok(body.length > 500, `ciało funkcji wczytane w całości: ${name}`,
     body.length > 500 ? "" : `tylko ${body.length} znaków — parser testu urwał funkcję, sprawdzenie poniżej byłoby fikcją`);
  const asks = body.match(/(?:DefenceHold|Fuel)\s*\.\s*(?:allows|reason|read|reserve)\s*\(/g) || [];
  ok(asks.length === 0, `ratunek bez bramki wysyłek: ${name}`,
     asks.length ? `ZNALEZIONO: ${[...new Set(asks)].join(", ")} — ratunek zablokuje sam siebie (w alarmie bramka ZAWSZE mówi „nie")` : "");
}

// ── 2. Moduły zarobkowe MUSZĄ mieć obie bramki ──
// Druga strona tej samej umowy: gdyby ktoś je usunął, wróciłby stan sprzed
// 07.08 (mining latał w alarmie, ekspedycja poszła 66 s po jego zdjęciu).
const EARNERS = [
  ["AsteroidMiner.run", "    async run() {\n      if (!CONFIG.asteroidMining.enabled", ["DefenceHold.allows"]],
  ["AsteroidMiner.dispatchToFoundAsteroid", "    async dispatchToFoundAsteroid(scanState) {", ["DefenceHold.allows", "Fuel.allows"]],
  ["ExpeditionRunner.run", "    async run() {\n      const cfg = CONFIG.expeditions;", ["DefenceHold.allows", "Fuel.allows"]],
  ["InactiveFarmer.run", "    async run() {\n      const cfg = CONFIG.inactiveFarming;", ["DefenceHold.allows"]],
];

for (const [name, marker, wanted] of EARNERS) {
  const body = cutBody(marker);
  for (const w of wanted) {
    ok(body.includes(w), `${name} pyta o zgodę: ${w}`,
       body.includes(w) ? "" : "BRAK — moduł może wysłać flotę w trakcie ewakuacji");
  }
}

// ── 3. Stempel okna obrony musi być stawiany przy KAŻDYM ruchu ratunku ──
// Bez niego hold kończy się w sekundzie zdjęcia alarmu, a ratunek/powrót
// jest jeszcze w powietrzu razem z paliwem (dokładnie luka z 11:21:50).
const saveBody = cutBody("    async run({ manual = false, sweep = false, auto = false, reason = \"manual\", where = null, queued = false, noGate = false } = {}) {");
const returnBody = cutBody("    async returnHome({ byOperator = false } = {}) {");
ok(/DefenceHold\s*\.\s*stamp\s*\(/.test(saveBody), "ratunek stempluje okno obrony (DefenceHold.stamp)");
ok(/DefenceHold\s*\.\s*stamp\s*\(/.test(returnBody), "powrót stempluje okno obrony (DefenceHold.stamp)");

// ── 4. Nadzorca dalej pilnuje ciszy ──
// Kontrakt z v2.76.0: „floty nie ruszam" musi zostawiać ślad. Gdyby bramki
// wysyłek zjadły ten wpis, cisza znów zaczęłaby wyglądać jak porządek.
ok(src.includes("DefenceWatchdog.note"), "nadzorca obrony wciąż wpięty (DefenceWatchdog.note)");

console.log(bad === 0
  ? "\nRATUNEK NIETYKALNY: WSZYSTKIE PRZYPADKI PRZESZŁY"
  : `\nRATUNEK NIETYKALNY: ${bad} PRZYPADKÓW NIE PRZESZŁO — NIE WYPUSZCZAJ TEJ WERSJI`);
process.exit(bad === 0 ? 0 : 1);
