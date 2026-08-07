// ─────────────────────────────────────────────────────────────────────────
//  TEST CZUJNIKA PRZERWY W OCHRONIE  (v2.80.0)
// ─────────────────────────────────────────────────────────────────────────
// Powód: 07.08 o 12:11-12:23 obrona nie wykonała ani jednego przebiegu, a
// jedyny ślad był informacyjną linijką w logu. Czujnik ma z tego zrobić
// zdarzenie — ale musi trafiać w próg, bo alarm o każdym porannym
// uruchomieniu przeglądarki nauczyłby ignorować alarmy w ogóle.
//
// Test wykonuje PRAWDZIWE ciało classify() wyjęte z pliku bota.

const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "ogamex-bot.user.js"), "utf8");

function bodyOf(name, argList) {
  const sig = `    ${name}(${argList}) {`;
  const i = src.indexOf(sig);
  if (i < 0) throw new Error(`nie znalazłem metody ${name}(${argList}) w bocie`);
  const open = i + sig.length - 1;   // klamra CIAŁA, nie listy argumentów
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

const body = bodyOf("classify", "gapMs");
// Bezpiecznik z lekcji drugiego okienka: urwane ciało przechodzi każdy test
// „nie znalazłem X" na pustce. Ciało poniżej 80 znaków = błąd parsera.
if (body.length < 80) throw new Error(`ciało classify() ma ${body.length} znaków — parser urwał funkcję`);

const raw = new Function("gapMs", body);
const MIN = 60 * 1000;
const ctx = { GAP_MS: 5 * MIN, OFF_MS: 3 * 60 * MIN };
const classify = (ms) => raw.call(ctx, ms);

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`  ✗ ${name}\n      dostałem: ${JSON.stringify(got)}\n      oczekiwane: ${JSON.stringify(want)}`); }
  else console.log(`  ✓ ${name}`);
};

console.log("\n── NORMALNA PRACA NIE ALARMUJE ──");
eq("pętla co 30 s", classify(30 * 1000).level, "ok");
eq("jeden przebieg zgubiony (1 min)", classify(60 * 1000).level, "ok");
eq("4 min — wciąż w normie", classify(4 * MIN).level, "ok");
eq("dokładnie próg 5 min = już przerwa", classify(5 * MIN).level, "gap");

console.log("\n── PRZERWA W OCHRONIE = ALARM ──");
eq("12 min (przypadek z 07.08 12:11-12:23)", classify(12 * MIN).level, "gap");
eq("12 min raportuje poprawną liczbę minut", classify(12 * MIN).mins, 12);
eq("godzina bez obrony", classify(60 * MIN).level, "gap");
eq("3 h to jeszcze awaria, nie „bota nie było”", classify(3 * 60 * MIN).level, "gap");

console.log("\n── BOT PO PROSTU WYŁĄCZONY = BEZ SYRENY ──");
// Push przy każdym porannym starcie przeglądarki byłby hałasem, który uczy
// ignorować powiadomienia — a wtedy przepadnie to jedno, które ma znaczenie.
eq("noc z zamkniętą przeglądarką (10 h)", classify(10 * 60 * MIN).level, "off");
eq("weekend (60 h)", classify(60 * 60 * MIN).level, "off");

console.log(
  fails
    ? `\nPRZERWA: ${fails} PRZYPADEK/PRZYPADKÓW NIEZDANYCH\n`
    : "\nPRZERWA: WSZYSTKIE PRZYPADKI PRZESZŁY\n"
);
process.exit(fails ? 1 : 0);
