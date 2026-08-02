// ==UserScript==
// @name         OGameX Assistant
// @namespace    https://github.com/Mitjano/Bybit_bot/ogamex-bot
// @version      2.57.0
// @description  Asteroid Mining automation for OGameX (multi-universe, fresh-scan on every cycle, TTL-aware dispatch with 5min safety margin; v2.10.0 adds right-sized fleets + parallel dispatch: send only the miners needed to carry the asteroid's resources and keep the rest mining other asteroids in parallel, with auto-learned cargo/yield; v2.13.0 auto-claims the green "Online bonus" menu button for antimatter + Academy points)
// @author       MCH
// @match        https://*.ogamex.net/*
// @updateURL    https://raw.githubusercontent.com/Mitjano/ogamex-userscript/main/ogamex-bot.user.js
// @downloadURL  https://raw.githubusercontent.com/Mitjano/ogamex-userscript/main/ogamex-bot.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════
  //  PER-UNIVERSE STORAGE ISOLATION  (v2.9.0, 2026-05-21)
  // ═══════════════════════════════════════════════════════════════
  // Bot used to be hardcoded to nexus.ogamex.net. Switched to wildcard
  // @match so it runs on athena/nexus/any future universe. But each
  // universe is a SEPARATE account with different planet coords —
  // sharing config + scan-state + dispatched-asteroids between universes
  // would have the bot trying to mine planets that don't exist on the
  // current host. Prefix every GM key with location.host so each
  // universe gets isolated storage; legacy keys (no prefix) fall back
  // for existing nexus users so they don't lose their config.
  //
  // We override window.GM_setValue / window.GM_getValue (property
  // assignment is fine in strict mode — it's globals reassignment that
  // would throw). The rest of the bot keeps calling GM_setValue /
  // GM_getValue unchanged; those identifiers resolve to the window
  // properties we just rewrote.
  const HOST = location.host;
  const _gmSetReal = window.GM_setValue;
  const _gmGetReal = window.GM_getValue;
  window.GM_setValue = function (key, value) {
    return _gmSetReal(`${HOST}:${key}`, value);
  };
  window.GM_getValue = function (key, defaultValue) {
    const v = _gmGetReal(`${HOST}:${key}`, undefined);
    if (v !== undefined) return v;
    // Migration fallback: existing nexus users keep their old un-prefixed
    // data (read-only); next write lands under the host-prefixed key.
    if (HOST === 'nexus.ogamex.net') {
      return _gmGetReal(key, defaultValue);
    }
    return defaultValue;
  };

  // ═══════════════════════════════════════════════════════════════
  //  CONFIGURATION (persistent via GM_setValue/GM_getValue, per-host)
  // ═══════════════════════════════════════════════════════════════

  const DEFAULT_CONFIG = {
    enabled: false,
    asteroidMining: {
      enabled: false,
      minersPerMission: 0, // 0 = send all available. Used as fallback ONLY when
                           // right-sizing has no data yet (no cargo + no yield estimate).
      // ── v2.10.0: right-sizing + parallel dispatch ──
      // The game caps how much one mission collects at the asteroid miner
      // fleet's TOTAL cargo capacity, and an asteroid holds resources roughly
      // proportional to your hourly production (≈ constant within a day). So
      // sending 100% of miners every time wastes ships that just ride along
      // empty. Right-sizing sends only ceil(expectedResources / cargoPerMiner
      // × bufferFactor) miners, leaving the rest at home to fly PARALLEL
      // missions to the other asteroids the game spawns (3–6/h).
      parallelDispatch: true,       // keep mining with leftover miners instead of waiting for the full fleet to return
      maxConcurrentMiningFleets: 0, // hard cap on simultaneous mining fleets; 0 = limited only by the game's fleet slots
      // User model (v2.10.4): "miners per flight" + "total miners to use" →
      // the bot launches floor(total / perFlight) flights in parallel, then
      // waits for returns. e.g. total 100000, perFlight 50000 → 2 flights.
      // totalMinersToUse 0 = no budget cap (limited only by fleet slots).
      // minersPerMission (per flight) 0 = send ALL available in a single wave.
      totalMinersToUse: 0,          // budget of miners to commit across simultaneous flights; 0 = unlimited
      minMinersPerMission: 1,       // never send fewer than this (also the floor for "miners left home" to bother going parallel)
      // v2.22.0: a parallel flight must carry at least this fraction of the
      // intended per-flight size, or the leftover miners wait for a full one.
      // A mission's haul is capped by the fleet's total cargo, so half a fleet
      // doesn't collect half an asteroid — it collects half a cap and abandons
      // the rest. 0 = off (fly any remainder, pre-2.22 behaviour).
      partialFlightMinRatio: 0.5,
      cargoPerMiner: 0,             // cargo capacity of ONE asteroid miner; 0 = auto-learn from the fleet confirmation page
      expectedResourcesPerAsteroid: 0, // expected resources per asteroid; 0 = auto-learn from mission reports (set manually to seed before learning)
      bufferFactor: 1.15,           // over-provision factor vs the estimate (covers above-average asteroids)
      yieldSampleSize: 20,          // rolling window of "resources found" reports used for the estimate
      estimatePercentile: 85,       // size the fleet against this percentile of samples (not the mean) so big asteroids aren't under-served
      learnFromReports: true,       // parse asteroid mining reports to learn expectedResources (see AsteroidYieldTracker)
      scanIntervalMin: 15, // minutes between range re-scans when a sweep found nothing NEW. (v2.10.12: was 45 — OGameX refreshes asteroid hints far sooner, so a full set of fresh ranges sat ignored for up to 45min. The immediate-rescan-on-new-ranges path handles the common case; this is just the genuinely-nothing-new fallback.)
      maxFlightMinutes: 45, // safety cap on one-way flight time; ranges beyond this are skipped. Formula max(11, ceil(11+Δ/15)) hits 45min at Δ=499 (max same-galaxy distance), so 45 ensures every range the game reports gets scanned. Lower values silently drop far ranges and the bot keeps spinning on a few empty close ones.
      // Ship types to use for asteroid mining, tried in order.
      // OGameX requires ASTEROID_MINER — only this ship type is allowed for asteroid missions.
      minerShipTypes: ["ASTEROID_MINER"],
      // Base planet from which miners ALWAYS launch. Set to null to fall back
      // to min-over-all-planets behavior. Per-host storage means each universe
      // remembers its own base independently (set via UI or saved config).
      minerBase: { galaxy: 3, system: 269, position: 8 },
    },
    // ── v2.15.0: incoming-attack alarm ──
    // ── v2.57.0: Fleet Save (FS) ──
    // Najbezpieczniejszy FS: wysyłka Z KSIĘŻYCA na inny księżyc misją Stacjonuj
    // i ZAWRÓCENIE w locie. Zawrócona flota wraca tyle czasu, ile leciała, więc
    //     powrót = start + 2 × opóźnienie zawrócenia
    // Właściciel podaje godzinę powrotu; bot wylicza, kiedy wystartować i kiedy
    // zawrócić. Minery zostają w domu — one pracują.
    fleetSave: {
      enabled: false,
      from: { galaxy: 3, system: 269, position: 8 },  // bazowy księżyc
      to: { galaxy: 3, system: 269, position: 5 },    // cel (też księżyc)
      returnAt: null,          // ISO, godzina powrotu ustawiona przez właściciela
      speedPercent: 10,        // wolniej = dłuższy lot = dłuższy możliwy FS
      excludeTypes: ["ASTEROID_MINER"],
    },
    threatAlarm: {
      enabled: true,
      // ── v2.21.0: act on the alarm, don't just shout about it ──
      // The old objection to arming this was that the mission bar can't tell an
      // attack from an espionage probe, so every probe would launch the whole
      // economy at the moon. That objection was half an argument: it priced the
      // false positive as permanent, when the fleet only has to sit out the
      // alert. With autoReturn the cost of a wrong guess is one alert window of
      // downtime (alert clears 10min after the last sighting) plus fuel for a
      // same-coords hop — against losing everything for being asleep. Cheap
      // insurance, so it defaults ON.
      autoSave: true,
      autoReturn: true,
    },
    // ── v2.14.0: expeditions in WAVES ──
    // Position 16 of the base system, combat fleet split into N waves sent a
    // couple of minutes apart. The spacing is a safety feature, not politeness:
    // one fleet returning at a time means a hunter camping the return can take
    // at most one wave, and there's a window to react.
    expeditions: {
      enabled: false,
      waves: 8,                 // split the fleet into this many flights
      holdingHours: 1,          // "Expedition duration" on the send page
      // Spacing between waves, randomised in this range. v2.15.1: owner
      // confirmed ~60s is enough separation in practice, so the whole fleet
      // goes out in ~8 minutes and mining gets the rest of the hour.
      waveGapMinSec: 60,
      waveGapMaxSec: 90,
      slotReserve: 2,           // fleet slots to leave free for mining/manual play
      // v2.37.0: 0 = Heavy Cargo dzieli się jak każdy inny statek (flota ÷ fale).
      // Wartość > 0 to świadome nadpisanie stałą liczbą na falę — sens ma tylko
      // wtedy, gdy HC jest równolegle potrzebne do farmienia.
      heavyCargoPerWave: 0,
      // Never send these on an expedition. Miners are the mining module's;
      // colony ships are one-shot and irreplaceable.
      // v2.46.0: Gwiazda Śmierci NIE lata na ekspedycje. Fala leci z prędkością
      // najwolniejszej jednostki, a GS to 26 minut w jedną stronę zamiast kilku
      // — jedna sztuka zamraża całą falę na prawie godzinę i zjada slot
      // ekspedycyjny, którego brakuje reszcie floty.
      excludeTypes: ["ASTEROID_MINER", "COLONY_SHIP", "DEATH_STAR"],
      // v2.48.0: ekspedycja potrafi trafić na obcych i zostawić pole złomu na
      // pozycji 16 systemu bazy. To nasze własne surowce — zbieramy recyklerami.
      collectDebris: true,
      // Base = where the combat fleet sits; target is position 16 of ITS system.
      // null → falls back to the asteroid-mining base.
      base: null,
    },
    // ── v2.11.0: Inactive-player farming (event: reward per fleet sent) ──
    // Scans user-given system ranges, attacks EVERY (i)/(I) inactive planet
    // with Heavy Cargo (mission=8, direct fleet URL — same 3-step flow as
    // asteroids). Mutually exclusive with asteroidMining (mining wins).
    inactiveFarming: {
      enabled: false,
      hcPerFlight: 100,          // Heavy Cargo per attack (manual, like miners per flight)
      ranges: "",                // e.g. "3:100-200, 3:250-300" — scanned system by system
      targetCooldownMin: 180,    // don't re-attack the same planet within this window
      slotReserve: 2,            // keep this many fleet slots free (manual play / mining)
    },
    // ── v2.13.0: auto-claim the green "Online bonus" menu button ──
    // (antimatter + Academy points). Independent of mining/farming — runs
    // whenever the bot is enabled and the button shows up.
    onlineBonus: {
      enabled: true,
      minGapMin: 2,   // floor between two claims (the bonus reappears on its own schedule)
      retryMin: 15,   // wait after a click that did NOT make the button disappear
    },
    // ── v2.12.0: humanizer — behavioural anti-detection ──
    humanizer: {
      breaks: true,              // random "coffee breaks": full-bot pause
      breakEveryMin: 35,         // after 35-65 min of activity…
      breakEveryMax: 65,
      breakLenMin: 5,            // …pause everything for 5-15 min
      breakLenMax: 15,
      maxAttacksPerDay: 0,       // farming: hard daily cap (0 = unlimited)
      wanderChance: 7,           // % chance to detour via Overview between farm systems
    },
    antiDetection: {
      minDelaySeconds: 30,
      maxDelaySeconds: 120,
      sleepStartHour: 0, // night mode disabled (start === end = always active)
      sleepEndHour: 0,
      jitterEnabled: true, // random "do nothing" pauses
    },
  };

  function deepMerge(defaults, overrides) {
    const result = { ...defaults };
    for (const key of Object.keys(overrides)) {
      if (overrides[key] && typeof overrides[key] === "object" && !Array.isArray(overrides[key]) &&
          defaults[key] && typeof defaults[key] === "object") {
        result[key] = deepMerge(defaults[key], overrides[key]);
      } else {
        result[key] = overrides[key];
      }
    }
    return result;
  }

  function loadConfig() {
    try {
      const saved = GM_getValue("ogamex_bot_config", null);
      const merged = saved ? deepMerge(DEFAULT_CONFIG, JSON.parse(saved)) : { ...DEFAULT_CONFIG };
      // antiDetection is code-controlled — never override from saved config.
      // v2.12.0 exception: the SLEEP WINDOW is user-configurable (UI inputs),
      // so those two fields survive the reset.
      const savedSleepStart = merged.antiDetection?.sleepStartHour;
      const savedSleepEnd = merged.antiDetection?.sleepEndHour;
      merged.antiDetection = { ...DEFAULT_CONFIG.antiDetection };
      if (Number.isFinite(savedSleepStart)) merged.antiDetection.sleepStartHour = savedSleepStart;
      if (Number.isFinite(savedSleepEnd)) merged.antiDetection.sleepEndHour = savedSleepEnd;

      // v2.16.1: one-shot — give the account a night. Start === end means the
      // window is OFF, i.e. the bot runs 24/7 with no daily quiet period, and
      // that is a far louder signal to an admin than anything about fleet
      // arithmetic. Sets 23:00-05:00 LOCAL time ONCE; both fields
      // stay editable in the panel afterwards and this never runs again, so
      // turning it back off sticks.
      {
        const NIGHT_KEY = "ogamex_migration_night_v2161";
        if (GM_getValue(NIGHT_KEY, "0") !== "1") {
          GM_setValue(NIGHT_KEY, "1");
          if (merged.antiDetection.sleepStartHour === merged.antiDetection.sleepEndHour) {
            merged.antiDetection.sleepStartHour = 23;
            merged.antiDetection.sleepEndHour = 5;
            // MUST persist: the one-shot key stops this from running again, so
            // without a write the next page load would reload the saved 0/0
            // and the window would silently vanish.
            saveConfig(merged);
            setTimeout(() => log("Night window enabled: 23:00-05:00 your local time — a 24/7 bot with no quiet hours is the loudest pattern there is. Change or disable it in the panel (equal start/end = off).", "warn"), 1500);
          }
        }
      }
      // v2.9.2 forced expeditions.enabled=false here because the UI had been
      // removed and old saved state could keep a headless module running.
      // v2.14.0 gives expeditions a real module AND a real toggle, so the
      // override is gone. The shape changed completely though (fleetComposition
      // / maxConcurrent → waves / holdingHours / …), so a saved v2.9-era block
      // is dropped once: deepMerge would otherwise keep dead keys around and,
      // worse, resurrect enabled=true from a config the user never reviewed.
      if (merged.expeditions && ("fleetComposition" in merged.expeditions || "maxConcurrent" in merged.expeditions)) {
        merged.expeditions = { ...DEFAULT_CONFIG.expeditions };
      }

      // v2.9.3 migration: v2.9.0 default minerBase was 6:71:9 (old nexus
      // playthrough). Athena users got that saved in their host-scoped
      // storage on first toggle, then v2.9.1+ bumped the default to
      // 3:269:8 but deepMerge kept the stale saved value. Result: bot
      // sorted "closest-first" against the WRONG galaxy and dispatched
      // fleets that arrived after the asteroid TTL. One-shot reset.
      // v2.37.0: Heavy Cargo wchodzi do normalnego podziału. Bez migracji
      // zapisana konfiguracja (stałe 50 000 000 na falę i HC na liście
      // wykluczeń) trzymałaby stare zachowanie mimo nowych domyślnych wartości.
      {
        const HC_KEY = "ogamex_migration_hc_split_v237";
        if (GM_getValue(HC_KEY, "0") !== "1") {
          GM_setValue(HC_KEY, "1");
          if (merged.expeditions) {
            merged.expeditions.heavyCargoPerWave = 0;
            merged.expeditions.excludeTypes = (merged.expeditions.excludeTypes || [])
              .filter(t => String(t).toUpperCase() !== "HEAVY_CARGO");
            saveConfig(merged);
            setTimeout(() => log("Heavy Cargo dzieli sie teraz na fale jak kazdy inny statek (bylo: stala liczba na fale). Zmienisz to polem Heavy Cargo / fale — 0 = podzial.", "info"), 1500);
          }
        }
      }

      // v2.39.1: stary licznik lotow gorniczych ("wszystkie misje minus
      // ekspedycje") potrafil zatrzymac skan na 90 minut ("flight budget
      // reached (28/3)"). Po podmianie licznika zdejmujemy tez pauze, ktora
      // ten blad zdazyl ustawic — inaczej mining stoi az do jej wygasniecia.
      {
        const MF_KEY = "ogamex_migration_mining_flights_v2391";
        if (GM_getValue(MF_KEY, "0") !== "1") {
          GM_setValue(MF_KEY, "1");
          GM_setValue("ogamex_fleet_return_at", "0");
          setTimeout(() => log("Licznik lotow gorniczych liczy teraz tylko WLASNE loty bota (recznie wysylane misje nie zjadaja limitu). Pauza skanu zdjeta.", "info"), 1500);
        }
      }

      // v2.46.0: konfiguracja jest zapisana u gracza, więc sama zmiana wartości
      // domyślnej nic by nie dała — trzeba dopisać GS do jego listy wykluczeń.
      {
        const DS_KEY = "ogamex_migration_no_deathstar_v246";
        if (GM_getValue(DS_KEY, "0") !== "1") {
          GM_setValue(DS_KEY, "1");
          if (merged.expeditions) {
            const ex = (merged.expeditions.excludeTypes || []).map(t => String(t).toUpperCase());
            if (!ex.includes("DEATH_STAR")) {
              merged.expeditions.excludeTypes = [...ex, "DEATH_STAR"];
              saveConfig(merged);
              setTimeout(() => log("Gwiazda Smierci nie lata juz na ekspedycje — fala leci z predkoscia najwolniejszej jednostki, a GS to 26 min w jedna strone.", "info"), 1500);
            }
          }
        }
      }

      const MIGRATION_KEY = "ogamex_migration_v293_done";
      if (GM_getValue(MIGRATION_KEY, "0") !== "1") {
        merged.asteroidMining.minerBase = { ...DEFAULT_CONFIG.asteroidMining.minerBase };
        // Stale scan queue was built against the wrong base — drop it so
        // the next scan rebuilds with the correct base.
        GM_setValue("ogamex_scan_state", null);
        GM_setValue(MIGRATION_KEY, "1");
        saveConfig(merged);
        console.log("[OGameX v2.9.3] migration: minerBase reset to", merged.asteroidMining.minerBase, "scan state cleared");
      }

      // v2.9.7 migration: prior to v2.9.6, TTL-skips were adding systems
      // to the 1h DispatchedAsteroids cooldown despite no fleet ever
      // being sent. Result: respawned asteroids in those slots were
      // skipped for the next hour with "already dispatched" log. v2.9.6
      // fixed the code, but users still have a corrupted set from the
      // old behavior. One-shot clear so the bot can pick up live
      // asteroids in previously-poisoned coords immediately.
      const MIGRATION_V297 = "ogamex_migration_v297_done";
      if (GM_getValue(MIGRATION_V297, "0") !== "1") {
        GM_setValue("ogamex_dispatched_asteroids", "[]");
        GM_setValue(MIGRATION_V297, "1");
        console.log("[OGameX v2.9.7] migration: DispatchedAsteroids cleared (stale TTL-skip entries from pre-v2.9.6)");
      }

      // v2.9.9 migration: older saved configs had maxFlightMinutes as low as
      // 20, which silently filtered out almost every range the game returned
      // (same-galaxy distances of 130+ → flight ≥20min). Bot would queue 4
      // empty systems near the cap, find nothing, sleep 45min, repeat forever
      // with full miner fleets parked. Force-bump any saved value below the
      // new default so existing users actually scan full ranges. Also clear
      // the stale scan queue + cooldown so the next tick rebuilds against
      // the new filter immediately instead of waiting out the old cooldown.
      const MIGRATION_V299 = "ogamex_migration_v299_done";
      if (GM_getValue(MIGRATION_V299, "0") !== "1") {
        const defaultMaxFlight = DEFAULT_CONFIG.asteroidMining.maxFlightMinutes;
        if (merged.asteroidMining.maxFlightMinutes < defaultMaxFlight) {
          const old = merged.asteroidMining.maxFlightMinutes;
          merged.asteroidMining.maxFlightMinutes = defaultMaxFlight;
          saveConfig(merged);
          console.log(`[OGameX v2.9.9] migration: maxFlightMinutes ${old} → ${defaultMaxFlight}min (was filtering most ranges)`);
        }
        GM_setValue("ogamex_scan_state", null);
        GM_setValue("ogamex_scan_cooldown_until", "0");
        GM_setValue(MIGRATION_V299, "1");
        console.log("[OGameX v2.9.9] migration: scan state + cooldown cleared — next tick scans fresh");
      }
      // v2.10.15 migration: the no-asteroid cooldown is now SHORT whenever the
      // game still shows hint ranges (asteroids respawn in them). Clear any
      // stale long cooldown left by older versions so the new behavior takes
      // effect on this load instead of after the old 45min finishes ticking.
      const MIGRATION_V21015 = "ogamex_migration_v21015_done";
      if (GM_getValue(MIGRATION_V21015, "0") !== "1") {
        GM_setValue("ogamex_scan_cooldown_until", "0");
        GM_setValue(MIGRATION_V21015, "1");
        console.log("[OGameX v2.10.15] migration: stale scan cooldown cleared");
      }

      return merged;
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  function saveConfig(config) {
    GM_setValue("ogamex_bot_config", JSON.stringify(config));
  }

  let CONFIG = loadConfig();

  // v2.10.15: how often to re-sweep hint ranges that are STILL live. OGameX
  // keeps showing the same ranges for a long time and asteroids respawn inside
  // them at position 17 over time, so a long idle cooldown there makes the bot
  // miss them (user had to keep clicking "Scan Asteroids" by hand). Hardcoded
  // on purpose — it bypasses the persisted scanIntervalMin, which is often a
  // stale 45 baked into old saved configs that deepMerge keeps overriding the
  // code default with. The long scanIntervalMin now only applies when there are
  // no hint ranges at all.
  const ACTIVE_RANGE_RECHECK_MIN = 10;

  // v2.27.0: how often to peek at the hint pool WHILE a scan cooldown runs.
  // Asteroids are the owner's largest income by far, so sitting out a 10-minute
  // cooldown after hints reappear is the single most expensive thing this bot
  // can do. One ajax call per probe (a deep fetch is six), so this is cheap.
  const HINT_PROBE_EVERY_MS = 2 * 60 * 1000;

  // ═══════════════════════════════════════════════════════════════
  //  LOGGING
  // ═══════════════════════════════════════════════════════════════

  const MAX_LOG_ENTRIES = 300;
  const LOG_STORAGE_KEY = "ogamex_bot_logs";

  // Load persisted logs from previous page navigations
  let logEntries = (() => {
    try {
      const raw = GM_getValue(LOG_STORAGE_KEY, "[]");
      return JSON.parse(raw).slice(0, MAX_LOG_ENTRIES);
    } catch { return []; }
  })();

  function log(msg, type = "info") {
    const time = new Date().toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const entry = { time, msg, type };
    logEntries.unshift(entry);
    if (logEntries.length > MAX_LOG_ENTRIES) logEntries.pop();
    // Persist logs across page navigations
    GM_setValue(LOG_STORAGE_KEY, JSON.stringify(logEntries));
    updateLogUI();
  }

  // ═══════════════════════════════════════════════════════════════
  //  DZIENNIK OBRONY  (v2.31.0)
  // ═══════════════════════════════════════════════════════════════
  // Osobny, trwały zapis WYŁĄCZNIE zdarzeń obronnych. Zwykły log tonie
  // w skanowaniu asteroid i falach ekspedycji — kilkaset linii na godzinę —
  // więc gdyby atak przeszedł, dowody byłyby nie do odzyskania dokładnie
  // wtedy, gdy są najbardziej potrzebne. Tu trafia to, co odpowiada na
  // pytanie „dlaczego flota zginęła": co bot widział w pasku misji, kiedy
  // był ślepy, co i dokąd wysłał, i co się nie udało.
  //
  // Pojemność liczona w DNIACH, nie w linijkach: odczyty bez obcych flot
  // wpadają raz na 10 minut, więc 600 wpisów to ponad cztery doby ciszy —
  // i znacznie więcej historii, jeśli coś się dzieje, bo wtedy liczą się
  // minuty wokół zdarzenia, a nie tygodnie.
  const ThreatLog = {
    KEY: "ogamex_threat_journal",
    MAX: 600,
    // ── v2.47.0: rano ma być widać noc ──
    // Dziennik trzymał 600 ostatnich wpisów bez względu na rodzaj. Zwykłych
    // odczytów paska przybywa przy KAŻDEJ zmianie liczby misji, a bot wysyła
    // falę co ~70 s — więc sześćset miejsc potrafi się zapełnić samą rutyną
    // w kilka godzin i wypchnąć jedyne wpisy, dla których ten dziennik
    // powstał: alarm, ratunek i powrót. Po nocy zostawałby zapis „12 misji /
    // 12 własnych" ×600.
    //
    // Teraz dwie półki: zdarzenia ważne żyją 12 godzin (i tyle wystarczy, żeby
    // po przespanej nocy wiedzieć, co się działo), a rutynowe odczyty mają
    // własny, mały limit i nie mogą wypchnąć niczego ważnego.
    RETAIN_MS: 12 * 60 * 60 * 1000,
    ROUTINE_MAX: 60,
    IMPORTANT: ["ATAK", "RATUNEK", "POWRÓT", "BŁĄD", "koniec"],

    isImportant(kind) { return this.IMPORTANT.includes(kind); },

    all() {
      try { return JSON.parse(GM_getValue(this.KEY, "[]")) || []; } catch { return []; }
    },

    add(kind, msg) {
      const now = new Date();
      const stamp = `${now.toLocaleDateString("pl-PL")} ${now.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
      const list = this.all();
      list.unshift({ t: stamp, at: Date.now(), k: kind, m: String(msg).slice(0, 400) });
      GM_setValue(this.KEY, JSON.stringify(this._prune(list)));
      try { updateStatusUI(); } catch {}
    },

    // Wpisy bez `at` pochodzą sprzed 2.47.0 — traktujemy je jak świeże, żeby
    // aktualizacja nie skasowała historii, którą właściciel może chcieć zobaczyć.
    _prune(list) {
      const cutoff = Date.now() - this.RETAIN_MS;
      const important = [];
      const routine = [];
      for (const e of list) {
        const at = Number.isFinite(e.at) ? e.at : Date.now();
        if (this.isImportant(e.k)) { if (at >= cutoff) important.push(e); }
        else if (routine.length < this.ROUTINE_MAX) routine.push(e);
      }
      const out = [...important, ...routine].sort((a, b) => (b.at || 0) - (a.at || 0));
      return out.slice(0, this.MAX);
    },

    clear() { GM_setValue(this.KEY, "[]"); },

    // Co się działo w ostatnich N godzinach — jedno zdanie do panelu i do logu.
    summary(hours = 12) {
      const cutoff = Date.now() - hours * 60 * 60 * 1000;
      const recent = this.all().filter(e => (Number.isFinite(e.at) ? e.at : Date.now()) >= cutoff);
      const count = (k) => recent.filter(e => e.k === k).length;
      const lastOf = (k) => recent.find(e => e.k === k)?.t || null;
      const alarms = count("ATAK");
      const saves = recent.filter(e => e.k === "RATUNEK" && /WYS[ŁL]ANE/i.test(e.m)).length;
      const returns = recent.filter(e => e.k === "POWRÓT" && /WYS[ŁL]ANE/i.test(e.m)).length;
      const errors = count("BŁĄD");
      return {
        hours, alarms, saves, returns, errors,
        lastAlarm: lastOf("ATAK"),
        lastSave: recent.find(e => e.k === "RATUNEK" && /WYS[ŁL]ANE/i.test(e.m))?.t || null,
        lastReturn: recent.find(e => e.k === "POWRÓT" && /WYS[ŁL]ANE/i.test(e.m))?.t || null,
        text: alarms || saves || returns || errors
          ? `${hours} h: ${alarms} alarm(ów)`
            + (saves ? `, ${saves}× flota na księżyc (ostatnio ${lastOf("RATUNEK")})` : "")
            + (returns ? `, ${returns}× powrót` : "")
            + (errors ? `, ${errors} błąd(ów)` : "")
          : `${hours} h: spokój — ani jednej obcej floty.`,
      };
    },

    asText() {
      const list = this.all();
      if (!list.length) return "(dziennik obrony pusty)";
      const s = this.summary(12);
      const head = `PODSUMOWANIE ${s.text}`
        + (s.lastAlarm ? `\nOstatni alarm: ${s.lastAlarm}` : "")
        + (s.lastSave ? `\nOstatni ratunek (flota na drugie ciało): ${s.lastSave}` : "")
        + (s.lastReturn ? `\nOstatni powrót: ${s.lastReturn}` : "");
      return `${head}\n${"-".repeat(60)}\n` + list.map(e => `${e.t}  [${e.k}]  ${e.m}`).join("\n");
    },

    lastAlarmAt() {
      const hit = this.all().find(e => e.k === "ATAK");
      return hit ? hit.t : null;
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  ERROR-PAGE RECOVERY  (v2.10.11)
  //  OGameX occasionally serves its OWN "Error occurred / Page not
  //  found" page (URL like /Error/NotFound?aspxerrorpath=/overview).
  //  On it NONE of the game UI exists, so the bot would just sit idle
  //  until the 25-min watchdog reload — long enough for in-flight
  //  miners to be spotted and scrapped. Detect it on load and go
  //  straight back into the game ("< Back to game"), with a backoff so
  //  a sustained outage can't turn into a tight reload loop.
  // ═══════════════════════════════════════════════════════════════
  function isOGameXErrorPage() {
    // URL signal: /Error/..., /Error/NotFound, or an ?aspxerrorpath= query.
    if (/\/Error(\/|$)|NotFound|aspxerrorpath/i.test(window.location.pathname + window.location.search)) return true;
    // Content signal (in case the URL ever differs): the modal shows both lines.
    const t = document.body ? document.body.textContent : "";
    return /Error occurred/i.test(t) && /Page not found/i.test(t);
  }

  function findBackToGameButton() {
    const els = document.querySelectorAll("a, button, input[type=button], input[type=submit]");
    for (const el of els) {
      const txt = (el.textContent || el.value || "").trim();
      if (/back to game/i.test(txt)) return el; // never matches "Back to lobby"
    }
    return null;
  }

  // v2.10.21: on the OGameX landing/lobby page (/ or /home) the user is still
  // LOGGED IN — they just click a "Play / Enter game" button to re-enter (no
  // password). Find that button so the bot can do the same instead of uselessly
  // reloading the landing page. Conservative text match; never a logout/register.
  function findGameEntryElement() {
    const els = document.querySelectorAll("a, button, input[type=button], input[type=submit]");
    const POS = /\b(play|graj|zagraj|enter\s*game|enter|wejd[zź]|wej[sś][cć]ie|do\s*gry|continue|kontynuuj|launch)\b/i;
    const NEG = /log\s*out|wyloguj|logout|register|rejestr|sign\s*up|reset|forgot|password|has[lł]o|news|forum|wiki|discord/i;
    for (const el of els) {
      const txt = (el.textContent || el.value || "").trim();
      const href = (el.getAttribute && el.getAttribute("href")) || "";
      if (!txt && !href) continue;
      if (NEG.test(txt) || NEG.test(href)) continue;
      if (POS.test(txt)) return el;
    }
    return null;
  }

  // v2.10.22: are we INSIDE the logged-in game (vs the logged-out login/landing
  // page)? OGameX's Overview tab lives at "/" or "/home" — the same paths the
  // bot used to treat as "login → bail", so on Overview it never built its panel
  // or started the scheduler (it only ran on /fleet, /galaxy, …). Detect in-game
  // chrome (top resource bar + section menu); if present we're logged in and
  // must run normally even on / or /home.
  function isLoggedInGamePage() {
    if (document.querySelector(".resource-item-metal, .resource-item-deuterium, #planetList, .smallplanet")) return true;
    for (const a of document.querySelectorAll("a.text-item")) {
      if (/^(galaxy|fleet|overview|resources|shipyard|research|defense)$/i.test((a.textContent || "").trim())) return true;
    }
    return false;
  }

  // Dump every clickable on the current page to the persisted log (survives the
  // page bail) — lets us see the exact landing-page buttons to target.
  function logClickables(tag) {
    const els = [...document.querySelectorAll("a, button, input[type=button], input[type=submit]")].slice(0, 60);
    const desc = els.map(el => {
      const t = (el.textContent || el.value || "").replace(/\s+/g, " ").trim().slice(0, 30);
      const cls = el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : "";
      const href = (el.getAttribute && el.getAttribute("href")) || "-";
      return `"${t}"[${el.tagName}${cls} href=${href}]`;
    });
    log(`[${tag}] ${els.length} clickables: ${desc.join(", ")}`, "warn");
  }

  // Returns true if we ARE on the error page and recovery was scheduled —
  // caller must then stop init() (we're navigating away).
  function handleErrorPageIfPresent() {
    if (!isOGameXErrorPage()) {
      // On a real game page → reset the consecutive-error streak.
      GM_setValue("ogamex_error_recover_streak", "0");
      return false;
    }

    // ── backoff: count recoveries that happen <90s apart as a "streak" ──
    const now = Date.now();
    const lastAt = parseInt(GM_getValue("ogamex_error_recover_at", "0"));
    let streak = parseInt(GM_getValue("ogamex_error_recover_streak", "0"));
    streak = lastAt && now - lastAt < 90 * 1000 ? streak + 1 : 0;
    GM_setValue("ogamex_error_recover_at", String(now));
    GM_setValue("ogamex_error_recover_streak", String(streak));

    // ── pick a recovery target ──
    // First try to re-request the exact page OGameX failed on (aspxerrorpath).
    // After a couple of fast repeats on that path, give up on it and use the
    // page's generic "Back to game" instead (→ overview).
    let specificTarget = null;
    const m = window.location.search.match(/[?&]aspxerrorpath=([^&#]+)/i);
    if (m && streak < 2) {
      try {
        const p = decodeURIComponent(m[1]);
        // accept only same-origin relative game paths; never bounce back to
        // an Error/ page or to login (/home).
        if (/^\/[A-Za-z0-9]/.test(p) && !/^\/(Error|home)\b/i.test(p)) specificTarget = p;
      } catch {}
    }

    // 0/1 → quick (~2-4s). Then exponential-ish, capped at 60s, so a sustained
    // OGameX outage backs off instead of hammering the server in a loop.
    const base = 2000 + Math.random() * 2000;
    const backoff = streak <= 1 ? base : Math.min(60000, base + Math.pow(2, streak) * 1000);

    log(`OGameX error page detected → recovering ${specificTarget ? "to " + specificTarget : "via < Back to game"} in ${Math.round(backoff / 1000)}s (streak ${streak}).`, "warn");

    setTimeout(() => {
      if (!isOGameXErrorPage()) return; // page changed under us — nothing to do
      if (specificTarget) {
        window.location.href = specificTarget;
        return;
      }
      // Click the page's own "Back to game" — what a human would do.
      const btn = findBackToGameButton();
      if (btn) {
        log("Clicking < Back to game.", "info");
        if (btn.tagName === "A" && btn.href) {
          window.location.href = btn.href; // use the real href (skips flaky JS handlers)
        } else {
          btn.click();
          // safety net: if the click didn't navigate, force it.
          setTimeout(() => { if (isOGameXErrorPage()) window.location.href = "/overview"; }, 5000);
        }
        return;
      }
      window.location.href = "/overview"; // last resort
    }, backoff);

    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  //  ANTI-DETECTION: Human-like delays
  // ═══════════════════════════════════════════════════════════════

  const AntiDetection = {
    // Gaussian-distributed random delay
    gaussianRandom(mean, stddev) {
      let u = 0, v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
      return Math.max(0, mean + z * stddev);
    },

    // Random delay between min and max seconds (gaussian distribution)
    async delay(label = "action") {
      const { minDelaySeconds, maxDelaySeconds } = CONFIG.antiDetection;
      const mean = (minDelaySeconds + maxDelaySeconds) / 2;
      const stddev = (maxDelaySeconds - minDelaySeconds) / 4;
      const seconds = Math.max(minDelaySeconds, Math.min(maxDelaySeconds, this.gaussianRandom(mean, stddev)));
      log(`Waiting ${Math.round(seconds)}s before ${label}...`, "delay");
      await this.sleep(seconds * 1000);
    },

    // Short delay (2-8 seconds) for between-page navigation
    async shortDelay() {
      const ms = 2000 + Math.random() * 6000;
      await this.sleep(ms);
    },

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    // Check if we should be sleeping (night hours)
    isSleepTime() {
      const { sleepStartHour, sleepEndHour } = CONFIG.antiDetection;
      if (sleepStartHour === sleepEndHour) return false; // disabled
      // v2.12.0: minute-granular with a DAILY ±20min jitter per boundary — a
      // bot that goes quiet at exactly HH:00:00 every night is a fingerprint.
      // Offsets are generated once per UTC day and persisted.
      let jit = null;
      const today = new Date().toISOString().slice(0, 10);
      try { jit = JSON.parse(GM_getValue("ogamex_sleep_jitter", "null")); } catch {}
      if (!jit || jit.date !== today) {
        jit = {
          date: today,
          startOff: Math.round((Math.random() * 40) - 20), // ±20 min
          endOff: Math.round((Math.random() * 40) - 20),
        };
        GM_setValue("ogamex_sleep_jitter", JSON.stringify(jit));
      }
      // v2.16.2: LOCAL time, not UTC. The window exists to make the account
      // look asleep when its owner is asleep, and the owner thinks in the
      // clock on their wall (which is also the clock the game shows). UTC also
      // drifts against local time twice a year with DST — the night window
      // would silently shift by an hour. The stored numbers are now local
      // hours: 23 and 5 mean 23:00-05:00 where the player lives.
      const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
      const norm = (m) => ((m % 1440) + 1440) % 1440;
      const startMin = norm(sleepStartHour * 60 + jit.startOff);
      const endMin = norm(sleepEndHour * 60 + jit.endOff);
      if (startMin === endMin) return false;
      if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
      return nowMin >= startMin || nowMin < endMin;
    },

    // Random jitter: occasionally do nothing for 5-15 minutes
    shouldJitter() {
      return CONFIG.antiDetection.jitterEnabled && Math.random() < 0.1; // 10% chance
    },

    async jitter() {
      if (!this.shouldJitter()) return;
      const minutes = 5 + Math.random() * 10;
      log(`Jitter pause: ${Math.round(minutes)}m (simulating idle player)`, "delay");
      await this.sleep(minutes * 60 * 1000);
    },
  };

  // Action rate limiter — max 10 actions per hour (persisted across page reloads)
  const RateLimiter = {
    maxPerHour: 20,
    KEY: "ogamex_rate_actions",

    _load() {
      try {
        const raw = GM_getValue(this.KEY, "[]");
        return JSON.parse(raw).filter(t => t > Date.now() - 60 * 60 * 1000);
      } catch { return []; }
    },

    _save(actions) {
      GM_setValue(this.KEY, JSON.stringify(actions));
    },

    canAct() {
      return this._load().length < this.maxPerHour;
    },

    record() {
      const actions = this._load();
      actions.push(Date.now());
      this._save(actions);
    },

    remaining() {
      return this.maxPerHour - this._load().length;
    },
  };

  // Navigation rate limiter — caps total bot-initiated page loads per hour.
  // RateLimiter above counts only fleet dispatches (~1-3/h). Scan traffic
  // (/galaxy?x=&y= page loads + AJAX fetches) is invisible to it — a full
  // 300-system scan can push ~300 requests in 7-8 minutes. NavRateLimiter
  // closes that gap so the scan pauses itself before looking bot-like.
  const NavRateLimiter = {
    maxPerHour: 300,
    KEY: "ogamex_nav_actions",

    _load() {
      try {
        const raw = GM_getValue(this.KEY, "[]");
        return JSON.parse(raw).filter(t => t > Date.now() - 60 * 60 * 1000);
      } catch { return []; }
    },

    _save(actions) {
      GM_setValue(this.KEY, JSON.stringify(actions));
    },

    record() {
      const actions = this._load();
      actions.push(Date.now());
      this._save(actions);
    },

    count() {
      return this._load().length;
    },

    canNavigate() {
      return this._load().length < this.maxPerHour;
    },

    // ms until oldest action rolls off — used to schedule resume after cap hit.
    millisUntilReset() {
      const actions = this._load();
      if (actions.length < this.maxPerHour) return 0;
      const oldest = Math.min(...actions);
      return Math.max(0, (oldest + 60 * 60 * 1000) - Date.now());
    },
  };

  // Navigate, first checking the nav cap. On cap hit, persists a pause timer
  // and returns false — caller must `return` and let the scheduler retry
  // after the pause window. ScanState is preserved so the queue resumes.
  // Returns true when navigation was committed (page is about to unload).
  function scanNavigate(url, context = "scan") {
    if (!NavRateLimiter.canNavigate()) {
      const waitMs = Math.max(NavRateLimiter.millisUntilReset() + 60 * 1000, 10 * 60 * 1000);
      GM_setValue("ogamex_nav_pause_until", String(Date.now() + waitMs));
      log(`Nav cap hit (${NavRateLimiter.count()}/${NavRateLimiter.maxPerHour}). Pausing ${Math.ceil(waitMs/60000)}min before ${context}.`, "warn");
      return false;
    }
    NavRateLimiter.record();
    window.location.href = url;
    return true;
  }

  // v2.10.9: human-pace delay between galaxy-system scans. Was 250-650ms — a
  // clear bot-tell (no human clicks through systems twice a second, and it
  // meant ~124 galaxy page-loads per sweep at machine speed). 2-6s + the
  // existing 10% jitter pause looks like a person checking nearby belts.
  // Balances stealth vs throughput (owner choice 2026-06-08). The
  // closest-range-first scan ORDER is unchanged — only the pacing.
  function humanScanDelayMs() {
    return 2000 + Math.random() * 4000;
  }

  // ═══════════════════════════════════════════════════════════════
  //  GAME STATE: Parse current game data from DOM
  // ═══════════════════════════════════════════════════════════════

  const GameState = {
    // Get CSRF token for AJAX requests
    getToken() {
      return (
        document.querySelector('meta[name="csrf-token"]')?.content ||
        document.querySelector('input[name="_token"]')?.value ||
        (typeof window !== "undefined" && window.token) ||
        ""
      );
    },

    // Get current resources
    getResources() {
      const parse = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return 0;
        const text = el.textContent.replace(/[.\s]/g, "").replace(/,/g, "");
        return parseInt(text, 10) || 0;
      };
      return {
        metal: parse("#resources_metal") || parse('[id*="metal"] .value') || 0,
        crystal: parse("#resources_crystal") || parse('[id*="crystal"] .value') || 0,
        deuterium: parse("#resources_deuterium") || parse('[id*="deuterium"] .value') || 0,
      };
    },

    // Get list of player's planets from right sidebar
    // Sidebar: "[26/26] Planets" header, each planet has coords like [6:476:9]
    // IMPORTANT: Must NOT pick up coords from the galaxy table (other players)
    getPlanets() {
      const planets = [];
      const seen = new Set();

      // The right sidebar planet entries are inside the planet list area
      // They are NOT inside .galaxy-content or .galaxy-item
      // Look for coord patterns only in elements that are NOT in the galaxy table
      document.querySelectorAll("a, div, span").forEach((el) => {
        // Skip anything inside galaxy content area
        if (el.closest(".galaxy-content, .galaxy-item, .galaxy-info")) return;

        const text = el.textContent;
        // Only match elements whose DIRECT text is short (planet entry, not container)
        if (text.length > 80) return;

        const match = text.match(/\[(\d+):(\d+):(\d+)\]/);
        if (!match) return;

        const galaxy = parseInt(match[1]);
        const system = parseInt(match[2]);
        const position = parseInt(match[3]);
        const key = `${galaxy}:${system}:${position}`;
        if (seen.has(key)) return;

        const name = text.replace(/\[.*\]/, "").replace(/\s+/g, " ").trim() || "Planet";

        seen.add(key);
        planets.push({
          galaxy, system, position, name,
          link: el.tagName === "A" ? el.href : el.closest("a")?.href || null,
        });
      });

      // Only log when count changes — getPlanets is called many times per cycle
      if (planets.length !== this._lastPlanetCount) {
        if (planets.length > 0) {
          log(`Parsed ${planets.length} planets`, "info");
        } else {
          log("Could not parse planets from sidebar", "error");
        }
        this._lastPlanetCount = planets.length;
      }
      return planets;
    },
    _lastPlanetCount: -1,

    // Get current (active) planet coordinates from page.
    // IMPORTANT: do NOT fall back to URL ?x=&y= — on /fleet and /galaxy those are
    // the TARGET coords, not the active source planet, which corrupts callers
    // tracking which planets they've already tried.
    getCurrentPlanet() {
      // Try highlighted planet in right sidebar (has different styling)
      const activePlanet = document.querySelector('[class*="active"] [class*="planet"], .active-planet, [class*="selected"]');
      if (activePlanet) {
        const match = activePlanet.textContent.match(/\[(\d+):(\d+):(\d+)\]/);
        if (match) return { galaxy: +match[1], system: +match[2], position: +match[3] };
      }
      // Try common selectors
      const coordEl = document.querySelector(".planet-header .coords, .current-planet .coords, [class*='planet-name']");
      if (coordEl) {
        const match = coordEl.textContent.match(/\[(\d+):(\d+):(\d+)\]/);
        if (match) return { galaxy: +match[1], system: +match[2], position: +match[3] };
      }
      return null;
    },

    // Get fleet slots info (from fleet page header area, not full body)
    getFleetSlots() {
      const text = document.body.textContent;
      const match = text.match(/Fleets:\s*(\d+)\s*\/\s*(\d+)/);
      if (match) return { used: parseInt(match[1]), total: parseInt(match[2]) };
      return { used: 0, total: 1 };
    },

    // Get expedition slots
    getExpeditionSlots() {
      const text = document.body.textContent;
      const match = text.match(/Expeditions:\s*(\d+)\s*\/\s*(\d+)/);
      if (match) return { used: parseInt(match[1]), total: parseInt(match[2]) };
      return { used: 0, total: 1 };
    },

    // Get available ships on current planet
    getAvailableShips() {
      const ships = {};
      document.querySelectorAll(".ship-item, [data-ship-type]").forEach((el) => {
        const type = el.dataset?.shipType;
        const qty = parseInt(el.dataset?.shipQuantity || el.querySelector(".ship-quantity, .quantity")?.textContent?.replace(/[.\s,]/g, "") || "0");
        if (type && qty > 0) {
          ships[type] = qty;
        }
      });
      return ships;
    },

    // Check current page
    getCurrentPage() {
      const path = window.location.pathname;
      if (path.includes("/fleet")) return "fleet";
      if (path.includes("/galaxy")) return "galaxy";
      if (path.includes("/overview")) return "overview";
      return path.replace("/", "") || "unknown";
    },

    // Check for active missions
    getActiveMissions() {
      const missionText = document.body.textContent;
      const match = missionText.match(/(\d+)\s*Missions?:\s*(\d+)\s*Own/);
      if (match) {
        return { total: parseInt(match[1]), own: parseInt(match[2]) };
      }
      return { total: 0, own: 0 };
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  ASTEROID SCANNER: 2-stage — ranges then galaxy page navigation
  //  Stage 1: Fetch ranges via AJAX (Partial_AsteroidLocation)
  //  Stage 2: Navigate galaxy page system-by-system, read live DOM
  // ═══════════════════════════════════════════════════════════════

  const AsteroidScanner = {
    // ── Stage 1: Parse ranges from "Find asteroids" (AJAX — works) ──
    // skipDelay: pass true when calling multiple times in a row to avoid
    // stacking anti-detection sleeps unnecessarily
    async scanRanges(skipDelay = false) {
      log("Fetching asteroid ranges...", "asteroid");
      if (!skipDelay) {
        await AntiDetection.sleep(2000 + Math.random() * 5000);
      }
      try {
        const response = await fetch("/galaxy/Partial_AsteroidLocation", {
          headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" },
          credentials: "same-origin",
        });

        if (!response.ok) {
          log(`Asteroid range fetch failed: HTTP ${response.status}`, "error");
          return null; // v2.12.7: error ≠ empty — don't let a failed fetch read as "no ranges"
        }

        const html = await response.text();
        log(`[DEBUG] AsteroidLocation HTML (${html.length}ch): ${html.substring(0, 200)}`, "info");

        // v2.10.10: session-loss detection. When the game session expires
        // (e.g. after the 45min no-asteroid cooldown idled with zero requests),
        // this fetch follows the auth redirect and returns the LOGIN page with
        // HTTP 200 — which parses as "0 ranges". Without this check the bot
        // keeps polling forever, blind, and never finds another asteroid until
        // a manual reload. A real page load restores the session (remember-me)
        // or lands on /home where init() correctly stays off.
        // Reload is rate-limited to 1/30min so an unexpected-but-valid empty
        // response can't cause a reload loop.
        if (response.redirected || !/galaxy-asteroid-modal|asteroid-modal-desc|playerAste/i.test(html)) {
          log(`Range fetch returned a non-game page (redirected=${response.redirected}) — session expired / logged out?`, "error");
          const lastSessionReload = parseInt(GM_getValue("ogamex_session_reload_at", "0"));
          if (Date.now() - lastSessionReload > 30 * 60 * 1000) {
            GM_setValue("ogamex_session_reload_at", String(Date.now()));
            log("Reloading page to restore session...", "warn");
            setTimeout(() => window.location.reload(), 2000 + Math.random() * 3000);
          }
          return null; // v2.12.7: unknown state, not a verified-empty pool
        }

        const ranges = AsteroidScanner.parseRangesFromHtml(html);

        if (ranges.length === 0) {
          log("No asteroid ranges found", "asteroid");
        } else {
          const labels = ranges.map(r => `[${r.galaxy}:${r.startSystem}-${r.endSystem}]`).join(", ");
          log(`Found ${ranges.length} asteroid ranges: ${labels}`, "asteroid");
        }

        return ranges;
      } catch (err) {
        // v2.12.7: observed live at 05:01 — a transient NetworkError returned
        // [] here, the per-step verify read it as "no active ranges" and
        // KILLED a sweep at 121/155 systems. Errors must be "unknown" (null),
        // never "verified empty"; only a parsed no-asteroid response is [].
        log(`Asteroid range scan error: ${err.message}`, "error");
        return null;
      }
    },

    // ── Parse "[g:s:p] ? [g:s:p]" pairs into ranges ── (extracted v2.12.5)
    // Each consecutive coordinate pair = one independent search area. Do NOT
    // merge overlapping ranges — merging loses information and can cause the
    // bot to scan outside the intended boundaries.
    parseRangesFromHtml(html) {
      const coords = [];
      const regex = /\[(\d+):(\d+):(\d+)\]/g;
      let match;
      while ((match = regex.exec(html)) !== null) {
        coords.push({ galaxy: parseInt(match[1]), system: parseInt(match[2]) });
      }
      const rawRanges = [];
      for (let i = 0; i + 1 < coords.length; i += 2) {
        const a = coords[i], b = coords[i + 1];
        if (a.galaxy === b.galaxy) {
          rawRanges.push({
            galaxy: a.galaxy,
            startSystem: Math.min(a.system, b.system),
            endSystem: Math.max(a.system, b.system),
          });
        }
      }
      rawRanges.sort((a, b) => a.galaxy - b.galaxy || a.startSystem - b.startSystem);
      return rawRanges;
    },

    // ── Stage 1c: click the game's OWN "Find asteroids" button ── (v2.12.5)
    // Observed live (20:38): the bare Partial_AsteroidLocation GET returned
    // "no signs of asteroids" 3× in a row, while a MANUAL click on the row-17
    // button one minute later showed FIVE ranges. The button's click handler
    // evidently does more than a bare read (fresh research roll / different
    // request). Clicking the real button replicates exactly what the game —
    // and a human player — does. Only available on a galaxy page where row 17
    // shows the button (i.e. no asteroid currently occupies the belt).
    async scanRangesViaButton() {
      const btn = document.querySelector("span.x-find-asteroid, span.btn-asteroid-find");
      if (!btn) return null; // not on a galaxy page / button not present
      log("Bare range fetch came back empty — clicking the game's 'Find asteroids' button instead (human path).", "asteroid");
      // Drop any stale modal so the poll below can't read a pre-click leftover
      document.querySelectorAll(".galaxy-asteroid-modal").forEach(el => el.remove());
      await AntiDetection.sleep(800 + Math.random() * 1200);
      btn.click();
      // Poll for the modal the game renders (up to ~6s)
      let modal = null;
      for (let i = 0; i < 12; i++) {
        await AntiDetection.sleep(500);
        modal = document.querySelector(".galaxy-asteroid-modal");
        if (modal) break;
      }
      if (!modal) {
        log("Find-asteroids modal did not appear within 6s — falling back to empty result.", "warn");
        return [];
      }
      await AntiDetection.sleep(700 + Math.random() * 1000); // human reads the modal
      const ranges = this.parseRangesFromHtml(modal.outerHTML);
      // Close like a human: prefer a real close control, else drop the node.
      // (Leftover DOM is harmless anyway — the next scan step is a full page load.)
      const dialog = modal.closest("dialog, [class*='modal-wrap'], [class*='dialog'], [class*='popup']") || modal;
      const closeBtn = dialog.querySelector("[class*='close'], button[aria-label='Close']")
        || [...dialog.querySelectorAll("button, span, a")].find(el => /^[×✕x]$/i.test((el.textContent || "").trim()));
      if (closeBtn) closeBtn.click(); else modal.remove();
      if (ranges.length > 0) {
        const labels = ranges.map(r => `[${r.galaxy}:${r.startSystem}-${r.endSystem}]`).join(", ");
        log(`Button scan found ${ranges.length} asteroid ranges: ${labels}`, "asteroid");
      } else {
        log("Button scan: modal shows no ranges either — hint pool genuinely empty.", "asteroid");
      }
      return ranges;
    },

    // ── Stage 1b: Deep fetch — call scanRanges N times to build the authoritative
    // range set. Single calls return a random subset of the pool, so one call can
    // silently omit an active range. Used by startNewScan AND re-check so the
    // re-check has enough confidence to DROP stale ranges that didn't reappear.
    async scanRangesFull(maxCalls = 6) {
      const allRanges = [];
      const seen = new Set();
      let prevCount = 0;
      for (let call = 0; call < maxCalls; call++) {
        if (call > 0) await AntiDetection.sleep(800 + Math.random() * 1200);
        const batch = await AsteroidScanner.scanRanges(call > 0);
        if (batch === null) continue; // v2.12.7: errored call = no information, not "empty"
        for (const r of batch) {
          const key = `${r.galaxy}:${r.startSystem}-${r.endSystem}`;
          if (!seen.has(key)) {
            seen.add(key);
            allRanges.push(r);
          }
        }
        if (allRanges.length === prevCount && call >= 2) {
          log(`Deep fetch: no new ranges after ${call + 1} calls, stopping`, "asteroid");
          break;
        }
        prevCount = allRanges.length;
      }
      // v2.12.5: empty result → try the game's own "Find asteroids" button
      // (see scanRangesViaButton). The bare GET provably under-reports when
      // the hint pool needs a fresh research roll.
      if (allRanges.length === 0) {
        const viaButton = await AsteroidScanner.scanRangesViaButton();
        if (viaButton && viaButton.length > 0) return viaButton;
      }
      allRanges.sort((a, b) => a.galaxy - b.galaxy || a.startSystem - b.startSystem);
      return allRanges;
    },

    // ── Stage 2: Check position 17 in LIVE DOM (current galaxy page) ──
    // Returns: { found: true, fleetUrl: "/fleet?x=6&y=84&z=17&mission=12",
    //            ttlSeconds: 353 } or { found: false }
    // ttlSeconds comes from data-asteroid-disappear (game's own countdown).
    // Caller MUST compare it against estimated flight time before dispatch
    // — otherwise we burn deuter on asteroids that vanish mid-flight.
    checkCurrentPageForAsteroid() {
      const items = document.querySelectorAll(".galaxy-item");
      const totalRows = items.length;

      // Log DOM state for debugging — helps diagnose missed detections
      log(`[DOM] galaxy-item rows found: ${totalRows}`, "fleet");

      if (totalRows === 0) {
        log("[DOM] No .galaxy-item rows! Page not fully rendered yet.", "error");
        return { found: false };
      }

      for (const item of items) {
        const idx = item.querySelector(".planet-index");
        if (!idx) continue;
        const posText = idx.textContent.trim();
        if (posText !== "17") continue;

        // Found row 17 — log full HTML for analysis
        const rowHtml = item.innerHTML.replace(/\s+/g, " ").trim().substring(0, 600);
        log(`[DOM] Row 17 HTML: ${rowHtml}`, "fleet");

        // ── Quick exit: "Find asteroids" button means NO asteroid here ──
        const findBtn = item.querySelector("span.x-find-asteroid, span.btn-asteroid-find");
        if (findBtn) {
          log(`Pos17: no asteroid (Find asteroids button present)`, "asteroid");
          return { found: false };
        }

        // Helper: read TTL seconds from any data-asteroid-disappear elem,
        // fall back to parsing (MM:SS) from row text. Returns null if neither.
        const parseTtlSeconds = () => {
          const el = item.querySelector("[data-asteroid-disappear]");
          if (el) {
            const n = parseInt(el.getAttribute("data-asteroid-disappear") || "", 10);
            if (Number.isFinite(n) && n > 0) return n;
          }
          const txt = (item.textContent || "").replace(/\s+/g, " ").trim();
          const m = txt.match(/\((\d{1,2}):(\d{2})\)/);
          if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
          return null;
        };

        // ── Method 1: a.btn-asteroid or mission=12 link (direct fleet URL) ──
        const asteroidLink = item.querySelector("a.btn-asteroid, a[href*='mission=12']");
        if (asteroidLink) {
          const href = asteroidLink.getAttribute("href") || "";
          const ttlSeconds = parseTtlSeconds();
          log(`ASTEROID FOUND! Fleet URL: ${href} | TTL: ${ttlSeconds ?? "?"}s`, "success");
          return { found: true, fleetUrl: href, ttlSeconds };
        }

        // ── Method 2: data-asteroid-disappear timer element ──
        const timerEl = item.querySelector("[data-asteroid-disappear]");
        if (timerEl) {
          const ttlSeconds = parseTtlSeconds();
          log(`ASTEROID FOUND (timer attr)! TTL: ${ttlSeconds ?? "?"}s`, "success");
          const urlMatch = window.location.href.match(/[?&]x=(\d+).*?[?&]y=(\d+)/);
          const reconstructed = urlMatch
            ? `/fleet?x=${urlMatch[1]}&y=${urlMatch[2]}&z=17&mission=12`
            : null;
          return { found: true, fleetUrl: reconstructed, ttlSeconds };
        }

        // ── Method 3: text-based — timer pattern (MM:SS) in row 17 ──
        const rowText = (item.textContent || "").replace(/\s+/g, " ").trim();
        const timerMatch = rowText.match(/\((\d{1,2}:\d{2})\)/);
        if (timerMatch) {
          const ttlSeconds = parseTtlSeconds();
          const urlMatch = window.location.href.match(/[?&]x=(\d+).*?[?&]y=(\d+)/);
          const reconstructed = urlMatch
            ? `/fleet?x=${urlMatch[1]}&y=${urlMatch[2]}&z=17&mission=12`
            : null;
          log(`ASTEROID FOUND (text timer)! TTL: ${ttlSeconds ?? "?"}s, url: ${reconstructed}`, "success");
          return { found: true, fleetUrl: reconstructed, ttlSeconds };
        }

        // No asteroid at position 17
        log(`Pos17: no asteroid (rows=${totalRows}, text="${rowText.substring(0, 80)}")`, "asteroid");
        return { found: false };
      }

      // Row 17 not found in DOM at all
      log(`[DOM] Pos17 row NOT found! Total rows: ${totalRows}. Selectors may have changed.`, "error");
      // Log all available position indices for diagnostics
      const allPos = [...items].map(i => i.querySelector(".planet-index")?.textContent?.trim() || "?").join(",");
      log(`[DOM] Available positions: ${allPos}`, "fleet");
      return { found: false };
    },

    // ── Build scan queue: all systems in all ranges, sorted by distance ──
    // v2.9.1: scan order = closest-to-base first. With 5 active ranges
    // spread across the galaxy, scanning ascending-by-system can spend
    // minutes walking a range 200+ systems from base before discovering
    // an asteroid right next door. Asteroids have a TTL (game-side) and
    // miner flight is one-way 1-25min depending on distance, so every
    // second wasted on far ranges first costs us catches.
    //
    // Filters out systems whose estimated one-way flight exceeds
    // maxFlightMinutes (no point queueing what we can't dispatch).
    // Same-galaxy systems always sort before cross-galaxy.
    buildScanQueue(ranges, base = null, maxFlightMinutes = null) {
      // v2.12.6: a range whose asteroid we already dispatched to is DONE for
      // as long as the fleet is en route (live DispatchedAsteroids entry) —
      // "one asteroid per range" means walking its other systems finds
      // nothing, and re-walking a harvested range minutes later is pure
      // bot-tell traffic. The entry expires at fleet ARRIVAL, so the range
      // returns to rotation exactly when a fresh spawn becomes possible.
      //
      // v2.12.8: one en-route fleet cancels AT MOST ONE range. The old
      // filter dropped every range containing ANY dispatched coord, so with
      // overlapping hints a single fleet killed several ranges at once
      // (observed: [3:13] en route excluded BOTH [3:9-29] and [3:12-32] —
      // two hint rows = two asteroids, and the second, unclaimed one was
      // never scanned; the bot then reported "no asteroids" while the game
      // modal still listed its range). Maximum bipartite matching between
      // dispatched coords and the ranges that contain them: only matched
      // ranges are dropped, every surplus range stays in the queue.
      //
      // v2.12.9: matching, but only over coords whose range is CERTAIN. A
      // coord inside the overlap of two hints could belong to either one, and
      // dropping the wrong one takes an unclaimed asteroid's whole search area
      // out of the sweep (same failure mode pruneFoundRange had). An ambiguous
      // en-route coord therefore excludes NOTHING — re-walking a possibly
      // harvested range costs page loads; the coord itself can never get a
      // second fleet, because the dispatch path re-checks DispatchedAsteroids
      // .has() live on the galaxy page before every send.
      const covers = (c, r) => c.galaxy === r.galaxy && c.system >= r.startSystem && c.system <= r.endSystem;
      const blocked = DispatchedAsteroids.coords().filter(c => {
        const containing = ranges.filter(r => covers(c, r));
        if (containing.length <= 1) return true;
        const labels = containing.map(r => `[${r.galaxy}:${r.startSystem}-${r.endSystem}]`).join(" / ");
        log(`En-route asteroid [${c.galaxy}:${c.system}:17] is inside ${containing.length} overlapping ranges (${labels}) — ambiguous, so none of them is excluded from the scan.`, "asteroid");
        return false;
      });
      const matchedBy = new Array(ranges.length).fill(-1); // range idx → blocked idx
      const tryAssign = (bi, visited) => {
        for (let ri = 0; ri < ranges.length; ri++) {
          if (visited.has(ri) || !covers(blocked[bi], ranges[ri])) continue;
          visited.add(ri);
          if (matchedBy[ri] === -1 || tryAssign(matchedBy[ri], visited)) {
            matchedBy[ri] = bi;
            return true;
          }
        }
        return false;
      };
      for (let bi = 0; bi < blocked.length; bi++) tryAssign(bi, new Set());
      const liveRanges = ranges.filter((r, ri) => {
        if (matchedBy[ri] === -1) return true;
        const hit = blocked[matchedBy[ri]];
        log(`Range [${r.galaxy}:${r.startSystem}-${r.endSystem}] excluded — asteroid [${hit.galaxy}:${hit.system}:17] already dispatched, fleet en route.`, "asteroid");
        return false;
      });
      // Stats for the caller: lets startScan tell "everything is already
      // being mined" (normal) apart from "queue truly empty" (config issue).
      this.lastQueueStats = {
        totalRanges: ranges.length,
        fleetExcluded: ranges.length - liveRanges.length,
      };

      // Sort ranges so the closest one (to base) is scanned first,
      // but stay sequential ascending inside each range — otherwise we
      // interleave systems across ranges when two ranges have overlapping
      // distance bands (e.g. [185-209] and [331-355] from base 269).
      const sortedRanges = [...liveRanges];
      if (base) {
        sortedRanges.sort((a, b) => {
          const aSame = a.galaxy === base.galaxy;
          const bSame = b.galaxy === base.galaxy;
          if (aSame !== bSame) return aSame ? -1 : 1;
          if (a.galaxy !== b.galaxy) return a.galaxy - b.galaxy;
          const aDist = a.endSystem < base.system
            ? base.system - a.endSystem
            : a.startSystem > base.system
              ? a.startSystem - base.system
              : 0;
          const bDist = b.endSystem < base.system
            ? base.system - b.endSystem
            : b.startSystem > base.system
              ? b.startSystem - base.system
              : 0;
          return aDist - bDist;
        });
      } else {
        sortedRanges.sort((a, b) => a.galaxy - b.galaxy || a.startSystem - b.startSystem);
      }

      const seen = new Set();
      const queue = [];
      for (const range of sortedRanges) {
        for (let s = range.startSystem; s <= range.endSystem; s++) {
          const key = `${range.galaxy}:${s}`;
          if (seen.has(key)) continue;
          seen.add(key);

          if (base && maxFlightMinutes != null && range.galaxy === base.galaxy) {
            const dist = Math.abs(s - base.system);
            if (AsteroidScanner.estimateFlightMinutes(dist) > maxFlightMinutes) {
              continue;
            }
          }
          queue.push({ galaxy: range.galaxy, system: s });
        }
      }
      return queue;
    },

    // ── Helper: find closest planet to a coordinate ──
    findClosestPlanet(coord, planets) {
      let closest = null, minDist = Infinity;
      for (const planet of planets) {
        if (planet.galaxy !== coord.galaxy) continue;
        const dist = Math.abs(planet.system - coord.system);
        if (dist < minDist) { minDist = dist; closest = planet; }
      }
      return { planet: closest, distance: minDist };
    },

    // ASTEROID_MINER flight time has a large fixed overhead (~10min warmup
    // + base flight) plus a small linear distance component. Single-rate
    // formulas are very wrong at small distances — v2.9.3 used /9 which
    // gave 2min for Δ=13 when reality is ~11min, leaving zero safety
    // margin on short-TTL asteroids.
    //
    // Two-point calibration on athena (2026-05-21):
    //   Δ=13  sys (3:269 → 3:256) → ~11min one-way (countdown 10m49s ×2)
    //   Δ=217 sys (3:269 → 3:52)  → ~24min one-way (countdown 23m54s ×2)
    // Linear fit: time_min ≈ 10.5 + 0.064 × distance. Round up + floor at
    // 11 so we never under-estimate even for adjacent systems.
    estimateFlightMinutes(systemDistance) {
      return Math.max(11, Math.ceil(11 + systemDistance / 15));
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  GALAXY SCAN STATE: Persisted across page navigations
  // ═══════════════════════════════════════════════════════════════

  const ScanState = {
    KEY: "ogamex_scan_state",

    load() {
      try {
        const raw = GM_getValue(this.KEY, null);
        if (!raw) return null;
        const state = JSON.parse(raw);
        // Expire scans older than 120 minutes (large ranges + dispatch + delays)
        if (state.active && Date.now() - state.startedAt > 120 * 60 * 1000) {
          log("Scan expired (>120min), clearing", "warn");
          this.clear();
          return null;
        }
        return state;
      } catch { return null; }
    },

    save(state) {
      GM_setValue(this.KEY, JSON.stringify(state));
    },

    clear() {
      GM_setValue(this.KEY, null);
    },

    // Start a new scan
    start(ranges, queue) {
      this.save({
        active: true,
        ranges,
        queue,           // [{galaxy, system}, ...] — remaining systems to scan
        scannedCount: 0,
        totalCount: queue.length,
        scannedSystems: [], // track scanned systems for range re-fetch dedup
        foundAsteroid: null,
        startedAt: Date.now(),
        lastRangeCheckAt: Date.now(),
        lastDeepFetchCount: 0,
      });
    },

    // Mark current system as scanned, advance to next
    advance(state) {
      const done = state.queue.shift();
      if (done) {
        if (!state.scannedSystems) state.scannedSystems = [];
        state.scannedSystems.push({ galaxy: done.galaxy, system: done.system });
      }
      state.scannedCount++;
      this.save(state);
    },

    // Mark asteroid found (keep scan active so it resumes after dispatch)
    markFound(state, galaxy, system, ttlSeconds = null) {
      state.foundAsteroid = {
        galaxy,
        system,
        position: 17,
        label: `[${galaxy}:${system}:17]`,
        ttlSeconds,
        foundAt: Date.now(),
      };
      // Don't set active=false — scan should resume after dispatch
      this.save(state);
    },

    // v2.10.5: once an asteroid is found in a range, the rest of that range's
    // systems are dead weight to scan (each hint range holds ~one asteroid).
    // Drop the remaining queued systems that belong to the found asteroid's
    // range(s) — BUT keep any system that ALSO falls inside a different range
    // that hasn't been satisfied yet, so heavily-overlapping ranges (e.g.
    // [310-330] / [311-331] / [317-337]) don't lose their own asteroids.
    pruneFoundRange(state, galaxy, system) {
      if (!state || !Array.isArray(state.ranges) || !Array.isArray(state.queue)) return 0;
      const inRange = (r, g, s) => r.galaxy === g && s >= r.startSystem && s <= r.endSystem;
      const allContaining = state.ranges.filter(r => inRange(r, galaxy, system));
      if (allContaining.length === 0) return 0;
      // v2.10.23: hint ranges OVERLAP (e.g. [3:28-48] and [3:39-59] share
      // 39-48). An asteroid found in the shared part belongs to only ONE of
      // them — we cannot tell which, and the other range still holds its own
      // asteroid a few systems away. Crediting the find to EVERY containing
      // range pruned them all at once, so that second asteroid was never
      // scanned and never mined.
      //
      // v2.12.9: v2.10.23's "credit the NARROWEST containing range" is not a
      // tiebreak at all when the hints are equal-width — and on athena every
      // hint row is exactly 21 systems wide, so reduce() always kept the FIRST
      // range and pruned its exclusive half unscanned. Simulation over the
      // live 10-hint layout ([3:43-63]/[3:54-74], [3:88-108]/[3:102-122],
      // [3:158-178]/[3:175-195] overlapping): only 49.3% of sweeps dispatched
      // all 10 asteroids, avg 9.37/10, and every loss was the lower range of
      // an overlapping pair. The other range's asteroid can be ANYWHERE in its
      // span — including the shared part — so an ambiguous find licenses no
      // pruning whatsoever. Extra page loads are the price of never dropping
      // an unscanned asteroid.
      if (allContaining.length > 1) {
        const labels = allContaining.map(r => `[${r.galaxy}:${r.startSystem}-${r.endSystem}]`).join(" / ");
        log(`Asteroid [${galaxy}:${system}:17] sits in ${allContaining.length} overlapping ranges (${labels}) — can't tell which one it satisfies, keeping every system of both queued.`, "asteroid");
        return 0;
      }
      const containing = [allContaining[0]];
      const owner = allContaining[0];
      const others = state.ranges.filter(r => r !== owner);
      const before = state.queue.length;
      state.queue = state.queue.filter(q => {
        const inContaining = containing.some(r => inRange(r, q.galaxy, q.system));
        if (!inContaining) return true;                       // unrelated system → keep
        const inOther = others.some(r => inRange(r, q.galaxy, q.system));
        return inOther;                                       // shared with another range → keep; else drop
      });
      const removed = before - state.queue.length;
      if (removed > 0) {
        state.scannedCount += removed; // count skipped systems so the X/Y progress stays sane
        this.save(state);
      }
      return removed;
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  DISPATCHED ASTEROIDS: Skip already-mined coordinates
  // ═══════════════════════════════════════════════════════════════

  const DispatchedAsteroids = {
    KEY: "ogamex_dispatched_asteroids",
    TTL: 60 * 60 * 1000, // fallback block when the fleet's arrival time is unknown

    _load() {
      try {
        const raw = GM_getValue(this.KEY, "[]");
        // v2.10.25: an entry expires at its releaseAt (fleet arrival + buffer)
        // when known, else after the flat TTL. The game respawns asteroids in
        // the same slots every ~5-15min, often at identical coords — a flat 1h
        // block skipped several legitimately mineable respawns per hour. Once
        // the fleet has ARRIVED the asteroid it flew to is consumed, so
        // anything visible at those coords afterwards is a NEW instance.
        return JSON.parse(raw).filter(e => Date.now() < (e.releaseAt || e.at + this.TTL));
      } catch { return []; }
    },

    add(galaxy, system) {
      const entries = this._load();
      entries.push({ coord: `${galaxy}:${system}`, at: Date.now() });
      GM_setValue(this.KEY, JSON.stringify(entries));
    },

    // v2.12.6: all live (non-expired) dispatched coords, parsed. Used by
    // buildScanQueue to drop whole ranges that already yielded an asteroid.
    coords() {
      return this._load().map(e => {
        const [g, s] = String(e.coord).split(":").map(Number);
        return { galaxy: g, system: s };
      }).filter(c => Number.isFinite(c.galaxy) && Number.isFinite(c.system));
    },

    // v2.10.25: set/tighten the expiry of the newest entry for these coords.
    // Called at send-confirmation time, when the game's own flight-time display
    // gives us the real arrival.
    release(coordStr, releaseAt) {
      if (!coordStr || !Number.isFinite(releaseAt)) return;
      const entries = this._load();
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].coord === coordStr) { entries[i].releaseAt = releaseAt; break; }
      }
      GM_setValue(this.KEY, JSON.stringify(entries));
    },

    has(galaxy, system) {
      return this._load().some(e => e.coord === `${galaxy}:${system}`);
    },

    // v2.10.27: active entries with their expiry — for the panel.
    entries() {
      return this._load().map(e => ({ coord: e.coord, freeAt: e.releaseAt || e.at + this.TTL }));
    },

    clear() {
      GM_setValue(this.KEY, "[]");
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  MINING FLIGHTS (v2.39.1): ile NASZYCH lotow gorniczych jest w powietrzu
  // ═══════════════════════════════════════════════════════════════
  // Do v2.39.0 liczylo sie to odejmowaniem: "wszystkie wlasne misje minus
  // ekspedycje". Zalozenie, ze wszystko, co nie jest ekspedycja, jest
  // miningiem, jest falszywe — wlasciciel gra tez recznie (kolonizacja,
  // transporty), a te misje wchodzily w limit gorniczy. Log z 11:54:
  // "flight budget reached (28/3) -> scan paused ~90min" przy trzech realnych
  // lotach na asteroidy. Mining, glowne zrodlo dochodu, stal poltorej godziny.
  //
  // Bot sam wysyla te floty, wiec sam moze je policzyc. Wpis zyje przez CALY
  // przelot tam i z powrotem (DispatchedAsteroids kasuje swoj wpis juz przy
  // przylocie, bo tam chodzi o blokade koordynatow, nie o slot floty).
  const MiningFlights = {
    KEY: "ogamex_mining_flights",

    _load() {
      try {
        const now = Date.now();
        return JSON.parse(GM_getValue(this.KEY, "[]")).filter(e => e && e.returnAt > now);
      } catch { return []; }
    },

    // flightMs = czas lotu w jedna strone z formularza gry (moze byc nieznany)
    add(coord, flightMs) {
      const roundTrip = flightMs > 0
        ? flightMs * 2 + 60000
        : (CONFIG.asteroidMining.maxFlightMinutes || 90) * 2 * 60 * 1000;
      const entries = this._load();
      entries.push({ coord: coord || "?", at: Date.now(), returnAt: Date.now() + roundTrip });
      GM_setValue(this.KEY, JSON.stringify(entries));
    },

    count() { return this._load().length; },

    // wysylka odrzucona przez gre → skasuj ostatni wpis (flota nie wystartowala)
    dropLast() {
      const entries = this._load();
      entries.pop();
      GM_setValue(this.KEY, JSON.stringify(entries));
    },

    list() { return this._load(); },

    clear() { GM_setValue(this.KEY, "[]"); },
  };

  // v2.10.24: extract target coords from ANY fleet-URL shape the bot produces.
  // The same asteroid yields DIFFERENT url strings depending on how it was
  // detected (game's raw href with galaxy=/system= vs our reconstructed
  // /fleet?x=..&y=..), so every duplicate guard must compare COORDS, never
  // string-equal URLs. Returns "g:s" or null.
  function coordsFromFleetUrl(url) {
    if (!url) return null;
    const g = url.match(/[?&](?:x|galaxy)=(\d+)/);
    const s = url.match(/[?&](?:y|system)=(\d+)/);
    // v2.11.0: include the position — inactive farming targets several
    // positions in ONE system, and a 2-part coord would false-block them as
    // duplicates of each other. `planet=` is the destination TYPE, not the
    // position — never match it here.
    const z = url.match(/[?&](?:z|position)=(\d+)/);
    if (!g || !s) return null;
    return z ? `${g[1]}:${s[1]}:${z[1]}` : `${g[1]}:${s[1]}`;
  }

  // ═══════════════════════════════════════════════════════════════
  //  TAB LOCK  (v2.10.25) — exactly ONE tab runs the bot
  // ═══════════════════════════════════════════════════════════════
  // Incident 2026-07-20: three fleets to [3:373:17] launched 1s and 14s apart.
  // A single tab physically cannot do that (one dispatch = 3 form steps with
  // sleeps ≈8-12s + navigation) → several open game tabs were EACH running the
  // scheduler and each picked up pending_mission. All GM_setValue-based guards
  // are blind to this: Tampermonkey propagates GM storage to other tabs
  // ASYNCHRONOUSLY (seconds), so the duplicate stamps raced. localStorage IS
  // synchronous across same-origin tabs — the lock lives there. The tab id
  // lives in sessionStorage so the leader keeps its identity across the many
  // page navigations the bot performs.
  const TabLock = {
    LS_KEY: "ogx_active_tab_lock",
    // 3min: background tabs get their timers throttled to ~1/min, so a
    // backgrounded leader may only refresh once a minute — 45s staleness made
    // leadership flap between tabs. A closed leader hands over within ≤3min.
    STALE_MS: 3 * 60 * 1000,
    HEARTBEAT_MS: 10 * 1000,  // independent interval keeps the lock fresh between 50-90s ticks
    _id: null,

    id() {
      if (this._id) return this._id;
      try {
        this._id = sessionStorage.getItem("ogx_tab_id");
        if (!this._id) {
          this._id = Math.random().toString(36).slice(2) + Date.now().toString(36);
          sessionStorage.setItem("ogx_tab_id", this._id);
        }
      } catch { this._id = "t" + Math.floor(Math.random() * 1e9); }
      return this._id;
    },

    _read() {
      try { return JSON.parse(localStorage.getItem(this.LS_KEY) || "null"); } catch { return null; }
    },

    // True when THIS tab holds (or successfully claims) the lock. Claiming
    // re-reads after write so a simultaneous write by another tab
    // (last-write-wins) is detected instead of both tabs believing they lead.
    isLeader() {
      const now = Date.now();
      const lock = this._read();
      if (lock && lock.id !== this.id() && now - lock.at <= this.STALE_MS) return false;
      try { localStorage.setItem(this.LS_KEY, JSON.stringify({ id: this.id(), at: now })); } catch { return true; }
      const after = this._read();
      return !after || after.id === this.id();
    },

    // v2.10.27: READ-ONLY leadership peek for UI — never claims the lock
    // (isLeader() writes, so calling it from a passive tab's status refresh
    // would steal leadership).
    peek() {
      const lock = this._read();
      if (!lock || Date.now() - lock.at > this.STALE_MS) return "unclaimed";
      return lock.id === this.id() ? "leader" : "passive";
    },
  };
  let _tabLockLogged = false;
  function requireLeader(context) {
    if (TabLock.isLeader()) return true;
    if (!_tabLockLogged) {
      _tabLockLogged = true;
      log(`PAUSED — another tab is running the bot (${context}). This tab stays passive.`, "warn");
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  //  HUMANIZER  (v2.12.0) — behavioural anti-detection
  // ═══════════════════════════════════════════════════════════════
  // A bot that acts continuously for hours with metronome regularity is
  // detectable regardless of per-action jitter. This layer adds the missing
  // macro-patterns: random full pauses ("coffee breaks") and a hard daily
  // attack cap for farming.
  const Humanizer = {
    _randMs(minMin, maxMin) { return (minMin + Math.random() * Math.max(0, maxMin - minMin)) * 60 * 1000; },

    isOnBreak() {
      const until = parseInt(GM_getValue("ogamex_break_until", "0")) || 0;
      return Date.now() < until;
    },
    breakLeftMin() {
      const until = parseInt(GM_getValue("ogamex_break_until", "0")) || 0;
      return until > Date.now() ? Math.ceil((until - Date.now()) / 60000) : 0;
    },

    // Called once per scheduler tick. Returns true when a break just started.
    // Never interrupts a dispatch in progress — the break waits for the next
    // tick with no pending mission.
    maybeStartBreak() {
      const h = CONFIG.humanizer;
      if (!h?.breaks) return false;
      const now = Date.now();
      let next = parseInt(GM_getValue("ogamex_next_break_at", "0")) || 0;
      if (!next) {
        GM_setValue("ogamex_next_break_at", String(now + this._randMs(h.breakEveryMin, h.breakEveryMax)));
        return false;
      }
      if (now < next) return false;
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") return false; // finish the send first
      const lenMs = this._randMs(h.breakLenMin, h.breakLenMax);
      GM_setValue("ogamex_break_until", String(now + lenMs));
      GM_setValue("ogamex_next_break_at", String(now + lenMs + this._randMs(h.breakEveryMin, h.breakEveryMax)));
      log(`Coffee break — pausing ALL bot activity for ~${Math.round(lenMs / 60000)}min (human pacing).`, "delay");
      return true;
    },

    attacksToday() {
      try {
        const d = JSON.parse(GM_getValue("ogamex_attacks_today", "null"));
        const today = new Date().toISOString().slice(0, 10);
        return d?.date === today ? (d.count || 0) : 0;
      } catch { return 0; }
    },
    recordAttack() {
      const today = new Date().toISOString().slice(0, 10);
      const c = this.attacksToday() + 1;
      GM_setValue("ogamex_attacks_today", JSON.stringify({ date: today, count: c }));
      return c;
    },
    attackLimitReached() {
      const lim = CONFIG.humanizer?.maxAttacksPerDay || 0;
      return lim > 0 && this.attacksToday() >= lim;
    },
  };

  // v2.10.25: the last-sent duplicate stamp lives in BOTH GM storage (survives
  // browser restart, per-universe prefixed) and localStorage (synchronous
  // across tabs — GM propagates async between tabs, which is how the stamps
  // raced). Read = newest of the two; write = both.
  function readLastSent() {
    let a = null, b = null;
    try { a = JSON.parse(GM_getValue("ogamex_last_sent_target", "null")); } catch {}
    try { b = JSON.parse(localStorage.getItem("ogx_last_sent_target") || "null"); } catch {}
    if (a && b) return (a.at || 0) >= (b.at || 0) ? a : b;
    return a || b;
  }
  function writeLastSent(v) {
    const s = v ? JSON.stringify(v) : "null";
    GM_setValue("ogamex_last_sent_target", s);
    try {
      if (v) localStorage.setItem("ogx_last_sent_target", s);
      else localStorage.removeItem("ogx_last_sent_target");
    } catch {}
  }

  // v2.10.25: server-truth duplicate check — storage guards are blind across
  // browsers/machines and race across tabs; the game's own event list is the
  // ground truth for "is a fleet already flying to these coords". Checks the
  // current page's embedded events first (instant), then fetches a fresh event
  // list. Fail-open: any fetch problem returns null (the storage guards still
  // apply). NOTE: return flights FROM those coords also match — conservative,
  // blocks a same-coords respawn only while a fleet is still on the books.
  async function fleetAlreadyFlyingTo(coord, { skipDom = false } = {}) {
    if (!coord) return null;
    // 3-part coord ("g:s:z", v2.11.0) is used verbatim; legacy 2-part coords
    // came only from asteroid URLs, whose position is always 17.
    const needle = coord.split(":").length === 3 ? `[${coord}]` : `[${coord}:17]`;
    // skipDom: at fleet-form step 3 the page may render the CHOSEN target as
    // text — matching our own about-to-be-sent target would block every send.
    // The pre-click recheck therefore uses only the fresh server fetch.
    if (!skipDom) try {
      // MUST exclude the bot's own panel: the persisted log contains lines
      // like "ASTEROID at [3:373:17]!" — matching them would block every send.
      const pageText = Array.from(document.body.children)
        .filter(el => el.id !== "ogx-bot-panel")
        .map(el => el.textContent || "")
        .join(" ");
      if (pageText.includes(needle)) return "page-events";
    } catch {}
    for (const url of ["/ajax/fleet/eventlist", "/ajax/fleet/eventbox"]) {
      try {
        const res = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
        if (!res.ok) continue;
        const txt = await res.text();
        if (txt.includes(needle)) return url;
      } catch {}
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  ASTEROID YIELD TRACKER  (v2.10.0)
  // ═══════════════════════════════════════════════════════════════
  // Decides how many miners a single mission needs, instead of always
  // sending 100%. Two learned inputs:
  //
  //   • cargoPerMiner  — capacity of ONE asteroid miner. Learned from the
  //                      fleet confirmation page (total cargo shown there ÷
  //                      miners selected). Overridable via config.cargoPerMiner.
  //   • expectedResources — typical resources on an asteroid. Learned from the
  //                      "resources found" mission reports (AsteroidYieldTracker
  //                      .recordYield). We size against a high percentile of the
  //                      sample window so above-average asteroids aren't
  //                      under-served. Overridable via config.expectedResourcesPerAsteroid.
  //
  //   minersNeeded = clamp(ceil(expectedResources / cargoPerMiner × buffer),
  //                        minMinersPerMission, ∞)
  //
  // If either input is unknown we return CONFIG.minersPerMission (0 = all),
  // i.e. exactly the legacy behaviour until enough has been learned.
  const AsteroidYieldTracker = {
    SAMPLES_KEY: "ogamex_yield_samples",   // [{res, at}] resources-found reports
    CARGO_KEY: "ogamex_cargo_per_miner",   // learned cargo capacity of one miner
    SEEN_REPORTS_KEY: "ogamex_seen_reports", // dedupe report ids already counted

    _loadSamples() {
      try { return JSON.parse(GM_getValue(this.SAMPLES_KEY, "[]")); } catch { return []; }
    },

    // Record one "resources found" mission yield (sum of metal+crystal+deut).
    recordYield(resources) {
      if (!Number.isFinite(resources) || resources <= 0) return;
      const max = CONFIG.asteroidMining.yieldSampleSize || 20;
      const samples = this._loadSamples();
      samples.push({ res: Math.round(resources), at: Date.now() });
      while (samples.length > max) samples.shift();
      GM_setValue(this.SAMPLES_KEY, JSON.stringify(samples));
      log(`Yield sample recorded: ${Math.round(resources).toLocaleString()} (n=${samples.length}, est now ${this.expectedResources().toLocaleString()})`, "asteroid");
    },

    // Learn cargo-per-miner from the fleet confirmation page.
    recordCargoPerMiner(totalCargo, minersSelected) {
      if (!Number.isFinite(totalCargo) || totalCargo <= 0) return;
      if (!Number.isFinite(minersSelected) || minersSelected <= 0) return;
      const per = Math.round(totalCargo / minersSelected);
      if (per <= 0) return;
      GM_setValue(this.CARGO_KEY, String(per));
      log(`Learned cargo/miner: ${per.toLocaleString()} (total ${totalCargo.toLocaleString()} ÷ ${minersSelected} miners)`, "fleet");
    },

    cargoPerMiner() {
      const cfg = CONFIG.asteroidMining.cargoPerMiner || 0;
      if (cfg > 0) return cfg;
      // v2.54.0: check-target nie istnieje na tym serwerze (404), więc jedynym
      // źródłem zostaje wartość uczona z raportów — i ona się zgadza: log
      // wielokrotnie potwierdził 20 750 na minera.
      return parseInt(GM_getValue(this.CARGO_KEY, "0")) || 0;
    },

    // High-percentile of the rolling sample window (fallback to config seed).
    expectedResources() {
      const cfg = CONFIG.asteroidMining.expectedResourcesPerAsteroid || 0;
      const samples = this._loadSamples().map(s => s.res).filter(n => n > 0).sort((a, b) => a - b);
      if (samples.length === 0) return cfg; // nothing learned yet → seed (or 0)
      const p = Math.min(100, Math.max(1, CONFIG.asteroidMining.estimatePercentile || 85));
      const idx = Math.min(samples.length - 1, Math.floor((p / 100) * samples.length));
      const learned = samples[idx];
      return Math.max(learned, cfg); // never below an explicit manual seed
    },

    // How many miners to send on ONE flight. 0 = send all available.
    // Priority:
    //   1. Explicit "miners per flight" (minersPerMission > 0) — manual control wins.
    //   2. Auto right-sizing from cargo + expected resources (if both known).
    //   3. 0 → send all (until anything is configured/learned).
    minersNeeded() {
      const am = CONFIG.asteroidMining;
      if ((am.minersPerMission || 0) > 0) return am.minersPerMission; // explicit per-flight cap wins
      const cargo = this.cargoPerMiner();
      const est = this.expectedResources();
      if (cargo > 0 && est > 0) {
        const buf = am.bufferFactor || 1.15;
        const n = Math.ceil((est / cargo) * buf);
        return Math.max(am.minMinersPerMission || 1, n);
      }
      return 0; // send all
    },

    // ── Engine A: parse asteroid mining reports to learn expectedResources ──
    // ⚠️ SELECTORS UNVERIFIED on live OGameX. This runs only on message-like
    // pages, is fully wrapped in try/catch, and never throws into the main
    // flow. When it sees candidate report markup it dumps the raw HTML to the
    // log so the exact selectors can be confirmed, then tightened. Until
    // verified, set config.expectedResourcesPerAsteroid manually to enable
    // right-sizing immediately.
    // v2.10.27: `root` lets the same parser run on the live page (default) or
    // on a fetched-and-DOMParsed messages document (fetchReportsPeriodic).
    scanReports(root = document, sourceLabel = "page") {
      if (!CONFIG.asteroidMining.learnFromReports) return;
      try {
        if (root === document) {
          const path = location.pathname.toLowerCase();
          const looksLikeMessages = /message|communication|report|nachricht|wiadomo/.test(path) ||
            /Asteroid\s*Mining/i.test(document.body.textContent || "");
          if (!looksLikeMessages) return;
        }

        // Candidate report containers — try a few common message selectors.
        let containers = Array.from(root.querySelectorAll(
          ".message, .msg, .messageContent, [data-message-id], .message_item, li.message, .communication-item"
        ));
        // v2.19.0: class names differ per OGameX build and guessing them is
        // what left this parser blind. Fall back to structure-agnostic
        // scanning: the INNERMOST elements that mention an asteroid are the
        // report bodies, whatever they happen to be wrapped in. Extraction
        // below is text-based anyway, so a container only has to be small and
        // not contain another report.
        if (containers.length === 0) {
          // A report body is the smallest element holding BOTH the asteroid
          // keyword and an outcome (resources, dark matter or "empty"). Keying
          // on "asteroid" alone picks the heading span, which carries no
          // numbers — so require both, then take the innermost such element.
          const isReport = (t) =>
            /asteroid/i.test(t) &&
            /(metal|crystal|kristall|kryszta|deuterium|deuter|dark\s*matter|ciemna\s*materia|empty|nothing found|nichts|pusto|brak)/i.test(t);
          containers = Array.from(root.querySelectorAll("*")).filter(el => {
            const t = el.textContent || "";
            if (!t || t.length > 3000 || !isReport(t)) return false;
            return !Array.from(el.children).some(ch => isReport(ch.textContent || ""));
          });
          if (containers.length) {
            // v2.49.1: ta linia leciała przy KAŻDYM wejściu na dowolną stronę
            // i zalewała log. Treść się nie zmienia, więc raz na 10 minut
            // wystarczy, żeby wiedzieć, że silnik strony nadal nie rozumie
            // markupu tego serwera.
            {
              const k = "ogamex_yield_unknown_logged_at";
              const lastNote = parseInt(GM_getValue(k, "0")) || 0;
              if (Date.now() - lastNote > 10 * 60 * 1000) {
                GM_setValue(k, String(Date.now()));
                log(`Yield fetch (${sourceLabel}): unknown message markup — generic block scan found ${containers.length} candidate(s).`, "info");
              }
            }
          }
        }
        if (containers.length === 0) {
          if (root !== document) {
            log(`Yield fetch (${sourceLabel}): no known message markup — selectors need tuning for this OGameX build.`, "warn");
            // v2.16.1: stop repeating that warning forever and DUMP the page
            // instead. Without report parsing the bot is blind to what
            // expeditions and asteroids actually bring back — which is exactly
            // the number needed to decide whether bigger waves still pay off.
            // Same one-shot trick that gave us the expedition link (mission=1,
            // not the 15 everyone would assume).
            if (GM_getValue("ogamex_messages_markup_dumped_v219", "") !== "1") {
              GM_setValue("ogamex_messages_markup_dumped_v219", "1");
              const html = (root.body?.innerHTML || root.documentElement?.innerHTML || "")
                .replace(/<script[\s\S]*?<\/script>/gi, "")
                .replace(/\s+/g, " ")
                .trim();
              log(`[MSG DOM] ${sourceLabel} (${html.length}ch): ${html.slice(0, 1800)}`, "info");
            }
          }
          return;
        }

        const seen = new Set(JSON.parse(GM_getValue(this.SEEN_REPORTS_KEY, "[]")));
        let learned = 0, dumped = 0, capped = 0;

        containers.forEach((c, i) => {
          const text = (c.textContent || "").replace(/\s+/g, " ").trim();
          if (!/asteroid/i.test(text)) return; // only asteroid mining reports

          // Stable-ish id for dedupe: explicit id attr, else a hash of the text.
          const id = c.getAttribute("data-message-id") || c.id ||
            ("h" + Math.abs([...text].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7)));
          if (seen.has(id)) return;

          // Outcome detection. Empty / dark matter / container ⇒ 0 resources,
          // but still mark seen so we don't reprocess. Resources ⇒ sum them.
          const isEmpty = /(empty|nothing found|nichts|pusto|brak)/i.test(text);
          const isDM = /dark\s*matter|dunkle\s*materie|ciemna\s*materia/i.test(text);
          let resources = 0;
          if (!isEmpty && !isDM) {
            // ── v2.23.0: read the heading, not the word "Metal" ──
            // This build labels every amount with an ICON, so the only words in
            // the report are the headings: "Resources found", "Fuel
            // consumption", "Total profit (Metal)". The label regex below
            // therefore matched exactly one thing — the "Metal" inside "Total
            // profit" — and learned profit-AFTER-FUEL as the asteroid's
            // content (4 084 467 657 139 instead of 4 150 000 000 000 on the
            // owner's report). Anchor on the heading and sum what follows it.
            const nums = [];
            const seg = text.match(/resources?\s*found([\s\S]{0,120}?)(?:fuel\s*consumption|total\s*profit|mission\s*date|$)/i);
            if (seg && seg[1]) {
              // No \s in the class: "4.150.000.000.000 0" is TWO amounts
              // (metal and crystal), and letting a space join them produced
              // 41 500 000 000 000 — a tenfold over-estimate from one stray zero.
              for (const g of seg[1].match(/\d[\d.,]*/g) || []) {
                const v = parseInt(g.replace(/[^\d]/g, ""), 10);
                if (Number.isFinite(v) && v > 0) nums.push(v);
              }
            }
            // Fallback for builds that DO write the resource names out.
            if (nums.length === 0) {
              const re = /(?:metal|crystal|kristall|kryszta|deuterium|deuter)\D{0,12}?([\d.,\s]{2,})/gi;
              let m;
              while ((m = re.exec(text)) !== null) {
                const v = parseInt((m[1] || "").replace(/[^\d]/g, ""), 10);
                if (Number.isFinite(v) && v > 0) nums.push(v);
              }
            }
            resources = nums.reduce((a, b) => a + b, 0);

            // ── The haul is capped by the fleet's TOTAL cargo ──
            // When "resources found" equals the capacity of the miners that
            // flew, the number is a FLOOR, not the asteroid's content: the
            // rest stayed in the ground. Learning it as "expected" is how a
            // small fleet teaches itself to stay small. Flag it loudly; the
            // sample is kept but marked, so the estimate can't be trusted as
            // an upper bound.
            const minersM = text.match(/asteroid\s*miner\D{0,12}?([\d][\d.,\s]*)/i);
            const minersSent = minersM ? parseInt(minersM[1].replace(/[^\d]/g, ""), 10) : 0;
            const cargo = this.cargoPerMiner();
            if (resources > 0 && minersSent > 0 && cargo > 0) {
              const capacity = minersSent * cargo;
              if (resources >= capacity * 0.98) {
                capped++;
                log(`[YIELD] limit ładowności: ${minersSent.toLocaleString()} minerów uniosło ${resources.toLocaleString()} = pełna ładowność ${capacity.toLocaleString()}. Asteroida miała WIĘCEJ — reszta została w ziemi.`, "warn");
              }
            }
            // Diagnostics: if it's clearly an asteroid resources report but we
            // parsed nothing, dump it so selectors/regex can be fixed.
            if (resources === 0 && dumped < 3) {
              log(`[REPORT?] asteroid report, 0 parsed — verify markup: ${text.substring(0, 240)}`, "warn");
              dumped++;
            }
          }

          seen.add(id);
          if (resources > 0) { this.recordYield(resources); learned++; }
        });

        if (learned > 0 || seen.size) {
          GM_setValue(this.SEEN_REPORTS_KEY, JSON.stringify([...seen].slice(-300)));
        }
        if (learned > 0) log(`Parsed ${learned} new asteroid report(s) for yield learning (${sourceLabel})${capped ? ` — ${capped} z nich uderzyło w limit ładowności, więc szacunek asteroidy jest zaniżony` : ""}`, "asteroid");
      } catch (err) {
        log(`Report scan error (non-fatal): ${err.message}`, "warn");
      }
    },

    // ── Engine B (v2.10.27): FETCH the messages page periodically ──
    // Root cause of "est: ?": Engine A only parses reports when the browser is
    // ON a messages page — and the bot never navigates there, so it never
    // learned anything. Leader-only (called from the gated scheduler tick),
    // every 30min, fail-open. Endpoint guessed from OGameX's route shape; the
    // no-markup warning above tells us if the selectors/URL need tuning.
    FETCH_EVERY_MS: 30 * 60 * 1000,
    async fetchReportsPeriodic() {
      if (!CONFIG.asteroidMining.learnFromReports) return;
      const last = parseInt(GM_getValue("ogamex_yield_fetch_at", "0")) || 0;
      if (Date.now() - last < this.FETCH_EVERY_MS) return;
      GM_setValue("ogamex_yield_fetch_at", String(Date.now()));
      // v2.41.0: właściwy endpoint zakładki wiadomości (MessagesController@
      // ajaxGetTabContents): /ajax/messages?tab=fleets&pagination=1. Raporty
      // z ekspedycji i wypraw górniczych siedzą w zakładce „fleets"; wcześniej
      // bot pobierał gołe /messages i lądował na „unknown message markup".
      // ── v2.49.0: właściwe adresy raportów, złapane przez ApiSniffer ──
      // Ten serwer to aplikacja .NET z własnym API wiadomości. Gra sama
      // odpytuje je przy otwieraniu zakładek:
      //   /messages/messagedata?MessageCategoryType=FLEET_OTHER&page=1
      //   /messages/messagedata?MessageCategoryType=FLEET_EXPEDITION&page=1
      // FLEET_OTHER niesie raporty z wypraw górniczych („Resources found"),
      // FLEET_EXPEDITION — łupy z ekspedycji. Do tej pory bot pobierał gołe
      // /messages i kończył na „unknown message markup", więc ładowność minera
      // i spodziewany urobek uczyły się wyłącznie z przypadkowych wejść na
      // stronę wiadomości. Dodatkowo /home/Partial_AsteroidJournal to gotowy
      // dziennik wypraw — jeśli odpowie, jest najlepszym źródłem.
      for (const url of [
        "/home/Partial_AsteroidJournal",
        "/messages/messagedata?MessageCategoryType=FLEET_OTHER&page=1",
        "/messages/messagedata?MessageCategoryType=FLEET_EXPEDITION&page=1",
        "/messages",
      ]) {
        if (!Ajax.supported(url)) continue;
        try {
          const res = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          if (!res.ok) { Ajax.markUnsupported(url, res.status); continue; }
          const html = await res.text();
          if (res.redirected || /login|password/i.test(html.substring(0, 500))) continue; // session page, not messages
          // v2.49.0: pierwszy raz z każdego źródła zrzuć próbkę — bez niej nie
          // da się napisać parsera pod markup TEGO serwera, a zgadywanie już raz
          // kosztowało pięć wersji.
          const dumpKey = `ogamex_dump_${url.replace(/\W+/g, "_").slice(0, 60)}`;
          if (GM_getValue(dumpKey, "") !== "1") {
            GM_setValue(dumpKey, "1");
            log(`[RAPORTY] ${url} → ${html.length} zn.: ${html.replace(/\s+/g, " ").slice(0, 1200)}`, "info");
          }
          const doc = new DOMParser().parseFromString(html, "text/html");
          this.scanReports(doc, url);
          return; // pierwsze źródło, które odpowiedziało, wystarczy
        } catch {}
      }
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  FLEET DISPATCHER: Navigate fleet send pages
  // ═══════════════════════════════════════════════════════════════

  const FleetDispatcher = {
    // Navigate to fleet page for a specific planet
    async goToFleet(planet) {
      // OGameX fleet URL format: /fleet?x=galaxy&y=system&z=position
      // (confirmed from galaxy view: /fleet?x=6&y=476&z=16&mission=1)
      const url = `/fleet?x=${planet.galaxy}&y=${planet.system}&z=${planet.position}`;
      log(`Navigating to fleet: ${planet.name} [${planet.galaxy}:${planet.system}:${planet.position}]`);
      window.location.href = url;
      // Page will reload — pending_mission flow handles next steps
    },

    // Step 1: Select ships on fleet page and click Next
    async selectShipsAndNext(shipType, quantity) {
      if (GameState.getCurrentPage() !== "fleet") {
        log("Not on fleet page, cannot select ships", "error");
        return false;
      }

      // Find the ship input
      const shipItems = document.querySelectorAll(".ship-item, [data-ship-type]");
      for (const item of shipItems) {
        if (item.dataset?.shipType === shipType) {
          const input = item.querySelector('input[type="text"], input.numberFormatInput');
          if (input) {
            const available = parseInt(item.dataset?.shipQuantity || "0");
            const toSend = quantity === 0 ? available : Math.min(quantity, available);
            input.value = toSend;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            input.dispatchEvent(new Event("input", { bubbles: true }));
            log(`Selected ${toSend} ${shipType}`, "fleet");

            await AntiDetection.shortDelay();

            // Click Next button
            const nextBtn = document.querySelector('a.next, button.next, [class*="next"]');
            if (nextBtn) {
              nextBtn.click();
              return true;
            }
          }
        }
      }

      log(`Could not find ship ${shipType} on fleet page`, "error");
      return false;
    },

    // Step 2: Set coordinates and click Next
    async setTargetAndNext(galaxy, system, position) {
      await AntiDetection.shortDelay();

      // Set coordinate fields
      const galaxyInput = document.querySelector('input[name="galaxy"], input#galaxy');
      const systemInput = document.querySelector('input[name="system"], input#system');
      const positionInput = document.querySelector('input[name="position"], input#position');

      if (!galaxyInput || !systemInput || !positionInput) {
        // Try alternative selectors
        const inputs = document.querySelectorAll('.coords input, input[type="text"]');
        if (inputs.length >= 3) {
          inputs[0].value = galaxy;
          inputs[1].value = system;
          inputs[2].value = position;
        } else {
          log("Cannot find coordinate inputs", "error");
          return false;
        }
      } else {
        galaxyInput.value = galaxy;
        systemInput.value = system;
        positionInput.value = position;
      }

      // Trigger change events
      document.querySelectorAll('input').forEach(i => i.dispatchEvent(new Event("change", { bubbles: true })));

      log(`Set target: [${galaxy}:${system}:${position}]`, "fleet");

      await AntiDetection.shortDelay();

      // Click Next
      const nextBtn = document.querySelector('a.next, button.next, [class*="next"], input[value="Next"]');
      if (nextBtn) {
        nextBtn.click();
        return true;
      }

      log("Cannot find Next button on target page", "error");
      return false;
    },

    // Step 3: Select mission and send fleet
    async selectMissionAndSend(missionId) {
      await AntiDetection.shortDelay();

      // Try clicking mission icon/button
      const missionBtns = document.querySelectorAll('[data-mission], .mission-select a, [class*="mission"]');
      for (const btn of missionBtns) {
        if (btn.dataset?.mission === String(missionId) || btn.href?.includes(`mission=${missionId}`)) {
          btn.click();
          log(`Selected mission type ${missionId}`, "fleet");
          break;
        }
      }

      await AntiDetection.shortDelay();

      // Click Send Fleet button
      const sendBtn = document.querySelector('a.send, button.send, [class*="send-fleet"], input[value*="Send"]');
      if (sendBtn) {
        sendBtn.click();
        log("Fleet sent!", "fleet");
        return true;
      }

      // Try finding by text content
      const allBtns = document.querySelectorAll("a, button, input[type='submit']");
      for (const btn of allBtns) {
        if (btn.textContent?.includes("Send fleet") || btn.value?.includes("Send fleet")) {
          btn.click();
          log("Fleet sent!", "fleet");
          return true;
        }
      }

      log("Cannot find Send Fleet button", "error");
      return false;
    },
  };

  // v2.12.4: every "queue exhausted" exit must land in a cooldown. Several
  // exits used to just clear ScanState, letting the very next tick start a
  // brand-new scan of the SAME still-advertised range — observed live:
  // dispatch to the only asteroid of a single range emptied the queue
  // (pruneFoundRange skips the range remainder), the off-galaxy un-wedge
  // path cleared the state, and the bot re-swept [3:36-56] seconds after
  // finishing it, re-detecting the asteroid it had just dispatched to.
  // Shared quiet exit: clear + short recheck cooldown. Deliberately NO range
  // AJAX here — these exits fire right after a fleet send / dispatch failure
  // or from arbitrary pages, where an extra fetch burst is bot-tell traffic;
  // the post-cooldown startNewScan does the deep fetch anyway.
  function endSweepWithCooldown(reason) {
    ScanState.clear();
    GM_setValue("ogamex_scan_cooldown_until", String(Date.now() + ACTIVE_RANGE_RECHECK_MIN * 60 * 1000));
    log(`${reason} — next range check in ${ACTIVE_RANGE_RECHECK_MIN}min.`, "asteroid");
  }

  // ═══════════════════════════════════════════════════════════════
  //  ASTEROID MINER: Main asteroid mining logic
  // ═══════════════════════════════════════════════════════════════

  const AsteroidMiner = {
    running: false,

    // ── Main entry: called on every page load and scheduler tick ──
    async run() {
      if (!CONFIG.asteroidMining.enabled || !CONFIG.enabled) return;
      if (Humanizer.isOnBreak()) return; // v2.12.0: also covers init on-load hooks
      if (AntiDetection.isSleepTime()) {
        log("Sleep time - asteroid mining paused", "delay");
        return;
      }
      if (this.running) return;
      this.running = true;

      try {
        // ── Check if we're on galaxy page during an active scan ──
        const scanState = ScanState.load();
        if (scanState?.active && GameState.getCurrentPage() === "galaxy") {
          await this.handleGalaxyScanStep(scanState);
          return;
        }

        // ── Check if scan found an asteroid → dispatch ──
        if (scanState?.foundAsteroid) {
          await this.dispatchToFoundAsteroid(scanState);
          return;
        }

        // ── Active scan but not on galaxy page (e.g. fleet dispatch completed) ──
        // Navigate back to galaxy to continue scan, unless miners are still in flight.
        if (scanState?.active && GameState.getCurrentPage() !== "galaxy") {
          const fleetReturnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
          if (fleetReturnAt && Date.now() < fleetReturnAt) {
            const waitMin = Math.ceil((fleetReturnAt - Date.now()) / 60000);
            log(`Scan paused — miners in flight (~${waitMin}min). Will resume on return.`, "delay");
            return;
          }
          // Fleet returned (or no timer) — navigate to galaxy and continue scan
          const remaining = scanState.queue || [];
          if (remaining.length > 0) {
            const next = remaining[0];
            log(`Fleet returned. Resuming scan at [${next.galaxy}:${next.system}] — ${remaining.length} systems left.`, "asteroid");
            await AntiDetection.shortDelay();
            scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "scan resume");
          } else {
            log("Scan complete — no systems left in queue. Starting fresh.", "asteroid");
            ScanState.clear();
          }
          return;
        }

        // ── No active scan → start new one if no scan running ──
        if (!scanState?.active) {
          // Check if miners are still in flight — wait for return before scanning
          const fleetReturnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
          if (fleetReturnAt && Date.now() < fleetReturnAt) {
            // Verify fleet is actually still in flight (page may show "No fleet movement")
            const noFleet = /No fleet movement/i.test(document.body.textContent);
            if (noFleet) {
              log("Timer says in flight but page shows no fleet movement. Resetting.", "asteroid");
              GM_setValue("ogamex_fleet_return_at", "0");
            } else {
              const waitMin = Math.ceil((fleetReturnAt - Date.now()) / 60000);
              log(`Miners in flight, ~${waitMin}min until return (${new Date(fleetReturnAt).toLocaleTimeString("pl-PL")})`, "delay");
              return;
            }
          }
          if (fleetReturnAt) {
            GM_setValue("ogamex_fleet_return_at", "0");
            log("Fleet returned! Starting new scan.", "asteroid");
          }
          // Check dispatch cooldown — don't rescan immediately after failed dispatch
          const lastFail = parseInt(GM_getValue("ogamex_dispatch_fail_at", "0"));
          if (lastFail && Date.now() - lastFail < 10 * 60 * 1000) {
            const waitMin = Math.ceil((10 * 60 * 1000 - (Date.now() - lastFail)) / 60000);
            log(`Dispatch cooldown: ${waitMin}min remaining (last dispatch failed)`, "delay");
            return;
          }
          if (!RateLimiter.canAct()) {
            log(`Rate limit reached. Waiting...`, "delay");
            return;
          }
          // Check nav rate limiter — don't start a scan if we'd immediately hit the cap
          const navPauseUntil = parseInt(GM_getValue("ogamex_nav_pause_until", "0"));
          if (navPauseUntil && Date.now() < navPauseUntil) {
            const waitMin = Math.ceil((navPauseUntil - Date.now()) / 60000);
            log(`Nav rate limit pause: ${waitMin}min remaining (${NavRateLimiter.count()}/${NavRateLimiter.maxPerHour} used)`, "delay");
            return;
          }
          if (navPauseUntil) GM_setValue("ogamex_nav_pause_until", "0");
          // Check scan cooldown — don't rescan immediately after full scan found nothing
          const scanCooldownUntil = parseInt(GM_getValue("ogamex_scan_cooldown_until", "0"));
          if (scanCooldownUntil && Date.now() < scanCooldownUntil) {
            // ── v2.27.0: the cooldown must not outlive its own reason ──
            // It is set when the hint pool comes back empty, and then held for
            // ten minutes no matter what. Owner's log, 22:46-22:56: hints were
            // empty at 22:46, a manual scan found FIVE ranges at 22:53:42 — and
            // the bot still answered "Scan cooldown: 3min remaining (no
            // asteroids last sweep)". Ten minutes of blindness on the biggest
            // income source, with the answer already on screen.
            // A probe is ONE ajax call, against six for a deep fetch, so
            // re-checking every 2min costs a fraction of a sweep and cuts the
            // worst case from 10 minutes to about 2.
            const lastProbe = parseInt(GM_getValue("ogamex_hint_probe_at", "0")) || 0;
            if (Date.now() - lastProbe >= HINT_PROBE_EVERY_MS) {
              GM_setValue("ogamex_hint_probe_at", String(Date.now()));
              const probe = await AsteroidScanner.scanRanges(false).catch(() => null);
              if (probe && probe.length) {
                log(`Cooldown przerwany: pojawiło się ${probe.length} przedział(ów) podpowiedzi — skanuję OD RAZU zamiast czekać.`, "asteroid");
                GM_setValue("ogamex_scan_cooldown_until", "0");
                await this.startNewScan();
                return;
              }
            }
            const waitMin = Math.ceil((scanCooldownUntil - Date.now()) / 60000);
            log(`Scan cooldown: ${waitMin}min remaining (no asteroids last sweep)`, "delay");
            return;
          }
          if (scanCooldownUntil) GM_setValue("ogamex_scan_cooldown_until", "0");
          await this.startNewScan();
        }
      } catch (err) {
        log(`Asteroid mining error: ${err.message}`, "error");
      } finally {
        this.running = false;
        updateStatusUI();
      }
    },

    // ── Start new scan: fetch ranges → build queue → navigate to first system ──
    async startNewScan() {
      log("Starting asteroid scan...", "asteroid");
      updateStatusUI();

      // v2.9.6: Clear stale scan state UPFRONT so concurrent scheduler ticks
      // can't pick up the old state during the ~10s scanRangesFull() fetch
      // and resume the old queue mid-flight. Without this, a manual "Scan
      // Asteroids" click would start fetching new ranges, but a tick firing
      // during the fetch would see the previous scanState (still active),
      // call handleGalaxyScanStep, and continue the OLD scan from wherever
      // it was — bypassing the fresh closest-first ordering we're trying to
      // produce. Symptom: scan "starts in the middle" after a re-enable.
      ScanState.clear();

      // NOTE: Do NOT clear DispatchedAsteroids here. Its own 1h TTL handles
      // expiry. Clearing on every scan caused double-dispatch when a new scan
      // started within the window (e.g. after a quick no-asteroid scan).

      // Deep fetch — scanRangesFull() does N calls because the AJAX endpoint
      // returns a random subset per call.
      const ranges = await AsteroidScanner.scanRangesFull(6);
      GM_setValue("ogamex_last_deep_fetch_at", String(Date.now()));

      if (ranges.length === 0) {
        // v2.10.10: short cooldown instead of retrying every tick. When the
        // hint pool is genuinely empty, polling 3 AJAX calls per minute is
        // bot-tell traffic for zero gain — a 10min re-check still picks up
        // new ranges promptly.
        log(`Deep fetch returned no ranges — no asteroid hints right now. Re-check in 10min.`, "asteroid");
        GM_setValue("ogamex_scan_cooldown_until", String(Date.now() + 10 * 60 * 1000));
        return;
      }
      log(`Collected ${ranges.length} unique ranges from deep fetch`, "asteroid");

      // Miners launch from a single fixed base planet
      const base = CONFIG.asteroidMining.minerBase;
      if (!base) {
        log("No minerBase configured — dispatch will fail until one is set", "warn");
      }
      const maxFlight = CONFIG.asteroidMining.maxFlightMinutes;

      // Build scan queue — all systems in all ranges, closest to base first
      const queue = AsteroidScanner.buildScanQueue(ranges, base, maxFlight);
      if (queue.length === 0) {
        const stats = AsteroidScanner.lastQueueStats || {};
        if (stats.fleetExcluded > 0 && stats.fleetExcluded === stats.totalRanges) {
          // v2.12.8: NOT an error — every hint range is claimed by a miner
          // fleet already en route. Nothing new can appear in those ranges
          // until a fleet arrives (entries release at arrival), so back off
          // like the no-hints path instead of red-flagging a healthy state.
          log(`All ${stats.totalRanges} hint range(s) already claimed by en-route miner fleets — nothing new to scan. Re-check in 10min.`, "asteroid");
          GM_setValue("ogamex_scan_cooldown_until", String(Date.now() + 10 * 60 * 1000));
        } else {
          log("Empty scan queue — no systems in returned ranges (or all beyond maxFlight)", "error");
        }
        return;
      }

      const first = queue[0];
      const formatPreview = q => {
        if (!base || q.galaxy !== base.galaxy) return `[${q.galaxy}:${q.system}]`;
        const dist = Math.abs(q.system - base.system);
        return `[${q.galaxy}:${q.system}] (Δ${dist}, ~${AsteroidScanner.estimateFlightMinutes(dist)}min)`;
      };
      const preview = queue.slice(0, 5).map(formatPreview).join(", ");
      const baseTag = base ? `from [${base.galaxy}:${base.system}:${base.position}]` : "(no base)";
      log(
        `Scan queue: ${queue.length} systems across ${ranges.length} ranges, closest-first ${baseTag}. ` +
        `First: ${preview}`,
        "asteroid"
      );

      // Save state and navigate to first system
      ScanState.start(ranges, queue);

      log(`Navigating to galaxy [${first.galaxy}:${first.system}]...`, "asteroid");
      scanNavigate(`/galaxy?x=${first.galaxy}&y=${first.system}`, "scan start");
    },

    // ── Handle one galaxy scan step (we're on galaxy page) ──
    async handleGalaxyScanStep(scanState) {
      // Wait for DOM to fully render — galaxy rows are server-rendered, so a
      // short settle is enough (v2.10.18: trimmed from 0.9-1.7s).
      await AntiDetection.sleep(500 + Math.random() * 600);

      // Check if fleet return time is set — if miners are in flight, stop scanning
      const fleetReturnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
      if (fleetReturnAt && Date.now() < fleetReturnAt) {
        const noFleet = /No fleet movement/i.test(document.body.textContent);
        if (noFleet) {
          GM_setValue("ogamex_fleet_return_at", "0");
          log("Fleet returned (no fleet movement). Continuing scan.", "asteroid");
        } else {
          const waitMin = Math.ceil((fleetReturnAt - Date.now()) / 60000);
          log(`Miners in flight (~${waitMin}min left). Scan paused — queue preserved.`, "delay");
          return;
        }
      }

      const current = scanState.queue[0];
      if (!current) {
        await this.finishSweep(scanState);
        return;
      }

      // Verify we're on the right system
      const url = window.location.href;
      const urlMatch = url.match(/[?&]y=(\d+)/);
      const currentSystem = urlMatch ? parseInt(urlMatch[1]) : -1;

      if (currentSystem !== current.system) {
        // Wrong system — navigate to correct one
        log(`Expected system ${current.system}, on ${currentSystem}. Redirecting...`, "asteroid");
        scanNavigate(`/galaxy?x=${current.galaxy}&y=${current.system}`, "wrong-system redirect");
        return;
      }

      log(`Scanning [${current.galaxy}:${current.system}]... (${scanState.scannedCount + 1}/${scanState.totalCount})`, "asteroid");
      updateStatusUI();

      // ── Per-step range verification (v2.8.8) ──
      // Empirically, a single AsteroidLocation call returns ALL active ranges
      // (deterministic snapshot — 3 consecutive calls in 4s returned identical
      // results in logs). So we do ONE cheap AJAX before every scan step:
      //   • If ranges unchanged → proceed to scan current system.
      //   • If ranges changed but current still in some range → rebuild the
      //     remainder of the queue (picks up any NEW lower/closer ranges
      //     immediately, not after 5-system delay).
      //   • If current no longer in any range → drop scannedSystems entirely
      //     and restart scan from the lowest system in the new ranges.
      // v2.10.18: throttle — re-fetching ALL ranges (an AJAX + its 2-7s
      // anti-detection sleep) on EVERY system dominated scan time for marginal
      // gain; ranges change once in many minutes, not every ~10s step. Verify
      // only every Nth system (and on the very first, scannedCount 0). A mid-scan
      // range change is caught within N systems, and the sweep-end re-fetch
      // (v2.10.13/15) covers the rest. Also anti-ban POSITIVE: ~6× fewer AJAX.
      const VERIFY_EVERY = 6;
      const freshRanges = (scanState.scannedCount % VERIFY_EVERY) === 0
        ? await AsteroidScanner.scanRanges()
        : null;
      if (freshRanges && freshRanges.length === 0) {
        log("Range verify: no active ranges — scan complete", "asteroid");
        ScanState.clear();
        return;
      }
      if (freshRanges) {
        const rangeKey = r => `${r.galaxy}:${r.startSystem}-${r.endSystem}`;
      const freshKeys = new Set(freshRanges.map(rangeKey));
      const storedKeys = new Set((scanState.ranges || []).map(rangeKey));
      const rangesChanged = freshKeys.size !== storedKeys.size
        || [...freshKeys].some(k => !storedKeys.has(k));

      if (rangesChanged) {
        const isInAnyFreshRange = (gal, sys) => freshRanges.some(r =>
          r.galaxy === gal && sys >= r.startSystem && sys <= r.endSystem
        );
        const freshLabels = freshRanges.map(r => `[${r.galaxy}:${r.startSystem}-${r.endSystem}]`).join(", ");
        const currentInAny = isInAnyFreshRange(current.galaxy, current.system);

        if (!currentInAny) {
          // Ranges shifted, current is stale — jump into the new ranges.
          // v2.12.6: KEEP the scanned-history. The old reset wiped
          // scannedSystems and rebuilt the FULL queue, so systems checked
          // minutes earlier — and even a pruned range whose asteroid already
          // had a fleet in flight — went right back into the walk (observed:
          // reset to [3:371] re-queued [3:1-41] scanned 2min before AND
          // [3:371-391] with the just-dispatched [3:385]). Filter the rebuilt
          // queue by everything this sweep already covered.
          const baseCfg = CONFIG.asteroidMining.minerBase;
          const maxFlightCfg = CONFIG.asteroidMining.maxFlightMinutes;
          const scannedSetR = new Set((scanState.scannedSystems || []).map(s => `${s.galaxy}:${s.system}`));
          const fullQueue = AsteroidScanner.buildScanQueue(freshRanges, baseCfg, maxFlightCfg)
            .filter(q => !scannedSetR.has(`${q.galaxy}:${q.system}`));
          scanState.ranges = freshRanges;
          scanState.queue = fullQueue;
          scanState.totalCount = scanState.scannedCount + fullQueue.length;
          ScanState.save(scanState);

          if (fullQueue.length === 0) {
            // Everything in the fresh ranges is already covered — that's a
            // sweep end, not a fresh start (verified cooldown, no restart).
            await this.finishSweep(scanState);
            return;
          }
          const jumpTo = fullQueue[0];
          log(`Range verify: current [${current.galaxy}:${current.system}] outside new ranges ${freshLabels} — jumping to [${jumpTo.galaxy}:${jumpTo.system}] (${fullQueue.length} unscanned systems, history kept)`, "asteroid");
          scanNavigate(`/galaxy?x=${jumpTo.galaxy}&y=${jumpTo.system}`, "range-verify reset");
          return;
        }

        // Current still valid — rebuild queue so new (often closer) ranges get
        // scanned immediately after we finish this system.
        const baseCfg = CONFIG.asteroidMining.minerBase;
        const maxFlightCfg = CONFIG.asteroidMining.maxFlightMinutes;
        const scannedSet = new Set((scanState.scannedSystems || []).map(s => `${s.galaxy}:${s.system}`));
        const freshQueue = AsteroidScanner.buildScanQueue(freshRanges, baseCfg, maxFlightCfg)
          .filter(q => !scannedSet.has(`${q.galaxy}:${q.system}`));
        const currentKey = `${current.galaxy}:${current.system}`;
        const rest = freshQueue.filter(q => `${q.galaxy}:${q.system}` !== currentKey);
        // v2.12.2: RANGE-COHERENT rebuild. freshQueue is distance-sorted, so a
        // rebuild used to hoist the CLOSEST range's unscanned systems to the
        // front — observed: scanning [3:181] → rebuild → jump to [3:346], and
        // earlier [3:416] → [3:336]. Ping-ponging 80+ systems in seconds is a
        // bot fingerprint (a human finishes the range they're browsing). Keep
        // the remaining systems of the CURRENT range first, then the rest in
        // their distance order.
        const curRange = freshRanges.find(r =>
          r.galaxy === current.galaxy && current.system >= r.startSystem && current.system <= r.endSystem);
        let orderedRest = rest;
        if (curRange) {
          const inCurrentRange = rest.filter(q =>
            q.galaxy === curRange.galaxy && q.system >= curRange.startSystem && q.system <= curRange.endSystem);
          const inSet = new Set(inCurrentRange.map(q => `${q.galaxy}:${q.system}`));
          orderedRest = [...inCurrentRange, ...rest.filter(q => !inSet.has(`${q.galaxy}:${q.system}`))];
        }
        scanState.ranges = freshRanges;
        scanState.queue = [current, ...orderedRest];
        scanState.totalCount = scanState.scannedCount + scanState.queue.length;
        ScanState.save(scanState);
        log(`Range verify: ranges changed to ${freshLabels} — queue rebuilt (${scanState.queue.length} systems, current [${current.galaxy}:${current.system}] kept)`, "asteroid");
        }
      }

      // Check position 17 in live DOM
      const result = AsteroidScanner.checkCurrentPageForAsteroid();

      if (result.found) {
        // Skip if already dispatched to this asteroid
        if (DispatchedAsteroids.has(current.galaxy, current.system)) {
          log(`Asteroid [${current.galaxy}:${current.system}:17] already dispatched, skipping`, "asteroid");
          ScanState.advance(scanState);
          const next = scanState.queue[0];
          if (next) {
            const scanDelay = humanScanDelayMs();
            await AntiDetection.sleep(scanDelay);
            scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "skip-dispatched next");
          } else {
            await this.finishSweep(scanState); // v2.12.4: sweep end → verified cooldown, not instant restart
          }
          return;
        }

        // Asteroid found!
        log(`ASTEROID at [${current.galaxy}:${current.system}:17]!`, "success");

        // v2.9.3: TTL vs flight-time check — if asteroid would vanish
        // before fleet arrives, DO NOT dispatch (burns deuter on a doomed
        // mission). v2.9.5: bumped buffer 60s→300s after a real-world
        // burn where v2.9.3 estimated 7min for Δ=58 but actual was 15min.
        // 5min margin absorbs formula error + ~30s dispatch UI overhead
        // + TTL countdown elapsed during the 3-step fleet flow.
        const baseForCheck = CONFIG.asteroidMining.minerBase;
        if (result.ttlSeconds != null && baseForCheck) {
          const sameGal = baseForCheck.galaxy === current.galaxy;
          const dist = sameGal ? Math.abs(baseForCheck.system - current.system) : Infinity;
          const estMin = sameGal ? AsteroidScanner.estimateFlightMinutes(dist) : Infinity;
          const estSec = estMin * 60;
          const ARRIVAL_BUFFER_SEC = 300;
          if (!Number.isFinite(estSec) || estSec + ARRIVAL_BUFFER_SEC > result.ttlSeconds) {
            log(
              `SKIP [${current.galaxy}:${current.system}:17] — flight ~${estMin}min (${estSec}s) ` +
              `+ ${ARRIVAL_BUFFER_SEC}s buffer > TTL ${result.ttlSeconds}s. Would vanish before arrival.`,
              "warn"
            );
            // v2.9.6: Do NOT add to DispatchedAsteroids on a TTL skip. A
            // short-TTL skip means we missed THIS asteroid instance — but the
            // game spawns a fresh asteroid in the same range slot every
            // ~5-15min, often at the same coords. Blocking the system for 1h
            // means we miss N consecutive replacement asteroids with longer
            // TTLs. DispatchedAsteroids is for double-dispatch prevention on
            // an in-flight fleet; a no-op skip never sent a fleet.
            ScanState.advance(scanState);
            const next = scanState.queue[0];
            if (next) {
              await AntiDetection.sleep(humanScanDelayMs());
              scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "skip-far-asteroid next");
            } else {
              await this.finishSweep(scanState); // v2.12.4: sweep end → verified cooldown, not instant restart
            }
            return;
          }
          log(`OK to dispatch: flight ~${estMin}min (${estSec}s) < TTL ${result.ttlSeconds}s`, "asteroid");
        }

        DispatchedAsteroids.add(current.galaxy, current.system);

        if (result.fleetUrl) {
          // Direct fleet URL available — navigate to fleet page
          log(`Direct dispatch via: ${result.fleetUrl}`, "asteroid");
          // Advance scan state (don't clear) so after dispatch bot resumes from next system
          ScanState.advance(scanState);
          // v2.10.5: skip the rest of this asteroid's range — jump to the next range.
          const skipped = ScanState.pruneFoundRange(scanState, current.galaxy, current.system);
          if (skipped > 0) log(`Found asteroid in range — skipping ${skipped} remaining system(s) in it, jumping to next range.`, "asteroid");
          GM_setValue("pending_mission", JSON.stringify({
            type: "asteroid_mining_direct",
            fleetUrl: result.fleetUrl,
            shipType: "ASTEROID_MINER",
            quantity: AsteroidYieldTracker.minersNeeded(), // right-sized (0 = all, until learned)
            step: "select_ships_direct",
            resumeScan: true, // flag: after dispatch, continue scanning
            timestamp: Date.now(),
          }));
          RateLimiter.record();
          await AntiDetection.shortDelay(); // 2-8s, fast like a real player clicking
          window.location.href = result.fleetUrl;
          return;
        }

        // No direct URL — use standard dispatch
        ScanState.advance(scanState); // keep scan going after dispatch
        ScanState.pruneFoundRange(scanState, current.galaxy, current.system); // v2.10.5: skip rest of range
        ScanState.markFound(ScanState.load(), current.galaxy, current.system, result.ttlSeconds);
        await this.dispatchToFoundAsteroid(ScanState.load());
        return;
      }

      // Not found — advance to next system
      ScanState.advance(scanState);
      const next = scanState.queue[0]; // queue was shifted by advance

      if (!next) {
        // v2.12.3: THIS is where a sweep normally ends (last queued system just
        // scanned) — and until now it set a flat cooldown with NO range
        // re-fetch, logging "Ranges still active" from a snapshot up to
        // VERIFY_EVERY systems old (the old comment claimed freshRanges was
        // "guaranteed non-empty here" — false on 5 of 6 steps, where it's
        // null). The v2.10.12 sweep-end re-fetch lived only in the
        // queue-empty-at-entry branch above, which this path made unreachable:
        // net effect was brand-new hint ranges staying invisible for a full
        // cooldown (+ jitter). Funnel into the shared finishSweep instead.
        await this.finishSweep(scanState);
        return;
      }

      const target = next;

      // Navigate to next system
      const scanDelay = humanScanDelayMs();
      log(`Next: [${target.galaxy}:${target.system}] in ${Math.round(scanDelay)}ms...`, "asteroid");
      await AntiDetection.sleep(scanDelay);
      scanNavigate(`/galaxy?x=${target.galaxy}&y=${target.system}`, "next system");
    },

    // ── Sweep finished (queue exhausted) — decide what happens next ──
    // (v2.10.12, generalized in v2.12.3) OGameX rotates its asteroid hints
    // frequently: by the time one sweep ends, a brand-new set of search areas
    // is often already live. So on EVERY sweep end: deep-fetch the ranges,
    // and if anything new appeared, rescan immediately instead of cooling
    // down. Only when the re-fetch shows nothing new does the cooldown start
    // — short when hint ranges are still live (asteroids respawn in them),
    // long when the hint pool is empty. Deep fetch (not a single call) so a
    // randomly-subsetted response can't hide a fresh range; it self-limits
    // via early-exit (~3 calls when the endpoint is deterministic).
    async finishSweep(scanState) {
      const sweptKeys = new Set((scanState.ranges || []).map(r => `${r.galaxy}:${r.startSystem}-${r.endSystem}`));
      const scannedCount = scanState.scannedCount || 0;
      const freshRanges = await AsteroidScanner.scanRangesFull(6);
      const newRanges = freshRanges.filter(r => !sweptKeys.has(`${r.galaxy}:${r.startSystem}-${r.endSystem}`));
      if (newRanges.length > 0) {
        const base = CONFIG.asteroidMining.minerBase;
        const maxFlight = CONFIG.asteroidMining.maxFlightMinutes;
        // v2.12.6: exclude systems the just-finished sweep already covered —
        // the fresh-range rescan is for the NEW areas, not a re-walk of the
        // ranges we finished seconds ago.
        const doneSet = new Set((scanState.scannedSystems || []).map(s => `${s.galaxy}:${s.system}`));
        const queue = AsteroidScanner.buildScanQueue(freshRanges, base, maxFlight)
          .filter(q => !doneSet.has(`${q.galaxy}:${q.system}`));
        if (queue.length > 0) {
          const newLabels = newRanges.map(r => `[${r.galaxy}:${r.startSystem}-${r.endSystem}]`).join(", ");
          log(`Sweep done (${scannedCount} systems) — ${newRanges.length} fresh range(s) appeared (${newLabels}) → rescanning now instead of a cooldown wait.`, "asteroid");
          ScanState.start(freshRanges, queue);
          const first = queue[0];
          scanNavigate(`/galaxy?x=${first.galaxy}&y=${first.system}`, "fresh-range rescan");
          return;
        }
      }
      const rangesLive = freshRanges.length > 0;
      const cooldownMin = rangesLive ? ACTIVE_RANGE_RECHECK_MIN : (CONFIG.asteroidMining.scanIntervalMin || 15);
      log(`Sweep done: ${scannedCount} systems checked, no new asteroids. ${rangesLive ? `Ranges still live (verified) → re-sweep in ${cooldownMin}min.` : `No hint ranges → waiting ${cooldownMin}min.`}`, "asteroid");
      ScanState.clear();
      // Cooldown timer so the scheduler doesn't restart immediately
      GM_setValue("ogamex_scan_cooldown_until", String(Date.now() + cooldownMin * 60 * 1000));
    },

    // ── Dispatch fleet to found asteroid ──
    async dispatchToFoundAsteroid(scanState) {
      const asteroid = scanState.foundAsteroid;
      if (!asteroid) return;

      // Miners launch from the configured base planet
      const base = CONFIG.asteroidMining.minerBase;
      if (!base) {
        log("No minerBase configured — cannot dispatch", "error");
        ScanState.clear();
        return;
      }
      if (base.galaxy !== asteroid.galaxy) {
        log(`Base [${base.galaxy}:${base.system}] and asteroid ${asteroid.label} in different galaxies`, "error");
        ScanState.clear();
        return;
      }

      const distance = Math.abs(base.system - asteroid.system);
      const estMinutes = AsteroidScanner.estimateFlightMinutes(distance);
      if (estMinutes > CONFIG.asteroidMining.maxFlightMinutes) {
        log(`Asteroid ${asteroid.label} too far from base (~${estMinutes}min), skipping`, "asteroid");
        ScanState.clear();
        return;
      }

      // v2.9.3: TTL guard in case bot was reloaded between markFound and
      // dispatch (foundAsteroid persists in scan state across page nav).
      if (asteroid.ttlSeconds != null && asteroid.foundAt) {
        const elapsedSec = Math.floor((Date.now() - asteroid.foundAt) / 1000);
        const remainingTtl = asteroid.ttlSeconds - elapsedSec;
        const estSec = estMinutes * 60;
        if (estSec + 300 > remainingTtl) {
          log(`SKIP ${asteroid.label} — flight ~${estMinutes}min (${estSec}s) + 300s buffer > remaining TTL ${remainingTtl}s (orig ${asteroid.ttlSeconds}s, elapsed ${elapsedSec}s)`, "warn");
          // v2.9.6: skip-via-TTL does NOT add to DispatchedAsteroids — see
          // explanation in handleGalaxyScanStep's TTL guard.
          const updated = ScanState.load();
          if (updated) { updated.foundAsteroid = null; ScanState.save(updated); }
          return;
        }
      }

      log(`Dispatching to ${asteroid.label} from base [${base.galaxy}:${base.system}:${base.position}] (~${estMinutes}min)`, "asteroid");

      // v2.10.24: this fallback path never registered the coords — the ONLY
      // dispatch initiation that didn't. In parallel mode the bot resumes
      // scanning right after the send; the asteroid stays visible in the
      // galaxy until collected, so the next sweep re-found it, has() said
      // false, and a second (and third) fleet flew to the same coords.
      if (DispatchedAsteroids.has(asteroid.galaxy, asteroid.system)) {
        log(`Asteroid [${asteroid.galaxy}:${asteroid.system}:17] already dispatched, skipping (fallback path)`, "asteroid");
        const updated2 = ScanState.load();
        if (updated2) { updated2.foundAsteroid = null; ScanState.save(updated2); }
        return;
      }
      DispatchedAsteroids.add(asteroid.galaxy, asteroid.system);

      // Use direct fleet URL with mission pre-set (same as asteroid link)
      const fleetUrl = `/fleet?x=${asteroid.galaxy}&y=${asteroid.system}&z=17&mission=12`;
      GM_setValue("pending_mission", JSON.stringify({
        type: "asteroid_mining_direct",
        fleetUrl,
        shipType: "ASTEROID_MINER",
        quantity: AsteroidYieldTracker.minersNeeded(), // right-sized (0 = all, until learned)
        step: "select_ships_direct",
        resumeScan: true,
        timestamp: Date.now(),
      }));

      // Clear foundAsteroid but keep scan active for resume
      const updatedState = ScanState.load();
      if (updatedState) {
        updatedState.foundAsteroid = null;
        ScanState.save(updatedState);
      }
      RateLimiter.record();
      await AntiDetection.shortDelay(); // 2-8s, fast like a real player clicking
      window.location.href = fleetUrl;
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  INACTIVE FARMER  (v2.11.0) — event farming of (i)/(I) players
  // ═══════════════════════════════════════════════════════════════
  // Sweeps user-configured system ranges ("3:100-200"), collects every planet
  // whose player status is (i)/(I) — skipping (v)/(p)/(b) — and attacks each
  // with Heavy Cargo via the direct fleet URL (…&z=P&planet=1&mission=8),
  // reusing the guarded select_ships_direct 3-step machinery. Mutually
  // exclusive with Asteroid Mining (mining wins; toggles auto-switch in UI).

  // Per-target attack cooldown — full g:s:z coords (many targets per system).
  const FarmedTargets = {
    KEY: "ogamex_farmed_targets",
    _ttlMs() { return Math.max(1, CONFIG.inactiveFarming.targetCooldownMin || 180) * 60 * 1000; },
    _load() {
      try { return JSON.parse(GM_getValue(this.KEY, "[]")).filter(e => Date.now() - e.at < this._ttlMs()); }
      catch { return []; }
    },
    add(coord) {
      const es = this._load();
      es.push({ coord, at: Date.now() });
      GM_setValue(this.KEY, JSON.stringify(es));
    },
    has(coord) { return this._load().some(e => e.coord === coord); },
    count() { return this._load().length; },
  };

  const FarmState = {
    KEY: "ogamex_farm_scan",
    load() { try { return JSON.parse(GM_getValue(this.KEY, "null")); } catch { return null; } },
    save(s) { GM_setValue(this.KEY, JSON.stringify(s)); },
    clear() { GM_setValue(this.KEY, "null"); },
  };

  const InactiveFarmer = {
    running: false,
    _pausedLogged: false,
    SWEEP_COOLDOWN_MIN: 15, // pause between full sweeps of the ranges

    parseRanges(str) {
      const out = [];
      String(str || "").split(",").forEach(part => {
        const m = part.trim().match(/^(\d+)\s*:\s*(\d+)\s*-\s*(\d+)$/);
        if (!m) return;
        const g = parseInt(m[1]);
        const a = Math.min(parseInt(m[2]), parseInt(m[3]));
        const b = Math.max(parseInt(m[2]), parseInt(m[3]));
        if (b - a <= 500) out.push({ galaxy: g, start: a, end: b });
      });
      return out;
    },

    cachedFleetTotal() { return parseInt(GM_getValue("ogamex_fleet_total_slots", "0")) || 0; },

    // "Fleets: X/37" exists only on the fleet page — the total is cached from
    // visits there (init). Everywhere else the live "M Own" missions bar
    // (inflightFleetCount) tracks usage.
    slotsFree() {
      const total = this.cachedFleetTotal();
      if (!total) return 1; // unknown yet → allow one dispatch; the fleet page visit caches it
      const reserve = CONFIG.inactiveFarming.slotReserve || 0;
      return Math.max(0, total - reserve - inflightFleetCount());
    },

    async run() {
      const cfg = CONFIG.inactiveFarming;
      if (!CONFIG.enabled || !cfg.enabled) return;
      if (CONFIG.asteroidMining.enabled) {
        if (!this._pausedLogged) {
          this._pausedLogged = true;
          log("Farming paused — Asteroid Mining is ON (modules are either/or).", "warn");
        }
        return;
      }
      if (AntiDetection.isSleepTime()) return;
      if (Humanizer.isOnBreak()) return; // v2.12.0: also covers init on-load hooks
      // v2.15.0: attacking someone else while a fleet is inbound on US is the
      // worst possible use of a fleet slot.
      if (ThreatMonitor.active()) {
        if (!this._threatLogged) {
          this._threatLogged = true;
          log("Farming on hold — incoming foreign fleet.", "warn");
        }
        return;
      }
      this._threatLogged = false;
      if (Humanizer.attackLimitReached()) {
        if (!this._limitLogged) {
          this._limitLogged = true;
          log(`Farm: daily attack limit reached (${Humanizer.attacksToday()}/${CONFIG.humanizer.maxAttacksPerDay}) — resting until tomorrow (UTC).`, "warn");
        }
        return;
      }
      this._limitLogged = false;
      if (this.running) return;
      this.running = true;
      try {
        const pending = GM_getValue("pending_mission", null);
        if (pending && pending !== "null") return; // a dispatch is mid-flight

        let st = FarmState.load();

        // Targets already collected → keep attacking before scanning further.
        // v2.11.2: attacks are ONLY initiated from a galaxy page (human-like:
        // player looks at the system, then attacks). Off-galaxy → go there.
        if (st?.active && st.targets?.length) {
          const pendingTargets = st.targets.filter(t => !FarmedTargets.has(t.coord));
          if (!pendingTargets.length) { st.targets = []; FarmState.save(st); return; }
          if (GameState.getCurrentPage() === "galaxy") {
            await this.dispatchNext(st);
          } else {
            const t = pendingTargets[0];
            await AntiDetection.shortDelay();
            scanNavigate(`/galaxy?x=${t.galaxy}&y=${t.system}`, "farm back-to-galaxy");
          }
          return;
        }

        if (st?.active) {
          if (GameState.getCurrentPage() === "galaxy") { await this.scanStep(st); return; }
          const next = st.queue?.[0];
          if (next) {
            await AntiDetection.shortDelay();
            scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "farm resume");
          } else {
            this.finishSweep(st);
          }
          return;
        }

        // No active sweep → start one (unless cooling down).
        const cool = parseInt(GM_getValue("ogamex_farm_cooldown_until", "0")) || 0;
        if (Date.now() < cool) return;
        const ranges = this.parseRanges(cfg.ranges);
        if (!ranges.length) return; // nothing configured — status line explains
        const queue = [];
        ranges.forEach(r => { for (let s = r.start; s <= r.end; s++) queue.push({ galaxy: r.galaxy, system: s }); });
        st = { active: true, queue, scannedCount: 0, totalCount: queue.length, targets: [] };
        FarmState.save(st);
        log(`Farm sweep started: ${queue.length} systems (${cfg.ranges})`, "success");
        await AntiDetection.shortDelay();
        scanNavigate(`/galaxy?x=${queue[0].galaxy}&y=${queue[0].system}`, "farm start");
      } finally {
        this.running = false;
      }
    },

    finishSweep(st) {
      log(`Farm sweep done: ${st?.scannedCount ?? "?"} systems checked. Next sweep in ${this.SWEEP_COOLDOWN_MIN}min.`, "info");
      FarmState.clear();
      GM_setValue("ogamex_farm_cooldown_until", String(Date.now() + this.SWEEP_COOLDOWN_MIN * 60 * 1000));
    },

    async scanStep(st) {
      const cur = st.queue?.[0];
      if (!cur) { this.finishSweep(st); return; }
      // Make sure the page we're reading IS the queued system.
      const url = window.location.href;
      const gx = url.match(/[?&]x=(\d+)/);
      const sy = url.match(/[?&]y=(\d+)/);
      if (!gx || parseInt(gx[1]) !== cur.galaxy || !sy || parseInt(sy[1]) !== cur.system) {
        scanNavigate(`/galaxy?x=${cur.galaxy}&y=${cur.system}`, "farm align");
        return;
      }
      const found = this.collectTargets(cur.galaxy, cur.system);
      st.queue.shift();
      st.scannedCount++;
      st.targets = (st.targets || []).concat(found);
      FarmState.save(st);
      if (found.length) log(`Farm: ${found.length} inactive target(s) at [${cur.galaxy}:${cur.system}]: ${found.map(t => t.coord).join(", ")}`, "success");
      if (st.targets.length) { await this.dispatchNext(st); return; }
      const next = st.queue[0];
      if (next) {
        // v2.12.0 wander: occasionally detour via Overview — a human glances
        // at resources between systems. The farm state machine self-heals
        // (off-galaxy → back-to-galaxy) on the next tick, so the detour costs
        // one natural-looking browse gap. Farming only — asteroid TTLs are
        // too tight for detours.
        const wander = (CONFIG.humanizer?.wanderChance || 0) / 100;
        if (wander > 0 && Math.random() < wander) {
          log("Farm: wandering via Overview (human-like detour).", "delay");
          await AntiDetection.sleep(humanScanDelayMs());
          scanNavigate("/overview", "farm wander");
          return;
        }
        await AntiDetection.sleep(humanScanDelayMs());
        scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "farm next");
      } else {
        this.finishSweep(st);
      }
    },

    // Parse the CURRENT galaxy page for attackable inactive planets.
    // Status letters from the legend: s strong, n weak, v vacation,
    // p protection, b banned, i 7d-inactive, I 28d-inactive. Case matters.
    collectTargets(galaxy, system) {
      const out = [];
      document.querySelectorAll(".galaxy-item").forEach(item => {
        const idx = item.querySelector(".planet-index");
        if (!idx) return;
        const pos = parseInt(idx.textContent.trim());
        if (!Number.isFinite(pos) || pos < 1 || pos > 15) return; // 16/17 = deep space/asteroid
        const text = (item.textContent || "").replace(/\s+/g, " ");
        const statuses = [...text.matchAll(/\(\s*([sinvpbI])\s*\)/g)].map(m => m[1]);
        const inactive = statuses.includes("i") || statuses.includes("I");
        const blocked = statuses.includes("v") || statuses.includes("p") || statuses.includes("b");
        if (!inactive || blocked) return;
        const coord = `${galaxy}:${system}:${pos}`;
        if (FarmedTargets.has(coord)) return;
        // One-time DOM dump of the first matched row — verifies the status
        // parsing against this OGameX build's real markup.
        if (GM_getValue("ogamex_farm_row_dumped", "0") !== "1") {
          GM_setValue("ogamex_farm_row_dumped", "1");
          log(`[FARM DOM] first target row: ${item.innerHTML.replace(/\s+/g, " ").substring(0, 400)}`, "info");
        }
        out.push({ coord, galaxy, system, position: pos });
      });
      return out;
    },

    async dispatchNext(st) {
      if (this.slotsFree() <= 0) {
        log(`Farm: fleet slots exhausted (reserve ${CONFIG.inactiveFarming.slotReserve}) — waiting for returns; ${st.targets?.length ?? 0} target(s) queued.`, "warn");
        return; // scheduler retries; targets persist in FarmState
      }
      const targets = (st.targets || []).filter(t => !FarmedTargets.has(t.coord));
      const t = targets.shift();
      st.targets = targets;
      FarmState.save(st);
      if (!t) {
        const next = st.queue?.[0];
        if (next) {
          await AntiDetection.shortDelay();
          scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "farm continue");
        } else {
          this.finishSweep(st);
        }
        return;
      }
      FarmedTargets.add(t.coord); // stamp at initiation, same as asteroids
      const hc = Math.max(1, CONFIG.inactiveFarming.hcPerFlight || 1);
      const fleetUrl = `/fleet?x=${t.galaxy}&y=${t.system}&z=${t.position}&planet=1&mission=8`;
      log(`FARM ATTACK → [${t.coord}] with ${hc} Heavy Cargo`, "success");
      GM_setValue("pending_mission", JSON.stringify({
        type: "inactive_farm_direct",
        farm: true,
        fleetUrl,
        shipType: "HEAVY_CARGO",
        quantity: hc,
        step: "select_ships_direct",
        resumeScan: false,
        timestamp: Date.now(),
      }));
      RateLimiter.record();
      await AntiDetection.shortDelay();
      window.location.href = fleetUrl;
    },

    // Entry point after a farm fleet was sent (fleetSendSuccessfully / finishDispatch).
    // Shares the `running` mutex with run() — a scheduler tick firing in the
    // same window would otherwise interleave dispatchNext and drop a target.
    async afterSend() {
      if (this.running) return;
      this.running = true;
      try {
        const st = FarmState.load();
        if (!st?.active) return;
        // v2.11.2 (human-like pacing): do NOT chain fleet-form → fleet-form.
        // A real player goes back to the galaxy view of the system, hovers the
        // next planet, and only then attacks — so when more targets are
        // queued, navigate to their system's galaxy page first; the on-galaxy
        // farm hook (init + scheduler) dispatches from there after a human
        // dwell. Server-side this reads galaxy → fleet → galaxy → fleet, not
        // a burst of bare fleet-form GETs.
        const targets = (st.targets || []).filter(t => !FarmedTargets.has(t.coord));
        if (targets.length) {
          const t = targets[0];
          await AntiDetection.shortDelay();
          scanNavigate(`/galaxy?x=${t.galaxy}&y=${t.system}`, "farm back-to-galaxy");
          return;
        }
        await this.dispatchNext(st); // no targets left → resume sweep / finish
      } finally {
        this.running = false;
      }
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  //  DEBRIS COLLECTOR (v2.48.0) — złom po ekspedycjach
  // ═══════════════════════════════════════════════════════════════
  // Ekspedycja potrafi trafić na obcych i stracić część fali. To, co z niej
  // zostanie, ląduje jako pole złomu na pozycji 16 systemu bazy — czyli tam,
  // dokąd bot wysyła ekspedycje. Są to nasze własne surowce i leżą do zebrania
  // recyklerami; nikt inny po nie nie przyleci, bo to nasz system.
  //
  // Trzy zasady, których się trzymam:
  //   • Nie zgaduję numeru misji. Wiersz galaktyki ma gotowy link zbierania —
  //     bierzemy go w całości, tak jak przy asteroidach (fork ma własną
  //     numerację: ekspedycja to mission=1, asteroida mission=12).
  //   • Recykling NIE jest lotem górniczym. Ma własną flagę, więc nie zjada
  //     budżetu lotów ani nie ustawia pauzy skanu.
  //   • Ustępuje wszystkiemu: ratunkowi floty, trwającej wysyłce i przerwom.
  const DebrisCollector = {
    KEY_AT: "ogamex_debris_check_at",
    KEY_SENT: "ogamex_debris_sent_at",
    KEY_DUMPED: "ogamex_debris_markup_dumped_v248",
    CHECK_EVERY_MS: 20 * 60 * 1000,   // co tyle zaglądamy na galaktykę bazy
    RESEND_GUARD_MS: 10 * 60 * 1000,  // po wysyłce nie próbuj drugi raz

    base() { return CONFIG.asteroidMining.minerBase; },

    // Wiersz pozycji 16 na ŻYWEJ stronie galaktyki. Zwraca link zbierania.
    findDebrisLink() {
      for (const item of document.querySelectorAll(".galaxy-item")) {
        const idx = parseInt(item.querySelector(".planet-index")?.textContent || "0") || 0;
        if (idx !== 16) continue;
        const cell = item.querySelector(".col-debris, .galaxy-col.col-debris");
        if (!cell) return null;
        if (GM_getValue(this.KEY_DUMPED, "") !== "1" && (cell.innerHTML || "").trim().length > 0) {
          GM_setValue(this.KEY_DUMPED, "1");
          log(`[ZŁOM] markup pola złomu (poz. 16): ${(cell.innerHTML || "").replace(/\s+/g, " ").slice(0, 600)}`, "info");
        }
        const a = cell.querySelector("a[href*='/fleet']");
        if (a) return a.getAttribute("href");
        // Niektóre buildy wieszają zbieranie na elemencie bez <a> — wtedy
        // zostaje sam fakt, że komórka nie jest pusta. Nie zgaduję misji:
        // zapisuję markup (wyżej) i czekam na niego, zamiast wysyłać flotę
        // w nieznane.
        return null;
      }
      return null;
    },

    // Ile recyklerów jest w hangarze (strona floty / ostatni zwiad).
    recyclersHome() {
      for (const el of document.querySelectorAll("[data-ship-type='RECYCLER']")) {
        const n = parseInt(el.dataset.shipQuantity || "0") || 0;
        if (n > 0) return n;
      }
      try {
        const recon = JSON.parse(GM_getValue("ogamex_fleet_recon", "null"));
        return parseInt(recon?.ships?.RECYCLER || "0") || 0;
      } catch { return 0; }
    },

    // Wywoływane, gdy bot STOI na stronie galaktyki systemu bazy.
    tryCollectHere() {
      if (!CONFIG.expeditions?.collectDebris) return false;
      if (GM_getValue("pending_mission", null)) return false;
      if (ThreatMonitor.active()) return false;             // ratunek ma pierwszeństwo
      const last = parseInt(GM_getValue(this.KEY_SENT, "0")) || 0;
      if (Date.now() - last < this.RESEND_GUARD_MS) return false;
      const b = this.base();
      const m = window.location.search.match(/[?&]x=(\d+)&y=(\d+)/);
      if (!m || parseInt(m[1]) !== b.galaxy || parseInt(m[2]) !== b.system) return false;
      const href = this.findDebrisLink();
      if (!href) return false;
      GM_setValue(this.KEY_SENT, String(Date.now()));
      GM_setValue("pending_mission", JSON.stringify({
        type: "debris_recycle_direct",
        recycle: true,               // NIE jest lotem górniczym
        fleetUrl: href,
        shipType: "RECYCLER",
        quantity: 0,                 // 0 = wszystkie recyklery w hangarze
        step: "select_ships_direct",
        resumeScan: true,
        timestamp: Date.now(),
      }));
      log(`[ZŁOM] pole złomu na [${b.galaxy}:${b.system}:16] — wysyłam recyklery (${href}).`, "success");
      setTimeout(() => { window.location.href = href; }, 800 + Math.random() * 700);
      return true;
    },

    // Okresowa wizyta na galaktyce bazy. Tylko gdy bot i tak nic nie robi.
    shouldVisit() {
      if (!CONFIG.expeditions?.collectDebris) return false;
      if (GM_getValue("pending_mission", null)) return false;
      if (ThreatMonitor.active()) return false;
      if (Humanizer.isOnBreak() || AntiDetection.isSleepTime()) return false;
      const last = parseInt(GM_getValue(this.KEY_AT, "0")) || 0;
      if (Date.now() - last < this.CHECK_EVERY_MS) return false;
      // Nie przerywamy skanu asteroid dla złomu: normalnie zaglądamy tylko
      // wtedy, gdy minery i tak są w drodze i skan stoi. Dopiero po dwóch
      // godzinach bez wizyty idziemy mimo wszystko — skaner umie się pozbierać
      // („Scan stranded off galaxy page. Resuming at …"), ale to kosztuje.
      const minersOut = (parseInt(GM_getValue("ogamex_fleet_return_at", "0")) || 0) > Date.now();
      return minersOut || Date.now() - last > 2 * 60 * 60 * 1000;
    },

    visit() {
      const b = this.base();
      GM_setValue(this.KEY_AT, String(Date.now()));
      log(`[ZŁOM] zaglądam na galaktykę bazy [${b.galaxy}:${b.system}] po pole złomu z ekspedycji.`, "info");
      scanNavigate(`/galaxy?x=${b.galaxy}&y=${b.system}`, "debris check");
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  FLEET MOVEMENTS (v2.51.0) — kto, po co i dokąd leci
  // ═══════════════════════════════════════════════════════════════
  // GET /home/fleetmovementlist — endpoint, który gra odpytuje sama, żeby
  // odświeżyć pasek misji. Zrzut z 21:09:52 pokazał, że wiersz niesie WSZYSTKO,
  // czego brakowało obronie:
  //
  //   <tr data-fleet-id="4649f6fc-…" class="row-mission-type-EXPEDITION">
  //     <td data-remaining-seconds="213" …>03:33</td>
  //     <td><img … data-tooltip-content="Expedition" /></td>
  //     <td> Yoyoyoyoyo <a href="/galaxy?x=3&y=269" class="fleet-source-coords">[3:269:8]</a> </td>
  //     <td><span … tooltip ze składem floty …>
  //
  // Typ misji jest podany NAZWĄ, nie numerem — więc odpada cały problem
  // numeracji, przez który 2.40.0 mogło czytać wrogość na odwrót. Do tego
  // źródło, cel, czas do przylotu i skład floty.
  const FleetMovements = {
    URL: "/home/fleetmovementlist",
    ATTACK: /(ATTACK|MISSILE|DESTRUCT|DESTROY|BOMBARD|INVAS)/i,
    SPY: /(ESPIONAGE|SPY|PROBE|SCAN)/i,

    // Zwraca { ok, rows } — ok=false znaczy „nie wiem", a nie „bezpiecznie".
    async fetch() {
      if (!Ajax.supported(this.URL)) return { ok: false, rows: [] };
      let html = "";
      try {
        const res = await fetch(this.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
        if (!res.ok) { Ajax.markUnsupported(this.URL, res.status); return { ok: false, rows: [] }; }
        html = await res.text();
      } catch { return { ok: false, rows: [] }; }
      if (!html) return { ok: false, rows: [] };
      const doc = new DOMParser().parseFromString(html, "text/html");
      const trs = [...doc.querySelectorAll("tr[class*='row-mission-type-']")];
      if (!trs.length) return { ok: false, rows: [] };
      const own = ThreatMonitor.ownBodies();
      const rows = [];
      for (const tr of trs) {
        const type = (String(tr.className).match(/row-mission-type-([A-Z_]+)/i) || [])[1] || "?";
        const srcEl = tr.querySelector(".fleet-source-coords");
        const coords = [...(tr.textContent || "").matchAll(/\[(\d+:\d+:\d+)\]/g)].map(m => m[1]);
        const src = (String(srcEl?.textContent || "").match(/(\d+:\d+:\d+)/) || [])[1] || coords[0] || null;
        const dst = coords.filter(c => c !== src).pop() || null;
        const eta = parseInt(tr.querySelector("[data-remaining-seconds]")?.getAttribute("data-remaining-seconds") || "0") || 0;
        // Skład floty siedzi w tooltipie („Light Cargo : 330.000.000").
        const tip = tr.querySelector("[data-tooltip-content*='Ships']")?.getAttribute("data-tooltip-content") || "";
        const ships = [...tip.matchAll(/>([A-Za-z ]+?)\s*:\s*<\/td>\s*<td[^>]*>([\d.\s]+)</g)]
          .map(m => `${m[1].trim()} ${m[2].trim()}`);
        rows.push({
          id: tr.getAttribute("data-fleet-id") || "",
          type, src, dst, eta,
          mine: !!(src && own.size && own.has(src)),
          attack: this.ATTACK.test(type),
          spy: this.SPY.test(type),
          ships,
        });
      }
      return { ok: true, rows };
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  FLEET SAVE (v2.57.0) — planowanie, na razie bez wysyłki
  // ═══════════════════════════════════════════════════════════════
  // Arytmetyka jest prosta i pewna: zawrócona flota wraca dokładnie tyle, ile
  // zdążyła lecieć. Powrót = start + 2 × opóźnienie zawrócenia, a opóźnienie
  // nie może przekroczyć pełnego czasu lotu w jedną stronę (T) — po T flota
  // dolatuje i przestaje być w drodze.
  //
  //   maksymalny FS z jednego lotu = 2 × T
  //   start = powrót − 2 × opóźnienie      (opóźnienie ≤ T)
  //
  // T zależy od trasy, składu floty i PRĘDKOŚCI. Przy 10% prędkości lot trwa
  // dziesięciokrotnie dłużej, więc suwak prędkości jest tu głównym narzędziem.
  // Bot pozna T dopiero z formularza wysyłki (gra pokazuje czas lotu w kroku 2)
  // — dlatego planer liczy na zmierzonym T i mówi wprost, gdy go jeszcze nie ma.
  const FleetSave = {
    KEY: "ogamex_fs_state",
    KEY_T: "ogamex_fs_flight_ms",   // zmierzony czas lotu w jedną stronę

    cfg() { return CONFIG.fleetSave || {}; },
    state() { try { return JSON.parse(GM_getValue(this.KEY, "null")); } catch { return null; } },
    save(st) { GM_setValue(this.KEY, JSON.stringify(st)); },

    // Zmierzony czas lotu dla tej trasy i prędkości (klucz uwzględnia oba).
    routeKey() {
      const c = this.cfg();
      return `${c.from?.galaxy}:${c.from?.system}:${c.from?.position}→${c.to?.galaxy}:${c.to?.system}:${c.to?.position}@${c.speedPercent}`;
    },
    flightMs() {
      try { return JSON.parse(GM_getValue(this.KEY_T, "{}"))[this.routeKey()] || 0; } catch { return 0; }
    },
    noteFlightMs(ms) {
      if (!(ms > 0)) return;
      let all = {};
      try { all = JSON.parse(GM_getValue(this.KEY_T, "{}")); } catch {}
      all[this.routeKey()] = ms;
      GM_setValue(this.KEY_T, JSON.stringify(all));
      log(`[FS] czas lotu tej trasy przy ${this.cfg().speedPercent}% prędkości: ${Math.round(ms / 60000)} min → maksymalny FS ${Math.round(ms / 30000)} min.`, "info");
    },

    // Zwraca plan albo powód, dla którego go nie ma.
    plan(now = Date.now()) {
      const c = this.cfg();
      if (!c.enabled) return { ok: false, why: "FS wyłączony" };
      const at = c.returnAt ? Date.parse(c.returnAt) : NaN;
      if (!Number.isFinite(at)) return { ok: false, why: "nie ustawiono godziny powrotu" };
      if (at <= now) return { ok: false, why: "godzina powrotu już minęła" };
      const T = this.flightMs();
      if (!T) return { ok: false, why: "nie znam jeszcze czasu lotu tej trasy — pierwszy FS trzeba wysłać ręcznie albo pozwolić botowi zmierzyć" };
      const window = at - now;
      if (window > 2 * T) {
        return {
          ok: false,
          why: `okno ${Math.round(window / 60000)} min przekracza maksimum ${Math.round(T / 30000)} min dla tej trasy. Zmniejsz prędkość albo wybierz dalszy księżyc.`,
          maxMs: 2 * T,
        };
      }
      // Startujemy jak najpóźniej: mniej czasu w powietrzu = mniej okazji.
      const delay = Math.floor(window / 2);        // ≤ T, bo window ≤ 2T
      return { ok: true, launchAt: now, recallAt: now + delay, returnAt: at, delayMs: delay, flightMs: T };
    },

    describe() {
      const p = this.plan();
      if (!p.ok) return `FS: ${p.why}`;
      const f = (ms) => new Date(ms).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
      return `FS: start ${f(p.launchAt)} → zawrócenie ${f(p.recallAt)} → powrót ${f(p.returnAt)}`;
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  API SNIFFER (v2.45.0) — czego gra używa NAPRAWDĘ
  // ═══════════════════════════════════════════════════════════════
  // Trasy z open-source'owego OGameX okazały się nieprawdziwe dla tego serwera
  // (404 na eventbox, eventlist i check-target). Zgadywanie kolejnych adresów
  // to strzelanie w ciemno, a każdy strzał to 404 w logach serwera.
  //
  // Jest prostszy i uczciwszy sposób: gra sama odpytuje swoje endpointy —
  // pasek misji odświeża się bez przeładowania, galaktyka doczytuje wiersze,
  // wiadomości ładują zakładki. Wystarczy podsłuchać WŁASNE zapytania strony.
  // Podpinamy się pod fetch i XMLHttpRequest w kontekście strony, notujemy
  // unikalne adresy i wypisujemy je raz. Zero dodatkowego ruchu.
  const ApiSniffer = {
    KEY: "ogamex_seen_endpoints",
    MAX: 40,

    seen() { try { return JSON.parse(GM_getValue(this.KEY, "{}")); } catch { return {}; } },

    note(method, url) {
      try {
        const u = String(url || "");
        if (!u || /^data:|^blob:/.test(u)) return;
        const path = u.startsWith("http") ? new URL(u).pathname + (new URL(u).search ? "?…" : "") : u.split("#")[0];
        if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ico|mp3)$/i.test(path)) return;
        const key = `${method} ${path}`;
        const all = this.seen();
        if (all[key]) { all[key].n = (all[key].n || 1) + 1; GM_setValue(this.KEY, JSON.stringify(all)); return; }
        if (Object.keys(all).length >= this.MAX) return;
        all[key] = { at: Date.now(), n: 1 };
        GM_setValue(this.KEY, JSON.stringify(all));
        log(`[API SNIFFER] gra odpytuje: ${key}`, "info");
      } catch {}
    },

    install() {
      const w = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;
      if (!w || w.__ogxSniffer) return;
      try {
        w.__ogxSniffer = true;
        const origFetch = w.fetch;
        if (typeof origFetch === "function") {
          w.fetch = function (input, init) {
            try { ApiSniffer.note((init && init.method) || "GET", typeof input === "string" ? input : input?.url); } catch {}
            return origFetch.apply(this, arguments);
          };
        }
        const origOpen = w.XMLHttpRequest?.prototype?.open;
        if (typeof origOpen === "function") {
          w.XMLHttpRequest.prototype.open = function (method, url) {
            try { ApiSniffer.note(method || "GET", url); } catch {}
            return origOpen.apply(this, arguments);
          };
        }
      } catch (e) {
        log(`[API SNIFFER] nie udało się podpiąć: ${e.message}`, "warn");
      }
    },

    dump() {
      const all = this.seen();
      const keys = Object.keys(all).sort();
      if (!keys.length) { log("[API SNIFFER] nic jeszcze nie złapano — pochodź chwilę po grze (galaktyka, flota, wiadomości).", "warn"); return; }
      log(`[API SNIFFER] złapane adresy (${keys.length}): ${keys.map(k => `${k} ×${all[k].n}`).join(" | ")}`, "error");
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  //  AJAX (v2.41.0) — rozmowa z grą jej własnymi endpointami
  // ═══════════════════════════════════════════════════════════════
  // OGameX jest open-source (lanedirt/OGameX) i jego routes/web.php wprost
  // wymienia endpointy, których gra używa sama z siebie. Do 2.39.1 bot udawał
  // człowieka klikającego w DOM nawet tam, gdzie gra ma gotowe API — stąd
  // przeładowanie strony na każdy skanowany system i zgadywanie struktury
  // wiadomości.
  //
  // Zasada, która obowiązuje przy KAŻDYM z tych endpointów: nowa droga musi
  // umieć się poddać. Athena to FORK (asteroidy, Galleon, Falcon, Reaper nie
  // istnieją w upstream), więc odpowiedź może wyglądać inaczej niż w źródle.
  // Gdy endpoint nie odpowie albo odpowie czymś nieznanym, wracamy na starą
  // ścieżkę zamiast zgadywać.
  const Ajax = {
    KEY_TOKEN: "ogamex_csrf_token",
    // ── v2.45.0: ten serwer NIE MA upstreamowych endpointów ──
    // Test z 2026-08-02 18:31 na athena.ogamex.net:
    //   /ajax/fleet/eventbox/fetch      → 404
    //   /ajax/fleet/eventlist/fetch     → 404
    //   /ajax/fleet/dispatch/check-target → 404
    //   /ajax/galaxy                    → 200, ale zwykła strona HTML
    //   /ajax/messages?tab=…            → 200, też strona HTML
    // Trasy z lanedirt/OGameX opisują INNĄ wersję gry. Dopóki nie znamy
    // prawdziwych adresów tego forka, nie wolno tych zapytań powtarzać: to
    // czysty ruch w tle bez żadnego pożytku, a każde 404 to ślad w logach
    // serwera. Bramka jest jednokierunkowa — raz wyłączona zostaje wyłączona,
    // aż do jawnego „Test API".
    // ── v2.49.0: martwy jest ADRES, nie cała idea ──
    // 2.45.0 wyłączało wszystkie ścieżki API jedną bramką, bo endpointy
    // z upstream OGameX dawały 404. Podsłuch (20:56) pokazał, że ten serwer
    // ma własne, zupełnie inne adresy — to aplikacja .NET, nie Laravel:
    //   /home/Partial_AsteroidJournal
    //   /home/Partial_ExpeditionJournal
    //   /messages/messagedata?MessageCategoryType=FLEET_EXPEDITION&page=1
    //   /home/combatreport?id=<uuid>
    // Jedna wspólna bramka kazałaby razem z martwymi adresami wyłączyć te
    // żywe. Pamiętamy więc, KTÓRY adres oddał 404 — reszta działa dalej.
    KEY_SUPPORT: "ogamex_api_dead_paths",
    _dead() { try { return JSON.parse(GM_getValue(this.KEY_SUPPORT, "{}")); } catch { return {}; } },
    supported(url) {
      if (!url) return true;
      const path = String(url).split("?")[0];
      return !this._dead()[path];
    },
    markUnsupported(url, status) {
      const path = String(url).split("?")[0];
      const dead = this._dead();
      if (dead[path]) return;
      dead[path] = { status, at: Date.now() };
      GM_setValue(this.KEY_SUPPORT, JSON.stringify(dead));
      log(`[API] ${path} → ${status}. Ten adres nie istnieje na tym serwerze — nie pytam o niego ponownie. Inne ścieżki działają dalej.`, "warn");
    },
    resetDead() { GM_setValue(this.KEY_SUPPORT, "{}"); },

    // Token CSRF: z <meta>, z ukrytego pola, z globalnej zmiennej `token`
    // (tak trzyma go sama gra), a w ostateczności z zapamiętanego
    // `newAjaxToken` — każda odpowiedź AJAX gry zwraca świeży.
    token() {
      const meta = document.querySelector("meta[name='csrf-token']")?.content;
      if (meta) return meta;
      const input = document.querySelector("input[name='_token'], input[name='token']")?.value;
      if (input) return input;
      try { if (typeof unsafeWindow !== "undefined" && unsafeWindow.token) return unsafeWindow.token; } catch {}
      try { if (typeof window !== "undefined" && window.token) return window.token; } catch {}
      // v2.44.0: gra wstawia token w skryptach inline (`{{ csrf_token() }}`
      // w szablonach). Szukamy go tam, zanim sięgniemy po zapamiętany.
      for (const sc of document.querySelectorAll("script:not([src])")) {
        const m = String(sc.textContent || "").match(/(?:_token|csrf[_-]?token|["']token["']|\btoken)\s*[:=]\s*["']([A-Za-z0-9]{20,})["']/);
        if (m) { this.remember(m[1]); return m[1]; }
      }
      return GM_getValue(this.KEY_TOKEN, "") || "";
    },

    remember(t) { if (t && typeof t === "string") GM_setValue(this.KEY_TOKEN, t); },

    // ── v2.44.0: powiedz, CO odpowiada, a co nie ──
    // 2026-08-02 18:22 log właściciela: „[GALAXY AJAX] endpoint zwrócił coś,
    // co nie jest JSON-em", a odczyty zagrożenia dalej miały format paska —
    // czyli MILCZAŁY WSZYSTKIE nowe endpointy, nie tylko galaktyka. Bez statusu
    // HTTP i początku odpowiedzi nie da się odróżnić 404 (fork nie ma tej
    // trasy) od 419 (brak tokenu CSRF) od przekierowania na logowanie.
    async diagnose() {
      const tok = this.token();
      log(`[API TEST] token CSRF: ${tok ? `${tok.slice(0, 8)}… (${tok.length} zn.)` : "BRAK — to najpewniej przyczyna"}`, tok ? "info" : "error");
      // v2.54.0: lista skrócona do adresów, które mają sens na TYM serwerze.
      // Trasy z upstream OGameX (eventbox, eventlist, check-target, /ajax/galaxy)
      // oddały 404 albo stronę HTML — trzymanie ich w teście tylko dokładałoby
      // szumu i pukania do nieistniejących drzwi.
      const probes = [
        ["GET", "/home/fleetmovementlist"],
        ["GET", "/home/Partial_AsteroidJournal"],
        ["GET", "/home/Partial_ExpeditionJournal"],
        ["GET", "/messages/messagedata?MessageCategoryType=FLEET_OTHER&page=1"],
        ["GET", "/messages/messagedata?MessageCategoryType=FLEET_EXPEDITION&page=1"],
      ];
      for (const [method, url, params] of probes) {
        try {
          const res = method === "GET"
            ? await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } })
            : await fetch(url, {
                method: "POST",
                headers: {
                  "X-Requested-With": "XMLHttpRequest",
                  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                },
                body: new URLSearchParams({ ...(params || {}), _token: tok, token: tok }).toString(),
              });
          const ct = res.headers.get("content-type") || "?";
          const txt = (await res.text()).replace(/\s+/g, " ").trim();
          // v2.49.1: przy adresach, z których ma powstać parser, podgląd musi być
          // na tyle długi, żeby było w nim widać wiersz raportu, a nie sam <style>.
          const wide = /messagedata|Journal|combatreport/i.test(url);
          log(`[API TEST] ${method} ${url} → ${res.status} ${ct.split(";")[0]} :: ${txt.slice(0, wide ? 1500 : 220)}`, res.ok ? "info" : "error");
        } catch (e) {
          log(`[API TEST] ${method} ${url} → wyjątek: ${e.message}`, "error");
        }
        await new Promise(r => setTimeout(r, 700));
      }
    },

  };

  // ═══════════════════════════════════════════════════════════════
  //  THREAT MONITOR  (v2.15.0) — someone is flying at us
  // ═══════════════════════════════════════════════════════════════
  // Stage 1 of fleet-save: DETECT and SHOUT. It never moves a ship.
  //
  // The signal was already in the codebase and unused: the mission bar reads
  // "N Missions: M Own", and inflightFleetCount() takes only M. N > M means
  // fleets are in the air that are NOT ours — an incoming attack, an
  // espionage probe, or an ally. One regex, zero extra requests.
  //
  // What it deliberately does NOT do yet: decide WHICH of those it is. A spy
  // probe is the scout before the punch, not a reason to launch 18 billion
  // miners, and getting that classification wrong is expensive in both
  // directions. So on the first sighting we DUMP the event rows (and, on a
  // galaxy page, the base row with its moon link) into the persisted log —
  // the same trick that saved us from assuming mission=15 for expeditions,
  // where the real answer turned out to be mission=1. Stage 2 (deploy
  // everything to the moon at the same coords) gets written against that
  // markup, not against a guess.
  //
  // While an alert is up: farming and expedition waves hold. Mining does NOT
  // — a mining dispatch sends miners AWAY from the planet, which is the
  // direction we want them going anyway.

  const ThreatMonitor = {
    KEY: "ogamex_threat",
    KEY_DUMPED: "ogamex_threat_markup_dumped_v2381",
    KEY_CANDIDATE: "ogamex_threat_candidate", // v2.32.0: od kiedy widzimy obcych
    CONFIRM_MS: 25 * 1000,                    // tyle musi się utrzymać, zanim ruszymy flotą
    SELF_SEND_BLIND_MS: 20 * 1000,            // tyle po NASZEJ wysyłce pasek kłamie
    KEY_SEEN: "ogamex_threat_last_seen",      // v2.29.0: co pasek pokazał ostatnio
    KEY_SEEN_AT: "ogamex_threat_last_seen_at",
    _fetching: false,

    // ── v2.40.0: typ misji z serwera zamiast arytmetyki na pasku ──
    // Do 2.39.1 zagrożenie liczyło się jako „wszystkie misje minus własne".
    // Ta liczba nie mówi ani KTO leci, ani PO CO, ani DOKĄD, więc sześć sond
    // wysłanych na inną kolonię wyglądało identycznie jak sześć fal ataku na
    // bazę — i ewakuowało flotę bez powodu (2026-08-02, ~12:18).
    //
    // OGameX ma na to własne endpointy (routes/web.php):
    //   /ajax/fleet/eventbox/fetch  → JSON { hostile, neutral, friendly, ... }
    //   /ajax/fleet/eventlist/fetch → HTML z wierszami
    //                                 <tr class="eventFleet" data-mission-type="N">
    // Serwer liczy jako „hostile" typy misji 1, 2, 6, 9, 10 — czyli SZPIEGOWANIE
    // (6) też. Dlatego sam licznik nie wystarcza: dopiero data-mission-type
    // z listy rozdziela sondę od uderzenia.
    KEY_EVENTS: "ogamex_threat_events",
    KEY_EVENTS_DUMPED: "ogamex_eventlist_markup_dumped_v240",
    ATTACK_TYPES: [1, 2, 9, 10],   // 1 atak, 2 atak ACS, 9 zniszczenie księżyca, 10 rakiety
    ESPIONAGE_TYPE: 6,
    EVENT_MAX_AGE_MS: 90 * 1000,   // starszy odczyt nie rządzi alarmem
    _evFetching: false,

    events() {
      try { return JSON.parse(GM_getValue(this.KEY_EVENTS, "null")); } catch { return null; }
    },

    // Nasze ciała — z listy skrótów planet, obecnej na każdej stronie gry.
    // Wiersz zdarzenia, którego ŹRÓDŁO jest nasze, jest nasz; reszta jest obca.
    ownBodies() {
      const set = new Set();
      for (const opt of document.querySelectorAll("#planetShortcutSelect option[value]")) {
        const m = String(opt.value).match(/^(PLANET|MOON)-(\d+)-(\d+)-(\d+)$/);
        if (m) set.add(`${m[2]}:${m[3]}:${m[4]}`);
      }
      if (set.size) GM_setValue("ogamex_own_bodies", JSON.stringify([...set]));
      else { try { for (const c of JSON.parse(GM_getValue("ogamex_own_bodies", "[]"))) set.add(c); } catch {} }
      return set;
    },

    async refreshEvents() {
      if (this._evFetching) return;
      this._evFetching = true;
      try {
        const hdr = { headers: { "X-Requested-With": "XMLHttpRequest" } };
        // ── v2.51.0: prawdziwe źródło — lista ruchów flot ──
        // Wiersz podaje typ misji NAZWĄ (row-mission-type-ATTACK / ESPIONAGE /
        // EXPEDITION), źródło, cel i czas do przylotu. To zamyka trzy braki
        // naraz: sonda nie rusza już flotą, znamy atakowaną kolonię i mamy
        // skład napastnika do dziennika.
        const fm = await FleetMovements.fetch().catch(() => ({ ok: false, rows: [] }));
        if (fm.ok) {
          const foreign = fm.rows.filter(r => !r.mine);
          const attacks = foreign.filter(r => r.attack);
          const spies = foreign.filter(r => r.spy);
          const out = {
            at: Date.now(),
            hostile: foreign.length,
            attacks: attacks.length,
            spies: spies.length,
            classified: true,
            targets: [...new Set(attacks.map(r => r.dst).filter(Boolean))],
            origins: [...new Set(attacks.map(r => r.src).filter(Boolean))],
          };
          // ── v2.53.0: kontrola krzyżowa z paskiem misji ──
          // /home/fleetmovementlist zweryfikowałem WYŁĄCZNIE na naszych własnych
          // wierszach — nikt jeszcze nie leciał na nas od czasu wdrożenia. Jeśli
          // ta lista pokazuje tylko FLOTY WŁASNE, to v2.51.0 nie „poprawiła"
          // wykrywania, tylko je WYŁĄCZYŁA: obcych zawsze zero, alarm nigdy nie
          // wstaje. Pasek misji liczy floty na całym koncie, więc rozbieżność
          // „pasek widzi obcych, lista nie" jest jedynym sygnałem, jaki mamy.
          // W razie rozbieżności wygrywa pasek — mniej wie, ale wie na pewno.
          const barNow = this.read();
          if (barNow && barNow.foreign > 0 && foreign.length === 0) {
            if (GM_getValue("ogamex_fml_blind_warned", "") !== "1") {
              GM_setValue("ogamex_fml_blind_warned", "1");
              log(`[THREAT] UWAGA: pasek pokazuje ${barNow.foreign} obcych flot, a lista ruchów flot żadnej. Ta lista najpewniej zawiera tylko NASZE floty — wracam do liczenia z paska (sondy znów będą ruszać flotą).`, "error");
              ThreatLog.add("BŁĄD", `Lista ruchów flot nie pokazuje obcych, a pasek widzi ${barNow.foreign}. Klasyfikacja niepewna — obrona wraca na pasek misji.`);
            }
            // Nie kończymy tu: schodzimy do ścieżki paska niżej.
          } else {
          GM_setValue(this.KEY_EVENTS, JSON.stringify(out));
          if (attacks.length) {
            const first = attacks.sort((a, b) => (a.eta || 1e9) - (b.eta || 1e9))[0];
            const mins = first.eta ? Math.max(0, Math.round(first.eta / 60)) : null;
            ThreatLog.add("ATAK", `${attacks.length}× ${first.type} z [${first.src}] na [${first.dst}]`
              + (mins !== null ? `, przylot za ~${mins} min` : "")
              + (first.ships?.length ? ` | flota: ${first.ships.slice(0, 8).join(", ")}` : ""));
          }
          return;
          }
        }

        if (!Ajax.supported("/ajax/fleet/eventbox/fetch")) return;
        let box = null;
        try {
          const res = await fetch("/ajax/fleet/eventbox/fetch", hdr);
          if (!res.ok) { Ajax.markUnsupported("/ajax/fleet/eventbox/fetch", res.status); return; }
          box = await res.json();
        } catch { return; }
        if (!box || !Number.isFinite(box.hostile)) return; // nie wiem → pasek zostaje awaryjnym źródłem
        Ajax.remember(box.newAjaxToken); // każda odpowiedź gry niesie świeży token CSRF
        const out = { at: Date.now(), hostile: box.hostile, attacks: 0, spies: 0, classified: true, targets: [], origins: [] };
        if (box.hostile > 0) {
          let html = "";
          try {
            const res = await fetch("/ajax/fleet/eventlist/fetch", hdr);
            if (res.ok) html = await res.text();
          } catch {}
          const rows = html ? [...new DOMParser().parseFromString(html, "text/html")
            .querySelectorAll("tr.eventFleet[data-mission-type]")] : [];
          if (!rows.length) {
            // Nie umiem sklasyfikować — nie udaję, że wiem. Alarm leci po staremu
            // (każda obca flota = zagrożenie), a markup ląduje w logu do naprawy.
            out.classified = false;
            if (html && GM_getValue(this.KEY_EVENTS_DUMPED, "") !== "1") {
              GM_setValue(this.KEY_EVENTS_DUMPED, "1");
              log(`[THREAT DOM] eventlist (${html.length}ch): ${html.replace(/\s+/g, " ").slice(0, 2000)}`, "error");
            }
          }
          const own = this.ownBodies();
          // ── v2.42.0: sprawdź, czy numeracja misji jest ta z upstream ──
          // W linku galaktyki tego forka ekspedycja to `mission=1`, a w upstream
          // OGameX `1` znaczy ATAK. Jeśli fork przenumerował misje, cała
          // klasyfikacja z 2.40.0 czyta wrogość na odwrót. Nasze WŁASNE wiersze
          // są tu wzorcem: bot lata ekspedycjami, miningiem i transportem, więc
          // typ, który widać na naszej misji, nie może być typem ataku.
          const ourTypes = new Set();
          for (const tr of rows) {
            const t = parseInt(tr.dataset.missionType || "0") || 0;
            const oc = (tr.querySelector(".coordsOrigin")?.textContent || "").match(/(\d+:\d+:\d+)/);
            if (t && oc && own.has(oc[1])) ourTypes.add(t);
          }
          const collision = this.ATTACK_TYPES.filter(t => ourTypes.has(t));
          if (collision.length) {
            out.classified = false;
            if (GM_getValue("ogamex_mission_numbering_warned", "") !== "1") {
              GM_setValue("ogamex_mission_numbering_warned", "1");
              log(`[THREAT] UWAGA: nasze własne misje mają typ ${collision.join(", ")}, który w upstream oznacza atak. Ten serwer ma inną numerację — rozróżnianie sondy od ataku WYŁĄCZONE, wracam do zasady „każda obca flota = zagrożenie". Typy naszych misji: ${[...ourTypes].join(", ")}.`, "error");
              ThreatLog.add("BŁĄD", `Numeracja misji forka nie zgadza się z upstream (nasze typy: ${[...ourTypes].join(", ")}). Klasyfikacja wyłączona.`);
            }
          }
          const coordIn = (el, fallback) => {
            const m = String((el || fallback || "")).match(/(\d+:\d+:\d+)/);
            return m ? m[1] : null;
          };
          for (const tr of rows) {
            if (tr.dataset.returnFlight === "true") continue;   // nasz powrót
            const type = parseInt(tr.dataset.missionType || "0") || 0;
            // ŹRÓDŁO decyduje, czyja to misja; CEL mówi, którą kolonię ewakuować.
            // Nie wolno pytać „czy w wierszu są nasze koordynaty" — atak NA nas
            // ma nasze koordynaty w celu i wypadłby jako własny.
            const all = [...(tr.textContent || "").matchAll(/(\d+:\d+:\d+)/g)].map(m => m[1]);
            const origin = coordIn(tr.querySelector(".coordsOrigin")?.textContent, all[0]);
            const dest = coordIn(tr.querySelector(".destCoords")?.textContent, all[all.length - 1]);
            if (own.size && origin && own.has(origin)) continue; // nasza własna misja
            if (!out.classified) { out.attacks = out.hostile; continue; } // numeracja niepewna → wszystko traktuj jak atak
            if (type === this.ESPIONAGE_TYPE) { out.spies++; continue; }
            if (this.ATTACK_TYPES.includes(type)) {
              out.attacks++;
              if (dest) out.targets.push(dest);
              if (origin) out.origins.push(origin); // do falangi: skąd leci
            }
          }
        }
        GM_setValue(this.KEY_EVENTS, JSON.stringify(out));
      } finally {
        this._evFetching = false;
      }
    },

    state() {
      try { return JSON.parse(GM_getValue(this.KEY, "null")); } catch { return null; }
    },

    // An alert goes stale on its own: if we stop seeing foreign fleets for
    // 10 minutes the danger either landed or turned around.
    // ── v2.36.0: brak odczytu to „nie wiem", a nie „bezpiecznie" ──
    // Alarm wygasał po 10 minutach od ostatniego WIDZENIA obcych flot. Znacznik
    // odświeża się tylko przy udanym odczycie, więc każda ślepota — jitter do
    // 15 minut, strona bez paska misji — zdejmowała alarm SAMA. Skutek był
    // gorszy niż brak obrony: atak przeczekiwał alarm, a auto-powrót ściągał
    // flotę z refugium prosto pod uderzenie.
    //
    // Alarm zdejmuje teraz WYŁĄCZNIE potwierdzony odczyt „zero obcych" (gałąź
    // niżej w check(), która czyści stan). Sam upływ czasu go nie zdejmie.
    // BACKSTOP_MS istnieje tylko po to, żeby trwała ślepota nie zamroziła
    // farmienia i ekspedycji na zawsze — to bezpiecznik, nie normalna droga.
    BACKSTOP_MS: 3 * 60 * 60 * 1000,
    active() {
      const s = this.state();
      if (!s || !(s.count > 0)) return false;
      if (Date.now() - (s.firstAt || s.seenAt) > this.BACKSTOP_MS) return false;
      return true;
    },

    clear() { GM_setValue(this.KEY, "null"); },

    // Reads the mission bar of whatever page we're on. Returns null when the
    // bar isn't rendered (most galaxy pages) so a blind page never clears a
    // live alert.
    read() {
      const m = document.body.textContent.match(/(\d+)\s*Missions?:\s*(\d+)\s*Own/);
      if (!m) return null;
      const total = parseInt(m[1]) || 0;
      const own = parseInt(m[2]) || 0;
      return { total, own, foreign: Math.max(0, total - own) };
    },

    // One-time markup capture so Stage 2 can be written from facts:
    // the event rows (what a hostile row looks like, its target, its ETA) and
    // the base planet's galaxy row (the moon link + its mission id).
    // v2.16.2: `force` lets the Fleet Recon button capture the events table on
    // demand, from OUR OWN fleets. Waiting for a hostile fleet to learn the
    // table's shape means Stage 2 can't be written until the day it's needed —
    // the one day nobody wants to be debugging selectors.
    // ── v2.38.0: zrzucaj tabelę Events z ŻYWEJ strony, nie z fetcha ──
    // Fetch /ajax/fleet/eventlist zwracał stronę błędu (log 09:24:21 — sam CSS
    // i #error-container), więc markup zdarzeń nigdy nie został złapany. A ta
    // tabela JEST w DOM na stronie floty: widać ją na zrzucie właściciela,
    // z wierszami „Yoyoyoyoyo [3:269:8] … Asteroid [3:161:17]".
    //
    // To jest markup, od którego zależy ochrona WSZYSTKICH planet: pasek misji
    // podaje tylko LICZBĘ obcych flot, nigdy celu. Bez wiersza zdarzenia nie da
    // się powiedzieć, którą kolonię trzeba ewakuować — a zgadywanie ruszałoby
    // flotą na chybił trafił.
    dumpEventsFromDom() {
      if (GM_getValue(this.KEY_DUMPED, "") === "1") return;
      // v2.38.1: selektor [class*='event'] złapał SVG z wykresu — w logu
      // właściciela wylądowało `<rect class="c3-event-rect...">` zamiast tabeli
      // zdarzeń. Szukamy teraz po TREŚCI, tak jak przy raportach z wiadomości:
      // wiersz zdarzenia zawsze niesie koordynaty w nawiasach kwadratowych,
      // a wykres nigdy. Bierzemy NAJGŁĘBSZY element z co najmniej dwoma
      // koordynatami — czyli sam blok zdarzeń, bez pół strony dookoła.
      const COORD = /\[\d+:\d+:\d+\]/g;
      const isRow = (t) => ((t || "").match(COORD) || []).length >= 2;
      // Nie „najgłębszy z koordynatami" — to wybiera POJEDYNCZY wiersz zamiast
      // całej tabeli. Chcemy element o NAJWIĘKSZEJ liczbie koordynatów (czyli
      // obejmujący wszystkie wiersze), a przy remisie najkrótszy, żeby dostać
      // sam blok zdarzeń, a nie pół strony dookoła niego.
      // v2.39.1: lista skrotow planet ("Colony 1 [7:499:6]" ... 60 pozycji)
      // bila kazda tabele zdarzen na liczbe koordynatow i to ona ladowala
      // w logu. Zdarzenie ma godzine przylotu i typ misji; lista skrotow nie ma
      // ani jednego, ani drugiego — i siedzi w <select>.
      const MISSION = /(attack|transport|deploy|expedition|espionage|colonis|harvest|recycl|return|destroy)/i;
      const hasClock = (t) => /\d{1,2}:\d{2}:\d{2}/.test(String(t).replace(/\[\d+:\d+:\d+\]/g, " "));
      const cand = [...document.querySelectorAll("div, table, tbody, section, ul")]
        .filter(el => {
          if (el.closest("svg") || /c3-|chart|graph/i.test(String(el.className || ""))) return false;
          if (el.tagName === "SELECT" || el.querySelector("select, option")) return false;
          const t = el.textContent || "";
          if (!(t.length <= 8000 && isRow(t))) return false;
          return hasClock(t) || MISSION.test(t);
        })
        .map(el => ({ el, n: ((el.textContent || "").match(COORD) || []).length, len: (el.textContent || "").length }))
        .sort((a, b) => (b.n - a.n) || (a.len - b.len));
      if (!cand.length) return;
      const host = cand[0].el;
      const html = (host.innerHTML || "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\s+/g, " ").trim();
      if (html.length < 60) return;
      GM_setValue(this.KEY_DUMPED, "1");
      log(`[THREAT DOM] blok zdarzeń (${html.length}ch): ${html.slice(0, 2500)}`, "error");
      ThreatLog.add("odczyt", "Zrzucono markup bloku zdarzeń — potrzebny do ochrony wszystkich planet.");
    },

    async dumpMarkupOnce(force = false) {
      if (force) GM_setValue(this.KEY_DUMPED, "");
      this.dumpEventsFromDom();
      if (GM_getValue(this.KEY_DUMPED, "") === "1" || this._fetching) return;
      this._fetching = true;
      try {
        for (const url of ["/ajax/fleet/eventlist", "/ajax/fleet/eventbox"]) {
          try {
            const res = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
            if (!res.ok) continue;
            const txt = (await res.text()).replace(/\s+/g, " ").trim();
            if (!txt || /error-container|<style/i.test(txt.slice(0, 400))) continue; // strona błędu, nie zdarzenia
            log(`[THREAT DOM] ${url}: ${txt.slice(0, 1500)}`, "error");
            GM_setValue(this.KEY_DUMPED, "1");
            break;
          } catch {}
        }
      } finally {
        this._fetching = false;
      }
    },

    // The moon link lives in the base planet's galaxy row. Captured whenever
    // we happen to be on the base system's galaxy page — no extra navigation.
    // v2.16.2: the passive version below only fires while STANDING on the base
    // system's galaxy page — and the scanner never goes there (base [3:269],
    // asteroid ranges [3:51-160]). So the one markup Stage 2 depends on would
    // have sat uncaptured forever. Fetch it once instead: a single request,
    // ever, guarded by the same key.
    // v2.17.2: fallback when the fetch can't see the table — go there ONCE for
    // real. The scan state machine already recovers from being sent elsewhere
    // ("Scan stranded off galaxy page. Resuming at …"), so this costs one page
    // load. Only fires while nothing is in progress.
    maybeVisitBaseForMoon() {
      if (MoonSave.armed()) return false;
      if (GM_getValue("ogamex_moon_fetch_dead", "") !== "1") return false; // fetch path still has a chance
      // v2.25.0: retry with a cooldown instead of "one visit, ever". A single
      // failed visit used to close the only remaining path permanently.
      const nextTry = parseInt(GM_getValue("ogamex_moon_visit_at", "0")) || 0;
      if (Date.now() < nextTry) return false;
      GM_setValue("ogamex_moon_visit_at", String(Date.now() + 30 * 60 * 1000));
      const base = CONFIG.asteroidMining.minerBase;
      if (!base || !CONFIG.enabled) return false;
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") return false;
      if (ScanState.load()?.active) return false; // never interrupt a running sweep
      if (AsteroidMiner.running || InactiveFarmer.running || ExpeditionRunner.running) return false;
      log(`[MOON DOM] visiting [${base.galaxy}:${base.system}] once to read the base row (fleet-save target).`, "info");
      scanNavigate(`/galaxy?x=${base.galaxy}&y=${base.system}`, "moon recon");
      return true;
    },

    async fetchBaseRowOnce() {
      if (MoonSave.armed() || this._fetchingMoon) return;
      if (GM_getValue("ogamex_moon_fetch_dead", "") === "1") return; // proven useless here
      const base = CONFIG.asteroidMining.minerBase;
      if (!base) return;
      this._fetchingMoon = true;
      try {
        const res = await fetch(`/galaxy?x=${base.galaxy}&y=${base.system}`, { headers: { "X-Requested-With": "XMLHttpRequest" } });
        if (!res.ok) return;
        const html = await res.text();
        if (/login|password/i.test(html.slice(0, 500))) return; // session page, not galaxy
        const doc = new DOMParser().parseFromString(html, "text/html");
        for (const item of doc.querySelectorAll(".galaxy-item")) {
          const idx = item.querySelector(".planet-index");
          if (!idx || idx.textContent.trim() !== String(base.position)) continue;
          if (GM_getValue("ogamex_moon_markup_dumped_v2253", "") !== "1") {
            GM_setValue("ogamex_moon_markup_dumped_v2253", "1");
            log(`[MOON DOM] base row [${base.galaxy}:${base.system}:${base.position}]: ${item.innerHTML.replace(/\s+/g, " ").trim().slice(0, 1200)}`, "info");
          }
          // v2.17.0: same row carries the moon link the fleet-save needs.
          MoonSave.learnFromRow(item, `${base.galaxy}:${base.system}:${base.position}`);
          MoonSave.resumeAfterLearn();
          return;
        }
        // v2.17.2: the fetched galaxy page comes back WITHOUT .galaxy-item rows
        // (the table is rendered client-side), so this path can't learn the
        // moon link at all. Count the failures, give up after two, and hand
        // over to the navigate-once fallback — the old code only set the
        // one-shot flag on SUCCESS, so it re-fetched on every scheduler tick
        // and spammed the log (seen live at 16:15:57, 16:16:00, 16:17:15).
        const tries = (parseInt(GM_getValue("ogamex_moon_fetch_tries", "0")) || 0) + 1;
        GM_setValue("ogamex_moon_fetch_tries", String(tries));
        if (tries >= 2) {
          GM_setValue("ogamex_moon_fetch_dead", "1");
          log(`[MOON DOM] fetched galaxy page has no rows (${tries} tries) — switching to a one-off visit to [${base.galaxy}:${base.system}] when the bot is idle.`, "warn");
        } else {
          log(`[MOON DOM] base row ${base.position} not found in the fetched galaxy page — the AJAX shape differs from the rendered one.`, "warn");
        }
      } catch (e) {
        log(`[MOON DOM] fetch failed: ${e.message}`, "warn");
      } finally {
        this._fetchingMoon = false;
      }
    },

    // v2.25.0: the goal is the LINK, not the dump. All three learning paths
    // used to stop at `ogamex_moon_markup_dumped_v2253 === "1"`, which is set the
    // moment the row is printed to the log — whether or not a moon link was
    // found in it. One unlucky dump therefore disabled moon-learning forever,
    // and the fleet-save button was left telling the owner to "press Fleet
    // Recon", which reads the FLEET page and can never learn a galaxy row.
    // That is the whole reason the save has been unusable.
    dumpBaseRowOnce() {
      if (MoonSave.armed()) return;
      if (GameState.getCurrentPage() !== "galaxy") return;
      const base = CONFIG.asteroidMining.minerBase;
      if (!base) return;
      const url = window.location.href;
      const gx = url.match(/[?&]x=(\d+)/);
      const sy = url.match(/[?&]y=(\d+)/);
      if (!gx || !sy || parseInt(gx[1]) !== base.galaxy || parseInt(sy[1]) !== base.system) return;
      for (const item of document.querySelectorAll(".galaxy-item")) {
        const idx = item.querySelector(".planet-index");
        if (!idx || idx.textContent.trim() !== String(base.position)) continue;
        // Learn on EVERY visit until armed; dump the markup only once.
        if (GM_getValue("ogamex_moon_markup_dumped_v2253", "") !== "1") {
          GM_setValue("ogamex_moon_markup_dumped_v2253", "1");
          log(`[MOON DOM] base row [${base.galaxy}:${base.system}:${base.position}]: ${item.innerHTML.replace(/\s+/g, " ").trim().slice(0, 900)}`, "info");
        }
        MoonSave.learnFromRow(item, `${base.galaxy}:${base.system}:${base.position}`);
        MoonSave.resumeAfterLearn();
        return;
      }
    },

    check({ emergencyOnly = false } = {}) {
      if (!CONFIG.threatAlarm?.enabled) return;
      // These three LEARN (and the last one navigates). Skipped while the bot
      // is on a humanizer break or in the night window — the mission-bar read
      // below still runs, because that is the part an attack depends on.
      // v2.38.3: zrzut zdarzeń to CZYSTY odczyt DOM — zero nawigacji, zero
      // zapytań. Nie ma powodu, żeby stał za bramką przerwy, a stał: właściciel
      // zaktualizował bota w trakcie 13-minutowej przerwy na kawę, więc
      // emergencyOnly było prawdą i zrzut nie ruszył ani razu. Wygląda to
      // z zewnątrz jak „nic się nie zmieniło".
      this.dumpEventsFromDom();
      if (!emergencyOnly) {
        this.dumpBaseRowOnce();
        this.fetchBaseRowOnce().catch(() => {}); // one-shot, no-op once captured
        this.maybeVisitBaseForMoon(); // only if the fetch path proved blind
      }

      // ── v2.40.0: pierwszeństwo ma odczyt z serwera ──
      // Pasek misji zostaje wyłącznie jako awaryjne źródło: gdy eventbox nie
      // odpowiedział albo gdy listy zdarzeń nie da się sklasyfikować.
      const bar = this.read();
      const ev = this.events();
      const evFresh = ev && Date.now() - ev.at < this.EVENT_MAX_AGE_MS;
      let r = bar, evSrc = "";
      if (evFresh && ev.classified) {
        r = { total: bar?.total ?? 0, own: bar?.own ?? 0, foreign: ev.attacks };
        evSrc = `zdarzenia: ataki ${ev.attacks}${ev.spies ? `, sondy ${ev.spies} (IGNORUJĘ)` : ""}`
          + (ev.targets?.length ? ` → cel: ${ev.targets.join(", ")}` : "");
      } else if (evFresh && ev.hostile > 0) {
        r = { total: bar?.total ?? 0, own: bar?.own ?? 0, foreign: ev.hostile };
        evSrc = `zdarzenia BEZ klasyfikacji: ${ev.hostile} obcych (typu misji nie dało się odczytać — traktuję jak atak)`;
      }
      // ── v2.29.0: powiedz, CO właściwie odczytałeś ──
      // 2026-08-01 23:30:20 obca flota (KARAGUMRUK z [3:307:7]) doleciała pod
      // planetę właściciela i zrobiła skan. Bot tykał o 23:30:38, :41 i :47 —
      // i nie napisał ani słowa. Nie dało się rozstrzygnąć, czy pasek pokazał
      // ZERO obcych, czy paska w ogóle nie było na tej stronie, bo obie ścieżki
      // milczały tak samo. Alarm bez śladu odczytu jest niesprawdzalny: nie
      // wiadomo, czy działa, dopóki nie zawiedzie na prawdziwym ataku.
      // Log jest dławiony do jednej linii na 10 min ORAZ przy każdej zmianie,
      // więc nie zaśmieca, a zostawia dowód.
      {
        const now = Date.now();
        const seen = evSrc ? evSrc
          : r ? `${r.total} misji / ${r.own} własnych → ${r.foreign} obcych`
          : "BRAK PASKA MISJI na tej stronie";
        const lastSeen = GM_getValue(this.KEY_SEEN, "");
        const lastAt = parseInt(GM_getValue(this.KEY_SEEN_AT, "0")) || 0;
        if (seen !== lastSeen || now - lastAt > 10 * 60 * 1000) {
          GM_setValue(this.KEY_SEEN, seen);
          GM_setValue(this.KEY_SEEN_AT, String(now));
          log(`[THREAT] odczyt: ${seen}${r ? "" : " (na tej stronie alarm jest ślepy)"}`, r && r.foreign > 0 ? "error" : "info");
          // Do dziennika trafia KAŻDY odczyt — także zerowy. Bez dowodu, że bot
          // patrzył i widział zero, nie da się później odróżnić „nie wykrył" od
          // „nie patrzył", a to dwie różne naprawy.
          ThreatLog.add(r && r.foreign > 0 ? "ATAK" : (r ? "odczyt" : "ŚLEPY"),
            `${seen}${r ? "" : ` | strona: ${location.pathname}`}`);
        }
      }
      if (!r) return; // no mission bar on this page — say nothing, change nothing
      const prev = this.state();

      // ── v2.32.0: POTWIERDŹ, zanim ruszysz flotą ──
      // 2026-08-02 09:24:14 bot wysłał własną falę ekspedycji. Sześć sekund
      // później pasek pokazał „19 misji / 18 własnych" — jedna „obca". O 09:24:20
      // ruszył pełny ratunek KSIĘŻYC → PLANETĘ, o 09:24:31 alarm sam zgasł
      // („18/18 → 0 obcych"). Nikt nie atakował: gra dolicza wysłaną flotę do
      // sumy, zanim dopisze ją do „Own", więc bot zobaczył własny statek jako
      // wroga i ewakuował całą gospodarkę. Potem próbował wracać i wpadł
      // w pętlę nieudanych powrotów.
      //
      // Atak leci minutami, więc kilkadziesiąt sekund na potwierdzenie nic nie
      // kosztuje, a odróżnia prawdziwego gościa od własnego cienia:
      //   • odczyt w ciągu SELF_SEND_BLIND_MS od NASZEJ wysyłki jest ignorowany
      //     (pasek jest w trakcie aktualizacji),
      //   • obce floty muszą utrzymać się przez CONFIRM_MS, zanim podniesiemy
      //     alarm.
      const lastOwnSend = Math.max(
        parseInt(GM_getValue("ogamex_last_dispatch_at", "0")) || 0,
        (() => { try { return JSON.parse(GM_getValue("ogamex_expo_state", "null"))?.lastSendAt || 0; } catch { return 0; } })()
      );
      if (r.foreign > 0 && Date.now() - lastOwnSend < this.SELF_SEND_BLIND_MS) {
        ThreatLog.add("odczyt", `${r.foreign} „obcych" tuż po NASZEJ wysyłce (${Math.round((Date.now() - lastOwnSend) / 1000)}s) — to własna flota w trakcie dopisywania do paska. Ignoruję.`);
        return;
      }
      if (r.foreign > 0) {
        const pendingSince = parseInt(GM_getValue(this.KEY_CANDIDATE, "0")) || 0;
        if (!pendingSince) {
          GM_setValue(this.KEY_CANDIDATE, String(Date.now()));
          log(`[THREAT] ${r.foreign} obcą flotę widzę pierwszy raz — potwierdzam przez ${Math.round(this.CONFIRM_MS / 1000)}s, zanim ruszę flotą.`, "warn");
          ThreatLog.add("odczyt", `Kandydat na alarm: ${r.foreign} obcych (${r.own}/${r.total}). Czekam na potwierdzenie ${Math.round(this.CONFIRM_MS / 1000)}s.`);
          return;
        }
        if (Date.now() - pendingSince < this.CONFIRM_MS) return; // jeszcze się nie potwierdziło
        const first = !prev || !(prev.count > 0);
        GM_setValue(this.KEY, JSON.stringify({
          count: r.foreign,
          total: r.total,
          own: r.own,
          seenAt: Date.now(),
          firstAt: first ? Date.now() : (prev.firstAt || Date.now()),
        }));
        if (first || r.foreign !== prev.count) {
          log(`INCOMING: ${r.foreign} foreign fleet(s) in the mission bar (${r.own} of ${r.total} are ours). Farming and expedition waves are on hold — CHECK THE GAME.`, "error");
          ThreatLog.add("ATAK", `WYKRYTO ${r.foreign} obcą/obce flotę/floty (${r.own} z ${r.total} to nasze). Farmienie i fale ekspedycji wstrzymane.`);
          this.dumpMarkupOnce().catch(() => {});
          this.notify(r.foreign);
        }
      } else if (prev && prev.count > 0) {
        GM_setValue(this.KEY_CANDIDATE, "0");
        log("Incoming fleets gone — threat alert cleared.", "success");
        ThreatLog.add("koniec", "Obce floty zniknęły z paska misji — alarm zdjęty.");
      } else if (r.foreign === 0 && (parseInt(GM_getValue(this.KEY_CANDIDATE, "0")) || 0)) {
        // Kandydat zgasł, zanim się potwierdził — dokładnie ten przypadek, który
        // 2 sierpnia wyewakuował flotę bez powodu. Zostawiamy ślad w dzienniku.
        const held = Math.round((Date.now() - (parseInt(GM_getValue(this.KEY_CANDIDATE, "0")) || 0)) / 1000);
        GM_setValue(this.KEY_CANDIDATE, "0");
        log(`[THREAT] niepotwierdzony kandydat zniknął po ${held}s — flota NIE była ruszana.`, "info");
        ThreatLog.add("odczyt", `Kandydat zniknął po ${held}s bez potwierdzenia — flota nietknięta.`);
        this.clear();
      }
      updateStatusUI();
    },

    // Desktop notification if the user already granted it (we ask once, from
    // the toggle — never unprompted mid-scan).
    notify(count) {
      try {
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
        new Notification("OGameX: obca flota w drodze", {
          body: `${count} obcych flot w pasku misji na ${location.host}. Sprawdź grę.`,
          tag: "ogamex-threat",
        });
      } catch {}
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  MOON SAVE  (v2.17.0) — Stage 2 of fleet-save
  // ═══════════════════════════════════════════════════════════════
  // Lifts EVERYTHING off the base planet — every ship plus every resource —
  // onto our own moon at the same coordinates. Works because the attacker
  // picks the target when the fleet launches and cannot re-aim mid-flight:
  // planet and moon at [3:269:8] are two separate bodies. Flight is a couple
  // of minutes, so it still beats an attack landing in three.
  //
  // WHAT IS AND ISN'T AUTOMATIC, deliberately:
  //   • the SAVE itself is written and usable now, by button;
  //   • the AUTOMATIC trigger stays off until the events table has been seen,
  //     because "someone is flying at us" (mission bar: total > own) does not
  //     distinguish an attack from an espionage probe, and probes are the
  //     normal prelude to nothing. Launching the entire economy on every probe
  //     costs an hour of mining for no reason. ThreatMonitor dumps that markup
  //     on the first sighting / on demand from Fleet Recon; classification
  //     lands after, not before.
  //
  // Nothing here is guessed. The moon URL is learned from the base planet's
  // own galaxy row, exactly like the expedition link was — where the obvious
  // assumption (mission=15) turned out to be wrong (mission=1).

  // v2.20.0 — MULTI-WAVE. Owner's attacker sends several fleets in several
  // waves, and one save is not a plan against that. The hole isn't the fleet
  // we lifted; it's everything that lands on the base planet BETWEEN the
  // waves: 8 expedition waves and up to 3 mining flights come home one at a
  // time, and each one sits on the planet waiting for the next hit. So once a
  // save has been made for a live alert, a watcher keeps the planet empty
  // until the alert clears — re-running the same proven save, which aborts by
  // itself when there is nothing left to lift.
  //
  // The watcher never DECIDES that an attack is real: it only continues what
  // the first save started (button today, classifier later). That keeps the
  // probe-vs-attack question exactly where it belongs.
  //
  // Known limit, worth stating plainly: the moon is a separate target at the
  // same coords, so this dodges waves aimed at the PLANET only. An attacker
  // who splits waves between planet and moon cannot be dodged by moving
  // between them — that needs flying the fleet off-world entirely.
  const MoonSave = {
    KEY_LINK: "ogamex_moon_link",
    KEY_STATE: "ogamex_moonsave_state",
    KEY_WATCH: "ogamex_moonsave_watch",
    MIN_RESAVE_MS: 90 * 1000,   // floor between sweeps: enough for a wave to land
    MAX_SAVES_PER_ALERT: 20,    // stop rather than loop forever on a stuck alert
    running: false,

    // Candidate mission names for "fly there and STAY". The game marks the
    // choices with a class named after the mission (observed live:
    // A.mission-item.EXPEDITION, A.mission-item.ASTEROID_MINING), so we match
    // on that and log everything available when none fits — no silent wrong pick.
    // v2.26.0: owner's own screenshot of step 3 settles this — the game offers
    // Transport / Deploy / Collect, and "Deploy" is the one that flies there
    // and STAYS. It leads the list now; TRANSPORT survives only as a last
    // resort (it unloads and comes home, see the warning where it's picked).
    MISSION_CANDIDATES: ["DEPLOY", "DEPLOYMENT", "STATION", "STATIONING", "TRANSPORT"],

    link() {
      try { return JSON.parse(GM_getValue(this.KEY_LINK, "null")); } catch { return null; }
    },

    // The fleet form takes COORDINATES and lets step 2 choose planet / moon /
    // debris for them. So the target was never a link to be learned from the
    // galaxy row — it's the base's own coordinates plus a click on step 2.
    // Three releases were spent hunting a link that this build does not have.
    // ── v2.38.0: ratunek działa na DOWOLNYCH koordynatach ──
    // Właściciel postawił księżyce przy każdej planecie i chce, żeby atak na
    // kolonię przenosił jej flotę na jej własny księżyc — te same koordy, wybór
    // „moon", misja stacjonowania. Mechanika jest identyczna jak na bazie, więc
    // jedyne, co było zaszyte na sztywno, to koordynaty.
    // Brak argumentu = baza, czyli dotychczasowe zachowanie bez zmian.
    coordsOf(where) {
      const b = where || CONFIG.asteroidMining.minerBase;
      if (!b || !Number.isFinite(b.galaxy) || !Number.isFinite(b.system)) return null;
      return b;
    },
    targetUrl(where) {
      const b = this.coordsOf(where);
      if (!b) return null;
      return `/fleet?x=${b.galaxy}&y=${b.system}&z=${b.position}`;
    },

    // v2.28.0: which body is active right now — the one a fleet would launch
    // from, and therefore the one the ships are sitting on. The sidebar marks
    // it: a moon carries .moon-select.selected, a planet .planet-select.selected.
    // Verified live on 2026-08-01 (18:51 dump listed A.moon-select.selected
    // while the planet entry had lost its .selected class).
    // null = page has no sidebar; callers fall back rather than guess.
    // ── v2.55.0: przełączanie na atakowaną kolonię ──
    // Formularz floty wysyła z planety AKTYWNEJ. Bez tego kroku ratunek innej
    // kolonii wysyłałby flotę Z BAZY (błąd 2.52.0, cofnięty w 2.52.1).
    //
    // Adresu przełączania NIE zgaduję: klikam kotwicę kolonii na liście planet,
    // dokładnie tak jak człowiek. Klik działa niezależnie od tego, czy pod
    // spodem jest href, czy obsługa w JS.
    KEY_SWITCH: "ogamex_moonsave_switch",

    // Koordynaty ciała aktualnie wybranego w liście planet.
    activeCoords() {
      const sel = document.querySelector("a.planet-select.selected, a.moon-select.selected, .planet-select.selected, .moon-select.selected");
      const row = sel?.closest("li, div, tr") || sel?.parentElement;
      const m = String(row?.textContent || "").match(/(\d+:\d+:\d+)/);
      return m ? m[1] : null;
    },

    // Kotwica planety o danych koordynatach (nie księżyca — wysyłamy Z planety).
    planetAnchor(coords) {
      for (const a of document.querySelectorAll("a.planet-select, .planet-select")) {
        const row = a.closest("li, div, tr") || a.parentElement;
        if (!row) continue;
        if (!String(row.textContent || "").includes(coords)) continue;
        return a;
      }
      return null;
    },

    // Zwraca true, gdy kliknięto (strona się przeładuje i ratunek wznowi się
    // z zapamiętanego stanu). false = nie znaleziono kolonii → NIE ruszamy floty.
    switchTo(coords, reason) {
      const a = this.planetAnchor(coords);
      if (!a) {
        log(`[RATUNEK] nie znajduję kolonii [${coords}] na liście planet — NIE ruszam floty. Reaguj ręcznie.`, "error");
        ThreatLog.add("BŁĄD", `Kolonii [${coords}] nie ma na liście planet — ewakuacja przerwana, flota nietknięta.`);
        return false;
      }
      GM_setValue(this.KEY_SWITCH, JSON.stringify({ coords, at: Date.now(), reason: reason || "atak" }));
      log(`[RATUNEK] przełączam się na [${coords}], żeby wysłać flotę Z TEJ kolonii.`, "warn");
      ThreatLog.add("RATUNEK", `Przełączam aktywną planetę na [${coords}] — wysyłka musi wyjść z atakowanej kolonii.`);
      a.click();
      return true;
    },

    // Po przeładowaniu: jeśli jesteśmy tam, gdzie mieliśmy być, dokończ ratunek.
    resumeAfterSwitch() {
      let st = null;
      try { st = JSON.parse(GM_getValue(this.KEY_SWITCH, "null")); } catch {}
      if (!st?.coords) return false;
      if (Date.now() - (st.at || 0) > 90 * 1000) { GM_setValue(this.KEY_SWITCH, "null"); return false; }
      const now = this.activeCoords();
      if (!now || now !== st.coords) return false; // jeszcze nie tu — poczekaj
      GM_setValue(this.KEY_SWITCH, "null");
      const [g, sy, pos] = st.coords.split(":").map(Number);
      log(`[RATUNEK] jestem na [${st.coords}] — wysyłam flotę i surowce na drugie ciało.`, "warn");
      this.run({ auto: true, where: { galaxy: g, system: sy, position: pos }, reason: st.reason || "atak" })
        .catch(err => log(`[RATUNEK] błąd po przełączeniu: ${err.message}`, "error"));
      return true;
    },

    currentBody() {
      if (document.querySelector(".moon-select.selected, a.moon-select.selected")) return "moon";
      if (document.querySelector(".planet-select.selected, a.planet-select.selected")) return "planet";
      return null;
    },
    armed() { return !!this.targetUrl(); },

    state() {
      try { return JSON.parse(GM_getValue(this.KEY_STATE, "null")) || {}; } catch { return {}; }
    },
    saveState(s) { GM_setValue(this.KEY_STATE, JSON.stringify(s)); },

    // Called with the base planet's galaxy row (from either dump path). The
    // moon column holds the link; we keep whatever the game itself points at.
    learnFromRow(rowEl, coordLabel) {
      if (this.armed() || !rowEl) return null;
      const moonCol = rowEl.querySelector(".col-moon, .galaxy-col.col-moon");
      const candidates = [
        ...(moonCol ? moonCol.querySelectorAll("a[href]") : []),
        ...rowEl.querySelectorAll("a[href*='moon'], a[href*='type=moon'], a[href*='isMoon']"),
      ];
      const a = candidates.find(el => /\/fleet/i.test(el.getAttribute("href") || ""))
             || candidates.find(el => (el.getAttribute("href") || "").length > 1);
      if (!a) {
        // v2.25.3: this used to fail SILENTLY, which is why the fleet save sat
        // "cel nieznany" through two visits to the base system with nothing in
        // the log to explain it. Say what was actually in the row.
        const moonCol = rowEl.querySelector(".col-moon, .galaxy-col.col-moon");
        log(`[MOON SAVE] wiersz bazy znaleziony, ale BEZ linku do księżyca. Kolumna moon: ${moonCol ? `"${(moonCol.innerHTML || "").replace(/\s+/g, " ").trim().slice(0, 200) || "PUSTA"}"` : "brak kolumny"} | wszystkich linków w wierszu: ${rowEl.querySelectorAll("a[href]").length}`, "warn");
        return null;
      }
      const href = a.getAttribute("href");
      const learned = { href, at: Date.now(), coord: coordLabel || null };
      GM_setValue(this.KEY_LINK, JSON.stringify(learned));
      log(`[MOON SAVE] moon target learned from the galaxy row: ${href}`, "success");
      updateStatusUI();
      return learned;
    },

    // One save per emergency. Without this the scheduler would re-fire every
    // tick and keep bouncing the fleet between planet and moon.
    recentlySaved() {
      const st = this.state();
      return !!(st.at && Date.now() - st.at < 15 * 60 * 1000);
    },

    // ── v2.21.0: the proof gate for unattended saving ──
    KEY_PROOF: "ogamex_moonsave_proven",
    proven() {
      try { return JSON.parse(GM_getValue(this.KEY_PROOF, "null")); } catch { return null; }
    },
    proveMission(name, cls) {
      if (this.proven()?.name === name) return;
      GM_setValue(this.KEY_PROOF, JSON.stringify({ name, cls, at: Date.now() }));
      log(`[MOON SAVE] misja stacjonowania potwierdzona na żywo: ${name} (${cls}). Automatyczny ratunek jest od teraz uzbrojony.`, "success");
      updateStatusUI();
    },

    // Where the fleet goes home to. The moon href is LEARNED from the galaxy
    // row; the planet side is the base coords with planet=1 — the same shape
    // the farm module has been sending on for months, so it isn't a guess
    // either. The mission is picked on step 3 exactly like the outbound save.
    homeUrl(where) {
      return this.targetUrl(where); // krok 2 wybiera ciało; koordy te same
    },

    // v2.25.0: the button used to dead-end on "press Fleet Recon first" —
    // advice that cannot work, because Fleet Recon reads the fleet page and
    // the moon link lives in the base system's GALAXY row. Now the button
    // fetches what it needs itself: go to that galaxy page, learn, and carry
    // on with the save the operator actually asked for.
    KEY_RESUME: "ogamex_moonsave_resume",

    async learnThenSave(reason) {
      const b = CONFIG.asteroidMining.minerBase;
      if (!b) { log("[MOON SAVE] nie znam planety bazowej — ustaw ją najpierw.", "error"); return false; }
      GM_setValue(this.KEY_RESUME, JSON.stringify({ at: Date.now(), reason }));
      log(`[MOON SAVE] cel księżyca nieznany — wchodzę na galaktykę [${b.galaxy}:${b.system}], żeby go odczytać, i wracam dokończyć ratunek.`, "warn");
      await AntiDetection.sleep(300 + Math.random() * 400);
      window.location.href = `/galaxy?x=${b.galaxy}&y=${b.system}`;
      return true;
    },

    // Called right after a successful learn on the base galaxy row.
    resumeAfterLearn() {
      let r = null;
      try { r = JSON.parse(GM_getValue(this.KEY_RESUME, "null")); } catch {}
      if (!r || !this.armed()) return;
      GM_setValue(this.KEY_RESUME, "null");
      if (Date.now() - (r.at || 0) > 30 * 60 * 1000) return; // too old to be "the click"
      log("[MOON SAVE] cel księżyca nauczony — dokańczam ratunek, o który prosiłeś.", "success");
      setTimeout(() => { this.run({ manual: true, reason: r.reason || "ręcznie (po nauce celu)" }).catch(() => {}); }, 1200);
    },

    watch() {
      try { return JSON.parse(GM_getValue(this.KEY_WATCH, "null")) || {}; } catch { return {}; }
    },
    saveWatch(w) { GM_setValue(this.KEY_WATCH, JSON.stringify(w)); },
    disarm(why) {
      const w = this.watch();
      if (!w.armed) return;
      GM_setValue(this.KEY_WATCH, "null");
      log(`[MOON SAVE] straż wyłączona (${why}) — planeta znów pracuje normalnie. Zapisów w tym alarmie: ${w.saves || 0}.`, "info");
      updateStatusUI();
    },

    // v2.21.0 — the automatic trigger. Fires on ANY foreign fleet, on purpose:
    // telling an attack from a probe needs the events table we still haven't
    // captured, and waiting for that means the fleet is unprotected every
    // night in the meantime. Reacting to both is the safe error, because
    // returnHome() bounds what a false alarm costs.
    async autoSaveOnThreat() {
      if (!CONFIG.enabled || !CONFIG.threatAlarm?.enabled || !CONFIG.threatAlarm?.autoSave) return false;
      if (!ThreatMonitor.active()) return false;
      if (this.watch().armed) return false;      // already saving for this alert
      if (this.running) return false;
      // v2.25.1: neither gate REFUSES any more. Both used to abort the save —
      // the fleet stayed on the planet while the bot explained what the owner
      // should have clicked earlier. That is the wrong trade under attack: a
      // save that goes wrong costs a page load and a fleet sitting on the moon
      // instead of the planet, while not saving costs the fleet.
      if (!this.armed()) {
        this._sayOnce("nolink", "[MOON SAVE] ATAK — celu księżyca jeszcze nie znam, wchodzę na galaktykę bazy, odczytuję go i od razu ratuję flotę.");
        ThreatLog.add("ATAK", "Automat rusza, ale celu jeszcze nie znam — wchodzę na galaktykę bazy po niego.");
        return this.learnThenSave("AUTOMAT: atak, cel doczytany w locie");
      }
      if (!this.proven()) {
        this._sayOnce("noproof", "[MOON SAVE] ATAK — misji stacjonowania nikt jeszcze nie potwierdził ręcznym ratunkiem. RATUJĘ MIMO TO i wypiszę wybraną misję niżej. SPRAWDŹ W GRZE, czy flota siedzi na księżycu.");
      }
      // ── v2.52.0: ratuj TĘ kolonię, na którą leci atak ──
      // Do 2.51.0 ewakuacja zawsze ruszała bazę, bo pasek misji nie podawał
      // celu. Lista ruchów flot podaje go wprost, więc trzymanie się bazy jest
      // teraz wprost szkodliwe: ruszałoby flotę tam, gdzie nic nie leci,
      // i zostawiało atakowaną kolonię bez reakcji.
      const ev = ThreatMonitor.events();
      const target = ev?.attacks > 0 ? (ev.targets || [])[0] : null;
      let where = null;
      if (target) {
        const [g, sy, pos] = String(target).split(":").map(Number);
        if (Number.isFinite(g) && Number.isFinite(sy) && Number.isFinite(pos)) where = { galaxy: g, system: sy, position: pos };
      }
      // ── v2.52.1: BEZ przełączania planety `where` jest niebezpieczne ──
      // MoonSave buduje tylko adres CELU; formularz floty wysyła z planety
      // AKTYWNEJ w danej chwili. Przy ataku na obcą kolonię 2.52.0 wysłałaby
      // więc flotę Z BAZY na księżyc tamtej kolonii — czyli sama wyprowadziłaby
      // flotę z bezpiecznego miejsca. Dopóki nie ma kroku „przełącz się na tę
      // planetę", ratujemy wyłącznie bazę, a o reszcie mówimy wprost.
      // ── v2.55.0: ewakuujemy ciało, na które leci atak ──
      // Warunkiem jest przełączenie się na nie: formularz wysyła z planety
      // AKTYWNEJ, więc bez tego kroku ruszylibyśmy flotę z bazy (błąd 2.52.0).
      if (where) {
        const b = CONFIG.asteroidMining.minerBase;
        const isBase = where.galaxy === b.galaxy && where.system === b.system && where.position === b.position;
        ThreatLog.add("ATAK", `Cel ataku: [${target}]${isBase ? " (baza)" : " — ewakuuję TĘ kolonię"}.`);
        const active = this.activeCoords();
        if (active && active !== target) {
          // Klik przeładuje stronę; ratunek dokończy się w resumeAfterSwitch().
          if (this.switchTo(target, `AUTOMAT: atak na [${target}]`)) return true;
          return false; // kolonii nie ma na liście — świadomie NIE ruszamy floty
        }
      }
      return this.run({
        auto: true,
        where,
        reason: where ? `AUTOMAT: atak na [${target}]` : "AUTOMAT: obca flota w pasku misji",
      });
    },

    _sayOnce(key, msg) {
      this._said = this._said || {};
      if (this._said[key] && Date.now() - this._said[key] < 5 * 60 * 1000) return;
      this._said[key] = Date.now();
      log(msg, "error");
    },

    // v2.21.0 — the other half. Without it a false alarm would park the
    // economy on the moon indefinitely: mining and expeditions both launch
    // from the base planet, so an empty planet earns nothing. The alert clears
    // itself 10min after the last foreign sighting; everything comes back and
    // the bot resumes on its own.
    async returnHome({ byOperator = false } = {}) {
      const w = this.watch();
      // v2.26.2: the operator's own request never needs the guard to be armed.
      // A failed return used to disarm it, which then made this button refuse
      // to try again — the fleet sat on the moon with no way back through the
      // bot at all.
      if (!byOperator && (!w.armed || !w.saves)) return false;
      if (!byOperator) {
        if (!CONFIG.threatAlarm?.autoReturn) return false;
        // v2.25.2: auto-return belongs ONLY to saves the alarm started. A save
        // the operator pressed with a clean mission bar — "I can see something
        // you can't" — would otherwise be undone within one scheduler tick,
        // because ThreatMonitor sees no foreign fleets and calls it over. The
        // bot would be overruling a human decision 90 seconds after it was
        // made. Operator-triggered saves stay until the operator says
        // otherwise (the WRÓĆ NA BAZĘ button).
        if (w.trigger !== "threat") return false;
        if (ThreatMonitor.active()) return false;     // still hostile — stay put
      }
      if (this.running) return false;
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") return false;
      // v2.33.0: druga warstwa na tę samą pętlę. Nawet gdyby rozbrojenie znów
      // gdzieś przepadło, powrót wysłany minutę temu jest w drodze — flota nie
      // stoi już na refugium, więc kolejna próba i tak trafi w pustkę
      // („nothing on this planet to save"). Jeden powrót na 5 minut wystarczy.
      if (w.returning && w.returnAt) {
        const age = Date.now() - w.returnAt;
        // ── v2.35.0: koniec zakleszczenia ──
        // Zapora z v2.33.0 blokowała ponowny powrót przez 5 minut, ale wyjścia
        // ze stanu dodane w v2.34.0 działają DOPIERO w formularzu — do którego
        // ta zapora nie pozwalała dojść. Stan mógł więc sprzątnąć tylko kod,
        // który sam blokował. Log właściciela: „powrót już leci (146s temu)"
        // w kółko, przy flocie od dawna stojącej w domu.
        // Skok planeta↔księżyc na tych samych koordach trwa poniżej minuty,
        // więc powrót sprzed 3 minut jest po prostu ZAKOŃCZONY.
        if (age > 3 * 60 * 1000) {
          ThreatLog.add("POWRÓT", `Powrót wysłany ${Math.round(age / 1000)}s temu — lot na te same koordy trwa <1 min, więc jest po wszystkim. Straż zdjęta.`);
          this.disarm("powrót dawno dolecial — zamykam alarm");
          return false;
        }
        this._sayOnce("returning", `[RATUNEK] powrót już leci (${Math.round(age / 1000)}s temu) — nie wysyłam drugiego.`);
        return false;
      }
      const url = this.homeUrl(w.at);
      if (!url) return false;
      this.running = true;
      try {
        // v2.28.0: home is whatever body the fleet lived on when the alert
        // started; the refuge is the other one. The return therefore has to
        // launch FROM the refuge and target HOME — both read from the watch
        // instead of being hard-wired to moon→planet.
        const home = w.homeBody || "planet";
        const refuge = w.refugeBody || (home === "moon" ? "planet" : "moon");
        GM_setValue("pending_mission", JSON.stringify({
          type: "moon_return_direct",
          moonSave: true,       // identical form handling: all ships, all resources, stationing
          moonReturn: true,
          atCoords: w.at || CONFIG.asteroidMining.minerBase,
          targetBody: home,     // …and this leg flies back to where the fleet lives
          launchBody: refuge,   // …starting from the body it fled to
          fleetUrl: url,
          step: "switch_to_body",
          timestamp: Date.now(),
        }));
        this.saveWatch({ ...w, returning: true, returnAt: Date.now() });
        const nm = (b) => (b === "moon" ? "księżyca" : "planety");
        log(`POWRÓT: alarm minął — ściągam flotę i surowce z ${nm(refuge)} z powrotem na ${home === "moon" ? "księżyc" : "planetę"}.`, "success");
        ThreatLog.add("POWRÓT", `Start: ${refuge === "moon" ? "księżyc" : "planeta"} → ${home === "moon" ? "księżyc" : "planeta"} (${byOperator ? "ręcznie" : "alarm minął"}).`);
        await AntiDetection.sleep(400 + Math.random() * 600);
        return true;
      } catch (err) {
        log(`[MOON SAVE] powrót nieudany: ${err.message}`, "error");
        return false;
      } finally {
        this.running = false;
      }
    },

    // Scheduler hook. Only ever CONTINUES a save the operator (or, later, the
    // classifier) already started; it never starts one. Re-running run() is
    // the whole detection mechanism: the save aborts itself with "nothing on
    // this planet to save" when the hangar is clean, so an empty planet costs
    // one page load and nothing else.
    MAX_ARMED_MS: 60 * 60 * 1000, // v2.34.0: bezpiecznik na zator stanu

    async keepPlanetEmpty() {
      if (!CONFIG.enabled || !CONFIG.threatAlarm?.enabled) return false;
      const w = this.watch();
      if (!w.armed) return false;
      // Ostatnia linia obrony przed zatorem: straż uzbrojona godzinę bez
      // zagrożenia to nie alarm, tylko zapomniany stan. Sama się nie odblokuje,
      // a każde jej odpalenie rusza CAŁĄ flotą.
      if (w.since && Date.now() - w.since > this.MAX_ARMED_MS && !ThreatMonitor.active()) {
        ThreatLog.add("BŁĄD", `Straż była uzbrojona ponad ${Math.round(this.MAX_ARMED_MS / 60000)} min bez zagrożenia — zdejmuję jako zator stanu.`);
        this.disarm("bezpiecznik: uzbrojona zbyt długo bez zagrożenia");
        return false;
      }
      if (!ThreatMonitor.active()) {
        // Don't disarm out from under returnHome() — it needs the armed state
        // to know there is something on the moon to bring back.
        if (CONFIG.threatAlarm?.autoReturn) return false;
        this.disarm("obce floty zniknęły z paska misji");
        return false;
      }
      if (this.running) return false;
      if (Date.now() - (w.lastAt || 0) < this.MIN_RESAVE_MS) return false;
      if ((w.saves || 0) >= this.MAX_SAVES_PER_ALERT) {
        if (!w.capped) { this.saveWatch({ ...w, capped: true }); log(`[MOON SAVE] limit ${this.MAX_SAVES_PER_ALERT} zapisów na alarm osiągnięty — straż stoi. SPRAWDŹ GRĘ.`, "error"); }
        return false;
      }
      ThreatLog.add("STRAŻ", `Zamiatanie nr ${(w.saves || 0) + 1}: sprawdzam, czy coś wróciło na bazę.`);
      return this.run({ sweep: true, reason: "straż wielofalowa — sprzątam planetę" });
    },

    async run({ manual = false, sweep = false, auto = false, reason = "manual", where = null } = {}) {
      if (this.running) return false;
      if (!this.armed()) return this.learnThenSave(reason);
      // A sweep is paced by MIN_RESAVE_MS instead: the 15-minute guard exists
      // to stop a bounce loop, and under multi-wave it would block exactly the
      // re-save the returning fleets need.
      if (!manual && !sweep && !auto && this.recentlySaved()) return false;
      // ── v2.36.0: ratunek WYWŁASZCZA, nie czeka w kolejce ──
      // Dotąd odmawiał, gdy zajęty był wspólny slot pending_mission — a fala
      // ekspedycji startuje co ~70 s i mining dorzuca swoje, więc slot bywa
      // zajęty niemal ciągle. Slot wygasa dopiero po 5 minutach. Rzecz, która
      // ma być najszybsza w całym programie, czekała za rutyną, która może
      // poczekać zawsze.
      // Utrata jednej fali ekspedycji kosztuje minuty. Utrata floty kosztuje
      // wszystko. Porzucone zadanie nie zostawia śmieci: to tylko rekord
      // w pending_mission, który zaraz nadpisujemy, a niedokończony formularz
      // umiera wraz z nawigacją.
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") {
        let kind = "inne zadanie";
        try { kind = JSON.parse(pending)?.type || kind; } catch {}
        log(`[RATUNEK] przerywam trwające zadanie (${kind}) — ratunek floty ma pierwszeństwo.`, "warn");
        ThreatLog.add("RATUNEK", `Wywłaszczenie: przerwane zadanie ${kind}, żeby nie czekać na wolny slot.`);
        GM_setValue("pending_mission", null);
      }
      this.running = true;
      try {
        const at = this.coordsOf(where) || this.coordsOf(this.watch().at);
        const href = this.targetUrl(at);
        // ── v2.28.0: uciekaj na DRUGIE ciało, nie zawsze na księżyc ──
        // Właściciel: „jeśli flota stoi na księżycu i leci atak na księżyc, ma
        // przenieść na planetę i odwrotnie" — i zamierza używać raz jednego,
        // raz drugiego. Okazuje się, że nie trzeba wiedzieć, w co celuje atak:
        // napastnik szpieguje i celuje tam, gdzie WIDZI flotę, więc ucieczka na
        // przeciwne ciało jest właściwa w obu przypadkach. To usuwa zależność
        // od rozpoznania celu, którego nigdy nie udało się potwierdzić.
        const from = this.currentBody() || "planet";
        const to = from === "moon" ? "planet" : "moon";
        const w0 = this.watch();
        GM_setValue("pending_mission", JSON.stringify({
          type: "moon_save_direct",
          moonSave: true,
          atCoords: at,
          targetBody: to,
          homeBody: w0.homeBody || from,
          fleetUrl: href,
          step: "select_ships_direct",
          timestamp: Date.now(),
        }));
        this.saveState({ at: Date.now(), reason });
        // Arm (or re-arm) the multi-wave watcher on every save, including the
        // manual one: pressing the button once is the operator saying "we are
        // under attack", and everything that lands afterwards has to go too.
        const w = this.watch();
        // Remember WHO started this: the alarm may undo its own saves, nobody
        // else's. A sweep inherits the trigger of the save it continues.
        const trigger = w.trigger || (auto || ThreatMonitor.active() ? "threat" : "manual");
        // homeBody is where the fleet LIVES — recorded on the first save of an
        // alert and never overwritten by the sweeps, so the return always knows
        // where to put everything back regardless of which body it is today.
        this.saveWatch({ armed: true, trigger, homeBody: w.homeBody || from, refugeBody: to, at,
                         lastAt: Date.now(), saves: (w.saves || 0) + 1, since: w.since || Date.now() });
        const nameOf = (b) => (b === "moon" ? "KSIĘŻYC" : "PLANETĘ");
        log(`RATUNEK FLOTY: ${nameOf(from)} → ${nameOf(to)} na tych samych koordach (${reason}). Wszystkie statki i wszystkie surowce.`, "success");
        ThreatLog.add("RATUNEK", `Start: ${nameOf(from)} → ${nameOf(to)} (${reason}). Zapis nr ${(w.saves || 0) + 1} w tym alarmie.`);
        await AntiDetection.sleep(400 + Math.random() * 600); // emergency: barely any delay
        window.location.href = href;
        return true;
      } catch (err) {
        log(`[MOON SAVE] error: ${err.message}`, "error");
        return false;
      } finally {
        this.running = false;
      }
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  EXPEDITIONS  (v2.14.0) — combat fleet in timed waves to position 16
  // ═══════════════════════════════════════════════════════════════
  // Sends the combat fleet on expeditions to [base:16], split into N waves a
  // couple of minutes apart. The spacing is a SAFETY feature, not politeness:
  // fleets return one at a time, so a hunter camping the return can catch at
  // most one wave and there is a window to react before the rest lands.
  //
  // The old ExpeditionManager is gone rather than extended: it was written for
  // the pre-2.10 "pick ONE ship type" flow, had no waves, no slot accounting
  // and no UI, and loadConfig force-disabled it. Nothing to salvage.
  //
  // Deliberately reuses the proven parts:
  //   • the 3-step direct-URL dispatch (select_ships_direct) that mining and
  //     farming already use, with an `expedition: true` flag switching the
  //     three things that differ: multi-type ship fill, the holding-time
  //     select, and skipping the same-target duplicate guard (many fleets to
  //     the SAME [g:s:16] is the whole point here — see the guard's comment).
  //   • FleetRecon for the mission id, read off galaxy row 16. Asteroids are
  //     mission=12, so 15 would have been a guess.

  const ExpeditionState = {
    KEY: "ogamex_expo_state",
    load() {
      try { return JSON.parse(GM_getValue(this.KEY, "null")) || {}; } catch { return {}; }
    },
    save(s) { GM_setValue(this.KEY, JSON.stringify(s)); },
    clear() { GM_setValue(this.KEY, "null"); },
  };

  // Ships for ONE wave, computed from the LIVE fleet page (never from a stale
  // snapshot — a recon taken while the fleet is away sees an empty hangar).
  // Split = floor(available / waves), so "8 of each" becomes 8 waves of 1.
  // Heavy Cargo is a FIXED per-wave count instead: it is the farmer's tool and
  // the single biggest stack, and splitting 1.9 billion of it across waves is
  // not something to do by accident.
  // v2.16.1: wave sizes a human would actually type. floor(available/waves) on
  // a growing fleet produces 10 437 522 one day and 11 208 964 the next —
  // nobody types that, and it changes on every rebuild. Keeping two
  // significant digits gives 10 000 000 / 11 000 000: looks hand-entered AND
  // stays put while the fleet grows, stepping up only on a real change.
  // Below 100 the exact number IS the human one (you don't round 7 ships).
  function humanRoundDown(n) {
    if (!Number.isFinite(n) || n < 100) return Math.max(0, Math.floor(n));
    const factor = Math.pow(10, Math.floor(Math.log10(n)) - 1); // keep 2 sig digits
    return Math.max(1, Math.floor(n / factor) * factor);
  }

  function expeditionShipPlan(waves) {
    const cfg = CONFIG.expeditions;
    const exclude = (cfg.excludeTypes || []).map(t => String(t).toUpperCase());
    const divisor = Math.max(1, waves || 1);
    const plan = [];
    const skipped = [];
    const empty = [];
    // ── v2.16.0: wave size is FROZEN for the whole burst ──
    // It used to be recomputed from the live hangar at every wave, so each
    // wave divided what was LEFT: 80M ships over 8 waves went out as 10M,
    // 8.7M, 7.6M, 6.6M… — a decaying tail that no human produces and that
    // isn't what "split the fleet into 8" means either. Other players save a
    // fleet group and send the identical group N times; freezing the first
    // wave's numbers reproduces exactly that, and it's also simply correct.
    // v2.19.0: a burst now ENDS after `waves` sends and the next wave re-sizes.
    // The old end condition — "nothing in the air" — was unreachable in the
    // steady state it was written for: the cap equals the wave count, so the
    // moment one lands the runner sends another and the slot count never
    // reaches zero. Sizes frozen on the first ever burst were being reused
    // forever, so a growing fleet kept flying yesterday's wave.
    const frozen = ExpeditionState.load().burst;
    const sameShape = frozen && frozen.waves === divisor && frozen.sizes;
    const useFrozen = sameShape && (frozen.sent || 0) < divisor;
    // Re-sizing is only safe because the basis is the FLEET, not the hangar.
    // With 7 of 8 waves away the hangar holds an eighth of the fleet, and
    // dividing that by eight is the decaying tail v2.16.0 froze the numbers to
    // avoid. Adding back what is demonstrably out (last wave sizes × waves in
    // the air) gives the same total whenever we recompute, so ending a burst
    // no longer shrinks the next one.
    const wavesInAir = ExpeditionRunner.slots().used || 0;
    const inAir = (type) => (frozen?.sizes?.[type] || 0) * wavesInAir;

    // ── v2.37.0: typ w całości w powietrzu NIE znika z floty ──
    // Strona floty pomija typy o zerowej liczbie — w logu właściciela o 11:02
    // „Ships on page" to były tylko HEAVY_CARGO i ASTEROID_MINER, bo cała
    // reszta latała. Pętla chodziła po tym, co jest w DOM, więc typ całkowicie
    // wysłany nie istniał w momencie przeliczania serii: udział 0, wypada ze
    // składu. A skoro wypadł, jego szacunek „w powietrzu" też był zerowy, więc
    // NIGDY nie wracał. Zapadka. Stąd znikające Galleon i Falcon oraz fale
    // schodzące do samego Heavy Cargo.
    // Rejestr floty pamięta ostatni znany udział każdego typu, a przeliczenie
    // idzie po SUMIE typów z DOM i z rejestru.
    const roster = ExpeditionState.load().roster || {};
    const domQty = {};
    for (const el of document.querySelectorAll("[data-ship-type]")) {
      if (el.dataset.shipType) domQty[el.dataset.shipType] = parseInt(el.dataset.shipQuantity || "0") || 0;
    }
    const shares = {}; // typ → zamierzony udział w fali (to trafia do zamrożenia)
    for (const type of [...new Set([...Object.keys(domQty), ...Object.keys(roster)])]) {
      if (exclude.includes(type.toUpperCase())) { skipped.push(type); continue; }
      const available = domQty[type] || 0;
      if (useFrozen) {
        // Utnij do tego, co realnie jest; typ, którego zabrakło, po prostu
        // wypada z pozostałych fal serii zamiast ją blokować.
        const want = frozen.sizes[type] || 0;
        const qty = Math.min(want, available);
        if (qty > 0) plan.push({ type, qty, available });
        else empty.push(type);
        continue;
      }
      // `share` to udział, jaki typ POWINIEN wnieść (flota ÷ fale) i to on jest
      // zamrażany; `qty` to tyle, ile hangar może dać w tej chwili. Zamrożenie
      // liczby przyciętej zabetonowałoby pusty hangar na kolejne `waves` wysyłek.
      const fleet = available + inAir(type);
      let share = fleet > 0 ? Math.max(1, humanRoundDown(fleet / divisor)) : 0;
      if (share === 0 && roster[type] > 0) share = roster[type]; // cały typ w powietrzu
      if (share > 0) shares[type] = share;
      const qty = Math.min(share, available);
      if (qty > 0) plan.push({ type, qty, available });
      else empty.push(type);
    }

    // ── v2.37.0: Heavy Cargo dzieli się jak każdy inny statek ──
    // Był wyłączony ze splitu i dokładany stałą liczbą, bo „to narzędzie
    // farmienia". Farmienie jest wyłączone, więc HC to po prostu kolejny statek
    // w fali — a stała liczba drenowała go w tempie niezależnym od tego, ile go
    // jest (240M → 190M → 140M → 90M po 50M na falę).
    // heavyCargoPerWave > 0 zostaje jako świadome nadpisanie dla farmiących.
    const hc = Math.max(0, parseInt(cfg.heavyCargoPerWave) || 0);
    if (hc > 0) {
      const idx = plan.findIndex(p => p.type.toUpperCase() === "HEAVY_CARGO");
      if (idx >= 0) plan.splice(idx, 1);
      const available = domQty.HEAVY_CARGO || 0;
      shares.HEAVY_CARGO = hc;
      if (available > 0) plan.push({ type: "HEAVY_CARGO", qty: Math.min(hc, available), available });
    }
    // First wave of a burst: remember these numbers so every later wave of the
    // same burst is identical.
    if (!useFrozen && plan.length) {
      const st = ExpeditionState.load();
      st.burst = { waves: divisor, at: Date.now(), sent: 0, sizes: { ...shares } };
      // Rejestr przeżywa serie: typ chwilowo w całości w powietrzu odzyska
      // swój udział przy następnym przeliczeniu zamiast wypaść na zawsze.
      st.roster = { ...(st.roster || {}), ...shares };
      ExpeditionState.save(st);
      const basis = wavesInAir > 0 ? ` (fleet = hangar + ${wavesInAir} wave(s) still in the air)` : "";
      log(`Expedition burst sized${basis}: ${plan.map(p => `${p.type}×${p.qty}`).join(", ")} — the next ${divisor} wave(s) are identical.`, "fleet");
    }
    return { plan, skipped, empty, frozen: !!useFrozen };
  }

  const ExpeditionRunner = {
    running: false,
    _warned: {},

    base() {
      const b = CONFIG.expeditions.base || CONFIG.asteroidMining.minerBase;
      return b && Number.isFinite(b.galaxy) && Number.isFinite(b.system) ? b : null;
    },

    // Rebuild the link for OUR base system: the learned href points at
    // whichever system the bot happened to be scanning, only its mission id is
    // universal. Shape mirrors the asteroid link (no planet= param — the game
    // launches from the ACTIVE planet, which is what the miner base already is).
    fleetUrl() {
      const b = this.base();
      const link = FleetRecon.expeditionLink();
      if (!b || !link || !link.mission) return null;
      return `/fleet?x=${b.galaxy}&y=${b.system}&z=16&mission=${link.mission}`;
    },

    // Live page value wins; off the fleet page fall back to the last cache.
    slots() {
      const m = document.body.textContent.match(/Expeditions?:\s*(\d+)\s*\/\s*(\d+)/);
      if (m) {
        GM_setValue("ogamex_expo_total_slots", m[2]);
        GM_setValue("ogamex_expo_used", m[1]);
        return { used: parseInt(m[1]), total: parseInt(m[2]), live: true };
      }
      return {
        used: parseInt(GM_getValue("ogamex_expo_used", "0")) || 0,
        total: parseInt(GM_getValue("ogamex_expo_total_slots", "0")) || 0,
        live: false,
      };
    },

    // Cap = waves the user wants, never above the game's expedition slots.
    waveCap() {
      const wanted = Math.max(1, CONFIG.expeditions.waves || 1);
      const total = this.slots().total;
      return total > 0 ? Math.min(wanted, total) : wanted;
    },

    nextWaveGapMs() {
      const cfg = CONFIG.expeditions;
      const min = Math.max(10, cfg.waveGapMinSec || 90);
      const max = Math.max(min, cfg.waveGapMaxSec || 180);
      return Math.round((min + Math.random() * (max - min)) * 1000);
    },

    // Repeat-suppressed logging — this runs every scheduler tick and the
    // "waiting for returns" state can last an hour.
    _say(key, msg, type = "info", everyMs = 15 * 60 * 1000) {
      const last = this._warned[key] || 0;
      if (Date.now() - last < everyMs) return;
      this._warned[key] = Date.now();
      log(msg, type);
    },

    sentToday() {
      const st = ExpeditionState.load();
      const today = new Date().toISOString().slice(0, 10);
      return st.day === today ? (st.sentToday || 0) : 0;
    },

    msToNextWave() {
      const st = ExpeditionState.load();
      if (!st.lastSendAt) return 0;
      const gap = st.nextGapMs || this.nextWaveGapMs();
      return Math.max(0, st.lastSendAt + gap - Date.now());
    },

    async run() {
      const cfg = CONFIG.expeditions;
      if (!CONFIG.enabled || !cfg.enabled || this.running) return;
      if (AntiDetection.isSleepTime() || Humanizer.isOnBreak()) return;
      // v2.15.0: don't put MORE fleets in the air while something hostile is
      // inbound — every wave is one more group that could land badly timed.
      if (ThreatMonitor.active()) {
        this._say("threat", "Expeditions on hold — incoming foreign fleet.", "warn", 5 * 60 * 1000);
        return;
      }
      // A wave click navigates through 3 pages — never start one on top of a
      // mining/farm dispatch (they share the single pending_mission slot).
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") return;
      if (AsteroidMiner.running || InactiveFarmer.running) return;

      this.running = true;
      try {
        const url = this.fleetUrl();
        if (!url) {
          this._say("link", "Expeditions ON but no target yet — open any Galaxy page once so the bot can read the Expedition link from row 16 (and set a base planet).", "warn");
          return;
        }

        // Wave pacing — the reason this module exists.
        const st = ExpeditionState.load();
        const gap = st.nextGapMs || this.nextWaveGapMs();
        if (st.lastSendAt && Date.now() - st.lastSendAt < gap) return;

        // Hard cap: the game's expedition slots.
        const slots = this.slots();
        // v2.16.0: nothing in the air = the previous burst is home, so the next
        // wave starts a NEW burst and re-sizes against the full hangar (which
        // now includes everything that just came back, plus anything built
        // since). While a burst is running the frozen sizes stand.
        if (slots.live && slots.used === 0) {
          const st0 = ExpeditionState.load();
          if (st0.burst) {
            delete st0.burst;
            ExpeditionState.save(st0);
            log("All expeditions home — next burst will be re-sized against the full fleet.", "fleet");
          }
        }
        const cap = this.waveCap();
        if (slots.total && slots.used >= cap) {
          this._say("slots", `Expeditions: ${slots.used}/${slots.total} in the air (cap ${cap}) — waiting for returns.`);
          return;
        }
        // Soft cap: leave fleet slots for mining / manual play.
        const fleetTotal = parseInt(GM_getValue("ogamex_fleet_total_slots", "0")) || 0;
        if (fleetTotal) {
          const free = fleetTotal - (cfg.slotReserve || 0) - inflightFleetCount();
          if (free <= 0) {
            this._say("fleetslots", `Expeditions: no fleet slot free (reserve ${cfg.slotReserve}) — waiting.`);
            return;
          }
        }

        const b = this.base();

        GM_setValue("pending_mission", JSON.stringify({
          type: "expedition_direct",
          expedition: true,
          fleetUrl: url,
          waves: Math.max(1, cfg.waves || 1),
          holdingHours: Math.max(1, cfg.holdingHours || 1),
          step: "select_ships_direct",
          timestamp: Date.now(),
        }));
        // Deliberately NOT RateLimiter.record(): that 20/hour pool has exactly
        // one consumer-side gate — AsteroidMiner refuses to START A SCAN when
        // canAct() is false. Mining already spends it fast (up to 14 parallel
        // flights), so charging 8+ expedition waves to the same pool would
        // starve the scanner, i.e. trade the big income (1.3B miners a flight)
        // for the small one. Expeditions are capped by something stricter
        // anyway: the game's expedition slots plus the wave gap. Total page
        // traffic stays under NavRateLimiter, which they do share.
        log(`EXPEDITION wave → [${b.galaxy}:${b.system}:16] for ${cfg.holdingHours}h (1/${cfg.waves} of the fleet, ${slots.used}/${slots.total || "?"} slots used)`, "success");
        await AntiDetection.shortDelay();
        window.location.href = url;
      } catch (err) {
        log(`Expedition error: ${err.message}`, "error");
      } finally {
        this.running = false;
      }
    },

    // Both post-send paths land here: finishDispatch (click didn't navigate)
    // and the fleetSendSuccessfully handler in init (the usual case).
    afterSend() {
      const st = ExpeditionState.load();
      const today = new Date().toISOString().slice(0, 10);
      // v2.15.1: BOTH post-send paths can fire for the SAME wave — finishDispatch
      // runs when the click doesn't navigate, and the fleetSendSuccessfully
      // handler runs when it does. Live log showed one wave counted as #2 and
      // #3 four seconds apart. One physical send inside 15s = one wave.
      if (st.lastSendAt && Date.now() - st.lastSendAt < 15000) return;
      st.lastSendAt = Date.now();
      st.nextGapMs = this.nextWaveGapMs();
      // v2.19.0: what ends a burst. Once `waves` waves have gone out on these
      // frozen sizes the fleet is fully committed, so the next wave re-sizes
      // against the fleet (hangar + what's in the air) and picks up anything
      // built since.
      if (st.burst) st.burst.sent = (st.burst.sent || 0) + 1;
      st.sentTotal = (st.sentTotal || 0) + 1;
      st.sentToday = (st.day === today ? (st.sentToday || 0) : 0) + 1;
      st.day = today;
      ExpeditionState.save(st);
      this._warned = {};
      log(`Expedition wave sent (#${st.sentToday} today) — next in ~${Math.round(st.nextGapMs / 1000)}s.`, "success");
      // ── v2.56.0: oddaj skanerowi stronę od razu ──
      // Fala ekspedycji przejmuje nawigację w środku przebiegu skanera, więc po
      // wysyłce bot stoi na /fleet i czeka, aż tick zauważy „Scan stranded off
      // galaxy page". W logu z 21:07 to było 7 sekund na falę — przy ~100 falach
      // dziennie ponad kwadrans przestoju na głównym źródle dochodu.
      // Wracamy sami, ale tylko gdy nic innego nie jest w toku.
      try {
        const scan = ScanState.load();
        const next = scan?.active ? scan.queue?.[0] : null;
        const busy = GM_getValue("pending_mission", null) && GM_getValue("pending_mission", null) !== "null";
        const minersOut = (parseInt(GM_getValue("ogamex_fleet_return_at", "0")) || 0) > Date.now();
        if (next && !busy && !minersOut && !ThreatMonitor.active()) {
          log(`Oddaję stronę skanerowi — wracam na [${next.galaxy}:${next.system}] bez czekania na tick.`, "asteroid");
          scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "expedition→scan handoff");
        }
      } catch {}
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  FLEET RECON  (v2.13.1, 2026-07-31)
  // ═══════════════════════════════════════════════════════════════
  // Everything the expedition module will need lives on step 1 of the fleet
  // page — and ONLY there: the ship types this planet actually has (with their
  // internal data-ship-type ids), the saved "Select fleet group" entries, and
  // the two slot counters ("Fleets: X/Y", "Expeditions: X/Y"). The bot visits
  // that page on every dispatch anyway, so instead of asking the player to
  // read markup out of devtools, we snapshot it into GM storage on each visit
  // and log a one-line summary when it CHANGES (silent otherwise — this runs
  // on every fleet page load and must not flood the log).
  //
  // Read by: the expedition composition UI (which ships to send), the wave
  // planner (how many expedition slots exist), the farmer's slot budget.

  const FleetRecon = {
    KEY: "ogamex_fleet_recon",

    snapshot() {
      try { return JSON.parse(GM_getValue(this.KEY, "null")); } catch { return null; }
    },

    // Which planet is selected in the sidebar (ships are per-planet).
    // v2.13.2: the real marker is `a.planet-select.selected` — confirmed from
    // a step-3 clickable dump ("Yoyoyoyoyo "[A.planet-select.selected]). The
    // guessed .active/.smallplanet selectors matched nothing, hence "planet ?".
    // The entry's own text is just the NAME here, so fall back to it when the
    // sidebar doesn't render coords.
    activePlanet() {
      const el = document.querySelector(
        "a.planet-select.selected, .planet-select.selected, .smallplanet.active, .planetlink.active"
      );
      if (!el) return null;
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      const m = txt.match(/\[?(\d+):(\d+):(\d+)\]?/);
      return m ? `${m[1]}:${m[2]}:${m[3]}` : (txt.slice(0, 30) || null);
    },

    // ── Expedition entry point (v2.13.2) ──
    // Row 16 ("Deep space") of any galaxy page carries the Expedition link,
    // exactly like row 17 carries the asteroid one. Learn the real URL from
    // the game instead of assuming mission=15: one row-16 dump into the
    // persisted log, then cache the parsed link + mission id for the
    // expedition module.
    KEY_EXPO_LINK: "ogamex_expo_link",

    expeditionLink() {
      try { return JSON.parse(GM_getValue(this.KEY_EXPO_LINK, "null")); } catch { return null; }
    },

    learnExpeditionLink() {
      if (GameState.getCurrentPage() !== "galaxy") return null;
      if (this.expeditionLink()) return this.expeditionLink(); // learned once, it's static
      for (const item of document.querySelectorAll(".galaxy-item")) {
        const idx = item.querySelector(".planet-index");
        if (!idx || idx.textContent.trim() !== "16") continue;
        log(`[DOM] Row 16 HTML: ${item.innerHTML.replace(/\s+/g, " ").trim().slice(0, 600)}`, "fleet");
        const a = item.querySelector("a[href*='/fleet']");
        if (!a) {
          log("[EXPO] Row 16 has no /fleet link — the Expedition button is scripted; markup dumped above.", "warn");
          return null;
        }
        const href = a.getAttribute("href");
        const mission = (href.match(/[?&]mission=(\d+)/) || [])[1] || null;
        const learned = { href, mission: mission ? parseInt(mission) : null, at: Date.now() };
        GM_setValue(this.KEY_EXPO_LINK, JSON.stringify(learned));
        log(`[EXPO] Expedition link learned: ${href} (mission=${learned.mission ?? "?"})`, "success");
        return learned;
      }
      return null;
    },

    scan() {
      if (GameState.getCurrentPage() !== "fleet") return null;

      const ships = [...document.querySelectorAll("[data-ship-type]")].map(el => {
        const item = el.closest(".ship-item") || el;
        const label = (el.getAttribute("title") || item.querySelector("img")?.alt ||
                       el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        return {
          type: el.dataset.shipType,
          qty: parseInt(el.dataset.shipQuantity || "0") || 0,
          label: label.slice(0, 30),
        };
      }).filter(s => s.type);

      // "Select fleet group" — a <select> whose own options say so. Matching on
      // the placeholder option keeps us off unrelated selects (expedition
      // duration, speed, …) without depending on an id we haven't seen.
      let groups = [];
      for (const sel of document.querySelectorAll("select")) {
        const opts = [...sel.options].map(o => (o.textContent || "").replace(/\s+/g, " ").trim());
        if (!opts.some(t => /fleet\s*group/i.test(t))) continue;
        groups = [...sel.options].map(o => ({ value: o.value, text: (o.textContent || "").trim().slice(0, 40) }));
        break;
      }

      const text = document.body.textContent;
      const fm = text.match(/Fleets:\s*(\d+)\s*\/\s*(\d+)/);
      const em = text.match(/Expeditions?:\s*(\d+)\s*\/\s*(\d+)/);

      const snap = {
        at: Date.now(),
        planet: this.activePlanet(),
        ships,
        groups,
        fleetSlots: fm ? { used: parseInt(fm[1]), total: parseInt(fm[2]) } : null,
        expoSlots: em ? { used: parseInt(em[1]), total: parseInt(em[2]) } : null,
      };

      // Cache the slot totals where the existing consumers already look.
      if (snap.fleetSlots) GM_setValue("ogamex_fleet_total_slots", String(snap.fleetSlots.total));
      if (snap.expoSlots) GM_setValue("ogamex_expo_total_slots", String(snap.expoSlots.total));

      // Log only when the interesting part changed (ship TYPES, groups, slot
      // totals) — quantities move constantly and would spam every page load.
      const prev = this.snapshot();
      const fingerprint = s => s && JSON.stringify([
        s.planet,
        (s.ships || []).map(x => x.type).sort(),
        (s.groups || []).map(x => x.text),
        s.fleetSlots?.total, s.expoSlots?.total,
      ]);
      GM_setValue(this.KEY, JSON.stringify(snap));
      if (fingerprint(prev) !== fingerprint(snap)) this.logSummary(snap, "changed");
      return snap;
    },

    logSummary(snap, tag = "cached") {
      if (!snap) { log("[FLEET RECON] no snapshot yet — open the Fleet page once.", "warn"); return; }
      const ships = (snap.ships || []).map(s => `${s.type}${s.label ? `/${s.label}` : ""}=${s.qty.toLocaleString()}`).join(", ") || "NONE";
      const groups = (snap.groups || []).map(g => `"${g.text}"(${g.value})`).join(", ") || "none";
      const slots = `fleets ${snap.fleetSlots ? `${snap.fleetSlots.used}/${snap.fleetSlots.total}` : "?"}, expeditions ${snap.expoSlots ? `${snap.expoSlots.used}/${snap.expoSlots.total}` : "?"}`;
      log(`[FLEET RECON ${tag}] planet ${snap.planet || "?"} | slots: ${slots} | groups: ${groups}`, "info");
      log(`[FLEET RECON ${tag}] ships: ${ships}`, "info");
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  ONLINE BONUS CLAIMER  (v2.13.0, 2026-07-31)
  // ═══════════════════════════════════════════════════════════════
  // Every few hours OGameX puts a green "Online bonus" entry at the top of
  // the left menu; clicking it grants antimatter + Academy points. Pure
  // freebie, so the bot takes it — but through the same gates as every other
  // module: leader tab only, never mid-dispatch (the click can navigate and
  // would strand a 3-step fleet flow), and quiet during breaks/night so the
  // account doesn't click at 4am while it's supposed to be asleep.
  //
  // We don't know the exact markup ogamex.net uses, so detection is
  // label-driven and defensive:
  //   • strict pass — a text node that IS the label ("Online bonus", after
  //     stripping digits/punctuation), climbing ≤4 levels to the real
  //     clickable (<a>/<button>/[onclick]/role=button/cursor:pointer)
  //   • loose pass — a short label CONTAINING the phrase, but only on a
  //     genuine control (so prose like "you claimed your online bonus"
  //     can't be clicked)
  //   • never our own panel, never a disabled/greyed item, never an item
  //     showing a countdown (that's "next bonus in mm:ss", not a button)
  // The first sighting dumps the element's outerHTML into the persisted log
  // so the markup can be tightened later from a real observation.

  const OnlineBonus = {
    KEY_CLAIMS: "ogamex_bonus_claims",       // JSON array of claim timestamps
    KEY_NEXT_TRY: "ogamex_bonus_next_try_at",
    KEY_PENDING: "ogamex_bonus_pending",     // click awaiting verification
    KEY_MARKUP: "ogamex_bonus_markup_logged",
    LABEL_RE: /^(online bonus|bonus online)$/i,
    LOOSE_RE: /online\s*bonus|bonus\s*online/i,
    busy: false,

    // ── claim bookkeeping ──
    claims() {
      try {
        const arr = JSON.parse(GM_getValue(this.KEY_CLAIMS, "[]"));
        return Array.isArray(arr) ? arr.filter(t => t > Date.now() - 7 * 24 * 60 * 60 * 1000) : [];
      } catch { return []; }
    },
    recordClaim() {
      const arr = this.claims();
      arr.push(Date.now());
      GM_setValue(this.KEY_CLAIMS, JSON.stringify(arr));
    },
    lastClaimAt() {
      const a = this.claims();
      return a.length ? a[a.length - 1] : 0;
    },
    claimsToday() {
      const d = new Date();
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      return this.claims().filter(t => t >= start).length;
    },

    // ── DOM helpers ──
    isVisible(el) {
      if (!el || !el.getClientRects || el.getClientRects().length === 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== "hidden" && st.display !== "none" && parseFloat(st.opacity || "1") > 0.05;
    },

    // The greyed-out state may sit on the control OR on its <li>/wrapper, so
    // check a couple of levels up too.
    isDisabled(el) {
      for (let cur = el, i = 0; cur && i < 3; cur = cur.parentElement, i++) {
        if (cur.disabled) return true;
        if (cur.getAttribute && cur.getAttribute("aria-disabled") === "true") return true;
        const cls = typeof cur.className === "string" ? cur.className : "";
        if (/disabl|inactive|locked|cooldown|unavailable|not-?active/i.test(cls)) return true;
      }
      return false;
    },

    // Nearest real control at or above `el` (menu entries are usually <a>/<li>).
    // A real control ALWAYS wins over the cursor heuristic: `cursor` is an
    // inherited CSS property, so the label <span> inside a clickable <a>
    // computes to `pointer` as well — trusting it first returned the span and
    // lost both the href fallback and the wrapper's disabled/greyed classes.
    clickableFor(el) {
      let pointer = null;
      for (let cur = el, i = 0; cur && cur !== document.body && i < 5; cur = cur.parentElement, i++) {
        if (/^(A|BUTTON|INPUT)$/.test(cur.tagName)) return cur;
        if (cur.hasAttribute && (cur.hasAttribute("onclick") || cur.getAttribute("role") === "button")) return cur;
        try {
          if (getComputedStyle(cur).cursor === "pointer") {
            const t = (cur.textContent || "").replace(/\s+/g, " ").trim();
            if (t.length <= 40) pointer = cur; // outermost node that is still just the label
          }
        } catch {}
      }
      return pointer;
    },

    find() {
      // Cheap prefilter: one string scan per tick instead of a full DOM walk.
      if (!this.LOOSE_RE.test(document.body.textContent || "")) return null;

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node, loose = null;
      while ((node = walker.nextNode())) {
        const raw = (node.nodeValue || "").replace(/\s+/g, " ").trim();
        if (!raw || raw.length > 60 || !this.LOOSE_RE.test(raw)) continue;
        const parent = node.parentElement;
        if (!parent || (parent.closest && parent.closest("#ogx-bot-panel"))) continue; // our own UI/log
        const ctrl = this.clickableFor(parent);
        const target = ctrl || parent;
        if (!this.isVisible(target)) continue;

        const label = (target.textContent || "").replace(/\s+/g, " ").trim();
        const letters = raw.replace(/[^\p{L} ]/gu, "").replace(/\s+/g, " ").trim();
        const hit = { el: target, node: raw, label: label.slice(0, 80) };
        if (this.LABEL_RE.test(letters)) return hit;           // strict: the node IS the label
        if (ctrl && label.length <= 40 && !loose) loose = hit;  // loose: a real control, short label
      }
      return loose;
    },

    // Some UIs put the reward behind a confirm inside a modal. Only click a
    // confirm that sits in a container actually talking about the bonus.
    clickConfirmIfAny() {
      const btns = document.querySelectorAll("button, a, input[type='button'], input[type='submit']");
      for (const b of btns) {
        if (b.closest && b.closest("#ogx-bot-panel")) continue;
        const t = ((b.textContent || b.value || "") + "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 24) continue;
        if (!/^(claim|collect|receive|get( it)?|odbierz|zbierz|confirm|ok|yes)$/i.test(t)) continue;
        if (!this.isVisible(b) || this.isDisabled(b)) continue;
        // Smallest meaningful container around the button — NOT <body>, whose
        // text always contains "Online bonus" (the menu entry) and would make
        // this match any stray OK button on the page.
        let ctx = "";
        for (let cur = b.parentElement, i = 0; cur && cur !== document.body && i < 5; cur = cur.parentElement, i++) {
          const t = (cur.textContent || "").replace(/\s+/g, " ").trim();
          if (t.length >= 20) { ctx = t.slice(0, 600); break; }
        }
        if (!/bonus|antimatter|dark\s*matter|academy/i.test(ctx)) continue;
        log(`Online bonus: confirming via "${t}".`, "info");
        this.humanClick(b);
        return true;
      }
      return false;
    },

    humanClick(el) {
      const opts = { bubbles: true, cancelable: true, view: window };
      try {
        el.dispatchEvent(new MouseEvent("mouseover", opts));
        el.dispatchEvent(new MouseEvent("mousedown", opts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
      } catch {}
      try { el.click(); } catch {}
    },

    markup(el) {
      return ((el && el.outerHTML) || "").replace(/\s+/g, " ").slice(0, 300);
    },

    // Resolve a click made earlier (possibly before a page navigation).
    // Returns true while the outcome is still undecided.
    // `force` = we just clicked in THIS tick and already waited out the UI,
    // so judge immediately instead of deferring to the next scheduler tick.
    settle(force = false) {
      let pend = null;
      try { pend = JSON.parse(GM_getValue(this.KEY_PENDING, "null")); } catch {}
      if (!pend) return false;
      const age = Date.now() - (pend.at || 0);
      if (!force && age < 2000) return true; // too early to judge

      const still = this.find();
      if (!still) {
        GM_setValue(this.KEY_PENDING, "null");
        this.recordClaim();
        const gap = Math.max(1, CONFIG.onlineBonus?.minGapMin || 2);
        GM_setValue(this.KEY_NEXT_TRY, String(Date.now() + gap * 60 * 1000));
        log(`Online bonus CLAIMED — antimatter + Academy points (#${this.claimsToday()} today).`, "success");
        updateStatusUI();
        return false;
      }
      if (age > 20000 || force) {
        GM_setValue(this.KEY_PENDING, "null");
        const retry = Math.max(1, CONFIG.onlineBonus?.retryMin || 15);
        GM_setValue(this.KEY_NEXT_TRY, String(Date.now() + retry * 60 * 1000));
        log(`Online bonus: clicked but the button is still there — retry in ${retry}min. Markup: ${this.markup(still.el)}`, "warn");
        updateStatusUI();
        return false;
      }
      return true; // still settling
    },

    async run({ manual = false } = {}) {
      if (this.busy) return;
      if (!manual && !CONFIG.onlineBonus?.enabled) return;

      if (this.settle()) return; // a previous click is still being judged

      if (!manual) {
        const nextTry = parseInt(GM_getValue(this.KEY_NEXT_TRY, "0")) || 0;
        if (Date.now() < nextTry) return;
      }

      // A click may navigate — never do it in the middle of a fleet flow.
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") return;
      if (AsteroidMiner.running || InactiveFarmer.running || ExpeditionRunner.running) return;

      const hit = this.find();
      if (!hit) {
        if (manual) log("No 'Online bonus' button visible on this page right now.", "warn");
        return;
      }

      // Learn the real markup once — the persisted log can be copied out.
      if (!GM_getValue(this.KEY_MARKUP, "")) {
        GM_setValue(this.KEY_MARKUP, "1");
        log(`Online bonus markup (first sighting): ${this.markup(hit.el)}`, "info");
      }

      if (this.isDisabled(hit.el)) {
        GM_setValue(this.KEY_NEXT_TRY, String(Date.now() + 10 * 60 * 1000));
        log(`Online bonus entry present but disabled/greyed — skipping for 10min.`, "info");
        return;
      }
      // "Online bonus 04:12" = countdown to the NEXT bonus, not a claimable one.
      if (/\d{1,2}:\d{2}/.test(hit.label)) {
        GM_setValue(this.KEY_NEXT_TRY, String(Date.now() + 5 * 60 * 1000));
        log(`Online bonus shows a countdown ("${hit.label}") — not claimable yet.`, "info");
        return;
      }

      this.busy = true;
      try {
        log(`Online bonus detected ("${hit.label}") — claiming.`, "success");
        const href = hit.el.tagName === "A" ? hit.el.getAttribute("href") : null;

        // ── v2.17.1: claim FAST, and by navigation when we can ──
        // Live log 16:07:54: "Online bonus detected — claiming." and then…
        // nothing, with the button still on screen minutes later. The claim was
        // losing a race: it slept 1.2-4s for human-reaction realism while the
        // asteroid scanner navigated to the next galaxy page ~2s later, killing
        // the page mid-claim. Every scan step is another lost bonus.
        // The button is a plain link (<a href="/home/onlinebonus" id=
        // "btn-online-bonus">), so going straight to that URL is both the
        // fastest and the most reliable claim — it's one atomic navigation
        // instead of a click plus several seconds of page life.
        const realHref = href && href !== "#" && !/^javascript:/i.test(href) ? (hit.el.href || href) : null;
        if (realHref) {
          GM_setValue(this.KEY_PENDING, JSON.stringify({ at: Date.now(), label: hit.label }));
          await AntiDetection.sleep(150 + Math.random() * 450); // enough to not be instant, too short to lose the race
          log(`Online bonus: navigating to ${href}`, "fleet");
          window.location.href = realHref;
          return;
        }
        // Stamp BEFORE clicking: if the click navigates, this page's JS dies
        // and only the marker (read on the next page's first tick) can tell
        // us the claim went through.
        GM_setValue(this.KEY_PENDING, JSON.stringify({ at: Date.now(), label: hit.label }));
        this.humanClick(hit.el);

        await AntiDetection.sleep(1500 + Math.random() * 1500);
        this.clickConfirmIfAny();
        await AntiDetection.sleep(1500 + Math.random() * 1000);

        // Still here (no navigation) → judge now instead of waiting a tick.
        if (this.find() && href && href !== "#" && !/^javascript:/i.test(href)) {
          log(`Online bonus: click didn't take — following its link (${href}).`, "warn");
          window.location.href = hit.el.href || href;
          return;
        }
        this.settle(true);
      } catch (err) {
        log(`Online bonus error: ${err.message}`, "error");
      } finally {
        this.busy = false;
      }
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  FLEET RETURN TIME PARSER
  // ═══════════════════════════════════════════════════════════════

  // After sending a fleet, the page shows fleet movement info.
  // Parse the return time so the bot knows when to scan again.
  // Looks for patterns like:
  //   "Next: 14:04" (HH:MM today)
  //   Countdown timers (data-arrival, data-return attributes)
  //   Fleet event rows with timestamps
  function parseFleetReturnTime() {
    const now = new Date();
    const bodyText = document.body.textContent;

    // Pattern 1: "Next: MM:SS" or "Next: HH:MM:SS" — countdown to next fleet event
    // IMPORTANT: Only use if "Type:" is asteroid-related. "Next:" shows ANY fleet type!
    const nextMatch = bodyText.match(/Next:\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
    if (nextMatch) {
      // Check if the mission type near "Next:" is asteroid mining
      const typeMatch = bodyText.match(/Type:\s*(\w[\w\s]*)/);
      const missionType = typeMatch ? typeMatch[1].trim().toLowerCase() : "";
      const isAsteroidMission = missionType.includes("asteroid") || missionType.includes("mining");

      const hours = nextMatch[1] ? parseInt(nextMatch[1]) : 0;
      const minutes = parseInt(nextMatch[2]);
      const seconds = parseInt(nextMatch[3]);
      const countdownMs = (hours * 3600 + minutes * 60 + seconds) * 1000;

      if (isAsteroidMission) {
        // (R) = return phase — countdown IS the return time, don't ×2
        const isReturn = /Asteroid\s*Mining\s*\(R\)/i.test(bodyText);
        if (isReturn) {
          log(`Parsed asteroid fleet RETURN countdown: ${hours}h${minutes}m${seconds}s`, "fleet");
          return now.getTime() + countdownMs;
        }
        log(`Parsed asteroid fleet countdown: ${hours}h${minutes}m${seconds}s (×2 for round trip)`, "fleet");
        return now.getTime() + countdownMs * 2;
      } else {
        log(`Next fleet is "${missionType}", not asteroid mining — ignoring countdown`, "fleet");
        // Don't use this countdown — fall through to other patterns
      }
    }

    // Pattern 2: data-return-time or data-arrival on fleet movement elements
    const returnEl = document.querySelector("[data-return-time], [data-arrival]");
    if (returnEl) {
      const ts = parseInt(returnEl.dataset.returnTime || returnEl.dataset.arrival || "0");
      if (ts > 0) {
        const returnMs = ts > 1e12 ? ts : ts * 1000;
        log(`Parsed fleet return from DOM attr: ${new Date(returnMs).toLocaleTimeString("pl-PL")}`, "fleet");
        return returnMs;
      }
    }

    // Pattern 3: Flight time display (e.g. "Flight time: 00:12:34")
    const flightMatch = bodyText.match(/[Ff]light\s*time:\s*(\d{1,2}):(\d{2}):(\d{2})/);
    if (flightMatch) {
      const flightMs = (parseInt(flightMatch[1]) * 3600 + parseInt(flightMatch[2]) * 60 + parseInt(flightMatch[3])) * 1000;
      return now.getTime() + flightMs * 2;
    }

    return null;
  }

  // v2.10.1: how many miners were left at home after the most recent dispatch.
  // Returns -1 when unknown/stale (no record, or older than a full round trip),
  // which callers treat as "assume none home" — the safe default that keeps the
  // bot from scanning when it has nothing to send. This is what makes parallel
  // mode dormant until right-sizing actually leaves miners behind: a 100% send
  // (minersNeeded=0, the pre-learning fallback) leaves 0 home → bot waits, just
  // like the old serial behaviour.
  // ── v2.24.0: count the hangar, don't remember it ──
  // This used to answer ONLY from the last dispatch record: available − toSend,
  // valid for maxFlightMinutes×2+10 = 100 minutes. After a send that took every
  // miner it therefore reported "0 home" for an hour and a half, long after the
  // fleets had landed. Owner's log, 2026-08-01: "Parallel: no miners home (0) →
  // wait for fleet return" at 10:59:09, and four seconds later the fleet page
  // listed ASTEROID_MINER qty 7 200 000 000. Seven point two BILLION miners sat
  // idle because of a stale arithmetic memory. The live page always wins; the
  // recon cache (written on every fleet-page visit) is the second choice; the
  // dispatch estimate is the last resort it always should have been.
  function minersHomeLive() {
    const types = [...(CONFIG.asteroidMining.minerShipTypes || []), "ASTEROID_MINER"];
    for (const t of types) {
      const el = document.querySelector(`[data-ship-type="${t}"]`);
      if (el) {
        const n = parseInt(el.dataset.shipQuantity || "0");
        if (Number.isFinite(n)) return n;
      }
    }
    return -1;
  }

  function minersHomeFromRecon(maxAgeMs = 10 * 60 * 1000) {
    try {
      const snap = JSON.parse(GM_getValue("ogamex_fleet_recon", "null"));
      if (!snap?.at || Date.now() - snap.at > maxAgeMs) return -1;
      const types = [...(CONFIG.asteroidMining.minerShipTypes || []), "ASTEROID_MINER"];
      for (const t of types) {
        const s = (snap.ships || []).find(x => x.type === t);
        if (s && Number.isFinite(s.qty)) return s.qty;
      }
    } catch {}
    return -1;
  }

  function minersHomeAfterLastDispatch() {
    const live = minersHomeLive();
    if (live >= 0) return live;
    const recon = minersHomeFromRecon();
    if (recon >= 0) return recon;
    let d = null;
    try { d = JSON.parse(GM_getValue("ogamex_last_dispatch", "null")); } catch {}
    if (!d || !Number.isFinite(d.available) || !Number.isFinite(d.toSend)) return -1;
    // v2.24.0: the estimate is only believable for as long as a dispatch takes
    // to matter — one round trip, not two plus ten minutes. Past that the
    // fleets are back and the arithmetic is fiction.
    const maxAgeMs = (CONFIG.asteroidMining.maxFlightMinutes + 5) * 60 * 1000;
    if (!d.at || Date.now() - d.at > maxAgeMs) return -1; // stale — tells us nothing about now
    return d.available - d.toSend;
  }

  // v2.10.4: max simultaneous mining flights. If the user set a miner budget
  // ("total miners to use") and a per-flight size, the cap = floor(total/per)
  // — e.g. 100000 / 50000 = 2 flights. Otherwise fall back to the explicit
  // maxConcurrentMiningFleets (0 = no cap → limited only by game fleet slots).
  function maxMiningFleets() {
    const am = CONFIG.asteroidMining;
    const total = am.totalMinersToUse || 0;
    const per = am.minersPerMission || 0;
    if (total > 0 && per > 0) return Math.max(1, Math.floor(total / per));
    return am.maxConcurrentMiningFleets || 0;
  }

  // v2.10.8: count in-flight fleets from the page's REAL fleet-status bar
  // ("N Missions: M Own"), NOT an estimate. History:
  //   - ≤v2.10.6: a counter that only reset to 0 when ALL fleets were home →
  //     stuck at max with staggered fleets (waited forever).
  //   - v2.10.7: estimated each fleet's return ETA and pruned on expiry — but
  //     ETAs ran short (asteroid mining dwell + flight-time error), so a fleet
  //     got pruned WHILE STILL IN FLIGHT → undercount → the bot freed the
  //     budget early, scanned with fleets still out, and tried to dispatch a
  //     4th fleet with too few miners (Send button disabled → dispatch failed).
  // Ground truth is the live page. During the wait the bot sits on a
  // fleet-status page (the "Type: Asteroid Mining" header is what triggers the
  // wait), so "M Own" is reliably present and drops the instant a fleet lands.
  // On a page WITHOUT the bar (e.g. galaxy scan) we keep the last stored count
  // — conservative: never free the budget on a blind page.
  function inflightFleetCount() {
    const m = document.body.textContent.match(/(\d+)\s*Missions?:\s*(\d+)\s*Own/);
    const stored = parseInt(GM_getValue("ogamex_inflight_fleets", "0")) || 0;
    if (!m) return stored; // no fleet bar on this page → last known (conservative)
    const own = parseInt(m[2]) || 0;
    // Post-send race guard: the page may not yet list a fleet we dispatched in
    // the last 30s, so don't let a stale-low read drop below what we just sent.
    const sinceSend = Date.now() - (parseInt(GM_getValue("ogamex_last_dispatch_at", "0")) || 0);
    const reconciled = (sinceSend < 30000 && own < stored) ? stored : own;
    if (reconciled !== stored) GM_setValue("ogamex_inflight_fleets", String(reconciled));
    return reconciled;
  }

  function clearInflightFleets() {
    GM_setValue("ogamex_inflight_fleets", "0");
  }

  // v2.15.1: MINING fleets only. inflightFleetCount() reads "M Own", i.e. every
  // mission we own — including expeditions. Mining's parallel budget
  // (floor(totalMinersToUse / minersPerFlight)) was therefore being eaten by
  // expedition waves: 3 expeditions + 1 mining flight read as "4/4 — flight
  // budget reached", and the asteroid scanner stopped dispatching. The game
  // reports its own expedition counter ("Expeditions: X/Y"), so subtract it.
  // Fleet-SLOT maths (farmer reserve, expedition reserve) still uses the full
  // count — there every fleet really does occupy a slot.
  // ── v2.30.0: nie mieszaj świeżego z nieświeżym ──
  // Mining = wszystkie misje minus ekspedycje. Tyle że te dwie liczby czyta się
  // z RÓŻNYCH miejsc: „N Missions: M Own" jest w górnym pasku (także na
  // galaktyce), a „Expeditions: X/Y" tylko na stronie floty. Poza nią licznik
  // ekspedycji spadał do CACHE'U i odejmowaliśmy zeszłoroczną liczbę od
  // dzisiejszej. Właściciel trzyma 10 ekspedycji w powietrzu non stop, więc
  // pomyłka bywała ogromna: log pokazywał „flight budget reached (5/3)", czyli
  // pięć lotów górniczych przy limicie trzech — po czym mining sam sobie
  // blokował wysyłkę. Na jego największym źródle dochodu.
  //
  // Zwraca -1 = NIE WIEM. Wywołania traktują to jako „budżet nie blokuje":
  // pomyłka w tę stronę kosztuje najwyżej jeden lot ponad limit, który sam się
  // rozejdzie, a w drugą stronę kosztuje przestój kopania.
  // ── v2.39.1: licz WŁASNE loty górnicze, nie „reszta po odjęciu" ──
  // Formuła „wszystkie misje minus ekspedycje" zakładała, że wszystko, co nie
  // jest ekspedycją, jest miningiem. Właściciel gra też ręcznie — kolonizuje,
  // przewozi surowce — i te misje wpadały do limitu górniczego. Log z 11:54:
  // „flight budget reached (28/3) → scan paused ~90min". Dwadzieścia osiem
  // lotów górniczych przy limicie trzech, przy realnych trzech w powietrzu.
  // Mining stał półtorej godziny na głównym źródle dochodu właściciela.
  //
  // Bot sam wysyła te floty i sam je notuje: DispatchedAsteroids trzyma wpis do
  // momentu przylotu (releaseAt, stemplowany czasem lotu z gry). To jest
  // dokładna liczba naszych misji górniczych w drodze — bez zgadywania, bez
  // zależności od tego, co jeszcze robi człowiek na koncie.
  function miningInflightCount() {
    return MiningFlights.count();
  }

  // v2.10.1: set the scan-pause timer from the page header countdown (factored
  // out so both the legacy serial path and the parallel "must wait" path share
  // identical logic).
  function setFleetReturnTimerFromHeader(headerText, storedReturnAt) {
    const nextMatch = headerText.match(/Next:\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
    if (nextMatch) {
      const hours = nextMatch[1] ? parseInt(nextMatch[1]) : 0;
      const minutes = parseInt(nextMatch[2]);
      const seconds = parseInt(nextMatch[3]);
      const countdownMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
      const isReturn = /Asteroid\s*Mining\s*\(R\)/i.test(headerText);
      // (R) = return phase, countdown IS return time. Otherwise ×2 for round trip.
      const returnAt = Date.now() + (isReturn ? countdownMs : countdownMs * 2) + 60000;
      GM_setValue("ogamex_fleet_return_at", String(returnAt));
      const newWait = Math.ceil((returnAt - Date.now()) / 60000);
      log(`Asteroid fleet active! Timer set: ~${newWait}min (countdown ${hours}h${minutes}m${seconds}s${isReturn ? ' R' : ' ×2'})`, "asteroid");
    } else if (storedReturnAt && storedReturnAt > Date.now()) {
      const minLeft = Math.ceil((storedReturnAt - Date.now()) / 60000);
      log(`Asteroid fleet active, can't parse countdown. Using stored timer (~${minLeft}min).`, "asteroid");
    } else {
      const fallbackMs = CONFIG.asteroidMining.maxFlightMinutes * 2 * 60 * 1000;
      GM_setValue("ogamex_fleet_return_at", String(Date.now() + fallbackMs));
      log(`Asteroid fleet active but no countdown found. Estimated ~${CONFIG.asteroidMining.maxFlightMinutes * 2}min wait.`, "asteroid");
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  PARALLEL DISPATCH DECISION  (v2.10.0)
  // ═══════════════════════════════════════════════════════════════
  // After a mining fleet is sent, decide whether to keep scanning (send the
  // leftover miners to OTHER asteroids in parallel) or pause until a fleet
  // returns. Returns true = keep scanning.
  //
  // The pause is implemented by setting ogamex_fleet_return_at, which every
  // existing scan gate already honours — so parallel mode simply means "don't
  // set that timer while we still have miners + a free fleet slot." When we DO
  // pause we use the soonest return so a freed slot (and the miners aboard)
  // gets reused as early as possible, not after the whole fleet is home.
  function decideAfterMiningSend({ available, toSend, capturedFlightMs }) {
    const am = CONFIG.asteroidMining;
    const minersLeftHome = (Number.isFinite(available) && Number.isFinite(toSend)) ? available - toSend : 0;
    const slots = GameState.getFleetSlots();
    const slotsFree = slots.total > 0 ? slots.total - slots.used : 1;
    // v2.10.8: we just sent a fleet — bump the stored floor by 1 and stamp the
    // time, so inflightFleetCount()'s page-reconciliation race guard knows a
    // fresh fleet may not appear in "M Own" for a few seconds. The real count
    // then takes over from the live page as soon as it shows the new fleet.
    const storedNow = parseInt(GM_getValue("ogamex_inflight_fleets", "0")) || 0;
    GM_setValue("ogamex_inflight_fleets", String(storedNow + 1));
    GM_setValue("ogamex_last_dispatch_at", String(Date.now()));
    const inflight = miningInflightCount(); // "M Own" minus expeditions (v2.15.1)
    const maxConc = maxMiningFleets(); // floor(totalMinersToUse / perFlight), or maxConcurrentMiningFleets
    // inflight < 0 = liczba nieznana → budżet nie blokuje (v2.30.0)
    const concOk = maxConc <= 0 || inflight < 0 || inflight < maxConc;

    // ── v2.22.0: don't launch the scraps ──
    // The flight budget is floor(totalMinersToUse / perFlight), which counts
    // miners the hangar may not actually hold. Owner's case: 5.0B miners,
    // 2.4B per flight, budget 3 flights → the third launched with the 200M
    // remainder. That flight isn't free money: the game caps a mission's haul
    // at the fleet's TOTAL cargo, so 200M miners came back with exactly
    // 200M × 20 750 = 4.15T — the cap to the digit, i.e. the asteroid had more
    // and the rest was left in the ground. Those miners earn far more as part
    // of the next full flight, so a parallel leg now has to be worth flying.
    const intendedPerFlight = am.minersPerMission > 0 ? am.minersPerMission : AsteroidYieldTracker.minersNeeded();
    const ratio = Number.isFinite(am.partialFlightMinRatio) ? am.partialFlightMinRatio : 0.5;
    const worthFlying = !(intendedPerFlight > 0 && ratio > 0) ||
      minersLeftHome >= Math.ceil(intendedPerFlight * ratio);

    const canParallel = am.parallelDispatch &&
      minersLeftHome >= (am.minMinersPerMission || 1) &&
      worthFlying &&
      slotsFree > 0 && concOk;

    if (canParallel) {
      GM_setValue("ogamex_fleet_return_at", "0"); // don't gate scanning
      log(`PARALLEL: sent ${toSend}, ~${minersLeftHome} miners still home, ${slotsFree} slot(s) free → keep scanning for more asteroids.`, "asteroid");
      return true;
    }

    // Pause until the soonest fleet return.
    let returnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
    if (!returnAt || returnAt < Date.now()) {
      if (capturedFlightMs > 0) returnAt = Date.now() + capturedFlightMs * 2 + 60000;
      else {
        const parsed = parseFleetReturnTime();
        returnAt = (parsed && parsed > Date.now()) ? parsed
          : Date.now() + CONFIG.asteroidMining.maxFlightMinutes * 2 * 60 * 1000;
      }
      GM_setValue("ogamex_fleet_return_at", String(returnAt));
    }
    const reason = !am.parallelDispatch ? "parallel off"
      : !worthFlying ? `resztówka: ${minersLeftHome} minerów w domu to mniej niż ${Math.round(ratio * 100)}% lotu (${intendedPerFlight}) — czekam na powrót zamiast marnować asteroidę na pół floty`
      : minersLeftHome < (am.minMinersPerMission || 1) ? "no miners left home"
      : slotsFree <= 0 ? "fleet slots full"
      : `flight budget reached (${inflight < 0 ? "?" : inflight}/${maxConc} flights)`;
    log(`WAIT (${reason}): scan paused ~${Math.ceil((returnAt - Date.now()) / 60000)}min until a fleet returns.`, "asteroid");
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  //  MISSION FLOW HANDLER: Continue multi-page fleet dispatch
  // ═══════════════════════════════════════════════════════════════

  let _handlingMission = false;
  async function handlePendingMission() {
    if (_handlingMission) return;
    // v2.10.25: a non-leader tab must NEVER execute a pending mission — this
    // was the exact mechanism of the triple-send (several tabs on the fleet
    // page each resumed the same pending_mission within seconds).
    if (!requireLeader("pending-mission")) return;
    const raw = GM_getValue("pending_mission", null);
    if (!raw) return;
    _handlingMission = true;

    let mission;
    try {
      mission = JSON.parse(raw);
    } catch {
      GM_setValue("pending_mission", null);
      _handlingMission = false; // v2.10.10: early return before the try/finally — don't leak the flag
      return;
    }

    // Expire old missions (>5 minutes)
    if (Date.now() - mission.timestamp > 5 * 60 * 1000) {
      log("Pending mission expired, clearing", "warn");
      GM_setValue("pending_mission", null);
      _handlingMission = false; // v2.10.10: same — a leaked flag made this fn a no-op until next reload
      return;
    }

    const page = GameState.getCurrentPage();
    log(`Continuing mission: ${mission.type}, step: ${mission.step}, page: ${page}`, "fleet");

    try {
      // ── Planet switch step: we landed on a planet page, now go to fleet ──
      if (mission.step === "switch_planet_then_fleet" && mission.switchToFleetUrl) {
        log(`Planet switched. Navigating to fleet: ${mission.switchToFleetUrl}`, "fleet");
        mission.step = "select_ships_direct";
        mission.timestamp = Date.now();
        GM_setValue("pending_mission", JSON.stringify(mission));
        await AntiDetection.sleep(1000 + Math.random() * 1500);
        window.location.href = mission.switchToFleetUrl;
        return;
      }

      // ── v2.21.0: the return leg starts on the MOON ──
      // A fleet launches from whichever body is active in the sidebar, and
      // after a save the active body is still the (now empty) planet. So the
      // moon has to be selected first, or the "return" would fly nothing from
      // the planet to itself. The sidebar renders each moon right after its
      // planet, so the base planet's entry identifies its moon — no coord
      // parsing, no guessing which of the moons is ours.
      if (mission.step === "switch_to_body" || mission.step === "switch_to_moon") {
        // v2.28.0: generalised from "switch to the moon". Either body can be
        // the refuge now, so the step switches to mission.launchBody — the one
        // the fleet fled to and must take off from. Old missions that still say
        // switch_to_moon mean the moon.
        const want = mission.launchBody || "moon";
        const here = MoonSave.currentBody();
        const sidebar = document.querySelectorAll("a.planet-select, .planet-select, a.moon-select, .moon-select");
        if (!sidebar.length) {
          // No sidebar on this page — go where there is one instead of giving up.
          log("[RATUNEK] brak listy planet na tej stronie — przechodzę na Overview i wracam do powrotu.", "fleet");
          mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
          await AntiDetection.sleep(500 + Math.random() * 500);
          window.location.href = "/overview";
          return;
        }
        if (here === want) {
          log(`[RATUNEK] jesteśmy już na właściwym ciele (${want === "moon" ? "księżyc" : "planeta"}) — lecę prosto do formularza.`, "fleet");
          mission.step = "select_ships_direct";
          mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
          await AntiDetection.sleep(500 + Math.random() * 500);
          window.location.href = mission.fleetUrl;
          return;
        }
        // Find the base entry in the sidebar. The game renders each moon right
        // after its planet, so the pair identifies itself by adjacency — no
        // coordinate parsing, and it works whichever half is currently active.
        const b = mission.atCoords || CONFIG.asteroidMining.minerBase;
        let target = null;
        const planets = [...document.querySelectorAll("a.planet-select, .planet-select")];
        for (const p of planets) {
          const href = p.getAttribute("href") || "";
          const isBase = b && href.includes(`${b.galaxy}`) && href.includes(`${b.system}`) && href.includes(`${b.position}`);
          let moon = p.nextElementSibling;
          while (moon && !(moon.classList && moon.classList.contains("moon-select"))) moon = moon.nextElementSibling;
          const mineHere = isBase || p.classList.contains("selected") ||
                           (moon && moon.classList.contains("selected"));
          if (!mineHere) continue;
          target = want === "moon" ? moon : p;
          if (isBase) break;
        }
        if (!target) {
          // Never disarm on failure: the fleet is still parked on the refuge and
          // the guard is the only way back through the bot.
          log(`[RATUNEK] POWRÓT NIEUDANY: nie znalazłem ${want === "moon" ? "księżyca" : "planety"} bazy na liście. Flota ZOSTAJE na miejscu, straż działa — kliknij WRÓĆ jeszcze raz albo przenieś ją ręcznie.`, "error");
          ThreatLog.add("BŁĄD", `Powrót przerwany: brak ${want === "moon" ? "księżyca" : "planety"} bazy na liście planet. Flota została na refugium.`);
          GM_setValue("pending_mission", null);
          return;
        }
        log(`[RATUNEK] przełączam aktywne ciało na ${want === "moon" ? "księżyc" : "planetę"} bazy…`, "fleet");
        mission.step = "switch_planet_then_fleet";
        mission.switchToFleetUrl = mission.fleetUrl;
        mission.timestamp = Date.now();
        GM_setValue("pending_mission", JSON.stringify(mission));
        await AntiDetection.sleep(600 + Math.random() * 600);
        const href = target.getAttribute("href");
        if (href && href.length > 1) window.location.href = href; else target.click();
        return;
      }

      // ── Direct asteroid mining: fleet URL has coords + mission pre-set ──
      // 3-step form on same page: Select ships → Confirm destination → Send fleet
      if (mission.step === "select_ships_direct" && page === "fleet") {
        // ── v2.10.23/24: same-target send guard (defence in depth) ──
        // Nothing downstream re-checks DispatchedAsteroids, so ANY path that
        // replays a pending_mission (send succeeded but the browser never
        // reached fleetSendSuccessfully, so pending_mission was never cleared
        // and the next page load resumes it) dispatches a second fleet to the
        // exact same coords. Window is short vs DispatchedAsteroids' 1h so a
        // legitimately respawned asteroid at the same coords is still mineable
        // later.
        // v2.10.24: compare COORDS, not url strings — the same asteroid gets a
        // different fleetUrl per detection method (raw game href vs
        // reconstructed /fleet?x=..&y=..), so url-equality let dupes through
        // whenever two dispatch cycles detected it differently (observed
        // 2026-07-20: 2-3 fleets to one asteroid, minutes apart).
        // v2.14.0: EXPEDITIONS ARE EXEMPT. Both guards below exist to stop two
        // fleets landing on one asteroid; an expedition wave is the opposite —
        // 8 fleets to the SAME [g:s:16] minutes apart IS the feature. Leaving
        // the guard on would have let wave 1 through and silently blocked
        // waves 2..N as "duplicates".
        const SEND_GUARD_MS = 10 * 60 * 1000;
        const missionCoord = coordsFromFleetUrl(mission.fleetUrl);
        if (!mission.expedition && !mission.moonSave) try {
          const lastSent = readLastSent(); // v2.10.25: GM + localStorage, newest wins
          const sameTarget = lastSent && (
            (missionCoord && lastSent.coord && lastSent.coord === missionCoord) ||
            lastSent.url === mission.fleetUrl // fallback when coords unparseable
          );
          // v2.10.25: block until the fleet's ARRIVAL when known (stamped at
          // send time from the game's own flight-time display) — after arrival
          // the asteroid is consumed and a same-coords respawn is fair game.
          // Fallback: flat 10min window.
          const blockedUntil = lastSent ? (lastSent.releaseAt || lastSent.at + SEND_GUARD_MS) : 0;
          if (sameTarget && Date.now() < blockedUntil) {
            const agoSec = Math.round((Date.now() - lastSent.at) / 1000);
            log(`DUPLICATE BLOCKED: already sent a fleet to [${missionCoord || mission.fleetUrl}] ${agoSec}s ago. Not sending again.`, "warn");
            GM_setValue("pending_mission", null);
            return; // inside the try — the finally resets _handlingMission
          }
        } catch {}

        // v2.10.25: server-truth check — catches a fleet launched seconds ago
        // by another tab, another browser or another machine, which no local
        // storage guard can see. Expeditions skip it for the same reason as above.
        const alreadyFlying = (mission.expedition || mission.moonSave) ? null : await fleetAlreadyFlyingTo(missionCoord);
        if (alreadyFlying) {
          log(`DUPLICATE BLOCKED (server events via ${alreadyFlying}): a fleet is already en route to [${missionCoord}]. Aborting send.`, "warn");
          GM_setValue("pending_mission", null);
          return;
        }

        log("Fleet page loaded (direct asteroid). Starting 3-step dispatch...", "fleet");

        // Flight time captured in step 2, used by finishDispatch
        let capturedFlightMs = 0;
        // v2.10.0: miner counts captured at step 1, read by finishDispatch to
        // decide parallel-vs-wait. Also persisted to ogamex_last_dispatch so the
        // fleetSendSuccessfully init handler (the usual post-send entry point)
        // can make the same decision.
        let dispatchInfo = { available: 0, toSend: 0 };

        // ── Helper: after dispatch, decide whether to resume scan or wait ──
        // dispatchOk=true: fleet sent → resume scanning if miners remain home
        //   and a fleet slot is free (parallel), else wait for a fleet to return.
        // dispatchOk=false: dispatch failed → resume scan (try next asteroid)
        const finishDispatch = async (dispatchOk) => {
          GM_setValue("pending_mission", null);
          // ── v2.11.0: farm missions manage their own state — the mining
          // wait/return timers below must stay untouched (they'd pause the
          // asteroid scanner over an HC attack). Success AND failure both just
          // hand control back to the farmer (next target / resume sweep);
          // a failed target stays on its FarmedTargets cooldown.
          // v2.14.0: expeditions own their pacing/counters and must not touch
          // the mining wait timers (a 1h expedition would pause the scanner).
          if (mission.moonSave) {
            if (dispatchOk) log("[MOON SAVE] fleet and resources are on the moon.", "success");
            return;
          }
          if (mission.expedition) {
            if (dispatchOk) {
              const storedExp = parseInt(GM_getValue("ogamex_inflight_fleets", "0")) || 0;
              GM_setValue("ogamex_inflight_fleets", String(storedExp + 1));
              GM_setValue("ogamex_last_dispatch_at", String(Date.now()));
              ExpeditionRunner.afterSend();
            }
            return;
          }
          if (mission.farm) {
            if (dispatchOk) {
              // Same in-flight bump as the fleetSendSuccessfully farm branch
              // (this path runs when the click did NOT navigate away).
              const storedNow2 = parseInt(GM_getValue("ogamex_inflight_fleets", "0")) || 0;
              GM_setValue("ogamex_inflight_fleets", String(storedNow2 + 1));
              GM_setValue("ogamex_last_dispatch_at", String(Date.now()));
              Humanizer.recordAttack(); // v2.12.0: daily cap counter
            }
            await InactiveFarmer.afterSend();
            return;
          }
          if (dispatchOk) {
            // Decide parallel vs wait based on miners left home + free slots.
            const goParallel = decideAfterMiningSend({
              available: dispatchInfo.available,
              toSend: dispatchInfo.toSend,
              capturedFlightMs,
            });
            if (goParallel) {
              const remainingScan = ScanState.load();
              if (remainingScan?.active && remainingScan.queue?.length > 0) {
                const next = remainingScan.queue[0];
                await AntiDetection.shortDelay();
                scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "parallel resume");
              } else {
                endSweepWithCooldown("Queue exhausted after dispatch"); // v2.12.4
              }
              return;
            }
            ScanState.clear();
            return;
          }
          // Dispatch failed — check WHY before resuming
          // If we have captured flight time, use it (miners were probably just sent)
          if (capturedFlightMs > 0) {
            const returnTime = Date.now() + capturedFlightMs * 2 + 60000;
            GM_setValue("ogamex_fleet_return_at", String(returnTime));
            GM_setValue("ogamex_dispatch_fail_at", "0"); // not a real failure — miners in flight
            const minLeft = Math.ceil((returnTime - Date.now()) / 60000);
            log(`Using captured flight time. Miners return in ~${minLeft}min.`, "asteroid");
            ScanState.clear();
            return;
          }
          // No captured time — check if already have a stored return time
          const storedReturn = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
          if (storedReturn && Date.now() < storedReturn) {
            GM_setValue("ogamex_dispatch_fail_at", "0"); // not a real failure
            const minLeft = Math.ceil((storedReturn - Date.now()) / 60000);
            log(`Miners in flight. Waiting ~${minLeft}min for return.`, "asteroid");
            ScanState.clear();
            return;
          }
          // No stored time — try parsing from page header (now filters by asteroid type)
          const parsedReturn = parseFleetReturnTime();
          if (parsedReturn && parsedReturn > Date.now()) {
            GM_setValue("ogamex_fleet_return_at", String(parsedReturn));
            GM_setValue("ogamex_dispatch_fail_at", "0"); // not a real failure
            const minLeft = Math.ceil((parsedReturn - Date.now()) / 60000);
            log(`Parsed asteroid fleet return from page: ~${minLeft}min.`, "asteroid");
            ScanState.clear();
            return;
          }
          // Last resort — conservative fallback
          const fleetText = document.body.textContent;
          const fleetActive = fleetText.match(/(\d+)\s*Missions?:\s*(\d+)\s*Own/);
          if (fleetActive && parseInt(fleetActive[2]) > 0) {
            const fallbackMs = CONFIG.asteroidMining.maxFlightMinutes * 2 * 60 * 1000;
            GM_setValue("ogamex_fleet_return_at", String(Date.now() + fallbackMs));
            GM_setValue("ogamex_dispatch_fail_at", "0"); // not a real failure — fleet active
            log(`Miners likely in flight (${fleetActive[2]} own missions). Estimated ~${CONFIG.asteroidMining.maxFlightMinutes * 2}min wait.`, "asteroid");
            ScanState.clear();
            return;
          }
          // No fleet in flight — resume scanning for next asteroid
          if (!mission.resumeScan) return;
          const remainingScan = ScanState.load();
          if (remainingScan?.active && remainingScan.queue?.length > 0) {
            const next = remainingScan.queue[0];
            log(`Dispatch failed, resuming scan: ${remainingScan.queue.length} systems left. Next: [${next.galaxy}:${next.system}]`, "asteroid");
            await AntiDetection.shortDelay();
            scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "post-dispatch resume");
          } else {
            endSweepWithCooldown("Queue exhausted after failed dispatch"); // v2.12.4
          }
        };

        // ── Helper: dump visible buttons for debugging ──
        const dumpButtons = (label) => {
          const btns = Array.from(document.querySelectorAll("a, button, input[type='submit'], input[type='button']"))
            .filter(el => el.offsetParent !== null)
            .map(el => {
              const txt = (el.value || el.textContent || "").trim().substring(0, 40);
              return txt ? `"${txt}"[${el.tagName}${el.className ? '.' + el.className.split(' ')[0] : ''}]` : null;
            })
            .filter(Boolean)
            .slice(0, 15);
          log(`[${label}] Buttons: ${btns.join(", ")} | URL: ${window.location.pathname}`, "fleet");
        };

        // ── Helper: find button and click with multiple methods ──
        const clickButton = (text, label) => {
          const fleetArea = document.querySelector("#content, .content, main, #fleet, .fleet-content, .fleet-form") || document.body;
          let btn = Array.from(fleetArea.querySelectorAll("a, button, input[type='submit']")).find(
            el => el.textContent.trim() === text && el.offsetParent !== null
          );
          if (!btn) {
            btn = fleetArea.querySelector(`input[value="${text}"]`);
          }
          if (!btn) {
            btn = Array.from(document.querySelectorAll("a, button, input[type='submit']")).find(
              el => el.textContent.trim() === text && el.offsetParent !== null &&
                    !el.closest(".sidebar, nav, .planet-list, #ogx-bot-panel") &&
                    !el.classList.contains("text-item") && !el.classList.contains("resource-item")
            );
          }
          if (!btn) return false;
          // v2.10.23: click ONCE. HTMLElement.click() already dispatches a
          // bubbling click event and runs the default action, so the extra
          // dispatchEvent(new MouseEvent("click")) that used to follow it fired
          // every handler a SECOND time. On "Next" that could skip a wizard
          // step; on "Send fleet" it launched a duplicate fleet (see step 3).
          btn.click();
          log(`Clicked "${text}" (${btn.tagName}.${btn.className} id=${btn.id}) [${label}]`, "fleet");
          return true;
        };

        // ── Helper: wait for DOM change (step transition) ──
        const waitForStepChange = async (indicator, maxWaitMs = 8000) => {
          const start = Date.now();
          while (Date.now() - start < maxWaitMs) {
            await AntiDetection.sleep(500);
            if (indicator()) return true;
          }
          return false;
        };

        // ═══ STEP 1: Select Asteroid Miners ═══
        await AntiDetection.sleep(1500 + Math.random() * 2000);

        const allShips = document.querySelectorAll("[data-ship-type]");
        const shipDump = Array.from(allShips).map(s =>
          `${s.dataset.shipType}(qty:${s.dataset.shipQuantity},tag:${s.tagName})`
        ).join(", ");
        log(`Ships on page: ${shipDump || "NONE"}`, "fleet");
        dumpButtons("step1-before");

        // ── v2.17.0: fleet save takes EVERYTHING ──
        // No splitting, no exclusions, no reserve: every hull on the planet
        // goes, miners included. The whole point is that nothing is left where
        // the attack lands.
        if (mission.moonSave) {
          // ── v2.34.0: powrót do miejsca, w którym flota już jest, to nie powrót ──
          // Właściciel: „flotę ma przenosić gdy leci na nią atak" — i miał rację,
          // że to, co robił bot, nie ma z tym nic wspólnego. Po fałszywym alarmie
          // z 09:24 flota wróciła na księżyc, ale straż została uzbrojona, więc
          // powrót odpalał w kółko: przełącz na planetę, wejdź na formularz,
          // ustaw cel KSIĘŻYC — stojąc już na księżycu. Cel równy źródłu, więc
          // gra wyszarza „Next" i lecimy w timeout. I tak w nieskończoność.
          const bodyNow = MoonSave.currentBody();
          if (mission.moonReturn && bodyNow && bodyNow === mission.targetBody) {
            log(`[RATUNEK] flota jest już na ${bodyNow === "moon" ? "księżycu" : "planecie"} — nie ma czego ściągać. Kończę powrót.`, "success");
            ThreatLog.add("POWRÓT", `Flota już na ${bodyNow === "moon" ? "księżycu" : "planecie"} (cel powrotu) — powrót zbędny, straż zdjęta.`);
            GM_setValue("pending_mission", null);
            MoonSave.disarm("flota już na ciele docelowym");
            return;
          }
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          const loaded = [];
          for (const el of document.querySelectorAll("[data-ship-type]")) {
            const type = el.dataset.shipType;
            const available = parseInt(el.dataset.shipQuantity || "0") || 0;
            if (!type || available <= 0) continue;
            const item = el.closest(".ship-item") || el.parentElement;
            const input = item?.querySelector("input.numberFormatInput, input[type='text']");
            if (!input) continue;
            if (nativeSetter) nativeSetter.call(input, available); else input.value = available;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            loaded.push(`${type}×${available}`);
            // Emergency: no human-pacing delay here. Every second counts and a
            // fleet save is exactly the moment a real player also hammers it.
          }
          if (!loaded.length) {
            log("[MOON SAVE] nothing on this planet to save — aborting.", "warn");
            GM_setValue("pending_mission", null);
            // v2.34.0: przy POWROCIE pusto na refugium znaczy, że nie ma czego
            // ściągać — flota już wróciła albo jest w drodze. Ponawianie tego
            // co pięć minut to była właśnie ta pętla, którą właściciel widział.
            if (mission.moonReturn) {
              ThreatLog.add("POWRÓT", "Na refugium pusto — nie ma czego ściągać. Straż zdjęta.");
              MoonSave.disarm("refugium puste — powrót bezprzedmiotowy");
            }
            return;
          }
          log(`[MOON SAVE] loading everything: ${loaded.join(", ")}`, "success");
          ThreatLog.add("RATUNEK", `Załadowano: ${loaded.join(", ")}`);
        } else

        // ── v2.14.0: expeditions fill MANY types in one go ──
        // Mining/farming send a single ship type; an expedition takes the whole
        // combat fleet split into `waves`. Same input-writing mechanics as
        // below (native setter + input/change — React-style bindings ignore a
        // plain .value assignment), just applied per type.
        if (mission.expedition) {
          const { plan, skipped, empty } = expeditionShipPlan(mission.waves);
          if (!plan.length) {
            const why = shipDump === "NONE"
              ? "the hangar is empty (everything is already in the air)"
              : `excluded: ${skipped.join(", ") || "none"}; none left of: ${empty.join(", ") || "none"}`;
            log(`Expedition: no ships to send on the active planet — ${why}. Ships: ${shipDump}`, "warn");
            GM_setValue("pending_mission", null);
            // Back off a full wave-gap so we don't retry every tick.
            ExpeditionState.save({ ...ExpeditionState.load(), lastSendAt: Date.now(), nextGapMs: 10 * 60 * 1000 });
            return;
          }
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          const filled = [];
          for (const p of plan) {
            const el = document.querySelector(`[data-ship-type="${p.type}"]`);
            const item = el?.closest(".ship-item") || el?.parentElement;
            const input = item?.querySelector("input.numberFormatInput, input[type='text']");
            if (!input) { log(`Expedition: no input for ${p.type} — skipping it.`, "warn"); continue; }
            if (nativeSetter) nativeSetter.call(input, p.qty); else input.value = p.qty;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            filled.push(`${p.type}×${p.qty}`);
            // v2.16.0: a human fills eleven boxes one after another, not all of
            // them inside the same millisecond. Cheap, and it's the kind of
            // timing signature that's actually visible to a server.
            await AntiDetection.sleep(120 + Math.random() * 380);
          }
          if (!filled.length) {
            log("Expedition: could not fill any ship input — aborting wave.", "error");
            GM_setValue("ogamex_dispatch_fail_at", String(Date.now()));
            GM_setValue("pending_mission", null);
            return;
          }
          log(`Expedition wave composition (1/${mission.waves} of the fleet): ${filled.join(", ")}`, "fleet");
        } else {

        // Find the ship to send. Farm missions name their ship explicitly
        // (HEAVY_CARGO); asteroid missions try configured types first, then
        // fall back to ASTEROID/MINER naming.
        const shipTypesToTry = mission.farm
          ? [mission.shipType]
          : [
              ...(CONFIG.asteroidMining.minerShipTypes || []),
              "ASTEROID_MINER", "ASTEROID", "MINER"
            ];
        let minerBtn = null;
        for (const shipType of shipTypesToTry) {
          minerBtn = document.querySelector(`[data-ship-type="${shipType}"]`) ||
                     document.querySelector(`[data-ship-type*="${shipType}"]`);
          if (minerBtn) {
            log(`Using ship type: ${shipType}`, "fleet");
            break;
          }
        }
        if (minerBtn) {
          const shipItem = minerBtn.closest(".ship-item") || minerBtn.parentElement;
          const input = shipItem?.querySelector("input.numberFormatInput, input[type='text']");
          const available = parseInt(minerBtn.dataset?.shipQuantity || input?.getAttribute("max-ships") || "0");
          // Right-sized send: mission.quantity comes from AsteroidYieldTracker
          // .minersNeeded() (0 = all available, the legacy fallback).
          const toSend = mission.quantity > 0 ? Math.min(mission.quantity, available) : available;
          // Record for the post-send parallel decision (both finishDispatch and
          // the fleetSendSuccessfully init handler read ogamex_last_dispatch).
          dispatchInfo = { available, toSend };
          // ogamex_last_dispatch feeds the MINING parallel decision
          // (minersHomeAfterLastDispatch) — HC counts must not pollute it.
          // v2.12.3 plausibility guard, recalibrated in v2.12.4: the 10M cap
          // false-flagged this server's REAL fleet (5 201 651 389 miners is a
          // genuine count on athena's inflated economy — confirmed against the
          // fleet page's own ship list). The guard now only catches true parse
          // garbage (e.g. concatenated digit runs), which lands far above any
          // real count. Above the cap store nothing: minersHomeAfterLastDispatch
          // returns "unknown", the designed fail-open path (keep scanning,
          // verify with the live ship count at dispatch time).
          if (!mission.farm) {
            const AVAIL_SANITY_CAP = 1_000_000_000_000; // 1e12
            if (available <= AVAIL_SANITY_CAP) {
              GM_setValue("ogamex_last_dispatch", JSON.stringify({ available, toSend, at: Date.now() }));
            } else {
              GM_setValue("ogamex_last_dispatch", "null");
              log(`Ship count sanity: available=${available} exceeds ${AVAIL_SANITY_CAP.toLocaleString()} — not recording (miners-home = unknown, verify at dispatch).`, "warn");
            }
          }

          if (input && toSend > 0) {
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) nativeSetter.call(input, toSend);
            else input.value = toSend;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            log(`Selected ${toSend}/${available} Asteroid Miners (input: ${input.className})`, "fleet");
          } else {
            log(`No ${mission.farm ? "Heavy Cargo" : "Asteroid Miners"} available (found: ${available}, input: ${!!input})`, "error");
            GM_setValue("ogamex_dispatch_fail_at", String(Date.now()));
            // v2.11.1: farm with 0 HC on the active planet would otherwise
            // burn through the whole target queue (each retry stamps a target
            // cooldown and navigates for nothing). Pause the sweep instead.
            if (mission.farm) {
              FarmState.clear();
              GM_setValue("ogamex_farm_cooldown_until", String(Date.now() + 10 * 60 * 1000));
              log("Farm: no Heavy Cargo on the active planet — sweep paused 10min.", "warn");
              GM_setValue("pending_mission", null);
              return;
            }
            await finishDispatch(false);
            return;
          }
        } else {
          // No Asteroid Miners on this planet — try switching to another planet.
          // Track tried planets by coord key from the active sidebar entry. If we
          // can't detect the current planet from DOM (rare), fall back to using
          // the previously-stored "last switched to" key from a prior rotation
          // step so we still avoid an infinite loop.
          const triedPlanets = JSON.parse(GM_getValue("ogamex_tried_planets", "[]"));
          const currentPlanet = GameState.getCurrentPlanet();
          const lastSwitched = GM_getValue("ogamex_last_switched_planet", null);
          const currentKey = currentPlanet
            ? `${currentPlanet.galaxy}:${currentPlanet.system}:${currentPlanet.position}`
            : (lastSwitched || `unknown-${Date.now()}`);
          if (!triedPlanets.includes(currentKey)) {
            triedPlanets.push(currentKey);
            GM_setValue("ogamex_tried_planets", JSON.stringify(triedPlanets));
          }

          const planets = GameState.getPlanets();
          const nextPlanet = planets.find(p => {
            const key = `${p.galaxy}:${p.system}:${p.position}`;
            return !triedPlanets.includes(key) && p.link;
          });

          if (nextPlanet) {
            const nextKey = `${nextPlanet.galaxy}:${nextPlanet.system}:${nextPlanet.position}`;
            GM_setValue("ogamex_last_switched_planet", nextKey);
            log(`No Asteroid Miners on ${currentKey}. Trying ${nextPlanet.name} [${nextKey}]...`, "asteroid");
            // Keep the pending_mission, switch planet then go to fleet page
            mission.timestamp = Date.now(); // refresh expiry
            // First step: navigate to planet page to select it
            // Second step: navigate to fleet with asteroid coords (on next page load)
            mission.step = "switch_planet_then_fleet";
            mission.switchToFleetUrl = mission.fleetUrl;
            GM_setValue("pending_mission", JSON.stringify(mission));
            await AntiDetection.sleep(800 + Math.random() * 400);
            // Navigate to planet page to change active planet
            window.location.href = nextPlanet.link;
            return;
          } else {
            GM_setValue("ogamex_tried_planets", "[]"); // reset for next time
            GM_setValue("ogamex_last_switched_planet", "");
            // Check if miners are in flight — that's why they're absent from all planets
            const fleetReturnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
            if (fleetReturnAt && Date.now() < fleetReturnAt) {
              const waitMin = Math.ceil((fleetReturnAt - Date.now()) / 60000);
              log(`Asteroid Miners absent from all planets — fleet in flight (~${waitMin}min). Clearing stale mission.`, "asteroid");
              GM_setValue("pending_mission", null);
              return;
            }
            log(`Asteroid Miner not found on ANY planet! Ships: ${shipDump}`, "error");
            GM_setValue("ogamex_dispatch_fail_at", String(Date.now()));
            await finishDispatch(false);
            return;
          }
        }
        } // end single-ship-type path (v2.14.0)

        await AntiDetection.sleep(1000 + Math.random() * 1500);

        // Click "Next" — step 1 → step 2
        if (!clickButton("Next", "step1→2")) {
          dumpButtons("step1-fail");
          log("Cannot find Next button (step 1)", "error");
          GM_setValue("ogamex_dispatch_fail_at", String(Date.now()));
          await finishDispatch(false);
          return;
        }

        // ═══ STEP 2: Wait for destination form ═══
        const step2Ready = await waitForStepChange(() => {
          return Array.from(document.querySelectorAll("a, button")).some(
            el => el.textContent.trim() === "Back" && el.offsetParent !== null
          );
        });
        if (!step2Ready) {
          dumpButtons("step2-timeout");
          log("Step 2 never loaded (no Back button after 8s)", "error");
          GM_setValue("ogamex_dispatch_fail_at", String(Date.now()));
          await finishDispatch(false);
          return;
        }
        log("Step 2 loaded (destination)", "fleet");
        dumpButtons("step2");

        // ── v2.26.0: the moon is a DESTINATION TYPE, not a link ──
        // Owner walked the form by hand and showed what the game actually does:
        // step 2's Destination panel offers planet / moon / debris for the SAME
        // coordinates, and step 3 then offers Transport / Deploy / Collect.
        // There is no moon link in the galaxy row to learn — which is why the
        // fleet save sat "cel nieznany" through every visit. Target the base
        // coords like any other fleet and pick the body here.
        if (mission.moonSave) {
          // v2.28.0: the target body is decided at dispatch time and carried on
          // the mission, because "flee" and "home" are no longer fixed to moon
          // and planet — either can be the base. Old missions without the field
          // keep the pre-2.28 meaning.
          const wantMoon = mission.targetBody ? mission.targetBody === "moon" : !mission.moonReturn;
          const panel = document.querySelector("#fleet2, .fleet2, .destination, [class*='destination']") || document.body;
          if (GM_getValue("ogamex_step2_markup_dumped", "") !== "1") {
            GM_setValue("ogamex_step2_markup_dumped", "1");
            log(`[MOON DOM] step-2 destination panel: ${(panel.innerHTML || "").replace(/\s+/g, " ").trim().slice(0, 1200)}`, "info");
          }
          // Candidates for the body switch, narrowed to the form: the sidebar's
          // own .planet-select/.moon-select are the PLANET SWITCHER and must not
          // be touched here — clicking those changes which planet we fly FROM.
          const inSidebar = (el) => !!el.closest(".planet-select, .moon-select, .sidebar, nav, #ogx-bot-panel");
          // v2.26.1: the live dump settled the markup — the switch is
          //   <a data-name="Moon" data-planet-type="2" class="moon-icon">
          // with 1=Planet, 2=Moon, 3=Debris. Match the DATA ATTRIBUTE, not a
          // regex over class names: "planet" appears in half the ids on this
          // page (#target_planet_type_name, .planet-coord, .planet-name), so
          // the fuzzy match for the RETURN leg could have grabbed a label
          // instead of the button and quietly left the target on the moon.
          const wantType = wantMoon ? "2" : "1";
          const byData = [...panel.querySelectorAll(`[data-planet-type="${wantType}"]`)]
            .filter(el => !inSidebar(el));
          const wanted = wantMoon ? /moon-icon/i : /planet-icon/i;
          const pick = byData[0] || [...panel.querySelectorAll("a, button")]
            .filter(el => el.offsetParent !== null && !inSidebar(el))
            .find(el => wanted.test(`${el.className || ""} ${el.getAttribute("data-name") || ""}`));
          if (pick) {
            pick.click();
            log(`[MOON SAVE] cel: ${wantMoon ? "KSIĘŻYC" : "PLANETA"} — kliknięto ${pick.tagName}.${(pick.className || "").toString().split(" ")[0] || "-"}`, "fleet");
            ThreatLog.add("RATUNEK", `Cel ustawiony: ${wantMoon ? "KSIĘŻYC" : "PLANETA"}`);
            await AntiDetection.sleep(400 + Math.random() * 400);
          } else {
            log(`[MOON SAVE] NIE ZNALAZŁEM przełącznika ${wantMoon ? "księżyca" : "planety"} na kroku 2 — lecę z domyślnym celem (to jest PLANETA). Zrzut panelu wyżej: przyślij go, dopiszę selektor.`, "error");
            ThreatLog.add("BŁĄD", `Nie znalazłem przełącznika ${wantMoon ? "księżyca" : "planety"} na kroku 2 — cel domyślny (PLANETA).`);
          }
        }

        // ── v2.10.0: learn cargo-per-miner from the confirmation page ──
        // OGameX shows the selected fleet's total cargo capacity here. Divide
        // by the miners we selected to learn one miner's capacity, which feeds
        // AsteroidYieldTracker.minersNeeded(). Only learn when we know how many
        // we sent (dispatchInfo.toSend) and the user hasn't pinned it in config.
        try {
          if (!CONFIG.asteroidMining.cargoPerMiner && dispatchInfo.toSend > 0) {
            const cargoText = document.body.textContent;
            // "Cargo capacity: 1.234.567" / "Storage capacity" / "Ładowność"
            const cm = cargoText.match(/(?:cargo|storage|capacity|ladun|ładun|frachtraum|laderaum)\D{0,20}?([\d][\d.,\s]{2,})/i);
            if (cm) {
              const totalCargo = parseInt((cm[1] || "").replace(/[^\d]/g, ""), 10);
              if (Number.isFinite(totalCargo) && totalCargo > 0) {
                AsteroidYieldTracker.recordCargoPerMiner(totalCargo, dispatchInfo.toSend);
              }
            } else {
              log(`[CARGO?] couldn't parse cargo capacity on step 2 — verify markup to enable auto cargo learning`, "warn");
            }
          }
        } catch (e) { log(`Cargo learn error (non-fatal): ${e.message}`, "warn"); }

        // ── Capture flight time from step 2 (shown before sending) ──
        const step2Text = document.body.textContent;
        // Look for "Flight time: HH:MM:SS" or "Duration: HH:MM:SS" or countdown elements
        const ftMatch = step2Text.match(/(?:[Ff]light\s*(?:time|duration)|[Dd]uration|[Ff]lugdauer)[\s:]*(\d{1,2}):(\d{2}):(\d{2})/);
        if (ftMatch) {
          capturedFlightMs = (parseInt(ftMatch[1]) * 3600 + parseInt(ftMatch[2]) * 60 + parseInt(ftMatch[3])) * 1000;
          log(`Captured flight time from step 2: ${ftMatch[1]}h${ftMatch[2]}m${ftMatch[3]}s`, "fleet");
        }
        // Also check for data attributes with flight duration
        if (!capturedFlightMs) {
          const durationEl = document.querySelector("[data-duration], [data-flight-time], [data-flight-duration]");
          if (durationEl) {
            const dur = parseInt(durationEl.dataset.duration || durationEl.dataset.flightTime || durationEl.dataset.flightDuration || "0");
            if (dur > 0) {
              capturedFlightMs = dur > 1e6 ? dur : dur * 1000; // seconds or ms
              log(`Captured flight duration from DOM: ${Math.round(capturedFlightMs/1000)}s`, "fleet");
            }
          }
        }
        // Also try plain time pattern like "12:34" or "1:23:45" near flight-related text
        if (!capturedFlightMs) {
          const timeEl = document.querySelector(".flight-time, .duration, [class*='flight'], [class*='duration']");
          if (timeEl) {
            const tm = timeEl.textContent.match(/(\d{1,2}):(\d{2}):(\d{2})/);
            if (tm) {
              capturedFlightMs = (parseInt(tm[1]) * 3600 + parseInt(tm[2]) * 60 + parseInt(tm[3])) * 1000;
              log(`Captured flight time from element: ${tm[1]}h${tm[2]}m${tm[3]}s`, "fleet");
            }
          }
        }

        await AntiDetection.sleep(800 + Math.random() * 1200);

        // Click "Next" — step 2 → step 3
        if (!clickButton("Next", "step2→3")) {
          dumpButtons("step2-fail");
          log("Cannot find Next button (step 2)", "error");
          GM_setValue("ogamex_dispatch_fail_at", String(Date.now()));
          await finishDispatch(false);
          return;
        }

        // ═══ STEP 3: Wait for Send fleet button ═══
        const step3Ready = await waitForStepChange(() => {
          return Array.from(document.querySelectorAll("a, button, input[type='submit'], input[type='button']")).some(el => {
            if (el.offsetParent === null) return false;
            const txt = (el.value || el.textContent || "").trim().toLowerCase();
            return txt.includes("send fleet") || txt.includes("send") && txt.includes("fleet");
          });
        }, 12000);
        if (!step3Ready) {
          dumpButtons("step3-timeout");
          log("Step 3 never loaded (no Send fleet button after 12s)", "error");
          GM_setValue("ogamex_dispatch_fail_at", String(Date.now()));
          await finishDispatch(false);
          return;
        }
        log("Step 3 loaded (mission select)", "fleet");

        // ── v2.17.0: fleet save — pick "stay there", then take every resource ──
        if (mission.moonSave) {
          // Mission choice. The game tags each option with a class named after
          // the mission (seen live: A.mission-item.EXPEDITION,
          // A.mission-item.ASTEROID_MINING), so match on that and — when
          // nothing matches — DUMP what's on offer rather than click something
          // plausible. A wrong mission here flies the fleet somewhere else.
          const missions = [...document.querySelectorAll(".mission-item, [class*='mission-item']")];
          const nameOf = (el) => `${el.className || ""} ${el.textContent || ""}`.toUpperCase();
          let picked = null, matched = null;
          for (const want of MoonSave.MISSION_CANDIDATES) {
            picked = missions.find(m => nameOf(m).includes(want));
            if (picked) { matched = want; break; }
          }
          if (picked) {
            log(`[MOON SAVE] mission: "${(picked.textContent || "").trim().slice(0, 30)}" (${picked.className})`, "fleet");
            // v2.21.0: this is the fact the automatic trigger waits for. Until
            // a real send has shown which "fly there and stay" mission this
            // build offers, arming an unattended fleet mover would be guessing
            // with the whole fleet as the stake. One save proves it, forever.
            if (matched !== "TRANSPORT") MoonSave.proveMission(matched, picked.className || "");
            ThreatLog.add("RATUNEK", `Misja: ${(picked.textContent || "").trim().slice(0, 20)} (${matched})`);
            // v2.20.0: a transport UNLOADS and flies home, and with the moon at
            // the same coords "home" is minutes away — straight back onto the
            // planet, in time for the next wave. It stays as the last resort
            // (better on the moon for a few minutes than on the planet), but it
            // is the multi-wave watcher that then does the actual work.
            if (matched === "TRANSPORT") {
              log("[MOON SAVE] UWAGA: to transport, nie stacjonowanie — flota WRÓCI na planetę po rozładunku. Straż wielofalowa będzie ją zdejmować co ~90 s, ale przy wielu falach sprawdź grę.", "error");
            }
            picked.click();
            await AntiDetection.sleep(500 + Math.random() * 500);
          } else {
            log(`[MOON SAVE] no stationing-type mission matched. Available: ${missions.map(m => `${(m.textContent || "").trim().slice(0, 20)}[${m.className}]`).join(", ") || "NONE"} — sending with the page default.`, "warn");
          }

          // Resources: the form has a per-resource "max" and an all-in-one
          // button (observed live as A.btn-all-res). Take everything — loot is
          // half the reason the attack is coming.
          const allRes = document.querySelector("a.btn-all-res, .btn-all-res");
          if (allRes) {
            allRes.click();
            log("[MOON SAVE] all resources loaded.", "fleet");
          } else {
            const fulls = [...document.querySelectorAll("a.btn-res-full, .btn-res-full")];
            fulls.forEach(b => b.click());
            log(fulls.length
              ? `[MOON SAVE] loaded resources via ${fulls.length} per-resource max buttons.`
              : "[MOON SAVE] no resource-load button found — ships fly, resources stay.", fulls.length ? "fleet" : "warn");
          }
          await AntiDetection.sleep(400 + Math.random() * 400);
        }

        // ── v2.14.0: expedition holding time ──
        // Step 3 of an expedition carries an extra "Expedition duration"
        // dropdown ("1 Hours", …). Match by the option TEXT, not by index or
        // value — we've never seen this select's markup, and a wrong value
        // would silently change how long the fleet sits in deep space.
        if (mission.expedition) {
          const want = String(Math.max(1, mission.holdingHours || 1));
          let done = false;
          for (const sel of document.querySelectorAll("select")) {
            const opts = [...sel.options];
            if (!opts.some(o => /\b\d+\s*(hour|hours|h|godz)/i.test(o.textContent || ""))) continue;
            const hit = opts.find(o => (o.textContent || "").replace(/\s+/g, " ").trim().match(/^(\d+)\b/)?.[1] === want);
            if (!hit) { log(`Expedition: no "${want}h" option (have: ${opts.map(o => (o.textContent || "").trim()).join(", ")}) — leaving the default.`, "warn"); break; }
            sel.value = hit.value;
            sel.dispatchEvent(new Event("input", { bubbles: true }));
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            log(`Expedition duration set to ${hit.textContent.trim()}`, "fleet");
            done = true;
            break;
          }
          if (!done) log("Expedition: duration select not found — sending with the page default.", "warn");
          await AntiDetection.sleep(600 + Math.random() * 900);
        }
        dumpButtons("step3");

        await AntiDetection.sleep(800 + Math.random() * 1200);

        // Click "Send fleet" — dump all visible clickables for diagnostics
        let dispatchOk = false;
        const allClickables = Array.from(document.querySelectorAll("a, button, input[type='submit'], input[type='button']")).filter(el => el.offsetParent !== null);
        const clickableInfo = allClickables.map(el => {
          const txt = (el.value || el.textContent || "").trim().substring(0, 40).replace(/\s+/g, " ");
          return `"${txt}"[${el.tagName}.${el.className.split(" ").slice(0,2).join(".")} id=${el.id || "-"}]`;
        }).join(", ");
        log(`[step3-clickables] ${allClickables.length} elements: ${clickableInfo}`, "fleet");

        // Priority 1: exact "send fleet" text match
        // Priority 2: id/class containing "send-fleet" or "btn-send"
        // Priority 3: broader "send" in id/class (but NOT text-only "send" — too broad)
        const sendBtn = allClickables.find(el => {
          const txt = (el.value || el.textContent || "").trim().toLowerCase();
          return txt === "send fleet";
        }) || allClickables.find(el => {
          const txt = (el.value || el.textContent || "").trim().toLowerCase();
          return txt.includes("send fleet");
        }) || allClickables.find(el => {
          const id = (el.id || "").toLowerCase();
          const cls = (el.className || "").toLowerCase();
          return id.includes("send-fleet") || id.includes("btn-send") ||
                 cls.includes("send-fleet") || cls.includes("btn-send");
        });
        if (sendBtn) {
          log(`Send btn: ${sendBtn.tagName}.${sendBtn.className} id=${sendBtn.id || "-"} href=${sendBtn.href || 'none'} text="${(sendBtn.textContent||"").trim().substring(0,50)}"`, "fleet");
          // v2.10.23 — DOUBLE-SEND FIX. This used to be:
          //     sendBtn.click();
          //     sendBtn.dispatchEvent(new MouseEvent("click", {...}));
          // Both lines run the button's handler, so every dispatch fired the
          // fleet-send TWICE, milliseconds apart → two identical fleets to the
          // SAME coords. The first mined the asteroid ("Resource Obtained"),
          // the second arrived to nothing ("Asteroid Not Found") — 12 of 16
          // missions on 2026-07-20 were such duplicates.
          //
          // The bug is as old as v2.9.0 but was MASKED while the bot sent 100%
          // of miners per flight: the first send emptied the hangar, so the
          // duplicate had no ships and died server-side. v2.10.0 right-sizing
          // sends only part of the fleet, leaving miners home — so the second
          // click started succeeding. Hence "it suddenly broke".
          //
          // Stamp the target BEFORE clicking: the click often navigates away
          // instantly, so any code after it may never run. Marking intent first
          // means a replayed pending_mission hits the duplicate guard above.
          // v2.10.26: LAST-SECOND server recheck. The first check ran at the
          // start of the 3-step flow, ~10s ago — another machine/browser can
          // have sent a fleet in that window. Fetch-only (skipDom — the step-3
          // page may render our own chosen target as text).
          const flyingNow = (mission.expedition || mission.moonSave) ? null : await fleetAlreadyFlyingTo(missionCoord, { skipDom: true });
          if (flyingNow) {
            log(`DUPLICATE BLOCKED (pre-click, server events via ${flyingNow}): a fleet is already en route to [${missionCoord}]. Aborting send.`, "warn");
            GM_setValue("pending_mission", null);
            await finishDispatch(false); // sets the wait/return timer — that fleet is ours from elsewhere
            return;
          }

          // v2.10.25: stamp BEFORE the click (navigation may kill everything
          // after it), in BOTH storages. capturedFlightMs (game's own display,
          // step 2) lets us block re-sends only until ARRIVAL + 2min buffer —
          // after arrival the asteroid is consumed, so a respawn at the same
          // coords is legitimately mineable (the flat 1h block skipped those).
          {
            const releaseAt = capturedFlightMs > 0 ? Date.now() + capturedFlightMs + 120000 : undefined;
            // v2.12.1: `farm` flag lets fleetSendSuccessfully tell a late-nav
            // farm send apart from a mining send even after pending_mission
            // was already cleared by finishDispatch (slow-navigation race).
            // v2.14.0: an expedition stamp must NOT look like an asteroid one —
            // writeLastSent feeds the same-target guard, so stamping [g:s:16]
            // would make the next wave (and any asteroid at those coords) look
            // like a duplicate. Record the kind and drop the coord.
            writeLastSent({
              url: mission.fleetUrl,
              coord: mission.expedition ? null : missionCoord,
              at: Date.now(),
              releaseAt: mission.expedition ? Date.now() : releaseAt,
              farm: !!mission.farm,
              expedition: !!mission.expedition,
            });
            if (!mission.expedition && !mission.recycle && missionCoord && releaseAt) DispatchedAsteroids.release(missionCoord, releaseAt);
            // v2.39.1: osobny licznik NASZYCH lotow gorniczych (limit rownoleglych
            // lotow). Stemplujemy PRZED klikiem — nawigacja potrafi zabic wszystko,
            // co jest po nim.
            if (!mission.expedition && !mission.farm && !mission.moonSave && !mission.recycle) {
              MiningFlights.add(missionCoord, capturedFlightMs);
            }
          }
          sendBtn.click();

          await AntiDetection.sleep(3000);
          // v2.10.24: only a VISIBLE element with actual text counts as an
          // error. `[class*='error']` also matches hidden/empty error
          // containers baked into the page — a false positive here wiped the
          // duplicate-guard stamp (line below) after every send, killing the
          // guard exactly when it was needed.
          const errorMsg = Array.from(document.querySelectorAll(".error, .alert-danger, [class*='error']"))
            .find(el => el.offsetParent !== null && el.textContent.trim().length > 0);
          const successMsg = document.querySelector(".success, .alert-success, [class*='success']");
          const fleetMovement = document.body.textContent.includes("fleet movement") ||
                                document.body.textContent.includes("Fleet movement");

          if (errorMsg) {
            log(`DISPATCH FAILED! Error: ${errorMsg.textContent.trim().substring(0, 100)}`, "error");
            if (mission.moonSave) ThreatLog.add("BŁĄD", `Gra odrzuciła wysyłkę: ${errorMsg.textContent.trim().slice(0, 120)}`);
            // No fleet actually left — drop the duplicate-guard stamp so a
            // genuine retry to these coords isn't blocked for the next 10min.
            writeLastSent(null);
            // v2.39.1: ta flota nie wystartowala — zdejmij ja z licznika lotow
            // gorniczych, inaczej fantom zjadalby limit az do konca przelotu.
            if (!mission.expedition && !mission.farm && !mission.moonSave && !mission.recycle) MiningFlights.dropLast();
            GM_setValue("ogamex_dispatch_fail_at", String(Date.now()));
          } else if (successMsg || fleetMovement) {
            if (mission.moonSave) ThreatLog.add(mission.moonReturn ? "POWRÓT" : "RATUNEK", "WYSŁANE — gra przyjęła flotę.");
            if (mission.moonReturn) MoonSave.disarm("flota i surowce wróciły na planetę bazową");
            log(mission.moonReturn ? "POWRÓT ZAKOŃCZONY — flota i surowce lecą z księżyca na planetę. Mining i ekspedycje wracają do pracy."
              : mission.moonSave ? "FLEET SAVED — everything moved to the moon."
              : mission.expedition ? "EXPEDITION FLEET SENT!"
              : mission.farm ? "FARM FLEET SENT!"
              : "FLEET SENT! All miners dispatched!", "success");
            GM_setValue("ogamex_dispatch_fail_at", "0");
            GM_setValue("ogamex_tried_planets", "[]"); // reset planet rotation
            GM_setValue("ogamex_last_switched_planet", "");
            dispatchOk = true;

            // Use captured flight time from step 2 (actual asteroid mining flight time)
            // (v2.11.0: farm sends don't pause anything — no return timer.)
            // v2.15.1: `expedition` joins `farm` here. An expedition wave was
            // setting ogamex_fleet_return_at (90min fallback — its flight time
            // isn't parseable from the expedition form), and the asteroid
            // scanner then paused for an hour and a half waiting for "miners"
            // that were never sent. Observed live: "FLEET SENT! All miners
            // dispatched!" right after an expedition send to [3:269:16].
            if (capturedFlightMs > 0 && !mission.farm && !mission.expedition && !mission.moonSave && !mission.recycle) {
              // Round trip = flight time * 2, add 1 min buffer for processing
              const returnTime = Date.now() + capturedFlightMs * 2 + 60000;
              GM_setValue("ogamex_fleet_return_at", String(returnTime));
              const minLeft = Math.ceil((returnTime - Date.now()) / 60000);
              log(`Fleet returns in ~${minLeft}min (flight: ${Math.round(capturedFlightMs/60000)}min × 2)`, "fleet");
            } else if (!mission.farm && !mission.expedition && !mission.moonSave && !mission.recycle) {
              // Fallback: try parsing from page, but only accept asteroid-type
              const returnTime = parseFleetReturnTime();
              if (returnTime) {
                GM_setValue("ogamex_fleet_return_at", String(returnTime));
                const minLeft = Math.ceil((returnTime - Date.now()) / 60000);
                log(`Fleet returns at ${new Date(returnTime).toLocaleTimeString("pl-PL")} (~${minLeft}min)`, "fleet");
              } else {
                // Last resort: use maxFlightMinutes as pessimistic estimate
                const fallbackMs = CONFIG.asteroidMining.maxFlightMinutes * 2 * 60 * 1000;
                GM_setValue("ogamex_fleet_return_at", String(Date.now() + fallbackMs));
                log(`Could not parse flight time. Estimated return in ~${CONFIG.asteroidMining.maxFlightMinutes * 2}min`, "fleet");
              }
            }
          } else {
            const bodySnippet = document.body.innerText.substring(0, 300).replace(/\s+/g, ' ');
            log(`Fleet click done but UNVERIFIED. Page: ${bodySnippet}`, "fleet");
            GM_setValue("ogamex_dispatch_fail_at", "0");
            GM_setValue("ogamex_tried_planets", "[]");
            GM_setValue("ogamex_last_switched_planet", "");
            dispatchOk = true; // assume success if no error
            // Still use captured flight time if available (mining only)
            if (capturedFlightMs > 0 && !mission.farm && !mission.expedition && !mission.moonSave && !mission.recycle) {
              const returnTime = Date.now() + capturedFlightMs * 2 + 60000;
              GM_setValue("ogamex_fleet_return_at", String(returnTime));
              log(`Estimated return in ~${Math.ceil((capturedFlightMs * 2 + 60000) / 60000)}min`, "fleet");
            }
          }
        } else {
          dumpButtons("step3-no-send");
          log("Cannot find 'Send fleet' button (step 3)", "error");
          if (mission.moonSave) ThreatLog.add("BŁĄD", "Brak przycisku Send fleet na kroku 3 — ratunek NIE poleciał.");
          GM_setValue("ogamex_dispatch_fail_at", String(Date.now()));
        }

        // dispatchOk=true → all miners sent, stop scanning (wait for return)
        // dispatchOk=false → failed, resume scanning for next asteroid
        await finishDispatch(dispatchOk);
        return;
      }

      // ── Standard multi-step fleet dispatch ──
      if (mission.step === "select_ships" && page === "fleet") {
        const success = await FleetDispatcher.selectShipsAndNext(mission.shipType, mission.quantity);
        if (success) {
          mission.step = "set_target";
          mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
        } else {
          GM_setValue("pending_mission", null);
        }
      } else if (mission.step === "set_target" && page === "fleet") {
        const { galaxy, system, position } = mission.target;
        const success = await FleetDispatcher.setTargetAndNext(galaxy, system, position);
        if (success) {
          mission.step = "send_fleet";
          mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
        } else {
          GM_setValue("pending_mission", null);
        }
      } else if (mission.step === "send_fleet" && page === "fleet") {
        const success = await FleetDispatcher.selectMissionAndSend(mission.missionId);
        if (success) {
          log(`Mission ${mission.type} dispatched!`, "success");
        }
        GM_setValue("pending_mission", null);
      } else if (mission.step === "select_ships_direct" && page !== "fleet" && mission.fleetUrl) {
        // Race condition: pending_mission was set but we haven't navigated to
        // fleet yet (scheduler tick fired before navigation). Navigate now.
        log(`Mission waiting for fleet page (on ${page}). Navigating to ${mission.fleetUrl}`, "fleet");
        mission.timestamp = Date.now(); // refresh to prevent expiry
        GM_setValue("pending_mission", JSON.stringify(mission));
        await AntiDetection.sleep(500 + Math.random() * 500);
        window.location.href = mission.fleetUrl;
        return;
      } else {
        // Fall-through: we have a pending_mission but no branch matched.
        // This happens when the dispatch flow left a fleet-page step in
        // state but the user/bot navigated back to galaxy (e.g. after a
        // failed dispatch). Clear it immediately instead of looping for
        // 5 minutes waiting for the timestamp to expire.
        log(
          `Dropping stuck pending_mission (step=${mission.step}, page=${page})`,
          "warn"
        );
        GM_setValue("pending_mission", null);
      }
    } catch (err) {
      log(`Mission flow error: ${err.message}`, "error");
      GM_setValue("pending_mission", null);
    } finally {
      _handlingMission = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  SCHEDULER: Main loop
  // ═══════════════════════════════════════════════════════════════

  let schedulerTimer = null;

  async function schedulerTick() {
    // v2.10.28: the watchdog heartbeat is stamped by the LEADER only (plus the
    // disabled case, so a disabled bot doesn't look dead). A passive tab
    // stamping it MASKED a dead leader: the leader's lock heartbeat (its own
    // interval) kept it leader while its dead scheduler chain never acted, the
    // passive tab kept last_tick_at fresh, and the 25min watchdog never fired
    // in ANY tab — silently dead bot, forever. With leader-only stamping a
    // dead leader chain lets the stamp go stale → every tab's watchdog reloads
    // → re-init re-elects a working leader.
    if (!CONFIG.enabled) {
      GM_setValue("ogamex_last_tick_at", String(Date.now()));
      return;
    }

    // v2.10.25: only the leader tab acts — every other tab is a passive viewer.
    if (!requireLeader("scheduler")) return;
    GM_setValue("ogamex_last_tick_at", String(Date.now()));

    // Handle any pending multi-page mission first
    await handlePendingMission();

    // v2.36.0: obrona NIE jest już częścią ticku — ma własny zegar
    // (startDefenceLoop). Powód w audycie: jitter śpi WEWNĄTRZ ticku, a łańcuch
    // jest szeregowy, więc „przed każdą pauzą" nie chroniło przed pauzą, która
    // zatrzymuje cały zegar.

    // v2.12.0: coffee breaks — full-bot pause with human macro-pacing.
    if (Humanizer.isOnBreak()) {
      log(`On break (~${Humanizer.breakLeftMin()}min left) — no activity.`, "delay");
      return;
    }
    if (Humanizer.maybeStartBreak()) return;

    // v2.10.27: background yield learning (30min throttle inside, fail-open).
    AsteroidYieldTracker.fetchReportsPeriodic().catch(() => {});

    // Sleep check
    if (AntiDetection.isSleepTime()) {
      log("Night mode active - sleeping until " + CONFIG.antiDetection.sleepEndHour + ":00 (czas lokalny)", "delay");
      return;
    }

    // v2.21.0: the threat read moved above the pause gates (see the defence
    // block after handlePendingMission). Only the learning side-effects run
    // here, once the bot is genuinely active.
    ThreatMonitor.check();

    // v2.13.0: grab the green "Online bonus" if it's on screen. Placed before
    // the keepalive reload (which returns) and before jitter (which can sleep
    // 15min inside the tick) so a visible bonus is taken promptly. No-ops in
    // ~microseconds when the button isn't there (single textContent scan).
    await OnlineBonus.run().catch(() => {});

    // v2.10.10 keepalive: guarantee a REAL page load at least every ~12min.
    // After "scan complete — no asteroids" the bot used to sit 45min on one
    // galaxy page with zero requests; the session could expire in that window
    // and every later range-AJAX silently returned the login page (= blind
    // bot, see scanRanges). A periodic reload keeps the session fresh AND
    // resets any wedged in-page state (stuck flags, dead timer chains,
    // browser tab throttling). During an active scan navigation happens every
    // few seconds anyway, so this only fires during long waits/cooldowns.
    {
      const lastPageLoad = parseInt(GM_getValue("ogamex_last_pageload_at", "0"));
      const pendingRaw = GM_getValue("pending_mission", null);
      const hasPending = pendingRaw && pendingRaw !== "null";
      if (!hasPending && lastPageLoad && Date.now() - lastPageLoad > 12 * 60 * 1000) {
        log("Keepalive: no page load for >12min — reloading to keep session alive.", "info");
        if (window.location.href.includes("fleetSendSuccessfully")) {
          // Don't re-trigger the post-send handler with stale dispatch data
          window.location.href = "/overview";
        } else {
          window.location.reload();
        }
        return;
      }
    }

    // ── v2.14.0: expedition waves go BEFORE mining ──
    // Not a priority statement — a mechanical one. AsteroidMiner.run() usually
    // ends by navigating to the next galaxy page, and once the page unloads the
    // rest of this tick never executes. Left at the end of the tick (where the
    // old ExpeditionManager sat) a wave would almost never fire while a scan is
    // running. ExpeditionRunner.run() is a cheap no-op until a wave is actually
    // due (pacing + slot checks), it never starts on top of a pending dispatch,
    // and the scan self-heals from being interrupted — so preempting one scan
    // step every ~2min is the cheapest correct arrangement.
    if (CONFIG.expeditions.enabled && !ExpeditionRunner.running) {
      // v2.48.0: złom po ekspedycjach leży na pozycji 16 systemu bazy i nikt
      // po niego nie przyleci poza nami. Zbieranie ustępuje wszystkiemu innemu
      // (patrz shouldVisit), więc nie konkuruje z miningiem.
      if (DebrisCollector.shouldVisit()) { DebrisCollector.visit(); return; }
      await ExpeditionRunner.run();
      const pendingAfterExpo = GM_getValue("pending_mission", null);
      if (pendingAfterExpo && pendingAfterExpo !== "null") return; // wave in progress — mining waits one tick
    }

    // Run asteroid mining
    const scanState = ScanState.load();
    const scanActive = scanState?.active;

    // Jitter — skip when scan is actively running (don't delay mid-scan).
    // v2.12.3: also skip while the scan cooldown is ticking down. The cooldown
    // already IS an idle pause; a jitter rolled during it humanized nothing
    // (the bot was doing nothing anyway) and just pushed the next range check
    // 5-15min past cooldown expiry — observed 10min cooldowns stretching to
    // 20-25min of blindness while fresh hint ranges sat unscanned.
    const scanCooldownActive = (parseInt(GM_getValue("ogamex_scan_cooldown_until", "0")) || 0) > Date.now();
    if (!scanActive && !scanCooldownActive) await AntiDetection.jitter();
    if (CONFIG.asteroidMining.enabled && !AsteroidMiner.running) {
      // If a scan is active but we're not on the galaxy page (user navigated
      // away, or dispatch landed us elsewhere), resume by jumping to the next
      // queued system instead of letting the scan rot until 120min expiry.
      if (scanActive && GameState.getCurrentPage() !== "galaxy") {
        const next = scanState.queue?.[0];
        const fleetReturnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
        const minersInFlight = fleetReturnAt && Date.now() < fleetReturnAt;
        const pendingMission = GM_getValue("pending_mission", null);
        const dispatchInProgress = pendingMission && pendingMission !== "null";
        // v2.10.14: un-wedge the dead state "active scan + empty queue + off the
        // galaxy page". handleGalaxyScanStep (which finishes a sweep and sets the
        // cooldown) only runs ON the galaxy page; the stranded-resume below needs
        // a `next` system. So an exhausted queue reached while we're off-galaxy
        // (e.g. a dispatch that hit the flight budget left us on overview/
        // fleetSendSuccessfully without clearing ScanState) matches NEITHER this
        // branch nor the !scanActive one — the scheduler idles silently and only
        // the 12-min keepalive reload ticks, forever. Clearing the spent scan
        // lets the next tick's !scanActive path start a fresh one (deep fetch →
        // picks up current ranges & any new asteroids).
        if (!next && !dispatchInProgress) {
          // v2.12.4: this un-wedge used to clear WITHOUT a cooldown — after a
          // dispatch that consumed the queue (pruneFoundRange on a single
          // range) the very next tick re-swept the same still-advertised
          // range from scratch. Quiet cooldown instead; startNewScan deep-
          // fetches fresh ranges when it expires.
          endSweepWithCooldown("Active scan but queue empty & off galaxy page");
          return;
        }
        if (next && !minersInFlight && !dispatchInProgress && !AntiDetection.isSleepTime()) {
          log(`Scan stranded off galaxy page. Resuming at [${next.galaxy}:${next.system}]`, "asteroid");
          await AntiDetection.shortDelay();
          scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "stranded resume");
          return;
        }
      } else if (scanActive && GameState.getCurrentPage() === "galaxy") {
        // On galaxy page with active scan — resume if fleet has returned.
        // This fires when the bot waits on a galaxy page for fleet return and
        // the fleet comes back without a page navigation (no new init() call).
        const fleetReturnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
        const minersInFlight = fleetReturnAt && Date.now() < fleetReturnAt;
        if (!minersInFlight) {
          await AsteroidMiner.run();
        }
      } else if (!scanActive) {
        await AsteroidMiner.run();
      }
    }

    // v2.11.0: inactive farming (no-ops when disabled or when mining is ON)
    if (CONFIG.inactiveFarming?.enabled && !InactiveFarmer.running) {
      await InactiveFarmer.run();
    }

  }

  // ═══════════════════════════════════════════════════════════════
  //  PĘTLA OBRONY  (v2.36.0) — własny zegar, poza schedulerem
  // ═══════════════════════════════════════════════════════════════
  // Audyt 2026-08-02, ustalenie krytyczne nr 1: blok obrony stał w ticku
  // schedulera, a AntiDetection.jitter() robi `await sleep(5-15 min)` WEWNĄTRZ
  // ticku. Łańcuch jest szeregowy (`await schedulerTick(); scheduleNext();`),
  // więc jitter zatrzymywał cały zegar — i przez kilkanaście minut, kilka razy
  // na godzinę, nie było ANI JEDNEGO odczytu paska misji. Przeniesienie obrony
  // „przed pauzy" w v2.21.0 chroniło przed przerwą na kawę i snem, bo z nich
  // tick wraca; z jitteru nie wraca.
  //
  // Własny setInterval nie da się zagłodzić: nie zależy od ticku, jitteru,
  // przerw humanizera ani okna nocnego. To jedyny sposób, żeby „obrona działa
  // 24 h" było prawdą, a nie deklaracją.
  let defenceTimer = null;
  let defenceRunning = false;
  const DEFENCE_EVERY_MS = 30 * 1000;

  async function defenceTick() {
    if (defenceRunning) return;          // poprzedni przebieg jeszcze trwa
    if (!CONFIG.enabled) return;
    if (!requireLeader("defence")) return; // tylko karta-lider rusza flotą
    defenceRunning = true;
    try {
      // Nauki jednorazowe (wizyty w galaktyce) zostają za pauzą — to one
      // kazałyby „odpoczywającemu" botowi nawigować. Sam odczyt paska idzie
      // zawsze, bo od niego zależy atak.
      const resting = Humanizer.isOnBreak() || AntiDetection.isSleepTime();
      // v2.40.0: najpierw serwer (typ misji + cel), potem decyzja. Dwa lekkie
      // zapytania AJAX, te same, które robi sama gra co kilkanaście sekund.
      await ThreatMonitor.refreshEvents().catch(() => {});
      // v2.44.0: jeśli po minucie pracy nadal nie mamy ANI JEDNEGO odczytu
      // zdarzeń z serwera, zrób jednorazową diagnostykę — inaczej cisza wygląda
      // tak samo jak spokój.
      {
        const ticks = (parseInt(GM_getValue("ogamex_defence_ticks", "0")) || 0) + 1;
        GM_setValue("ogamex_defence_ticks", String(ticks));
        if (ticks >= 3 && !ThreatMonitor.events() && GM_getValue("ogamex_api_diag_done", "") !== "1") {
          GM_setValue("ogamex_api_diag_done", "1");
          log("[API TEST] po kilku przebiegach nadal brak odczytu zdarzeń z serwera — sprawdzam endpointy.", "warn");
          Ajax.diagnose().catch(() => {});
        }
      }
      ThreatMonitor.check({ emergencyOnly: resting });
      // v2.55.0: jeśli poprzedni tick przełączył planetę, dokończ ratunek tutaj.
      if (MoonSave.resumeAfterSwitch()) return;
      if (await MoonSave.autoSaveOnThreat().catch(() => false)) return;
      if (await MoonSave.returnHome().catch(() => false)) return;
      await MoonSave.keepPlanetEmpty().catch(() => false);

      // ── v2.39.0: gdy COŚ widzimy, patrz częściej ──
      // Potwierdzenie wymaga dwóch odczytów, a pętla chodzi co 30 s — więc
      // decyzja mogła zająć nawet minutę. Przy locie liczonym w minutach to
      // mieści się w normie, ale połowa okna ostrzegawczego schodziła na samo
      // czekanie na następne spojrzenie. Skoro kandydat jest, dogrywamy odczyt
      // po 10 s: potwierdzenie spada z ~60 s do ~35 s, a ruch w tle się nie
      // zmienia, bo dzieje się to tylko wtedy, gdy naprawdę coś zobaczyliśmy.
      if (parseInt(GM_getValue(ThreatMonitor.KEY_CANDIDATE, "0")) || 0) {
        setTimeout(() => { defenceTick().catch(() => {}); }, 10 * 1000);
      }
    } catch (err) {
      log(`[RATUNEK] błąd pętli obrony: ${err.message}`, "error");
      ThreatLog.add("BŁĄD", `Pętla obrony wyrzuciła wyjątek: ${err.message}`);
    } finally {
      defenceRunning = false;
    }
  }

  function startDefenceLoop() {
    if (defenceTimer) clearInterval(defenceTimer);
    defenceTimer = setInterval(() => { defenceTick().catch(() => {}); }, DEFENCE_EVERY_MS);
    setTimeout(() => { defenceTick().catch(() => {}); }, 1500); // pierwszy przebieg od razu
    log(`Pętla obrony uruchomiona (co ${DEFENCE_EVERY_MS / 1000}s, niezależnie od przerw i jitteru).`, "info");
  }

  function startScheduler() {
    if (schedulerTimer) clearTimeout(schedulerTimer);
    // Randomized interval: 50-90 seconds (not a fixed 60s heartbeat)
    function scheduleNext() {
      const intervalMs = (50 + Math.random() * 40) * 1000;
      schedulerTimer = setTimeout(async () => {
        await schedulerTick();
        scheduleNext();
      }, intervalMs);
    }
    // v2.15.0: stamp the heartbeat NOW. While the bot is off nothing ticks, so
    // last_tick_at goes stale; re-enabling it then tripped the 25min watchdog
    // within seconds and reloaded the page for no reason (seen at 13:32 —
    // "Bot ENABLED" at :06, "scheduler chain dead. Reloading." at :08).
    GM_setValue("ogamex_last_tick_at", String(Date.now()));
    // First run after random 3-8 seconds
    setTimeout(() => {
      schedulerTick();
      scheduleNext();
    }, 3000 + Math.random() * 5000);
    log("Scheduler started", "info");
  }

  function stopDefenceLoop() {
    if (defenceTimer) { clearInterval(defenceTimer); defenceTimer = null; }
    log("Pętla obrony zatrzymana.", "info");
  }

  function stopScheduler() {
    if (schedulerTimer) {
      clearTimeout(schedulerTimer);
      schedulerTimer = null;
    }
    log("Scheduler stopped", "info");
  }

  // ═══════════════════════════════════════════════════════════════
  //  UI PANEL
  // ═══════════════════════════════════════════════════════════════

  function createUI() {
    const panel = document.createElement("div");
    panel.id = "ogx-bot-panel";
    panel.innerHTML = `
      <style>
        #ogx-bot-panel {
          position: fixed;
          top: 10px;
          left: 10px;
          width: 260px;
          background: rgba(0, 10, 30, 0.92);
          border: 1px solid #1a5276;
          border-radius: 8px;
          color: #e0e0e0;
          font-family: 'Segoe UI', Arial, sans-serif;
          font-size: 12px;
          z-index: 99999;
          box-shadow: 0 4px 20px rgba(0,0,0,0.6);
          user-select: none;
        }
        #ogx-bot-panel .header {
          background: linear-gradient(135deg, #1a5276, #0d2f4f);
          padding: 8px 12px;
          border-radius: 8px 8px 0 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: move;
          font-weight: bold;
          font-size: 13px;
          color: #5dade2;
        }
        #ogx-bot-panel .body { padding: 10px 12px; }
        #ogx-bot-panel .section {
          margin-bottom: 8px;
          padding: 8px;
          background: rgba(255,255,255,0.03);
          border-radius: 4px;
          border-left: 3px solid #1a5276;
        }
        #ogx-bot-panel .section.active { border-left-color: #27ae60; }
        #ogx-bot-panel .section.inactive { border-left-color: #7f8c8d; }
        #ogx-bot-panel .section-title {
          font-weight: bold;
          margin-bottom: 4px;
          display: flex;
          justify-content: space-between;
        }
        #ogx-bot-panel .status { font-size: 11px; color: #999; }
        #ogx-bot-panel .status.on { color: #27ae60; }
        #ogx-bot-panel .status.off { color: #e74c3c; }
        #ogx-bot-panel .log-area {
          max-height: 200px;
          overflow-y: auto;
          font-size: 10px;
          font-family: monospace;
          background: rgba(0,0,0,0.3);
          padding: 6px;
          border-radius: 4px;
          margin-top: 4px;
        }
        #ogx-bot-panel .log-pinned {
          max-height: 60px;
          overflow-y: auto;
          font-size: 10px;
          font-family: monospace;
          background: rgba(80,0,0,0.3);
          border: 1px solid #e74c3c44;
          padding: 4px 6px;
          border-radius: 4px;
          margin-bottom: 4px;
        }
        #ogx-bot-panel .log-entry { margin: 1px 0; line-height: 1.4; }
        #ogx-bot-panel .log-entry.error { color: #e74c3c; }
        #ogx-bot-panel .log-entry.success { color: #27ae60; }
        #ogx-bot-panel .log-entry.delay { color: #7f8c8d; }
        #ogx-bot-panel .log-entry.asteroid { color: #f39c12; }
        #ogx-bot-panel .log-entry.expedition { color: #3498db; }
        #ogx-bot-panel .log-entry.fleet { color: #9b59b6; }
        #ogx-bot-panel .toggle-btn {
          padding: 4px 12px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-weight: bold;
          font-size: 12px;
        }
        #ogx-bot-panel .toggle-btn.on {
          background: #27ae60;
          color: white;
        }
        #ogx-bot-panel .toggle-btn.off {
          background: #e74c3c;
          color: white;
        }
        #ogx-bot-panel .mini-btn {
          padding: 2px 8px;
          border: 1px solid #555;
          background: rgba(255,255,255,0.1);
          color: #ccc;
          border-radius: 3px;
          cursor: pointer;
          font-size: 11px;
        }
        #ogx-bot-panel .mini-btn:hover { background: rgba(255,255,255,0.2); }
        #ogx-bot-panel .minimize { cursor: pointer; font-size: 16px; color: #999; }
        #ogx-bot-panel .minimize:hover { color: #fff; }
      </style>

      <div class="header">
        <span>OGameX Assistant</span>
        <div>
          <button id="ogx-toggle" class="toggle-btn ${CONFIG.enabled ? "on" : "off"}">${CONFIG.enabled ? "ON" : "OFF"}</button>
          <span class="minimize" id="ogx-minimize">_</span>
        </div>
      </div>
      <div class="body" id="ogx-body">
        <div class="section ${CONFIG.asteroidMining.enabled ? "active" : "inactive"}" id="ogx-asteroid-section">
          <div class="section-title">
            <span>Asteroid Mining</span>
            <button class="mini-btn" id="ogx-asteroid-toggle">${CONFIG.asteroidMining.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-asteroid-status">Idle</div>
          <div class="status" id="ogx-asteroid-sizing" style="font-size:10px;color:#f39c12;margin-top:3px;">Mode: — | miners/mission: — | cargo/miner: — | est. asteroid: —</div>
          <div class="status" id="ogx-asteroid-locks" style="font-size:10px;color:#7f8c8d;margin-top:3px;" title="Which tab runs the bot + coords currently locked against re-dispatch (frees at fleet arrival, or after 1h if arrival unknown).">Tab: —</div>
          <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="How many miners to send on ONE flight. 0 = send all available in a single wave. This overrides the auto cargo/est formula.">Miners per flight (0=all)</span>
              <input id="ogx-cfg-miners" type="number" min="0" step="1" value="${CONFIG.asteroidMining.minersPerMission}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Budget of miners to commit across simultaneous flights. The bot launches floor(total / per-flight) flights, then waits for returns. e.g. 100000 total / 50000 per = 2 flights. 0 = no limit (only fleet slots).">Total miners to use (0=∞)</span>
              <input id="ogx-cfg-total" type="number" min="0" step="1" value="${CONFIG.asteroidMining.totalMinersToUse}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Cargo capacity of ONE asteroid miner. 0 = auto-learn from the fleet page. Set it to enable smart sizing now.">Cargo / miner (0=auto)</span>
              <input id="ogx-cfg-cargo" type="number" min="0" step="1" value="${CONFIG.asteroidMining.cargoPerMiner}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Typical resources on one asteroid (sum metal+crystal+deut, from your past mission reports). 0 = auto-learn. With this + cargo set, the bot sends only ceil(res/cargo×buffer) miners.">Est. asteroid res. (0=auto)</span>
              <input id="ogx-cfg-est" type="number" min="0" step="1000" value="${CONFIG.asteroidMining.expectedResourcesPerAsteroid}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <div style="font-size:9px;color:#7f8c8d;margin-top:2px;">Set cargo + est → sends only what's needed. Or just set a miners cap.</div>
          </div>
        </div>

        <div class="section ${CONFIG.inactiveFarming.enabled ? "active" : "inactive"}" id="ogx-farm-section">
          <div class="section-title">
            <span>Inactive Farming</span>
            <button class="mini-btn" id="ogx-farm-toggle">${CONFIG.inactiveFarming.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-farm-status">Idle</div>
          <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Heavy Cargo sent per attack on one inactive planet.">Heavy Cargo / attack</span>
              <input id="ogx-farm-hc" type="number" min="1" step="1" value="${CONFIG.inactiveFarming.hcPerFlight}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="System ranges to sweep, comma-separated. Example: 3:100-200, 3:250-300. Every (i)/(I) inactive planet found is attacked; (v)/(p)/(b) skipped.">Ranges</span>
              <input id="ogx-farm-ranges" type="text" placeholder="3:100-200" value="${escapeHTML(CONFIG.inactiveFarming.ranges || "")}" style="width:120px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Don't re-attack the same planet within this many minutes.">Target cooldown (min)</span>
              <input id="ogx-farm-cooldown" type="number" min="1" step="10" value="${CONFIG.inactiveFarming.targetCooldownMin}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Keep this many fleet slots unused (for mining / manual play). Limit shown on the Fleet page as 'Fleets: X/37'.">Slot reserve</span>
              <input id="ogx-farm-reserve" type="number" min="0" step="1" value="${CONFIG.inactiveFarming.slotReserve}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <div style="font-size:9px;color:#7f8c8d;margin-top:2px;">Attacks every (i)/(I) player in the ranges with Heavy Cargo (event farming). Either/or with Asteroid Mining.</div>
          </div>
        </div>

        <div id="ogx-threat-banner" style="display:none;margin-bottom:8px;padding:8px;border-radius:4px;background:rgba(192,57,43,0.25);border:1px solid #e74c3c;color:#ff8a80;font-weight:bold;font-size:11px;line-height:1.4;"></div>

        <div class="section" id="ogx-threat-section">
          <div class="section-title">
            <span>Alarm: obca flota</span>
            <button class="mini-btn" id="ogx-threat-toggle">${CONFIG.threatAlarm.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-threat-status">—</div>
          <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
            <button class="mini-btn" id="ogx-moonsave-now" style="width:100%;background:#7b241c;border-color:#e74c3c;color:#fff;font-weight:bold;" title="Przenosi CAŁĄ flotę i WSZYSTKIE surowce na DRUGIE ciało na tych samych koordach: z planety na księżyc albo z księżyca na planetę, zależnie od tego, gdzie flota stoi. Atakujący wybiera cel przy starcie i nie może go zmienić w locie, więc flota na drugim ciele jest poza tym uderzeniem.">RATUJ FLOTĘ → drugie ciało</button>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:4px 0 2px;font-size:10px;color:#bbb;">
              <span title="Gdy w pasku misji pojawi się obca flota, bot sam wysyła CAŁĄ flotę i WSZYSTKIE surowce na księżyc. Reaguje też na sondy szpiegowskie — dlatego działa razem z automatycznym powrotem.">Auto-ratunek przy ataku</span>
              <button class="mini-btn" id="ogx-auto-save">${CONFIG.threatAlarm.autoSave ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Gdy alarm wygaśnie (10 min bez obcych flot), bot ściąga flotę i surowce z powrotem na planetę, żeby mining i ekspedycje ruszyły. Bez tego fałszywy alarm parkowałby gospodarkę na księżycu na stałe.">Auto-powrót po alarmie</span>
              <button class="mini-btn" id="ogx-auto-return">${CONFIG.threatAlarm.autoReturn ? "ON" : "OFF"}</button>
            </label>
            <button class="mini-btn" id="ogx-moonback-now" style="width:100%;margin-top:4px;background:#1a5276;border-color:#2e86c1;color:#fff;" title="Ściąga flotę i surowce z ciała, na które uciekły, z powrotem na to, z którego wystartowały. Potrzebne po ręcznym ratunku — takich bot sam nie cofa.">WRÓĆ NA BAZĘ</button>
            <div class="status" id="ogx-moonsave-status" style="font-size:10px;margin-top:3px;">—</div>
            <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
              <div class="status" id="ogx-threatlog-status" style="font-size:10px;color:#e67e22;">Dziennik obrony: —</div>
              <div style="display:flex;gap:4px;margin-top:3px;">
                <button class="mini-btn" id="ogx-threatlog-copy" style="flex:1;font-size:10px;" title="Kopiuje CAŁY dziennik obrony do schowka: każdy odczyt paska misji, każdy alarm, każdy ratunek i każdy błąd, ze znacznikiem daty. To jest zapis, który pokazuje, dlaczego flota przetrwała albo nie.">Kopiuj dziennik ataków</button>
                <button class="mini-btn" id="ogx-threatlog-clear" style="font-size:10px;" title="Czyści dziennik obrony (zwykły log zostaje nietknięty).">Wyczyść</button>
              </div>
            </div>
          </div>
          <div style="font-size:9px;color:#7f8c8d;margin-top:2px;">Czyta pasek misji: gdy „N Missions" &gt; „M Own", ktoś leci na Ciebie. Wstrzymuje farmienie i fale ekspedycji, NIE rusza flotą. Mining zostaje — wysyła minerów z planety.</div>
        </div>

        <div class="section ${CONFIG.expeditions.enabled ? "active" : "inactive"}" id="ogx-expo-section">
          <div class="section-title">
            <span>Expeditions</span>
            <button class="mini-btn" id="ogx-expo-toggle">${CONFIG.expeditions.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-expo-status">Idle</div>
          <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Na tyle fal dzielona jest flota bojowa. Masz po 8 sztuk każdego typu → 8 fal po 1 sztuce. Nigdy więcej niż slotów ekspedycyjnych.">Fale (podział floty)</span>
              <input id="ogx-expo-waves" type="number" min="1" step="1" value="${CONFIG.expeditions.waves}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Czas postoju w kosmosie („Expedition duration" na stronie wysyłki).">Długość ekspedycji (h)</span>
              <input id="ogx-expo-hours" type="number" min="1" max="24" step="1" value="${CONFIG.expeditions.holdingHours}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Minimalny odstęp między falami (sekundy). Odstęp = bezpieczeństwo: wracają pojedynczo, więc łowca złapie najwyżej jedną falę.">Odstęp fal min (s)</span>
              <input id="ogx-expo-gapmin" type="number" min="10" step="10" value="${CONFIG.expeditions.waveGapMinSec}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Maksymalny odstęp między falami (sekundy). Bot losuje z przedziału min-max, żeby nie wysyłać co równe 120 s.">Odstęp fal max (s)</span>
              <input id="ogx-expo-gapmax" type="number" min="10" step="10" value="${CONFIG.expeditions.waveGapMaxSec}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="0 = Heavy Cargo dzieli się na fale jak każdy inny statek (flota ÷ fale) — tak jest domyślnie. Wartość większa od zera wymusza STAŁĄ liczbę HC na falę, niezależną od tego, ile ich masz; sens ma tylko, gdy HC są Ci równolegle potrzebne do farmienia.">Heavy Cargo / falę (0=dziel)</span>
              <input id="ogx-expo-hc" type="number" min="0" step="1" value="${CONFIG.expeditions.heavyCargoPerWave}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Tyle slotów flot zostaje wolnych dla mininga i gry ręcznej.">Rezerwa slotów</span>
              <input id="ogx-expo-reserve" type="number" min="0" step="1" value="${CONFIG.expeditions.slotReserve}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <div style="font-size:9px;color:#7f8c8d;margin-top:2px;">Cel: pozycja 16 systemu bazy. Statki: wszystko poza ${CONFIG.expeditions.excludeTypes.join(", ")}. Działa razem z miningiem.</div>
          </div>
        </div>

        <div class="section ${CONFIG.onlineBonus.enabled ? "active" : "inactive"}" id="ogx-bonus-section">
          <div class="section-title">
            <span>Online Bonus</span>
            <button class="mini-btn" id="ogx-bonus-toggle">${CONFIG.onlineBonus.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-bonus-status">—</div>
          <div style="font-size:9px;color:#7f8c8d;margin-top:2px;">Klika zielony „Online bonus" w menu, gdy się pojawi → antymateria + punkty Academy. Działa razem z mining/farming.</div>
        </div>

        <div class="section">
          <div class="section-title">
            <span>Anti-Detection</span>
            <span class="status ${AntiDetection.isSleepTime() ? "off" : "on"}">${AntiDetection.isSleepTime() ? "SLEEP" : "ACTIVE"}</span>
          </div>
          <div class="status">Delay: ${CONFIG.antiDetection.minDelaySeconds}-${CONFIG.antiDetection.maxDelaySeconds}s | Sleep: ${CONFIG.antiDetection.sleepStartHour}:00-${CONFIG.antiDetection.sleepEndHour}:00 (czas lokalny, ±20min/dzień)</div>
          <div class="status" id="ogx-humanizer-status" style="font-size:10px;color:#7f8c8d;margin-top:3px;">—</div>
          <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Random full-bot pauses: after 35-65min of activity, everything stops for 5-15min — mimics a human stepping away.">Coffee breaks</span>
              <button class="mini-btn" id="ogx-hum-breaks">${CONFIG.humanizer.breaks ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Hard cap of farm attacks per UTC day. 0 = unlimited. Volume is what admins see first.">Max attacks / day (0=∞)</span>
              <input id="ogx-hum-maxatk" type="number" min="0" step="10" value="${CONFIG.humanizer.maxAttacksPerDay}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Godzina rozpoczęcia nocnej przerwy, czas LOKALNY (ten sam, co zegar w grze). Równy start i koniec = brak przerwy. Granice dryfują ±20 min dziennie, żeby bot nie zasypiał co do sekundy.">Sen od (godz. lokalna)</span>
              <input id="ogx-hum-sleepstart" type="number" min="0" max="23" step="1" value="${CONFIG.antiDetection.sleepStartHour}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Godzina zakończenia nocnej przerwy, czas LOKALNY.">Sen do (godz. lokalna)</span>
              <input id="ogx-hum-sleepend" type="number" min="0" max="23" step="1" value="${CONFIG.antiDetection.sleepEndHour}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
          </div>
        </div>

        <div class="section">
          <div class="section-title">
            <span>Quick Actions</span>
          </div>
          <button class="mini-btn" id="ogx-scan-now">Scan Asteroids</button>
          <button class="mini-btn" id="ogx-bonus-now" title="Sprawdź TERAZ, czy na stronie jest przycisk Online bonus, i kliknij go (ignoruje cooldown).">Claim Bonus</button>
          <button class="mini-btn" id="ogx-api-test" title="Odpytuje po kolei endpointy gry (eventbox, eventlist, galaxy, check-target, messages) i wypisuje do logu status HTTP oraz początek odpowiedzi. Od tego zależy, czy szybki skan i wysyłka przez API mogą działać.">Test API</button>
          <button class="mini-btn" id="ogx-fleet-recon" title="Wypisz do logu, co bot widzi na stronie floty: typy statków (data-ship-type), zapisane grupy flot, sloty flot i ekspedycji. Na stronie /fleet skanuje na świeżo, gdzie indziej pokazuje ostatni zapis.">Fleet Recon</button>
        </div>

        <div id="ogx-log-pinned" class="log-pinned" style="display:none;"></div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
          <span style="font-size:11px; color:#999;">Log (persisted)</span>
          <div style="display:flex;gap:4px;">
            <button class="mini-btn" id="ogx-copy-logs" style="font-size:10px;">Copy</button>
            <button class="mini-btn" id="ogx-clear-logs" style="font-size:10px;">Clear</button>
          </div>
        </div>
        <div class="log-area" id="ogx-log"></div>
        <textarea id="ogx-log-textarea" style="width:100%;height:120px;font-size:9px;font-family:monospace;background:rgba(0,0,0,0.5);color:#aaa;border:1px solid #333;border-radius:4px;padding:4px;margin-top:4px;resize:vertical;display:none;box-sizing:border-box;" readonly placeholder="Kliknij Copy żeby załadować logi..."></textarea>
      </div>
    `;

    document.body.appendChild(panel);

    // Make draggable
    makeDraggable(panel, panel.querySelector(".header"));

    // Event handlers
    document.getElementById("ogx-toggle").addEventListener("click", () => {
      CONFIG.enabled = !CONFIG.enabled;
      saveConfig(CONFIG);
      const btn = document.getElementById("ogx-toggle");
      btn.textContent = CONFIG.enabled ? "ON" : "OFF";
      btn.className = `toggle-btn ${CONFIG.enabled ? "on" : "off"}`;
      if (CONFIG.enabled) {
        startScheduler();
        startDefenceLoop();
        log("Bot ENABLED", "success");
      } else {
        stopScheduler();
        stopDefenceLoop();
        log("Bot DISABLED", "info");
      }
    });

    // v2.11.0: mining and farming are either/or — turning one ON turns the
    // other OFF (both button + section repainted).
    const paintModuleToggles = () => {
      const aBtn = document.getElementById("ogx-asteroid-toggle");
      const aSec = document.getElementById("ogx-asteroid-section");
      if (aBtn) aBtn.textContent = CONFIG.asteroidMining.enabled ? "ON" : "OFF";
      if (aSec) aSec.className = `section ${CONFIG.asteroidMining.enabled ? "active" : "inactive"}`;
      const fBtn = document.getElementById("ogx-farm-toggle");
      const fSec = document.getElementById("ogx-farm-section");
      if (fBtn) fBtn.textContent = CONFIG.inactiveFarming.enabled ? "ON" : "OFF";
      if (fSec) fSec.className = `section ${CONFIG.inactiveFarming.enabled ? "active" : "inactive"}`;
    };

    document.getElementById("ogx-asteroid-toggle").addEventListener("click", () => {
      CONFIG.asteroidMining.enabled = !CONFIG.asteroidMining.enabled;
      if (CONFIG.asteroidMining.enabled && CONFIG.inactiveFarming.enabled) {
        CONFIG.inactiveFarming.enabled = false;
        log("Inactive farming disabled (mining turned on — modules are either/or)", "info");
      }
      saveConfig(CONFIG);
      paintModuleToggles();
      log(`Asteroid mining ${CONFIG.asteroidMining.enabled ? "enabled" : "disabled"}`, "info");
    });

    document.getElementById("ogx-farm-toggle").addEventListener("click", () => {
      CONFIG.inactiveFarming.enabled = !CONFIG.inactiveFarming.enabled;
      if (CONFIG.inactiveFarming.enabled && CONFIG.asteroidMining.enabled) {
        CONFIG.asteroidMining.enabled = false;
        log("Asteroid mining disabled (farming turned on — modules are either/or)", "info");
      }
      saveConfig(CONFIG);
      paintModuleToggles();
      log(`Inactive farming ${CONFIG.inactiveFarming.enabled ? "enabled" : "disabled"}`, "info");
      updateStatusUI();
    });

    // v2.15.0: incoming-fleet alarm
    {
      const tBtn = document.getElementById("ogx-threat-toggle");
      if (tBtn) tBtn.addEventListener("click", () => {
        CONFIG.threatAlarm.enabled = !CONFIG.threatAlarm.enabled;
        saveConfig(CONFIG);
        tBtn.textContent = CONFIG.threatAlarm.enabled ? "ON" : "OFF";
        if (!CONFIG.threatAlarm.enabled) {
          ThreatMonitor.clear();
          // v2.35.0: wyłączenie alarmu to jednoznaczne „przestań" — kasuje też
          // straż ratunku. Bez tego operator nie miał ŻADNEGO sposobu, żeby
          // ręcznie zdjąć zator stanu, i musiał czekać na bezpiecznik.
          MoonSave.disarm("alarm wyłączony przez operatora");
        }
        // Ask for desktop notifications only here — never unprompted mid-scan.
        if (CONFIG.threatAlarm.enabled && typeof Notification !== "undefined" && Notification.permission === "default") {
          Notification.requestPermission().catch(() => {});
        }
        log(`Alarm obcej floty ${CONFIG.threatAlarm.enabled ? "włączony" : "wyłączony"}`, "info");
        updateStatusUI();
      });
    }

    // v2.17.0: manual fleet save
    {
      const bindThreatToggle = (id, key, label) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener("click", () => {
          CONFIG.threatAlarm[key] = !CONFIG.threatAlarm[key];
          saveConfig(CONFIG);
          btn.textContent = CONFIG.threatAlarm[key] ? "ON" : "OFF";
          log(`${label} ${CONFIG.threatAlarm[key] ? "włączony" : "WYŁĄCZONY"}`, CONFIG.threatAlarm[key] ? "info" : "warn");
          updateStatusUI();
        });
      };
      bindThreatToggle("ogx-auto-save", "autoSave", "Auto-ratunek przy ataku");
      bindThreatToggle("ogx-auto-return", "autoReturn", "Auto-powrót po alarmie");

      const msBtn = document.getElementById("ogx-moonsave-now");
      if (msBtn) msBtn.addEventListener("click", () => {
        const needsLearn = !MoonSave.armed();
        if (!window.confirm(
          "Przenieść CAŁĄ flotę i WSZYSTKIE surowce na drugie ciało (planeta ↔ księżyc, te same koordy)?\n\n" +
          "Minerzy przestaną kopać do czasu powrotu." +
          (needsLearn ? "\n\nCel księżyca nie jest jeszcze znany — bot wejdzie najpierw na galaktykę bazy, odczyta go i dokończy sam." : ""))) return;
        MoonSave.run({ manual: true, reason: "ręcznie" }).catch(err => log(`[MOON SAVE] ${err.message}`, "error"));
      });

      const tlCopy = document.getElementById("ogx-threatlog-copy");
      if (tlCopy) tlCopy.addEventListener("click", () => {
        const text = ThreatLog.asText();
        const n = ThreatLog.all().length;
        // GM_setClipboard nie jest w @grant tego skryptu, więc idziemy tą samą
        // drogą co istniejący przycisk Copy: navigator.clipboard, a gdy
        // przeglądarka odmówi — textarea + execCommand. Dowody z ataku nie mogą
        // zależeć od jednego API.
        const done = () => { tlCopy.textContent = "Skopiowane!"; setTimeout(() => { tlCopy.textContent = "Kopiuj dziennik ataków"; }, 1500); log(`Dziennik obrony skopiowany (${n} wpisów).`, "success"); };
        const fallback = () => {
          try {
            const ta = document.createElement("textarea");
            ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
            document.body.appendChild(ta); ta.select();
            const ok = document.execCommand("copy");
            document.body.removeChild(ta);
            if (ok) return done();
          } catch {}
          log(`Schowek niedostępny — wypisuję dziennik obrony (${n} wpisów):`, "warn");
          text.split("\n").slice(0, 150).forEach(l => log(l, "info"));
        };
        try {
          if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(fallback);
          else fallback();
        } catch { fallback(); }
      });
      const tlClear = document.getElementById("ogx-threatlog-clear");
      if (tlClear) tlClear.addEventListener("click", () => {
        if (!window.confirm("Wyczyścić dziennik obrony? Stracisz zapis tego, co bot widział przy dotychczasowych alarmach.")) return;
        ThreatLog.clear();
        log("Dziennik obrony wyczyszczony.", "info");
        updateStatusUI();
      });

      const mbBtn = document.getElementById("ogx-moonback-now");
      if (mbBtn) mbBtn.addEventListener("click", () => {
        const noGuard = !MoonSave.watch().armed;
        if (!window.confirm("Ściągnąć CAŁĄ flotę i WSZYSTKIE surowce z powrotem na ciało bazowe?" +
          (noGuard ? "\n\n(Straż nie jest aktywna — jeśli na księżycu nic nie ma, formularz po prostu nic nie wyśle.)" : ""))) return;
        MoonSave.returnHome({ byOperator: true }).catch(err => log(`[MOON SAVE] ${err.message}`, "error"));
      });
    }

    // v2.14.0: expedition controls
    {
      const eBtn = document.getElementById("ogx-expo-toggle");
      if (eBtn) eBtn.addEventListener("click", () => {
        CONFIG.expeditions.enabled = !CONFIG.expeditions.enabled;
        saveConfig(CONFIG);
        eBtn.textContent = CONFIG.expeditions.enabled ? "ON" : "OFF";
        const sec = document.getElementById("ogx-expo-section");
        if (sec) sec.className = `section ${CONFIG.expeditions.enabled ? "active" : "inactive"}`;
        if (CONFIG.expeditions.enabled && !FleetRecon.expeditionLink()) {
          log("Expeditions enabled — open any Galaxy page once so the bot can read the Expedition link (row 16).", "warn");
        }
        log(`Expeditions ${CONFIG.expeditions.enabled ? "enabled" : "disabled"}`, "info");
        updateStatusUI();
      });
      const bindExpo = (id, key, label, { min = 0 } = {}) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("change", () => {
          const v = Math.max(min, parseInt(el.value) || 0);
          el.value = v;
          CONFIG.expeditions[key] = v;
          // Keep the gap range coherent — a max below min would make the
          // randomised spacing collapse to a constant.
          if (key === "waveGapMinSec" && CONFIG.expeditions.waveGapMaxSec < v) {
            CONFIG.expeditions.waveGapMaxSec = v;
            const mx = document.getElementById("ogx-expo-gapmax");
            if (mx) mx.value = v;
          }
          if (key === "waveGapMaxSec" && v < CONFIG.expeditions.waveGapMinSec) {
            CONFIG.expeditions.waveGapMinSec = v;
            const mn = document.getElementById("ogx-expo-gapmin");
            if (mn) mn.value = v;
          }
          saveConfig(CONFIG);
          log(`${label} set to ${v}`, "info");
          updateStatusUI();
        });
      };
      bindExpo("ogx-expo-waves", "waves", "Expedition waves", { min: 1 });
      bindExpo("ogx-expo-hours", "holdingHours", "Expedition duration (h)", { min: 1 });
      bindExpo("ogx-expo-gapmin", "waveGapMinSec", "Wave gap min (s)", { min: 10 });
      bindExpo("ogx-expo-gapmax", "waveGapMaxSec", "Wave gap max (s)", { min: 10 });
      bindExpo("ogx-expo-hc", "heavyCargoPerWave", "Heavy Cargo per wave", { min: 0 });
      bindExpo("ogx-expo-reserve", "slotReserve", "Expedition slot reserve", { min: 0 });
    }

    // v2.13.0: online-bonus toggle (independent of mining/farming)
    {
      const bnBtn = document.getElementById("ogx-bonus-toggle");
      if (bnBtn) bnBtn.addEventListener("click", () => {
        CONFIG.onlineBonus.enabled = !CONFIG.onlineBonus.enabled;
        saveConfig(CONFIG);
        bnBtn.textContent = CONFIG.onlineBonus.enabled ? "ON" : "OFF";
        const sec = document.getElementById("ogx-bonus-section");
        if (sec) sec.className = `section ${CONFIG.onlineBonus.enabled ? "active" : "inactive"}`;
        log(`Online bonus auto-claim ${CONFIG.onlineBonus.enabled ? "enabled" : "disabled"}`, "info");
        updateStatusUI();
      });
      const apiTestBtn = document.getElementById("ogx-api-test");
      if (apiTestBtn) apiTestBtn.addEventListener("click", async () => {
        apiTestBtn.disabled = true;
        log("[API TEST] sprawdzam endpointy gry…", "info");
        ApiSniffer.dump();
        Ajax.resetDead(); // ręczny test zawsze otwiera bramki
        GM_setValue("ogamex_yield_fetch_at", "0"); // i zdejmuje 30-minutowy dławik raportów
        try { await Ajax.diagnose(); } catch (e) { log(`[API TEST] błąd: ${e.message}`, "error"); }
        finally { apiTestBtn.disabled = false; }
      });
      const recon = document.getElementById("ogx-fleet-recon");
      if (recon) recon.addEventListener("click", () => {
        // On the fleet page take a fresh reading; elsewhere show what the last
        // visit stored (the data only exists on step 1 of /fleet).
        const snap = GameState.getCurrentPage() === "fleet" ? FleetRecon.scan() : FleetRecon.snapshot();
        FleetRecon.logSummary(snap, GameState.getCurrentPage() === "fleet" ? "live" : "cached");
        // v2.16.2: same button also captures what Stage 2 (fleet-save to the
        // moon) needs: the events table shape and the base row's moon link.
        ThreatMonitor.dumpMarkupOnce(true).catch(() => {});
        ThreatMonitor.fetchBaseRowOnce().catch(() => {});
        const exp = FleetRecon.learnExpeditionLink() || FleetRecon.expeditionLink();
        log(exp ? `[EXPO] link: ${exp.href} (mission=${exp.mission ?? "?"})`
                : "[EXPO] link unknown — open any Galaxy page once so row 16 can be read.", exp ? "info" : "warn");
      });
      const bnNow = document.getElementById("ogx-bonus-now");
      if (bnNow) bnNow.addEventListener("click", () => {
        log("Manual online-bonus check...", "info");
        GM_setValue(OnlineBonus.KEY_MARKUP, ""); // re-dump the markup on a manual probe
        OnlineBonus.run({ manual: true }).catch(err => log(`Online bonus error: ${err.message}`, "error"));
      });
    }

    // Farming config inputs (numeric + the free-text ranges field)
    const bindFarmNum = (id, key, label) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("change", () => {
        const v = Math.max(0, parseInt(el.value) || 0);
        el.value = v;
        CONFIG.inactiveFarming[key] = v;
        saveConfig(CONFIG);
        log(`${label} set to ${v.toLocaleString()}`, "info");
        updateStatusUI();
      });
    };
    bindFarmNum("ogx-farm-hc", "hcPerFlight", "Heavy Cargo / attack");
    bindFarmNum("ogx-farm-cooldown", "targetCooldownMin", "Target cooldown");
    bindFarmNum("ogx-farm-reserve", "slotReserve", "Slot reserve");
    // v2.12.0: humanizer controls
    {
      const bBtn = document.getElementById("ogx-hum-breaks");
      if (bBtn) bBtn.addEventListener("click", () => {
        CONFIG.humanizer.breaks = !CONFIG.humanizer.breaks;
        saveConfig(CONFIG);
        bBtn.textContent = CONFIG.humanizer.breaks ? "ON" : "OFF";
        if (!CONFIG.humanizer.breaks) GM_setValue("ogamex_break_until", "0"); // end an active break
        log(`Coffee breaks ${CONFIG.humanizer.breaks ? "enabled" : "disabled"}`, "info");
        updateStatusUI();
      });
      const mAtk = document.getElementById("ogx-hum-maxatk");
      if (mAtk) mAtk.addEventListener("change", () => {
        const v = Math.max(0, parseInt(mAtk.value) || 0);
        mAtk.value = v;
        CONFIG.humanizer.maxAttacksPerDay = v;
        saveConfig(CONFIG);
        log(`Max attacks/day set to ${v === 0 ? "unlimited" : v}`, "info");
        updateStatusUI();
      });
      const bindSleep = (id, key) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("change", () => {
          const v = Math.min(23, Math.max(0, parseInt(el.value) || 0));
          el.value = v;
          CONFIG.antiDetection[key] = v;
          saveConfig(CONFIG);
          log(`Okno snu: ${CONFIG.antiDetection.sleepStartHour}:00-${CONFIG.antiDetection.sleepEndHour}:00 czasu lokalnego${CONFIG.antiDetection.sleepStartHour === CONFIG.antiDetection.sleepEndHour ? " (wyłączone)" : ""}`, "info");
        });
      };
      bindSleep("ogx-hum-sleepstart", "sleepStartHour");
      bindSleep("ogx-hum-sleepend", "sleepEndHour");
    }

    {
      const el = document.getElementById("ogx-farm-ranges");
      if (el) el.addEventListener("change", () => {
        CONFIG.inactiveFarming.ranges = el.value.trim();
        saveConfig(CONFIG);
        const parsed = InactiveFarmer.parseRanges(CONFIG.inactiveFarming.ranges);
        log(`Farm ranges set: "${CONFIG.inactiveFarming.ranges}" → ${parsed.length} valid range(s), ${parsed.reduce((a, r) => a + r.end - r.start + 1, 0)} systems`, parsed.length ? "info" : "warn");
        FarmState.clear(); // ranges changed → restart sweep from scratch
        GM_setValue("ogamex_farm_cooldown_until", "0");
        updateStatusUI();
      });
    }

    // ── v2.10.2: live right-sizing config inputs ──
    const bindCfgInput = (id, key, label) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("change", () => {
        const v = Math.max(0, parseInt(el.value) || 0);
        el.value = v;
        CONFIG.asteroidMining[key] = v;
        saveConfig(CONFIG);
        log(`${label} set to ${v === 0 ? "auto/all" : v.toLocaleString()}`, "info");
        updateStatusUI();
      });
    };
    bindCfgInput("ogx-cfg-miners", "minersPerMission", "Miners per flight");
    bindCfgInput("ogx-cfg-total", "totalMinersToUse", "Total miners to use");
    bindCfgInput("ogx-cfg-cargo", "cargoPerMiner", "Cargo/miner");
    bindCfgInput("ogx-cfg-est", "expectedResourcesPerAsteroid", "Est. asteroid resources");

    document.getElementById("ogx-scan-now").addEventListener("click", async () => {
      log("Manual scan triggered...", "asteroid");
      // v2.27.0: the operator asking for a scan outranks any cooldown. Without
      // this the button could find ranges and the very next scheduler tick
      // would still refuse to sweep them, because the cooldown from the last
      // empty fetch was never cleared — exactly what happened at 22:53.
      GM_setValue("ogamex_scan_cooldown_until", "0");
      GM_setValue("ogamex_hint_probe_at", "0");
      // If already on galaxy page, check current position 17 first
      if (GameState.getCurrentPage() === "galaxy") {
        const result = AsteroidScanner.checkCurrentPageForAsteroid();
        if (result.found) {
          log(`Asteroid detected! ${result.fleetUrl ? "Fleet URL: " + result.fleetUrl : ""}`, "success");
          updateStatusUI();
          // Dispatch fleet to the found asteroid
          if (result.fleetUrl) {
            const url = window.location.href;
            const gMatch = url.match(/[?&]x=(\d+)/);
            const sMatch = url.match(/[?&]y=(\d+)/);
            const galaxy = gMatch ? parseInt(gMatch[1]) : 0;
            const system = sMatch ? parseInt(sMatch[1]) : 0;

            // v2.9.3: TTL vs flight check (same guard as auto-dispatch).
            const baseForCheck = CONFIG.asteroidMining.minerBase;
            if (result.ttlSeconds != null && baseForCheck) {
              const sameGal = baseForCheck.galaxy === galaxy;
              const dist = sameGal ? Math.abs(baseForCheck.system - system) : Infinity;
              const estMin = sameGal ? AsteroidScanner.estimateFlightMinutes(dist) : Infinity;
              const estSec = estMin * 60;
              if (!Number.isFinite(estSec) || estSec + 300 > result.ttlSeconds) {
                log(`SKIP manual dispatch — flight ~${estMin}min (${estSec}s) + 300s buffer > TTL ${result.ttlSeconds}s`, "warn");
                // v2.9.6: skip-via-TTL does NOT add to DispatchedAsteroids.
                return;
              }
            }
            // v2.10.24: manual path never checked the dedup store — a manual
            // "Scan Asteroids" click while a fleet was already flying to these
            // coords sent a duplicate.
            if (DispatchedAsteroids.has(galaxy, system)) {
              log(`Asteroid [${galaxy}:${system}:17] already dispatched — not sending again (manual)`, "warn");
              return;
            }
            log(`Dispatching fleet via: ${result.fleetUrl}`, "asteroid");
            DispatchedAsteroids.add(galaxy, system);
            GM_setValue("pending_mission", JSON.stringify({
              type: "asteroid_mining_direct",
              fleetUrl: result.fleetUrl,
              shipType: "ASTEROID_MINER",
              quantity: AsteroidYieldTracker.minersNeeded(), // right-sized (0 = all, until learned)
              step: "select_ships_direct",
              resumeScan: false,
              timestamp: Date.now(),
            }));
            RateLimiter.record();
            await AntiDetection.shortDelay();
            window.location.href = result.fleetUrl;
          }
          return;
        }
      }
      // Start full range scan → navigate through systems
      await AsteroidMiner.startNewScan();
    });

    document.getElementById("ogx-minimize").addEventListener("click", () => {
      const body = document.getElementById("ogx-body");
      body.style.display = body.style.display === "none" ? "block" : "none";
    });

    document.getElementById("ogx-clear-logs").addEventListener("click", () => {
      logEntries = [];
      GM_setValue(LOG_STORAGE_KEY, "[]");
      const ta = document.getElementById("ogx-log-textarea");
      if (ta) { ta.value = ""; ta.style.display = "none"; }
      updateLogUI();
    });

    document.getElementById("ogx-copy-logs").addEventListener("click", () => {
      const text = logEntries
        .map(e => `[${e.time}] [${e.type.toUpperCase()}] ${e.msg}`)
        .join("\n");
      const ta = document.getElementById("ogx-log-textarea");
      if (ta) {
        ta.value = text;
        ta.style.display = ta.style.display === "none" ? "block" : "none";
        if (ta.style.display === "block") {
          ta.select();
          try {
            navigator.clipboard.writeText(text).then(() => {
              const btn = document.getElementById("ogx-copy-logs");
              if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "Copy"; }, 1500); }
            }).catch(() => {});
          } catch(e) {}
        }
      }
    });

    // Display persisted logs from previous page navigations
    updateLogUI();

    // ── v2.11.0 accordion: section titles collapse their body ──
    // With two modules + anti-detection + quick actions + log the panel got
    // crowded; click a title to fold a section (ON/OFF buttons still work —
    // clicks on buttons don't toggle). Collapsed set persists across pages.
    try {
      const collapsed = new Set(JSON.parse(GM_getValue("ogx_ui_collapsed", "[]")));
      panel.querySelectorAll(".section").forEach(sec => {
        const title = sec.querySelector(".section-title");
        if (!title) return;
        const name = (title.querySelector("span")?.textContent || "").trim();
        if (!name) return;
        title.style.cursor = "pointer";
        const chev = document.createElement("span");
        chev.textContent = collapsed.has(name) ? "▸" : "▾";
        chev.style.cssText = "margin-right:6px;font-size:10px;color:#7f8c8d;";
        title.insertBefore(chev, title.firstChild);
        const apply = () => {
          const fold = collapsed.has(name);
          chev.textContent = fold ? "▸" : "▾";
          Array.from(sec.children).forEach(ch => {
            if (ch !== title) ch.style.display = fold ? "none" : "";
          });
        };
        apply();
        title.addEventListener("click", (e) => {
          if (e.target.closest("button, input")) return; // toggles/inputs keep working
          if (collapsed.has(name)) collapsed.delete(name); else collapsed.add(name);
          GM_setValue("ogx_ui_collapsed", JSON.stringify([...collapsed]));
          apply();
        });
      });
    } catch {}

    // v2.10.27: keep the status lines fresh (lock countdowns, tab role) —
    // runs in passive tabs too; peek() is read-only so this never steals
    // leadership.
    setInterval(updateStatusUI, 5000);
  }

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function updateLogUI() {
    const logArea = document.getElementById("ogx-log");
    if (!logArea) return;

    // All logs in main area (increased limit)
    logArea.innerHTML = logEntries
      .slice(0, 50)
      .map((e) => `<div class="log-entry ${e.type}">${escapeHTML(e.time)} ${escapeHTML(e.msg)}</div>`)
      .join("");

    // Pinned area: last 5 important logs (error/success/fleet) — never buried by scan spam
    const pinned = document.getElementById("ogx-log-pinned");
    if (!pinned) return;
    const important = logEntries.filter(e => e.type === "error" || e.type === "success" || e.type === "fleet").slice(0, 5);
    if (important.length > 0) {
      pinned.style.display = "block";
      pinned.innerHTML = important
        .map((e) => `<div class="log-entry ${e.type}">${escapeHTML(e.time)} ${escapeHTML(e.msg)}</div>`)
        .join("");
    } else {
      pinned.style.display = "none";
    }
  }

  function updateStatusUI() {
    const astStatus = document.getElementById("ogx-asteroid-status");
    if (!astStatus) return;

    const scanState = ScanState.load();
    let text = "Idle";

    if (scanState?.active) {
      const { scannedCount, totalCount, queue } = scanState;
      const next = queue?.[0];
      text = `Scanning: ${scannedCount}/${totalCount} systems`;
      if (next) text += ` | Next: [${next.galaxy}:${next.system}]`;
    } else if (scanState?.foundAsteroid) {
      text = `FOUND: ${scanState.foundAsteroid.label} — dispatching...`;
    }

    astStatus.textContent = text;

    // v2.10.0: right-sizing / parallel status line
    const sizing = document.getElementById("ogx-asteroid-sizing");
    if (sizing) {
      const am = CONFIG.asteroidMining;
      const cargo = AsteroidYieldTracker.cargoPerMiner();
      const est = AsteroidYieldTracker.expectedResources();
      const need = AsteroidYieldTracker.minersNeeded();
      const inflight = miningInflightCount();
      const maxFleets = maxMiningFleets();
      const mode = am.parallelDispatch ? "parallel" : "serial";
      const needStr = need > 0 ? need.toLocaleString() : "all";
      const cargoStr = cargo > 0 ? cargo.toLocaleString() : "?";
      const estStr = est > 0 ? est.toLocaleString() : "?";
      const flightsStr = maxFleets > 0 ? `${inflight}/${maxFleets}` : `${inflight}/∞`;
      sizing.textContent = `Mode: ${mode} | per flight: ${needStr} | flights: ${flightsStr} | cargo/miner: ${cargoStr} | est: ${estStr}`;
    }

    // v2.10.27: transparency line — which tab runs the bot + which coords are
    // currently locked (and when each frees up). This is the view that would
    // have shown today's duplicate incidents at a glance.
    const locks = document.getElementById("ogx-asteroid-locks");
    if (locks) {
      const role = TabLock.peek(); // read-only — must NOT claim from a passive tab
      const roleStr = role === "leader" ? "ACTIVE (this tab)" : role === "passive" ? "PASSIVE (other tab runs)" : "unclaimed";
      const blocked = DispatchedAsteroids.entries()
        .map(e => `[${e.coord}] ${Math.max(0, Math.ceil((e.freeAt - Date.now()) / 60000))}m`)
        .join(", ");
      locks.textContent = `Tab: ${roleStr}${blocked ? ` | locked: ${blocked}` : " | locked: none"}`;
      locks.style.color = role === "passive" ? "#e67e22" : "#7f8c8d";
    }

    // v2.11.0: inactive-farming status line
    const farmStatus = document.getElementById("ogx-farm-status");
    if (farmStatus) {
      const cfg = CONFIG.inactiveFarming;
      let ftext = "Idle";
      if (!cfg.enabled) {
        ftext = "Off";
      } else if (CONFIG.asteroidMining.enabled) {
        ftext = "PAUSED — Asteroid Mining is ON (either/or)";
      } else if (!InactiveFarmer.parseRanges(cfg.ranges).length) {
        ftext = "No valid ranges — set e.g. 3:100-200";
      } else {
        const st = FarmState.load();
        const free = InactiveFarmer.slotsFree();
        const totalSlots = InactiveFarmer.cachedFleetTotal() || "?";
        if (st?.active) {
          ftext = `Sweep ${st.scannedCount}/${st.totalCount} | targets queued: ${st.targets?.length ?? 0} | slots free: ${free}/${totalSlots} | attacked (cooldown): ${FarmedTargets.count()}`;
        } else {
          const cool = parseInt(GM_getValue("ogamex_farm_cooldown_until", "0")) || 0;
          const coolMin = cool > Date.now() ? Math.ceil((cool - Date.now()) / 60000) : 0;
          ftext = coolMin > 0
            ? `Sweep done — next in ~${coolMin}min | attacked (cooldown): ${FarmedTargets.count()}`
            : `Ready — sweep starts on next tick | slots free: ${free}/${totalSlots}`;
        }
      }
      farmStatus.textContent = ftext;
    }

    // v2.15.0: threat banner + status line
    {
      const banner = document.getElementById("ogx-threat-banner");
      const tStatus = document.getElementById("ogx-threat-status");
      const st = ThreatMonitor.state();
      const active = ThreatMonitor.active();
      if (banner) {
        if (active) {
          const mins = Math.floor((Date.now() - (st.firstAt || st.seenAt)) / 60000);
          banner.style.display = "block";
          banner.textContent = `⚠ OBCA FLOTA W DRODZE — ${st.count} (pasek misji: ${st.own}/${st.total} nasze). Wykryta ${mins}min temu. Farmienie i fale ekspedycji wstrzymane. SPRAWDŹ GRĘ.`;
        } else {
          banner.style.display = "none";
        }
      }
      if (tStatus) {
        tStatus.textContent = !CONFIG.threatAlarm?.enabled
          ? "Off"
          : active
            ? `ALARM: ${st.count} obcych flot`
            : "Czysto — brak obcych flot w pasku misji";
        tStatus.style.color = active ? "#e74c3c" : "#999";
      }
      const tlStatus = document.getElementById("ogx-threatlog-status");
      if (tlStatus) {
        // v2.47.0: pierwsza linia ma odpowiadać na pytanie „co się działo, gdy
        // spałem", a nie podawać liczbę wpisów.
        const s12 = ThreatLog.summary(12);
        const all = ThreatLog.all();
        tlStatus.textContent = `Ostatnie ${s12.text}`
          + (s12.lastSave ? ` | ratunek: ${s12.lastSave}` : "")
          + (s12.lastReturn ? ` | powrót: ${s12.lastReturn}` : "")
          + ` | wpisów: ${all.length}`;
        tlStatus.style.color = (s12.alarms || s12.errors) ? "#e74c3c" : "#7f8c8d";
      }

      const msStatus = document.getElementById("ogx-moonsave-status");
      if (msStatus) {
        const ms = MoonSave.state();
        const mw = MoonSave.watch();
        msStatus.textContent = !MoonSave.armed()
          ? "Cel księżyca nieznany — po prostu kliknij RATUJ FLOTĘ, bot sam wejdzie na galaktykę bazy i go odczyta"
          : mw.armed
            ? `STRAŻ WIELOFALOWA (${mw.trigger === "threat" ? "alarm" : "ręcznie"}): flota na ${mw.refugeBody === "moon" ? "księżycu" : "planecie"}, baza ${mw.homeBody === "moon" ? "księżyc" : "planeta"} trzymana pusta, ${mw.saves || 0} zapis(ów) co ~${Math.round(MoonSave.MIN_RESAVE_MS / 1000)}s. ${mw.trigger === "threat" ? "Powrót sam, gdy obce floty znikną z paska." : "Ratunek ręczny — powrót TYLKO przyciskiem WRÓĆ NA BAZĘ."}`
            : ms.at
              ? `Gotowe. Ostatni ratunek: ${Math.round((Date.now() - ms.at) / 60000)}min temu (${ms.reason || "?"})`
              : "Gotowe — cel księżyca nauczony. Automat WYŁĄCZONY (czeka na rozpoznanie ataku vs sondy).";
        msStatus.style.color = mw.armed ? "#e74c3c" : MoonSave.armed() ? "#7f8c8d" : "#e67e22";
      }
    }

    // v2.14.0: expedition status line
    const expoStatus = document.getElementById("ogx-expo-status");
    if (expoStatus) {
      const cfg = CONFIG.expeditions;
      let etext;
      if (!cfg.enabled) {
        etext = "Off";
      } else if (!FleetRecon.expeditionLink()) {
        etext = "Czeka na link ekspedycji — wejdź raz na Galaxy";
      } else if (!ExpeditionRunner.base()) {
        etext = "Brak bazy — ustaw minerBase / expeditions.base";
      } else {
        const s = ExpeditionRunner.slots();
        const nextMs = ExpeditionRunner.msToNextWave();
        const parts = [`w powietrzu: ${s.used}/${s.total || "?"} (cap ${ExpeditionRunner.waveCap()})`];
        parts.push(nextMs > 0 ? `następna fala za ~${Math.ceil(nextMs / 1000)}s` : "fala gotowa");
        parts.push(`dziś: ${ExpeditionRunner.sentToday()}`);
        etext = parts.join(" | ");
      }
      expoStatus.textContent = etext;
    }

    // v2.13.0: online-bonus status line
    const bonusStatus = document.getElementById("ogx-bonus-status");
    if (bonusStatus) {
      if (!CONFIG.onlineBonus?.enabled) {
        bonusStatus.textContent = "Off";
        bonusStatus.style.color = "#7f8c8d";
      } else {
        const last = OnlineBonus.lastClaimAt();
        const parts = [`claimed today: ${OnlineBonus.claimsToday()}`];
        parts.push(last ? `last: ${Math.max(0, Math.round((Date.now() - last) / 60000))}min ago` : "last: never");
        const nextTry = parseInt(GM_getValue(OnlineBonus.KEY_NEXT_TRY, "0")) || 0;
        if (nextTry > Date.now()) parts.push(`next check in ${Math.ceil((nextTry - Date.now()) / 60000)}min`);
        else parts.push("watching");
        bonusStatus.textContent = parts.join(" | ");
        bonusStatus.style.color = "#999";
      }
    }

    // v2.12.0: humanizer status line
    const humStatus = document.getElementById("ogx-humanizer-status");
    if (humStatus) {
      const parts = [];
      if (Humanizer.isOnBreak()) {
        parts.push(`ON BREAK — ${Humanizer.breakLeftMin()}min left`);
      } else if (CONFIG.humanizer.breaks) {
        const next = parseInt(GM_getValue("ogamex_next_break_at", "0")) || 0;
        parts.push(next > Date.now() ? `next break in ~${Math.ceil((next - Date.now()) / 60000)}min` : "break due");
      } else {
        parts.push("breaks off");
      }
      const lim = CONFIG.humanizer.maxAttacksPerDay || 0;
      parts.push(`attacks today: ${Humanizer.attacksToday()}${lim > 0 ? `/${lim}` : ""}`);
      humStatus.textContent = parts.join(" | ");
      humStatus.style.color = Humanizer.isOnBreak() ? "#e67e22" : "#7f8c8d";
    }
  }

  function makeDraggable(element, handle) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    handle.addEventListener("mousedown", (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = element.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      element.style.left = startLeft + (e.clientX - startX) + "px";
      element.style.top = startTop + (e.clientY - startY) + "px";
      element.style.right = "auto";
    });

    document.addEventListener("mouseup", () => {
      isDragging = false;
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  INITIALIZATION
  // ═══════════════════════════════════════════════════════════════

  function init() {
    // Wait for page to be fully loaded
    if (document.readyState !== "complete") {
      window.addEventListener("load", init);
      return;
    }

    // v2.10.11: OGameX served its own "Error occurred / Page not found" page?
    // Recover (→ Back to game) BEFORE anything else and bail — leaving miners
    // grounded here risks them being scrapped. Also resets the streak when
    // we're on a normal game page.
    if (handleErrorPageIfPresent()) {
      return;
    }

    // Only run on game pages — NOT the landing/lobby page (/ or /home). v2.10.21:
    // the user is still LOGGED IN here (confirmed: no password, they just click a
    // "Play / Enter game" button to re-enter and land on Overview). So the right
    // recovery is to CLICK that button — NOT reload (the landing page just shows
    // itself again; observed reloading it 10× over ~1.5h with zero progress) and
    // NOT navigate to /overview cold (that returns OGameX's error page, feeding
    // the error→Back-to-game→landing loop). We don't yet know the exact button,
    // so dump all clickables to the (persisted) log AND try a text match.
    // v2.10.22: only the LOGGED-OUT landing/login page is skipped. When logged
    // in, "/" and "/home" are the game's Overview/home — fall through and run
    // (build the panel, start the scheduler → it navigates to galaxy to scan).
    // Without this the bot was invisible & idle on Overview, the very page the
    // error-recovery lands on, so it never resumed until the user opened
    // Fleet/Galaxy by hand.
    const onLandingPath = window.location.pathname.includes("/home") || window.location.pathname === "/";
    if (onLandingPath && !isLoggedInGamePage()) {
      if (CONFIG.enabled) {
        const now = Date.now();
        const lastAt = parseInt(GM_getValue("ogamex_login_retry_at", "0"));
        let streak = (lastAt && now - lastAt < 20 * 60 * 1000) ? parseInt(GM_getValue("ogamex_login_retry_streak", "0")) + 1 : 0;
        GM_setValue("ogamex_login_retry_at", String(now));
        GM_setValue("ogamex_login_retry_streak", String(streak));

        logClickables("landing-page"); // diagnostic — shows the exact buttons to target

        const entry = findGameEntryElement();
        if (entry) {
          const label = (entry.textContent || entry.value || "").replace(/\s+/g, " ").trim().slice(0, 40);
          const delaySec = Math.min(60, 3 * Math.pow(2, Math.min(streak, 4))); // 3,6,12,24,48,60s — throttle if it keeps bouncing
          log(`On login/landing page (no game UI) — clicking "${label}" to re-enter game in ~${Math.round(delaySec)}s (attempt ${streak + 1}).`, "warn");
          setTimeout(() => {
            const href = entry.getAttribute && entry.getAttribute("href");
            if (entry.tagName === "A" && href && href !== "#") window.location.href = entry.href;
            else entry.click();
          }, delaySec * 1000);
        } else {
          // No obvious entry button found — fall back to a reload (and the dump
          // above will tell us what to click next time). Backoff so we don't spin.
          const schedule = [2, 2, 4, 8, 15];
          const minutes = schedule[Math.min(streak, schedule.length - 1)];
          log(`On landing page — no Play/Enter button matched; reloading in ~${minutes}min (attempt ${streak + 1}). Clickables logged above — send them so I can target the button.`, "warn");
          setTimeout(() => { window.location.reload(); }, (minutes + Math.random() * 0.5) * 60 * 1000);
        }
      }
      return;
    }

    const SCRIPT_VERSION = (typeof GM_info !== "undefined" && GM_info?.script?.version) || "?";
    ApiSniffer.install(); // v2.45.0: notuj, czego gra używa naprawdę
    // v2.47.0: raz na godzinę wypisz do logu, co działo się przez ostatnie 12 h.
    // Po nocy pierwsza linia w logu ma mówić, czy ktoś leciał i czy flota
    // uciekała na księżyc — bez przeglądania dziennika.
    try {
      const last = parseInt(GM_getValue("ogamex_threat_digest_at", "0")) || 0;
      if (Date.now() - last > 60 * 60 * 1000) {
        GM_setValue("ogamex_threat_digest_at", String(Date.now()));
        const d = ThreatLog.summary(12);
        log(`[OBRONA] Ostatnie ${d.text}`, d.alarms || d.errors ? "warn" : "info");
      }
    } catch {}
    log(`OGameX Assistant v${SCRIPT_VERSION} loaded`, "info");

    // v2.10.10: timestamp of the last real page load — read by the scheduler
    // keepalive to detect long stretches with no navigation (session risk).
    GM_setValue("ogamex_last_pageload_at", String(Date.now()));

    // ── v2.10.25: non-leader tabs are passive viewers ──
    // Everything below mutates SHARED state (pending_mission, scan state,
    // fleet timers) — a second open game tab executing it was the root cause
    // of the 3-fleets-to-one-asteroid incident. A passive tab still builds the
    // panel and starts the (leader-gated) scheduler, so it takes over
    // automatically within ~3min if the active tab closes.
    if (!TabLock.isLeader()) {
      log("Another tab is running the bot — this tab stays PASSIVE (will take over if the active tab closes).", "warn");
      createUI();
      updateStatusUI();
      if (CONFIG.enabled) { startScheduler(); startDefenceLoop(); }
      return;
    }
    // Leader heartbeat, independent of the 50-90s scheduler cadence. When this
    // tab owns the lock isLeader() refreshes it; when another fresh tab owns
    // it, isLeader() is a read-only false — no write war.
    setInterval(() => TabLock.isLeader(), TabLock.HEARTBEAT_MS);

    // ── v2.25.3: learn the moon target ON PAGE LOAD ──
    // It used to depend on the scheduler tick reaching ThreatMonitor.check()
    // while we happened to be standing on the base system's galaxy page. The
    // asteroid scanner starts a sweep within seconds of that page loading and
    // navigates away, and a jitter pause can swallow the tick entirely (a 13min
    // one landed on the very click that triggered this). Doing it at load
    // removes the race: the page we arrived at is the page we read.
    if (GameState.getCurrentPage() === "galaxy") {
      ThreatMonitor.dumpBaseRowOnce();
      MoonSave.resumeAfterLearn();
    }
    // v2.38.3: blok zdarzeń jest na stronie floty — łap go przy wczytaniu,
    // nie czekając na tick, który podczas przerwy i tak nic nie robi.
    ThreatMonitor.dumpEventsFromDom();

    // v2.11.0: cache the fleet-slot TOTAL ("Fleets: X/37") — visible only on
    // the fleet page; the farmer's slot budget needs it on galaxy pages.
    // v2.13.1: superseded by FleetRecon.scan() on fleet pages (it caches the
    // same key plus ship types, fleet groups and expedition slots). The plain
    // regex stays for every OTHER page that happens to show the counter.
    if (GameState.getCurrentPage() === "fleet") {
      FleetRecon.scan();
    } else if (GameState.getCurrentPage() === "galaxy") {
      // One-shot: learn the Expedition link from row 16 (no-op once known).
      FleetRecon.learnExpeditionLink();
      const ftm = document.body.textContent.match(/Fleets:\s*\d+\s*\/\s*(\d+)/);
      if (ftm) GM_setValue("ogamex_fleet_total_slots", ftm[1]);
    } else {
      const ftm = document.body.textContent.match(/Fleets:\s*\d+\s*\/\s*(\d+)/);
      if (ftm) GM_setValue("ogamex_fleet_total_slots", ftm[1]);
    }

    // ── Handle fleetSendSuccessfully page (race condition fix) ──
    // When "Send fleet" is clicked, OGameX navigates the browser to this URL
    // BEFORE our JS finishDispatch() can run, so pending_mission is never cleared.
    // Fix it here — immediately clear pending_mission and foundAsteroid so that
    // the scheduled handlePendingMission below is a no-op (won't attempt re-dispatch).
    //
    // v2.10.0: this is ALSO the usual place the parallel-vs-wait decision is
    // made, because the browser navigates here before finishDispatch can run.
    // parallelKeepScanning is read by the fleet-timer block below to avoid
    // re-pausing the scan we just decided to continue.
    let parallelKeepScanning = false;
    let wasExpoSend = false; // v2.15.2: read by the fleet-timer block below
    if (window.location.href.includes("fleetSendSuccessfully")) {
      // v2.11.0: was this a FARM send? The browser navigated here before
      // finishDispatch could run, so pending_mission still carries the type.
      // Farm sends must NOT run the mining parallel-decision below.
      let wasFarmSend = false;
      let wasMoonSend = false;
      let wasMoonReturn = false;
      try {
        const pm = JSON.parse(GM_getValue("pending_mission", "null"));
        wasFarmSend = !!pm?.farm;
        wasExpoSend = !!pm?.expedition;
        wasMoonSend = !!pm?.moonSave;
        wasMoonReturn = !!pm?.moonReturn;
      } catch {}
      // v2.14.0: slow-navigation twin of the farm check below — if
      // finishDispatch already cleared pending_mission, the send stamp still
      // carries the kind, so an expedition never falls into the mining branch.
      if (!wasExpoSend) {
        const ls = readLastSent();
        wasExpoSend = !!(ls?.expedition && Date.now() - (ls.at || 0) < 60000);
      }
      if (wasMoonSend) {
        // v2.26.3: a fleet save / return is not a mining flight and must not be
        // booked as one. Owner's 18:51 log shows the return leg landing here and
        // printing "PARALLEL: sent 1000000000, ~4400000000 miners still home" —
        // numbers recycled from an old mining record, on a send that moved no
        // miners to any asteroid. Beyond the nonsense in the log it also bumped
        // the in-flight fleet counter and could set a mining return timer, i.e.
        // spend the mining budget on a trip to our own moon.
        GM_setValue("pending_mission", null);
        // ── v2.33.0: TU rozbraja się straż po powrocie ──
        // Rozbrojenie siedziało wyłącznie w finishDispatch, czyli na ścieżce,
        // która działa TYLKO gdy klik nie przeładuje strony. Normalnie gra
        // przerzuca przeglądarkę na fleetSendSuccessfully i ląduje tutaj —
        // a ta gałąź (dodana w v2.26.3 dla liczników mininga) czyściła
        // pending_mission i wychodziła, nie tykając straży. Straż zostawała
        // uzbrojona po UDANYM powrocie, więc returnHome() odpalał znowu przy
        // następnym ticku. Log właściciela z 2 sierpnia: powrót wysłany
        // o 09:26:19, a potem próby o 09:27:45, 09:29:11, 09:30:23, 09:30:36
        // i 09:32:26 — wszystkie w pustkę, bo flota była już w drodze.
        if (wasMoonReturn) MoonSave.disarm("flota wróciła na bazę (potwierdzone po wysyłce)");
        ThreatLog.add(wasMoonReturn ? "POWRÓT" : "RATUNEK", "WYSŁANE — gra przyjęła flotę (potwierdzone po przeładowaniu).");
        log("Ratunek/powrót floty wysłany — liczniki mininga nietknięte.", "fleet");
      } else if (wasExpoSend) {
        GM_setValue("pending_mission", null);
        const storedExp = parseInt(GM_getValue("ogamex_inflight_fleets", "0")) || 0;
        GM_setValue("ogamex_inflight_fleets", String(storedExp + 1));
        GM_setValue("ogamex_last_dispatch_at", String(Date.now()));
        ExpeditionRunner.afterSend();
      } else if (wasFarmSend) {
        GM_setValue("pending_mission", null);
        // v2.11.1: bump the in-flight floor + stamp, exactly like the mining
        // path (decideAfterMiningSend) does — the page may not list the fleet
        // we sent seconds ago, and slotsFree() must not under-count near the
        // cap (it would send one fleet more than the reserve allows).
        const storedNow = parseInt(GM_getValue("ogamex_inflight_fleets", "0")) || 0;
        GM_setValue("ogamex_inflight_fleets", String(storedNow + 1));
        GM_setValue("ogamex_last_dispatch_at", String(Date.now()));
        const atkToday = Humanizer.recordAttack(); // v2.12.0: daily cap counter
        log(`Farm fleet sent (attack #${atkToday} today) — continuing with next target / sweep.`, "success");
        setTimeout(() => { InactiveFarmer.afterSend().catch(() => {}); }, 1500 + Math.random() * 1500);
        // Skip the mining post-send logic entirely — but fall through to the
        // rest of init (UI, scheduler) via this flag staying false.
      } else {
      GM_setValue("pending_mission", null);
      const afterDispatchState = ScanState.load();
      if (afterDispatchState) {
        afterDispatchState.foundAsteroid = null;
        ScanState.save(afterDispatchState);
      }
      const am = CONFIG.asteroidMining;
      let lastDisp = null;
      try { lastDisp = JSON.parse(GM_getValue("ogamex_last_dispatch", "null")); } catch {}
      // v2.12.1: slow-navigation race — if finishDispatch of a FARM send
      // already ran (cleared pending_mission) and the click-navigation landed
      // here late, wasFarmSend is false but this was NOT a mining send.
      // Running the mining decision would use STALE mining numbers and
      // double-bump the in-flight counter. The send stamp carries the kind.
      const lastSentInfo = readLastSent();
      const recentFarmSend = !!(lastSentInfo?.farm && Date.now() - (lastSentInfo.at || 0) < 60000);
      if (am.parallelDispatch && lastDisp && !recentFarmSend) {
        parallelKeepScanning = decideAfterMiningSend({
          available: lastDisp.available,
          toSend: lastDisp.toSend,
          capturedFlightMs: 0,
        });
      }
      if (parallelKeepScanning) {
        log("Fleet sent — miners + slot remain → continuing scan for more asteroids (parallel).", "asteroid");
        // v2.10.6: actually RESUME the scan here. The browser lands on
        // fleetSendSuccessfully (NOT galaxy), so the on-load galaxy-resume below
        // (requires page==='galaxy') never fires. Previously the resume was left
        // entirely to the scheduler's stranded-recovery, which is gated by
        // timing/minersInFlight/dispatchInProgress and did NOT reliably catch
        // this — so after a parallel dispatch the scan stalled in a
        // "parallel keeps scanning" reload loop and the remaining (often
        // multiple) asteroid ranges never got scanned. Navigate to the next
        // queued system now, mirroring finishDispatch's "parallel resume".
        const resumeState = ScanState.load();
        const nextSys = resumeState?.active && resumeState.queue?.length ? resumeState.queue[0] : null;
        if (nextSys) {
          GM_setValue("ogamex_fleet_return_at", "0"); // parallel: keep scanning, don't wait
          const delayMs = 1500 + Math.random() * 2000; // human-like pause before resuming
          setTimeout(() => scanNavigate(`/galaxy?x=${nextSys.galaxy}&y=${nextSys.system}`, "parallel resume (post-send)"), delayMs);
        } else {
          // v2.12.4: the comment used to SAY "let scheduler cooldown" but no
          // cooldown was ever set — the next tick restarted a full sweep of
          // the same range right after the fleet send. Set it for real.
          endSweepWithCooldown("Queue exhausted after dispatch");
        }
      } else {
        log("Fleet sent — dispatch state cleaned up. Scan paused until a fleet returns.", "asteroid");
      }
      } // end !wasFarmSend (v2.11.0)
    }

    // ── Cleanup stale data on startup ──
    GM_setValue("ogamex_tried_planets", "[]");
    GM_setValue("ogamex_last_switched_planet", "");

    // ── Smart fleet return timer check on startup ──
    // ALWAYS scan page header for active asteroid fleet, regardless of stored timer.
    // This recovers from scenarios where the timer was never persisted (e.g. dispatch
    // failure path didn't save it) — preventing the bot from scanning while miners
    // are still in flight.
    // v2.15.2: SKIP the whole block after an expedition send. It is mining
    // bookkeeping end to end, and an expedition lands on the very same
    // fleetSendSuccessfully page, so it was being dragged through it with two
    // possible outcomes, both wrong:
    //   • `justSentFleet && storedReturnAt > now` → setFleetReturnTimerFromHeader
    //     re-derived the mining timer from the FIRST countdown on the page,
    //     which after a wave belongs to an expedition. Live log:
    //     "Asteroid fleet active! Timer set: ~2min (countdown 0h0m5s ×2)".
    //   • header shows "Type: Expedition" instead of Asteroid Mining → the
    //     last branch fires "Active fleets visible but not asteroid mining.
    //     Resetting timer." and CLEARS the wait while every miner is still
    //     away — the scanner then hunts asteroids it has no ships to reach.
    // An expedition changes nothing about where the miners are, so the honest
    // move is to leave mining's state exactly as it was.
    if (wasExpoSend) {
      log("Expedition send — mining fleet timers left untouched.", "fleet");
    } else {
      const storedReturnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
      const headerText = document.body.textContent;
      const noFleetMovement = /No fleet movement/i.test(headerText);
      const hasAsteroidFleet = /Type:\s*Asteroid\s*Mining/i.test(headerText);

      const justSentFleet = window.location.href.includes("fleetSendSuccessfully");
      if (noFleetMovement && !justSentFleet) {
        // No fleets in flight at all — clear any stale timer
        // (Skip this check on fleetSendSuccessfully: the page may not yet reflect
        // the fleet we just dispatched, causing a false "no movement" read.)
        if (storedReturnAt) {
          log("No fleet movement — fleet already returned. Resetting timer.", "asteroid");
          GM_setValue("ogamex_fleet_return_at", "0");
        }
        clearInflightFleets(); // everything home — reset parallel budget (v2.10.7)
        GM_setValue("ogamex_inflight_fleets", "0"); // legacy key — keep cleared for safety
      } else if (hasAsteroidFleet || (justSentFleet && storedReturnAt && storedReturnAt > Date.now())) {
        // ── Asteroid fleet IS in flight ──
        // In parallel mode an in-flight fleet is normal — keep scanning as long
        // as there's a free fleet slot AND we're not certain we're out of miners.
        // v2.10.3: treat an UNKNOWN home count (no/stale dispatch record) as
        // "probably have miners → scan and verify at dispatch", not as zero.
        // Ground truth is the live ship count read on the fleet page at send
        // time; if it really is 0 the dispatch fail-path sets the wait. Only a
        // FRESH record proving <min miners home (e.g. right after a 100% send)
        // pauses here. v2.10.1's "unknown == wait" wrongly blocked players who
        // had miners home but no recent record.
        if (CONFIG.asteroidMining.parallelDispatch && !parallelKeepScanning) {
          const minersHome = minersHomeAfterLastDispatch(); // -1 = unknown
          const known = minersHome >= 0;
          const slots = GameState.getFleetSlots();
          const slotsFree = slots.total > 0 ? slots.total - slots.used : 1;
          const minNeeded = CONFIG.asteroidMining.minMinersPerMission || 1;
          const haveMiners = !known || minersHome >= minNeeded; // unknown → assume some
          const maxFleets = maxMiningFleets();
          const inflight = miningInflightCount(); // v2.15.1: expeditions don't spend the mining budget
          const budgetOk = maxFleets <= 0 || inflight < 0 || inflight < maxFleets; // <0 = nieznane (v2.30.0)
          if (slotsFree > 0 && haveMiners && budgetOk) {
            GM_setValue("ogamex_fleet_return_at", "0"); // capacity + (likely) miners + budget → keep scanning
            const homeStr = known ? `~${minersHome}` : "unknown→verify at dispatch";
            const budgetStr = maxFleets > 0 ? `, ${inflight < 0 ? "?" : inflight}/${maxFleets} flights` : "";
            log(`Asteroid fleet in flight, ${homeStr} miners home + ${slotsFree} slot(s) free${budgetStr} — parallel keeps scanning.`, "asteroid");
          } else {
            const why = !budgetOk ? `flight budget reached (${inflight < 0 ? "?" : inflight}/${maxFleets})`
              : !haveMiners ? `no miners home (${minersHome})`
              : "fleet slots full";
            log(`Parallel: ${why} → wait for fleet return.`, "asteroid");
            setFleetReturnTimerFromHeader(headerText, storedReturnAt);
          }
        } else if (!parallelKeepScanning) {
          // Serial mode: always (re)compute the wait timer from the page header.
          setFleetReturnTimerFromHeader(headerText, storedReturnAt);
        }
        // parallelKeepScanning === true → decideAfterMiningSend already cleared the gate.
      } else if (storedReturnAt && storedReturnAt > Date.now()) {
        // Timer exists but no asteroid fleet visible — could be stale OR page just doesn't show it
        // Be conservative: only reset if there are NO fleets in flight at all
        // (we already checked noFleetMovement above; if we're here, something is in flight but not asteroid)
        log("Active fleets visible but not asteroid mining. Resetting timer.", "asteroid");
        GM_setValue("ogamex_fleet_return_at", "0");
      }
    }

    createUI();
    updateStatusUI();

    // v2.10.0: learn expected asteroid yield from mission reports (no-op unless
    // we're on a message-like page; fully guarded).
    AsteroidYieldTracker.scanReports();

    // v2.17.1: check the bonus BEFORE the galaxy-scan resume below. That resume
    // navigates 1.5s after load and the scheduler's first tick only arrives at
    // 3-8s — on a tab that is actively scanning, the claim never got a page
    // that lived long enough. Claiming is a single navigation, so going early
    // costs one scan step at most.
    if (CONFIG.enabled) {
      setTimeout(() => { OnlineBonus.run().catch(() => {}); }, 200 + Math.random() * 250);
    }

    // Handle pending missions from previous page (fleet dispatch flow)
    setTimeout(handlePendingMission, 2000);

    // ── Handle active galaxy scan on page load ──
    // If we're on galaxy page and there's an active scan, continue scanning
    // BUT only if miners are NOT in flight
    const scanState = ScanState.load();
    const fleetReturnCheck = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
    if (fleetReturnCheck && Date.now() < fleetReturnCheck) {
      const waitMin2 = Math.ceil((fleetReturnCheck - Date.now()) / 60000);
      log(`Miners in flight (~${waitMin2}min left). Scan paused — will resume on return.`, "delay");
      // DO NOT clear ScanState — preserve the queue so scan can resume after fleet returns.
      // The scheduler's stranded-scan logic will navigate to galaxy once the timer expires.
    } else if (scanState?.active && GameState.getCurrentPage() === "galaxy" && CONFIG.enabled && CONFIG.asteroidMining.enabled) {
      log("Resuming galaxy scan...", "asteroid");
      // Delay to let the page fully render galaxy items
      // v2.48.0: jeśli to galaktyka systemu bazy, najpierw sprawdź pole złomu.
      try { if (DebrisCollector.tryCollectHere()) return; } catch {}
      setTimeout(() => AsteroidMiner.run(), 1500 + Math.random() * 1000); // v2.10.18: trimmed (galaxy items are server-rendered, present on load)
    } else if (CONFIG.enabled && CONFIG.inactiveFarming?.enabled && !CONFIG.asteroidMining.enabled
               && FarmState.load()?.active && GameState.getCurrentPage() === "galaxy") {
      // v2.11.0: farm sweep continues on galaxy page load (mirror of the
      // asteroid resume above; farmer no-ops if a pending_mission exists).
      setTimeout(() => { InactiveFarmer.run().catch(() => {}); }, 1500 + Math.random() * 1000);
    }

    // Auto-start scheduler if enabled
    if (CONFIG.enabled) {
      startScheduler();
      startDefenceLoop();
    }

    // v2.10.10 watchdog: the scheduler is a chained setTimeout — if one tick
    // ever throws an uncaught error (or the chain dies any other way), the
    // bot goes permanently silent with NO log line, because during a cooldown
    // nothing else ever reloads the page. This interval is independent of the
    // chain and its callback is trivial, so it can't die the same way. Max
    // legit tick gap is ~17min (15min jitter pause + 90s interval), so 25min
    // of silence means the chain is dead → reload restarts everything.
    setInterval(() => {
      if (!CONFIG.enabled) return;
      const lastTick = parseInt(GM_getValue("ogamex_last_tick_at", "0"));
      if (lastTick && Date.now() - lastTick > 25 * 60 * 1000) {
        log("Watchdog: no scheduler tick for >25min — scheduler chain dead. Reloading.", "warn");
        window.location.reload();
      }
    }, 60 * 1000);
  }

  init();
})();
