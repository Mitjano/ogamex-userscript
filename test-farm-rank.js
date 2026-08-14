// Test parsera rankingu farmy — czyta PRAWDZIWY blok FARM-RANK z bota
// (markery FARM-RANK-START/END), nie kopię. Filtr rankingu decyduje, komu
// bot NIE wyśle floty — pomyłka w parsingu oznacza albo ataki na puste
// kolonie (strata slotów), albo pomijanie tłustych celów (strata łupu).
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n"); /* CRLF checkout (autocrlf) nie moze psuc markerow z \n */

const m = src.match(/\/\/ ── FARM-RANK-START[\s\S]*?\/\/ ── FARM-RANK-END/);
if (!m) { console.error("BŁĄD | nie znalazłem bloku FARM-RANK w ogamex-bot.user.js"); process.exit(1); }
const { farmParseRank, farmRankEligible } = new Function(`${m[0]}\nreturn { farmParseRank, farmRankEligible };`)();

const NBSP = " ";
const parseCases = [
  // [tekst wejściowy, oczekiwany ranking, opis]
  ["Ranking: 2.881", 2881, "tooltip ze screena 14.08 (kropka = tysiące)"],
  ["Royal Zion Ranking: 2.881 Write message Friend request", 2881, "pełna treść tooltipa"],
  ["2 Colony 27 MCH (i) Husaria Ranking: 2.881", 2881, "inne liczby w wierszu nie mylą parsera"],
  ["Rank: 288", 288, "wariant EN bez -ing"],
  ["RANKING : 12", 12, "wielkość liter i spacja przed dwukropkiem"],
  ["Ranking: 2,881", 2881, "przecinek jako separator tysięcy"],
  [`Ranking: 2${NBSP}881`, 2881, "twarda spacja jako separator tysięcy"],
  ["Ranking: 1 234", 1234, "zwykła spacja jako separator tysięcy"],
  ["Ranking: 2.881 3", 2881, "cyfra dalej w tekście nie dokleja się"],
  ["Deadmind (n) Nu4aN", null, "wiersz bez rankingu → null"],
  ["", null, "pusty tekst → null"],
];
const eligCases = [
  // [rank, maxRank, oczekiwane, opis]
  [2881, 800, false, "rank 2881 > limit 800 → POMIŃ (sedno update'u)"],
  [500, 800, true, "rank 500 ≤ 800 → atakuj"],
  [800, 800, true, "równy limitowi → atakuj (do 800 włącznie)"],
  [null, 800, true, "nieznany ranking → fail-open: atakuj (bot nie może oślepnąć od zmiany markupu)"],
  [2881, 0, true, "limit 0 = filtr wyłączony → stare zachowanie"],
  [1, 500, true, "top gracza nieaktywnego bierzemy zawsze"],
];

let bad = 0;
for (const [text, want, desc] of parseCases) {
  const got = farmParseRank(text);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "BŁĄD"} | parse → ${String(got).padEnd(5)} (chcę ${String(want).padEnd(5)}) | ${desc}`);
}
for (const [rank, maxRank, want, desc] of eligCases) {
  const got = farmRankEligible(rank, maxRank);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "BŁĄD"} | eligible(${String(rank).padEnd(4)}, ${String(maxRank).padEnd(3)}) → ${got} (chcę ${want}) | ${desc}`);
}
console.log(bad === 0 ? "\nWSZYSTKIE PRZYPADKI PRZESZŁY" : `\n${bad} PRZYPADKÓW NIE PRZESZŁO`);
process.exit(bad === 0 ? 0 : 1);
