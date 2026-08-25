// ─────────────────────────────────────────────────────────────────────────
//  TEST ODKRYWCA: 40-MINUTOWE EKSPEDYCJE  (v2.103.0)
// ─────────────────────────────────────────────────────────────────────────
// Powód: owner chce zmienić klasę na Odkrywcę (ekspedycje 40 min, +30% łupu).
// Stary wybór „Expedition duration" łapał tylko opcje „N Hours" — opcję
// „40 Minutes" pominąłby i wysyłał na 1 h, gubiąc cały zysk z klasy.
// Wykonuje PRAWDZIWE ciało pickExpeditionDuration() wyjęte z pliku bota.
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n");
const a = src.indexOf("  function pickExpeditionDuration("), b = src.indexOf("  // ── /EXPO-DURATION");
if (a < 0 || b < 0) throw new Error("brak bloku EXPO-DURATION");
const pick = new Function(src.slice(a, b) + "\nreturn pickExpeditionDuration;")();

let failures = 0;
const check = (n, c) => { console.log(`${c ? "OK  " : "FAIL"} | ${n}`); if (!c) failures++; };
const opt = (t, v) => ({ textContent: t, value: v });

const hoursOnly = [opt("1 Hours", "1"), opt("2 Hours", "2"), opt("3 Hours", "3")];
const withMin = [opt("40 Minutes", "0"), ...hoursOnly];
const withFrac = [opt("0.67 Hours", "0.67"), ...hoursOnly];
const withValue = [opt(" 40 min ", "40"), ...hoursOnly];

let r = pick(withMin, { hours: "1", minutes: 40 });
check("Odkrywca: wybiera „40 Minutes”", r.minutesHit && r.option.textContent === "40 Minutes");
r = pick(withFrac, { hours: "1", minutes: 40 });
check("Odkrywca: rozpoznaje „0.67 Hours”", r.minutesHit && r.option.value === "0.67");
r = pick(withValue, { hours: "2", minutes: 40 });
check("Odkrywca: „ 40 min ” z odstępami", r.minutesHit && r.option.value === "40");
r = pick(hoursOnly, { hours: "2", minutes: 40 });
check("inna klasa: brak 40 min → minutesHit=false, fallback 2 h", !r.minutesHit && r.option.textContent === "2 Hours");
r = pick(withMin, { hours: "1", minutes: 0 });
check("toggle OFF: „40 Minutes” NIE maskuje „1 Hours”", !r.minutesHit && r.option.textContent === "1 Hours");
r = pick(withMin, { hours: "3", minutes: 0 });
check("toggle OFF: 3 h", r.option.textContent === "3 Hours");
r = pick(hoursOnly, { hours: "9", minutes: 0 });
check("brak żądanej godziny → null (stara ścieżka: warn + default strony)", r.option === null);
check("mini-btn w panelu + bind toggle", src.includes('id="ogx-expo-disc40"') && src.includes("CONFIG.expeditions.discoverer40 = !CONFIG.expeditions.discoverer40"));
check("pending_mission niesie holdingMinutes", /holdingMinutes: cfg\.discoverer40 \? 40 : 0/.test(src));
check("krok 3 formularza rozpoznaje opcje w minutach", src.includes("(hour|hours|h|godz|min)"));

console.log(failures ? `\n${failures} FAIL` : "\nWSZYSTKO OK");
process.exit(failures ? 1 : 0);
