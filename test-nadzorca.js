// Test nadzorcy obrony — wyciąga PRAWDZIWĄ funkcję verdict() z bota
// i sprawdza ją na scenariuszach, bez czekania na atak.
const fs = require("fs");
const src = fs.readFileSync("C:/Users/micha/ogamex-userscript/ogamex-bot.user.js", "utf8");

// wytnij ciało verdict(s) { ... } licząc klamry
const start = src.indexOf("    verdict(s) {");
if (start < 0) throw new Error("nie znalazłem verdict() — nadzorca zniknął z bota?");
let i = src.indexOf("{", start), depth = 0, end = -1;
for (let j = i; j < src.length; j++) {
  if (src[j] === "{") depth++;
  else if (src[j] === "}") { depth--; if (depth === 0) { end = j; break; } }
}
const body = src.slice(i + 1, end);
const verdict = new Function("s", body);

const GRACE = 90000;
const base = { expected: true, armed: false, saves: 0, pendingRescue: false,
               decisionAgeMs: null, aliveMs: 0, graceMs: GRACE };

const cases = [
  ["obrona wyłączona / brak alarmu", { ...base, expected: false }, "off"],
  ["alarm świeży, jeszcze liczymy na reakcję", { ...base, aliveMs: 30000 }, "waiting"],
  ["flota ewakuowana", { ...base, aliveMs: 300000, armed: true, saves: 1 }, "ok"],
  ["ratunek w toku (misja w formularzu)", { ...base, aliveMs: 300000, pendingRescue: true }, "ok"],
  ["jawna decyzja: flota po bezpiecznej stronie", { ...base, aliveMs: 300000, decisionAgeMs: 20000 }, "ok"],
  ["decyzja PRZETERMINOWANA (sprzed 5 min)", { ...base, aliveMs: 300000, decisionAgeMs: 300000 }, "STUCK"],
  ["straż uzbrojona, ale ZERO zapisów", { ...base, aliveMs: 300000, armed: true, saves: 0 }, "STUCK"],
  ["ALARM TRWA, cisza — sytuacja z 03.08 i 07.08", { ...base, aliveMs: 300000 }, "STUCK"],
  ["granica: dokładnie w oknie łaski", { ...base, aliveMs: GRACE - 1 }, "waiting"],
  ["granica: tuż po oknie łaski", { ...base, aliveMs: GRACE + 1 }, "STUCK"],
];

let bad = 0;
for (const [desc, state, want] of cases) {
  const got = verdict(state).state;
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "BŁĄD"} | oczekiwano ${want.padEnd(7)} | dostano ${String(got).padEnd(7)} | ${desc}`);
}
console.log(bad === 0 ? "\nNADZORCA: WSZYSTKIE PRZYPADKI PRZESZŁY" : `\nNADZORCA: ${bad} PRZYPADKÓW NIE PRZESZŁO`);
process.exit(bad === 0 ? 0 : 1);
