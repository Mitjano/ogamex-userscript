// Jedno wejście do testów 3.0 — do odpalenia PRZED każdym pushem ogamex-3.user.js.
//   node test3-all.js
// UWAGA: pipe zjada kod wyjścia — sprawdzaj `echo $?` bez pipe'a (lekcja 27.08:
// v2.108.0 poszła na produkcję z czerwonym testem, bo `| tail -1` zjadł status).
const { execFileSync } = require("child_process");

const SUITES = [
  ["decyzje obrony (macierz incydentów)", "test3-decide.js"],
  ["E2E: prawdziwy bot na sztucznej grze (jsdom)", "test3-e2e.js"],
  ["panel: budowa, pasek stanu, zwijanie (jsdom)", "test3-ui.js"],
];
let failed = [];
for (const [name, file] of SUITES) {
  process.stdout.write(`\n──── ${name} (${file})\n`);
  try { execFileSync(process.execPath, [file], { stdio: "inherit", cwd: __dirname }); }
  catch { failed.push(name); }
}
process.stdout.write("\n──── składnia ogamex-3.user.js\n");
try { execFileSync(process.execPath, ["--check", "ogamex-3.user.js"], { stdio: "inherit", cwd: __dirname }); console.log("OK   | plik parsuje się poprawnie"); }
catch { failed.push("składnia ogamex-3.user.js"); }

console.log(failed.length === 0
  ? "\n═══ 3.0: WSZYSTKO PRZESZŁO — można wypchnąć. Po wgraniu: TEST w panelu na żywo."
  : `\n═══ NIE WYPYCHAJ: ${failed.length} zestaw(ów) nie przeszło → ${failed.join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
