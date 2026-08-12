// Test bramek wysyłek (v2.79.0) — wyciąga PRAWDZIWE funkcje z bota:
//   DefenceHold.reason()  — czy w oknie obrony wolno cokolwiek wysyłać
//   Fuel.allows()         — czy fala nie zjada rezerwy paliwa na ewakuację
// Powód: 07.08 w trakcie/tuż po alarmie bot dalej próbował wysyłać ekspedycje
// i minery, a na ciele zostawała sama rezerwa deuteru.
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8");

function cutBody(marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`nie znalazłem ${marker.trim()} — bramka zniknęła z bota?`);
  const i = src.indexOf("{", start);
  let depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) { end = j; break; } }
  }
  return src.slice(i + 1, end);
}

// ── DefenceHold.reason() ──
const reasonBody = cutBody("    reason() {");
const SETTLE_MS = 140 * 1000;

function reasonWith({ alarm, armed, defenceAt }) {
  const fn = new Function(
    "ThreatMonitor", "MoonSave", "GM_getValue", "KEY_DEFENCE_AT", "self",
    `return (function(){ const that = self; ${reasonBody.replace(/this\./g, "that.")} }).call(self)`,
  );
  return fn(
    { active: () => alarm },
    { watch: () => ({ armed }) },
    () => String(defenceAt || 0),
    "k",
    { SETTLE_MS },
  );
}

const now = Date.now();
const holdCases = [
  ["alarm trwa → stop", { alarm: true, armed: false, defenceAt: 0 }, true],
  ["straż uzbrojona (alarm zdjęty) → stop", { alarm: false, armed: true, defenceAt: 0 }, true],
  ["ratunek w locie 10 s temu → stop", { alarm: false, armed: false, defenceAt: now - 10_000 }, true],
  ["ratunek wylądował (200 s temu) → wolno", { alarm: false, armed: false, defenceAt: now - 200_000 }, false],
  ["spokój, nic się nie działo → wolno", { alarm: false, armed: false, defenceAt: 0 }, false],
  // Dokładnie ta luka, która puściła ekspedycję o 11:21:50 (66 s po zdjęciu alarmu).
  ["66 s po zdjęciu alarmu, powrót w powietrzu → stop", { alarm: false, armed: false, defenceAt: now - 66_000 }, true],
];

let bad = 0;
for (const [desc, state, wantHold] of holdCases) {
  const why = reasonWith(state);
  const held = why != null;
  const ok = held === wantHold;
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "BŁĄD"} | ${wantHold ? "stop  " : "wolno "} | ${String(why ?? "—").slice(0, 46).padEnd(46)} | ${desc}`);
}

// ── Fuel.allows() ── (przez read()/reserve() podstawione stanem ciała)
const fuelBody = cutBody("    allows(who) {\n      const reserve = this.reserve();");
function fuelAllows({ have, reserve }) {
  const that = {
    reserve: () => reserve,
    read: () => have,
    _said: { fuel_test: Date.now() }, // log wyciszony w teście
  };
  const fn = new Function("log", "who", "that", fuelBody.replace(/this\./g, "that."));
  return fn(() => {}, "test", that);
}

const fuelCases = [
  ["paliwa dużo ponad rezerwę → wolno", { have: 20_000_000_000_000, reserve: 100_000_000_000 }, true],
  ["na ciele DOKŁADNIE rezerwa (stan po ratunku 07.08) → stop", { have: 100_000_000_000, reserve: 100_000_000_000 }, false],
  ["poniżej rezerwy → stop", { have: 5_000_000_000, reserve: 100_000_000_000 }, false],
  ["rezerwa wyłączona (0) → wolno", { have: 0, reserve: 0 }, true],
  ["nie da się odczytać paska surowców → nie blokuj", { have: null, reserve: 100_000_000_000 }, true],
];

for (const [desc, state, wantAllow] of fuelCases) {
  const got = fuelAllows(state);
  const ok = got === wantAllow;
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "BŁĄD"} | ${wantAllow ? "wolno " : "stop  " } | ${String(got).padEnd(46)} | ${desc}`);
}

console.log(bad === 0 ? "\nBRAMKI WYSYŁEK: WSZYSTKIE PRZYPADKI PRZESZŁY" : `\nBRAMKI WYSYŁEK: ${bad} PRZYPADKÓW NIE PRZESZŁO`);
process.exit(bad === 0 ? 0 : 1);
