// Test higieny wydajnosci (v2.93.0) - zamraza dwa bezpieczniki przeciw
// muleniu przegladarki (obserwacja ownera 15.08: Firefox lagowal po kilku
// godzinach pracy bota):
//  1) zero programowych nawigacji przez `window.location.href =` - kazda
//     taka nawigacja doklada wpis do historii karty (tysiace dziennie),
//     ktora Firefox serializuje w tle; wolno tylko location.replace().
//  2) log() przycina wpisy przed zapisem do magazynu - dziennik jest
//     serializowany przy KAZDYM wpisie, wiec 10-kilobajtowe zrzuty DOM
//     w 300 wpisach mielily CPU caly dzien.
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n");

let fail = 0;
const check = (desc, ok) => {
  console.log(`${ok ? "OK  " : "BŁĄD"} | ${desc}`);
  if (!ok) fail++;
};

const hrefAssigns = (src.match(/window\.location\.href = /g) || []).length;
check(`zero nawigacji przez window.location.href= (jest: ${hrefAssigns})`, hrefAssigns === 0);
const replaces = (src.match(/window\.location\.replace\(/g) || []).length;
check(`nawigacje ida przez location.replace() (jest: ${replaces}, min 30)`, replaces >= 30);
check("log() przycina wpisy przed zapisem (600 znakow + znacznik)",
  /msgStr\.length > 600 \? msgStr\.slice\(0, 600\)/.test(src));

// v2.94.0: dalsze bezpieczniki wydajnosci
check("zapis logow z debouncem + flush na pagehide",
  /schedulePersistLogs\(\);/.test(src) && /addEventListener\("pagehide", persistLogsNow\)/.test(src));
check("updateLogUI nie przebudowuje listy przy zwinietym logu",
  /if \(logArea\.style\.display !== "none"\) logArea\.innerHTML/.test(src));
check("rozwiniecie logu odmalowuje liste (paint -> updateLogUI)",
  /if \(open\) updateLogUI\(\);/.test(src));
check("ThreatLog.all() ma cache 30 s, add() go zeruje",
  /_cacheAt < 30 \* 1000\) return this\._cache;/.test(src) && /this\._cache = null; \/\/ v2\.94\.0/.test(src));
check("FarmTargetDB.updateSystem pomija zapis bez zmian",
  /if \(JSON\.stringify\(db\) !== before\) this\.save\(db\);/.test(src));

if (fail) { console.error(`\n${fail} PORAŻKA/EK`); process.exit(1); }
console.log("\nWSZYSTKIE PRZYPADKI PRZESZŁY");
