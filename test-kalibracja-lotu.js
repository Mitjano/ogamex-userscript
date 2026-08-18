// Test kalibracji czasu lotu (v2.99.0) — WYKONUJE blok FLIGHT-CAL na
// sztucznym magazynie. Regresja = na Genesis (fleet x3 vs athena x4) wzór
// atheny zaniża doloty i bramka TTL wysyła minery na asteroidy, które
// znikną przed dolotem.
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "ogamex-bot.user.js"), "utf8").replace(/\r\n/g, "\n");

let fail = 0;
const check = (desc, ok) => {
  console.log(`${ok ? "OK  " : "BŁĄD"} | ${desc}`);
  if (!ok) fail++;
};

const m = src.match(/\/\/ ── FLIGHT-CAL-START ──([\s\S]*?)\/\/ ── FLIGHT-CAL-END ──/);
check("blok FLIGHT-CAL istnieje", !!m);
if (m) {
  const mkModule = () => {
    const store = {};
    const FlightCalibration = new Function("GM_getValue", "GM_setValue", "log",
      `${m[1]}\nreturn FlightCalibration;`)(
      (k, d) => (k in store ? store[k] : d),
      (k, v) => { store[k] = v; },
      () => {});
    return { FlightCalibration, store };
  };

  // ── zapis + odczyt ──
  {
    const { FlightCalibration } = mkModule();
    check("record: poprawna próbka przyjęta", FlightCalibration.record(13, 11) === true);
    check("record: minuty ≤ 0 odrzucone", FlightCalibration.record(50, 0) === false);
    check("record: minuty > 600 odrzucone (śmieć parsera)", FlightCalibration.record(50, 700) === false);
    check("record: Δ > 499 odrzucone", FlightCalibration.record(600, 20) === false);
    check("record: Δ ujemne odrzucone", FlightCalibration.record(-5, 20) === false);
    check("load: 1 próbka w magazynie", FlightCalibration.load().samples.length === 1);
  }

  // ── fit: za mało danych / za mały rozrzut = null (fallback na wzór atheny) ──
  {
    const { FlightCalibration } = mkModule();
    check("fit: 0 próbek → null", FlightCalibration.fit() === null);
    FlightCalibration.record(13, 11);
    check("fit: 1 próbka → null", FlightCalibration.fit() === null);
    FlightCalibration.record(20, 12); // rozrzut 7 < 20
    check("fit: rozrzut Δ < 20 → null (nachylenie byłoby szumem)", FlightCalibration.fit() === null);
    check("estimate: bez fitu → null", FlightCalibration.estimate(100) === null);
  }

  // ── fit odtwarza kalibrację atheny z jej własnych dwóch punktów ──
  // (Δ13 → 11 min, Δ217 → 24 min; nachylenie (24-11)/204 ≈ 0.0637)
  {
    const { FlightCalibration } = mkModule();
    FlightCalibration.record(13, 11);
    FlightCalibration.record(217, 24);
    const f = FlightCalibration.fit();
    check("fit: athena — nachylenie ≈ 0.064", f && Math.abs(f.b - 13 / 204) < 0.001);
    check("fit: athena — wyraz wolny ≈ 10.2", f && Math.abs(f.a - (11 - (13 / 204) * 13)) < 0.05);
    // estimate = ceil(a + b·Δ) + 2 marginesu
    const raw100 = f.a + f.b * 100;
    check("estimate(100) = ceil + 2 min marginesu", FlightCalibration.estimate(100) === Math.ceil(raw100) + 2);
  }

  // ── scenariusz Genesis: loty 4/3 dłuższe niż athena ──
  {
    const { FlightCalibration } = mkModule();
    FlightCalibration.record(13, 11 * 4 / 3);
    FlightCalibration.record(217, 24 * 4 / 3);
    const est = FlightCalibration.estimate(217);
    // wzór atheny dałby max(11, ceil(11+217/15)) = 26 min — ZA MAŁO na x3 (realnie 32)
    check("Genesis: estimate(217) ≥ 32 (wzór atheny dawał 26 — despawn przed dolotem)", est >= 32);
    const athena217 = Math.max(11, Math.ceil(11 + 217 / 15));
    check("Genesis: nauczone > wzór atheny (kierunek poprawki właściwy)", est > athena217);
  }

  // ── cap próbek + odporność na zepsuty magazyn ──
  {
    const { FlightCalibration, store } = mkModule();
    for (let i = 0; i < 40; i++) FlightCalibration.record(10 + i * 5, 11 + i);
    check("cap: magazyn trzyma najwyżej MAX_SAMPLES (30) najnowszych", FlightCalibration.load().samples.length === 30);
    store[FlightCalibration.KEY] = "{zepsuty json";
    check("load: zepsuty JSON → pusta lista, bez wyjątku", FlightCalibration.load().samples.length === 0);
  }

  // ── ujemne nachylenie (szum: bliska próbka wolniejsza) nie psuje estymaty ──
  {
    const { FlightCalibration } = mkModule();
    FlightCalibration.record(13, 30);
    FlightCalibration.record(217, 12);
    const f = FlightCalibration.fit();
    check("fit: ujemne nachylenie przycięte do 0 (dalej ≠ szybciej)", !f || f.b === 0);
    const e1 = FlightCalibration.estimate(10), e2 = FlightCalibration.estimate(400);
    check("estimate: przy b=0 stały czas niezależny od Δ", e1 === null ? e2 === null : e1 === e2);
  }
}

// ── zamrożenia na źródle (integracja, nie tylko moduł) ──
check("estimateFlightMinutes pyta najpierw FlightCalibration.estimate",
  /estimateFlightMinutes\(systemDistance\)\s*{\s*[^}]*FlightCalibration\.estimate\(systemDistance\)/.test(src));
check("fallback atheny zostaje (max(11, ceil(11 + Δ/15)))",
  src.includes("Math.max(11, Math.ceil(11 + systemDistance / 15))"));
check("hak nauki tylko dla asteroid_mining_direct",
  /capturedFlightMs > 0 && mission\.type === "asteroid_mining_direct"/.test(src));
check("hak nauki: start z launchAt misji z fallbackiem HomeBase.mining()",
  /mission\.launchAt \|\| HomeBase\.mining\(\)/.test(src));
check("hak nauki: ta sama galaktyka wymagana (Δ systemów bez sensu między galaktykami)",
  /parseInt\(calUrl\[1\]\) === calFrom\.galaxy/.test(src));
check("magazyn kalibracji ma własny klucz per-host", src.includes('KEY: "ogamex_flight_cal"'));

console.log(fail === 0 ? "\nWSZYSTKIE TESTY KALIBRACJI LOTU OK" : `\n${fail} TESTÓW PADŁO`);
process.exit(fail === 0 ? 0 : 1);
