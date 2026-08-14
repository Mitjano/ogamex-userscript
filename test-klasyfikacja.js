// Test klasyfikacji wrogich wierszy — czyta PRAWDZIWE regexy z bota.
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n") /* CRLF checkout (autocrlf) nie moze psuc markerow z \n */;

const pick = (name) => {
  const m = src.match(new RegExp(`^\\s*${name}:\\s*(/.+?/i),`, "m"));
  if (!m) throw new Error("nie znalazłem regexu " + name);
  return eval(m[1]);
};
const ATTACK = pick("ATTACK"), SPY = pick("SPY"), SAFE = pick("SAFE");

// dokładnie ta sama decyzja co w FleetMovements.fetch()
function classify(type, className = "") {
  const isSpy = SPY.test(type);
  const hostileCls = /row-hostile-mission/i.test(String(className));
  return hostileCls ? !isSpy : (ATTACK.test(type) || (!isSpy && !SAFE.test(type)));
}

const cases = [
  // [typ, klasa wiersza, oczekiwany atak?, opis]
  ["ATTACK", "row-mission-type-ATTACK row-hostile-mission", true, "klasyczny atak"],
  ["FEDERATION", "row-mission-type-FEDERATION", true, "ACS bez klasy wrogości (07.08 08:25)"],
  ["ACS", "row-mission-type-ACS", true, "ACS pod inną nazwą"],
  ["GROUP", "row-mission-type-GROUP", true, "atak grupowy"],
  ["HOLD", "row-mission-type-HOLD", true, "wrogie stacjonowanie"],
  ["ESPIONAGE", "row-mission-type-ESPIONAGE row-hostile-mission", false, "sonda (wroga, ale nie atak)"],
  ["TRANSPORT", "row-mission-type-TRANSPORT row-hostile-mission", true, "KLUCZOWE: gra mówi wrogi mimo nazwy SAFE"],
  ["TOTALLY_NEW_MISSION", "row-mission-type-TOTALLY_NEW_MISSION", true, "nieznany typ = atak (bezpieczny błąd)"],
  ["EXPEDITION", "row-mission-type-EXPEDITION", false, "własna/obca ekspedycja"],
  ["TRANSPORT", "row-mission-type-TRANSPORT", false, "zwykły transport"],
  ["RETURN", "row-mission-type-RETURN", false, "powrót"],
  ["COLLECT", "row-mission-type-COLLECT", false, "zbieranie złomu forka"],
  ["DESTRUCT", "row-mission-type-DESTRUCT", true, "niszczenie księżyca"],
  ["MISSILE", "row-mission-type-MISSILE", true, "rakiety"],
];

let bad = 0;
for (const [type, cls, want, desc] of cases) {
  const got = classify(type, cls);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "BŁĄD"} | ${want ? "ATAK" : "brak"} oczekiwany | ${type.padEnd(22)} | ${desc}`);
}
console.log(bad === 0 ? "\nWSZYSTKIE PRZYPADKI PRZESZŁY" : `\n${bad} PRZYPADKÓW NIE PRZESZŁO`);
process.exit(bad === 0 ? 0 : 1);
