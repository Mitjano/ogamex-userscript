// ─────────────────────────────────────────────────────────────────────────
//  TEST UCIECZKI W POWIETRZE  (v2.85.0)
// ─────────────────────────────────────────────────────────────────────────
// Jedyny scenariusz utraty floty przed 2.85.0: atak na OBA ciała jednej
// pary naraz — ewakuacja w obrębie pary przenosiła flotę pod drugie
// uderzenie. Ten test zamraża DECYZJĘ (kiedy lecieć w powietrze, kiedy
// zostać przy starym ratunku) i arytmetykę zawrócenia.
//
// Jak każdy test w tym repo: wyciąga PRAWDZIWE ciało funkcji z pliku bota
// i wykonuje je. Test na przepisanej kopii logiki jest wart tyle, co brak
// testu.

const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n") /* CRLF checkout (autocrlf) nie moze psuc markerow z \n */;

// ── wyciągnij ciało metody po nazwie (liczenie klamer od KOŃCA sygnatury —
//    lekcja z test-kolejka: przy `({ a, b })` pierwsza klamra to argumenty) ──
function bodyOf(name, argList) {
  const sig = `    ${name}(${argList}) {`;
  const i = src.indexOf(sig);
  if (i < 0) throw new Error(`nie znalazłem metody ${name}(${argList}) w bocie`);
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

const decideBody = bodyOf("decide", "{ enabled, bodies, activePhase, failedAt, now, landed }");
if (decideBody.length < 100) throw new Error("ciało decide() podejrzanie krótkie — ekstrakcja się rozjechała");
const decide = new Function("o", "const { enabled, bodies, activePhase, failedAt, now, landed } = o;\n" + decideBody);

const recallBody = bodyOf("recallAtFor", "maxEtaSec, now");
const recallAtFor = new Function("maxEtaSec", "now", "const this_RECALL = 120000;\n" + recallBody.replace(/this\.RECALL_BUFFER_MS/g, "this_RECALL"));

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`  ✗ ${name}\n      dostałem: ${JSON.stringify(got)}\n      oczekiwane: ${JSON.stringify(want)}`); }
  else console.log(`  ✓ ${name}`);
};

const NOW = 1_000_000_000;

console.log("\n── A. STARE ZACHOWANIE NIETKNIĘTE (zwykłe ataki = swap) ──");

eq("atak tylko w księżyc → zwykły ratunek",
  decide({ enabled: true, bodies: ["moon"], activePhase: null, failedAt: 0, now: NOW }), "swap");

eq("atak tylko w planetę → zwykły ratunek",
  decide({ enabled: true, bodies: ["planet"], activePhase: null, failedAt: 0, now: NOW }), "swap");

eq("brak rozpoznanych ciał (stare wiersze bez ikon) → zwykły ratunek",
  decide({ enabled: true, bodies: [], activePhase: null, failedAt: 0, now: NOW }), "swap");

eq("funkcja wyłączona w panelu → zwykły ratunek nawet przy obu ciałach",
  decide({ enabled: false, bodies: ["moon", "planet"], activePhase: null, failedAt: 0, now: NOW }), "swap");

console.log("\n── B. OBA CIAŁA PARY POD ATAKIEM → POWIETRZE ──");

eq("księżyc + planeta naraz → ucieczka w powietrze",
  decide({ enabled: true, bodies: ["moon", "planet"], activePhase: null, failedAt: 0, now: NOW }), "air");

eq("kolejność ciał bez znaczenia",
  decide({ enabled: true, bodies: ["planet", "moon"], activePhase: null, failedAt: 0, now: NOW }), "air");

console.log("\n── C. BEZPIECZNIKI: nie dubluj, nie pętl porażki ──");

eq("ucieczka już w locie → nie wysyłaj drugiej (i nie rób swapa)",
  decide({ enabled: true, bodies: ["moon", "planet"], activePhase: "launched", failedAt: 0, now: NOW }), "active");

eq("wysyłka w przygotowaniu → jak wyżej",
  decide({ enabled: true, bodies: ["moon", "planet"], activePhase: "arming", failedAt: 0, now: NOW }), "active");

eq("flota zawrócona, JESZCZE W LOCIE do domu → jak wyżej",
  decide({ enabled: true, bodies: ["moon", "planet"], activePhase: "recalled", failedAt: 0, now: NOW, landed: false }), "active");

// v2.100.0 (audyt 25.08, D3): po LĄDOWANIU faza `recalled` nie blokuje
// obrony — atak dosłany na świeżo wylądowaną flotę musi wywołać reakcję.
eq("flota zawrócona i WYLĄDOWAŁA, oba ciała pod atakiem → znowu w powietrze",
  decide({ enabled: true, bodies: ["moon", "planet"], activePhase: "recalled", failedAt: 0, now: NOW, landed: true }), "air");

eq("flota wylądowała, atak w jedno ciało → zwykły skok w parze",
  decide({ enabled: true, bodies: ["moon"], activePhase: "recalled", failedAt: 0, now: NOW, landed: true }), "swap");

eq("porażka 5 min temu → swap (nie pętlimy nieudanego startu)",
  decide({ enabled: true, bodies: ["moon", "planet"], activePhase: null, failedAt: NOW - 5 * 60 * 1000, now: NOW }), "swap");

eq("porażka 11 min temu → wolno próbować znowu",
  decide({ enabled: true, bodies: ["moon", "planet"], activePhase: null, failedAt: NOW - 11 * 60 * 1000, now: NOW }), "air");

console.log("\n── D. ARYTMETYKA ZAWRÓCENIA (ostatni dolot + 2 min bufora) ──");

eq("dolot 300 s → zawrócenie po 300 s + 120 s",
  recallAtFor(300, NOW), NOW + 300 * 1000 + 120000);

eq("dolot nieznany (0) → zawrócenie po samym buforze",
  recallAtFor(0, NOW), NOW + 120000);

eq("ujemny/śmieciowy dolot nie cofa zegara",
  recallAtFor(-50, NOW), NOW + 120000);

console.log(fails ? `\nUCIECZKA: ${fails} PRZYPADKÓW PADŁO` : "\nUCIECZKA: WSZYSTKIE PRZYPADKI PRZESZŁY");
process.exit(fails ? 1 : 0);

console.log("\n── F. v2.104.7: PARA BEZ KSIĘŻYCA (Destroy 26.08 18:26) ──");
eq("bez księżyca: atak w planetę → w powietrze (nie ma dokąd skakać)",
  decide({ enabled: true, bodies: ["planet"], activePhase: null, failedAt: 0, now: NOW, noMoon: true }), "air");
eq("bez księżyca: brak rozpoznanych ciał → zwykły ratunek (nic nie wiemy)",
  decide({ enabled: true, bodies: [], activePhase: null, failedAt: 0, now: NOW, noMoon: true }), "swap");
eq("bez księżyca, ale ucieczka nieudana <10 min → swap (bez pętli)",
  decide({ enabled: true, bodies: ["planet"], activePhase: null, failedAt: NOW - 60000, now: NOW, noMoon: true }), "swap");
eq("z księżycem: atak w planetę → nadal swap (stare zachowanie)",
  decide({ enabled: true, bodies: ["planet"], activePhase: null, failedAt: 0, now: NOW, noMoon: false }), "swap");
