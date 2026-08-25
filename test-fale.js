// ─────────────────────────────────────────────────────────────────────────
//  TEST FAL I ATAKU KOMBINOWANEGO  (v2.100.0 — audyt 25.08)
// ─────────────────────────────────────────────────────────────────────────
// Scenariusz ownera: flota na księżycu, napastnik wysyła fale na księżyc,
// bot skacze na planetę, fale przechodzą, napastnik dosyła atak NA PLANETĘ
// (albo od razu na oba ciała) — a w tle wracają fale ekspedycji. Ten test
// zamraża trzy CZYSTE decyzje, od których zależy, czy flota zostanie pod
// uderzeniem:
//   A. MoonSave.swapDecision — atak w ciało z flotą → skok / oba → powietrze
//   B. AirSave.recallAtUpdate — dosłana fala przesuwa zegar zawrócenia
//   C. AirSave.landedAtOf — kiedy zawrócona flota fizycznie ląduje
//
// Jak każdy test w tym repo: wyciąga PRAWDZIWE ciało funkcji z pliku bota.

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

const swapBody = bodyOf("swapDecision", "{ attacked, fleetBody }");
const swapDecision = new Function("o", "const { attacked, fleetBody } = o;\n" + swapBody);

const RECALL = 120000;
const updBody = bodyOf("recallAtUpdate", "{ recallAt, maxEtaSec, now, sentAt, flightMs }").replace(/this\.RECALL_BUFFER_MS/g, String(RECALL));
const recallAtUpdate = new Function("o", "const { recallAt, maxEtaSec, now, sentAt, flightMs } = o;\n" + updBody);

const landedBody = bodyOf("landedAtOf", "st");
const landedAtOf = new Function("st", landedBody);

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`  ✗ ${name}\n      dostałem: ${JSON.stringify(got)}\n      oczekiwane: ${JSON.stringify(want)}`); }
  else console.log(`  ✓ ${name}`);
};

console.log("\n── A. swapDecision: atak w ciało, na którym stoi flota (D1) ──");

eq("flota na planecie (refugium), atak w planetę → MOVE (skok na księżyc)",
  swapDecision({ attacked: ["planet"], fleetBody: "planet" }), "move");
eq("flota na planecie, fale wciąż w księżyc → HOLD (po bezpiecznej stronie)",
  swapDecision({ attacked: ["moon"], fleetBody: "planet" }), "hold");
eq("flota na księżycu, atak w księżyc → MOVE",
  swapDecision({ attacked: ["moon"], fleetBody: "moon" }), "move");
eq("flota na księżycu, atak w planetę → HOLD",
  swapDecision({ attacked: ["planet"], fleetBody: "moon" }), "hold");
eq("oba ciała pod atakiem → AIR niezależnie od miejsca floty",
  swapDecision({ attacked: ["moon", "planet"], fleetBody: "planet" }), "air");
eq("oba ciała (duplikaty wierszy wielu fal) → AIR",
  swapDecision({ attacked: ["moon", "moon", "planet"], fleetBody: "moon" }), "air");
eq("nic nie leci w parę → HOLD",
  swapDecision({ attacked: [], fleetBody: "planet" }), "hold");
eq("nieznane miejsce floty (stara straż bez refugeBody) → LEGACY (stara ścieżka)",
  swapDecision({ attacked: ["planet"], fleetBody: null }), "legacy");
eq("śmieciowe ciała ignorowane",
  swapDecision({ attacked: ["asteroid", "planet"], fleetBody: "planet" }), "move");

console.log("\n── B. recallAtUpdate: dosłana fala przesuwa zawrócenie (D2) ──");

const NOW = 1_000_000_000, SENT = NOW - 5 * 60 * 1000, FLIGHT = 3 * 60 * 60 * 1000;

eq("nowa fala z dolotem 20 min → zawrócenie = teraz + 20 min + bufor",
  recallAtUpdate({ recallAt: NOW + 5 * 60 * 1000, maxEtaSec: 1200, now: NOW, sentAt: SENT, flightMs: FLIGHT }),
  { recallAt: NOW + 1200 * 1000 + RECALL, capped: false });
eq("fala krótsza niż obecny zegar → zegar się NIE cofa",
  recallAtUpdate({ recallAt: NOW + 30 * 60 * 1000, maxEtaSec: 60, now: NOW, sentAt: SENT, flightMs: FLIGHT }),
  { recallAt: NOW + 30 * 60 * 1000, capped: false });
eq("dolot ataku poza naszym lotem → zawrócenie minutę przed dolotem do refugium + capped",
  recallAtUpdate({ recallAt: NOW, maxEtaSec: 5 * 3600, now: NOW, sentAt: SENT, flightMs: FLIGHT }),
  { recallAt: SENT + FLIGHT - 60000, capped: true });
eq("brak czasu lotu (nie odczytany) → bez górnej granicy",
  recallAtUpdate({ recallAt: NOW, maxEtaSec: 5 * 3600, now: NOW, sentAt: SENT, flightMs: 0 }),
  { recallAt: NOW + 5 * 3600 * 1000 + RECALL, capped: false });

console.log("\n── C. landedAtOf: powrót trwa tyle, ile lot do zawrócenia (D3) ──");

eq("zawrócenie 40 min po starcie → lądowanie 40 min po zawróceniu",
  landedAtOf({ sentAt: NOW, recalledAt: NOW + 40 * 60 * 1000 }), NOW + 80 * 60 * 1000);
eq("zawrócenie natychmiast → minimum minuta na powrót",
  landedAtOf({ sentAt: NOW, recalledAt: NOW + 5000 }), NOW + 5000 + 60000);

console.log(fails ? `\nFALE: ${fails} PRZYPADKÓW PADŁO` : "\nFALE: WSZYSTKIE PRZYPADKI PRZESZŁY");
process.exit(fails ? 1 : 0);
