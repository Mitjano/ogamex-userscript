// Jedno wejście do wszystkich testów bota — do odpalenia PRZED każdym pushem.
// Powód (obawa ownera 07.08.2026): „teraz działa, ale kolejny update może
// zrobić tak, że bot wykryje flotę i jej nie przeniesie". Ta regresja nie boli
// od razu i w logu wygląda prawie jak sukces — dlatego ma własny test, a nie
// nadzieję, że ktoś zauważy.
//
//   node test-all.js
//
// Czego te testy NIE zastąpią: klik „TEST: symulacja ataku" w panelu gry po
// wgraniu nowej wersji. Testy sprawdzają logikę w pliku; symulacja sprawdza
// całą maszynerię w żywej grze (formularz floty, nawigacja, DOM forka).
const { execFileSync } = require("child_process");

const SUITES = [
  ["klasyfikacja wrogich misji", "test-klasyfikacja.js"],
  ["nadzorca obrony", "test-nadzorca.js"],
  ["kolejka ratunków (2. kolonia)", "test-kolejka.js"],
  ["ucieczka w powietrze (oba ciała pary)", "test-ucieczka.js"],
  ["cel ratunku + ślad paska (katastrofa 13:10)", "test-cel-ratunku.js"],
  ["bramki wysyłek (alarm + paliwo)", "test-bramka-wysylek.js"],
  ["ratunek nietykalny", "test-ratunek-nietykalny.js"],
  ["przerwa w ochronie (uśpiony laptop)", "test-przerwa.js"],
  ["ranking celu farmy (parser + filtr)", "test-farm-rank.js"],
  ["priorytet mining > farming", "test-farm-priorytet.js"],
];

let failed = [];
for (const [name, file] of SUITES) {
  process.stdout.write(`\n──── ${name} (${file})\n`);
  try {
    execFileSync(process.execPath, [file], { stdio: "inherit", cwd: __dirname });
  } catch {
    failed.push(name);
  }
}

// Składnia pliku bota — łapie literówkę, która w Tampermonkey objawia się
// „skrypt się nie ładuje", czyli obroną wyłączoną bez ostrzeżenia.
process.stdout.write("\n──── składnia ogamex-bot.user.js\n");
try {
  execFileSync(process.execPath, ["--check", "ogamex-bot.user.js"], { stdio: "inherit", cwd: __dirname });
  console.log("OK   | plik parsuje się poprawnie");
} catch {
  failed.push("składnia ogamex-bot.user.js");
}

console.log(failed.length === 0
  ? "\n═══ WSZYSTKO PRZESZŁO — wersję można wypchnąć. Po wgraniu: klik TEST: symulacja ataku w grze."
  : `\n═══ NIE WYPYCHAJ: ${failed.length} zestaw(ów) nie przeszło → ${failed.join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
