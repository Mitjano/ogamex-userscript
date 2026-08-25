// ─────────────────────────────────────────────────────────────────────────
//  TEST TEMPA ZAMIATANIA WG POWROTÓW  (v2.101.0 — 25.08)
// ─────────────────────────────────────────────────────────────────────────
// Scenariusz ownera (zrzut 25.08 10:37): flota skoczyła na planetę, 2. fala
// wroga leci na księżyc za 9 min, a w tym czasie na księżyc wracają fale
// ekspedycji (04:24, 08:35, 08:39) i asteroid (05:33, 07:36). Sztywne 90 s
// między zamiataniami gubiło fale z ostatnich 2 min. Ten test zamraża
// CZYSTĄ funkcję MoonSave.sweepPlan: kiedy zamiatać od razu, kiedy po
// staremu, i które powroty są poza zasięgiem automatu (ostrzeżenie).

const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n");

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

const body = bodyOf("sweepPlan", "{ now, lastAt, returns, attackAt, minGap, fastGap, fastWindow, doomWindow }");
const sweepPlan = new Function("o", "const { now, lastAt, returns, attackAt, minGap, fastGap, fastWindow, doomWindow } = o;\n" + body);

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`  ✗ ${name}\n      dostałem: ${JSON.stringify(got)}\n      oczekiwane: ${JSON.stringify(want)}`); }
  else console.log(`  ✓ ${name}`);
};
const S = 1000, M = 60 * S;
const T0 = 1_000_000_000;               // „teraz" w chwili ataku wykrytego
const ATTACK = T0 + 9 * M;              // 2. fala uderza za 9 min
const RET = [T0 + 4 * M + 24 * S, T0 + 5 * M + 33 * S, T0 + 7 * M + 36 * S, T0 + 8 * M + 35 * S, T0 + 8 * M + 39 * S];

console.log("\n── A. Spokojny alarm: stary krok 90 s ──");
{
  const p = sweepPlan({ now: T0 + 60 * S, lastAt: T0, returns: RET, attackAt: ATTACK });
  eq("60 s po zamiataniu, nic nie wylądowało, wróg za 8 min → NIE zamiataj", p.due, false);
  eq("krok = 90 s", p.gap, 90000);
}
{
  const p = sweepPlan({ now: T0 + 91 * S, lastAt: T0, returns: RET, attackAt: ATTACK });
  eq("91 s po zamiataniu → zamiataj (po staremu)", p.due, true);
}

console.log("\n── B. Lądowanie od ostatniego zamiatania → szybki krok 20 s ──");
{
  const now = T0 + 4 * M + 30 * S;      // 6 s po lądowaniu ekspedycji 04:24
  const p = sweepPlan({ now, lastAt: T0 + 4 * M + 20 * S, returns: RET, attackAt: ATTACK });
  eq("fala wylądowała 6 s temu, zamiatanie 10 s temu → jeszcze nie (20 s)", p.due, false);
  eq("licznik lądowań = 1", p.landed, 1);
  const p2 = sweepPlan({ now: now + 15 * S, lastAt: T0 + 4 * M + 20 * S, returns: RET, attackAt: ATTACK });
  eq("25 s po zamiataniu z lądowaniem w międzyczasie → zamiataj", p2.due, true);
}
{
  const p = sweepPlan({ now: T0 + 5 * M + 40 * S, lastAt: T0 + 4 * M + 40 * S, returns: RET, attackAt: ATTACK });
  eq("asteroida 05:33 wylądowała 7 s temu, zamiatanie 60 s temu → zamiataj od razu", p.due, true);
}

console.log("\n── C. Wróg za < 3 min → szybki krok nawet bez lądowań ──");
{
  const now = ATTACK - 2 * M;
  const p = sweepPlan({ now, lastAt: now - 50 * S, returns: [], attackAt: ATTACK });
  eq("uderzenie za 2 min, zamiatanie 50 s temu → zamiataj (krok 45 s)", p.due, true);
  eq("flaga soon", p.soon, true);
  const p2 = sweepPlan({ now, lastAt: now - 30 * S, returns: [], attackAt: ATTACK });
  eq("…ale bez lądowania nie częściej niż co 45 s (v2.102.1)", p2.due, false);
  const p3 = sweepPlan({ now, lastAt: now - 25 * S, returns: [now - 5 * S], attackAt: ATTACK });
  eq("…a z lądowaniem już po 20 s", p3.due, true);
}
{
  const p = sweepPlan({ now: T0, lastAt: T0 - 30 * S, returns: [], attackAt: 0 });
  eq("dolot wroga nieznany → stary krok", p.gap, 90000);
}

console.log("\n── D. Fale nie do uratowania (ostrzeżenie, nie ruch) ──");
{
  const p = sweepPlan({ now: T0, lastAt: T0, returns: RET, attackAt: ATTACK });
  eq("08:35 i 08:39 (25 s i 21 s przed uderzeniem) → poza zasięgiem", p.doomed, [T0 + 8 * M + 35 * S, T0 + 8 * M + 39 * S]);
}
{
  const p = sweepPlan({ now: T0 + 8 * M + 36 * S, lastAt: T0, returns: RET, attackAt: ATTACK });
  eq("już wylądowane nie są doomed (tylko przyszłe)", p.doomed, [T0 + 8 * M + 39 * S]);
}
{
  const p = sweepPlan({ now: T0, lastAt: T0, returns: [ATTACK + 30 * S], attackAt: ATTACK });
  eq("powrót PO uderzeniu → bezpieczny, nie doomed", p.doomed, []);
}
{
  const p = sweepPlan({ now: T0, lastAt: T0, returns: RET, attackAt: 0 });
  eq("bez znanego dolotu wroga → brak ostrzeżeń", p.doomed, []);
}

console.log("\n── E. Ucieczka w powietrze: własny krok bazowy (5 min) z tym samym zegarem ──");
{
  const p = sweepPlan({ now: T0 + 4 * M, lastAt: T0, returns: [], attackAt: ATTACK + 60 * M, minGap: 5 * M });
  eq("4 min po zamiataniu, krok 5 min, nic nie wylądowało → nie", p.due, false);
  const p2 = sweepPlan({ now: T0 + 4 * M, lastAt: T0, returns: [T0 + 3 * M], attackAt: ATTACK + 60 * M, minGap: 5 * M });
  eq("…ale lądowanie w międzyczasie → tak", p2.due, true);
}

console.log(fails ? `\nZAMIATANIE: ${fails} PRZYPADKÓW PADŁO` : "\nZAMIATANIE: WSZYSTKIE PRZYPADKI PRZESZŁY");
process.exit(fails ? 1 : 0);
