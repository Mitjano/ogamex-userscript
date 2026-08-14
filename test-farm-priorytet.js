// Test priorytetu mining > farming (v2.90.0) — czyta PRAWDZIWY blok
// FARM-PRIO z bota. Decyzja ownera: asteroidy zarabiają więcej, więc farm
// może się ruszać TYLKO w martwych oknach skanera asteroid. Pomyłka w tym
// predykacie oznacza albo farm blokujący mining (utrata głównego dochodu),
// albo farm martwy na zawsze przy włączonym miningu (powrót either/or).
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n"); // CRLF checkout (autocrlf) nie moze psuc markerow z \n

const m = src.match(/\/\/ ── FARM-PRIO-START[\s\S]*?\/\/ ── FARM-PRIO-END/);
if (!m) { console.error("BŁĄD | nie znalazłem bloku FARM-PRIO w ogamex-bot.user.js"); process.exit(1); }
const { farmYieldsToMining } = new Function(`${m[0]}\nreturn { farmYieldsToMining };`)();

const NOW = 1000000000000; // stały zegar — test nie zależy od Date.now()
const MIN = 60 * 1000;
const base = { miningEnabled: true, now: NOW, fleetReturnAt: 0, dispatchFailAt: 0, scanCooldownUntil: 0 };

const cases = [
  // [nadpisania stanu, oczekiwane ustąpienie farmy, opis]
  [{ miningEnabled: false }, false, "mining OFF → farm wolny (stare zachowanie solo)"],
  [{}, true, "mining ON, zero timerów = skanuje albo zaraz ruszy → farm USTĘPUJE"],
  [{ fleetReturnAt: NOW + 5 * MIN }, false, "minery w locie (powrót za 5 min) → okno farmy"],
  [{ fleetReturnAt: NOW - 1 }, true, "timer powrotu właśnie minął → mining wraca, farm ustępuje"],
  [{ dispatchFailAt: NOW - 5 * MIN }, false, "cooldown po nieudanej wysyłce (5/10 min) → okno farmy"],
  [{ dispatchFailAt: NOW - 11 * MIN }, true, "cooldown porażki minął (11 min) → mining ma pierwszeństwo"],
  [{ scanCooldownUntil: NOW + 8 * MIN }, false, "przerwa między skanami zakresów → okno farmy"],
  [{ scanCooldownUntil: NOW - 1 }, true, "przerwa między skanami minęła → farm ustępuje"],
  [{ fleetReturnAt: NOW + 20 * MIN, scanCooldownUntil: NOW + 8 * MIN }, false, "lot + cooldown naraz → okno farmy (dowolny powód wystarcza)"],
  // Tryb parallel ZERUJE fleetReturnAt gdy dalej skanuje przy flocie w locie —
  // predykat musi wtedy trzymać farm z dala od przeglądarki.
  [{ fleetReturnAt: 0 }, true, "parallel skanuje przy flocie w locie (timer wyzerowany) → farm USTĘPUJE"],
];

let bad = 0;
for (const [patch, want, desc] of cases) {
  const got = farmYieldsToMining({ ...base, ...patch });
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "BŁĄD"} | ustępuje=${String(got).padEnd(5)} (chcę ${String(want).padEnd(5)}) | ${desc}`);
}
console.log(bad === 0 ? "\nWSZYSTKIE PRZYPADKI PRZESZŁY" : `\n${bad} PRZYPADKÓW NIE PRZESZŁO`);
process.exit(bad === 0 ? 0 : 1);
