// Test punktu startu farmy (v2.91.0) — zamraża na ŹRÓDLE bezpieczniki, dzięki
// którym „Start farmienia" działa jak w miningu: wpisane koordy = misja niesie
// launchAt i brama v2.84 przełącza parę/ciało; puste = stare zachowanie
// (start z aktywnego ciała, decyzja v2.74.8). Regresja tutaj nie boli od razu:
// bot dalej atakuje, tylko z ZŁEGO ciała — np. flotą główną z planety, którą
// widzi falanga. Dlatego wzorce są przybite testem, nie nadzieją.
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n");

let fail = 0;
const check = (desc, ok) => {
  console.log(`${ok ? "OK  " : "BŁĄD"} | ${desc}`);
  if (!ok) fail++;
};

// 1. Config ma pole launchFrom w inactiveFarming (panel je zapisuje).
const cfgBlock = src.match(/inactiveFarming: \{[\s\S]*?\n    \}/);
check("config inactiveFarming.launchFrom istnieje", !!cfgBlock && /launchFrom: null/.test(cfgBlock[0]));

// 2. HomeBase.farm(): wpisane koordy → forModule (sztywny start), puste → null
//    (misja bez launchAt = zachowanie v2.74.8). To odróżnia farm od mining(),
//    który przy pustym polu spada na ciało AKTYWNE.
check("HomeBase.farm() zwraca null przy pustym polu (nie ciało aktywne)",
  /farm\(\) \{ const c = CONFIG\.inactiveFarming\?\.launchFrom; return c \? this\.forModule\(c\) : null; \}/.test(src));

// 3. Wysyłka farmy dokłada launchAt TYLKO gdy koordy wpisane.
check("dispatchNext: launchAt warunkowo z HomeBase.farm()",
  /const farmBase = HomeBase\.farm\(\);[\s\S]{0,400}\.\.\.\(farmBase \? \{ launchAt: farmBase \} : \{\}\),/.test(src));

// 4. Brama v2.84 (select_ships_direct) NIE wyklucza już farmy — misja farmy
//    z launchAt przechodzi korektę pary. Stary guard z `!mission.farm` w tej
//    linii oznaczałby, że pole w panelu jest martwe.
check("brama launchAt wpuszcza farm (bez !mission.farm)",
  /if \(mission\.launchAt && !mission\.moonSave && !mission\.fleetSave && !mission\.originChecked\) \{/.test(src));

// 5. Korekta ciała trybu KSIĘŻYC obejmuje farm z launchAt (ta sama para,
//    ale aktywna PLANETA → przełącz na księżyc przed formularzem; bez tego
//    lot widzi falanga). Farm bez koordów dalej wyłączony (v2.74.8).
check("korekta baseBody=moon: (!mission.farm || mission.launchAt)",
  /CONFIG\.baseBody === "moon" && !mission\.moonSave && !mission\.fleetSave && \(!mission\.farm \|\| mission\.launchAt\) && !mission\.launchChecked/.test(src));

// 6. Panel: pole ogx-farm-from + binding zapisujący do inactiveFarming.launchFrom.
check("panel ma input ogx-farm-from", /id="ogx-farm-from"/.test(src));
check("binding ogx-farm-from → CONFIG.inactiveFarming.launchFrom",
  /bindLaunchFrom\("ogx-farm-from",\s*\(\) => CONFIG\.inactiveFarming\.launchFrom,\s*\(v\) => \{ CONFIG\.inactiveFarming\.launchFrom = v; \},/.test(src));

if (fail) { console.error(`\n${fail} PORAŻKA/EK`); process.exit(1); }
console.log("\nWSZYSTKIE PRZYPADKI PRZESZŁY");
