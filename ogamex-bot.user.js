// ==UserScript==
// @name         OGameX Assistant
// @namespace    https://github.com/Mitjano/Bybit_bot/ogamex-bot
// @version      2.111.3
// @description  Asteroid Mining automation for OGameX (multi-universe, fresh-scan on every cycle, TTL-aware dispatch with 5min safety margin; v2.10.0 adds right-sized fleets + parallel dispatch: send only the miners needed to carry the asteroid's resources and keep the rest mining other asteroids in parallel, with auto-learned cargo/yield; v2.13.0 auto-claims the green "Online bonus" menu button for antimatter + Academy points)
// @author       MCH
// @match        https://*.ogamex.net/*
// @updateURL    https://raw.githubusercontent.com/Mitjano/ogamex-userscript/main/ogamex-bot.user.js
// @downloadURL  https://raw.githubusercontent.com/Mitjano/ogamex-userscript/main/ogamex-bot.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      generativelanguage.googleapis.com
// @connect      ntfy.sh
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

// ── v2.92.0: przechwycenie ORYGINALNYCH GM_* na poziomie sandboxa ──
// Musi stać PRZED IIFE: wewnątrz IIFE te nazwy cieniują consty z prefiksem,
// więc tam oryginałów już nie widać (TDZ nie pozwala złapać ich w środku).
const __gmGetRaw = GM_getValue;
const __gmSetRaw = GM_setValue;

(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════
  //  PER-UNIVERSE STORAGE ISOLATION  (v2.92.0 — naprawa martwej v2.9.0)
  // ═══════════════════════════════════════════════════════════════
  // v2.9.0 nadpisywało window.GM_setValue/getValue, ale w sandboxie
  // Tampermonkeya gołe identyfikatory GM_* rozwiązują się w scope
  // sandboxa, NIE przez window — nadpiska była martwa i WSZYSTKIE uni
  // dzieliły jeden nieprefiksowany magazyn. Odkryte 14.08.2026: bot na
  // świeżym koncie na Vedze czytał config, kolejkę farmy i liczniki
  // Atheny (i mógł je nadpisywać). Teraz cieniujemy GM_getValue /
  // GM_setValue constami WEWNĄTRZ IIFE — każde istniejące wywołanie
  // w bocie trafia w te wrappery leksykalnie, bez dotykania window.
  // ── UNI-ISO-START ──
  const HOST = location.host;
  const GM_setValue = (key, value) => __gmSetRaw(`${HOST}:${key}`, value);
  const GM_getValue = (key, defaultValue) => {
    const v = __gmGetRaw(`${HOST}:${key}`, undefined);
    if (v !== undefined) return v;
    // Migracja: dane Atheny żyją w starych, NIEprefiksowanych kluczach
    // (izolacja nigdy nie działała) — czytamy je TYLKO na Athenie, każdy
    // zapis ląduje już pod kluczem z prefiksem, więc prefiks z czasem
    // przejmuje wszystko. Inne uni startują z czystą kartą (bot OFF).
    if (HOST === "athena.ogamex.net") {
      return __gmGetRaw(key, defaultValue);
    }
    return defaultValue;
  };
  // ── UNI-ISO-END ──

  // ═══════════════════════════════════════════════════════════════
  //  CONFIGURATION (persistent via GM_setValue/GM_getValue, per-host)
  // ═══════════════════════════════════════════════════════════════

  const DEFAULT_CONFIG = {
    enabled: false,
    // ── v2.69.0: TRYB KSIĘŻYCOWY (decyzja właściciela 05.08 po ataku) ──
    // Falanga skanuje tylko PLANETY: loty z/na planetę widać co do sekundy
    // (napastnik ustawił atak "w jedną sekundę" na powrót ekspedycji), loty
    // z/na KSIĘŻYC są niewidoczne, a księżyca nie da się zeskanować.
    // "moon" = każda rutynowa wysyłka (mining, ekspedycje, złom) startuje
    // z księżyca bazy: przed formularzem bot przełącza aktywne ciało, a
    // rotacja minerów po koloniach jest wyłączona. Flota, minery, recyklery
    // i deuter mają MIESZKAĆ na księżycu (prom z planety ręcznie: RATUJ).
    baseBody: "moon",
    // ── v2.83.0: PROM na przełącznik, DOMYŚLNIE OFF ──
    // Decyzja właściciela 12.08: bot NIE przenosi floty sam z siebie —
    // 08:48 prom tuż po starcie wywiózł całą flotę + 11,8 bln deuteru
    // z planety na księżyc bez pytania. Automatyczna samonaprawa „flota
    // na złym ciele" działa odtąd tylko, gdy operator świadomie ją włączy
    // (przycisk PROM w sekcji Mining); przenosiny ręczne = RATUJ / Deploy.
    moonFerry: { enabled: false },
    // v2.105.0: automatyczna ODBUDOWA księżyca (fork ma /home/moonformation —
    // „Form a moon" za metal). Po zniszczeniu księżyca bazy bot sam go stawia.
    // maxMetalShare: koszt rośnie wykładniczo (na żywo 26.08: 6000 km = 1,8 bln,
    // 8944 km = 89 bln metalu) — jeden księżyc nie może zjeść więcej niż ten
    // ułamek posiadanego metalu; 1000 km stawiamy zawsze, gdy stać.
    moonRebuild: { enabled: true, diameterKm: 8944, allPlanets: true, maxMetalShare: 0.25 },
    // v2.106.0: RATUNEK BRAMĄ SKOKOWĄ — atak na księżyc z flotą → skok bramą na
    // inny księżyc (0 s, bez lotu, falanga nic nie widzi) zamiast Deployu 81 s na
    // planetę. targetMoon: {galaxy,system,position} preferowany cel (null =
    // pierwszy księżyc z listy bramy, który nie jest atakowany).
    // v2.107.0 (audyt 2, Z2): havens = księżyce-SCHRONY — gdy lista niepusta, brama
    // skacze WYŁĄCZNIE na nie (nigdy na hub); finta wypala bramę bazy + schronu,
    // huby zostają naładowane. Format: [{ galaxy, system, position }, ...].
    // v2.108.1 DECYZJA OPERATORA 27.08: brama WYŁĄCZONA — bot NIE teleportuje floty
    // (test 09:31: skok bez surowców, cooldown 30 min, napastnik znalazł flotę na
    // schronie po 40 min). Ratunek = Deploy w parze / ucieczka w powietrze.
    // v2.109.0 DECYZJA OPERATORA 27.08 (po skoku 10:37 z całą flotą i surowcami): brama ON.
    // havens = jedyne cele skoku: [7:209:7] (ma bramę; [7:499:6] NIE ma). Ustawienia bramy
    // są sterowane z repo (loadConfig nadpisuje zapis z przeglądarki).
    // v2.110.0 DECYZJA OSTATECZNA OPERATORA 27.08: „nie mieliśmy używać jumpgate" — brama OFF
    // dla ratunków (wymuszone w loadConfig). Powrót do domu z już zajętego schronu dozwolony.
    // Ratunek przy ataku na księżyc = Deploy na księżyc-sąsiada w układzie + zawrót (airOnMoonAttack).
    jumpGate: { enabled: false, targetMoon: null, takeResources: true, havens: [{ galaxy: 7, system: 209, position: 7 }] },
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
      // v2.73.0: 05.08 ~22:30 właściciel PRZENIÓSŁ bazę na [3:272:7]
      // (agresor przeskoczył do starego układu, 3 min lotu od bazy; nowy
      // układ jest pełny — nikt się już nie wciśnie).
      minerBase: { galaxy: 3, system: 272, position: 7 },
      // ── v2.84.0: sztywny punkt startu MINERÓW (null = aktywne ciało) ──
      // Decyzja właściciela 12.08: asteroidy spawnują się zawsze w g3 (tam
      // większość planet), a ekspedycje latają z g2 — minery mają mieszkać
      // na wpisanym księżycu w g3 i bot sam się na niego przełącza przed
      // wysyłką. Ciało (planeta/księżyc) wynika z trybu baseBody.
      launchFrom: null,   // { galaxy, system, position } | null
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
      from: { galaxy: 3, system: 272, position: 7 },  // v2.75.0: JUŻ NIE wymusza startu — FS leci z aktualnie aktywnego księżyca; to tylko fallback routeKey na stronach bez paska planet
      to: null,                // cel do PONOWNEGO wyboru po przenosinach (stary 3:269:5 nieaktualny)
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
      // v2.78.0: drugi atak na INNĄ kolonię podczas trwającego alarmu.
      // Wyłącznik istnieje, żeby dało się wrócić do zachowania z 2.77.2
      // bez podmiany wersji skryptu — pierwsza kolonia jest ratowana tak
      // samo w obu ustawieniach.
      rescueQueue: true,
      // ── v2.85.0: UCIECZKA W POWIETRZE ──
      // Atak na OBA ciała jednej pary naraz (planeta + księżyc, np. GS
      // „zniszcz księżyc" + atak na planetę): ewakuacja w obrębie pary
      // przenosi flotę pod drugie uderzenie. Zamiast tego WSZYSTKO leci
      // powolnym Deployem do innej kolonii i ZAWRACA po przejściu ataków
      // (flota w locie jest nietykalna). OFF = zachowanie 2.84.0.
      airSave: true,
      // v2.110.0: atak na SAM księżyc z flotą → Deploy na księżyc-sąsiada w układzie + zawrót
      // (zamiast planety pary). OFF = jak dotąd (planeta pary).
      airOnMoonAttack: true,
      // ── v2.100.0: STRAŻ ŚWIADOMA CIAŁA (audyt 25.08 — fale + atak kombinowany) ──
      // Do 2.99.6 uzbrojona straż nie porównywała atakowanego ciała z tym,
      // na którym STOI uratowana flota (refugium). Scenariusz: fale na
      // księżyc → flota skacze na planetę → fale przechodzą → napastnik
      // dosyła atak NA PLANETĘ przy wciąż uzbrojonej straży. Gałąź straży
      // kończyła się `return false`, a zamiatanie startowało z księżyca
      // (pusty hangar → „nothing to save"). Flota stała na planecie pod
      // atakiem. Teraz: atak w ciało z flotą → skok na drugie (jeśli
      // czyste) albo ucieczka w powietrze (jeśli oba); zamiatanie startuje
      // z ATAKOWANEGO ciała, nie z aktywnego. OFF = zachowanie 2.99.6.
      bodyAwareGuard: true,
      // v2.102.3: czy pasek misji liczy sondy jako „Hostile". Dowód z 25.08 16:22
      // (ACS + sonda w locie = „1 Hostile") mówi NIE. Gdyby po zmianie forka sondy
      // wywoływały fałszywe alarmy z paska — ustaw true.
      barCountsProbes: false,
      // v2.80.0: cichy dźwięk trzymający kartę przy życiu w tle.
      // Skutek uboczny: karta dostaje ikonkę głośnika i pojawia się
      // w sterowaniu multimediami. Dlatego jest wyłącznik.
      keepAwake: true,
      // v2.74.0: tyle deuteru ZOSTAJE na ciele przy ratunku i FS. Bez tego
      // ratunek/FS zabierał wszystko — a flota, która wróci później (np.
      // z ekspedycji), nie miałaby paliwa na własną ewakuację. Rezerwa to
      // grosze przy bilionach w skarbcu; napastnik zlootuje najwyżej ją.
      deutReserve: 100_000_000_000,
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
      // v2.103.0: klasa ODKRYWCA — 40-minutowe ekspedycje (1,5x więcej lotów
      // na slot, +30% łupu). ON = bot wybiera opcję „40 min" w formularzu;
      // gdy jej nie ma (inna klasa), ostrzega i wysyła na holdingHours.
      discoverer40: false,
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
      // v2.59.0: RECYCLER też zostaje w domu (decyzja właściciela 2026-08-03).
      // Na ekspedycji nic nie wnosi, a jest jedynym statkiem, którym
      // DebrisCollector może zebrać złom po ekspedycjach — wysyłanie go falami
      // zostawiało zbieranie bez narzędzia.
      // v2.69.2: AVATAR nie lata na ekspedycje (decyzja właściciela 05.08) —
      // jednostka unikatowa (1 szt.), nie ma czego szukać w kosmosie.
      excludeTypes: ["ASTEROID_MINER", "COLONY_SHIP", "DEATH_STAR", "RECYCLER", "AVATAR"],
      // v2.48.0: ekspedycja potrafi trafić na obcych i zostawić pole złomu na
      // pozycji 16 systemu bazy. To nasze własne surowce — zbieramy recyklerami.
      collectDebris: true,
      // Base = where the combat fleet sits; target is position 16 of ITS system.
      // null → falls back to the asteroid-mining base.
      base: null,
      // v2.84.0: sztywny punkt startu EKSPEDYCJI (null = aktywne ciało —
      // fale lecą stąd, gdzie stoisz). Wpisany = bot przełącza się na to
      // ciało przed każdą falą; cel to poz. 16 JEGO systemu, więc powroty
      // zawsze wracają tam, skąd wystartowały.
      launchFrom: null,   // { galaxy, system, position } | null
    },
    // ── v2.11.0: Inactive-player farming (event: reward per fleet sent) ──
    // Scans user-given system ranges, attacks (i)/(I) inactive planets
    // with Heavy Cargo (mission=8, direct fleet URL — same 3-step flow as
    // asteroids). v2.90.0: współistnieje z asteroidMining — mining ma
    // pierwszeństwo, farm działa w oknach, gdy minery są w locie.
    inactiveFarming: {
      enabled: false,
      hcPerFlight: 100,          // ships per attack (manual, like miners per flight)
      // v2.72.0: statek do wyboru (event „idle farming"). LIGHT_CARGO i
      // BATTLESHIP bywają szybsze od HEAVY_CARGO (krótszy lot = slot szybciej
      // wolny = więcej ataków), a BATTLESHIP przeżyje resztki obrony na
      // planecie nieaktywnego. Nazwy potwierdzone na żywo: to dokładnie
      // data-ship-type z formularza floty (ten sam słownik co roster ekspedycji).
      shipType: "HEAVY_CARGO",   // LIGHT_CARGO | HEAVY_CARGO | BATTLESHIP
      ranges: "",                // e.g. "3:100-200, 3:250-300" — scanned system by system
      targetCooldownMin: 180,    // don't re-attack the same planet within this window
      // v2.81.0: nowe okrazenie = czysta karta. Bez tego cooldown liczony
      // zegarem wycinal cele w drugim przebiegu: pelne przemiatanie 499
      // systemow trwa ~2 h, wiec planety zdobyte w pierwszej godzinie
      // wciaz siedzialy na 180-minutowej blokadzie i byly pomijane.
      // Przy ON tempo dyktuje dlugosc przemiatania (+15 min przerwy),
      // a nie arbitralny zegar. Przy OFF zachowanie sprzed 2.81.0.
      repeatEachSweep: true,
      slotReserve: 2,            // keep this many fleet slots free (manual play / mining)
      // ── v2.89.0: filtr rankingu + baza celów ──
      // Obserwacja ownera (14.08): bot atakował KAŻDEGO nieaktywnego, a łup
      // z graczy z końca rankingu (2000+) nie zwraca nawet czasu lotu — puste
      // kolonie zjadały sloty floty. Ranking gracza stoi w tooltipie wiersza
      // galaktyki („Ranking: 2.881"), więc pełne przemiatanie buduje BAZĘ
      // celów (koordy + gracz + ranking), a kolejne okrążenia odwiedzają już
      // tylko systemy z celami w limicie rankingu — zamiast ~2 h pełnego
      // skanu, okrążenie po bazie trwa minuty i uderza tylko w tłuste cele.
      maxTargetRank: 800,        // atakuj TYLKO nieaktywnych z rankingiem ≤ N; 0 = bez filtra.
                                 // Nieznany ranking (parser nie odczytał) = atakuj + głośny log.
      dbRefreshHours: 12,        // co tyle godzin pełny skan zakresów odświeża bazę celów
      // ── v2.91.0: sztywny punkt startu ataków (jak minery/ekspedycje) ──
      // Wpisane koordy = każdy atak wychodzi z tej pary (księżyc przy trybie
      // KSIĘŻYC), więc można farmić INNĄ galaktykę nie ruszając floty.
      // Puste = zachowanie v2.74.8: start z aktualnie aktywnego ciała.
      launchFrom: null,          // { galaxy, system, position } | null
      // ── v2.97.0: priorytet lupu ──
      // Bot uczy sie sredniego lupu kazdego celu z Dziennika Grabiezy
      // (Plunder Journal) i atakuje najtlustsze cele pierwsze. Prog odcina
      // znana drobnice: cel ze SREDNIM lupem < progu jest pomijany
      // (nieznany cel nigdy — eksploracja uczy bazy). 0 = bez progu.
      minTargetProfit: 0,
      // ── v2.98.0: tryb sekwencyjny (przełącznik ownera, 17.08) ──
      // Owner zobaczył priorytet łupu w akcji i chce mieć wybór: ON = stare
      // zachowanie sprzed v2.89 — KAŻDY przebieg przemiata cały zakres po
      // kolei (1→koniec) i atakuje cele w kolejności napotkania; wyłącza
      // okrążenia po bazie ORAZ sortowanie po łupie. OFF (domyślnie) =
      // priorytet łupu: laps po znanych systemach + najtłustsze cele pierwsze.
      // Filtr rankingu, czarna lista i próg łupu działają w OBU trybach.
      sequentialSweep: false,
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
      // v2.108.3 (27.08 10:37): zapisany config miał stare jumpGate.enabled:true i wygrał
      // z domyślnym false → bot skoczył bramą mimo decyzji operatora. Brama dla RATUNKÓW
      // jest wymuszona OFF z kodu; zapis w przeglądarce nie może tego włączyć.
      merged.jumpGate = { ...DEFAULT_CONFIG.jumpGate, ...(merged.jumpGate || {}), enabled: false, havens: DEFAULT_CONFIG.jumpGate.havens };   // v2.110.0: brama OFF z kodu, zapis nie włączy
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

      // v2.90.2: pula RateLimitera (20 wysyłek/h) jest zapchana 76 atakami
      // farmy sprzed poprawki — bez wyczyszczenia mining stałby zablokowany
      // do godziny PO wgraniu wersji, która błąd usuwa. Jednorazowo.
      {
        const RL_KEY = "ogamex_migration_rate_pool_v2902";
        if (GM_getValue(RL_KEY, "0") !== "1") {
          GM_setValue(RL_KEY, "1");
          GM_setValue("ogamex_rate_actions", "[]");
          setTimeout(() => log("Pula wysylek/h wyczyszczona z wpisow farmy (ataki farmy nie licza sie juz do puli minerow) — skaner asteroid odblokowany.", "info"), 1500);
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

      // v2.59.0: konfiguracja jest zapisana u gracza, więc sama zmiana wartości
      // domyślnej nic nie da (ten sam mechanizm co przy GS w 2.46.0) — trzeba
      // dopisać RECYCLER do jego listy wykluczeń ekspedycji.
      {
        const RC_KEY = "ogamex_migration_no_recycler_expo_v259";
        if (GM_getValue(RC_KEY, "0") !== "1") {
          GM_setValue(RC_KEY, "1");
          if (merged.expeditions) {
            const ex = (merged.expeditions.excludeTypes || []).map(t => String(t).toUpperCase());
            if (!ex.includes("RECYCLER")) {
              merged.expeditions.excludeTypes = [...ex, "RECYCLER"];
              saveConfig(merged);
              setTimeout(() => log("Recyklery nie lataja juz na ekspedycje — zostaja w domu do zbierania zlomu (DebrisCollector).", "info"), 1500);
            }
          }
        }
      }

      // v2.69.2: AVATAR do wykluczeń ekspedycji (decyzja właściciela 05.08) —
      // ten sam mechanizm migracji co GS/RECYCLER: zapisany config gracza
      // trzyma starą listę, sama zmiana domyślnej nic nie da.
      {
        const AV_KEY = "ogamex_migration_no_avatar_expo_v2692";
        if (GM_getValue(AV_KEY, "0") !== "1") {
          GM_setValue(AV_KEY, "1");
          if (merged.expeditions) {
            const ex = (merged.expeditions.excludeTypes || []).map(t => String(t).toUpperCase());
            if (!ex.includes("AVATAR")) {
              merged.expeditions.excludeTypes = [...ex, "AVATAR"];
              saveConfig(merged);
              setTimeout(() => log("AVATAR nie lata juz na ekspedycje — zostaje w domu.", "info"), 1500);
            }
          }
        }
      }

      // ── v2.73.0 migration: PRZENOSINY BAZY [3:269:8] → [3:272:7] (05.08 ~22:30) ──
      // Właściciel przeniósł planetę główną i księżyc (agresor wskoczył do
      // starego układu na 3 min lotu). Zapisany config trzymałby starą bazę —
      // a prom co 2 h wysłałby CAŁĄ flotę Deployem w nieistniejące [3:269:8].
      // Reset bazy + całej nauczonej wiedzy o starym księżycu i starych tras.
      {
        const MB_KEY = "ogamex_migration_base_3272_v273";
        if (GM_getValue(MB_KEY, "0") !== "1") {
          GM_setValue(MB_KEY, "1");
          merged.asteroidMining.minerBase = { galaxy: 3, system: 272, position: 7 };
          if (merged.fleetSave) {
            merged.fleetSave.from = { galaxy: 3, system: 272, position: 7 };
            merged.fleetSave.to = null; // stary cel 3:269:5 nieaktualny — wybrać nowy
          }
          saveConfig(merged);
          // Wiedza o STARYM księżycu: link celu ratunku, flagi nauki wiersza
          // galaktyki — wszystko uczy się od nowa z wiersza [3:272:7].
          GM_setValue("ogamex_moon_link", "null");
          GM_setValue("ogamex_moon_fetch_dead", "");
          GM_setValue("ogamex_moon_fetch_tries", "0");
          GM_setValue("ogamex_moon_visit_at", "0");
          GM_setValue("ogamex_moon_markup_dumped_v2253", "");
          // Kolejki zbudowane na starej bazie (odległości liczone od 3:269).
          GM_setValue("ogamex_scan_state", null);
          GM_setValue("ogamex_farm_scan", "null");
          GM_setValue("ogamex_fs_flight_ms", "{}");
          // Prom: pierwszy kurs z NOWEJ bazy od razu (konsolidacja na nowym księżycu).
          GM_setValue("ogamex_ferry_at", "0");
          console.log("[OGameX v2.73.0] migration: baza przeniesiona na [3:272:7], wiedza o starym księżycu wyczyszczona");
          setTimeout(() => log("PRZENOSINY: baza bota ustawiona na [3:272:7] (planeta+księżyc). Cel ratunku nauczy się z nowego wiersza galaktyki; cel Fleet Save do ponownego wyboru.", "success"), 1500);
        }

        // ── v2.74.6 migration: rezerwa deuteru 1 mld → 100 mld (decyzja ownera 06.08) ──
        // 1 mld to za mało paliwa dla flot lądujących na planecie; zapisany
        // config trzyma starą wartość, więc jednorazowo podbijamy ją do nowego
        // domyślnego 100 mld (chyba że owner ustawił już własną WYŻSZĄ).
        const DR_KEY = "ogamex_migration_deut_reserve_v2746";
        if (GM_getValue(DR_KEY, "0") !== "1") {
          GM_setValue(DR_KEY, "1");
          if (merged.threatAlarm && (parseInt(merged.threatAlarm.deutReserve) || 0) < 100_000_000_000) {
            merged.threatAlarm.deutReserve = 100_000_000_000;
            saveConfig(merged);
            setTimeout(() => log("Rezerwa deuteru na planecie podniesiona do 100 mld (ratunek/FS/prom zostawiają tyle w zbiorniku).", "info"), 1500);
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
    // v2.93.0: zrzuty debugowe DOM potrafia miec ~10 KB na linie, a dziennik
    // (300 wpisow) jest serializowany do magazynu przy KAZDYM wpisie -
    // megabajtowe JSON-y mielily CPU caly dzien. 600 znakow wystarczalo na
    // kazda diagnoze z ostatnich tygodni; pelny tekst i tak widac na zywo.
    const msgStr = String(msg);
    const entry = { time, msg: msgStr.length > 600 ? msgStr.slice(0, 600) + " [uciete]" : msgStr, type };
    logEntries.unshift(entry);
    if (logEntries.length > MAX_LOG_ENTRIES) logEntries.pop();
    // Persist logs across page navigations
    // v2.94.0: zapis z debouncem (1/s) zamiast serializacji 300 wpisow przy
    // KAZDEJ linii; flush na pagehide lapie wpisy sprzed samej nawigacji.
    schedulePersistLogs();
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
  // ═══════════════════════════════════════════════════════════════
  //  NOTIFIER (v2.67.0) — push na telefon przez ntfy.sh
  // ═══════════════════════════════════════════════════════════════
  // Druga linia obrony na wypadek, gdyby automatyczne podnoszenie floty
  // zawiodło (padnięta przeglądarka tego nie wyśle, ale wszystko, co bot
  // ZDĄŻY wykryć, trafia też na telefon). ntfy.sh: darmowe, bez konta —
  // temat o losowej nazwie działa jak sekret, a apka na telefonie
  // subskrybuje go po nazwie.
  //
  // Co idzie na telefon (przez hak w ThreatLog.add — dziennik już wie, co
  // jest ważne): ATAK (pilne), RATUNEK wysłany, BŁĄD obrony (wysokie),
  // porażka FS (wysokie), POWRÓT (cicho). Rutynowe odczyty — nigdy.
  const Notifier = {
    KEY_TOPIC: "ogamex_ntfy_topic",
    KEY_ON: "ogamex_ntfy_on",
    KEY_VOICE: "ogamex_voice_on",   // v2.72.1: alarm głosowy na laptopie
    KEY_LAST: "ogamex_ntfy_last",   // { "<kind>": ts } — dławik na rodzaj
    THROTTLE_MS: { "ATAK": 5 * 60 * 1000, "RATUNEK": 2 * 60 * 1000, "POWRÓT": 5 * 60 * 1000, "BŁĄD": 5 * 60 * 1000, "FS": 5 * 60 * 1000 },

    topic() {
      let t = GM_getValue(this.KEY_TOPIC, "");
      if (!t) {
        // 12 losowych znaków = temat-nieodgadnięty; prefiks mówi, co to jest.
        t = "ogamex-mch-" + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8);
        GM_setValue(this.KEY_TOPIC, t);
      }
      return t;
    },
    enabled() { return GM_getValue(this.KEY_ON, "1") === "1"; },

    _throttled(kind) {
      let last = {};
      try { last = JSON.parse(GM_getValue(this.KEY_LAST, "{}")); } catch {}
      const win = this.THROTTLE_MS[kind] || 5 * 60 * 1000;
      if (Date.now() - (last[kind] || 0) < win) return true;
      last[kind] = Date.now();
      GM_setValue(this.KEY_LAST, JSON.stringify(last));
      return false;
    },

    push(title, msg, priority = "default", tags = "") {
      // v2.106.4 — 27.08 08:17: alarm był, push na telefon nie dotarł, a log
      // milczał (nie wiadomo: OFF? inny temat? błąd sieci?). Każda próba i
      // każde pominięcie zostawia ślad z tematem.
      if (!this.enabled()) {
        if (priority === "urgent" || priority === "high") log(`[PUSH] POMINIĘTE — „Push na telefon (ntfy)" jest OFF na tym komputerze (${title}).`, "warn");
        return;
      }
      const topic = this.topic();
      try {
        GM_xmlhttpRequest({
          method: "POST",
          url: "https://ntfy.sh/" + topic,
          headers: { Title: title, Priority: priority, Tags: tags },
          data: String(msg).slice(0, 600),
          timeout: 15000,
          onload: (r) => log(`[PUSH] wysłano (${priority}) na temat ${topic}: ${title} — HTTP ${r && r.status}`, (r && r.status >= 200 && r.status < 300) ? "info" : "warn"),
          onerror: () => log("[PUSH] ntfy.sh nie odpowiedziało — powiadomienie nie wyszło.", "warn"),
          ontimeout: () => log("[PUSH] ntfy.sh timeout — powiadomienie nie wyszło.", "warn"),
        });
      } catch (e) { log(`[PUSH] błąd: ${e.message}`, "warn"); }
    },

    // ── v2.72.1: alarm GŁOSOWY na laptopie (Web Speech API) ──
    // Push na telefon bywa niesłyszalny (iOS: tryb cichy/Sen wygrywa nawet
    // z priority=urgent — lekcja 04.08). Laptop z otwartą kartą gry może
    // po prostu POWIEDZIEĆ, że jest atak — syntezator systemowy, zero
    // zależności. Głos polski, jeśli system go ma; inaczej domyślny z lang.
    voiceEnabled() { return GM_getValue(this.KEY_VOICE, "1") === "1"; },
    speak(text, times = 3) {
      if (!this.voiceEnabled()) return;
      try {
        if (!("speechSynthesis" in window)) { log("[GŁOS] przeglądarka nie ma speechSynthesis.", "warn"); return; }
        const voice = (speechSynthesis.getVoices() || []).find(v => /^pl/i.test(v.lang || "")) || null;
        for (let i = 0; i < Math.max(1, times); i++) {
          const u = new SpeechSynthesisUtterance(text);
          if (voice) u.voice = voice;
          u.lang = "pl-PL";
          u.rate = 1.0;
          u.volume = 1.0;
          speechSynthesis.speak(u); // kolejka syntezatora sama dawkuje powtórki
        }
      } catch (e) { log(`[GŁOS] błąd syntezy: ${e.message}`, "warn"); }
    },

    // ── v2.72.2: SYRENA — 10-sekundowa melodyjka alarmowa (Web Audio) ──
    // Gra POD głosem (cichsza), więc razem brzmi jak prawdziwy alarm.
    // Syntetyzowana na miejscu (trójkąt + obwiednia) — zero plików, zero
    // sieci. Uczciwość: nawigacja strony (a ratunek nawiguje od razu) utnie
    // dźwięk — to sygnał „obudź się", nie gwarantowany 10-sekundowy koncert.
    siren(seconds = 10) {
      if (!this.voiceEnabled()) return;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = this._audioCtx || (this._audioCtx = new Ctx());
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        const master = ctx.createGain();
        master.gain.value = 0.35;
        master.connect(ctx.destination);
        const notes = [660, 880, 1046, 880]; // wznoszący motyw alarmowy
        const step = 0.45;
        const t0 = ctx.currentTime;
        for (let t = 0; t < seconds; t += step) {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = "triangle";
          o.frequency.value = notes[Math.round(t / step) % notes.length];
          g.gain.setValueAtTime(0, t0 + t);
          g.gain.linearRampToValueAtTime(1, t0 + t + 0.02);
          g.gain.setValueAtTime(1, t0 + t + step - 0.06);
          g.gain.linearRampToValueAtTime(0, t0 + t + step - 0.01);
          o.connect(g); g.connect(master);
          o.start(t0 + t);
          o.stop(t0 + Math.min(t + step, seconds));
        }
      } catch (e) { log(`[SYRENA] błąd: ${e.message}`, "warn"); }
    },

    // Hak z dziennika obrony: rodzaj wpisu decyduje o tym, czy i jak głośno.
    fromJournal(kind, msg) {
      const m = String(msg || "");
      if (kind === "ATAK") {
        if (this._throttled("ATAK")) return;
        this.push("⚔️ ATAK na Twoje konto OGameX!", m, "urgent", "rotating_light");
        this.siren(10);
        this.speak("Uwaga! Atak na bazę! Uwaga! Atak na bazę!", 3);
      } else if (kind === "RATUNEK" && /WYS[ŁL]ANE/i.test(m)) {
        if (this._throttled("RATUNEK")) return;
        this.push("🛟 Flota ewakuowana", m, "default", "shield");
      } else if (kind === "BŁĄD") {
        if (this._throttled("BŁĄD")) return;
        this.push("⚠️ Obrona zgłasza BŁĄD — sprawdź grę!", m, "high", "warning");
        this.speak("Uwaga! Błąd obrony! Sprawdź grę!", 1);
      } else if (kind === "FS" && /NIEUDANE|zosta/i.test(m)) {
        if (this._throttled("FS")) return;
        this.push("🌙 Fleet Save: problem", m, "high", "warning");
      } else if (kind === "POWRÓT" && /WYS[ŁL]ANE/i.test(m)) {
        if (this._throttled("POWRÓT")) return;
        this.push("✅ Flota wróciła na bazę", m, "min", "white_check_mark");
      }
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  WAKE LOCK (v2.68.0) — bot ON = komputer nie zasypia
  // ═══════════════════════════════════════════════════════════════
  // Obrona działa tylko, póki karta żyje — a uśpiony laptop ją zabija.
  // Screen Wake Lock API trzyma ekran zapalony, więc system nie wchodzi
  // w sen z bezczynności; działa tak samo na macOS i Windows, bez
  // caffeinate i bez grzebania w ustawieniach zasilania (ważne w pracy,
  // gdzie nie ma praw admina). Uczciwe ograniczenia: karta z grą musi
  // być WIDOCZNA (schowana/zminimalizowana = system odbiera blokadę;
  // odzyskujemy ją, gdy karta wraca), a zamknięcie klapy i tak usypia.
  // ── v2.80.0: DRUGA POŁOWA „nie zasypiaj" ──
  // WakeLock trzyma ekran, ale WYŁĄCZNIE gdy karta jest widoczna — przeglądarka
  // odbiera blokadę przy każdym schowaniu (w logu: „The requesting document is
  // hidden"). Efekt zobaczyliśmy 07.08 o 12:11-12:23: dwanaście minut ciszy,
  // przepadł zaplanowany odczyt zagrożeń, a atak w tym oknie zostałby wykryty
  // dopiero po przeładowaniu sesji.
  //
  // Drugą połowę problemu — zamrażanie i dławienie liczników w karcie w tle —
  // da się załatwić inaczej: karta, która ODTWARZA DŹWIĘK, jest zwolniona
  // z intensive throttling i z zamrażania. Gramy więc ciszę w kółko. Sygnał
  // jest niezerowy (amplituda 1/32768 ≈ -90 dBFS), bo cisza idealna bywa
  // liczona jako brak dźwięku — i przy tym absolutnie niesłyszalny.
  //
  // Czego to NIE zrobi, i trzeba to wiedzieć: NIE powstrzyma uśpienia systemu
  // ani zamknięcia klapy. Strona WWW nie ma do tego żadnego uprawnienia —
  // to się ustawia w zasilaniu Windows. Ten moduł ratuje przypadek „karta
  // w tle / inne okno na wierzchu", nie przypadek „laptop poszedł spać".
  const AudioKeepalive = {
    _el: null,
    _playing: false,
    _wired: false,
    _starting: false,

    // v2.80.1: log co najwyzej raz na 30 min NA RODZAJ komunikatu.
    // Bot przeladowuje strone co kilkanascie sekund, a kazdy nowy dokument
    // zaczyna od zera — bez tego jedna informacja o dzwieku zjadala caly log
    // (dokladnie ta sama lekcja, co z autotestem w v2.77.2: powtarzany
    // komunikat przestaje byc informacja, a zaczyna byc szumem).
    _say(kind, msg, level) {
      try {
        const KEY = `ogamex_wake_said_${kind}`;
        const last = parseInt(GM_getValue(KEY, "0")) || 0;
        if (Date.now() - last < 30 * 60 * 1000) return;
        GM_setValue(KEY, String(Date.now()));
      } catch {}
      log(msg, level);
    },

    _url() {
      const rate = 8000, n = rate;            // 1 s mono 16-bit
      const buf = new ArrayBuffer(44 + n * 2);
      const dv = new DataView(buf);
      const wr = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
      wr(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); wr(8, "WAVE");
      wr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
      dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
      dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      wr(36, "data"); dv.setUint32(40, n * 2, true);
      // v2.102.0 (I-A3): ±1 LSB (−90 dBFS) nie liczy się jako „gra dźwięk" —
      // przeglądarka dalej dławiła timery. Ton 100 Hz o amplitudzie ~−44 dBFS:
      // ledwo słyszalny przy głośności systemowej, ale liczony jako audio.
      for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(200 * Math.sin(2 * Math.PI * 100 * i / 8000)), true);
      return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    },

    // Wołane przy starcie i z każdego ticku obrony — samo się naprawia, gdy
    // nawigacja zabije element albo właściciel przełączy wyłącznik.
    ensure() {
      if (!CONFIG.threatAlarm?.keepAwake) { this.stop(); return; }
      // v2.80.1: play() jest asynchroniczne. ensure() wola i start skryptu,
      // i tick obrony — bez tej blokady drugie wywolanie startowalo play()
      // na elemencie, ktory wlasnie startowal, i przegladarka odrzucala je
      // przez polityke autoodtwarzania. Objaw w logu 07.08 13:07-13:28:
      // „karta trzymana przy zyciu" i „czeka na kliknięcie" w tej samej
      // sekundzie, w kolko. Wyscig, nie brak zgody.
      if (this._starting) return;
      if (this._playing && this._el && !this._el.paused) return;
      this.start();
    },

    start() {
      try {
        if (!this._el) {
          this._el = new Audio(this._url());
          this._el.loop = true;
          this._el.volume = 1;
        }
        this._starting = true;
        this._el.play().then(() => {
          this._starting = false;
          if (this._playing) return;
          this._playing = true;
          this._say("ok", "[WAKE] karta trzymana przy życiu cichym dźwiękiem — w tle nie zostanie zamrożona ani zdławiona.", "info");
        }).catch((e) => {
          this._starting = false;
          // Polityka autoodtwarzania: pierwszy raz wymaga gestu użytkownika.
          // Nie walczymy z nią — czekamy na dowolne kliknięcie w grę.
          if (this._wired) return;
          this._wired = true;
          this._say("wait", `[WAKE] dźwięk podtrzymujący czeka na pierwsze kliknięcie w grę (${e.name}) — kliknij gdziekolwiek na stronie.`, "warn");
          const kick = () => {
            document.removeEventListener("click", kick, true);
            document.removeEventListener("keydown", kick, true);
            this._wired = false;
            this.start();
          };
          document.addEventListener("click", kick, true);
          document.addEventListener("keydown", kick, true);
        });
      } catch (e) {
        log(`[WAKE] dźwięk podtrzymujący niedostępny: ${e.message}`, "warn");
      }
    },

    stop() {
      if (!this._el) return;
      try { this._el.pause(); } catch {}
      this._playing = false;
    },
  };

  const WakeLock = {
    _lock: null,
    _wired: false,
    supported() { return !!navigator.wakeLock?.request; },
    async acquire() {
      if (!CONFIG.enabled || !this.supported()) return;
      if (this._lock && !this._lock.released) return;
      try {
        this._lock = await navigator.wakeLock.request("screen");
        log("[WAKE] blokada uśpienia aktywna — komputer nie zaśnie, póki karta z grą jest widoczna.", "info");
      } catch (e) {
        log(`[WAKE] nie udało się zablokować uśpienia: ${e.message}`, "warn");
      }
    },
    release() {
      if (!this._lock) return;
      try { this._lock.release(); } catch {}
      this._lock = null;
      log("[WAKE] blokada uśpienia zdjęta (bot OFF) — komputer może zasnąć normalnie.", "info");
    },
    wire() {
      if (this._wired) return;
      this._wired = true;
      if (!this.supported()) {
        log("[WAKE] przeglądarka nie zna Wake Lock API — uśpienie pilnuj systemowo (caffeinate).", "warn");
        return;
      }
      // Przeglądarka zwalnia blokadę przy każdym schowaniu karty — jedyny
      // legalny moment na odzyskanie jej to powrót widoczności.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this.acquire();
      });
      this.acquire();
    },
  };

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

    _cache: null,
    _cacheAt: 0,
    all() {
      // v2.94.0: cache 30 s - pasek statusu liczy summary() co 5 s, a kazde
      // wywolanie parsowalo do 600 wpisow x 400 znakow. add() zeruje cache.
      if (this._cache && Date.now() - this._cacheAt < 30 * 1000) return this._cache;
      try { this._cache = JSON.parse(GM_getValue(this.KEY, "[]")) || []; } catch { this._cache = []; }
      this._cacheAt = Date.now();
      return this._cache;
    },

    add(kind, msg) {
      const now = new Date();
      const stamp = `${now.toLocaleDateString("pl-PL")} ${now.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
      const list = this.all();
      list.unshift({ t: stamp, at: Date.now(), k: kind, m: String(msg).slice(0, 400) });
      GM_setValue(this.KEY, JSON.stringify(this._prune(list)));
      this._cache = null; // v2.94.0: nastepny odczyt widzi swiezy wpis
      try { Notifier.fromJournal(kind, msg); } catch {}  // v2.67.0: push na telefon
      try { updateStatusUI(); } catch {}
    },

    // v2.66.4: wpisy sprzed 2.47.0 nie mają `at` i były traktowane jak wiecznie
    // świeże — alarm z 2 sierpnia straszył w nagłówku „12h" jeszcze 4 sierpnia.
    // Znacznik odtwarzamy z pola tekstowego `t` („2.08.2026 12:18:09"); gdy się
    // nie da, wpis dostaje wiek zerowy i wypada z retencji.
    _stampOf(e) {
      if (Number.isFinite(e.at)) return e.at;
      const m = String(e.t || "").match(/(\d{1,2})\.(\d{2})\.(\d{4})\D+(\d{2}):(\d{2}):(\d{2})/);
      if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]).getTime();
      return 0;
    },
    _prune(list) {
      const cutoff = Date.now() - this.RETAIN_MS;
      const important = [];
      const routine = [];
      for (const e of list) {
        const at = this._stampOf(e);
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
      const recent = this.all().filter(e => this._stampOf(e) >= cutoff);
      const count = (k) => recent.filter(e => e.k === k).length;
      const lastOf = (k) => recent.find(e => e.k === k)?.t || null;
      // ── v2.70.2: alarmy liczone jako EPIZODY, nie wpisy ──
      // Jeden atak generuje kilkanaście wpisów rodzaju ATAK (wykrycia, zmiany
      // liczby flot, zrzuty HTML, cel…) — pasek pokazywał „31 alarmów" przy
      // dwóch realnych epizodach (zgłoszenie właściciela 05.08 15:53).
      // Epizod = zdjęcie alarmu („koniec") + ewentualnie trwający właśnie.
      let alarms = count("koniec");
      try { if (ThreatMonitor.active()) alarms += 1; } catch {}
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
      // v2.61.0: koniec epizodu strony błędu → policz i zapisz, jak długo bot
      // był ślepy. Bez tego wpisu okno ślepoty było niewidoczne w dzienniku —
      // właściciel odkrył je przypadkiem, patrząc na zawieszony ekran.
      const epStart = parseInt(GM_getValue("ogamex_error_episode_at", "0")) || 0;
      if (epStart) {
        GM_setValue("ogamex_error_episode_at", "0");
        const min = Math.round((Date.now() - epStart) / 60000);
        log(`Powrót do gry po ${min} min strony błędu OGameX.`, min >= 3 ? "warn" : "info");
        ThreatLog.add("koniec", `Powrót do gry po ${min} min strony błędu — obrona znów widzi.`);
      }
      return false;
    }

    // v2.61.0: początek epizodu → ślad w dzienniku obrony (raz na epizod).
    if (!(parseInt(GM_getValue("ogamex_error_episode_at", "0")) || 0)) {
      GM_setValue("ogamex_error_episode_at", String(Date.now()));
      ThreatLog.add("BŁĄD", "OGameX serwuje stronę błędu — bot ślepy do czasu powrotu do gry. Odzyskiwanie uruchomione.");
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
        // v2.63.0: /overview też odpada — NA TYM SERWERZE NIE ISTNIEJE (404 za
        // każdym razem; to on stał za wszystkimi stronami błędu z
        // aspxerrorpath=/overview). Przegląd gry żyje pod "/".
        if (/^\/[A-Za-z0-9]/.test(p) && !/^\/(Error|home|overview)\b/i.test(p)) specificTarget = p;
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
        window.location.replace(specificTarget);
        return;
      }
      // Click the page's own "Back to game" — what a human would do.
      const btn = findBackToGameButton();
      if (btn) {
        log("Clicking < Back to game.", "info");
        if (btn.tagName === "A" && btn.href) {
          window.location.replace(btn.href); // use the real href (skips flaky JS handlers)
        } else {
          btn.click();
          // safety net: if the click didn't navigate, force it.
          setTimeout(() => { if (isOGameXErrorPage()) window.location.replace("/"); }, 5000);
        }
        return;
      }
      window.location.replace("/"); // last resort
    }, backoff);

    // ── v2.61.0: strażnik strony błędu ──
    // Incydent 2026-08-03 (×2): bot stał na tej stronie GODZINAMI, bo cała
    // ścieżka odzyskiwania wisiała na JEDNYM setTimeout — a przeglądarka
    // w karcie w tle dławi timery do ~1/min, a przy oszczędzaniu pamięci
    // potrafi je gubić. Jeden zgubiony timer = martwy bot do ręcznego F5.
    // Interwał ponawia próbę co ~60 s tak długo, jak strona błędu stoi;
    // 70-sekundowa zapora nie dubluje próby, którą timeout wyżej ma w drodze.
    // Po 6 nieudanych podejściach eskalacja na "/" — stronę lobby init umie
    // obsłużyć osobno (klik w Play), więc to wyjście z pętli overview→404.
    if (!window.__ogxErrWatch) {
      window.__ogxErrWatch = setInterval(() => {
        try {
          if (!isOGameXErrorPage()) { clearInterval(window.__ogxErrWatch); window.__ogxErrWatch = null; return; }
          const lastTry = parseInt(GM_getValue("ogamex_error_recover_at", "0")) || 0;
          if (Date.now() - lastTry < 70 * 1000) return;
          const streakNow = (parseInt(GM_getValue("ogamex_error_recover_streak", "0")) || 0) + 1;
          GM_setValue("ogamex_error_recover_at", String(Date.now()));
          GM_setValue("ogamex_error_recover_streak", String(streakNow));
          log(`Strażnik strony błędu: ponawiam powrót do gry (próba ${streakNow}).`, "warn");
          if (streakNow >= 6) { window.location.replace("/"); return; }
          const btn = findBackToGameButton();
          if (btn && btn.tagName === "A" && btn.href) window.location.replace(btn.href);
          else if (btn) btn.click();
          else window.location.replace("/");
        } catch {}
      }, 60 * 1000);
    }

    // v2.61.0: pętla obrony startuje TAKŻE tutaj. Strona błędu nie znaczy, że
    // cały serwer leży — /overview potrafi oddawać 404, gdy reszta tras żyje.
    // Odczyt zagrożeń idzie fetchem (lista ruchów flot), więc działa bez
    // paska misji, a ratunek nawiguje prosto do formularza floty. W najgorszym
    // razie fetch pada i pętla jest tania w bezczynności; w najlepszym — bot
    // broni floty nawet wtedy, gdy strona pod nim się wysypała.
    try { startDefenceLoop(); } catch {} // v2.69.1: obserwator czuwa też przy OFF

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
    // v2.99.2: 300 → 450. Przy sweepach ~87 układów limit 300/h wpychał bota
    // w kilkuminutowe „Nav rate limit pause" W ŚRODKU sweepa (decyzja ownera
    // 22.08: tempo skanu > margines stealth; jitter i okno nocne zostają).
    maxPerHour: 450,
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
    // v2.93.0: replace() zamiast href= we WSZYSTKICH programowych nawigacjach
    // bota. Bot robi tysiace przeladowan dziennie; kazde href= doklada wpis
    // do historii karty, a Firefox serializuje historie sesji w tle - po
    // kilku godzinach mulila cala przegladarka (obserwacja ownera 15.08).
    // Dla serwera identyczny GET; replace() po prostu nie rosnie w historii.
    window.location.replace(url);
    return true;
  }

  // v2.10.9: human-pace delay between galaxy-system scans. Was 250-650ms — a
  // clear bot-tell (no human clicks through systems twice a second, and it
  // meant ~124 galaxy page-loads per sweep at machine speed). The
  // closest-range-first scan ORDER is unchanged — only the pacing.
  // v2.99.2: 2-6s → 1-3s (decyzja ownera 22.08). Owner klika ręcznie co
  // ~1-2 s, więc 1-3 s to wciąż ludzkie tempo, a średnia pauza spada 4s→2s
  // (sweep ~2× szybszy, asteroidy rzadziej padają na bramce TTL).
  function humanScanDelayMs() {
    return 1000 + Math.random() * 2000;
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
  //  FLIGHT CALIBRATION (v2.99.0) — czas lotu minerów uczony per-serwer
  // ═══════════════════════════════════════════════════════════════
  // estimateFlightMinutes miał stałe z dwupunktowej kalibracji na athenie
  // (fleet x4). Genesis ma fleet x3 → loty ~4/3 dłuższe, więc stały wzór
  // ZANIŻA czas dolotu i bramka TTL wypuszcza minery na asteroidy, które
  // znikną przed dolotem. Bot i tak czyta PRAWDZIWY czas lotu z formularza
  // na kroku 2 (capturedFlightMs, v2.66.8) — tu zapisujemy pary
  // (Δ systemów, minuty) do magazynu per-host i po ≥2 próbkach o rozrzucie
  // ≥20 systemów liczymy własne dopasowanie a + b·Δ (najmniejsze kwadraty).
  // Uczymy się WYŁĄCZNIE z misji asteroid_mining_direct (jeden typ statku,
  // 100% prędkości) — farm/ekspedycje/ratunki zatrułyby dopasowanie.
  // Do czasu nauki: stary wzór atheny (fail-safe, konserwatywny na x4).
  // ── FLIGHT-CAL-START ──
  const FlightCalibration = {
    KEY: "ogamex_flight_cal",
    MAX_SAMPLES: 30,
    MIN_SPREAD: 20,     // minimalny rozrzut Δ między próbkami — bez niego nachylenie to szum
    _cache: null,       // { n, fit } — fit() woła się przy każdym planowaniu skanu

    load() {
      try { const raw = GM_getValue(this.KEY, null); const st = raw ? JSON.parse(raw) : null; return st && Array.isArray(st.samples) ? st : { samples: [] }; }
      catch { return { samples: [] }; }
    },
    save(st) { GM_setValue(this.KEY, JSON.stringify(st)); this._cache = null; },

    // dist: Δ systemów (ta sama galaktyka), minutes: realny czas w jedną stronę z formularza
    record(dist, minutes) {
      if (!Number.isFinite(dist) || dist < 0 || dist > 499) return false;
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 600) return false;
      const st = this.load();
      st.samples.push({ d: dist, m: Math.round(minutes * 10) / 10, at: Date.now() });
      if (st.samples.length > this.MAX_SAMPLES) st.samples = st.samples.slice(-this.MAX_SAMPLES);
      this.save(st);
      log(`[KALIBRACJA] lot minerów Δ${dist} → ${minutes.toFixed(1)} min (próbek: ${st.samples.length})`, "asteroid");
      return true;
    },

    // Dopasowanie m = a + b·Δ; null = za mało danych → wzór atheny
    fit() {
      const st = this.load();
      const s = st.samples;
      if (this._cache && this._cache.n === s.length) return this._cache.fit;
      let fit = null;
      if (s.length >= 2) {
        const dMin = Math.min(...s.map(x => x.d)), dMax = Math.max(...s.map(x => x.d));
        if (dMax - dMin >= this.MIN_SPREAD) {
          const n = s.length;
          const sumD = s.reduce((a, x) => a + x.d, 0), sumM = s.reduce((a, x) => a + x.m, 0);
          const meanD = sumD / n, meanM = sumM / n;
          const varD = s.reduce((a, x) => a + (x.d - meanD) ** 2, 0);
          const cov = s.reduce((a, x) => a + (x.d - meanD) * (x.m - meanM), 0);
          let b = cov / varD;
          if (b < 0) b = 0; // dalej ≠ szybciej — ujemne nachylenie to szum pomiarowy
          const a = meanM - b * meanD;
          if (a > 0) fit = { a, b };
        }
      }
      this._cache = { n: s.length, fit };
      return fit;
    },

    // Oszacowanie w minutach z marginesem bezpieczeństwa (+2 min, sufit) —
    // bramka TTL woli odpuścić asteroidę niż wysłać minery na despawn.
    estimate(dist) {
      const f = this.fit();
      if (!f) return null;
      return Math.max(3, Math.ceil(f.a + f.b * dist) + 2);
    },
  };
  // ── FLIGHT-CAL-END ──

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
    // v2.99.0: najpierw dopasowanie nauczone z realnych lotów NA TYM serwerze
    // (FlightCalibration, per-host — Genesis fleet x3 ≠ athena x4); stałe
    // atheny zostają jako fallback do czasu ≥2 próbek o sensownym rozrzucie.
    estimateFlightMinutes(systemDistance) {
      const learned = FlightCalibration.estimate(systemDistance);
      if (learned !== null) return learned;
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
  // Szacunek round-tripu, gdy gra nie poda czasu lotu: 15 min (typowy lot na
  // asteroide to 3-8 min w jedna strone). Patrz komentarz przy add().
  const FALLBACK_ROUNDTRIP_MS = 15 * 60 * 1000;

  const MiningFlights = {
    KEY: "ogamex_mining_flights",

    _load() {
      try {
        const now = Date.now();
        return JSON.parse(GM_getValue(this.KEY, "[]")).filter(e => e && e.returnAt > now);
      } catch { return []; }
    },

    // flightMs = czas lotu w jedna strone z formularza gry (moze byc nieznany)
    // ── v2.58.0: fallback byl KATASTROFALNIE dlugi ──
    // Gdy czasu lotu nie dalo sie odczytac, wpis dostawal maxFlightMinutes*2 =
    // 90 MINUT (a przy starych configach nawet wiecej). Realny lot na asteroide
    // trwa ~3-8 min, wiec taki wpis-duch blokowal slot budzetu przez godzine z
    // okladem: log pokazywal "flight budget reached (3/3)" przy DWOCH realnych
    // misjach w grze. Autor kodu sam zapisal zasade: pomylka "za krotko" kosztuje
    // najwyzej jeden lot ponad limit (sam sie rozejdzie), a "za dlugo" kosztuje
    // przestoj na glownym zrodle dochodu. Wiec szacujemy krotko.
    add(coord, flightMs) {
      const roundTrip = flightMs > 0
        ? flightMs * 2 + 60000
        : FALLBACK_ROUNDTRIP_MS;
      const entries = this._load();
      entries.push({ coord: coord || "?", at: Date.now(), returnAt: Date.now() + roundTrip });
      GM_setValue(this.KEY, JSON.stringify(entries));
    },

    count() { return this._load().length; },

    // ── v2.58.0: KONFRONTACJA Z GRA ──
    // Rejestr byl jedynym zrodlem prawdy o wlasnych lotach i nikt go nigdy nie
    // sprawdzal z rzeczywistoscia. Kazdy wpis z zawyzonym returnAt (nieznany czas
    // lotu, przerwana wysylka, restart przegladarki w trakcie) wisial do wygasniecia
    // i zjadal slot budzetu. Gra podaje liczbe WSZYSTKICH wlasnych misji ("M Own") —
    // to twarda GORNA granica liczby naszych lotow gorniczych (mining to podzbior).
    // Jesli mamy wiecej wpisow niz gra widzi misji, nadmiar to duchy: kasujemy
    // najstarsze, bo one najpewniej juz wrocily. Zwraca liczbe usunietych.
    reconcile(ownMissions) {
      if (!(ownMissions >= 0)) return 0;           // brak paska misji na tej stronie
      const entries = this._load();
      if (entries.length <= ownMissions) return 0;
      entries.sort((a, b) => (a.at || 0) - (b.at || 0));   // najstarsze pierwsze
      const ghosts = entries.length - ownMissions;
      const kept = entries.slice(ghosts);
      GM_setValue(this.KEY, JSON.stringify(kept));
      return ghosts;
    },

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
  // ── v2.102.0 (audyt 25.08, I-A1): fetch z TIMEOUTEM ──
  // W pliku nie było ani jednego AbortController. Jedno zawieszone zapytanie
  // w ticku obrony = `defenceRunning` na zawsze true = pętla obrony martwa do
  // przeładowania (12-40 min). Każdy fetch obrony idzie przez fetchT.
  async function fetchT(url, opts = {}, ms = 8000) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, ms) : null;
    try { return await fetch(url, ctrl ? { ...opts, signal: ctrl.signal } : opts); }
    finally { if (t) clearTimeout(t); }
  }

  // ── v2.102.0 (I-A5): utrata sesji = BŁĄD z pushem, nie „czysto" ──
  // Wylogowana sesja zwraca stronę logowania z kodem 200 → lista pusta →
  // po 90 s pasek czytany ze STATYCZNEGO DOM sprzed wylogowania = „czysto"
  // na zawsze, zero pusha. Tu jest jedna pamięć „sesja padła" dla obrony.
  const SessionWatch = {
    KEY: "ogamex_session_lost_at",
    KEY_SAID: "ogamex_session_lost_said",
    looksLoggedOut(res, html) {
      try {
        if (res && res.redirected && /login|auth|password/i.test(String(res.url || ""))) return true;
        const head = String(html || "").slice(0, 1500);
        return /name=["']password["']|type=["']password["']|<form[^>]*login/i.test(head);
      } catch { return false; }
    },
    lost() {
      const now = Date.now();
      GM_setValue(this.KEY, String(now));
      const said = parseInt(GM_getValue(this.KEY_SAID, "0")) || 0;
      if (now - said > 10 * 60 * 1000) {
        GM_setValue(this.KEY_SAID, String(now));
        log("[SESJA] gra odpowiada stroną logowania — bot jest ŚLEPY (nie widzi ataków). Zaloguj się ponownie.", "error");
        ThreatLog.add("BŁĄD", "SESJA WYGASŁA — obrona ślepa do ponownego zalogowania. Zaloguj się w grze.");
      }
    },
    ok() { GM_setValue(this.KEY, "0"); },
    lostRecently() { const t = parseInt(GM_getValue(this.KEY, "0")) || 0; return t && Date.now() - t < 15 * 60 * 1000; },
    // v2.107.0 (audyt 2, Z7/A8): sesja padła → po 2 min JEDNA próba nawigacji na "/"
    // (fork bywa zalogowany po ciasteczku, tylko AJAX dostał stronę logowania),
    // zamiast 15 min ślepoty. Kolejna próba nie częściej niż co 15 min.
    KEY_RETRY: "ogamex_session_retry_at",
    maybeRecover() {
      const lost = parseInt(GM_getValue(this.KEY, "0")) || 0;
      if (!lost || Date.now() - lost < 2 * 60 * 1000) return false;
      const tried = parseInt(GM_getValue(this.KEY_RETRY, "0")) || 0;
      if (Date.now() - tried < 15 * 60 * 1000) return false;
      const pendingRaw = GM_getValue("pending_mission", null);
      if (pendingRaw && pendingRaw !== "null") return false;
      GM_setValue(this.KEY_RETRY, String(Date.now()));
      log("[SESJA] 2 min od wykrycia wylogowania — próbuję wejść na \"/\" (jeśli gra wpuści, obrona odzyska wzrok).", "warn");
      window.location.replace("/");
      return true;
    },
  };

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
      const vis = (typeof document !== "undefined" && document.visibilityState === "visible");
      if (lock && lock.id !== this.id() && now - lock.at <= this.STALE_MS) {
        // v2.102.0 (I-A2): karta WIDOCZNA przejmuje przywództwo od lidera w tle
        // (dławione timery) — po 20 s jego ukrycia. Widoczna karta = pełne tempo.
        const takeover = vis && lock.vis === false && now - (lock.visAt || lock.at) > 20 * 1000;
        if (!takeover) return false;
        log("[KARTY] przejmuję sterowanie: poprzednia karta-lider jest w tle (dławione timery), ta jest widoczna.", "warn");
      }
      let visAt = now;
      try { if (lock && lock.id === this.id() && lock.vis === vis) visAt = lock.visAt || now; } catch {}
      try { localStorage.setItem(this.LS_KEY, JSON.stringify({ id: this.id(), at: now, vis, visAt })); } catch { return true; }
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
    // v2.59.0: pierwszy w kolejce jest POTWIERDZONY endpoint tego serwera
    // (lista ruchów flot podaje cel każdej misji jako [g:s:p] w treści wiersza).
    // Stare /ajax/* z upstream OGameX tu nie istnieją (404) — sprzątanie 2.54.0
    // ominęło to miejsce i każda wysyłka górnicza zostawiała dwa 404 w logach
    // serwera. Bramka Ajax.supported wyłącza martwy adres po pierwszym 404.
    for (const url of ["/home/fleetmovementlist", "/ajax/fleet/eventlist", "/ajax/fleet/eventbox"]) {
      if (!Ajax.supported(url)) continue;
      try {
        const res = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
        if (!res.ok) { Ajax.markUnsupported(url, res.status); continue; }
        Ajax.markWorking(url);
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
      // ── v2.63.2: strażnik rozsądku ──
      // 2026-08-03 18:08:20 parser kroku 2 złapał ze strony LICZBĘ LEKKICH
      // TRANSPORTOWCÓW (4 777 288 823 — co do cyfry stan hangaru) zamiast
      // ładowności i „nauczył się" 4 zamiast 20 750. Przez 28 s minersNeeded
      // liczyło się od wartości 5000× za małej. Fizyczna ładowność minera
      // zmienia się wyłącznie z badaniami — nigdy skokiem o rzędy wielkości.
      // Nowa wartość odbiegająca >3× od znanej to śmieciowy odczyt, nie wiedza.
      const prev = parseInt(GM_getValue(this.CARGO_KEY, "0")) || 0;
      if (prev > 0 && (per > prev * 3 || per < prev / 3)) {
        log(`Odrzucam odczyt ładowności ${per.toLocaleString()}/minera (znane: ${prev.toLocaleString()}) — parser złapał złą liczbę ze strony.`, "warn");
        return;
      }
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
          // v2.64.0: zanim stare parsery zaczną zgadywać — jeśli jest klucz,
          // model czyta HTML wprost. Porażka LLM = cicha kontynuacja po staremu.
          try {
            const n = await LlmParser.extractYields(html, url);
            if (n > 0) return;
          } catch {}
          // v2.49.0: pierwszy raz z każdego źródła zrzuć próbkę — bez niej nie
          // da się napisać parsera pod markup TEGO serwera, a zgadywanie już raz
          // kosztowało pięć wersji.
          // v2.63.3: klucz podbity — zrzut z 2 sierpnia przepadł z logu, a bez
          // markupu dziennika wypraw nie da się napisać parsera urobku.
          const dumpKey = `ogamex_dump2_${url.replace(/\W+/g, "_").slice(0, 60)}`;
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
      window.location.replace(url);
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
  //  v2.79.0 — ALARM = TYLKO EWAKUACJA (wspólna bramka wysyłek)
  // ═══════════════════════════════════════════════════════════════
  // Reguła właściciela (07.08): „gdy jest atak i jest alarm, bot nie powinien
  // floty wysyłać, tylko ewakuować każdą wracającą flotę na planetę".
  //
  // Dotąd każdy moduł pilnował tego sam i po swojemu: ekspedycje i farmienie
  // patrzyły wyłącznie na ThreatMonitor.active(), a MINING nie patrzył
  // WCALE — w alarmie 11:15-11:20 skaner dalej chodził po galaktyce i wysłał
  // 2,5 mld minerów. To jest jedno miejsce z odpowiedzią „czy wolno teraz
  // wysyłać cokolwiek".
  //
  // Okno obrony NIE kończy się w chwili, gdy obce floty znikną z paska:
  // ratunek albo powrót jeszcze leci (81 s na te same koordy), straż dalej
  // zamiata bazę, a surowce są w powietrzu. Fala wysłana w tym oknie zabiera
  // statki spod ewakuacji i pali deuter, którego zabraknie na ucieczkę —
  // dokładnie to widać było o 11:21:50 (ekspedycja poszła 66 s po zdjęciu
  // alarmu, gdy księżyc miał na koncie samą rezerwę paliwa).
  const KEY_DEFENCE_AT = "ogamex_defence_last_at";

  const DefenceHold = {
    // Ile czekamy po ostatnim ruchu obrony, zanim znów wolno wysyłać.
    // Hop na te same koordy trwa ~81 s; 140 s to lądowanie + zapas na to,
    // żeby surowce zdążyły wejść na konto ciała.
    SETTLE_MS: 140 * 1000,

    stamp() { try { GM_setValue(KEY_DEFENCE_AT, String(Date.now())); } catch {} },

    /** Powód wstrzymania wysyłek albo null, gdy wolno pracować normalnie. */
    reason() {
      try {
        if (ThreatMonitor.active()) return "trwa alarm — obce floty w drodze";
        const w = MoonSave.watch() || {};
        if (w.armed) return "straż obrony uzbrojona — baza ma zostać pusta";
        const ref = parseInt(GM_getValue(KEY_DEFENCE_AT, "0")) || 0;
        const left = ref + this.SETTLE_MS - Date.now();
        if (ref && left > 0) {
          return `ratunek/powrót jeszcze w locie (~${Math.ceil(left / 1000)}s do lądowania)`;
        }
      } catch {}
      return null;
    },

    /** true = wolno wysyłać. Loguje powód nie częściej niż co 5 min. */
    allows(who) {
      const why = this.reason();
      if (!why) return true;
      const key = `hold_${who}`;
      const last = this._said[key] || 0;
      if (Date.now() - last > 5 * 60 * 1000) {
        this._said[key] = Date.now();
        log(`[OBRONA] ${who} wstrzymane: ${why}. Ewakuacja ma pierwszeństwo.`, "warn");
      }
      return false;
    },
    _said: {},
  };

  // ── v2.79.0: paliwo na ucieczkę jest nietykalne ──
  // `deutReserve` (100 mld, decyzja ownera 06.08) zostaje na ciele przy każdym
  // ratunku PO to, żeby flota wracająca w trakcie alarmu miała czym uciec.
  // Nic tego dotąd nie pilnowało od drugiej strony: ekspedycje i mining brały
  // paliwo z tego samego zbiornika, więc rezerwa mogła zniknąć na wypady po
  // zysk, a przy kolejnym ataku nie byłoby czym ewakuować. Dodatkowo — to jest
  // ta pętla, którą właściciel zgłosił 07.08 — po ratunku na ciele zostaje
  // DOKŁADNIE rezerwa, więc każda próba wysyłki i tak kończy się odmową gry;
  // lepiej nie wchodzić w formularz wcale i powiedzieć to wprost w logu.
  const Fuel = {
    reserve() { return Math.max(0, parseInt(CONFIG.threatAlarm?.deutReserve) || 0); },

    /** Deuter na aktualnie wybranym ciele albo null, gdy nie da się odczytać. */
    read() {
      try {
        const el = document.querySelector(".resource-item-deuterium");
        if (!el) return null;
        // „Deuterium\n 100.000.000.000" → pierwszy blok cyfr z separatorami.
        const m = (el.textContent || "").match(/\d[\d.,\s ']*/);
        if (!m) return null;
        const n = parseInt(m[0].replace(/[^\d]/g, ""), 10);
        return Number.isFinite(n) ? n : null;
      } catch { return null; }
    },

    /**
     * true = wolno wysyłać. Odczyt niemożliwy (strona bez paska surowców)
     * NIE blokuje — bramka ma chronić rezerwę, a nie zatrzymywać bota na
     * podstawie zgadywania.
     */
    allows(who) {
      const reserve = this.reserve();
      if (!reserve) return true;
      const have = this.read();
      if (have == null) return true;
      if (have > reserve) return true;
      const key = `fuel_${who}`;
      const last = this._said[key] || 0;
      if (Date.now() - last > 10 * 60 * 1000) {
        this._said[key] = Date.now();
        log(`[PALIWO] ${who} wstrzymane: na ciele ${have.toLocaleString()} deuteru, a ${reserve.toLocaleString()} to nietykalna rezerwa na ewakuację floty. Czekam, aż paliwo wróci (powrót po alarmie / produkcja).`, "warn");
      }
      return false;
    },
    _said: {},
  };

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
      // v2.79.0: mining nie miał ŻADNEJ bramki obrony — w alarmie 07.08 skaner
      // dalej chodził po galaktyce i był o krok od wysłania 2,5 mld minerów.
      // Cała maszyneria (skan, nawigacja, wysyłka) stoi na czas ewakuacji:
      // rywalizacja o stronę z ratunkiem jest równie kosztowna co sama fala.
      if (!DefenceHold.allows("mining")) return;
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

      // v2.84.0: miners launch from launchFrom (panel) or the ACTIVE body
      const base = HomeBase.mining();
      if (!base) {
        log("Nie znam punktu startu (brak paska planet i minerBase) — wysyłka nie ruszy.", "warn");
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
          const baseCfg = HomeBase.mining();
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
        const baseCfg = HomeBase.mining();
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
        const baseForCheck = HomeBase.mining();
        if (result.ttlSeconds != null && baseForCheck) {
          const sameGal = baseForCheck.galaxy === current.galaxy;
          const dist = sameGal ? Math.abs(baseForCheck.system - current.system) : Infinity;
          const estMin = sameGal ? AsteroidScanner.estimateFlightMinutes(dist) : Infinity;
          const estSec = estMin * 60;
          const ARRIVAL_BUFFER_SEC = 300;
          if (!Number.isFinite(estSec) || estSec + ARRIVAL_BUFFER_SEC > result.ttlSeconds) {
            // v2.98.1: skip międzygalaktyczny dostaje JASNY komunikat (throttle
            // 1 h) — incydent 17.08: baza aktywna w g2, asteroidy w g3, bot
            // w kółko skanował i po cichu odrzucał każde znalezisko logiem
            // „flight ~Infinitymin". Operator ma wiedzieć CO uzupełnić.
            if (!sameGal) {
              const lastHint = parseInt(GM_getValue("ogamex_crossgal_hint_at", "0")) || 0;
              if (Date.now() - lastHint > 3600000) {
                GM_setValue("ogamex_crossgal_hint_at", String(Date.now()));
                log(`MINING MARTWY: asteroida [${current.galaxy}:${current.system}:17], a start minerów to [${baseForCheck.galaxy}:${baseForCheck.system}] — INNA GALAKTYKA, każde znalezisko będzie odrzucane. Wpisz w panelu „Start minerów (g:s:p)" koordy ciała w gal. ${current.galaxy}, gdzie fizycznie stoją minery z deuterem.`, "error");
              }
            }
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
            launchAt: HomeBase.mining(), // v2.84.0: skąd ma wyjść flota (formularz przełączy ciało)
            step: "select_ships_direct",
            resumeScan: true, // flag: after dispatch, continue scanning
            timestamp: Date.now(),
          }));
          RateLimiter.record();
          await AntiDetection.shortDelay(); // 2-8s, fast like a real player clicking
          window.location.replace(result.fleetUrl);
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
        const base = HomeBase.mining();
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
      // v2.79.0: ostatnia bramka przed samą wysyłką — lot minerów pali deuter,
      // a rezerwa na ewakuację floty nie jest do wzięcia. Asteroida i tak ma
      // swój TTL; lepiej ją stracić niż paliwo na ucieczkę.
      if (!DefenceHold.allows("mining") || !Fuel.allows("mining")) return;

      // v2.84.0: miners launch from launchFrom (panel) or the ACTIVE body
      const base = HomeBase.mining();
      if (!base) {
        log("Nie znam punktu startu (brak paska planet i minerBase) — nie wysyłam.", "error");
        ScanState.clear();
        return;
      }
      if (base.galaxy !== asteroid.galaxy) {
        log(`Punkt startu [${base.galaxy}:${base.system}] i asteroida ${asteroid.label} w różnych galaktykach — pomijam.`, "error");
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

      log(`Dispatching to ${asteroid.label} from active body [${base.galaxy}:${base.system}:${base.position}] (~${estMinutes}min)`, "asteroid");

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
        launchAt: base, // v2.84.0: skąd ma wyjść flota (formularz przełączy ciało)
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
      window.location.replace(fleetUrl);
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  INACTIVE FARMER  (v2.11.0) — event farming of (i)/(I) players
  // ═══════════════════════════════════════════════════════════════
  // Sweeps user-configured system ranges ("3:100-200"), collects every planet
  // whose player status is (i)/(I) — skipping (v)/(p)/(b) — and attacks each
  // with Heavy Cargo via the direct fleet URL (…&z=P&planet=1&mission=8),
  // reusing the guarded select_ships_direct 3-step machinery. v2.90.0:
  // współistnieje z Asteroid Mining — mining ma PIERWSZEŃSTWO (asteroidy
  // zarabiają więcej), farm rusza się tylko, gdy skaner asteroid śpi
  // (minery w locie / cooldowny) — patrz farmYieldsToMining.

  // ── v2.89.0: ranking celu z wiersza galaktyki ──
  // Tooltip gracza („Royal Zion / Ranking: 2.881 / Write message…") jest
  // renderowany serwerowo w HTML wiersza — czasem jako zwykły tekst, czasem
  // w atrybucie data-tooltip-content/title (tak fork robi tooltipy w innych
  // miejscach). Parser dostaje ZLEPEK obu źródeł. Kropka/przecinek/nbsp to
  // separatory tysięcy („2.881" = ranking 2881, nie 2,881).
  // ── FARM-RANK-START (test-farm-rank.js czyta ten blok w całości) ──
  const FARM_RANK_RX = /rank(?:ing)?\s*:?\s*(\d{1,3}(?:[.,  ]\d{3})+|\d+)/i;
  function farmParseRank(raw) {
    const m = FARM_RANK_RX.exec(String(raw || ""));
    if (!m) return null;
    const n = parseInt(m[1].replace(/\D/g, ""), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function farmRankEligible(rank, maxRank) {
    if (!maxRank) return true;     // 0 = filtr wyłączony
    if (rank == null) return true; // nieznany ranking → atakuj (fail-open), log krzyczy osobno
    return rank <= maxRank;
  }
  // ── FARM-RANK-END ──

  // ── v2.90.0: MINING MA PIERWSZEŃSTWO, FARM WYPEŁNIA OKNA ──
  // Decyzja ownera (14.08): asteroidy zarabiają więcej niż farmienie, więc
  // koniec z either/or (włączenie farmy WYŁĄCZAŁO mining — bot tracił
  // główne źródło dochodu). Oba moduły mogą być ON naraz; farm rusza się
  // TYLKO wtedy, gdy mining i tak nic nie robi:
  //   • minery w locie (ogamex_fleet_return_at w przyszłości — tryb parallel
  //     ZERUJE ten timer, gdy dalej skanuje, więc timer>now naprawdę znaczy
  //     „skan śpi do powrotu”),
  //   • 10-min cooldown po nieudanej wysyłce minerów,
  //   • przerwa między skanami zakresów (ogamex_scan_cooldown_until).
  // W każdej innej sytuacji mining pracuje albo zaraz ruszy — farm czeka.
  // Rytm z logów: mining skanuje ~1-2 min, potem 8-25 min lotu — farm dostaje
  // większość zegara, ale nigdy kosztem asteroid.
  // ── FARM-PRIO-START (test-farm-priorytet.js czyta ten blok w całości) ──
  const MINING_FAIL_COOLDOWN_MS = 10 * 60 * 1000; // ta sama stała co w skanerze asteroid

  // v2.95.0: stempel porazki wysylki TYLKO dla misji gorniczych. v2.66.3
  // wylaczyla ekspedycje, ale farm/zlom/ratunek dalej wbijaly 10-minutowy
  // cooldown SKANERA ASTEROID za wlasne porazki. Od v2.90.0 farm chodzi
  // rownolegle z miningiem, wiec jego wpadka (np. timeout kroku formularza)
  // parkowala mining przy WOLNYCH asteroidach - obserwacja ownera 15.08
  // ~09:00: farm mieli ataki w 4 gali, a skaner stoi "last dispatch failed".
  // Piec flag = ta sama macierz, ktora zdejmuje lot z licznika minerow.
  function stampDispatchFailIfMining(mission) {
    const miningMission = !mission?.expedition && !mission?.farm && !mission?.recycle && !mission?.moonSave && !mission?.fleetSave;
    if (miningMission) GM_setValue("ogamex_dispatch_fail_at", String(Date.now()));
  }
  function farmYieldsToMining(s) {
    // s = { miningEnabled, now, fleetReturnAt, dispatchFailAt, scanCooldownUntil }
    if (!s.miningEnabled) return false;                                        // mining OFF → farm wolny
    if (s.fleetReturnAt > s.now) return false;                                 // minery w locie → okno farmy
    if (s.dispatchFailAt && s.now - s.dispatchFailAt < MINING_FAIL_COOLDOWN_MS) return false; // cooldown po porażce
    if (s.scanCooldownUntil > s.now) return false;                             // przerwa między skanami
    return true;                                                               // mining pracuje/zaraz ruszy → farm ustępuje
  }
  // ── FARM-PRIO-END ──

  // ── v2.89.0: trwała baza celów farmienia ──
  // Każdy zeskanowany system NADPISUJE swoje wpisy (planeta, która przestała
  // być nieaktywna, znika z bazy przy najbliższej wizycie). Baza trzyma
  // WSZYSTKICH nieaktywnych — także tych poza limitem rankingu — bo limit
  // można zmienić suwakiem bez ponownego pełnego skanu. Wpisy niewidziane
  // 7 dni wypadają same (skasowana planeta w systemie, którego już nie
  // odwiedzamy, nie może wiecznie ciągnąć okrążeń).
  const FarmTargetDB = {
    KEY: "ogamex_farm_target_db",
    TTL_DAYS: 7,
    load() {
      try { const o = JSON.parse(GM_getValue(this.KEY, "{}")); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; }
      catch { return {}; }
    },
    save(db) { GM_setValue(this.KEY, JSON.stringify(db)); },
    updateSystem(galaxy, system, entries) {
      const db = this.load();
      // v2.94.0: wiekszosc systemow w przemiataniu nie ma zadnych wpisow -
      // porownanie przed/po oszczedza zapis calej bazy (dziesiatki KB) na
      // kazdy taki system. Systemy z celami i tak zapisuja (swiezy seenAt).
      const before = JSON.stringify(db);
      const prefix = `${galaxy}:${system}:`;
      for (const c of Object.keys(db)) if (c.startsWith(prefix)) delete db[c];
      entries.forEach(e => { db[e.coord] = { name: e.name || "?", rank: e.rank ?? null, seenAt: Date.now() }; });
      const cut = Date.now() - this.TTL_DAYS * 86400000;
      for (const c of Object.keys(db)) if ((db[c].seenAt || 0) < cut) delete db[c];
      if (JSON.stringify(db) !== before) this.save(db);
    },
    stats(maxRank) {
      const db = this.load();
      let total = 0, eligible = 0, unknown = 0;
      for (const c in db) {
        total++;
        if (db[c].rank == null) unknown++;
        if (farmRankEligible(db[c].rank, maxRank)) eligible++;
      }
      return { total, eligible, unknown };
    },
    // Systemy (w obrębie AKTUALNYCH zakresów), w których stoi choć jeden cel
    // przechodzący filtr — z tego buduje się kolejkę szybkiego okrążenia.
    eligibleSystems(maxRank, ranges) {
      const db = this.load();
      const seen = new Set(); const out = [];
      for (const c in db) {
        if (!farmRankEligible(db[c].rank, maxRank)) continue;
        const parts = c.split(":");
        const g = parseInt(parts[0]), s = parseInt(parts[1]);
        if (!Number.isFinite(g) || !Number.isFinite(s)) continue;
        if (!ranges.some(r => r.galaxy === g && s >= r.start && s <= r.end)) continue;
        const key = `${g}:${s}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ galaxy: g, system: s });
      }
      // v2.97.0: okrazenie po bazie odwiedza najpierw systemy z najwiekszym
      // ZNANYM lupem (suma EMA celow w systemie); remis/nieznane — numerycznie.
      const ysum = FarmYieldDB.systemSums();
      out.sort((a, b) => (ysum[`${b.galaxy}:${b.system}`] || 0) - (ysum[`${a.galaxy}:${a.system}`] || 0) || a.galaxy - b.galaxy || a.system - b.system);
      return out;
    },
  };

  // Per-target attack cooldown — full g:s:z coords (many targets per system).
  // ═══════════════════════════════════════════════════════════════
  //  CZARNA LISTA FARMY (v2.96.0) — nie rozbijaj sie drugi raz o obrone
  // ═══════════════════════════════════════════════════════════════
  // Incydent 15.08 (~09:30): 10 atakow z rzedu (po 30 mln HC) rozbilo sie
  // o obrone planet Sith Campeador w [4:36-37] — nieaktywny NIE znaczy
  // bezbronny, a farm slepo wracal na te same koordy co okrazenie.
  // Zrodlo prawdy: raporty bojowe. Wlasne straty > 0 = planeta ma obrone
  // = ban na TTL (obrona po bitwie i tak sie odbudowuje, wiec powrot
  // po 2 tygodniach ma sens tylko na prosbe operatora).
  // ── FARM-BAN-START ──
  const FarmBlacklist = {
    KEY: "ogamex_farm_blacklist",
    TTL_MS: 14 * 24 * 60 * 60 * 1000,
    load() { try { return JSON.parse(GM_getValue(this.KEY, "{}")) || {}; } catch { return {}; } },
    save(d) { GM_setValue(this.KEY, JSON.stringify(d)); },
    has(coord) {
      const e = this.load()[coord];
      return !!e && Date.now() - (e.at || 0) < this.TTL_MS;
    },
    // true = swiezy ban (do zliczania w logu); ponowny raport tylko odswieza stempel
    add(coord, losses) {
      const d = this.load();
      const fresh = !d[coord];
      d[coord] = { at: Date.now(), losses: losses || 0 };
      const cut = Date.now() - this.TTL_MS;
      for (const c of Object.keys(d)) if ((d[c].at || 0) < cut) delete d[c];
      this.save(d);
      return fresh;
    },
    count() {
      const d = this.load();
      const cut = Date.now() - this.TTL_MS;
      return Object.keys(d).filter(c => (d[c].at || 0) >= cut).length;
    },
  };

  // Czyta liste raportow bojowych i banuje cele, na ktorych farm sie rozbil.
  // Transport ten sam co Yield fetch (API .NET zlapane snifferem w v2.49.0);
  // kategoria combat nie jest potwierdzona, wiec: kandydaci + zapamietanie
  // dzialajacego adresu + rownolegle zbior z OTWARTEJ strony /messages
  // (harvestDom) — ta druga droga dziala na pewno, bo parsuje czysty tekst,
  // ktory widac na ekranie (nazwa/koordy/straty/lup).
  const CombatWatch = {
    KEY_AT: "ogamex_combat_watch_at",
    KEY_URL: "ogamex_combat_endpoint",
    EVERY_MS: 10 * 60 * 1000,
    CANDIDATES: [
      "/messages/messagedata?MessageCategoryType=FLEET_COMBAT&page=1",
      "/messages/messagedata?MessageCategoryType=COMBAT&page=1",
      "/messages/messagedata?MessageCategoryType=COMBAT_REPORTS&page=1",
    ],
    _num(s) { const n = parseInt(String(s).replace(/[^0-9]/g, ""), 10); return Number.isFinite(n) ? n : null; },
    // Czysty tekst -> [{coord, losses, resources}]. Uklad z zywego serwera:
    // "Combat report: Delta 11 [4:37:11] 15.08.2026 09:36:11 MCH : 360.000.000
    //  Sith Campeador : 0 Resources : 0 Debris field : 288.000.000.000".
    // Pierwsza para "nazwa : liczba" (poza Resources/Debris) = straty
    // ATAKUJACEGO. Raport z obrony wlasnej kolonii tez przejdzie, ale jego
    // koordy to NASZA planeta — farm nigdy jej nie zaatakuje, ban jalowy.
    parse(text) {
      const out = [];
      const marks = [];
      const re = /Combat report:[^\[]{0,80}\[(\d+):(\d+):(\d+)\]/g;
      let m;
      // Poczatek fragmentu ZA tytulem — koordy z naglowka nie moga wpasc do
      // par "gracz : liczba" (test: [4:37:11] dawal straty "37").
      while ((m = re.exec(text))) marks.push({ start: m.index + m[0].length, idx: m.index, coord: `${m[1]}:${m[2]}:${m[3]}` });
      for (let i = 0; i < marks.length; i++) {
        let chunk = text.slice(marks[i].start, marks[i + 1] ? marks[i + 1].idx : marks[i].start + 1600);
        // Data i godzina raportu ("15.08.2026 09:36:11") tez wygladaja jak
        // pary z dwukropkiem — precz z nimi przed skanowaniem.
        chunk = chunk.replace(/\d{1,2}\.\d{2}\.\d{4}[\s\u00A0]+\d{1,2}:\d{2}(:\d{2})?/g, " ");
        const resM = chunk.match(/Resources\s*:\s*([0-9][0-9.,\s\u00A0]*)/i);
        let losses = null;
        const pairRe = /([^:\n]{2,40}?)\s*:\s*([0-9][0-9.,\s\u00A0]*)/g;
        let pm;
        while ((pm = pairRe.exec(chunk))) {
          const name = pm[1].trim();
          if (/resources|debris/i.test(name)) continue;
          losses = this._num(pm[2]);
          break;
        }
        out.push({ coord: marks[i].coord, losses, resources: resM ? this._num(resM[1]) : null });
      }
      return out;
    },
    _apply(reports, sourceLabel) {
      let banned = 0;
      for (const r of reports) {
        if (r.losses == null || r.losses <= 0) continue;
        if (FarmBlacklist.add(r.coord, r.losses)) {
          banned++;
          log(`[FARM BAN] [${r.coord}] — obrona rozbila flote (straty ${r.losses.toLocaleString("pl-PL")}, lup ${r.resources ?? "?"}). Ban 14 dni.`, "warn");
        }
      }
      if (banned) log(`[FARM BAN] ${sourceLabel}: dopisano ${banned} planet z obrona; czarna lista: ${FarmBlacklist.count()}.`, "warn");
      return banned;
    },
    // Zbior z OTWARTEJ strony wiadomosci — dziala niezaleznie od endpointu.
    harvestDom() {
      if (!/^\/messages/.test(location.pathname)) return;
      const text = (document.body.innerText || "").replace(/\s+/g, " ");
      if (!/Combat report:/i.test(text)) return;
      this._apply(this.parse(text), "strona wiadomosci");
    },
    async run() {
      const last = parseInt(GM_getValue(this.KEY_AT, "0")) || 0;
      if (Date.now() - last < this.EVERY_MS) return;
      GM_setValue(this.KEY_AT, String(Date.now()));
      const known = GM_getValue(this.KEY_URL, "");
      for (const url of (known ? [known] : this.CANDIDATES)) {
        try {
          const res = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          if (!res.ok) continue;
          const html = await res.text();
          if (res.redirected || /login|password/i.test(html.substring(0, 500))) continue;
          const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
          if (!/Combat report:/i.test(text)) continue;
          if (!known) { GM_setValue(this.KEY_URL, url); log(`[FARM BAN] endpoint raportow bojowych potwierdzony: ${url}`, "info"); }
          this._apply(this.parse(text), "raporty (fetch)");
          return;
        } catch {}
      }
      if (!known && GM_getValue("ogamex_combat_probe_logged", "") !== "1") {
        GM_setValue("ogamex_combat_probe_logged", "1");
        log("[FARM BAN] zaden kandydat endpointu raportow nie odpowiedzial — bany zbieram ze strony wiadomosci (wejdz czasem na Combat reports).", "warn");
      }
    },
  };
  // ── FARM-BAN-END ──

  // ═══════════════════════════════════════════════════════════════
  //  PRIORYTET LUPU (v2.97.0) — najtlustsze cele pierwsze
  // ═══════════════════════════════════════════════════════════════
  // Zrodlo prawdy: Dziennik Grabiezy (profil gracza) — dokladny lup per
  // atak per koordy. Rozrzut na zywo 15.08: Abutre [4:372:3] 5,1 bln vs
  // Ratatosk [4:378:x] ~240 mld — 20x roznicy przy tym samym koszcie
  // slotu i limitu atakow/dobe. EMA (alfa 0,5) zamiast ostatniej probki,
  // bo lup rosnie z czasem od poprzedniego farmniecia.
  // ── FARM-YIELD-START ──
  const FarmYieldDB = {
    KEY: "ogamex_farm_yield",
    KEY_SEEN: "ogamex_farm_yield_seen",
    TTL_MS: 30 * 24 * 60 * 60 * 1000,
    load() { try { return JSON.parse(GM_getValue(this.KEY, "{}")) || {}; } catch { return {}; } },
    save(d) { GM_setValue(this.KEY, JSON.stringify(d)); },
    avg(coord) {
      const e = this.load()[coord];
      if (!e || Date.now() - (e.at || 0) > this.TTL_MS) return null;
      return e.p;
    },
    update(coord, profit, player) {
      if (!Number.isFinite(profit) || profit < 0) return;
      const d = this.load();
      const e = d[coord];
      d[coord] = {
        p: e ? Math.round(e.p * 0.5 + profit * 0.5) : profit,
        n: (e?.n || 0) + 1,
        at: Date.now(),
        player: player || e?.player || "?",
      };
      const cut = Date.now() - this.TTL_MS;
      for (const c of Object.keys(d)) if ((d[c].at || 0) < cut) delete d[c];
      this.save(d);
    },
    // Mediana znanych srednich — wynik eksploracyjny dla celow bez historii
    // (nieznany moze byc zlotem, wiec nie laduje na koncu kolejki).
    median() {
      const vals = Object.values(this.load()).filter(e => Date.now() - (e.at || 0) <= this.TTL_MS).map(e => e.p).sort((a, b) => a - b);
      if (!vals.length) return null;
      return vals[Math.floor(vals.length / 2)];
    },
    // Suma znanych lupow per system "g:s" — kolejnosc okrazenia po bazie.
    systemSums() {
      const out = {};
      const d = this.load();
      const cut = Date.now() - this.TTL_MS;
      for (const c of Object.keys(d)) {
        if ((d[c].at || 0) < cut) continue;
        const key = c.split(":").slice(0, 2).join(":");
        out[key] = (out[key] || 0) + d[c].p;
      }
      return out;
    },
    top(n) {
      return Object.entries(this.load())
        .map(([coord, e]) => ({ coord, ...e }))
        .filter(e => Date.now() - (e.at || 0) <= this.TTL_MS)
        .sort((a, b) => b.p - a.p)
        .slice(0, n);
    },
    // v2.97.3: nauka PACZKA zamiast per-wpis. Dwa bledy z zywego seedowania
    // (19:06, trzy razy "638 wpisow" z ta sama baza): (1) cap listy seen 600
    // byl MNIEJSZY niz jeden widok dziennika (638 wierszy) - kazdy dodany
    // wpis wypychal z konca dokladnie ten, ktory za chwile sprawdzalismy;
    // kaskada = dedup martwy, wszystko uczone od nowa co 15 s; (2) kazdy
    // wpis robil load+save CALEJ bazy i listy seen (638x na tick).
    learnBatch(rows) {
      let seen; try { seen = JSON.parse(GM_getValue(this.KEY_SEEN, "[]")) || []; } catch { seen = []; }
      const seenSet = new Set(seen);
      const d = this.load();
      let learned = 0;
      for (const r of rows) {
        if (r.profit == null || !Number.isFinite(r.profit) || r.profit < 0) continue;
        const key = `${r.coord}|${r.when}`;
        if (seenSet.has(key)) continue;
        seenSet.add(key);
        seen.unshift(key);
        const e = d[r.coord];
        d[r.coord] = {
          p: e ? Math.round(e.p * 0.5 + r.profit * 0.5) : r.profit,
          n: (e?.n || 0) + 1,
          at: Date.now(),
          player: r.player || e?.player || "?",
        };
        learned++;
      }
      if (learned) {
        const cut = Date.now() - this.TTL_MS;
        for (const c of Object.keys(d)) if ((d[c].at || 0) < cut) delete d[c];
        this.save(d);
        // cap 4000 >> najwiekszy widok dziennika; FIFO wystarcza, bo stare
        // dni nie wracaja do widoku po zejsciu z profilu.
        GM_setValue(this.KEY_SEEN, JSON.stringify(seen.slice(0, 4000)));
      }
      return learned;
    },
  };

  // Czyta Dziennik Grabiezy: fetch partialu (kandydat — bracia
  // Partial_AsteroidJournal i Partial_ExpeditionJournal potwierdzeni na
  // zywo) + zbior z OTWARTEJ strony profilu (dziala na pewno: parsuje
  // czysty tekst wierszy "data | gracz (i) | [g:s:p] | +lup").
  const PlunderWatch = {
    KEY_AT: "ogamex_plunder_watch_at",
    EVERY_MS: 15 * 60 * 1000,
    CANDIDATES: ["/home/Partial_PlunderJournal"],
    _num(s) { const n = parseInt(String(s).replace(/[^0-9]/g, ""), 10); return Number.isFinite(n) ? n : null; },
    parse(text) {
      const out = [];
      // Kwota jako GRUPY TYSIECY (1-3 cyfry + bloki sep+3cyfry) — chciwa
      // klasa [0-9.,\s]* polykala spacje i DATE nastepnego wiersza
      // ("...031 15.08.2026 18" -> 5,1e22; zlapane testem przed wdrozeniem).
      const re = /(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2})[\s\u00A0]+([^\[\]()]{2,32}?)\s*\(\s*[a-zA-Z]\s*\)\s*\[(\d+):(\d+):(\d+)\][\s\u00A0]*\+[\s\u00A0]*([0-9]{1,3}(?:[.,\s\u00A0][0-9]{3})*)/g;
      let m;
      while ((m = re.exec(text))) {
        out.push({ when: m[1], player: m[2].trim(), coord: `${m[3]}:${m[4]}:${m[5]}`, profit: this._num(m[6]) });
      }
      return out;
    },
    _apply(rows, label) {
      const learned = FarmYieldDB.learnBatch(rows);
      if (learned) log(`[FARM LUP] ${label}: nauczyl(em) sie ${learned} wpisu(-ow) lupu (baza: ${Object.keys(FarmYieldDB.load()).length} celow).`, "info");
      return learned;
    },
    harvestDom() {
      const text = (document.body?.textContent || "");
      if (!/Plunder Journal/i.test(text)) return;
      this._apply(this.parse(text.replace(/\s+/g, " ")), "strona profilu");
    },
    async run() {
      const last = parseInt(GM_getValue(this.KEY_AT, "0")) || 0;
      if (Date.now() - last < this.EVERY_MS) return;
      GM_setValue(this.KEY_AT, String(Date.now()));
      for (const url of this.CANDIDATES) {
        try {
          const res = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          if (!res.ok) continue;
          const html = await res.text();
          if (res.redirected || /login|password/i.test(html.substring(0, 500))) continue;
          const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
          const rows = this.parse(text);
          if (!rows.length) {
            // rytual zrzutu: bez markupu nie piszemy parsera na slepo
            const dumpKey = "ogamex_plunder_dump2";
            if (GM_getValue(dumpKey, "") !== "1") {
              GM_setValue(dumpKey, "1");
              log(`[FARM LUP] ${url} -> ${html.length} zn., 0 wierszy — zrzut: ${text.slice(0, 700)}`, "warn");
            }
            continue;
          }
          this._apply(rows, "dziennik (fetch)");
          return;
        } catch {}
      }
    },
  };
  // ── FARM-YIELD-END ──


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
    // v2.81.0: zwolnij wszystkie cele przed nowym okrazeniem.
    clear() {
      const n = this.count();
      GM_setValue(this.KEY, "[]");
      return n;
    },

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

    // v2.90.0: czy farm ma teraz ustąpić miningowi (żywe GM-fakty → czysty
    // predykat farmYieldsToMining; używane w run(), hooku on-load i statusie).
    yieldsToMining() {
      return farmYieldsToMining({
        miningEnabled: !!CONFIG.asteroidMining.enabled,
        now: Date.now(),
        fleetReturnAt: parseInt(GM_getValue("ogamex_fleet_return_at", "0")) || 0,
        dispatchFailAt: parseInt(GM_getValue("ogamex_dispatch_fail_at", "0")) || 0,
        scanCooldownUntil: parseInt(GM_getValue("ogamex_scan_cooldown_until", "0")) || 0,
      });
    },

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
      // v2.90.0: mining ma pierwszeństwo — farm działa tylko w jego martwych
      // oknach (minery w locie / cooldowny). Stan farmy zostaje nietknięty,
      // więc przerwane okrążenie samo wznawia się w następnym oknie.
      if (this.yieldsToMining()) {
        if (!this._pausedLogged) {
          this._pausedLogged = true;
          log("Farm ustępuje: Asteroid Mining pracuje (priorytet) — wrócę, gdy minery będą w locie.", "delay");
        }
        return;
      }
      if (this._pausedLogged) {
        this._pausedLogged = false;
        if (CONFIG.asteroidMining.enabled) log("Farm wraca: mining czeka na powrót minerów — okno dla farmienia.", "info");
      }
      if (AntiDetection.isSleepTime()) return;
      if (Humanizer.isOnBreak()) return; // v2.12.0: also covers init on-load hooks
      // v2.15.0: attacking someone else while a fleet is inbound on US is the
      // worst possible use of a fleet slot.
      // v2.79.0: bramka obejmuje całe okno obrony (alarm + straż + lot
      // ratunku/powrotu), nie samą chwilę, gdy obce floty są na pasku.
      if (!DefenceHold.allows("farmienie")) return;
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
        // v2.96.0: przed kazda decyzja dociagnij swieze raporty bojowe
        // (self-throttle 10 min) — bany musza wyprzedzic wysylke.
        await CombatWatch.run().catch(() => {});
        await PlunderWatch.run().catch(() => {}); // v2.97.0: lupy przed decyzja
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
        // ── v2.89.0: okrążenie po bazie celów zamiast pełnego skanu ──
        // Pełny skan zakresów (np. 998 systemów gal. 3+4 ≈ godziny) odświeża
        // bazę celów co dbRefreshHours. MIĘDZY pełnymi skanami bot krąży
        // wyłącznie po systemach, w których baza zna cel przechodzący filtr
        // rankingu — okrążenie trwa minuty, więc tłuste cele dostają ataki
        // wielokrotnie częściej, a puste systemy nie kosztują ani nawigacji,
        // ani czasu. Statusy i ranking odświeżają się przy każdej wizycie
        // (scanStep nadpisuje wpisy systemu), więc baza nie gnije.
        const maxRank = cfg.maxTargetRank || 0;
        const lastFull = parseInt(GM_getValue("ogamex_farm_last_full_sweep", "0")) || 0;
        const refreshMs = Math.max(1, cfg.dbRefreshHours || 12) * 3600000;
        let queue = null, mode = "full";
        const dbFresh = Date.now() - lastFull < refreshMs;
        // v2.90.1: start po przerwie (np. następnego dnia) NIE zaczyna od
        // pełnego skanu, jeśli baza zna cele — najpierw JEDNO okrążenie po
        // znanych systemach (natychmiastowy łup z wczorajszej wiedzy), pełny
        // skan odświeżający bazę idzie zaraz po nim. Flaga pilnuje, żeby
        // zaległe okrążenie nie odsuwało pełnego skanu w nieskończoność.
        const staleLapDone = GM_getValue("ogamex_farm_stale_lap_done", "0") === "1";
        // v2.98.0: tryb sekwencyjny pomija okrążenia po bazie — każdy przebieg
        // to pełne przemiatanie zakresów układ po układzie.
        if (cfg.sequentialSweep !== true && (dbFresh || !staleLapDone)) {
          const sys = FarmTargetDB.eligibleSystems(maxRank, ranges);
          if (sys.length) {
            queue = sys; mode = "lap";
            if (!dbFresh) {
              GM_setValue("ogamex_farm_stale_lap_done", "1");
              log("Farm: pełny skan zaległy, ale baza zna cele — najpierw okrążenie po nich, pełny skan zaraz po.", "info");
            }
          }
          // pusta baza w obrębie zakresów → od razu pełny skan
        }
        if (!queue) {
          queue = [];
          ranges.forEach(r => { for (let s = r.start; s <= r.end; s++) queue.push({ galaxy: r.galaxy, system: s }); });
        }
        // ── v2.81.0: nowe okrazenie zaczyna od czystej karty ──
        // Wlasciciel: „najlepiej jakby wracal do zaatakowanych wczesniej celow,
        // jak skonczy wszystkich atakowac w zaznaczonym zakresie". Kolejka i tak
        // odwiedza kazdy system dokladnie RAZ na przebieg, wiec zwolnienie
        // blokad tutaj nie grozi podwojnym uderzeniem w tym samym okrazeniu —
        // daje tylko to, o co chodzi: kolejne okrazenie bierze wszystkich od nowa.
        // Naturalnym ogranicznikiem tempa zostaje dlugosc przemiatania plus
        // 15-minutowa przerwa miedzy przebiegami.
        if (cfg.repeatEachSweep !== false) {
          const freed = FarmedTargets.clear();
          if (freed) log(`Farm: nowe okrazenie — zwolniono ${freed} cel(ow) z poprzedniego przebiegu (atakuje ponownie).`, "info");
        }
        st = { active: true, mode, queue, scannedCount: 0, totalCount: queue.length, targets: [], skippedRank: 0, unknownRank: 0 };
        FarmState.save(st);
        if (mode === "lap") {
          const nextFullMin = Math.max(0, Math.ceil((lastFull + refreshMs - Date.now()) / 60000));
          log(`Farm: okrążenie PO BAZIE — ${queue.length} system(ów) ze znanymi celami${maxRank ? ` (rank ≤ ${maxRank})` : ""}; pełny skan zakresów za ~${nextFullMin} min.`, "success");
        } else {
          log(`Farm sweep started (pełny skan): ${queue.length} systems (${cfg.ranges})${maxRank ? ` | filtr: rank ≤ ${maxRank}` : ""}`, "success");
        }
        await AntiDetection.shortDelay();
        scanNavigate(`/galaxy?x=${queue[0].galaxy}&y=${queue[0].system}`, "farm start");
      } finally {
        this.running = false;
      }
    },

    finishSweep(st) {
      // v2.89.0: pełny skan stempluje się dopiero PO dojściu do końca —
      // przerwany w połowie nie udaje świeżej bazy i następne podejście
      // znowu będzie pełne.
      if (st?.mode !== "lap") {
        GM_setValue("ogamex_farm_last_full_sweep", String(Date.now()));
        GM_setValue("ogamex_farm_stale_lap_done", "0"); // v2.90.1: świeży pełny skan kasuje dług zaległego okrążenia
      }
      const cfg = CONFIG.inactiveFarming;
      const dbStats = FarmTargetDB.stats(cfg.maxTargetRank || 0);
      const kind = st?.mode === "lap" ? "okrążenie po bazie" : "pełny skan";
      log(`Farm sweep done (${kind}): ${st?.scannedCount ?? "?"} systems checked. Baza celów: ${dbStats.total} nieaktywnych, ${dbStats.eligible} w limicie${cfg.maxTargetRank ? ` (rank ≤ ${cfg.maxTargetRank})` : ""}${st?.skippedRank ? `, pominięto ${st.skippedRank} pow. limitu` : ""}. Next sweep in ${this.SWEEP_COOLDOWN_MIN}min.`, "info");
      if (st?.unknownRank) log(`Farm: ${st.unknownRank} cel(ów) BEZ odczytanego rankingu — filtr ich nie ogranicza (atakowane jak dotąd). Wklej [FARM RANK DOM] z dziennika do analizy parsera.`, "warn");
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
      const scan = this.collectTargets(cur.galaxy, cur.system);
      const found = scan.targets;
      st.queue.shift();
      st.scannedCount++;
      st.targets = (st.targets || []).concat(found);
      st.skippedRank = (st.skippedRank || 0) + scan.skippedRank;
      st.unknownRank = (st.unknownRank || 0) + scan.unknownRank;
      FarmState.save(st);
      if (found.length) log(`Farm: ${found.length} inactive target(s) at [${cur.galaxy}:${cur.system}]: ${found.map(t => t.coord + (t.rank ? ` (rank ${t.rank})` : "")).join(", ")}`, "success");
      if (scan.skippedRank) log(`Farm: [${cur.galaxy}:${cur.system}] ${scan.skippedRank} nieaktywny(ch) POMINIĘTO — ranking powyżej ${CONFIG.inactiveFarming.maxTargetRank} (puste kolonie nie zjadają slotów).`, "info");
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
          scanNavigate("/", "farm wander");
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
    // v2.89.0: zwraca { targets, skippedRank, unknownRank } — targets to
    // wiersze przechodzące filtr rankingu i nie będące na cooldownie; baza
    // celów dostaje KOMPLET nieaktywnych tego systemu (nadpisanie systemu).
    collectTargets(galaxy, system) {
      const cfg = CONFIG.inactiveFarming;
      const maxRank = cfg.maxTargetRank || 0;
      const out = [];
      const dbEntries = [];
      let skippedRank = 0, unknownRank = 0, bannedSkip = 0;
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
        // Ranking: tooltip bywa tekstem w wierszu ALBO atrybutem — czytamy oba.
        const attrText = [item, ...item.querySelectorAll("[data-tooltip-content],[title],[data-title]")]
          .map(el => `${el.getAttribute?.("data-tooltip-content") || ""} ${el.getAttribute?.("title") || ""} ${el.getAttribute?.("data-title") || ""}`)
          .join(" ").replace(/<[^>]*>/g, " ");
        const rank = farmParseRank(text) ?? farmParseRank(attrText);
        // Nazwa gracza (do podglądu bazy): tekst tuż przed statusem (i)/(I).
        const nameM = text.match(/([^()]{2,32}?)\s*\(\s*[iI]\s*\)/);
        const name = nameM ? nameM[1].trim().slice(0, 24) : "?";
        dbEntries.push({ coord, name, rank });
        if (maxRank > 0 && rank == null) {
          unknownRank++;
          // Jednorazowy zrzut wiersza bez odczytanego rankingu — do
          // utwardzenia parsera na markup TEGO forka.
          if (GM_getValue("ogamex_farm_rank_dumped", "0") !== "1") {
            GM_setValue("ogamex_farm_rank_dumped", "1");
            log(`[FARM RANK DOM] wiersz bez rankingu: ${item.innerHTML.replace(/\s+/g, " ").substring(0, 600)}`, "warn");
          }
        }
        if (!farmRankEligible(rank, maxRank)) { skippedRank++; return; }
        if (FarmBlacklist.has(coord)) { bannedSkip++; return; } // v2.96.0: obrona = nie wracamy
        if (FarmedTargets.has(coord)) return;
        // One-time DOM dump of the first matched row — verifies the status
        // parsing against this OGameX build's real markup.
        if (GM_getValue("ogamex_farm_row_dumped", "0") !== "1") {
          GM_setValue("ogamex_farm_row_dumped", "1");
          log(`[FARM DOM] first target row: ${item.innerHTML.replace(/\s+/g, " ").substring(0, 400)}`, "info");
        }
        out.push({ coord, galaxy, system, position: pos, rank });
      });
      // Świeży skan systemu = nowa prawda o jego wpisach w bazie (planety,
      // które przestały być nieaktywne, właśnie z niej wypadły).
      FarmTargetDB.updateSystem(galaxy, system, dbEntries);
      if (bannedSkip) log(`Farm: [${galaxy}:${system}] ${bannedSkip} cel(e) na czarnej liscie (obrona) — pomijam.`, "info");
      return { targets: out, skippedRank, unknownRank };
    },

    async dispatchNext(st) {
      if (this.slotsFree() <= 0) {
        log(`Farm: fleet slots exhausted (reserve ${CONFIG.inactiveFarming.slotReserve}) — waiting for returns; ${st.targets?.length ?? 0} target(s) queued.`, "warn");
        return; // scheduler retries; targets persist in FarmState
      }
      let targets = (st.targets || []).filter(t => !FarmedTargets.has(t.coord) && !FarmBlacklist.has(t.coord));
      // v2.97.0: najtlustsze cele pierwsze. Znany sredni lup sortuje malejaco,
      // nieznany dostaje MEDIANE znanych (eksploracja w srodku kolejki, nie na
      // koncu); prog minTargetProfit wycina ZNANA drobnice (nieznanych nigdy).
      const floor = CONFIG.inactiveFarming.minTargetProfit || 0;
      if (floor > 0) {
        const before = targets.length;
        targets = targets.filter(x => { const a = FarmYieldDB.avg(x.coord); return a == null || a >= floor; });
        if (before - targets.length) log(`Farm: ${before - targets.length} cel(e) ponizej progu lupu (${floor.toLocaleString("pl-PL")}) — pomijam.`, "info");
      }
      // v2.98.0: w trybie sekwencyjnym cele idą w kolejności napotkania
      // (układ po układzie) — bez sortowania po łupie.
      if (CONFIG.inactiveFarming.sequentialSweep !== true) {
        const med = FarmYieldDB.median();
        if (med != null) targets.sort((a, b) => (FarmYieldDB.avg(b.coord) ?? med) - (FarmYieldDB.avg(a.coord) ?? med));
      }
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
      const ship = CONFIG.inactiveFarming.shipType || "HEAVY_CARGO";
      const fleetUrl = `/fleet?x=${t.galaxy}&y=${t.system}&z=${t.position}&planet=1&mission=8`;
      log(`FARM ATTACK → [${t.coord}] with ${hc} ${ship}`, "success");
      // v2.74.8: bez wpisanych koordów farm startuje z aktualnie aktywnego
      // ciała (właściciel przenosi flotę bliżej celów eventu).
      // v2.91.0: pole „Start farmienia" w panelu wygrywa — misja niesie
      // launchAt i brama v2.84 przełącza parę/ciało przed formularzem, więc
      // można farmić inną galaktykę bez przenoszenia floty.
      const farmBase = HomeBase.farm();
      GM_setValue("pending_mission", JSON.stringify({
        type: "inactive_farm_direct",
        farm: true,
        ...(farmBase ? { launchAt: farmBase } : {}),
        fleetUrl,
        shipType: ship,
        quantity: hc,
        step: "select_ships_direct",
        resumeScan: false,
        timestamp: Date.now(),
      }));
      // v2.90.2: celowo BEZ RateLimiter.record() — ten sam wzorzec co
      // ekspedycje. Pula 20/h ma jednego konsumenta bramki: skaner asteroid
      // (canAct() przed startem skanu). Incydent 14.08 11:00-11:21: 76 ataków
      // farmy zapchało pulę, mining stał („Rate limit reached”) z wolną
      // asteroidą na talerzu, a farm mu „ustępował” — klincz na 20+ minut.
      // Tempo farmy ograniczają: humanizer (maxAttacksPerDay, shortDelay),
      // rytm galaktyka→formularz→galaktyka i wspólny NavRateLimiter.
      await AntiDetection.shortDelay();
      window.location.replace(fleetUrl);
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
        const targets = (st.targets || []).filter(t => !FarmedTargets.has(t.coord) && !FarmBlacklist.has(t.coord));
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
  // ═══════════════════════════════════════════════════════════════
  //  MOON FERRY (v2.71.0) — prom planeta → księżyc (tryb księżycowy)
  // ═══════════════════════════════════════════════════════════════
  // W trybie księżycowym flota MIESZKA na księżycu, ale planeta stale coś
  // gromadzi: produkcję stoczni, deuter i surowce z kopalń — a czasem całą
  // flotę po nietypowym epizodzie (05.08 16:24: powrót po zepsutym flipie
  // odstawił wszystko na planetę i nic nie miało podstawy tego naprawić).
  // Prom co 2 h przewozi WSZYSTKO z planety na księżyc misją Deploy — tą
  // samą maszynerią co ratunek. Pusta planeta = cichy koniec („nothing to
  // save"). Ustępuje wszystkiemu: alarmowi, straży, trwającej wysyłce,
  // przerwom i oknu nocnemu.
  // ═══════════════════════════════════════════════════════════════
  //  HOME BASE (v2.82.0) — start z AKTUALNEGO ciała, nie ze sztywnej bazy
  // ═══════════════════════════════════════════════════════════════
  // Decyzja właściciela 12.08: agresywni sąsiedzi wymuszają zmianę miejsca
  // startu — mining, ekspedycje, złom i prom mają lecieć z planety/księżyca
  // AKTYWNEGO w pasku planet, a nie z zapisanej na sztywno bazy [3:272:7].
  // Formularz floty i tak wysyła z ciała aktywnego (potwierdzone na żywo
  // przy FS v2.75.0 i ratunku v2.55.0) — dotąd bot dokręcał start do bazy;
  // teraz podąża za operatorem: przełączenie planety w grze = nowy punkt
  // startu, bez żadnej konfiguracji.
  //   • coords() — koordy aktywnego ciała; na stronie bez paska planet
  //     ostatni znany odczyt (cache GM), w ostateczności minerBase.
  //   • pairMoon() — księżyc AKTUALNEGO układu (wiersz księżyca renderuje
  //     się zaraz po swojej planecie; STOP na następnej planecie, żeby
  //     bezksiężycowa kolonia nie „pożyczyła" cudzego księżyca).
  // Obrona (ratunek/straż/FS) ma własną logikę celów — nietknięta.
  const HomeBase = {
    KEY: "ogamex_home_body",

    _parseCoords(el) {
      const m = (el?.textContent || "").replace(/\s+/g, " ").match(/(\d+):(\d+):(\d+)/);
      return m ? { galaxy: +m[1], system: +m[2], position: +m[3] } : null;
    },

    _selectedEntry() {
      // Księżyc przed planetą: gdy zaznaczony jest księżyc, oba wpisy pary
      // potrafią nosić klasę selected — wygrywa ciało, z którego realnie
      // wychodzi formularz.
      return document.querySelector(
        "a.moon-select.selected, .moon-select.selected, a.planet-select.selected, .planet-select.selected"
      );
    },

    // Żywy odczyt z paska planet; null, gdy paska nie ma na tej stronie.
    read() {
      const el = this._selectedEntry();
      if (!el) return null;
      const isMoon = el.classList.contains("moon-select");
      let c = this._parseCoords(el);
      if (!c && isMoon) {
        // Wpis księżyca często nie niesie koordów — bierze je z planety,
        // po której następuje (ta sama adjacencja co switch_to_body).
        let p = el.previousElementSibling;
        while (p && !(p.classList && p.classList.contains("planet-select"))) p = p.previousElementSibling;
        c = this._parseCoords(p);
      }
      if (!c) return null;
      const rec = { ...c, body: isMoon ? "moon" : "planet" };
      let prev = null;
      try { prev = JSON.parse(GM_getValue(this.KEY, "null")); } catch {}
      const changed = !prev || prev.galaxy !== rec.galaxy || prev.system !== rec.system
        || prev.position !== rec.position || prev.body !== rec.body;
      if (changed) {
        GM_setValue(this.KEY, JSON.stringify(rec));
        log(`[START] aktywne ciało: ${rec.body === "moon" ? "księżyc" : "planeta"} [${rec.galaxy}:${rec.system}:${rec.position}] — stąd polecą mining/ekspedycje/złom.`, "info");
      }
      return rec;
    },

    // Koordy punktu startu rutynowych wysyłek. Nigdy nie zwraca null przy
    // ustawionym minerBase — stare ścieżki mogą na tym polegać.
    coords() {
      const live = this.read();
      if (live) return live;
      try {
        const c = JSON.parse(GM_getValue(this.KEY, "null"));
        if (c && Number.isFinite(c.galaxy) && Number.isFinite(c.system)) return c;
      } catch {}
      const b = CONFIG.asteroidMining.minerBase;
      return b ? { ...b, body: null } : null;
    },

    // Księżyc pary danego wpisu planety (adjacencja ze STOPEM na następnej
    // planecie — bezksiężycowa para nie może „pożyczyć" cudzego księżyca).
    moonOf(planetEl) {
      let n = planetEl ? planetEl.nextElementSibling : null;
      while (n && !(n.classList && n.classList.contains("moon-select"))) {
        if (n.classList && n.classList.contains("planet-select")) return null;
        n = n.nextElementSibling;
      }
      return n || null;
    },

    // Księżyc aktualnego układu (element paska planet) albo null, gdy go nie
    // ma / nie widać. Gdy zaznaczony JEST księżyc — zwraca ten wpis.
    pairMoon() {
      const el = this._selectedEntry();
      if (!el) return null;
      if (el.classList.contains("moon-select")) return el;
      return this.moonOf(el);
    },

    // ── v2.84.0: punkt startu PER MODUŁ ──
    // Wpisane w panelu koordy wygrywają z ciałem aktywnym; ciało startu
    // wynika z trybu (baseBody moon → księżyc tej pary). null/brak = jak
    // dotąd: startuj stamtąd, gdzie stoi operator.
    forModule(cfgCoords) {
      const c = cfgCoords;
      if (c && Number.isFinite(c.galaxy) && Number.isFinite(c.system) && Number.isFinite(c.position)) {
        return { galaxy: c.galaxy, system: c.system, position: c.position, body: CONFIG.baseBody === "moon" ? "moon" : "planet", fixed: true };
      }
      return this.coords();
    },
    mining() { return this.forModule(CONFIG.asteroidMining.launchFrom); },
    // v2.91.0: farm — wpisane koordy wygrywają; puste = null (misja nie
    // niesie launchAt i atak startuje z aktywnego ciała, jak od v2.74.8).
    farm() { const c = CONFIG.inactiveFarming?.launchFrom; return c ? this.forModule(c) : null; },
    // expeditions.base (stare, tylko-cel) zostaje w łańcuchu jako fallback.
    expo() { return this.forModule(CONFIG.expeditions.launchFrom || CONFIG.expeditions.base); },

    // Wpis planety o danych koordach na pasku planet (koordy siedzą w tekście
    // kotwicy — potwierdzone na żywo przez FleetRecon.activePlanet).
    // v2.104.7: czy para o tych koordach MA księżyc (wg paska planet).
    // true/false, albo null gdy pary nie widać na pasku (nie wiemy).
    pairHasMoon(c) {
      const a = this.pairAnchor(c);
      if (!a) return null;
      return !!this.moonOf(a);
    },
    pairAnchor(c) {
      if (!c) return null;
      for (const p of document.querySelectorAll("a.planet-select, .planet-select")) {
        const m = (p.textContent || "").replace(/\s+/g, " ").match(/(\d+):(\d+):(\d+)/);
        if (m && +m[1] === c.galaxy && +m[2] === c.system && +m[3] === c.position) return p;
      }
      return null;
    },
  };

  const MoonFerry = {
    KEY_AT: "ogamex_ferry_at",
    EVERY_MS: 2 * 60 * 60 * 1000,

    due() {
      // v2.83.0: prom tylko na wyraźne życzenie operatora (domyślnie OFF).
      if (!CONFIG.moonFerry?.enabled) return false;
      if (CONFIG.baseBody !== "moon" || !CONFIG.enabled) return false;
      if (ThreatMonitor.active() || MoonSave.watch().armed) return false;
      const p = GM_getValue("pending_mission", null);
      if (p && p !== "null") return false;
      if (Humanizer.isOnBreak() || AntiDetection.isSleepTime()) return false;
      return Date.now() - (parseInt(GM_getValue(this.KEY_AT, "0")) || 0) > this.EVERY_MS;
    },

    async run() {
      if (!this.due()) return false;
      // v2.82.0: prom obsługuje AKTUALNY układ (planeta → jej księżyc),
      // nie sztywną bazę — inaczej co 2 h wyrywałby operatora z wybranego
      // przez niego miejsca startu. Bez paska planet nie wiemy, gdzie
      // jesteśmy — bez stempla, spróbujemy na stronie, która pasek ma.
      const b = HomeBase.read();
      if (!b) return false;
      if (!HomeBase.pairMoon()) {
        // Kolonia bez księżyca: nie ma dokąd wozić. Stempel normalny, żeby
        // nie próbować co tick — wróci za 2 h albo po zmianie układu.
        GM_setValue(this.KEY_AT, String(Date.now()));
        log("[PROM] aktualny układ nie ma księżyca — prom pominięty do zmiany miejsca startu.", "info");
        return false;
      }
      GM_setValue(this.KEY_AT, String(Date.now()));
      GM_setValue("pending_mission", JSON.stringify({
        type: "moon_ferry_direct",
        moonSave: true,       // ta sama obsługa formularza co ratunek
        ferry: true,          // …ale własne wpisy w logu/dzienniku
        sweep: true,          // NIGDY nie flipuj na drugie ciało (v2.70.3)
        atCoords: b,
        launchBody: "planet",
        targetBody: "moon",
        homeBody: "moon",
        fleetUrl: `/fleet?x=${b.galaxy}&y=${b.system}&z=${b.position}`,
        step: "switch_to_body",
        timestamp: Date.now(),
      }));
      log("[PROM] planeta → księżyc: przewożę wszystko, co stoi na planecie (produkcja, surowce, zabłąkana flota). Pusta planeta = nic się nie stanie.", "info");
      return true;
    },
  };

  // ═══ v2.105.0: ODBUDOWA KSIĘŻYCA ═══
  // Fork athena ma stronę /home/moonformation (Overview → ikona „Create a
  // Moon around this planet"): pole Diameter, koszt w metalu, przycisk
  // „Form a moon". Incydent 26.08 18:26: 3× Destroy zniszczyło księżyc bazy
  // [5:125:4]. Bot: (1) po wykryciu utraty (MoonSave.returnHome → pairHasMoon
  // === false) planuje odbudowę, (2) przełącza aktywne ciało na planetę pary,
  // (3) wchodzi na moonformation, ustawia średnicę (schodzi w dół, aż koszt
  // zmieści się w metalu), klika „Form a moon", (4) weryfikuje na pasku planet.
  // Ręcznie: przycisk „Utwórz księżyc (tu)" w Szybkich akcjach — dla AKTYWNEJ
  // planety. Selektory formularza NIE są potwierdzone na żywo (lekcja 02.08):
  // pierwsze wejście zrzuca markup panelu Options do logu.
  const MoonRebuild = {
    KEY_TRY: "ogamex_moonform_try",   // { key: { n, at } }
    MAX_TRIES_24H: 3,
    DIAMETERS: [8944, 8000, 7000, 6000, 5000, 4000, 3000, 2000, 1000],

    key(c) { return c && Number.isFinite(c.galaxy) ? `${c.galaxy}:${c.system}:${c.position}` : null; },
    tries() { try { return JSON.parse(GM_getValue(this.KEY_TRY, "{}")) || {}; } catch { return {}; } },
    noteTry(k) { const t = this.tries(); const e = t[k] || { n: 0, at: 0 }; if (Date.now() - e.at > 24 * 3600 * 1000) e.n = 0; e.n += 1; e.at = Date.now(); t[k] = e; GM_setValue(this.KEY_TRY, JSON.stringify(t)); return e.n; },
    canTry(k) { const e = this.tries()[k]; if (!e) return true; if (Date.now() - e.at > 24 * 3600 * 1000) return true; return e.n < this.MAX_TRIES_24H && Date.now() - e.at > 10 * 60 * 1000; },

    // Zaplanuj odbudowę pary (wołane z returnHome po wykryciu utraty księżyca
    // i ze schedulera przy znaczniku ogamex_moon_lost_<k>).
    schedule(c, reason) {
      const k = this.key(c);
      if (!k) return false;
      if (CONFIG.moonRebuild?.enabled === false) { log(`[KSIĘŻYC] odbudowa wyłączona w konfiguracji — [${k}] zostaje bez księżyca.`, "warn"); return false; }
      if (GM_getValue("pending_mission", null)) return false;
      if (!this.canTry(k)) { return false; }
      if (ThreatMonitor.active && ThreatMonitor.active()) { return false; }   // najpierw alarm
      const n = this.noteTry(k);
      GM_setValue("pending_mission", JSON.stringify({ type: "moon_form", step: "switch_planet", atCoords: { galaxy: c.galaxy, system: c.system, position: c.position }, diameterKm: CONFIG.moonRebuild?.diameterKm || 8944, timestamp: Date.now(), moonSave: false, reason }));
      log(`[KSIĘŻYC] odbudowa [${k}] — próba ${n}/${this.MAX_TRIES_24H} (${reason}). Przełączam na planetę i wchodzę na Moon Creation.`, "warn");
      ThreatLog.add("KSIĘŻYC", `Odbudowa księżyca [${k}] — próba ${n} (${reason}).`);
      return true;
    },

    // Tick: KAŻDA planeta z paska bez księżyca = kandydat (życzenie operatora
    // 26.08: „bot musi wiedzieć, gdzie nie ma moona, żeby go stworzyć").
    // Kolejność: zniszczony księżyc bazy (znacznik utraty) → reszta po pasku.
    // Jedna odbudowa na tick; kolejne po weryfikacji poprzedniej.
    maybeStart() {
      try {
        if (!CONFIG.enabled || CONFIG.moonRebuild?.enabled === false) return;
        if (GM_getValue("pending_mission", null)) return;
        const all = this.planetsWithoutMoon();
        if (!all.length) return;
        const lost = all.filter(c => !!GM_getValue("ogamex_moon_lost_" + this.key(c), ""));
        const list = CONFIG.moonRebuild?.allPlanets === false ? lost : [...lost, ...all.filter(c => !lost.includes(c))];
        for (const c of list) {
          if (this.schedule(c, lost.includes(c) ? "znacznik utraty księżyca" : "planeta bez księżyca")) return;
        }
      } catch (e) { log(`[KSIĘŻYC] błąd planowania odbudowy: ${e.message}`, "warn"); }
    },
    // Pasek planet: wpisy planet, po których NIE następuje moon-select tej pary.
    planetsWithoutMoon() {
      const out = [];
      for (const p of document.querySelectorAll("a.planet-select, .planet-select")) {
        if (HomeBase.moonOf(p)) continue;
        const m = (p.textContent || "").replace(/\s+/g, " ").match(/(\d+):(\d+):(\d+)/);
        if (m) out.push({ galaxy: +m[1], system: +m[2], position: +m[3] });
      }
      return out;
    },

    readMetal() {
      try {
        const el = document.querySelector(".resource-item-metal");
        const m = el && (el.textContent || "").match(/\d[\d.,\s ']*/);
        const n = m ? parseInt(m[0].replace(/[^\d]/g, ""), 10) : NaN;
        return Number.isFinite(n) ? n : null;
      } catch { return null; }
    },
    // Panel Options na stronie moonformation: pole średnicy + koszt + przycisk.
    formEls() {
      const inputs = [...document.querySelectorAll("input")].filter(i => i.offsetParent !== null && !i.closest("#ogx-bot-panel") && /number|text/i.test(i.type || "text"));
      const byName = inputs.find(i => /diam/i.test(`${i.id} ${i.name} ${i.className}`));
      const input = byName || inputs.find(i => /^\s*[\d.,]+\s*$/.test(i.value || ""));
      const btn = [...document.querySelectorAll("a, button, input[type='submit']")].find(el => el.offsetParent !== null && !el.closest("#ogx-bot-panel") && /form\s*a\s*moon|utw[oó]rz\s*ksi/i.test(el.value || el.textContent || ""));
      return { input, btn };
    },
    readRequirement() {
      // liczba przy „Requirements" (koszt metalu) — pierwszy blok cyfr po nagłówku
      const t = (document.body.textContent || "");
      const i = t.search(/Requirements|Wymagania/i);
      if (i < 0) return null;
      const m = t.slice(i, i + 400).match(/\d{1,3}(?:[.,\s]\d{3})+|\d{4,}/);
      return m ? parseInt(m[0].replace(/[^\d]/g, ""), 10) : null;
    },
    async setDiameter(input, km) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      input.focus();
      if (setter) setter.call(input, String(km)); else input.value = String(km);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      input.blur();
      await AntiDetection.sleep(900 + Math.random() * 500);
    },
  };

  // ═══ v2.106.0: RATUNEK BRAMĄ SKOKOWĄ (/building/jumpgate) ═══
  // Strona bramy (zrzuty 26.08 18:49): „Destination moon” (select z „Moon
  // [g:s:p]”), sekcja „Ships” z polem na typ + pomarańczowy „»” (max) przy
  // każdym i zbiorczy „»” pod listą, sekcja „Resources” z 3 polami i „»”,
  // „Cargo space X / Y”, zielony przycisk „Jump”. Selektory dobierane
  // heurystycznie (nagłówki + kolejność) — przy niepowodzeniu zrzut DOM do
  // logu i AUTOMATYCZNY powrót do zwykłego ratunku Deployem.
  const GateSave = {
    KEY: "ogamex_gate_state",    // { at, to, jumpedAt, homeKey }
    // v2.109.1 (27.08, pytanie operatora „co gdy atak na [2:151:9] po skoku?"): po skoku
    // mapa hangarów NIE znała nowego miejsca floty (weryfikowany był pusty hangar źródła),
    // więc ślepy alarm z paska broniłby złej kolonii. Po udanym skoku bot odwiedza /fleet
    // na księżycu docelowym — FleetRecon.scan() zapisuje hangar + ciało. Ważne 10 min.
    KEY_RECON: "ogamex_post_jump_recon",
    reconAfterJump() {
      let f = null; try { f = JSON.parse(GM_getValue(this.KEY_RECON, "null")); } catch {}
      if (!f || !f.key) return false;
      if (Date.now() - (f.at || 0) > 10 * 60 * 1000) { GM_setValue(this.KEY_RECON, "null"); return false; }
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") return false;
      if (ThreatMonitor.active()) { /* w alarmie nie chodzimy po koloniach — obrona ma pierwszeństwo */ return false; }
      const active = MoonSave.activeCoords();
      if (active !== f.key || MoonSave.currentBody() !== "moon") {
        const a = MoonSave.planetAnchor(f.key);
        const m = a ? HomeBase.moonOf(a) : null;
        if (!m) { GM_setValue(this.KEY_RECON, "null"); log(`[BRAMA] rekonesans po skoku: nie widzę księżyca [${f.key}] na pasku — pomijam.`, "warn"); return false; }
        log(`[BRAMA] rekonesans po skoku: przełączam na księżyc [${f.key}], żeby mapa hangarów znała nowe miejsce floty.`, "info");
        m.click();
        return true;
      }
      if (GameState.getCurrentPage() !== "fleet") { window.location.replace("/fleet"); return true; }
      GM_setValue(this.KEY_RECON, "null");
      try { FleetRecon.scan(); } catch {}
      log(`[BRAMA] rekonesans po skoku: hangar księżyca [${f.key}] zapisany w mapie hangarów.`, "info");
      return false;
    },
    key(c) { return c && Number.isFinite(c.galaxy) ? `${c.galaxy}:${c.system}:${c.position}` : null; },
    parseKey(k) { const m = String(k || "").match(/^(\d+):(\d+):(\d+)$/); return m ? { galaxy: +m[1], system: +m[2], position: +m[3] } : null; },
    state() { try { return JSON.parse(GM_getValue(this.KEY, "null")) || null; } catch { return null; } },
    save(st) { GM_setValue(this.KEY, st ? JSON.stringify(st) : "null"); },
    enabled() { return CONFIG.jumpGate?.enabled !== false; },

    // Czy warto próbować bramy: flota na KSIĘŻYCU tej pary, para ma księżyc,
    // atak nie jest „oba ciała" (wtedy i tak w powietrze… ale brama też ratuje —
    // skok na inny księżyc jest lepszy niż lot), brak świeżej porażki bramy.
    canTry(at) {
      if (!this.enabled()) return false;
      const k = this.key(at);
      if (!k) return false;
      const failAt = parseInt(GM_getValue("ogamex_gate_fail_" + k, "0")) || 0;
      if (Date.now() - failAt < 10 * 60 * 1000) return false;
      // v2.107.5: znany cooldown bramy (z parsera „cooling down" albo 30 min po
      // własnym skoku) → nie tracimy 10-15 s na stronę bramy, od razu Deploy.
      const readyAt = parseInt(GM_getValue("ogamex_gate_ready_at_" + k, "0")) || 0;
      if (readyAt && Date.now() < readyAt) return false;
      if (HomeBase.pairHasMoon(at) === false) return false;
      return true;
    },

    // Start misji skoku: przełącz na księżyc pary → /building/jumpgate → formularz.
    start(at, reason, { fallbackDeploy = true } = {}) {
      const k = this.key(at);
      GM_setValue("pending_mission", JSON.stringify({
        type: "gate_jump", moonSave: true, gate: true,
        atCoords: at, launchBody: "moon", homeBody: "moon",
        fleetUrl: "/building/jumpgate",
        step: "switch_to_body", timestamp: Date.now(), reason, fallbackDeploy,
      }));
      log(`[BRAMA] RATUNEK BRAMĄ: księżyc [${k}] → inny księżyc (${reason}). Przełączam na księżyc i otwieram bramę.`, "success");
      ThreatLog.add("RATUNEK", `Brama skokowa: start z [${k}] (${reason}).`);
      return true;
    },

    // ── Formularz bramy ──
    sectionOf(title) {
      const els = [...document.querySelectorAll("h1,h2,h3,h4,div,span,legend,th")].filter(e => !e.closest("#ogx-bot-panel") && (e.textContent || "").trim().toLowerCase() === title.toLowerCase());
      const h = els[0];
      if (!h) return null;
      // najbliższy przodek, który zawiera jakieś inputy
      let n = h.parentElement;
      while (n && n !== document.body && !n.querySelector("input, select, button")) n = n.parentElement;
      return n && n !== document.body ? n : null;
    },
    maxButtons(root) {
      return [...root.querySelectorAll("a, button, img, span, div")].filter(el => {
        if (el.closest("#ogx-bot-panel") || el.offsetParent === null) return false;
        const txt = (el.textContent || "").trim();
        const cls = `${el.className || ""} ${el.id || ""} ${el.getAttribute("title") || ""} ${el.getAttribute("src") || ""}`.toLowerCase();
        // v2.107.8 (zrzut 27.08 09:50): obok „»" stoi czerwony przycisk „0" (czyść) —
        // kliknięty jako ostatni wyzerowałby statki. Wykluczamy zerowanie/czyszczenie.
        if (/^0$/.test(txt) || /clear|reset|zero|empty|none/.test(cls)) return false;
        return /^(»|>>|⟫|max|all)$/i.test(txt) || /max|all|arrow|select-?all|fill/.test(cls);
      });
    },
    shipInputs(root) { return [...root.querySelectorAll("input")].filter(i => i.offsetParent !== null && /number|text/i.test(i.type || "text")); },
    inputSum(inputs) { return inputs.reduce((a, i) => a + (parseInt(String(i.value || "0").replace(/[^\d]/g, ""), 10) || 0), 0); },
    destSelect() { return [...document.querySelectorAll("select")].find(sel => !sel.closest("#ogx-bot-panel") && [...sel.options].some(o => /\d+:\d+:\d+/.test(o.textContent || ""))) || null; },
    jumpButton() { return [...document.querySelectorAll("a, button, input[type='submit'], input[type='button']")].find(el => !el.closest("#ogx-bot-panel") && el.offsetParent !== null && /^\s*(jump|skok|skocz)\s*$/i.test(el.value || el.textContent || "")) || null; },
    pickDestination(sel, at, attackedKeys) {
      const opts = [...sel.options].map(o => ({ o, c: this.parseKey(((o.textContent || "").match(/(\d+):(\d+):(\d+)/) || []).slice(1).join(":")) })).filter(x => x.c);
      const here = this.key(at);
      const want = CONFIG.jumpGate?.targetMoon;
      const wantK = want ? this.key(want) : null;
      let ok = opts.filter(x => this.key(x.c) !== here && !attackedKeys.includes(this.key(x.c)));
      // v2.107.0 (audyt 2, Z2): schrony = JEDYNE cele skoku; brak dostępnego
      // schronu → null (ratunek Deployem), nigdy skok na hub.
      const havens = (CONFIG.jumpGate?.havens || []).map(h => this.key(h)).filter(Boolean);
      if (havens.length) {
        ok = ok.filter(x => havens.includes(this.key(x.c)));
        if (!ok.length) log(`[BRAMA] żaden schron (${havens.join(", ")}) nie jest dostępny na liście bramy (brak/atakowany) — nie skaczę na hub, ratunek Deployem.`, "warn");
      }
      return ok.find(x => wantK && this.key(x.c) === wantK) || ok[0] || null;
    },
    async fireChange(el) { el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); await AntiDetection.sleep(500 + Math.random() * 400); },

    // Porażka bramy → zwykły ratunek (Deploy) od razu.
    async fallback(mission, why) {
      const k = this.key(mission.atCoords);
      // v2.107.2: POWRÓT bramą po alarmie nie jest ratunkiem — brama w cooldownie
      // (30-40 min po skoku) to stan oczekiwany: info bez pusha, ponowienie co 5 min.
      if (mission.gateReturn) {
        GM_setValue("pending_mission", null);
        log(`[BRAMA] powrót nie poszedł (${why}) — najpewniej cooldown bramy; ponowię za 5 min. Flota bezpieczna na [${k}].`, "info");
        return;
      }
      log(`[BRAMA] nie skoczę (${why}) — przechodzę na zwykły ratunek Deployem.`, "error");
      ThreatLog.add("BŁĄD", `Brama [${k}]: ${why} — ratunek Deployem.`);
      GM_setValue("ogamex_gate_fail_" + k, String(Date.now()));
      GM_setValue("pending_mission", null);
      if (mission.fallbackDeploy) {
        try { await MoonSave.run({ auto: true, reason: `brama nieudana: ${why}`, where: mission.atCoords, noGate: true }); } catch (e) { log(`[BRAMA] fallback nie ruszył: ${e.message}`, "error"); }
      }
    },

    // Powrót bramą po alarmie: z księżyca-refugium na księżyc domowy.
    async returnHome(w, { byOperator = false } = {}) {
      const st = this.state();
      if (!st || !st.to) return false;
      // v2.108.2 (27.08 10:20–10:26): flota wróciła do domu ręcznie, a straż „refugium=brama"
      // co 5 min przełączała ciało na [2:151:8] i próbowała powrotu. Brama WYŁĄCZONA
      // albo hangar domu NIEPUSTY wg mapy hangarów (<15 min) → straż schodzi, stan bramy czyszczony.
      try {
        let homeHas = null;
        try { const e = (JSON.parse(GM_getValue(FleetRecon.KEY_HANGARS, "{}")) || {})[st.homeKey]; if (e && Date.now() - (e.at || 0) < 15 * 60 * 1000) homeHas = e.total || 0; } catch {}
        // v2.108.3: brama OFF dotyczy RATUNKÓW; POWRÓT do domu bramą (flota już na schronie)
        // jest dozwolony — inaczej flota zostałaby na schronie na stałe.
        if (homeHas !== null && homeHas > 0) {
          log(`[BRAMA] powrót bramą odwołany (flota już w domu [${st.homeKey}] wg hangaru) — straż schodzi, stan bramy czyszczony.`, "info");
          GM_setValue(this.KEY, "null");
          try { MoonSave.disarm("powrót bramą odwołany — brama wyłączona / flota w domu"); } catch {}
          return false;
        }
      } catch {}
      const home = this.parseKey(st.homeKey), refuge = this.parseKey(st.to);
      if (!home || !refuge) return false;
      if (GM_getValue("pending_mission", null) && GM_getValue("pending_mission", null) !== "null") return false;
      const lastTry = parseInt(GM_getValue("ogamex_gate_return_try", "0")) || 0;
      if (!byOperator && Date.now() - lastTry < 5 * 60 * 1000) return false;   // cooldown bramy — próbuj co 5 min
      GM_setValue("ogamex_gate_return_try", String(Date.now()));
      GM_setValue("pending_mission", JSON.stringify({
        type: "gate_jump", moonSave: true, gate: true, gateReturn: true,
        atCoords: refuge, forceTarget: home, launchBody: "moon", homeBody: "moon",
        fleetUrl: "/building/jumpgate", step: "switch_to_body", timestamp: Date.now(),
        reason: byOperator ? "powrót bramą (operator)" : "powrót bramą po alarmie", fallbackDeploy: false,
      }));
      log(`[BRAMA] POWRÓT: księżyc [${st.to}] → księżyc [${st.homeKey}] bramą (jeśli brama ma cooldown, ponowię za 5 min).`, "info");
      return true;
    },
  };

  const DebrisCollector = {
    KEY_AT: "ogamex_debris_check_at",
    KEY_SENT: "ogamex_debris_sent_at",
    KEY_DUMPED: "ogamex_debris_markup_dumped_v248",
    CHECK_EVERY_MS: 20 * 60 * 1000,   // co tyle zaglądamy na galaktykę bazy
    RESEND_GUARD_MS: 10 * 60 * 1000,  // po wysyłce nie próbuj drugi raz

    // v2.82.0: „galaktyka bazy" = układ AKTUALNEGO ciała — ekspedycje lecą
    // teraz na poz. 16 bieżącego systemu, więc i złom po nich leży tam.
    // (Złom w POPRZEDNIM miejscu startu zbierz ręcznie albo wróć tam ciałem.)
    base() { return HomeBase.expo(); },

    // Wiersz pozycji 16 na ŻYWEJ stronie galaktyki. Zwraca link zbierania.
    findDebrisLink() {
      // v2.70.0: oprócz poz. 16 (złom po ekspedycjach) sprawdzamy też POZYCJĘ
      // BAZY — po bitwie obronnej złom leży przy samej planecie (05.08 rano:
      // 4,3 bld surowców na [3:269:8], a zbieracz patrzył tylko na 16).
      const b = this.base();
      const wanted = [16, b?.position].filter(n => Number.isFinite(n));
      for (const item of document.querySelectorAll(".galaxy-item")) {
        const idx = parseInt(item.querySelector(".planet-index")?.textContent || "0") || 0;
        if (!wanted.includes(idx)) continue;
        const cell = item.querySelector(".col-debris, .galaxy-col.col-debris");
        // (było: return null przy pustej komórce poz. 16 — ucinało sprawdzenie
        // pozycji bazy; teraz idziemy dalej po liście)
        if (!cell || !(cell.innerHTML || "").trim()) continue;
        if (GM_getValue(this.KEY_DUMPED, "") !== "1") {
          GM_setValue(this.KEY_DUMPED, "1");
          log(`[ZŁOM] markup pola złomu (poz. ${idx}): ${(cell.innerHTML || "").replace(/\s+/g, " ").slice(0, 600)}`, "info");
        }
        const a = cell.querySelector("a[href*='/fleet']");
        if (a) return a.getAttribute("href");
        // v2.99.3: tooltip „Debris field → Recycle" bywa renderowany POZA
        // komórką (kontener wskazany przez rel/id `debris{g}_{s}_{p}`).
        const rel = cell.querySelector("[rel^='debris']")?.getAttribute("rel");
        const tip = (rel && document.getElementById(rel)) || document.getElementById(`debris${b.galaxy}_${b.system}_${idx}`);
        const ta = tip?.querySelector("a[href*='/fleet']");
        if (ta) return ta.getAttribute("href");
        // Bez żadnego linku, ale komórka NIE jest pusta = złom jest. Nie
        // zgadujemy misji w URL-u: krok 2 sam klika data-planet-type=3, krok 3
        // sam klika „Collect" (albo NIE wysyła) — wystarczą koordy.
        log(`[ZŁOM] poz. ${idx}: złom widoczny, ale bez linku zbierania — jadę na formularz po samych koordach.`, "warn");
        return `/fleet?x=${b.galaxy}&y=${b.system}&z=${idx}`;
      }
      return null;
    },

    // Ile recyklerów jest w hangarze (strona floty / ostatni zwiad).
    recyclersHome() {
      for (const el of document.querySelectorAll("[data-ship-type='RECYCLER']")) {
        const n = parseInt(el.dataset.shipQuantity || "0") || 0;
        if (n > 0) return n;
      }
      // v2.99.3: brak zwiadu = NIE WIEMY (null), a nie „zero". Zero z
      // niewiedzy blokowało wizytę na 16 w nieskończoność.
      try {
        const recon = JSON.parse(GM_getValue("ogamex_fleet_recon", "null"));
        if (!recon?.ships) return null;
        // v2.99.4: ships to TABLICA [{type, qty}], nie mapa — `ships.RECYCLER`
        // było zawsze undefined → 0 → „zero recyklerów" mimo 7,9 mld w hangarze.
        const list = Array.isArray(recon.ships) ? recon.ships : Object.entries(recon.ships).map(([type, qty]) => ({ type, qty }));
        const r = list.find(x => String(x.type).toUpperCase() === "RECYCLER");
        return parseInt(r?.qty || "0") || 0;
      } catch { return null; }
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
      // v2.68.1: pusty hangar (recyklery na księżycu po ratunku/FS) palił
      // 10-minutową blokadę ponowienia bez żadnej wysyłki.
      if (this.recyclersHome() === 0) {
        log("[ZŁOM] pole złomu jest, ale w hangarze zero recyklerów — spróbuję, gdy wrócą.", "warn");
        return false;
      }
      GM_setValue(this.KEY_SENT, String(Date.now()));
      GM_setValue("pending_mission", JSON.stringify({
        type: "debris_recycle_direct",
        recycle: true,               // NIE jest lotem górniczym
        fleetUrl: href,
        shipType: "RECYCLER",
        quantity: 0,                 // 0 = wszystkie recyklery w hangarze
        launchAt: this.base(),       // v2.84.0: recyklery mieszkają przy flocie ekspedycyjnej
        step: "select_ships_direct",
        resumeScan: true,
        timestamp: Date.now(),
      }));
      log(`[ZŁOM] pole złomu na [${b.galaxy}:${b.system}:16] — wysyłam recyklery (${href}).`, "success");
      setTimeout(() => { window.location.replace(href); }, 800 + Math.random() * 700);
      return true;
    },

    // Okresowa wizyta na galaktyce bazy. Tylko gdy bot i tak nic nie robi.
    // ── v2.68.1: złom leżał na 16 godzinami ──
    // Wizyta odpalała się tylko, gdy minery były W LOCIE (albo raz na 2 h) —
    // a przy pustych skanach minery siedzą w domu i warunek nie zachodził
    // nigdy. Teraz rytm jest prosty: co 20 minut, gdy bot nie ma nic
    // pilniejszego; trwający skan asteroid przeżywa złom najwyżej 2 godziny.
    shouldVisit() {
      if (!CONFIG.expeditions?.collectDebris) return false;
      if (GM_getValue("pending_mission", null)) return false;
      if (ThreatMonitor.active()) return false;
      if (Humanizer.isOnBreak() || AntiDetection.isSleepTime()) return false;
      if (this.recyclersHome() === 0) return false; // bez recyklerów wizyta nic nie da (null = nie wiemy → jedziemy)
      const last = parseInt(GM_getValue(this.KEY_AT, "0")) || 0;
      if (Date.now() - last < this.CHECK_EVERY_MS) return false;
      const scanActive = !!ScanState.load()?.active;
      return !scanActive || Date.now() - last > 2 * 60 * 60 * 1000;
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
    // v2.75.5: +ACS/FEDERATION/GROUP/HOLD — atak GRUPOWY („Players: 1/2" na
    // liście zdarzeń) przeszedł 07.08 08:2x NIEWYKRYTY: 92,8 mld statków
    // w księżyc bazy, a klasyfikacja widziała tylko sondę („ataki 0, sondy 1")
    // i skasowała kandydata. FEDERATION/HOLD siedziały na liście SAFE z
    // nazewnictwa upstreamu — obca misja tych typów na NASZE ciało to atak
    // ACS albo wrogie stacjonowanie, nigdy nic bezpiecznego.
    ATTACK: /(ATTACK|MISSILE|DESTRUCT|DESTROY|BOMBARD|INVAS|FEDERATION|GROUP|ACS|HOLD)/i,
    SPY: /(ESPIONAGE|SPY|PROBE|SCAN)/i,
    // v2.66.0: typy, które fizycznie nie mogą uderzyć (transport nie atakuje,
    // stacjonowanie nie celuje w obcych, powrót leci do siebie). Obca misja
    // spoza WSZYSTKICH trzech list to typ, którego nie znamy — traktujemy jak
    // ATAK, bo przegapiony atak kosztuje flotę, a fałszywy alarm dwa przeloty.
    // v2.75.3: +COLLECT — typ zbierania złomu TEGO forka (przycisk „Collect"
    // w formularzu floty). Bez niego własny lot po złom przy chwilowo pustym
    // ownBodies() klasyfikował się jako "typ spoza znanych list" = atak.
    SAFE: /(TRANSPORT|DEPLOY|STATION|RETURN|EXPEDITION|COLONI|HARVEST|RECYCL|ASTEROID|COLLECT)/i,

    // ── v2.77.0: klasyfikacja POJEDYNCZEGO wiersza jako osobna metoda ──
    // Wyjęta z pętli bez zmiany ani jednego warunku — po to, żeby AUTOTEST
    // (DefenceSelfTest) mógł ją wywołać na syntetycznym markupie, w tym
    // samym DOM i tym samym kodzie, który obsługuje prawdziwy atak.
    // Test, który sprawdza kopię logiki zamiast oryginału, jest wart tyle,
    // co brak testu — dlatego oryginał jest jeden i wołają go oba miejsca.
    classifyRow(tr, own) {
        const type = (String(tr.className).match(/row-mission-type-([A-Z_]+)/i) || [])[1] || "?";
        const srcEl = tr.querySelector(".fleet-source-coords");
        const coords = [...(tr.textContent || "").matchAll(/\[(\d+:\d+:\d+)\]/g)].map(m => m[1]);
        // v2.111.0 (zrzut 27.08 10:16:55): wiersz ACS Attack ma ZAMIAST koordów źródła
        // „Players: 1/2" — w wierszu jest TYLKO cel „Moon [2:151:8]". Dotąd jedyna
        // współrzędna szła jako ŹRÓDŁO, cel = null → wiersz odrzucony → atak na
        // [2:151:8] widziany był tylko jako goły licznik paska. Reguła: brak
        // .fleet-source-coords i jedna współrzędna = to jest CEL (gra zawsze pokazuje cel).
        const srcExplicit = (String(srcEl?.textContent || "").match(/(\d+:\d+:\d+)/) || [])[1] || null;
        const src = srcExplicit || (coords.length >= 2 ? coords[0] : null);
        const dst = (!srcExplicit && coords.length === 1) ? coords[0] : (coords.filter(c => c !== src).pop() || null);
        const eta = parseInt(tr.querySelector("[data-remaining-seconds]")?.getAttribute("data-remaining-seconds") || "0") || 0;
        // Skład floty siedzi w tooltipie („Light Cargo : 330.000.000").
        const tip = tr.querySelector("[data-tooltip-content*='Ships']")?.getAttribute("data-tooltip-content") || "";
        const ships = [...tip.matchAll(/>([A-Za-z ]+?)\s*:\s*<\/td>\s*<td[^>]*>([\d.\s]+)</g)]
          .map(m => `${m[1].trim()} ${m[2].trim()}`);
        const isSpy = this.SPY.test(type);
        // v2.75.5: PIERWSZE słowo ma sama gra — wiersz wrogiej misji nosi
        // klasę `row-hostile-mission` (zrzuty [ATAK DOM] z 05-06.08). To
        // odporne na KAŻDĄ nazwę typu (ACS, przyszłe misje forka): wrogi
        // wiersz nie-sonda = atak, niezależnie od tego, jak się nazywa.
        // Wiersze bez tej klasy klasyfikujemy po staremu (nazwa typu).
        const hostileCls = /row-hostile-mission/i.test(String(tr.className));
        // ── v2.86.2: misja SOJUSZNIKA nie jest atakiem ──
        // Gra znakuje misje przyjaciół klasą row-friendly-mission (pasek:
        // „N Friendly"). Incydent 12.08 12:32 NA ŻYWO: kolega wysłał
        // Stacjonuj (HOLD, 10 sond) na nasz księżyc — HOLD jest na liście
        // ATTACK po wrogim ACS z 07.08, więc sojusznicza wizyta odpaliła
        // godzinny fałszywy alarm i odbijanie floty planeta↔księżyc co 90 s.
        // Klasa gry wygrywa z nazwą typu — symetrycznie do row-hostile.
        // (Misja friendly mechanicznie nie może nas uderzyć: ACS defend/
        // stacjonowanie sojusznika broni razem z nami.)
        const friendlyCls = /row-friendly-mission/i.test(String(tr.className));
        const isAttack = friendlyCls ? false
          : hostileCls ? !isSpy
          : (this.ATTACK.test(type) || (!isSpy && !this.SAFE.test(type)));
        // ── v2.70.0: ciało i nazwa przy KOŃCACH trasy ──
        // Zrzuty [ATAK DOM] z 05.08 pokazały, że wiersz niesie ikonę
        // (moon-icon) i nazwę ciała obok koordynatów obu końców. Ciało CELU
        // pozwala uciekać deterministycznie na przeciwne ciało zamiast
        // zgadywać z heurystyki „aktywne ciało"; nazwa źródła to wywiad.
        const tdOf = (coordStr) => {
          if (!coordStr) return null;
          const a = [...tr.querySelectorAll("a")].find(x => (x.textContent || "").includes(`[${coordStr}]`));
          return a ? a.closest("td") : null;
        };
        const bodyOf = (td) => {
          if (!td) return null;
          return (td.querySelector("img[src*='moon-icon']") || /\bMoon\b/i.test(td.textContent || "")) ? "moon" : "planet";
        };
        const srcTd = (srcEl && srcEl.closest("td")) || tdOf(src);
        const dstTd = tdOf(dst);
        const srcName = srcTd ? ((srcTd.textContent || "").replace(`[${src}]`, "").replace(/\s+/g, " ").trim() || null) : null;
        return {
          srcBody: bodyOf(srcTd),
          srcName,
          dstBody: bodyOf(dstTd),
          id: tr.getAttribute("data-fleet-id") || "",
          type, src, dst, eta,
          mine: !!(src && own.size && own.has(src)),
          friendly: friendlyCls, // v2.86.2: sojusznik — poza licznikami zagrożeń
          attack: isAttack,
          unknownType: isAttack && !this.ATTACK.test(type),
          spy: isSpy && !friendlyCls,
          ships,
          // v2.67.1: surowy HTML wiersza — materiał dowodowy na pierwszy atak.
          // Bez niego zły odczyt wrogiego wiersza byłby nie do zdiagnozowania
          // (stare one-shot zrzuty zużyły się na NASZYCH flotach).
          html: (tr.outerHTML || "").replace(/\s+/g, " ").slice(0, 1800),
        };    },

    // Zwraca { ok, rows } — ok=false znaczy „nie wiem", a nie „bezpiecznie".
    async fetch() {
      if (!Ajax.supported(this.URL)) return { ok: false, rows: [] };
      let html = "";
      try {
        const res = await fetchT(this.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
        if (!res.ok) { Ajax.markUnsupported(this.URL, res.status); return { ok: false, rows: [] }; }
        html = await res.text();
        // v2.102.0 (I-A5): strona logowania z kodem 200 = sesja padła, nie „pusto".
        if (SessionWatch.looksLoggedOut(res, html)) { SessionWatch.lost(); return { ok: false, rows: [], loggedOut: true }; }
        SessionWatch.ok();
        Ajax.markWorking(this.URL); // v2.61.0: sprawdzony adres nie umrze od jednej czkawki 404
      } catch { return { ok: false, rows: [] }; }
      if (!html) return { ok: false, rows: [] };
      const doc = new DOMParser().parseFromString(html, "text/html");
      const trs = [...doc.querySelectorAll("tr[class*='row-mission-type-']")];
      if (!trs.length) return { ok: false, rows: [] };
      // v2.57.1: jednorazowy zrzut KOŃCA wiersza — tam siedzą przyciski akcji,
      // w tym zawracanie floty, bez którego nie da się zrobić Fleet Save.
      if (GM_getValue("ogamex_fml_tail_dumped", "") !== "1") {
        GM_setValue("ogamex_fml_tail_dumped", "1");
        const html = (trs[0].innerHTML || "").replace(/\s+/g, " ");
        log(`[RUCHY FLOT] koniec 1. wiersza (szukam zawracania): ${html.slice(-1200)}`, "error");
      }
      const own = ThreatMonitor.ownBodies();
      const rows = [];
      for (const tr of trs) rows.push(this.classifyRow(tr, own));
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

    // v2.75.2: koordy aktywnego ciała z WIERSZA listy planet — ta sama metoda
    // co MoonSave.activeCoords (jedyna potwierdzona na tym forku; recon
    // pokazywał "planet ?", bo tekst wpisu to sama nazwa, koordy stoją w
    // wierszu obok). getCurrentPlanet zostaje jako drugi odczyt.
    originCoords() {
      const sel = document.querySelector("a.planet-select.selected, a.moon-select.selected, .planet-select.selected, .moon-select.selected");
      const row = sel?.closest("li, div, tr") || sel?.parentElement;
      const m = String(row?.textContent || "").match(/(\d+):(\d+):(\d+)/);
      if (m) return { galaxy: +m[1], system: +m[2], position: +m[3] };
      return GameState.getCurrentPlanet();
    },

    // Zmierzony czas lotu dla tej trasy i prędkości (klucz uwzględnia oba).
    routeKey() {
      const c = this.cfg();
      // v2.75.0: FS startuje z AKTUALNEGO księżyca (decyzja właściciela 06.08,
      // event idle-farming: flota wędruje między układami) — czas lotu jest
      // kluczowany po faktycznej pozycji, nie po dawnej bazie, więc po
      // teleporcie plan wymusza świeży pomiar zamiast liczyć zawrócenie po
      // czasie ze starej trasy. c.from zostaje tylko jako fallback na
      // stronach bez paska planet.
      const o = this.originCoords() || c.from;
      return `${o?.galaxy}:${o?.system}:${o?.position}→${c.to?.galaxy}:${c.to?.system}:${c.to?.position}@${c.speedPercent}`;
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

    // ── v2.60.0: godzina powrotu jako "HH:MM" = NAJBLIŻSZE takie wskazanie ──
    // Właściciel ustawia raz "09:00" i FS powtarza się co dobę: po zakończonym
    // cyklu następne "09:00" znów jest w przyszłości, więc planer sam liczy
    // kolejny wieczór. ISO (pełna data) nadal działa jako jednorazówka.
    returnAtMs(now = Date.now()) {
      const c = this.cfg();
      const raw = String(c.returnAt || "");
      const hm = raw.match(/^(\d{1,2}):(\d{2})$/);
      if (hm) {
        const d = new Date(now);
        d.setHours(parseInt(hm[1]), parseInt(hm[2]), 0, 0);
        if (d.getTime() <= now) d.setDate(d.getDate() + 1);
        return d.getTime();
      }
      const t = Date.parse(raw);
      return Number.isFinite(t) ? t : NaN;
    },

    // Margines: zawrócenie musi wypaść wyraźnie PRZED dolotem (delay ≤ T − margines),
    // bo po dolocie flota stacjonuje i zawracać nie ma czego.
    LAUNCH_MARGIN_MS: 3 * 60 * 1000,
    MEASURE_COOLDOWN_MS: 15 * 60 * 1000, // pomiar (wejście w formularz bez wysyłki) max co tyle
    RECALL_RETRY_MS: 60 * 1000,
    RECALL_MAX_TRIES: 3,

    // Zwraca plan albo powód, dla którego go nie ma.
    // ignoreEnabled: potwierdzenie przy WŁĄCZANIU liczy plan, zanim flaga
    // stanie się prawdą (v2.68.3).
    plan(now = Date.now(), { ignoreEnabled = false } = {}) {
      const c = this.cfg();
      if (!c.enabled && !ignoreEnabled) return { ok: false, why: "FS wyłączony" };
      const at = this.returnAtMs(now);
      if (!Number.isFinite(at)) return { ok: false, why: "nie ustawiono godziny powrotu" };
      if (at <= now) return { ok: false, why: "godzina powrotu już minęła" };
      const T = this.flightMs();
      if (!T) return { ok: false, why: "nie znam czasu lotu tej trasy — kliknij „Zmierz trasę (bez wysyłki)”", measure: true };
      const window = at - now;
      const maxMs = 2 * T - 2 * this.LAUNCH_MARGIN_MS;
      if (window > maxMs) {
        // ── v2.74.3: NIE czekamy na „opłacalne" okno — decyzja właściciela
        // 05.08: „FS ma być wysyłany natychmiast, flota na księżycu = cel".
        // Za długie okno = lecimy ŁAŃCUCHEM pełnych rund: start OD RAZU,
        // zawrócenie po pełnym locie (T − margines), powrót po 2T; po nim
        // planer wystawi kolejną rundę, aż ostatnia zmieści się w oknie
        // i wróci o zadanej godzinie. Flota jest w powietrzu cały czas.
        return { ok: true, launchAt: now, recallAt: now + Math.floor(maxMs / 2),
                 returnAt: now + maxMs, delayMs: Math.floor(maxMs / 2), flightMs: T, chained: true };
      }
      // Ostatnia (albo jedyna) runda: zawrócenie w połowie okna = powrót o zadanej godzinie.
      const delay = Math.floor(window / 2);        // ≤ T − margines, bo window ≤ 2T − 2·margines
      return { ok: true, launchAt: now, recallAt: now + delay, returnAt: at, delayMs: delay, flightMs: T };
    },

    describe() {
      const st = this.state();
      const f = (ms) => new Date(ms).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
      if (st?.phase === "launched") return `FS: flota W DRODZE, zawrócenie ${f(st.recallAt)}, powrót ${f(st.returnAt)}`;
      if (st?.phase === "recalled") return `FS: ZAWRÓCONA, powrót ~${f(st.returnAt)}`;
      if (st?.phase === "recall_failed") return `FS: ZAWRACANIE NIEUDANE — flota doleci na cel i tam zostanie. Sprawdź log.`;
      const p = this.plan();
      if (!p.ok) return `FS: ${p.why}`;
      return `FS: start ${f(p.launchAt)} → zawrócenie ${f(p.recallAt)} → powrót ${f(p.returnAt)}`;
    },

    // ═══ v2.60.0: WYSYŁKA — maszyna stanów ═══
    // idle → (okno pasuje) launched → (recallAt) recalled → (po returnAt) idle.
    // Wołane z pętli obrony (co 30 s, odporna na przerwy/jitter/okno nocne —
    // zawrócenie o 4:00 rano MUSI zadziałać, więc nie może wisieć na schedulerze,
    // który śpi w oknie nocnym).
    running: false,

    async tick() {
      const st = this.state() || {};
      if (st.phase === "launched") {
        if (Date.now() >= (st.recallAt || 0)) { await this.attemptRecall(st); return; }
        // ── v2.69.3: wykryj RĘCZNE zawrócenie przed czasem ──
        // 05.08: właściciel zawrócił poranny (omyłkowy) FS minutę po starcie,
        // a maszyna o 13:01 i tak poszła zawracać nieistniejący lot — trzy
        // "ZAWRACANIE NIEUDANE" i straszny komunikat o niczym. Co 5 min tani
        // fetch listy: brak naszego lotu PRZED czasem dolotu = zawrócony
        // (ręcznie albo przerwany) → cykl zamyka się cicho i od razu.
        if (Date.now() - (st.lastRowCheck || 0) > 5 * 60 * 1000) {
          this.save({ ...st, lastRowCheck: Date.now() });
          try {
            const res = await fetchT(FleetMovements.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
            if (res.ok) {
              const doc = new DOMParser().parseFromString(await res.text(), "text/html");
              const eta = (st.sentAt || 0) + (st.flightMs || 0);
              if (!this._findOurRow(doc, st) && st.flightMs && Date.now() < eta - 60000) {
                this.save({ ...st, phase: "recalled", recalledAt: Date.now() });
                log("[FS] lotu nie ma na liście przed czasem dolotu — został zawrócony (najpewniej ręcznie). Zamykam cykl bez alarmów.", "info");
                try { updateStatusUI(); } catch {}
              }
            }
          } catch {}
        }
        return;
      }
      if (st.phase === "recalled" || st.phase === "recall_failed") {
        // Cykl domknięty 10 min po planowym powrocie; przy "HH:MM" następny
        // wieczór planer sam wystawi kolejny start.
        if (Date.now() > (st.returnAt || 0) + 10 * 60 * 1000) {
          this.save(null);
          log(`[FS] cykl zamknięty (${st.phase === "recalled" ? "flota wróciła" : "flota została na celu — ściągnij ręcznie"}).`, st.phase === "recalled" ? "success" : "warn");
        }
        return;
      }
      // faza idle — czy pora startować?
      const c = this.cfg();
      if (!CONFIG.enabled || !c.enabled || this.running) return;
      // v2.106.1 — 19:07–19:12: FS zmierzony, plan OK, a start nie ruszał i log
      // milczał. Każdy powód czekania idzie do logu (dławiony do 1× na 5 min).
      const waitWhy = (why) => {
        const at = parseInt(GM_getValue("ogamex_fs_wait_said", "0")) || 0;
        const last = GM_getValue("ogamex_fs_wait_why", "");
        if (why !== last || Date.now() - at > 5 * 60 * 1000) {
          GM_setValue("ogamex_fs_wait_said", String(Date.now())); GM_setValue("ogamex_fs_wait_why", why);
          log(`[FS] czekam ze startem: ${why}.`, "warn");
        }
      };
      // Alarm ma bezwzględne pierwszeństwo: gdy MoonSave ewakuuje/pilnuje bazy,
      // FS nie zabiera mu floty spod ręki.
      if (ThreatMonitor.active()) return waitWhy("trwa alarm");
      if (MoonSave.watch().armed) { const w = MoonSave.watch(); return waitWhy(`straż obrony uzbrojona (para [${RescueQueue.str(w.at) || "?"}], flota: ${w.refugeBody || "?"}, od ${w.since ? new Date(w.since).toLocaleTimeString("pl-PL") : "?"}) — WRÓĆ NA BAZĘ albo zdejmij straż`); }
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") { let k = "?"; try { k = JSON.parse(pending)?.type || "?"; } catch {} return waitWhy(`inne zadanie w toku (${k})`); } // FS może poczekać 30 s
      // v2.66.0: nieudany start (np. pusty księżyc) nie jest ponawiany co tick.
      const failAt = parseInt(GM_getValue("ogamex_fs_fail_at", "0")) || 0;
      if (Date.now() - failAt < 10 * 60 * 1000) return waitWhy(`pauza po nieudanym starcie (${Math.ceil((10 * 60 * 1000 - (Date.now() - failAt)) / 60000)} min)`);
      // v2.75.0: start z aktualnego ciała — FS czeka, aż aktywny będzie księżyc
      // (właściciel przenosi flotę podczas eventu; wysyłka z planety byłaby
      // widoczna w falandze, więc z planety NIE startujemy).
      if (MoonSave.currentBody() !== "moon") {
        const warnAt = parseInt(GM_getValue("ogamex_fs_body_warn_at", "0")) || 0;
        if (Date.now() - warnAt > 10 * 60 * 1000) {
          GM_setValue("ogamex_fs_body_warn_at", String(Date.now()));
          log("[FS] czekam ze startem: aktywne ciało nie jest księżycem — przełącz na księżyc, z którego mam wysłać FS.", "warn");
        }
        return;
      }
      const p = this.plan();
      if (!p.ok && !p.measure) return waitWhy(p.why || "plan nie gotowy");   // za wcześnie / wyłączony / brak godziny
      if (!p.ok && p.measure) {
        // Nie znamy T: wejdź w formularz, zmierz i NIE wysyłaj (bramka w kroku 2
        // odmówi, bo okno >> 2T przy nieznanym T zawsze kończy się odmową albo
        // pomiarem). Rzadko — to nawigacja z wypełnianiem formularza.
        const lastTry = parseInt(GM_getValue("ogamex_fs_measure_at", "0")) || 0;
        if (Date.now() - lastTry < this.MEASURE_COOLDOWN_MS) return;
        GM_setValue("ogamex_fs_measure_at", String(Date.now()));
        return this.launch({ measure: true });
      }
      return this.launch({ plan: p });
    },

    // Start: z księżyca, na którym właściciel AKTUALNIE jest (v2.75.0 — bez
    // przełączania na dawną bazę; formularz wysyła z ciała aktywnego).
    // atCoords = bieżąca pozycja, żeby switch_to_body — gdyby w międzyczasie
    // aktywna stała się planeta — wrócił na księżyc TEJ pary, nie bazy.
    // v2.74.3: plan z ticka niesie returnAt RUNDY (przy łańcuchu ≠ finalna
    // godzina z panelu) — bramka 2T na kroku 2 i markLaunched liczą na nim.
    launch({ measure = false, plan = null } = {}) {
      const c = this.cfg();
      const to = c.to;
      if (!to || !Number.isFinite(to.galaxy)) { log("[FS] brak celu w konfiguracji — ustaw „Cel” w panelu FS.", "error"); return false; }
      const from = this.originCoords();
      if (MoonSave.currentBody() !== "moon" || !from) { log("[FS] nie startuję: aktywne ciało nie jest księżycem albo nie widzę pozycji na tej stronie.", "warn"); return false; }
      const at = (plan && plan.returnAt) || this.returnAtMs();
      if (!measure && !Number.isFinite(at)) return false;
      GM_setValue("pending_mission", JSON.stringify({
        type: "fleet_save_direct",
        fleetSave: true,
        fsMeasure: measure,
        atCoords: from,
        launchBody: "moon",
        targetBody: "moon",
        fleetUrl: `/fleet?x=${to.galaxy}&y=${to.system}&z=${to.position}`,
        returnAtMs: at || 0,
        speedPercent: c.speedPercent,
        step: "switch_to_body",
        timestamp: Date.now(),
      }));
      log(measure
        ? `[FS] pomiar trasy [${from.galaxy}:${from.system}:${from.position}]→[${to.galaxy}:${to.system}:${to.position}] przy ${c.speedPercent}% — wypełnię formularz, odczytam czas lotu i WYJDĘ bez wysyłki.`
        : `[FS] startuję: księżyc [${from.galaxy}:${from.system}:${from.position}] → księżyc [${to.galaxy}:${to.system}:${to.position}], stacjonuj z zawróceniem, powrót ${new Date(at).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}.`, "info");
      if (!measure) ThreatLog.add("FS", `Start FS na [${to.galaxy}:${to.system}:${to.position}], powrót ${new Date(at).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}.`);
      return true;
    },

    // Stemplowane po POTWIERDZONEJ wysyłce (finishDispatch albo strona
    // fleetSendSuccessfully). recallAt liczone od TERAZ: powrót = teraz + okno,
    // zawrócenie w połowie okna.
    markLaunched(pm) {
      const sentAt = Date.now();
      const returnAt = pm.returnAtMs || this.returnAtMs();
      const recallAt = sentAt + Math.floor(Math.max(0, returnAt - sentAt) / 2);
      this.save({ phase: "launched", sentAt, recallAt, returnAt, flightMs: pm.capturedFlightMs || 0, tries: 0,
                  from: pm.atCoords || this.cfg().from, to: this.cfg().to });
      const f = (ms) => new Date(ms).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
      log(`[FS] WYSŁANE. Zawrócenie ${f(recallAt)}, powrót ~${f(returnAt)}.`, "success");
      ThreatLog.add("FS", `Flota w drodze. Zawrócenie ${f(recallAt)}, powrót ~${f(returnAt)}.`);
      try { updateStatusUI(); } catch {}
    },

    // ═══ ZAWRACANIE ═══
    // Kontrolki zawracania nikt jeszcze nie widział (zrzut czeka w
    // FleetMovements.fetch). Szukamy jej po ZNACZENIU (recall/callback/retreat/
    // revoke/cancel/zawróć) w NASZYM wierszu; nic nie pasuje → zrzut + głośny
    // błąd + flota DOLECI na nasz własny księżyc i tam zostanie (stacjonowanie
    // = bezpieczna porażka; transport odrzucamy już przy wysyłce).
    RECALL_RX: /recall|call.?back|revoke|retreat|withdraw|cancel|abort|zawr[oó]|cofnij/i,
    _recalling: false,

    _findOurRow(doc, st = null) {
      const c = this.cfg();
      // v2.75.3: lot rozpoznajemy po koordach STEMPLOWANYCH przy wysyłce —
      // od v2.75.0 FS startuje z aktualnego księżyca, więc c.from (dawna baza)
      // nie opisuje już trasy; szukanie po nim nie znalazłoby naszego wiersza
      // i zawrócenie by przepadło (flota stacjonowałaby na celu).
      const f = st?.from || c.from;
      const t = st?.to || c.to;
      const fromS = `${f?.galaxy}:${f?.system}:${f?.position}`;
      const toS = `${t?.galaxy}:${t?.system}:${t?.position}`;
      for (const tr of doc.querySelectorAll("tr[class*='row-mission-type-']")) {
        const t = tr.textContent || "";
        if (t.includes(`[${fromS}]`) && t.includes(`[${toS}]`)) return tr;
      }
      return null;
    },

    async attemptRecall(st) {
      if (this._recalling) return;
      this._recalling = true;
      try {
        let html = "";
        try {
          const res = await fetchT(FleetMovements.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          if (res.ok) html = await res.text();
        } catch {}
        if (!html) { this._recallFail(st, "lista ruchów flot nie odpowiada"); return; }
        const doc = new DOMParser().parseFromString(html, "text/html");
        const row = this._findOurRow(doc, st);
        if (!row) {
          // Wiersza nie ma: flota już doleciała (za późno) albo już zawrócona.
          // v2.69.3: brak wiersza PRZED czasem dolotu = lot zawrócony (np.
          // ręcznie) — to sukces cyklu, nie porażka. Porażką jest dopiero
          // brak wiersza PO dolocie (flota stacjonuje na celu).
          const etaAbs = (st.sentAt || 0) + (st.flightMs || 0);
          if (st.flightMs && Date.now() < etaAbs - 60000) {
            this.save({ ...st, phase: "recalled", recalledAt: Date.now() });
            log("[FS] lotu nie ma na liście przed czasem dolotu — został zawrócony (najpewniej ręcznie). Zamykam cykl.", "info");
            try { updateStatusUI(); } catch {}
            return;
          }
          this._recallFail(st, "nie znajduję naszego lotu na liście ruchów (doleciała? już zawrócona?)");
          return;
        }
        const fleetId = row.getAttribute("data-fleet-id") || "";
        const etaBefore = parseInt(row.querySelector("[data-remaining-seconds]")?.getAttribute("data-remaining-seconds") || "0") || 0;
        // ── v2.66.9: PRAWDZIWA kontrolka, złapana na żywo 15:33 ──
        //   <a href="#" class="x_btn_fleet_return tooltip" data-fleet-id="…">
        // href="#" = czysty handler JS, więc fetch nic nie da — trzeba KLIKNĄĆ
        // w żywym DOM (lista renderuje się w panelu „Fleet movements" na
        // /fleet). Wcześniejszy wykrywacz celowo nie szukał po słowie „return"
        // (myliłoby się z lotami powrotnymi) — i dlatego przegapił klasę
        // x_btn_fleet_return.
        const returnBtnInRow = row.querySelector("a.x_btn_fleet_return, [class*='btn_fleet_return'], [class*='fleet_return']");
        // Lot już wraca (np. zawrócony ręcznie): wiersz bez przycisku zawracania
        // + znacznik powrotu = nie ma czego zawracać, cel osiągnięty.
        if (!returnBtnInRow && /data-return-flight="true"|\(R\)|return/i.test(row.outerHTML)) {
          this.save({ ...st, phase: "recalled", recalledAt: Date.now() });
          log("[FS] lot już jest w drodze powrotnej (zawrócony — możliwe, że ręcznie). Uznaję zawrócenie za wykonane.", "success");
          ThreatLog.add("FS", "Lot wykryty jako powrotny — zawrócenie wykonane (być może ręcznie).");
          try { updateStatusUI(); } catch {}
          return;
        }
        // kontrolka fallback: link z realnym href, formularz albo data-atrybut
        const link = [...row.querySelectorAll("a[href]")].find(a =>
          (a.getAttribute("href") || "#") !== "#" && (
            this.RECALL_RX.test(a.getAttribute("href") || "") || this.RECALL_RX.test(String(a.className || ""))
            || this.RECALL_RX.test(a.getAttribute("data-tooltip-content") || "") || this.RECALL_RX.test(a.textContent || "")));
        const form = [...row.querySelectorAll("form")].find(f => this.RECALL_RX.test(f.getAttribute("action") || ""));
        const dataEl = link || form ? null : [...row.querySelectorAll("[data-url], [data-href], [data-action]")].find(el =>
          this.RECALL_RX.test(el.getAttribute("data-url") || el.getAttribute("data-href") || el.getAttribute("data-action") || ""));
        if (!returnBtnInRow && !link && !form && !dataEl) {
          // Zasada z noty: markupu nie zgadujemy. Zrzut końca wiersza do logu
          // (wymuszony, nie one-shot) i głośna porażka.
          log(`[FS] NIE ZNAJDUJĘ kontrolki zawracania w wierszu lotu. Koniec wiersza: ${(row.innerHTML || "").replace(/\s+/g, " ").slice(-1200)}`, "error");
          this._recallFail(st, "brak kontrolki zawracania w markupli wiersza (zrzut w logu — przyślij go, dopiszę selektor)");
          return;
        }
        if (link || form || dataEl) {
          // ścieżka HTTP — na wypadek, gdyby inny build dawał realny adres
          const target = link ? link.getAttribute("href")
            : form ? form.getAttribute("action")
            : (dataEl.getAttribute("data-url") || dataEl.getAttribute("data-href") || dataEl.getAttribute("data-action"));
          log(`[FS] zawracam flotę (${link ? "link" : form ? "formularz" : "data-atrybut"}: ${target}).`, "info");
          try {
            if (form) {
              const params = new URLSearchParams();
              for (const inp of form.querySelectorAll("input[name]")) params.set(inp.getAttribute("name"), inp.getAttribute("value") || "");
              const tok = Ajax.token(); if (tok && !params.has("_token")) params.set("_token", tok);
              await fetch(target, {
                method: (form.getAttribute("method") || "POST").toUpperCase(),
                headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
                body: params.toString(), credentials: "same-origin",
              });
            } else {
              await fetch(target, { headers: { "X-Requested-With": "XMLHttpRequest" }, credentials: "same-origin" });
            }
          } catch (e) { this._recallFail(st, `zapytanie zawracania padło: ${e.message}`); return; }
        } else {
          // ── klik w żywym DOM ──
          const btnId = returnBtnInRow.getAttribute("data-fleet-id") || fleetId;
          const findLive = () => (btnId
            ? document.querySelector(`a.x_btn_fleet_return[data-fleet-id="${btnId}"]`)
            : document.querySelector("a.x_btn_fleet_return"));
          let live = findLive();
          if (!live) {
            // v2.74.0: wiersze listy flot renderują się DOPIERO po rozwinięciu
            // — potwierdzone na żywo 05.08 23:08 (właściciel rozwinął ręcznie
            // i dokładnie ten sam klik przeszedł). Rozwijamy więc jak człowiek:
            // kandydaci to „Fleet movements", nagłówek „Events" i pasek misji
            // („N Missions"); po kliku POLLUJEMY do 4 s, bo wiersze dochodzą
            // asynchronicznie (1,5 s bywało za mało).
            const cands = [...document.querySelectorAll("a, button, div, span, h2, h3")]
              .filter(e => e.offsetParent !== null && !e.closest("#ogx-bot-panel"))
              .filter(e => {
                const t = (e.textContent || "").trim();
                return t.length > 0 && t.length < 60 && /fleet\s*movements|^events$|\d+\s*Missions?/i.test(t);
              });
            log(`[FS] przycisku zawracania nie ma w żywym DOM — próbuję rozwinąć listę flot (${cands.length} kandydatów).`, "info");
            for (const t of cands) {
              t.click();
              for (let i = 0; i < 8 && !live; i++) { await AntiDetection.sleep(500); live = findLive(); }
              if (live) { log(`[FS] lista flot rozwinięta („${(t.textContent || "").trim().slice(0, 30)}") — przycisk zawracania widoczny.`, "success"); break; }
            }
          }
          if (!live) {
            // Zła strona (lista tylko w danych) — przejdź na /fleet i spróbuj
            // w następnym przebiegu pętli obrony. Max 2 nawigacje na cykl.
            const navs = (st.recallNavs || 0) + 1;
            if (navs <= 2) {
              this.save({ ...st, recallNavs: navs });
              log(`[FS] przycisk zawracania jest w danych, ale nie na tej stronie — przechodzę na /fleet (${navs}/2), żeby go kliknąć.`, "info");
              window.location.replace("/fleet");
              return;
            }
            this._recallFail(st, "przycisk x_btn_fleet_return jest w danych listy, ale nie mogę go dosięgnąć w żywym DOM");
            return;
          }
          log(`[FS] klikam zawracanie (a.x_btn_fleet_return, lot ${(btnId || "?").slice(0, 8)}…).`, "info");
          // Gdyby gra pytała natywnym confirm(), klik by na nim stanął —
          // na czas kliknięcia odpowiadamy „tak".
          const w = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;
          const origConfirm = w.confirm;
          try { w.confirm = () => true; live.click(); await AntiDetection.sleep(800); }
          finally { try { w.confirm = origConfirm; } catch {} }
          // Dialog potwierdzenia w DOM (jeśli jest) — klik tylko w obrębie modala.
          const confirmBtn = [...document.querySelectorAll("button, a, input[type='button'], input[type='submit']")]
            .find(e => e.offsetParent !== null && !e.closest("#ogx-bot-panel")
              && e.closest("[class*='modal'], [class*='dialog'], [class*='popup'], [class*='confirm']")
              && /^(ok|yes|tak|confirm|potwierd)/i.test((e.value || e.textContent || "").trim()));
          if (confirmBtn) { confirmBtn.click(); await AntiDetection.sleep(500); }
        }
        // ── weryfikacja: zawrócony lot ZMIENIA wiersz ──
        await AntiDetection.sleep(4000);
        let ok = false;
        try {
          const res2 = await fetchT(FleetMovements.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          const doc2 = res2.ok ? new DOMParser().parseFromString(await res2.text(), "text/html") : null;
          const row2 = doc2 && (fleetId ? doc2.querySelector(`tr[data-fleet-id="${fleetId}"]`) : this._findOurRow(doc2));
          if (!row2) ok = true;                                        // wiersz przekluczony/zniknął
          else if (/return|powr|zawr/i.test(row2.className + " " + (row2.textContent || ""))) ok = true;
          else {
            const etaAfter = parseInt(row2.querySelector("[data-remaining-seconds]")?.getAttribute("data-remaining-seconds") || "0") || 0;
            // normalny lot: eta spadła o ~5s; zawrócony: eta PRZESKAKUJE na czas powrotu
            if (Math.abs(etaAfter - (etaBefore - 5)) > 30) ok = true;
          }
        } catch {}
        if (ok) {
          this.save({ ...st, phase: "recalled", recalledAt: Date.now() });
          const f = (ms) => new Date(ms).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
          log(`[FS] ZAWRÓCONA — powrót ~${f(st.returnAt)}.`, "success");
          ThreatLog.add("FS", `Flota zawrócona, powrót ~${f(st.returnAt)}.`);
          try { updateStatusUI(); } catch {}
        } else {
          this._recallFail(st, "po zawróceniu wiersz lotu wygląda tak samo — zawrócenie najpewniej NIE zadziałało");
        }
      } finally {
        this._recalling = false;
      }
    },

    _recallFail(st, why) {
      const tries = (st.tries || 0) + 1;
      if (tries < this.RECALL_MAX_TRIES) {
        this.save({ ...st, tries, recallAt: Date.now() + this.RECALL_RETRY_MS });
        log(`[FS] zawracanie nieudane (${tries}/${this.RECALL_MAX_TRIES}): ${why}. Ponawiam za ${Math.round(this.RECALL_RETRY_MS / 1000)}s.`, "warn");
        return;
      }
      this.save({ ...st, phase: "recall_failed", tries });
      log(`[FS] ZAWRACANIE NIEUDANE po ${tries} próbach: ${why}. Flota DOLECI na nasz księżyc i tam zostanie (stacjonowanie) — ściągnij ją ręcznie albo przyciskiem, gdy wstaniesz.`, "error");
      ThreatLog.add("BŁĄD", `FS: zawracanie nieudane (${why}). Flota zostanie na celu — bezpieczna, ale nie wróci sama.`);
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("OGameX: FS — zawracanie nieudane", { body: "Flota doleci na cel i tam zostanie. Sprawdź log.", tag: "ogamex-fs" });
        }
      } catch {}
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  EVENTS PANEL (v2.88.0) — trzecie źródło: żywy DOM panelu Events
  // ═══════════════════════════════════════════════════════════════
  // 13:07 (utrata floty): atak z układu był NIEWIDZIALNY dla listy ruchów
  // i endpointów zdarzeń — jedyny ślad to goły licznik paska (bez celu,
  // dolotu i ciała), więc nie wstawał ani blitz, ani ucieczka w powietrze.
  // Ale panel Events RENDERUJE się w stronie (/home, /fleet) z kompletem:
  // typ misji, odliczanie, źródło, cel + ikona księżyca. Czytamy go z DOM
  // parserem o kształcie z fetchServerEvents (tr.eventFleet + .coordsOrigin
  // + .destCoords — NIE zgadujemy nowego markupu); jeśli fork renderuje
  // inaczej, jednorazowy zrzut [EVENTS DOM] do logu i selektory dopiszemy
  // z faktów. Odczyt żyje 3 min jako cache (strony galaktyki panelu nie
  // mają — ta sama lekcja co cache paska).
  const EventsPanel = {
    KEY_CACHE: "ogamex_events_panel_cache",
    KEY_DUMPED: "ogamex_events_panel_dumped_v2882",

    _parseTr(tr, own) {
      if (tr.dataset.returnFlight === "true") return null;      // nasz powrót
      const type = parseInt(tr.dataset.missionType || "0") || 0;
      const oc = (tr.querySelector(".coordsOrigin")?.textContent || "").match(/(\d+):(\d+):(\d+)/);
      const dcEl = tr.querySelector(".destCoords");
      const dc = ((dcEl && dcEl.textContent) || "").match(/(\d+):(\d+):(\d+)/);
      if (!dc) return null;                                     // bez celu wiersz nic nie wnosi
      const src = oc ? oc[0] : null;
      if (own.size && src && own.has(src)) return null;         // nasza własna misja
      const isSpy = type === ThreatMonitor.ESPIONAGE_TYPE;
      const isAttack = !isSpy && ThreatMonitor.ATTACK_TYPES.includes(type);
      if (!isSpy && !isAttack) return null;                     // typ spoza znanych — ostrożnie: zostaje ścieżka paska
      // Dolot: data-arrival-time (epoch s) albo odliczanie w wierszu.
      let eta = 0;
      const arr = parseInt(tr.dataset.arrivalTime || "0") || 0;
      if (arr > 0) eta = Math.max(0, Math.round(arr - Date.now() / 1000));
      if (!eta) {
        const t = tr.textContent || "";
        const cd = t.match(/\b(\d{1,2}):(\d{2}):(\d{2})\b/) || t.match(/\b(\d{1,2}):(\d{2})\b/);
        if (cd) eta = cd[3] !== undefined ? (+cd[1] * 3600 + +cd[2] * 60 + +cd[3]) : (+cd[1] * 60 + +cd[2]);
      }
      const dstBody = (dcEl.querySelector("img[src*='moon']") || /\bMoon\b/i.test(dcEl.textContent || "")) ? "moon" : "planet";
      return {
        mine: false, friendly: false, attack: isAttack, spy: isSpy, unknownType: false,
        type: String(type), src, srcBody: null, srcName: null, dst: dc[0], dstBody, eta,
        ships: [], html: (tr.outerHTML || "").replace(/\s+/g, " ").slice(0, 600), panel: true,
      };
    },

    read() {
      const own = ThreatMonitor.ownBodies();
      // ── Kształt A: upstream tr.eventFleet z NUMERYCZNĄ numeracją misji ──
      // Tylko przy pewnej numeracji — inaczej typy liczbowe nic nie znaczą.
      if (GM_getValue("ogamex_mission_numbering_warned", "") !== "1") {
        const trs = [...document.querySelectorAll("tr.eventFleet[data-mission-type]")];
        if (trs.length) {
          const rows = [];
          for (const tr of trs) { const r = this._parseTr(tr, own); if (r) rows.push(r); }
          this._cache(rows);
          return rows;
        }
      }
      // ── Kształt B (v2.88.2): fork renderuje panel wierszami listy ruchów ──
      // Zrzut [EVENTS DOM] z 12.08 16:10 pokazał kontener forka:
      // #layoutFleetMovements > #fleet-movement-content (był pusty, bo
      // „obcy" pochodził z symulacji ślepego paska). Wrogie wiersze tego
      // forka to tr[class*='row-mission-type-'] (zrzuty [ATAK DOM]) —
      // czytamy je PRAWDZIWYM FleetMovements.classifyRow: zero nowego
      // parsera, klasyfikacja sprawdzona bojowo (row-hostile/row-friendly)
      // i przybita autotestem. Numeracja liczbowa jej nie dotyczy.
      const panelTrs = [...document.querySelectorAll("#fleet-movement-content tr[class*='row-mission-type-'], #layoutFleetMovements tr[class*='row-mission-type-']")];
      if (panelTrs.length) {
        const rows = [];
        for (const tr of panelTrs) {
          let r = null; try { r = FleetMovements.classifyRow(tr, own); } catch {}
          if (!r || r.mine || r.friendly || !r.dst) continue;
          if (!r.attack && !r.spy) continue;
          rows.push({ ...r, panel: true });
        }
        this._cache(rows);
        return rows;
      }
      this._maybeDump();
      try {
        const c = JSON.parse(GM_getValue(this.KEY_CACHE, "null"));
        if (c && Date.now() - c.at < 3 * 60 * 1000) {
          return (c.rows || [])
            .filter(r => (r.arriveAt || 0) - Date.now() > -60000)   // dolot minął >1 min temu = po wszystkim
            .map(r => ({ ...r, eta: Math.max(0, Math.round(((r.arriveAt || 0) - Date.now()) / 1000)) }));
        }
      } catch {}
      return [];
    },

    _cache(rows) {
      GM_setValue(this.KEY_CACHE, JSON.stringify({
        at: Date.now(),
        rows: rows.map(r => ({ ...r, arriveAt: Date.now() + (r.eta || 0) * 1000 })),
      }));
    },

    // Fork bez znanych wierszy: JEDNORAZOWY zrzut kontenera Events do logu.
    // v2.88.2 (lekcja 16:10): zrzut NIE odpala się na symulacji (syntetyczny
    // obcy = panel słusznie pusty) ani na pustym kontenerze — spalenie
    // jedynego zrzutu na niczym to strata jedynej szansy na markup.
    _maybeDump() {
      if (GM_getValue(this.KEY_DUMPED, "") === "1") return;
      let bar = null;
      try { bar = ThreatMonitor.read(); } catch {}
      if (!bar || bar.sim || bar.foreign < 1) return;
      let el = document.querySelector("#fleet-movement-content") || document.querySelector("#layoutFleetMovements");
      if (!el) {
        const hdr = [...document.querySelectorAll("div, span, h1, h2, h3, td")]
          .find(e => (e.textContent || "").trim() === "Events" && !e.closest("#ogx-bot-panel"));
        if (!hdr) return;
        el = hdr.closest("table") || (hdr.parentElement && hdr.parentElement.parentElement) || hdr.parentElement;
      }
      if (!el || !el.children || el.children.length === 0) return; // pusty kontener niczego nie uczy
      const html = (el.outerHTML || "").replace(/\s+/g, " ");
      if (html.length < 100) return;
      GM_setValue(this.KEY_DUMPED, "1");
      log(`[EVENTS DOM] panel Events bez znanych wierszy — zrzut do dopisania selektorów forka (prześlij tę linię): ${html.slice(0, 3000)}`, "error");
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  WŁASNE POWROTY (v2.101.0) — zegar lądowań fal na atakowaną parę
  // ═══════════════════════════════════════════════════════════════
  // Owner (25.08): 8 fal ekspedycji + asteroidy wracają na księżyc co kilka
  // minut, a druga fala wroga jest wycelowana w te powroty. Sztywne 90 s
  // między zamiataniami gubiło fale lądujące w ostatnich 2 min przed
  // uderzeniem. Panel Events pokazuje NASZE loty powrotne z odliczaniem —
  // czytamy je tym samym parserem, co wrogie wiersze (kształt A: upstream
  // tr.eventFleet + data-return-flight; kształt B: wiersze forka z
  // markerem powrotu, ale BEZ przycisku zawracania — lot z przyciskiem
  // dopiero leci). Cache 3 min, bo strony galaktyki panelu nie mają.
  const OwnReturns = {
    KEY_CACHE: "ogamex_own_returns_cache",

    read() {
      const own = ThreatMonitor.ownBodies();
      const out = [];
      const push = (dst, body, etaSec) => { if (dst && etaSec > 0) out.push({ dst, dstBody: body, arriveAt: Date.now() + etaSec * 1000 }); };
      let seen = false;
      const trsA = [...document.querySelectorAll("tr.eventFleet[data-mission-type]")];
      if (trsA.length) {
        seen = true;
        for (const tr of trsA) {
          if (tr.dataset.returnFlight !== "true") continue;
          const dcEl = tr.querySelector(".destCoords");
          const dc = ((dcEl && dcEl.textContent) || "").match(/(\d+):(\d+):(\d+)/);
          if (!dc) continue;
          let eta = 0;
          const arr = parseInt(tr.dataset.arrivalTime || "0") || 0;
          if (arr > 0) eta = Math.max(0, Math.round(arr - Date.now() / 1000));
          if (!eta) {
            const t = tr.textContent || "";
            const cd = t.match(/\b(\d{1,2}):(\d{2}):(\d{2})\b/) || t.match(/\b(\d{1,2}):(\d{2})\b/);
            if (cd) eta = cd[3] !== undefined ? (+cd[1] * 3600 + +cd[2] * 60 + +cd[3]) : (+cd[1] * 60 + +cd[2]);
          }
          const body = (dcEl.querySelector("img[src*='moon'], figure.moon, .planetIcon.moon, [class*='moon']") || /\bMoon\b/i.test(dcEl.textContent || "")) ? "moon" : "planet";
          push(dc[0], body, eta);
        }
      } else {
        const trsB = [...document.querySelectorAll("#fleet-movement-content tr[class*='row-mission-type-'], #layoutFleetMovements tr[class*='row-mission-type-']")];
        if (trsB.length) seen = true;
        for (const tr of trsB) {
          // Recenzja 25.08 (A1): NAJPIERW bojowa klasyfikacja — wrogi/sojuszniczy
          // wiersz nigdy nie ma przycisku zawracania, więc sam regex „return"
          // (np. data-return-flight="false") robiłby z ataku „nasz powrót".
          let r = null; try { r = FleetMovements.classifyRow(tr, own); } catch {}
          if (!r || !r.mine) continue;
          if (tr.querySelector("a.x_btn_fleet_return, [class*='btn_fleet_return']")) continue; // dopiero leci
          if (!/data-return-flight="true"|\(R\)|return/i.test(tr.outerHTML)) continue;
          // Powrót ląduje w ŹRÓDLE lotu (nasze ciało); zapas: pierwsza nasza koorda.
          const coords = [...(tr.textContent || "").matchAll(/\[(\d+:\d+:\d+)\]/g)].map(m => m[1]);
          const home = (r.src && own.has(r.src)) ? r.src : (coords.find(c => own.has(c)) || null);
          if (!home) continue;
          const eta = Number.isFinite(r.eta) && r.eta > 0 ? r.eta
            : (parseInt(tr.querySelector("[data-remaining-seconds]")?.getAttribute("data-remaining-seconds") || "0") || 0);
          push(home, null, eta);   // ciało lądowania nieznane w tym kształcie
        }
      }
      // ── Recenzja 25.08 (#1): lot, który WYLĄDOWAŁ, znika z panelu ──
      // Sam odczyt DOM zwracałby tylko przyszłe dolot — „lądowanie od
      // ostatniego zamiatania" nigdy by nie wystąpiło. Dlatego pamiętamy
      // lądowania z ostatnich 10 min (z poprzednich odczytów) i doklejamy je
      // do żywej listy; przyszłe wpisy z cache służą tylko stronom bez panelu.
      const now = Date.now();
      let c = null;
      try { c = JSON.parse(GM_getValue(this.KEY_CACHE, "null")); } catch {}
      const prev = (c && Array.isArray(c.rows)) ? c.rows : [];
      const landedRecently = prev.filter(r => (r.arriveAt || 0) <= now && now - (r.arriveAt || 0) < 10 * 60 * 1000);
      const live = seen ? out
        : ((c && now - (c.at || 0) < 3 * 60 * 1000) ? prev.filter(r => (r.arriveAt || 0) > now) : []);
      const merged = [...live];
      for (const r of landedRecently) {
        if (!merged.some(m => m.dst === r.dst && Math.abs((m.arriveAt || 0) - (r.arriveAt || 0)) < 15000)) merged.push(r);
      }
      GM_setValue(this.KEY_CACHE, JSON.stringify({ at: seen ? now : ((c && c.at) || now), rows: merged }));
      return merged;
    },

    /** Czasy lądowań (ms epoch) na parę `key`; body=null lub nieznane ciało = licz. */
    landingsAt(key, body) {
      return this.read()
        .filter(r => r.dst === key && (!body || !r.dstBody || r.dstBody === body))
        .map(r => r.arriveAt)
        .sort((a, b) => a - b);
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  AIR SAVE (v2.85.0) — UCIECZKA W POWIETRZE na atak obu ciał pary
  // ═══════════════════════════════════════════════════════════════
  // Jedyny scenariusz, w którym ewakuacja księżyc↔planeta NIE ratuje floty:
  // napastnik uderza JEDNOCZEŚNIE w planetę i księżyc tej samej pary
  // (klasyka: GS „zniszcz księżyc" + atak na planetę). Odpowiedź uzgodniona
  // z ownerem (OTWARTE od 07.08, zielone światło 12.08): wysłać WSZYSTKO
  // powolnym Deployem do innej kolonii i ZAWRÓCIĆ po przejściu ataków —
  // flota w locie jest nietykalna, a zawrócenie lotu startującego
  // z księżyca jest niewidzialne dla falangi.
  //
  // Warstwa NA istniejącej ścieżce (strategia zmian w obronie):
  //   • odpala się TYLKO, gdy lista ruchów pokazuje ataki na OBA ciała
  //     jednej pary (ev.targetBodiesAll) — każdy inny atak idzie starą,
  //     bojowo potwierdzoną ścieżką ratunku;
  //   • każda porażka (brak refugium, lot za krótki, brak przycisku
  //     zawracania) = głośny wpis + powrót kolonii na zwykły ratunek
  //     przez markFailed — dno regresji to zachowanie 2.84.0;
  //   • wysyłka jedzie sprawdzonym formularzem ratunku (wszystkie statki,
  //     wszystkie surowce minus rezerwa deuteru), prędkość ustawia kod FS,
  //     zawracanie klika tę samą kontrolkę x_btn_fleet_return, którą FS
  //     zawraca na żywo od v2.66.9.
  const AirSave = {
    KEY: "ogamex_airsave",
    KEY_FAIL: "ogamex_airsave_fail",
    RECALL_BUFFER_MS: 120000,   // zawrócenie: ostatni dolot ataku + 2 min zapasu

    enabled() { return CONFIG.threatAlarm?.airSave !== false; },
    state() { try { return JSON.parse(GM_getValue(this.KEY, "null")) || {}; } catch { return {}; } },
    save(st) { GM_setValue(this.KEY, st ? JSON.stringify(st) : "null"); },

    key(c) { return c && Number.isFinite(c.galaxy) ? `${c.galaxy}:${c.system}:${c.position}` : null; },

    // CZYSTA decyzja — bez DOM, sieci i zegara systemowego. Testowana
    // offline (test-ucieczka.js) i wołana na żywo przez MoonSave.run().
    // v2.100.0 (audyt 25.08, D3): faza `recalled` blokuje zwykły ratunek
    // TYLKO do lądowania (`landed`). Dotąd blokowała jeszcze 10 min po nim —
    // atak dosłany na świeżo wylądowaną flotę nie wywoływał skoku.
    decide({ enabled, bodies, activePhase, failedAt, now, landed, noMoon }) {
      if (!enabled) return "swap";
      if (activePhase === "launched" || activePhase === "arming") return "active";
      if (activePhase === "recalled" && !landed) return "active";
      // v2.104.7: para BEZ księżyca (zniszczony 26.08 18:26 przez 3× Destroy)
      // nie ma dokąd skakać — każdy atak na planetę = ucieczka w powietrze.
      if (noMoon && (!bodies || !bodies.length)) return "swap";
      if (!noMoon && (!bodies || bodies.length < 2)) return "swap";
      if (failedAt && now - failedAt < 10 * 60 * 1000) return "swap";
      return "air";
    },

    // CZYSTA arytmetyka zawrócenia: ostatni dolot + bufor.
    recallAtFor(maxEtaSec, now) { return now + Math.max(0, maxEtaSec || 0) * 1000 + this.RECALL_BUFFER_MS; },

    // Kiedy zawrócona flota fizycznie ląduje w domu: powrót trwa tyle,
    // ile lot do chwili zawrócenia.
    landedAtOf(st) {
      const backMs = Math.max(60000, (st.recalledAt || 0) - (st.sentAt || 0));
      return (st.recalledAt || 0) + backMs;
    },

    // ── v2.100.0 (D2): CZYSTE przeliczenie zegara zawrócenia w locie ──
    // Napastnik dosyła fale PO starcie ucieczki → zawrócenie przesuwa się na
    // ostatni dolot + bufor. Górna granica: dolot NASZEGO lotu do refugium
    // minus minuta — zawrócić można tylko lot, który jeszcze leci.
    recallAtUpdate({ recallAt, maxEtaSec, now, sentAt, flightMs }) {
      const want = Math.max(recallAt || 0, now + Math.max(0, maxEtaSec || 0) * 1000 + this.RECALL_BUFFER_MS);
      const cap = (sentAt && flightMs) ? sentAt + flightMs - 60000 : Infinity;
      return { recallAt: Math.min(want, cap), capped: want > cap };
    },

    decideFor(atCoords) {
      const k = this.key(atCoords);
      if (!k) return "swap";
      let ev = null;
      try { ev = ThreatMonitor.events(); } catch {}
      let failedAt = 0;
      try { failedAt = (JSON.parse(GM_getValue(this.KEY_FAIL, "{}")) || {})[k] || 0; } catch {}
      const st = this.state();
      return this.decide({
        enabled: this.enabled(),
        bodies: ThreatMonitor.attackBodiesFor(k),   // v2.102.4: lista ∪ pamięć ∪ nadwyżka
        activePhase: (st.phase && this.key(st.at) === k) ? st.phase : null,
        failedAt,
        now: Date.now(),
        landed: st.phase === "recalled" ? Date.now() >= this.landedAtOf(st) : false,
        noMoon: HomeBase.pairHasMoon(atCoords) === false,   // v2.104.7
      });
    },

    markFailed(atCoords, why) {
      const k = this.key(atCoords);
      if (!k) return;
      let m = {};
      try { m = JSON.parse(GM_getValue(this.KEY_FAIL, "{}")) || {}; } catch {}
      m[k] = Date.now();
      GM_setValue(this.KEY_FAIL, JSON.stringify(m));
      DefenceWatchdog.note(`ucieczka w powietrze nieudana (${why}) — kolonia [${k}] wraca na zwykły ratunek`);
    },

    // Najbliższa WŁASNA kolonia poza atakowaną parą (z paska planet;
    // preferuj tę samą galaktykę — i tak lecimy wolno, chodzi o dolot,
    // którego nigdy nie będzie).
    refuge(atCoords) {
      const list = [];
      for (const p of document.querySelectorAll("a.planet-select, .planet-select")) {
        const m = (p.textContent || "").replace(/\s+/g, " ").match(/(\d+):(\d+):(\d+)/);
        if (m) list.push({ galaxy: +m[1], system: +m[2], position: +m[3] });
      }
      const k = this.key(atCoords);
      const own = list.filter(c => this.key(c) !== k);
      if (!own.length) return null;
      const sameGal = own.filter(c => c.galaxy === atCoords.galaxy);
      const pool = sameGal.length ? sameGal : own;
      pool.sort((a, b) => Math.abs(a.system - atCoords.system) - Math.abs(b.system - atCoords.system));
      return pool[0];
    },

    // Wysyłka. Wołane z MoonSave.run() — aktywna kolonia to już atakowana
    // para (autoSaveOnThreat przełączył się wcześniej). Zwraca true, gdy
    // misja ruszyła; false = wracaj na zwykły ratunek.
    async launch(atCoords, reason, maxEtaSec) {
      // v2.110.2 (27.08 11:26): DRUGA ucieczka (inna para) NADPISAŁA stan pierwszej —
      // główna flota leciała na [2:21:4] bez pamięci o zawrocie. Stan powietrza jest
      // jeden na bota: dopóki jedna para leci (arming/launched/recalled), inna para
      // NIE dostaje powietrza (wraca do zwykłego ratunku w parze). Per-para = Etap A.
      try {
        const cur = this.state();
        if (cur && cur.phase && ["arming", "launched", "recalled"].includes(cur.phase) && this.key(cur.at) !== this.key(atCoords)) {
          log(`[UCIECZKA] w powietrzu jest już flota z [${this.key(cur.at)}] — nie nadpisuję jej stanu; [${this.key(atCoords)}] dostaje zwykły ratunek w parze.`, "error");
          ThreatLog.add("BŁĄD", `Ucieczka dla [${this.key(atCoords)}] wstrzymana: w powietrzu już [${this.key(cur.at)}] (jeden stan). Ratunek w parze.`);
          return false;
        }
      } catch {}
      const to = this.refuge(atCoords);
      if (!to) {
        log("[UCIECZKA] nie widzę żadnej innej kolonii na pasku planet — wracam do zwykłego ratunku.", "error");
        this.markFailed(atCoords, "brak refugium na pasku planet");
        return false;
      }
      const holdUntilMs = this.recallAtFor(maxEtaSec, Date.now());
      const speed = Math.max(1, Math.min(100, parseInt(CONFIG.fleetSave?.speedPercent) || 10));
      GM_setValue("pending_mission", JSON.stringify({
        type: "air_save_direct",
        moonSave: true,          // formularz ratunku: wszystkie statki + surowce − rezerwa deuteru
        airSave: true,
        atCoords,                // atakowana para (dla flipa pustego hangaru)
        holdUntilMs,             // kiedy zawrócić: ostatni dolot + bufor
        speedPercent: speed,     // wolno = długi lot = zawsze zdążymy zawrócić
        fleetUrl: `/fleet?x=${to.galaxy}&y=${to.system}&z=${to.position}`,
        step: "select_ships_direct",
        timestamp: Date.now(),
      }));
      this.save({ phase: "arming", at: atCoords, to, holdUntilMs, reason, createdAt: Date.now() });
      try { RescueQueue.dropPending(atCoords, "ucieczka w powietrze tej kolonii"); } catch {}   // v2.104.0
      DefenceHold.stamp();
      const hhmm = new Date(holdUntilMs).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
      log(`UCIECZKA W POWIETRZE: atak na OBA ciała [${this.key(atCoords)}] — wysyłam WSZYSTKO powolnym Deployem (${speed}%) do [${this.key(to)}], zawrócę ~${hhmm} (po przejściu ataków).`, "error");
      ThreatLog.add("RATUNEK", `UCIECZKA W POWIETRZE: oba ciała [${this.key(atCoords)}] pod atakiem — flota leci do [${this.key(to)}] (${speed}%), zawrócenie ~${hhmm}.`);
      await AntiDetection.sleep(300 + Math.random() * 400);
      window.location.replace(`/fleet?x=${to.galaxy}&y=${to.system}&z=${to.position}`);
      return true;
    },

    // Po potwierdzonej wysyłce (finishDispatch ORAZ fleetSendSuccessfully —
    // obie ścieżki mogą odpalić dla tej samej wysyłki, stąd dedup 15 s).
    afterSend(mission) {
      const st = this.state();
      // v2.100.0 (D4): dodatkowy lot z zamiatania w trakcie ucieczki —
      // dopisuje się do stanu, NIE resetuje zegara ani fazy głównego lotu.
      if (mission && mission.airExtra) {
        if (Date.now() - (st.extraAt || 0) < 15000) return;
        if (st.phase === "recalled") {
          // v2.100.1 (F2): fala wysłana już PO zawróceniu lotu głównego —
          // otwieramy zawracanie ponownie, żeby i ją ściągnąć (zegar bez cofania).
          this.save({ ...st, phase: "launched", recallAt: Math.max(st.recallAt || 0, Date.now()), extra: (st.extra || 0) + 1, extraAt: Date.now(), reopened: (st.reopened || 0) + 1 });
          log("[UCIECZKA] fala wystartowała po zawróceniu lotu głównego — zawrócę ją osobno.", "warn");
          updateStatusUI();
          return;
        }
        if (st.phase !== "launched") return;
        this.save({ ...st, extra: (st.extra || 0) + 1, extraAt: Date.now() });
        updateStatusUI();
        return;
      }
      if (st.phase === "launched" && Date.now() - (st.sentAt || 0) < 15000) return;
      let fromBody = null;
      try { fromBody = (mission && mission.launchBody) || MoonSave.currentBody() || null; } catch {}
      this.save({
        ...st,
        phase: "launched",
        fromBody,               // v2.100.1: ciało startu — tam lądują fale (zamiatanie)
        sentAt: Date.now(),
        flightMs: (mission && mission.flightMs) || st.flightMs || 0,
        recallAt: (mission && mission.holdUntilMs) || st.holdUntilMs || (Date.now() + this.RECALL_BUFFER_MS),
        at: st.at || (mission && mission.atCoords) || null,
      });
      updateStatusUI();
    },

    // Tick w pętli obrony (przed FS): pilnuje zawrócenia i domyka cykl.
    async tick() {
      const st = this.state();
      if (!st.phase) return;
      if (st.phase === "arming") {
        // Wysyłka nie potwierdziła się w 5 min = misja padła w formularzu.
        // v2.102.0 (C-F6): bez pending (formularz padł) porażka po 60 s, nie 5 min —
        // faza „arming" blokuje zwykły ratunek.
        const pend = GM_getValue("pending_mission", null);
        const noPending = !pend || pend === "null";
        const age = Date.now() - (st.createdAt || 0);
        if (age > 5 * 60 * 1000 || (noPending && age > 60 * 1000)) {
          this.save(null);
          this.markFailed(st.at, "wysyłka nie potwierdziła się w 5 min");
          log("[UCIECZKA] wysyłka nie potwierdziła się w 5 min — stan wyczyszczony, kolonia wraca na zwykły ratunek.", "error");
        }
        return;
      }
      if (st.phase === "launched") {
        DefenceWatchdog.note("ucieczka w powietrze w locie — zawrócenie wg zegara");
        // v2.102.0 (C-F6): co 60 s sprawdź, czy nasz lot JESZCZE JEST — ręczne
        // zawrócenie przez ownera zamykało obronę na godziny (faza „launched").
        // v2.102.2 (test 12:52): detektor NIE działa, gdy zegar zawrócenia już
        // minął albo bot już klikał zawracanie — inaczej zagłuszał log „ZAWRÓCONA"
        // i zamykał fazę przed potwierdzeniem klikniętego zawrócenia.
        const recallDue = Date.now() >= (st.recallAt || 0) - 30 * 1000;
        if (!recallDue && !(st.recallTries > 0) && Date.now() - (st.checkAt || 0) > 60 * 1000 && Date.now() - (st.sentAt || 0) > 90 * 1000) {
          this.save({ ...st, checkAt: Date.now() });
          try {
            const res = await fetchT(FleetMovements.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
            if (res.ok) {
              const doc = new DOMParser().parseFromString(await res.text(), "text/html");
              const anyRows = doc.querySelectorAll("tr[class*='row-mission-type-']").length > 0;
              const ours = this._findOurRows(doc, st).length;
              if (ours) this.save({ ...st, checkAt: Date.now(), rowSeen: true });
              // Wniosek „zawrócony" TYLKO, jeśli nasz wiersz był kiedyś widoczny —
              // fork potrafi nie pokazywać lotów w tym samym układzie (recenzja #7).
              if (anyRows && !ours && st.rowSeen && Date.now() < (st.sentAt || 0) + (st.flightMs || 0) - 60000) {
                this.save({ ...st, phase: "recalled", recalledAt: Date.now(), checkAt: Date.now() });
                log("[UCIECZKA] naszego lotu nie ma już na liście przed czasem dolotu — zawrócony (ręcznie?). Zwykły ratunek znów aktywny.", "warn");
                ThreatLog.add("POWRÓT", "Ucieczka w powietrze: lot zniknął z listy przed dolotem — uznaję za zawrócony.");
                return;
              }
            }
          } catch {}
        }
        // ── v2.100.0 (D2): zegar zawrócenia ŻYJE — dosłane fale go przesuwają ──
        let cur = st;
        try {
          const evNow = ThreatMonitor.events();
          const maxEta = (evNow?.targetMaxEta || {})[this.key(st.at)] || 0;
          // v2.100.1 (#5): gdy zawracanie już ruszyło (część lotów wraca), zegar
          // się nie przesuwa — reszta ma wrócić razem, nie zostać w powietrzu.
          // v2.102.2 (test 12:50): ETA liczone od CZASU ODCZYTU zdarzeń — od „teraz"
          // dryfowało o sekundę na tick i logowało „przesunięte" 6× w 20 s.
          if (maxEta > 0 && !st.recalledSome) {
            const u = this.recallAtUpdate({ recallAt: st.recallAt, maxEtaSec: maxEta, now: evNow.at || Date.now(), sentAt: st.sentAt, flightMs: st.flightMs });
            if (u.recallAt > (st.recallAt || 0) + 20000) {
              cur = { ...st, recallAt: u.recallAt };
              this.save(cur);
              const hhmm = new Date(u.recallAt).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
              log(`[UCIECZKA] dosłana fala z dłuższym dolotem — zawrócenie przesunięte na ~${hhmm}.`, "warn");
              ThreatLog.add("ATAK", `Nowa fala w trakcie ucieczki — zawrócenie przesunięte na ~${hhmm}.`);
            }
            if (u.capped && Date.now() - (st.capSaidAt || 0) > 10 * 60 * 1000) {
              cur = { ...cur, capSaidAt: Date.now() };
              this.save(cur);
              log("[UCIECZKA] UWAGA: ostatni dolot ataku wykracza poza nasz lot do refugium — zawrócę tuż przed dolotem; po powrocie straż/skok w parze przejmuje obronę.", "error");
            }
          }
        } catch {}
        if (Date.now() >= (cur.recallAt || 0)) { await this._recall(cur); return; }
        // ── v2.100.0 (D4): zamiatanie w trakcie ucieczki — fale ekspedycji/asteroid,
        // które lądują na atakowanej parze, też idą w powietrze.
        await this.sweep(cur);
        return;
      }
      if (st.phase === "recalled") {
        // v2.100.1 (F4): po LĄDOWANIU zegar bezpiecznika „zator" straży liczy
        // się od nowa — inaczej wielogodzinna ucieczka (since > 60 min) była
        // rozbrajana w pierwszym cichym ticku, zanim powrót ściągnął flotę.
        if (!st.sinceReset && Date.now() >= this.landedAtOf(st)) {
          this.save({ ...st, sinceReset: true });
          try { const w = MoonSave.watch(); if (w.armed) MoonSave.saveWatch({ ...w, since: Date.now() }); } catch {}
        }
        // v2.111.2 (27.08 12:01): flota stała w hangarze, a stan „recalled" blokował
        // symulację i ratunek do 10 min po wyliczonym lądowaniu. Świeży odczyt hangaru
        // pary (FleetRecon, PO zawrocie) z flotą = wylądowała → cykl domknięty od razu.
        try {
          const e = (JSON.parse(GM_getValue(FleetRecon.KEY_HANGARS, "{}")) || {})[this.key(st.at)];
          if (e && (e.total || 0) > 0 && (e.at || 0) > (st.recalledAt || 0) + 30 * 1000) {
            this.save(null);
            log(`[UCIECZKA] cykl domknięty — hangar [${this.key(st.at)}] pełny wg odczytu z ${new Date(e.at).toLocaleTimeString("pl-PL")} (flota wylądowała).`, "success");
            return;
          }
        } catch {}
        // Powrót trwa tyle, ile lot do chwili zawrócenia; domknij z zapasem.
        const backMs = Math.max(60000, (st.recalledAt || 0) - (st.sentAt || 0));
        if (Date.now() > (st.recalledAt || 0) + backMs + 10 * 60 * 1000) {
          this.save(null);
          log("[UCIECZKA] cykl domknięty — flota powinna być z powrotem w domu. Zerknij do hangaru.", "success");
        }
        return;
      }
      if (st.phase === "recall_failed") {
        // Stan trwały do ręcznego sprzątnięcia — przypominaj co 15 min.
        if (Date.now() - (st.nagAt || 0) > 15 * 60 * 1000) {
          this.save({ ...st, nagAt: Date.now() });
          log(`[UCIECZKA] flota NIE została zawrócona — doleci/doleciała do [${this.key(st.to)}]. Ściągnij ją ręcznie (Deploy powrotny), potem stan wyczyści się sam po 2 h.`, "error");
        }
        if (Date.now() - (st.createdAt || st.sentAt || 0) > 2 * 60 * 60 * 1000) this.save(null);
      }
    },

    // ── v2.100.0 (D4): ZAMIATANIE W TRAKCIE UCIECZKI ──
    // Owner (25.08): „bot ma chronić wszystkie fale" — 8 fal ekspedycji
    // z księżyca wraca w trakcie ucieczki i lądowało na atakowanej parze
    // bez żadnej reakcji (run() widział „ucieczka w toku" i milczał, straż
    // nie była uzbrojona). Teraz każda fala, która wyląduje, leci tym samym
    // powolnym Deployem do tego samego refugium; zawrócenie zbiera WSZYSTKIE
    // nasze loty (patrz _recall). Pusty hangar = jeden przelot strony.
    SWEEP_MAX: 40,
    async sweep(st) {
      if (!ThreatMonitor.active()) return;
      if (!st.at || !st.to) return;
      // Pierwsze 10 min co 90 s (fale wracają gęsto), potem co 5 min.
      // v2.101.0: + zegar powrotów (lądowanie = zamiataj po 20 s; wróg za
      // < 3 min = też 20 s) tą samą czystą funkcją, co straż.
      const baseGap = Date.now() - (st.sentAt || 0) < 10 * 60 * 1000 ? MoonSave.MIN_RESAVE_MS : 5 * 60 * 1000;
      const lastAt = Math.max(st.sweepAt || 0, st.sentAt || 0);
      let due = Date.now() - lastAt >= baseGap;
      try {
        const key = this.key(st.at);
        const ev = ThreatMonitor.events();
        const minEta = (ev?.targetMinEta || {})[key] || 0;
        const attackAt = minEta > 0 ? (ev.at || Date.now()) + minEta * 1000 : 0;
        // fastGap 60 s: zamiatanie ucieczki to reload + formularz na pustym hangarze;
        // po lądowaniu/„soon" nie ma sensu gęściej (recenzja #9).
        const plan = MoonSave.sweepPlan({ now: Date.now(), lastAt, returns: OwnReturns.landingsAt(key, st.fromBody || null), attackAt, minGap: baseGap, fastGap: 60000 });
        MoonSave.warnDoomed(plan.doomed, attackAt, key);
        due = plan.due;
      } catch {}
      if (!due) return;
      if ((st.sweeps || 0) >= this.SWEEP_MAX) {
        if (!st.sweepCapSaid) { this.save({ ...st, sweepCapSaid: true }); log(`[UCIECZKA] limit ${this.SWEEP_MAX} zamiatań w jednej ucieczce — dalsze fale SPRAWDŹ RĘCZNIE.`, "error"); }
        return;
      }
      // v2.100.1 (F2): tuż przed zawróceniem nie startujemy nowej fali —
      // formularz trwa do minuty, a zawrócenie w tym oknie zostawiłoby lot
      // bez opieki (afterSend i tak go dziś odzyska, ale po co ryzykować).
      if ((st.recallAt || 0) - Date.now() < 3 * 60 * 1000) return;
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") return;
      if (MoonSave.running) return;
      const speed = Math.max(1, Math.min(100, parseInt(CONFIG.fleetSave?.speedPercent) || 10));
      const fleetUrl = `/fleet?x=${st.to.galaxy}&y=${st.to.system}&z=${st.to.position}`;
      this.save({ ...st, sweepAt: Date.now(), sweeps: (st.sweeps || 0) + 1 });
      // v2.100.1: fale lądują na ciele, z którego wystartował lot główny
      // (dom ekspedycji) — jedziemy tam JAWNIE (switch_to_body) i bez flipa;
      // pusty hangar = 1-2 przeloty, aktywne ciało nie skacze co zamiatanie.
      const launchBody = st.fromBody || (CONFIG.baseBody === "moon" ? "moon" : "planet");
      GM_setValue("pending_mission", JSON.stringify({
        type: "air_save_direct",
        moonSave: true,
        airSave: true,
        airExtra: true,          // dodatkowy lot: nie resetuje stanu ucieczki
        flippedBody: true,       // bez flipa i korekt — ciało startu jawne
        atCoords: st.at,
        launchBody,
        holdUntilMs: st.recallAt,
        speedPercent: speed,
        fleetUrl,
        step: "switch_to_body",
        timestamp: Date.now(),
      }));
      DefenceHold.stamp();
      ThreatLog.add("STRAŻ", `Zamiatanie w trakcie ucieczki nr ${(st.sweeps || 0) + 1}: co wylądowało na [${this.key(st.at)}], leci do [${this.key(st.to)}].`);
      log(`[UCIECZKA] zamiatanie nr ${(st.sweeps || 0) + 1}: sprawdzam hangar ${launchBody === "moon" ? "księżyca" : "planety"} [${this.key(st.at)}] — wracające fale też idą w powietrze.`, "fleet");
      await AntiDetection.sleep(300 + Math.random() * 400);
      window.location.replace("/");   // switch_to_body potrzebuje paska planet
    },

    // Nasze loty: Deploy/stacjonowanie z atakowanej pary do refugium, nie-powrotne.
    // v2.100.0: może ich być kilka (lot główny + fale z zamiatania).
    _findOurRows(doc, st) {
      const toKey = this.key(st.to), atKey = this.key(st.at);
      const done = new Set(st.recalledIds || []);   // v2.100.1 (F5): już zawrócone po id
      const out = [];
      for (const tr of doc.querySelectorAll("tr[class*='row-mission-type-']")) {
        const cls = String(tr.className);
        if (!/DEPLOY|STATION/i.test(cls)) continue;
        if (/return/i.test(cls)) continue;
        const fid = tr.getAttribute("data-fleet-id") || "";
        if (fid && done.has(fid)) continue;
        const txt = tr.textContent || "";
        if (toKey && txt.includes(`[${toKey}]`) && atKey && txt.includes(`[${atKey}]`)) out.push(tr);
      }
      return out;
    },
    _findOurRow(doc, st) { return this._findOurRows(doc, st)[0] || null; },

    async _recall(st) {
      if (this._recalling) return;
      this._recalling = true;
      try {
        const tries = (st.recallTries || 0) + 1;
        this.save({ ...st, recallTries: tries });
        if (tries > 5) {
          this.save({ ...st, phase: "recall_failed" });
          log("[UCIECZKA] 5 nieudanych prób zawrócenia — flota DOLECI do refugium i tam zostanie (bezpieczna, ale poza domem). Ściągnij ją ręcznie.", "error");
          ThreatLog.add("BŁĄD", `Ucieczka w powietrze: zawrócenie nie powiodło się 5×. Flota doleci do [${this.key(st.to)}] — ściągnij ręcznie.`);
          return;
        }
        let html = "";
        try {
          const res = await fetchT(FleetMovements.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          if (res.ok) html = await res.text();
        } catch {}
        if (!html) { log("[UCIECZKA] lista ruchów flot nie odpowiada — ponowię w następnym przebiegu.", "warn"); return; }
        const doc = new DOMParser().parseFromString(html, "text/html");
        const row = this._findOurRow(doc, st);
        if (!row) {
          // v2.111.3 (zrzut 12:16:45): lista MIAŁA nasz lot, ale już jako `row-fleet-return`
          // (zawrót z próby 1 zadziałał; przeładowanie strony zjadło zapis stanu) —
          // _findOurRows wyklucza wiersze return → „nie znajduję lotu" ×5, push, recall_failed.
          // Wiersz POWROTNY z naszymi koordami = zawrót potwierdzony.
          try {
            const toKey = this.key(st.to), atKey = this.key(st.at);
            const back = [...doc.querySelectorAll("tr[class*='row-mission-type-']")].find(tr => /return/i.test(String(tr.className)) && /DEPLOY|STATION/i.test(String(tr.className)) && (tr.textContent || "").includes(`[${toKey}]`) && (tr.textContent || "").includes(`[${atKey}]`));
            if (back) {
              this.save({ ...st, phase: "recalled", recalledAt: st.recalledAt || Date.now(), recallTries: 0 });
              log(`[UCIECZKA] ✅ lot [${atKey}]→[${toKey}] już WRACA (wiersz powrotny na liście) — zawrót potwierdzony.`, "success");
              ThreatLog.add("POWRÓT", `Ucieczka: flota zawrócona, wraca na [${atKey}].`);
              return;
            }
          } catch {}
          const etaAbs = (st.sentAt || 0) + (st.flightMs || 0);
          if (st.flightMs && Date.now() < etaAbs - 60000) {
            // v2.111.1 (27.08 10:18 / 11:28 / 11:54 — 3× „zawrócony (możliwe, że ręcznie)",
            // a lot LECIAŁ dalej; operator zawracał ręcznie): lista ruchów nie oddaje naszego
            // lotu (widzi tylko aktywną parę / inne ciało). Brak wiersza NIE jest sukcesem:
            // ponawiamy (5×), zrzucamy listę i panel Events do logu, krzyczymy pushem.
            const listRows = [...doc.querySelectorAll("tr[class*='row-mission-type-']")].map(tr => `${String(tr.className).replace(/\s+/g, " ")} :: ${(tr.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160)}`);
            let evRows = [];
            try { evRows = [...document.querySelectorAll("#fleet-movement-content tr, #layoutFleetMovements tr")].map(tr => `${String(tr.className).replace(/\s+/g, " ")} :: ${(tr.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160)}`); } catch {}
            if (!st.noRowDumped) {
              this.save({ ...st, recallTries: tries, noRowDumped: true });
              log(`[UCIECZKA DOM] brak naszego lotu [${this.key(st.at)}]→[${this.key(st.to)}] na liście (${listRows.length} wierszy): ${listRows.join(" || ").slice(0, 2500)}`, "error");
              log(`[UCIECZKA DOM] panel Events (${evRows.length} wierszy): ${evRows.join(" || ").slice(0, 2500)}`, "error");
            }
            log(`[UCIECZKA] nie znajduję naszego lotu na liście (próba ${tries}/5) — NIE zakładam zawrotu, ponowię. Jeśli flota leci do [${this.key(st.to)}], ZAWRÓĆ RĘCZNIE.`, "error");
            if (tries === 2) ThreatLog.add("BŁĄD", `Ucieczka: nie widzę własnego lotu do [${this.key(st.to)}] na liście — zawrót niepewny, sprawdź i zawróć ręcznie.`);
          } else {
            this.save({ ...st, phase: "recall_failed" });
            log("[UCIECZKA] nie znajduję naszego lotu na liście — doleciał do refugium? Ściągnij flotę ręcznie.", "error");
            ThreatLog.add("BŁĄD", `Ucieczka w powietrze: lot zniknął z listy (doleciał?). Flota na [${this.key(st.to)}] — ściągnij ręcznie.`);
          }
          return;
        }
        // Klik x_btn_fleet_return — dokładnie ścieżka FS (potwierdzona na żywo).
        const fleetId = row.getAttribute("data-fleet-id") || "";
        const findLive = () => (fleetId
          ? document.querySelector(`a.x_btn_fleet_return[data-fleet-id="${fleetId}"]`)
          : document.querySelector("a.x_btn_fleet_return"));
        let live = findLive();
        if (!live) {
          const cands = [...document.querySelectorAll("a, button, div, span, h2, h3")]
            .filter(e => e.offsetParent !== null && !e.closest("#ogx-bot-panel"))
            .filter(e => { const t = (e.textContent || "").trim(); return t.length > 0 && t.length < 60 && /fleet\s*movements|^events$|\d+\s*Missions?/i.test(t); });
          for (const t of cands) {
            t.click();
            for (let i = 0; i < 8 && !live; i++) { await AntiDetection.sleep(500); live = findLive(); }
            if (live) break;
          }
        }
        if (!live) {
          const navs = (st.recallNavs || 0) + 1;
          if (navs <= 2) {
            this.save({ ...st, recallTries: tries - 1, recallNavs: navs }); // nawigacja nie zjada próby
            log(`[UCIECZKA] przycisk zawracania nie na tej stronie — przechodzę na /fleet (${navs}/2).`, "info");
            window.location.replace("/fleet");
            return;
          }
          log(`[UCIECZKA] nie mogę dosięgnąć przycisku zawracania (próba ${tries}/5) — ponowię.`, "warn");
          return;
        }
        const w = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;
        const orig = w.confirm;
        try { w.confirm = () => true; live.click(); await AntiDetection.sleep(800); }
        finally { try { w.confirm = orig; } catch {} }
        await AntiDetection.sleep(4000);
        let ok = false;
        try {
          const res2 = await fetchT(FleetMovements.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          const doc2 = res2.ok ? new DOMParser().parseFromString(await res2.text(), "text/html") : null;
          const row2 = doc2 && (fleetId ? doc2.querySelector(`tr[data-fleet-id="${fleetId}"]`) : this._findOurRow(doc2, st));
          if (!row2 || /return|powr|zawr/i.test((row2.className || "") + " " + (row2.textContent || ""))) ok = true;
        } catch {}
        if (ok) {
          // v2.100.0 (D4): zostały jeszcze nasze loty (fale z zamiatania)?
          // Zawracamy po jednym na tick — próby liczone od nowa per lot.
          // v2.100.1 (F5): zawrócony lot zapamiętany po id — fork, który znaczy
          // powrót tylko tekstem, nie wciągnie go drugi raz na listę.
          const recalledIds = [...(st.recalledIds || []), ...(fleetId ? [fleetId] : [])];
          st = { ...st, recalledIds };
          let left = 0;
          try {
            const res3 = await fetchT(FleetMovements.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
            if (res3.ok) left = this._findOurRows(new DOMParser().parseFromString(await res3.text(), "text/html"), st).length;
          } catch {}
          if (left > 0) {
            this.save({ ...st, recallTries: 0, recalledSome: (st.recalledSome || 0) + 1 });
            log(`[UCIECZKA] lot zawrócony, zostało jeszcze ${left} — zawracam kolejny w następnym przebiegu.`, "success");
            return;
          }
          this.save({ ...st, recallTries: tries, phase: "recalled", recalledAt: Date.now() });
          log(`[UCIECZKA] flota ZAWRÓCONA${st.recalledSome ? ` (${(st.recalledSome || 0) + 1} loty)` : ""} — wraca do domu. Ataki przeszły w pustkę.`, "success");
          ThreatLog.add("POWRÓT", "UCIECZKA W POWIETRZE: flota zawrócona po przejściu ataków — wraca do domu.");
        } else {
          log(`[UCIECZKA] zawrócenie niepotwierdzone (próba ${tries}/5) — ponowię.`, "warn");
        }
      } finally { this._recalling = false; }
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  LLM PARSER (v2.64.0) — Gemini czyta to, czego parsery nie rozumieją
  // ═══════════════════════════════════════════════════════════════
  // Powracający ból tego projektu to markup: „unknown message markup",
  // zgadywanie struktur, pięć wersji do kosza. LLM dostaje surowy HTML
  // i zwraca liczby — niezależnie od formatu, w jakim fork je renderuje.
  //
  // TWARDA ZASADA: model TYLKO CZYTA. Żadna decyzja o flocie (ratunek,
  // powrót, FS, dobór minerów w locie) nie przechodzi przez LLM — obrona
  // i wysyłka są deterministyczne i takie zostają. Model zasila wyłącznie
  // statystykę urobku, którą i tak wygładza percentyl z 20 próbek.
  //
  // Klucz: pole w panelu → GM storage. NIGDY w repo — skrypt jest publicznie
  // serwowany przez auto-update, wpisany na stałe klucz byłby jawny.
  const LlmParser = {
    KEY_API: "ogamex_llm_key",
    KEY_USED: "ogamex_llm_used",     // { day: "YYYY-MM-DD", n }
    KEY_SEEN: "ogamex_llm_seen",     // hashe już rozliczonych raportów
    MODEL: "gemini-2.5-flash",
    DAILY_LIMIT: 40,                  // darmowy limit to ~1500/dzień; nam starcza ułamek
    TIMEOUT_MS: 25 * 1000,

    apiKey() { return (GM_getValue(this.KEY_API, "") || "").trim(); },
    enabled() { return !!this.apiKey(); },

    _usedToday() {
      try {
        const u = JSON.parse(GM_getValue(this.KEY_USED, "null"));
        const today = new Date().toISOString().slice(0, 10);
        return u?.day === today ? (u.n || 0) : 0;
      } catch { return 0; }
    },
    _bumpUsed() {
      const today = new Date().toISOString().slice(0, 10);
      GM_setValue(this.KEY_USED, JSON.stringify({ day: today, n: this._usedToday() + 1 }));
    },

    // Prosty hash — do odróżniania raportów już policzonych od nowych.
    _hash(t) {
      let h = 0;
      for (let i = 0; i < t.length; i++) { h = ((h << 5) - h + t.charCodeAt(i)) | 0; }
      return String(h);
    },
    _seen() { try { return JSON.parse(GM_getValue(this.KEY_SEEN, "[]")); } catch { return []; } },
    _markSeen(ids) {
      const all = [...new Set([...this._seen(), ...ids])].slice(-300);
      GM_setValue(this.KEY_SEEN, JSON.stringify(all));
    },

    _call(prompt) {
      return new Promise((resolve) => {
        const body = JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // v2.64.1: thinkingBudget 0 — do wyciągania liczb z HTML „myślenie"
          // modelu nic nie wnosi, a na płatnym tierze liczy się jak tokeny
          // wyjściowe (najdroższe). Krótsza odpowiedź = niższy koszt i latencja.
          generationConfig: { temperature: 0, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
        });
        GM_xmlhttpRequest({
          method: "POST",
          url: `https://generativelanguage.googleapis.com/v1beta/models/${this.MODEL}:generateContent?key=${encodeURIComponent(this.apiKey())}`,
          headers: { "Content-Type": "application/json" },
          data: body,
          timeout: this.TIMEOUT_MS,
          onload: (res) => {
            try {
              const j = JSON.parse(res.responseText);
              const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
              resolve(txt ? JSON.parse(txt) : null);
            } catch { resolve(null); }
          },
          onerror: () => resolve(null),
          ontimeout: () => resolve(null),
        });
      });
    },

    // ── v2.66.0: druga para oczu dla obrony — WYŁĄCZNIE eskalacja ──
    // Wołane tylko, gdy deterministyczna klasyfikacja mówi „obce floty są,
    // ale żadna nie jest atakiem". Model może wtedy PODNIEŚĆ alarm (fałszywy
    // alarm kosztuje dwa przeloty), ale nigdy go nie zdejmuje i nigdy nie
    // rusza flotą — odpowiedź „to nie atak" niczego nie zmienia.
    KEY_DEF_SEEN: "ogamex_llm_def_seen",
    async classifyThreat(rowsHtml, signature) {
      if (!this.enabled()) return null;
      if (this._usedToday() >= this.DAILY_LIMIT) return null;
      let seen = [];
      try { seen = JSON.parse(GM_getValue(this.KEY_DEF_SEEN, "[]")); } catch {}
      if (seen.includes(signature)) return null;   // ten obraz już oceniony
      GM_setValue(this.KEY_DEF_SEEN, JSON.stringify([...seen, signature].slice(-40)));
      this._bumpUsed();
      const out = await this._call(
        "Poniżej wiersze z listy ruchów flot w grze typu OGame. To są CUDZE floty "
        + "lecące w stronę gracza. Oceń, czy KTÓRAKOLWIEK z tych misji może być wrogim "
        + "atakiem na gracza (atak, rakiety, zniszczenie księżyca). Szpiegowanie i handel "
        + "NIE są atakiem. Zwróć wyłącznie JSON: {\"attack\":true/false,\"target\":\"g:s:p lub null\",\"why\":\"krótko\"}.\n\nHTML:\n"
        + String(rowsHtml || "").replace(/\s+/g, " ").slice(0, 12000)
      );
      if (!out || typeof out.attack !== "boolean") return null;
      return out;
    },

    // HTML dziennika/wiadomości → [{id, resources}] dla misji górniczych.
    // Zwraca liczbę NOWO zapisanych próbek urobku (0 = nic nowego / porażka).
    async extractYields(html, sourceLabel) {
      if (!this.enabled()) return 0;
      if (this._usedToday() >= this.DAILY_LIMIT) return 0;
      const trimmed = String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/\s+/g, " ").slice(0, 28000);
      if (trimmed.length < 100) return 0;
      // Dławik na źródło: ten sam HTML nie leci do modelu drugi raz.
      const pageHash = `page:${this._hash(trimmed)}`;
      if (this._seen().includes(pageHash)) return 0;
      this._bumpUsed();
      const out = await this._call(
        "Poniżej HTML z dziennika misji w grze przeglądarkowej (fork OGame). "
        + "Wypisz WSZYSTKIE raporty z wypraw górniczych na asteroidy (asteroid mining), "
        + "które zawierają zebrane surowce. Dla każdego policz SUMĘ metal+kryształ+deuter. "
        + "Zwróć wyłącznie JSON: {\"reports\":[{\"id\":\"<data lub unikalny fragment>\",\"resources\":<liczba>}]}. "
        + "Liczby w grze używają kropek/spacji jako separatorów tysięcy. "
        + "Pomiń raporty bojowe, szpiegowskie i ekspedycyjne. Jeśli nic nie ma: {\"reports\":[]}.\n\nHTML:\n" + trimmed
      );
      if (!out || !Array.isArray(out.reports)) {
        log(`[LLM] ${sourceLabel}: model nie zwrócił poprawnego JSON — zostaję przy starych parserach.`, "warn");
        return 0;
      }
      const seen = this._seen();
      const fresh = [];
      for (const r of out.reports) {
        const res = Number(r?.resources);
        if (!Number.isFinite(res) || res <= 0 || res > 1e18) continue;
        const id = `rep:${this._hash(String(r.id || "") + "|" + res)}`;
        if (seen.includes(id)) continue;
        fresh.push({ id, res });
      }
      this._markSeen([pageHash, ...fresh.map(f => f.id)]);
      for (const f of fresh) AsteroidYieldTracker.recordYield(f.res);
      if (fresh.length) log(`[LLM] ${sourceLabel}: odczytano ${fresh.length} nowy(ch) raport(ów) urobku (użycia dziś: ${this._usedToday()}/${this.DAILY_LIMIT}).`, "success");
      return fresh.length;
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
    // v2.61.0: adresy, które choć raz odpowiedziały poprawnie. Podczas awarii
    // (strona błędu, restart aplikacji .NET) KAŻDA trasa potrafi chwilowo oddać
    // 404 — trwałe wyłączenie po jednej czkawce zabrałoby obronie jej główne
    // źródło (fleetmovementlist) na zawsze i to dokładnie wtedy, gdy jest
    // najbardziej potrzebne. Sprawdzony adres nie może umrzeć od jednego 404.
    KEY_PROVEN: "ogamex_api_proven_paths",
    _dead() { try { return JSON.parse(GM_getValue(this.KEY_SUPPORT, "{}")); } catch { return {}; } },
    _proven() { try { return JSON.parse(GM_getValue(this.KEY_PROVEN, "{}")); } catch { return {}; } },
    supported(url) {
      if (!url) return true;
      const path = String(url).split("?")[0];
      return !this._dead()[path];
    },
    markWorking(url) {
      const path = String(url).split("?")[0];
      const ok = this._proven();
      if (ok[path]) return;
      ok[path] = Date.now();
      GM_setValue(this.KEY_PROVEN, JSON.stringify(ok));
    },
    markUnsupported(url, status) {
      const path = String(url).split("?")[0];
      // Tylko 404/405 znaczy „trasa nie istnieje". 5xx / przekierowanie /
      // timeout to awaria chwilowa, nie wyrok.
      if (status !== 404 && status !== 405) return;
      if (this._proven()[path]) {
        log(`[API] ${path} → ${status}, ale ten adres już wcześniej działał — traktuję jako czkawkę serwera, NIE wyłączam go.`, "warn");
        return;
      }
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
    KEY_EXCESS_SINCE: "ogamex_bar_excess_since", // v2.104.2: od kiedy trwa BIEŻĄCA nadwyżka paska (kotwica „może być sondą")
    KEY_EXCESS_LAND: "ogamex_bar_excess_land",   // v2.104.3: zapamiętane lądowanie sond tłumaczących nadwyżkę (nie kurczy się z eta)
    CONFIRM_MS: 25 * 1000,                    // tyle musi się utrzymać, zanim ruszymy flotą
    SELF_SEND_BLIND_MS: 10 * 1000,            // v2.102.0: 20→10 s (D-F6) — tyle po NASZEJ wysyłce pasek kłamie
    CONFIRM_BAR_MS: 12 * 1000,                // v2.102.0 (D-F5): atak widoczny TYLKO na pasku (lista ślepa = z układu) potwierdza się szybciej
    KEY_SEEN: "ogamex_threat_last_seen",      // v2.29.0: co pasek pokazał ostatnio
    KEY_SEEN_AT: "ogamex_threat_last_seen_at",
    // ── v2.99.1: ostatni AUTORYTATYWNY odczyt (pasek/cache/świeże zdarzenia) ──
    // KEY_SEEN_AT stempluje też odczyty ŚLEPE, więc do mierzenia ślepoty jest
    // bezużyteczny — potrzebny osobny zegar, który rusza tylko, gdy naprawdę
    // COŚ widzieliśmy.
    KEY_SIGHT_AT: "ogamex_threat_sight_at",
    KEY_BLIND_NAV_AT: "ogamex_threat_blind_nav_at",
    BLIND_NAV_MS: 5 * 60 * 1000,   // tyle ślepoty przy uzbrojonej obronie uzasadnia wymuszony przegląd
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
    // v2.102.0 (blok D): syntetyczne wrogie wiersze w kształcie forka
    // (row-mission-type-ATTACK row-hostile-mission, .fleet-source-coords,
    // data-remaining-seconds, ikona księżyca przy celu) — przechodzą przez
    // PRAWDZIWY classifyRow. Tryby: moon (1 atak na księżyc, 150 s),
    // planet (na planetę), both (księżyc 150 s + planeta 300 s → ucieczka
    // w powietrze). ETA maleje z czasem jak przy prawdziwym locie.
    simRows() {
      const simUntil = parseInt(GM_getValue("ogamex_threat_sim_until", "0")) || 0;
      if (!simUntil || Date.now() >= simUntil) return [];
      const mode = String(GM_getValue("ogamex_threat_sim_mode", "moon") || "moon");
      const startedAt = parseInt(GM_getValue("ogamex_threat_sim_started", "0")) || Date.now();
      // v2.103.1: cel symulacji = para, na której operator STAŁ przy starcie
      // (zapisana w ogamex_threat_sim_target). Incydent 21:19: flota stała na
      // księżycu [5:67:5], a symulacja biła w bazę z konfiguracji [3:272:7] —
      // hangar pusty, „nothing to save", zero testu. Fallback: baza z configu.
      let b = null;
      try { b = JSON.parse(GM_getValue("ogamex_threat_sim_target", "null")); } catch {}
      if (!b || !Number.isFinite(b.galaxy)) b = CONFIG.expeditions?.launchFrom || CONFIG.asteroidMining.minerBase;
      if (!b || !Number.isFinite(b.galaxy)) return [];
      const key = `${b.galaxy}:${b.system}:${b.position}`;
      const etaOf = (base) => Math.max(5, Math.round((startedAt + base * 1000 - Date.now()) / 1000));
      const mk = (body, base) => {
        const eta = etaOf(base);
        return `<tr class="row-mission-type-ATTACK row-hostile-mission" data-fleet-id="sim-${body}">`
          + `<td><span class="fleet-source-coords">[9:999:9]</span> Symulator</td>`
          + `<td><span data-remaining-seconds="${eta}">${eta}s</span></td>`
          + `<td>${body === "moon" ? '<img src="/img/moon-icon.png">' : ""}<a href="#">[${key}]</a> ${body === "moon" ? "Moon" : "Planet"}</td></tr>`;
      };
      const html = mode === "both" ? mk("moon", 150) + mk("planet", 300) : mk(mode === "planet" ? "planet" : "moon", 150);
      const doc = new DOMParser().parseFromString(`<table><tbody>${html}</tbody></table>`, "text/html");
      const own = this.ownBodies();
      return [...doc.querySelectorAll("tr")].map(tr => ({ ...FleetMovements.classifyRow(tr, own), sim: true }));
    },

    // v2.102.4: ciała celu dla pary = żywa lista ∪ pamięć (ważna tylko póki atak
    // tej pary leci). Lista forka gubi wiersze ACS między odczytami — bez tego
    // flipy formularza, zamiatanie i decyzja ucieczki w powietrze ślepły w
    // najgorszym momencie.
    // ── BAR-EXCESS (v2.104.0) — CZYSTA decyzja o nadwyżce paska (test-nadwyzka.js) ──
    // Kotwica czasu = start kandydata (nie chwila odczytu — 2.103.3 odnawiała
    // czekanie co tick i nadwyżka z wylądowanymi sondami NIGDY się nie
    // potwierdzała: kształt 16:14/16:21 z prawdziwego ataku). Czekanie tylko,
    // gdy nadwyżkę mogą tłumaczyć sondy WYLĄDOWANE (w locie są już odjęte),
    // cap 120 s (daleka sonda nie może zamrozić potwierdzenia ataku z układu).
    // Pasek z cache + sondy na liście = dwie różne chwile → krótkie czekanie
    // (20 s od kandydata) na żywy pasek, ale nadwyżka ZOSTAJE (woli alarm).
    // v2.104.2 — FAŁSZYWE „OBA CIAŁA" 26.08 16:03/16:06: atak TYLKO na księżyc,
    // wylądowana sonda na liście, pasek 2 vs lista 1 → nadwyżka 1 „może być
    // sondą" — ale kotwicą był firstAt ALARMU (16:02:26), więc czekanie 10 s
    // minęło zanim się zaczęło → excess>0 → attackBodiesFor dołożył oba ciała
    // → ucieczka w powietrze z 11 GŚ na 10% = 4 h 24 min lotu bez ataku na
    // planetę. Kotwica = początek TEJ nadwyżki (excessSince, ustawiany w check()
    // przy przejściu 0→>0, kasowany przy 0), nie starsza od kandydata.
    barExcessDecision({ barForeign, barSpyOnly, barSpyType, barCached, attacks, spies, spiesInFlight, spyMaxEta, barCountsProbes, candidateAt, excessSince, landAt, now }) {
      // v2.104.6: pasek „1 Hostile, Type: Spy” = jedyny obcy lot to sonda —
      // nie ma czego traktować jak atak (lista ataków nadal liczy się osobno).
      if (barSpyOnly && (barForeign || 0) === 1 && (attacks || 0) === 0) return { excess: 0, listForeign: 0, waitUntil: 0, why: "pasek: Type Spy — sonda, nie atak" };
      // v2.105.5 (decyzja operatora 26.08): pasek „Type: Spy” + lista bez
      // ataków = SONDY, flota NIE rusza — niezależnie od liczby. Ryzyko
      // szczątkowe: atak z własnego układu (lista go gubi) lecący ZA sondą —
      // pokaże się w pasku po lądowaniu sondy jako Type ≠ Spy → alarm wtedy.
      if (barSpyType && (attacks || 0) === 0) return { excess: 0, listForeign: 0, waitUntil: 0, why: "pasek: Type Spy — sondy, nie atak" };
      const inFlight = barCountsProbes ? (spies || 0) : (spiesInFlight || 0);
      const listForeign = (attacks || 0) + inFlight;
      const excess = Math.max(0, (barForeign || 0) - listForeign);
      const anchor = Math.max(candidateAt || 0, excessSince || 0) || now;
      if (excess <= 0) return { excess: 0, listForeign, waitUntil: 0, why: "" };
      if (barCached && (spies || 0) > 0) return { excess, listForeign, waitUntil: anchor + 20000, why: "pasek z cache + sondy — czekam na żywy pasek" };
      const landed = Math.max(0, (spies || 0) - inFlight);
      // v2.104.3 — 26.08 16:33: 3 sondy, pasek 3→2, lista 0 ataków. Stare okno
      // = kotwica + eta(TERAZ) + 10 s kurczyło się z każdym tickiem, bo eta
      // maleje — 1 s po lądowaniu sond „minęło" i alarm ruszył flotą, choć
      // pasek zdjął sondy 4 s później. Koniec czekania = LĄDOWANIE (now+eta)
      // + 30 s karencji na odświeżenie paska, nie mniej niż kotwica + 30 s,
      // cap kotwica + 150 s (16:22: wylądowane sondy + ukryty ACS → alarm po 30 s).
      // v2.104.4 — 26.08 16:45: pasek 4, lista 0 ataków + 2 sondy → nadwyżka 4 > 2
      // „nie może być sondą” → alarm po 12 s → ucieczka w powietrze. Przy roju
      // sond lista i pasek gubią wiersze w różnym tempie, więc LICZBY nie
      // rozstrzygają — rozstrzyga TRWAŁOŚĆ: sondy znikają z paska w kilkanaście
      // sekund, atak wisi minuty. Jakiekolwiek sondy na liście → nadwyżka musi
      // utrzymać się ≥ 60 s od początku (i ≥ 30 s po lądowaniu sond), cap 150 s.
      // Bez sond (13:10) — bez czekania, jak dotąd.
      if ((spies || 0) > 0) {
        // Lądowanie ZAPAMIĘTANE (landAt z check(), max przez czas nadwyżki) — liczone
        // od nowa z eta=0 przesuwałoby się z każdym odczytem (błąd 2.103.3).
        const landNow = (spyMaxEta || 0) > 0 ? now + Math.min(spyMaxEta, 120) * 1000 : 0;
        const land = Math.max(anchor, landAt || 0, landNow);
        const waitUntil = Math.min(Math.max(anchor + 60000, land + 30000), anchor + 150000);
        return { excess, listForeign, waitUntil, why: excess <= landed ? "nadwyżka może być sondą" : "sondy na liście — czekam na trwałość", landAt: land };
      }
      return { excess, listForeign, waitUntil: 0, why: "" };
    },
    // ── /BAR-EXCESS ──

    attackBodiesFor(key) {
      const out = new Set();
      try { for (const b of ((this.events()?.targetBodiesAll || {})[key] || [])) out.add(b); } catch {}
      try {
        const m = JSON.parse(GM_getValue("ogamex_atk_body_" + key, "null"));
        if (m && m.until && Date.now() < m.until) for (const b of (m.bodies || (m.body ? [m.body] : []))) out.add(b);
      } catch {}
      // nadwyżka paska przy uzbrojonej straży = niewidoczny wiersz = nie wiemy,
      // w które ciało → traktuj jak OBA (ucieczka w powietrze; flota w locie jest nietykalna)
      // v2.104.0 (audyt): TYLKO dla pary strzeżonej — klauzula dla każdej pary
      // robiła „oba ciała" drugiej kolonii z kolejki i blokowała jej ratunek.
      try { const st = this.state(); const w = MoonSave.watch(); if (st && st.count > 0 && (st.excess || 0) > 0 && w.armed && RescueQueue.str(w.at) === key) { out.add("moon"); out.add("planet"); } } catch {}
      return [...out];
    },
    attackBodyFor(key) {
      try { const live = (this.events()?.targetBodies || {})[key]; if (live) return live; } catch {}
      try { const m = JSON.parse(GM_getValue("ogamex_atk_body_" + key, "null")); if (m && m.until && Date.now() < m.until && m.body) return m.body; } catch {}
      return null;
    },

    ownBodies() {
      const set = new Set();
      for (const opt of document.querySelectorAll("#planetShortcutSelect option[value]")) {
        const m = String(opt.value).match(/^(PLANET|MOON)-(\d+)-(\d+)-(\d+)$/);
        if (m) set.add(`${m[2]}:${m[3]}:${m[4]}`);
      }
      // v2.102.0 (D-F3): także z paska planet (koordy w tekście kotwic) —
      // nowa kolonia spoza selecta liczyła się jako „obca".
      for (const a of document.querySelectorAll("a.planet-select, .planet-select, a.moon-select, .moon-select")) {
        const m = (a.textContent || "").replace(/\s+/g, " ").match(/(\d+):(\d+):(\d+)/);
        if (m) set.add(`${m[1]}:${m[2]}:${m[3]}`);
      }
      if (set.size) GM_setValue("ogamex_own_bodies", JSON.stringify([...set]));
      else { try { for (const c of JSON.parse(GM_getValue("ogamex_own_bodies", "[]"))) set.add(c); } catch {} }
      return set;
    },

    async refreshEvents() {
      if (this._evFetching) return;
      this._evFetching = true;
      try {
        // ── v2.67.0: SYMULACJA ATAKU (przycisk w panelu) ──
        // Obawa właściciela po zawracaniu FS: „automatyczne podnoszenie floty
        // też może nie zadziałać". Czytanie kodu tego nie rozstrzygnie —
        // symulacja przepuszcza syntetyczny atak na bazę przez PRAWDZIWĄ
        // maszynerię: kandydat → potwierdzenie 25 s → alarm → autoSaveOnThreat
        // → realna ewakuacja → po wygaśnięciu okna prawdziwe odczyty gaszą
        // alarm → auto-powrót. Jedyne, czego nie testuje, to parsowanie
        // wrogiego wiersza HTML — a ten sam parser poprawnie rozczytał sondę
        // szpiegowską 04.08 09:49.
        {
          const simUntil = parseInt(GM_getValue("ogamex_threat_sim_until", "0")) || 0;
          // ── v2.102.0 (audyt 25.08, blok D): symulacja PRZEZ PARSER ──
          // Dotąd symulacja wpisywała gotowe zdarzenie i wracała PRZED siecią —
          // nie testowała listy ruchów, arbitrażu pasek-vs-lista, ciała celu,
          // blitza ani strażnika bezpiecznej strony. Teraz syntetyczny WROGI
          // WIERSZ HTML (kształt forka) wchodzi do FleetMovements.classifyRow
          // razem z prawdziwymi wierszami — patrz simRows() i wstrzyknięcie niżej.
          if (simUntil && Date.now() >= simUntil) {
            GM_setValue("ogamex_threat_sim_until", "0");
            try {
              GM_setValue("ogamex_atk_until", "0"); GM_setValue("ogamex_atk_fuse", "0");
              // v2.104.0: sprzątaj pamięć dla CELU symulacji (od 2.103.1 ≠ baza z configu) i jej klucze.
              let b = null; try { b = JSON.parse(GM_getValue("ogamex_threat_sim_target", "null")); } catch {}
              if (!b || !Number.isFinite(b.galaxy)) b = CONFIG.expeditions?.launchFrom || CONFIG.asteroidMining.minerBase;
              if (b) { const k = `${b.galaxy}:${b.system}:${b.position}`; GM_setValue("ogamex_atk_body_" + k, "null"); let map = {}; try { map = JSON.parse(GM_getValue("ogamex_atk_until_map", "{}")) || {}; } catch {} delete map[k]; GM_setValue("ogamex_atk_until_map", JSON.stringify(map)); }
              GM_setValue("ogamex_threat_sim_target", "null"); GM_setValue("ogamex_threat_sim_started", "0");
            } catch {}
            log("[TEST] symulacja ataku zakończona — obrona wraca na prawdziwe odczyty. Alarm powinien zaraz zgasnąć, a flota wrócić automatycznie.", "info");
          }
        }
        const hdr = { headers: { "X-Requested-With": "XMLHttpRequest" } };
        // ── v2.51.0: prawdziwe źródło — lista ruchów flot ──
        // Wiersz podaje typ misji NAZWĄ (row-mission-type-ATTACK / ESPIONAGE /
        // EXPEDITION), źródło, cel i czas do przylotu. To zamyka trzy braki
        // naraz: sonda nie rusza już flotą, znamy atakowaną kolonię i mamy
        // skład napastnika do dziennika.
        const fm = await FleetMovements.fetch().catch(() => ({ ok: false, rows: [] }));
        try {
          const simRows = this.simRows();
          if (simRows.length) { fm.ok = true; fm.rows = [...(fm.rows || []), ...simRows]; fm.simInjected = true; }
        } catch (e) { log(`[TEST] symulacja: błąd budowy wiersza (${e.message})`, "error"); }
        if (fm.ok) {
          // v2.86.2: sojusznicy (row-friendly-mission) poza WSZYSTKIMI
          // licznikami zagrożeń — inaczej stacjonowanie kolegi podbijało
          // ev.hostile i gałąź „BEZ klasyfikacji" wołała alarm.
          const foreign = fm.rows.filter(r => !r.mine && !r.friendly);
          const attacks = foreign.filter(r => r.attack);
          const spies = foreign.filter(r => r.spy);
          // ── v2.88.0: PANEL EVENTS (żywy DOM + cache 3 min) — trzecie źródło ──
          // Dokłada wiersze, których lista NIE ODDAŁA (13:07: atak z układu
          // widoczny tylko jako goły licznik paska — bez celu, dolotu, ciała,
          // więc nie wstawał blitz ani ucieczka w powietrze). Wiersze panelu
          // wchodzą do tej samej klasyfikacji co wiersze listy, więc cel,
          // dolot i ciało trafiają w te same mapy — blitz i air-save działają
          // z automatu. Dedup po (cel, rodzaj, dolot ±20 s).
          try {
            const pRows = EventsPanel.read();
            if (pRows.length) {
              const keyOf = r => `${r.dst}|${r.attack ? "A" : "S"}|${Math.round((r.eta || 0) / 20)}`;
              const have = new Set(foreign.map(keyOf));
              let added = 0;
              for (const pr of pRows) {
                if (have.has(keyOf(pr))) continue;
                have.add(keyOf(pr));
                foreign.push(pr);
                if (pr.attack) attacks.push(pr); else if (pr.spy) spies.push(pr);
                added++;
              }
              if (added) log(`[THREAT] panel Events dołożył ${added} wiersz(e), których lista ruchów nie oddała.`, "warn");
            }
          } catch (e) { log(`[THREAT] panel Events: ${e.message}`, "warn"); }
          // ── v2.67.1: materiał dowodowy — surowy HTML wrogich wierszy ──
          // Jednorazowo na każdy NOWY obraz wrogich flot (nie co 30 s): to,
          // czego będzie trzeba do naprawy, gdyby klasyfikacja źle odczytała
          // prawdziwy atak. Sondy pomijamy — ich odczyt jest już potwierdzony.
          if (attacks.length) {
            const sigH = attacks.map(r => r.id || `${r.type}|${r.src}|${r.dst}`).sort().join(";");
            let seenH = null;
            try { seenH = JSON.parse(GM_getValue("ogamex_atk_dom_sig", "null")); } catch {}
            if (!seenH || seenH.sig !== sigH) {
              GM_setValue("ogamex_atk_dom_sig", JSON.stringify({ sig: sigH, at: Date.now() }));
              for (const r of attacks.slice(0, 3)) {
                log(`[ATAK DOM] wrogi wiersz (${r.type}${r.unknownType ? " — TYP SPOZA ZNANYCH LIST" : ""}): ${r.html || "(brak html)"}`, "error");
              }
              ThreatLog.add("ATAK", `Zrzucono surowy HTML ${Math.min(attacks.length, 3)} wrogiego(-ich) wiersza(-y) do logu głównego — materiał do weryfikacji klasyfikacji.`);
            }
          }
          // ── v2.85.0: mapy per kolonia ──
          // • cele w kolejności NAJKRÓTSZEGO dolotu (kolonia, w którą
          //   uderzenie przyjdzie najwcześniej, ratowana pierwsza),
          // • ciało celu PER KOLONIA (dotąd globalne z 1. wiersza — przy
          //   ataku mieszanym druga kolonia polegała tylko na zapasowym
          //   bezpieczniku pustego hangaru),
          // • zestaw ciał + najdłuższy dolot per kolonia — wyzwalacz
          //   i zegar zawrócenia UCIECZKI W POWIETRZE.
          const byDst = new Map(); // dst -> { minEta, maxEta, bodies:Set, body }
          for (const r of attacks) {
            if (!r.dst) continue;
            const e = Number.isFinite(r.eta) && r.eta > 0 ? r.eta : 9e9;
            const rec = byDst.get(r.dst) || { minEta: Infinity, maxEta: 0, bodies: new Set(), body: null };
            if (e < rec.minEta) { rec.minEta = e; rec.body = r.dstBody || rec.body; }
            if (e !== 9e9 && e > rec.maxEta) rec.maxEta = e;
            if (r.dstBody) rec.bodies.add(r.dstBody);
            byDst.set(r.dst, rec);
          }
          const dstSorted = [...byDst.keys()].sort((a, b) => byDst.get(a).minEta - byDst.get(b).minEta);
          const out = {
            at: Date.now(),
            hostile: foreign.length,
            sim: !!fm.simInjected,   // v2.102.0: syntetyczne wiersze w tym odczycie
            attacks: attacks.length,
            spies: spies.length,
            // v2.102.3 (ATAK 16:22): sondy W LOCIE liczą się w pasku, wylądowane (eta≈0)
            // nie — tylko te pierwsze mogą „tłumaczyć" obcych z paska.
            spiesInFlight: spies.filter(r => Number.isFinite(r.eta) && r.eta > 30).length,
            spyMaxEta: Math.max(0, ...spies.map(r => (Number.isFinite(r.eta) && r.eta < 48 * 3600) ? r.eta : 0)),
            classified: true,
            targets: dstSorted,
            origins: [...new Set(attacks.map(r => r.src).filter(Boolean))],
            // v2.70.0: w KTÓRE ciało leci atak (ikona przy celu w wierszu) —
            // pozwala nie ruszać floty stojącej po bezpiecznej stronie.
            // (zostaje globalnie dla kompatybilności; nowe odczyty biorą mapy)
            targetBody: (attacks.find(r => r.dstBody) || {}).dstBody || null,
            targetBodies: Object.fromEntries(dstSorted.filter(k => byDst.get(k).body).map(k => [k, byDst.get(k).body])),
            targetBodiesAll: Object.fromEntries(dstSorted.map(k => [k, [...byDst.get(k).bodies]])),
            targetMaxEta: Object.fromEntries(dstSorted.map(k => [k, byDst.get(k).maxEta || null])),
            // v2.101.0: NAJKRÓTSZY dolot per kolonia — zegar zamiatania wg powrotów.
            atkUntil: (() => { let m = 0; for (const r of attacks) { if (Number.isFinite(r.eta) && r.eta > 0 && r.eta < 48 * 3600) m = Math.max(m, Date.now() + Math.min(r.eta, 3 * 3600) * 1000); } return m || null; })(),
            targetMinEta: Object.fromEntries(dstSorted.map(k => [k, Number.isFinite(byDst.get(k).minEta) && byDst.get(k).minEta < 9e9 ? byDst.get(k).minEta : null])),
            // v2.70.1: najkrótszy czas dolotu ataku — blitz z sąsiedniego
            // układu (<2 min) nie może czekać na pełne potwierdzenie.
            minEta: attacks.length ? Math.min(...attacks.map(r => r.eta || 9e9)) : null,
          };
          // ── v2.53.0: kontrola krzyżowa z paskiem misji ──
          // /home/fleetmovementlist zweryfikowałem WYŁĄCZNIE na naszych własnych
          // wierszach — nikt jeszcze nie leciał na nas od czasu wdrożenia. Jeśli
          // ta lista pokazuje tylko FLOTY WŁASNE, to v2.51.0 nie „poprawiła"
          // wykrywania, tylko je WYŁĄCZYŁA: obcych zawsze zero, alarm nigdy nie
          // wstaje. Pasek misji liczy floty na całym koncie, więc rozbieżność
          // „pasek widzi obcych, lista nie" jest jedynym sygnałem, jaki mamy.
          // W razie rozbieżności wygrywa pasek — mniej wie, ale wie na pewno.
          // ── v2.66.0: Gemini jako drugie oko (tylko eskalacja) ──
          // Deterministyka mówi „obcy są, ale to nie atak" — poproś model
          // o niezależną ocenę. „Atak" od modelu podnosi kandydata alarmu;
          // „nie atak" NIE zmienia niczego.
          if (foreign.length > 0 && attacks.length === 0 && LlmParser.enabled()) {
            const sig = foreign.map(r => `${r.type}|${r.src}|${r.dst}`).sort().join(";");
            const rowsHtml = foreign.map(r => `<row type="${r.type}" from="${r.src}" to="${r.dst}" eta="${r.eta}s" ships="${(r.ships || []).join(", ")}"/>`).join("\n");
            LlmParser.classifyThreat(rowsHtml, sig).then(v => {
              if (v?.attack) {
                log(`[GEMINI] drugie oko widzi ATAK (${v.why || "bez uzasadnienia"}, cel: ${v.target || "?"}) — podnoszę kandydata alarmu.`, "error");
                ThreatLog.add("ATAK", `GEMINI eskalacja: ${v.why || ""} cel ${v.target || "?"} (deterministyka nie sklasyfikowała ataku).`);
                const prev = { ...(this.events() || {}) };
                prev.attacks = Math.max(1, prev.attacks || 0);
                // v2.102.0 (C-F4): model NIE może wskazać obcych koordynatów jako celu —
                // switchTo padałby co tick i blokował ratunek.
                if (v.target && /^\d+:\d+:\d+$/.test(v.target) && this.ownBodies().has(v.target)) prev.targets = [v.target];
                prev.at = Date.now();
                GM_setValue(this.KEY_EVENTS, JSON.stringify(prev));
              }
            }).catch(() => {});
          }
          const barNow = this.read();
          // v2.75.5: rozbieżność LICZBY, nie tylko zupełna ślepota. 07.08
          // 08:25 pasek widział obcego, lista pokazała TYLKO sondę (atak
          // grupowy nie wszedł na listę albo ukrył się pod nazwą) — warunek
          // `foreign.length === 0` nie łapał, sonda maskowała atak, kandydat
          // został skasowany i 92,8 mld statków leciało bez alarmu. Gdy pasek
          // widzi WIĘCEJ obcych niż lista, brakujące wiersze to niewiadoma —
          // a niewiadoma to atak: schodzimy na ścieżkę paska (25 s
          // potwierdzenia + okno ślepoty po własnej wysyłce nadal działają).
          // ── v2.102.4: PAMIĘĆ ATAKU per para (dolot, ciała) — pisana tu, PRZED
          // gałęzią nadwyżki paska (tam lista nie trafiała do KEY_EVENTS, więc
          // pamięć nie powstawała dokładnie wtedy, gdy była najbardziej potrzebna).
          // ETA z sensem (0 < eta < 48 h), sufit 3 h; bezpiecznik powrotu (fuse)
          // maks. 20 min — wabik z dolotem za 6 h nie zablokuje powrotu na 6 h.
          try {
            if (attacks.length) {
              let map = {}; try { map = JSON.parse(GM_getValue("ogamex_atk_until_map", "{}")) || {}; } catch {}
              const per = {};
              for (const r of attacks) {
                if (!r.dst) continue;
                const eta = Number.isFinite(r.eta) && r.eta > 0 && r.eta < 48 * 3600 ? Math.min(r.eta, 3 * 3600) : 0;
                const u = eta ? Date.now() + eta * 1000 : 0;
                const rec = per[r.dst] || { until: 0, bodies: new Set() };
                if (u > rec.until) rec.until = u;
                if (r.dstBody) rec.bodies.add(r.dstBody);
                per[r.dst] = rec;
              }
              let globalUntil = parseInt(GM_getValue("ogamex_atk_until", "0")) || 0;
              for (const k of Object.keys(per)) {
                const rec = per[k];
                if (rec.until > (map[k] || 0)) map[k] = rec.until;
                if (rec.until > globalUntil) globalUntil = rec.until;
                let old = null; try { old = JSON.parse(GM_getValue("ogamex_atk_body_" + k, "null")); } catch {}
                const bodies = new Set([...(old && old.until > Date.now() ? (old.bodies || []) : []), ...rec.bodies]);
                GM_setValue("ogamex_atk_body_" + k, JSON.stringify({ body: [...rec.bodies][0] || (old && old.body) || null, bodies: [...bodies], at: Date.now(), until: Math.max(rec.until, (old && old.until) || 0) }));
              }
              for (const k of Object.keys(map)) if (Date.now() - map[k] > 6 * 3600 * 1000) delete map[k];
              GM_setValue("ogamex_atk_until_map", JSON.stringify(map));
              GM_setValue("ogamex_atk_until", String(globalUntil));
              const fuse = Math.min(globalUntil, Date.now() + 20 * 60 * 1000);
              if (fuse > (parseInt(GM_getValue("ogamex_atk_fuse", "0")) || 0)) GM_setValue("ogamex_atk_fuse", String(fuse));
            }
          } catch {}
          if (barNow && barNow.foreign > foreign.length) {
            const warnAt = parseInt(GM_getValue("ogamex_fml_blind_warned_at", "0")) || 0;
            if (Date.now() - warnAt > 10 * 60 * 1000) {
              GM_setValue("ogamex_fml_blind_warned_at", String(Date.now()));
              log(`[THREAT] UWAGA: pasek pokazuje ${barNow.foreign} obcych flot, a lista ruchów tylko ${foreign.length}. Brakujące wiersze traktuję jak ATAK — obrona liczy z paska.`, "error");
              // ── v2.80.3: to jest STAN POSREDNI, nie werdykt ──
              // Do 2.80.2 szlo jako BLAD, czyli push na telefon z syrena.
              // 07.08 zapalilo sie trzy razy (09:56, 11:20, 15:03) i za kazdym
              // razem byla to sonda, ktora wyladowala MIEDZY dwoma odczytami:
              // lista zdazyla ja skasowac, pasek jeszcze liczyl.
              //
              // Push nie wnosil tu zadnej ochrony. Eskalacja to linijka nizej
              // — schodzimy na sciezke paska, ktora ma wlasne 25 s
              // potwierdzenia i przy prawdziwym ataku podnosi ALARM z pushem
              // o priorytecie pilnym. Zawiadomienie o samym rozjezdzie tylko
              // uczylo ignorowac zawiadomienia. Wpis zostaje w dzienniku,
              // czerwona linia w logu zostaje — znika wylacznie syrena.
              ThreatLog.add("odczyt", `Rozjazd zrodel: pasek ${barNow.foreign} obcych, lista ${foreign.length}. Zwykle sonda, ktora wyladowala miedzy odczytami. Obrona przechodzi na pasek i potwierdza 25 s; prawdziwy atak podniesie osobny ALARM.`);
            }
            // Nie kończymy tu: schodzimy do ścieżki paska niżej.
          } else {
          // ── v2.75.7: WERDYKT SERWERA PONAD NASZĄ KLASYFIKACJĄ ──
          // Lista ruchów flot mogła wiersz ataku ZOBACZYĆ, ale nazwać go
          // bezpiecznie (07.08 08:25 — atak grupowy pod nieznaną nazwą, sonda
          // zgadzała liczby, więc kontrola z paskiem milczała). Serwer liczy
          // wrogość sam, po typie misji, i ma inny markup — jeśli widzi więcej
          // ataków niż my, wygrywa ON. Rozjazd = alarm, nigdy odwrotnie:
          // przegapiony atak kosztuje flotę, fałszywy dwa przeloty.
          const srv = await this.fetchServerEvents().catch(() => null);
          if (srv) {
            // Gdy lista zdarzeń serwera dała się sklasyfikować, liczy się
            // WYŁĄCZNIE srv.attacks — ta liczba jest już odsiana po ŹRÓDLE
            // (nasze własne loty odpadają), więc farmienie nie podniesie
            // alarmu. Surowego licznika `hostile` używamy tylko wtedy, gdy
            // typów nie dało się odczytać — wtedy wszystko, czego nie
            // tłumaczą nasze sondy, jest atakiem.
            const srvAttacks = srv.classified
              ? srv.attacks
              : Math.max(0, (srv.hostile || 0) - out.spies);
            if (srvAttacks > out.attacks) {
              const before = out.attacks;
              out.attacks = srvAttacks;
              out.hostile = Math.max(out.hostile, srv.hostile || 0);
              for (const t of (srv.targets || [])) if (t && !out.targets.includes(t)) out.targets.push(t);
              for (const o of (srv.origins || [])) if (o && !out.origins.includes(o)) out.origins.push(o);
              const warnAt = parseInt(GM_getValue("ogamex_srv_mismatch_at", "0")) || 0;
              if (Date.now() - warnAt > 5 * 60 * 1000) {
                GM_setValue("ogamex_srv_mismatch_at", String(Date.now()));
                log(`[THREAT] ROZJAZD ŹRÓDEŁ: lista ruchów dała ${before} ataków (${out.spies} sond, ${foreign.length} obcych wierszy), a serwer widzi ${srv.hostile} wrogich (${srv.classified ? `${srv.attacks} ataków, ${srv.spies} sond` : "typów nie dało się odczytać"}). Wygrywa serwer — podnoszę alarm${out.targets.length ? ` na [${out.targets.join(", ")}]` : ""}.`, "error");
                ThreatLog.add("ATAK", `Rozjazd źródeł: lista ruchów ${before} ataków, serwer ${srv.hostile} wrogich flot. Alarm z werdyktu serwera${out.targets.length ? ` (cel: ${out.targets.join(", ")})` : " (celu nie znam — ucieczka na przeciwne ciało)"}.`);
              }
            }
          }
          // v2.102.3: PAMIĘĆ ATAKU — fork gubi wiersz ACS między odczytami (16:21:18→20,
          // 16:26:49→16:27:30). Ostatni widziany DOLOT i CIAŁO celu zostają w GM:
          // dopóki dolot nie minął, alarm nie gaśnie, powrót nie rusza, a ratunek
          // zna ciało celu nawet z samego paska.
          GM_setValue(this.KEY_EVENTS, JSON.stringify(out));
          if (attacks.length) {
            const first = attacks.sort((a, b) => (a.eta || 1e9) - (b.eta || 1e9))[0];
            const mins = first.eta ? Math.max(0, Math.round(first.eta / 60)) : null;
            // v2.59.0: pętla obrony chodzi co 30 s, więc bez dławienia ten wpis
            // wpadał do dziennika 120×/h przez cały czas trwania ataku — i przy
            // limicie 600 potrafiłby wypchnąć wpisy, dla których dziennik istnieje.
            // Nowy wpis tylko, gdy obraz się ZMIENIŁ (liczba/źródło/cel) albo
            // minęło 5 minut — ślad ciągłości zostaje, spam nie.
            const sig = `${attacks.length}|${first.type}|${first.src}|${first.dst}`;
            let lastSig = null;
            try { lastSig = JSON.parse(GM_getValue("ogamex_threat_atk_sig", "null")); } catch {}
            if (!lastSig || lastSig.sig !== sig || Date.now() - (lastSig.at || 0) > 5 * 60 * 1000) {
              GM_setValue("ogamex_threat_atk_sig", JSON.stringify({ sig, at: Date.now() }));
              // v2.70.0: wywiad — skąd (ciało+nazwa) i w które ciało leci.
              const bodyPl = (b, big) => b === "moon" ? (big ? "KSIĘŻYC" : "księżyca") : b === "planet" ? (big ? "PLANETĘ" : "planety") : "?";
              ThreatLog.add("ATAK", `${attacks.length}× ${first.type} z ${bodyPl(first.srcBody)}${first.srcName ? ` „${first.srcName}"` : ""} [${first.src}] na ${bodyPl(first.dstBody, true)} [${first.dst}]`
                + (mins !== null ? `, przylot za ~${mins} min` : "")
                + (first.ships?.length ? ` | flota: ${first.ships.slice(0, 8).join(", ")}` : ""));
            }
          }
          // ── v2.74.7: wywiad także dla NIE-ataków (sondy itp.) ──
          // 06.08 12:31: sonda z daleka wisiała w pasku minutami, podniosła
          // alarm — a w dzienniku nie został po niej ŻADEN ślad (skąd, czym).
          // Skład i źródło siedzą w tym samym tooltipie co przy atakach, więc
          // notujemy każdy nowy obraz obcych misji (sygnatura, nie co 30 s).
          const others = foreign.filter(r => !r.attack);
          if (others.length) {
            const sigS = others.map(r => r.id || `${r.type}|${r.src}|${r.dst}`).sort().join(";");
            let lastS = null;
            try { lastS = JSON.parse(GM_getValue("ogamex_threat_spy_sig", "null")); } catch {}
            if (!lastS || lastS.sig !== sigS || Date.now() - (lastS.at || 0) > 10 * 60 * 1000) {
              GM_setValue("ogamex_threat_spy_sig", JSON.stringify({ sig: sigS, at: Date.now() }));
              for (const r of others.slice(0, 3)) {
                const minsS = r.eta ? Math.max(0, Math.round(r.eta / 60)) : null;
                ThreatLog.add("odczyt", `Obca misja ${r.type} z [${r.src || "?"}]${r.srcName ? ` „${r.srcName}"` : ""} na [${r.dst || "?"}]`
                  + (minsS !== null ? `, dolot ~${minsS} min` : "")
                  + (r.ships?.length ? ` | skład: ${r.ships.slice(0, 6).join(", ")}` : ""));
              }
            }
          }
          return;
          }
        }

        const srv = await this.fetchServerEvents();
        if (!srv) return;                 // nie wiem → pasek zostaje awaryjnym źródłem
        GM_setValue(this.KEY_EVENTS, JSON.stringify(srv));
      } finally {
        this._evFetching = false;
      }
    },

    // ── v2.75.7: DRUGIE ŹRÓDŁO PRAWDY — API zdarzeń serwera ──
    // Klasyfikacja z listy ruchów flot stoi na NAZWACH klas w markupie forka.
    // 07.08 08:25 atak grupowy przeszedł niewykryty, bo jego nazwa nie była na
    // żadnej z list (ATTACK/SPY/SAFE), a sonda w tym samym czasie zgadzała
    // liczby, więc kontrola krzyżowa z paskiem misji nic nie zauważyła.
    // Serwer ma WŁASNY werdykt wrogości (typy misji 1,2,6,9,10) i własny
    // markup (tr.eventFleet[data-mission-type]) — to niezależny odczyt tej
    // samej rzeczywistości, odporny na nazewnictwo wierszy listy ruchów.
    // Zwraca null = „nie wiem" (nigdy „bezpiecznie").
    async fetchServerEvents() {
      const hdr = { headers: { "X-Requested-With": "XMLHttpRequest" } };
      if (!Ajax.supported("/ajax/fleet/eventbox/fetch")) return null;
      let box = null;
      try {
        const res = await fetchT("/ajax/fleet/eventbox/fetch", hdr);
        if (!res.ok) { Ajax.markUnsupported("/ajax/fleet/eventbox/fetch", res.status); return null; }
        box = await res.json();
      } catch { return null; }
      if (!box || !Number.isFinite(box.hostile)) return null;
      Ajax.remember(box.newAjaxToken); // każda odpowiedź gry niesie świeży token CSRF
      {
        const out = { at: Date.now(), hostile: box.hostile, attacks: 0, spies: 0, classified: true, targets: [], origins: [] };
        if (box.hostile > 0) {
          let html = "";
          try {
            const res = await fetchT("/ajax/fleet/eventlist/fetch", hdr);
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
        return out;
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
      // v2.102.0 (D-F2): backstop od OSTATNIEGO widzenia, nie pierwszego —
      // wabiki trzymane na pasku 3 h gasiłyby alarm z lecącym atakiem.
      if (Date.now() - (s.seenAt || s.firstAt) > this.BACKSTOP_MS) return false;
      return true;
    },

    clear() { GM_setValue(this.KEY, "null"); GM_setValue(this.KEY_EXCESS_SINCE, "0"); GM_setValue(this.KEY_EXCESS_LAND, "0"); },   // v2.104.2: koniec alarmu = koniec nadwyżki

    // ── v2.88.1: PARSER PASKA — czysta funkcja, zamrożona testami ──
    // INCYDENT 12.08 15:24 (ACS na [3:272:7]): pasek pokazywał
    // „2 Missions: 2 Hostile" — BEZ segmentu „Own", bo żadna nasza flota
    // nie leciała. Stary regex WYMAGAŁ „X Own", więc odczyt padał i bot
    // uznawał „brak paska na tej stronie" → w grę wchodził cache sprzed
    // ataku, który mówił „czysto". Bot był ślepy DOKŁADNIE wtedy, gdy cała
    // flota stała w domu i atak był najgroźniejszy: zero alarmu, zero
    // pusha, ratunek ręczny właściciela. Każdy segment (Own/Hostile/
    // Friendly) jest teraz OPCJONALNY; jawne „Hostile" to twarda liczba
    // wrogów — bez arytmetyki odejmowania.
    parseBar(text) {
      const t = String(text || "");
      const m = t.match(/(\d+)\s*Missions?\s*:/);
      // v2.104.4 — 26.08 16:46: strona floty pokazywała „No fleet movement”, a
      // parser zwracał null → obrona brała CACHE paska (4 obcych sprzed minuty)
      // i ruszała flotą. Brak ruchów to ŻYWY odczyt zera, nie brak paska.
      if (!m) return /No fleet movement/i.test(t) ? { total: 0, own: 0, foreign: 0 } : null;
      const total = parseInt(m[1]) || 0;
      // segmenty czytamy z okna tuż za „N Missions:", żeby liczby z reszty
      // strony (odliczania, koordynaty) nie weszły do rachunku
      // v2.105.6 — 18:33: „Type: Spy” NIE był widziany, bo textContent ma między
      // segmentami długie ciągi białych znaków (wcięcia HTML) i 160 znaków
      // kończyło się przed „Type:”. Okno = 1200 znaków ZWINIĘTE do pojedynczych
      // spacji, potem 220 znaków.
      const win = t.slice(m.index, m.index + 1200).replace(/\s+/g, " ").slice(0, 220);
      const seg = (re) => { const x = win.match(re); return x ? (parseInt(x[1]) || 0) : null; };
      const own = seg(/(\d+)\s*Own/);
      const hostile = seg(/(\d+)\s*Hostile/);
      const friendly = seg(/(\d+)\s*Friendly/);
      if (own === null && hostile === null && friendly === null) return null;
      const foreign = hostile !== null ? hostile : Math.max(0, total - (own || 0) - (friendly || 0));
      // v2.104.6 — 26.08 17:50: pasek „1 Hostile, Type: Spy”, lista bez wiersza
      // sondy (leciała już z powrotem) → nadwyżka trwała >60 s → moon-save
      // całej floty bez ataku. Pasek SAM mówi, czym jest najbliższy obcy lot.
      const spyType = /Type\s*:\s*(Spy|Espionage|Szpieg)/i.test(win);
      const barType = ((win.match(/Type\s*:\s*([A-Za-z][A-Za-z ()]{0,24})/) || [])[1] || "").trim() || null;   // v2.106.3: do logu
      const spyOnly = foreign === 1 && spyType;
      // v2.105.0 — 18:14: pasek „4 Hostile, Type: Spy” (rój sond). Typ dotyczy
      // najbliższego lotu, więc >1 nie wyklucza ataku za sondą — ale sondy
      // wracają w minuty, atak wisi dłużej: przy Type Spy nadwyżka musi
      // utrzymać się 5 min, zanim ruszymy flotą.
      return { total, own: own || 0, foreign, spyOnly, spyType, barType };
    },

    // Reads the mission bar of whatever page we're on. Returns null when the
    // bar isn't rendered (most galaxy pages) so a blind page never clears a
    // live alert.
    read() {
      // ── v2.87.0: SYMULACJA ŚLEPEGO PASKA ──
      // Odtwarza atak z 12.08 13:10: lista ruchów i zdarzenia serwera CZYSTE,
      // tylko pasek widzi +1 obcą flotę (tak wyglądają ataki z własnego
      // układu). Syntetyczny odczyt przechodzi przez CAŁĄ prawdziwą
      // maszynerię: cache paska → kandydat → potwierdzenie → ratunek do
      // DOMU FLOTY → straż → powrót. To jedyny sposób na E2E tej ścieżki
      // bez czekania na prawdziwego wroga.
      const blindUntil = parseInt(GM_getValue("ogamex_threat_sim_blind_until", "0")) || 0;
      if (Date.now() < blindUntil) {
        const pb0 = this.parseBar(document.body.textContent);
        const own0 = pb0 ? (pb0.own || 0) : 0;
        GM_setValue("ogamex_bar_cache", JSON.stringify({ at: Date.now(), foreign: 1, total: own0 + 1, own: own0 }));
        return { total: own0 + 1, own: own0, foreign: 1, sim: true };
      }
      if (blindUntil) {
        GM_setValue("ogamex_threat_sim_blind_until", "0");
        GM_setValue("ogamex_bar_cache", JSON.stringify({ at: Date.now(), foreign: 0, total: 0, own: 0 }));
        log("[TEST] symulacja ślepego paska zakończona — pasek wraca na prawdziwe odczyty. Alarm zgaśnie, flota wróci automatycznie.", "info");
      }
      // v2.88.1: parsowanie w parseBar() — czysta funkcja z macierzą testów
      // (incydent 15:24: pasek bez segmentu „Own" wywracał stary regex).
      const out = this.parseBar(document.body.textContent);
      if (!out) return null;
      // ── v2.86.3: ODCZYT PASKA ZOSTAWIA ŚLAD (cache 3 min) ──
      // KATASTROFA 13:10: pasek zobaczył atak o 13:07:42, ale kolejne 99 s
      // bot spędził na stronach galaktyki, gdzie pasek się nie renderuje —
      // a lista ruchów, która NIE ODDAJE wierszy ataków z własnego układu,
      // odświeżała się jako „czysta" i kasowała obraz. Jeden log, zero
      // śladu, flota stracona. Każdy udany odczyt paska (także 0 — realne
      // odwołanie) zapisuje się na 3 min i zastępuje pasek tam, gdzie go
      // nie ma.
      GM_setValue("ogamex_bar_cache", JSON.stringify({ at: Date.now(), foreign: out.foreign, total: out.total, own: out.own, spyOnly: !!out.spyOnly, spyType: !!out.spyType, barType: out.barType || null }));
      return out;
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
      let bar = this.read();
      // v2.102.0 (I-A5): po utracie sesji pasek w DOM to zamrożony obraz sprzed
      // wylogowania — nie jest odczytem. Strona jest wtedy ŚLEPA.
      if (SessionWatch.lostRecently()) bar = null;
      // ── v2.86.3: strona bez paska bierze CACHE odczytu (3 min) ──
      // Skaner spędza minuty na stronach galaktyki, gdzie pasek się nie
      // renderuje — dotąd te przebiegi były ślepe na wszystko, czego nie
      // oddała lista ruchów. Odczyt z ostatniej strony Z paskiem żyje 3 min.
      let barEff = bar;
      if (!barEff) {
        try {
          const c = JSON.parse(GM_getValue("ogamex_bar_cache", "null"));
          if (c && Date.now() - (c.at || 0) < 3 * 60 * 1000) barEff = { total: c.total || 0, own: c.own || 0, foreign: c.foreign || 0, spyOnly: !!c.spyOnly, spyType: !!c.spyType, barType: c.barType || null, cached: true };
        } catch {}
      }
      const ev = this.events();
      const evFresh = ev && Date.now() - ev.at < this.EVENT_MAX_AGE_MS;
      let r = barEff, evSrc = "", probeWaitUntil = 0, barExcess = 0;
      if (evFresh && ev.classified) {
        r = { total: barEff?.total ?? 0, own: barEff?.own ?? 0, foreign: ev.attacks };
        // ── v2.86.3: PASEK WYGRYWA, GDY WIDZI WIĘCEJ NIŻ LISTA ──
        // KATASTROFA 13:10: lista ruchów tego forka NIE ODDAJE wierszy
        // ataków z własnego układu (3 rozjazdy 12.08 — wszystkie to loty
        // Ibra646 z [2:277:11]; ostatni kosztował flotę główną). „Czysta"
        // świeża lista kasowała odczyt paska przy każdym przebiegu i atak
        // znikał z obrazu na 99 s. Od teraz: brakujące wiersze = ATAK,
        // większa liczba wygrywa — na każdej stronie, także z cache.
        // v2.87.3: pasek liczy WSZYSTKIE obce misje — TAKŻE SONDY — więc
        // porównanie z samymi atakami z listy robiło z każdej sondy „atak"
        // (incydent 14:38-14:50: 2 sondy → pełne ratunki pustych kolonii,
        // mimo że lista słusznie mówiła „sondy 2, IGNORUJĘ"). Brakujący
        // wiersz to wyłącznie NADWYŻKA paska ponad wszystkie obce wiersze
        // listy (ataki+sondy) — i tylko ona jest traktowana jak atak.
        // Zabójczy przypadek 13:07 (atak w ogóle nie na liście) nadal
        // pokryty: pasek 1 > lista 0 → nadwyżka 1 → alarm.
        // v2.102.0 (D-F3): nadwyżka paska liczona względem ROZPOZNANYCH ataków
        // i sond — własny lot z ciała spoza ownBodies() (liczony w `hostile`)
        // maskował prawdziwy, niewidzialny dla listy atak.
        // v2.102.3 — ATAK 25.08 16:22 (ACS Ibry, 712 mld): pasek „1 Hostile", lista
        // 0 ataków + 2 sondy → 1 ≤ 2 → „zero" → alarm zdjęty 16:22:47 → auto-powrót
        // wiózł flotę POD atak (uratował ręczny klik ownera). Pasek tego forka NIE
        // liczy sond jako Hostile (16:22:07: ACS + sonda w locie = „1 Hostile"),
        // więc porównujemy TYLKO z atakami. Gdyby fork jednak liczył sondy,
        // przełącznik threatAlarm.barCountsProbes przywraca stare zachowanie.
        // v2.102.4: nadwyżka paska liczona TYLKO względem ataków. Sondy w locie nie
        // maskują — tylko OPÓŹNIAJĄ potwierdzenie do chwili, gdy musiały wylądować
        // (jeśli nadwyżka trwa po tym, to nie była sonda).
        // v2.103.3 — FAŁSZYWY ALARM 25.08 21:32/21:34: pasek 3 obcych, lista 0 ataków
        // + 3 sondy → „3 brakujących = ATAK" → ucieczka w powietrze CAŁEJ floty
        // (Deploy 3%, 14 h) bez żadnego ataku. Dowód, że pasek tego forka LICZY
        // sondy W LOCIE (16:22 „ACS + sonda = 1 Hostile" — tamta sonda już
        // wylądowała, lista trzyma wiersz dłużej niż pasek). Stąd:
        //   nadwyżka = pasek − ataki − sondy W LOCIE (eta>30 s).
        // Wylądowane sondy nadal NIE maskują (16:22 pokryte). Jeśli nadwyżka
        // ≤ liczba wszystkich sond, potwierdzenie czeka, aż sondy MUSIAŁY
        // wylądować (spyMaxEta+10 s) — trwa dalej = to nie sonda.
        // barCountsProbes=true: liczą się WSZYSTKIE sondy (stare zachowanie).
        // v2.104.0: decyzja przez czystą funkcję barExcessDecision (patrz blok BAR-EXCESS).
        let candAt = parseInt(GM_getValue(this.KEY_CANDIDATE, "0")) || 0;
        if (candAt && Date.now() - candAt > 5 * 60 * 1000) candAt = 0;
        // recenzja 2.104.0 (W3): w trwającym alarmie kandydat resetuje się co 5 min —
        // kotwicą jest wtedy pierwsze widzenie alarmu (firstAt), inaczej co 5 min
        // wracało okno bez „oba ciała".
        if (!candAt) { try { const st0 = this.state(); if (st0 && st0.count > 0 && st0.firstAt) candAt = st0.firstAt; } catch {} }
        // v2.104.2: początek TEJ nadwyżki — kotwica czekania „może być sondą"
        // w trwającym alarmie (firstAt alarmu robił z każdej sondy „oba ciała").
        let excSince = parseInt(GM_getValue(this.KEY_EXCESS_SINCE, "0")) || 0;
        let excLand = parseInt(GM_getValue(this.KEY_EXCESS_LAND, "0")) || 0;   // v2.104.3: zapamiętane lądowanie sond
        const decideBx = () => barEff ? this.barExcessDecision({
          barForeign: barEff.foreign, barSpyOnly: !!barEff.spyOnly, barSpyType: !!barEff.spyType, barCached: !!barEff.cached, attacks: ev.attacks || 0, spies: ev.spies || 0,
          spiesInFlight: ev.spiesInFlight || 0, spyMaxEta: ev.spyMaxEta || 0,
          barCountsProbes: !!CONFIG.threatAlarm?.barCountsProbes, candidateAt: candAt, excessSince: excSince, landAt: excLand, now: Date.now(),
        }) : { excess: 0, listForeign: ev.attacks || 0, waitUntil: 0, why: "" };
        let bx = decideBx();
        if (bx.excess > 0 && !excSince) { excSince = Date.now(); excLand = 0; GM_setValue(this.KEY_EXCESS_SINCE, String(excSince)); bx = decideBx(); }
        else if (bx.excess <= 0 && excSince) { excSince = 0; excLand = 0; GM_setValue(this.KEY_EXCESS_SINCE, "0"); }
        if (bx.excess > 0 && (bx.landAt || 0) > excLand) { excLand = bx.landAt; GM_setValue(this.KEY_EXCESS_LAND, String(excLand)); }
        else if (bx.excess <= 0) GM_setValue(this.KEY_EXCESS_LAND, "0");
        const listForeign = bx.listForeign;
        if (bx.excess > 0) {
          const missing = bx.excess;
          barExcess = missing;
          probeWaitUntil = bx.waitUntil;
          r = { ...r, foreign: (ev.attacks || 0) + missing };
          evSrc = `PASEK${barEff.cached ? " (cache <3 min)" : ""}${barEff.barType ? ` [Type: ${barEff.barType}]` : " [Type: ?]"}: ${barEff.foreign} obcych vs lista ${listForeign} (ataki ${ev.attacks || 0}, sondy ${ev.spies || 0}, w locie ${ev.spiesInFlight || 0}) — ${missing} brakujących traktuję jak ATAK${bx.why ? ` (${bx.why})` : ""}`;
        } else
        evSrc = `zdarzenia: ataki ${ev.attacks}${ev.spies ? `, sondy ${ev.spies} (IGNORUJĘ)` : ""}`
          + (ev.targets?.length ? ` → cel: ${ev.targets.join(", ")}` : "");
        // ── v2.86.1: SONDA UZBRAJA CZUJNOŚĆ (flotą dalej nie rusza) ──
        // Pełny łańcuch przeciwnika (owner, na żywo 12.08): SKAN sondą →
        // decyzja → atak. Sonda leci sekundy i jest NAJWCZEŚNIEJSZYM
        // sygnałem — więc na 5 min po niej pętla obrony schodzi do rytmu
        // ~10 s (ten sam mechanizm co gotowość po wabiku). Ewakuacji sonda
        // nadal NIE wywołuje: reagowanie flotą na każdy skan parkowałoby
        // gospodarkę na stałe i uczyłoby napastnika sterowania botem.
        if (ev.spies > 0) {
          const prev = parseInt(GM_getValue("ogamex_spy_alert_at", "0")) || 0;
          if (Date.now() - prev > 5 * 60 * 1000) {
            log(`[GOTOWOŚĆ] sonda szpiegowska (${ev.spies}) — ktoś nas skanuje przed atakiem? Przez 5 min pętla obrony chodzi co ~10 s.`, "warn");
          }
          GM_setValue("ogamex_spy_alert_at", String(Date.now()));
        }
      } else if (evFresh && ev.hostile > 0) {
        r = { total: barEff?.total ?? 0, own: barEff?.own ?? 0, foreign: ev.hostile };
        evSrc = `zdarzenia BEZ klasyfikacji: ${ev.hostile} obcych (typu misji nie dało się odczytać — traktuję jak atak)`;
      }
      // ── v2.108.0 (27.08 10:10:36, PRAWDZIWY ATAK): PAMIĘĆ ATAKU Z LISTY ──
      // Lista pokazała wiersz ATTACK → [2:151:8], ETA 07:16 (lądowanie 10:17:53),
      // sekundę później lista i pasek = 0 → „kandydat zniknął po 0 s", zero ratunku.
      // Atak był prawdziwy — operator sam skoczył bramą w ostatniej chwili.
      // Fork pokazuje wiersze/pasek najwyraźniej tylko dla AKTYWNEJ pary, więc
      // odczyt gaśnie, gdy bot przełączy ciało. Reguła: sklasyfikowany wiersz
      // ATTACK z celem i dolotem ≤ 20 min = atak aż do dolotu, niezależnie od
      // tego, co potem mówią lista i pasek. Cel do ratunku bierzemy z tej pamięci.
      if (!r || r.foreign === 0) {   // v2.108.1: r bywa null (brak paska i zdarzeń) — pamięć ma pierwszeństwo przed ślepotą
        try {
          const mem = JSON.parse(GM_getValue("ogamex_atk_until_map", "{}")) || {};
          const now = Date.now();
          const live = Object.keys(mem).filter(k => /^\d+:\d+:\d+$/.test(k) && mem[k] > now && mem[k] - now <= 20 * 60 * 1000).sort((a, b) => mem[a] - mem[b]);
          if (live.length) {
            r = { total: r?.total ?? 0, own: r?.own ?? 0, ...(r || {}), foreign: live.length };
            const hhmm = (t) => new Date(t).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
            evSrc = `PAMIĘĆ ATAKU: ${live.map(k => `[${k}] dolot ${hhmm(mem[k])}`).join(", ")} — lista i pasek milczą, ale wiersz ATTACK był widziany`;
            GM_setValue("ogamex_atk_memory_targets", JSON.stringify(live));
          } else {
            GM_setValue("ogamex_atk_memory_targets", "null");
          }
        } catch {}
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
          // v2.86.4: NIEPOTWIERDZONY odczyt to nie alarm — sondy widoczne
          // tylko na pasku (loty Ibra646) pchały push ⚔️ z syreną przy każdym
          // skanie, a fałszywe alarmy uczą ignorować prawdziwe. Rodzaj ATAK
          // (= push na telefon) dopiero przy POTWIERDZONYM alarmie; do tego
          // czasu zwykły odczyt w dzienniku. Potwierdzenie (WYKRYTO) i blitz
          // mają własne wpisy ATAK — te pchają jak dotąd.
          ThreatLog.add(r && r.foreign > 0 ? (this.active() ? "ATAK" : "odczyt") : (r ? "odczyt" : "ŚLEPY"),
            `${seen}${r ? "" : ` | strona: ${location.pathname}`}`);
        }
      }
      if (!r) {
        // ── v2.99.1: ŚLEPY ALARM SAM IDZIE PO WZROK ──
        // Incydent 20.08 03:59→04:49: po ataku (4×50 mld BC na księżyc) straż
        // wyczerpała limit 20 zamiatań, a bot został na /galaxy — stronie bez
        // paska misji. Lista ruchów też nie oddawała odczytu, więc alarm wisiał
        // ŚLEPY przez 50 minut i zdjęła go dopiero przypadkowa sonda
        // szpiegowska, która wymusiła świeży odczyt zdarzeń. Flota stała na
        // refugium ~70 min dłużej niż trzeba, minery nie latały.
        // Od teraz: gdy obrona jest uzbrojona (alarm aktywny albo straż armed)
        // i od BLIND_NAV_MS nie było ŻADNEGO autorytatywnego odczytu, bot sam
        // nawiguje na "/" (przegląd — /overview na tym serwerze nie istnieje),
        // gdzie pasek misji renderuje się zawsze. Nawigacja celowo POZA
        // NavRateLimiterem — to ta sama klasa ruchu co ratunek (widoczność
        // decyduje o flocie), a dławi ją własny zegar 5 min. Nocna cisza nie
        // blokuje: alarm i tak już nawigował (ratunek), ślepota jest droższa.
        const armed = (() => { try { return !!MoonSave.watch().armed; } catch { return false; } })();
        // v2.102.0 (I-A6): także w trakcie skanu galaktyki — strony bez paska
        // przez wiele minut = atak z układu niewidoczny aż do końca skanu.
        const scanActive = (() => { try { return !!ScanState.load()?.active; } catch { return false; } })();
        if (this.active() || armed || scanActive) {
          const sightAt = parseInt(GM_getValue(this.KEY_SIGHT_AT, "0")) || 0;
          const lastNav = parseInt(GM_getValue(this.KEY_BLIND_NAV_AT, "0")) || 0;
          const pending = GM_getValue("pending_mission", null);
          const busy = (pending && pending !== "null") || MoonSave.running;
          if (!busy && Date.now() - sightAt > this.BLIND_NAV_MS && Date.now() - lastNav > this.BLIND_NAV_MS) {
            GM_setValue(this.KEY_BLIND_NAV_AT, String(Date.now()));
            const blindMin = sightAt ? Math.round((Date.now() - sightAt) / 60000) : null;
            log(`[THREAT] obrona uzbrojona, a od ${blindMin ?? "?"} min żadna strona nie dała odczytu paska ani zdarzeń — idę na przegląd po wzrok.`, "warn");
            ThreatLog.add("odczyt", `Ślepota ${blindMin ?? "?"} min przy uzbrojonej obronie — wymuszam przegląd ("/"), żeby alarm mógł zgasnąć albo potwierdzić zagrożenie.`);
            window.location.replace("/");
          }
        }
        return; // no mission bar on this page — say nothing, change nothing
      }
      GM_setValue(this.KEY_SIGHT_AT, String(Date.now()));
      // v2.102.0 (I-A6, recenzja #2): osobny zegar ŻYWEGO paska. Lista ruchów
      // odpowiada zawsze, więc gałąź `!r` nie łapała skanu; atak z układu był
      // niewidoczny przez cały skan. Skan bez żywego paska >3 min → jedna
      // strona „/" po wzrok (skan wznawia się sam).
      if (bar) { GM_setValue("ogamex_threat_bar_at", String(Date.now())); GM_setValue("ogamex_bar_nav_count", "0"); }
      else {
        try {
          const scanOn = !!ScanState.load()?.active;
          const barAt = parseInt(GM_getValue("ogamex_threat_bar_at", "0")) || 0;
          const lastNav = parseInt(GM_getValue(this.KEY_BLIND_NAV_AT, "0")) || 0;
          const pending = GM_getValue("pending_mission", null);
          const busy = (pending && pending !== "null") || MoonSave.running;
          if (scanOn && !busy && !SessionWatch.lostRecently() && Date.now() - barAt > 3 * 60 * 1000 && Date.now() - lastNav > 3 * 60 * 1000) {
            GM_setValue(this.KEY_BLIND_NAV_AT, String(Date.now()));
            ThreatLog.add("odczyt", "Skan bez żywego paska misji >3 min — jedna strona przeglądu po wzrok (atak z układu widać tylko na pasku).");
            window.location.replace("/");
            return;
          }
        } catch {}
      }
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
      // v2.59.0: okno ślepoty dotyczy TYLKO odczytu z paska (artefakt „total
      // rośnie przed Own"). Odczyt z listy ruchów flot klasyfikuje po ŹRÓDLE,
      // więc własna wysyłka nie może w nim wyjść jako obca — a fale ekspedycji
      // idą co 60-90 s, czyli pasek-owe 20 s ślepoty zjadało ~25% czasu czuwania.
      if ((!evSrc || /^PASEK/.test(evSrc)) && r.foreign > 0 && Date.now() - lastOwnSend < this.SELF_SEND_BLIND_MS) {   // v2.102.4
        ThreatLog.add("odczyt", `${r.foreign} „obcych" tuż po NASZEJ wysyłce (${Math.round((Date.now() - lastOwnSend) / 1000)}s) — to własna flota w trakcie dopisywania do paska. Ignoruję.`);
        return;
      }
      if (r.foreign > 0) {
        let pendingSince = parseInt(GM_getValue(this.KEY_CANDIDATE, "0")) || 0;
        if (pendingSince && Date.now() - pendingSince > 5 * 60 * 1000) pendingSince = 0;   // v2.102.0 (#6): stary kandydat = nowy kandydat
        // ── v2.70.1: BLITZ — sklasyfikowany ATAK z dolotem <2 min nie czeka ──
        // Potwierdzenie 25 s chroni przed artefaktem PASKA (własna flota
        // policzona jako obca) — sklasyfikowany wiersz ATTACK z listy ruchów
        // nie ma tego problemu, a łowca z księżycem w sąsiednim układzie leci
        // <60 s: pełne potwierdzenie zjadłoby cały margines ewakuacji.
        // Koszt pomyłki = dwa 81-sekundowe przeloty; koszt spóźnienia = flota.
        const blitz = evSrc && ev?.attacks > 0 && Number.isFinite(ev.minEta) && ev.minEta < 120;
        // v2.102.0 (D-F5): atak widoczny TYLKO na pasku = lista go nie widzi =
        // z układu = krótki dolot → krótsze potwierdzenie.
        const barSrc = !evSrc || /^PASEK/.test(evSrc);
        const confirmMs = barSrc ? this.CONFIRM_BAR_MS : this.CONFIRM_MS;
        if (!pendingSince) {
          GM_setValue(this.KEY_CANDIDATE, String(Date.now()));
          GM_setValue("ogamex_threat_cand_src", barSrc ? "bar" : "list");
          // ── v2.86.0: PODWYŻSZONA GOTOWOŚĆ ──
          // Wzorzec przeciwnika potwierdzony na żywo 12.08: wabik
          // (wyślij-zawróć, kandydat znika po 10 s) → chwilę później WŁAŚCIWY
          // atak. Po każdym dostrzeżeniu obcej floty — także takim, które
          // zaraz zniknie — pętla obrony przechodzi na rytm ~10 s na 10 minut,
          // żeby właściwe uderzenie nie czekało do 30 s na dostrzeżenie.
          if (Date.now() - (parseInt(GM_getValue("ogamex_high_alert_at", "0")) || 0) > 10 * 60 * 1000) {
            log("[GOTOWOŚĆ] obca flota w zasięgu wzroku — przez 10 min pętla obrony chodzi co ~10 s.", "warn");
          }
          GM_setValue("ogamex_high_alert_at", String(Date.now()));
          if (!blitz) {
            log(`[THREAT] ${r.foreign} obcą flotę widzę pierwszy raz — potwierdzam przez ${Math.round(this.CONFIRM_MS / 1000)}s, zanim ruszę flotą.`, "warn");
            ThreatLog.add("odczyt", `Kandydat na alarm: ${r.foreign} obcych (${r.own}/${r.total}). Czekam na potwierdzenie ${Math.round(this.CONFIRM_MS / 1000)}s.`);
            return;
          }
          if (!this.active()) {
            log(`[THREAT] BLITZ: atak z dolotem ~${ev.minEta}s — alarm NATYCHMIAST, bez potwierdzania.`, "error");
            ThreatLog.add("ATAK", `BLITZ: dolot ~${ev.minEta}s — potwierdzanie pominięte, ratunek rusza od razu.`);
          }
        } else if ((Date.now() - pendingSince < confirmMs || (probeWaitUntil && Date.now() < probeWaitUntil && !this.active())) && !blitz) {
          if (probeWaitUntil && Date.now() < probeWaitUntil && Date.now() - (parseInt(GM_getValue("ogamex_probe_wait_said", "0")) || 0) > 60 * 1000) {
            GM_setValue("ogamex_probe_wait_said", String(Date.now()));
            log(`[THREAT] nadwyżka paska może być sondą w locie — czekam do jej lądowania (${new Date(probeWaitUntil).toLocaleTimeString("pl-PL")}); jeśli zostanie, to atak.`, "warn");
          }
          return; // jeszcze się nie potwierdziło
        }
        const first = !prev || !(prev.count > 0) || !this.active();   // v2.102.4: po backstopie atak znów „pierwszy" (push)
        GM_setValue(this.KEY, JSON.stringify({
          count: r.foreign,
          total: r.total,
          own: r.own,
          seenAt: Date.now(),
          firstAt: first ? Date.now() : (prev.firstAt || Date.now()),
          src: barSrc ? "bar" : (prev && prev.src === "bar" && !bar ? "bar" : "list"),   // v2.102.0: skąd alarm — pasek gasi tylko żywy pasek
          excess: (probeWaitUntil && Date.now() < probeWaitUntil) ? 0 : barExcess,   // v2.102.4 (+2.104.0: nie „oba ciała", póki nadwyżkę mogą tłumaczyć sondy)
        }));
        if (first || r.foreign !== prev.count) {
          log(`INCOMING: ${r.foreign} foreign fleet(s) in the mission bar (${r.own} of ${r.total} are ours). Farming and expedition waves are on hold — CHECK THE GAME.`, "error");
          ThreatLog.add("ATAK", `WYKRYTO ${r.foreign} obcą/obce flotę/floty (${r.own} z ${r.total} to nasze). Farmienie i fale ekspedycji wstrzymane.`);
          this.dumpMarkupOnce().catch(() => {});
          this.notify(r.foreign);
        }
      } else if (prev && prev.count > 0 && Date.now() < (parseInt(GM_getValue("ogamex_atk_until", "0")) || 0) && !(bar && bar.foreign === 0)) {
        // v2.102.4: ŻYWY pasek z zerem = żaden wróg nie leci (13:10 pokazało, że
        // pasek liczy nawet loty niewidzialne dla listy) → wabik zawrócony;
        // wtedy NIE trzymamy — idzie histereza niżej i czyścimy pamięć dolotu.
        // v2.102.3: widzieliśmy atak z dolotem w przyszłości — żaden „zerowy"
        // odczyt (lista gubi wiersze, sondy) nie zdejmuje alarmu przed dolotem.
        if (Date.now() - (prev.untilSaidAt || 0) > 5 * 60 * 1000) {
          GM_setValue(this.KEY, JSON.stringify({ ...prev, untilSaidAt: Date.now() }));
          const hhmm = new Date(parseInt(GM_getValue("ogamex_atk_until", "0")) || 0).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          log(`[THREAT] odczyt „zero", ale widziany atak dolatuje ${hhmm} — alarm TRZYMANY do dolotu.`, "warn");
          ThreatLog.add("odczyt", `Zerowy odczyt zignorowany: widziany atak dolatuje ${hhmm} — alarm trzymany.`);
        }
      } else if (prev && prev.count > 0 && !bar) {
        // v2.102.3: lista jest niewiarygodna (fork ukrywa wiersz ACS między
        // odczytami — 16:21:18→20), więc BEZ żywego paska alarm nie gaśnie
        // niezależnie od tego, skąd pochodził.
        // ── v2.102.0 (D-F1 — kształt katastrofy 13:10) ──
        // Alarm pochodzi z PASKA (lista nie widzi ataku = start z układu).
        // Ta strona paska nie ma, a cache wygasł — świeża „czysta" lista NIE
        // może zdjąć alarmu. Trzymamy go i idziemy po żywy pasek.
        if (Date.now() - (prev.barHoldSaidAt || 0) > 5 * 60 * 1000) {
          GM_setValue(this.KEY, JSON.stringify({ ...prev, barHoldSaidAt: Date.now() }));
          log("[THREAT] alarm z paska misji, a ta strona paska nie ma — lista ruchów nie widzi ataków z układu, więc NIE zdejmuję alarmu. Idę po żywy odczyt paska.", "warn");
          ThreatLog.add("odczyt", "Alarm z paska trzymany bez żywego paska — lista nie widzi ataków z układu.");
        }
        const lastNav = parseInt(GM_getValue(this.KEY_BLIND_NAV_AT, "0")) || 0;
        const pending = GM_getValue("pending_mission", null);
        const busy = (pending && pending !== "null") || MoonSave.running;
        if (!busy && !SessionWatch.lostRecently() && Date.now() - lastNav > 60 * 1000) {
          GM_setValue(this.KEY_BLIND_NAV_AT, String(Date.now()));
          const navs = (parseInt(GM_getValue("ogamex_bar_nav_count", "0")) || 0) + 1;
          GM_setValue("ogamex_bar_nav_count", String(navs));
          if (navs === 5) { log("[THREAT] 5× przegląd bez paska misji — fork nie renderuje paska? Alarm trzymany, powrót ręczny (WRÓĆ NA BAZĘ). Prześlij zrzut strony przeglądu.", "error"); ThreatLog.add("BŁĄD", "Strona przeglądu 5× bez paska misji — alarm nie ma jak zgasnąć. Sprawdź grę / powrót ręczny."); }
          if (navs < 5 || Date.now() - lastNav > 10 * 60 * 1000) window.location.replace("/");
        }
      } else if (prev && prev.count > 0 && !prev.zeroAt) {
        // v2.102.0 (D-F8): histereza — jeden zerowy odczyt nie zdejmuje alarmu;
        // drugi ≥15 s później tak. Koszt: ≤15 s później powrót.
        GM_setValue(this.KEY, JSON.stringify({ ...prev, zeroAt: Date.now() }));
        ThreatLog.add("odczyt", "Zerowy odczyt — alarm zejdzie po potwierdzeniu drugim odczytem (≥15 s).");
      } else if (prev && prev.count > 0 && Date.now() - (prev.zeroAt || 0) < 15 * 1000) {
        // czekamy na drugi zerowy odczyt
      } else if (prev && prev.count > 0) {
        GM_setValue(this.KEY_CANDIDATE, "0");
        GM_setValue("ogamex_atk_until", "0");   // v2.102.4: żywy pasek 2× zero → wabik/atak minął — pamięć dolotu czyszczona
        // ── v2.59.0: this.clear() wróciło na miejsce ──
        // Wypadło stąd w 2.32.0 (przeprowadzka do gałęzi niepotwierdzonego
        // kandydata niżej — która przy AKTYWNYM alarmie jest nieosiągalna, bo
        // ta gałąź łapie wcześniej). Skutek: po każdym potwierdzonym alarmie
        // active() zostawało true aż do 3-godzinnego BACKSTOPU — auto-powrót
        // z refugium nie odpalał (returnHome wymaga !active()), ekspedycje
        // i farmienie stały, straż zamiatała planetę co 90 s, a ta linia
        // logowała „alarm zdjęty" co 30 s, nie zdejmując niczego.
        this.clear();
        log("Incoming fleets gone — threat alert cleared.", "success");
        ThreatLog.add("koniec", "Obce floty zniknęły z paska misji — alarm zdjęty.");
      } else if (r.foreign === 0 && (parseInt(GM_getValue(this.KEY_CANDIDATE, "0")) || 0) && !!bar && bar.foreign === 0) {   // v2.102.4: kandydat gaśnie tylko od ŻYWEGO paska z zerem (wabik zawrócony)
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
    MAX_SAVES_PER_ALERT: 40,    // v2.101.0: liczone TYLKO potwierdzone wysyłki (było 20 z pustymi hangarami)
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
    // ── v2.87.0: WYBÓR CELU RATUNKU jako CZYSTA funkcja ──
    // Decyzja, która 12.08 13:10 kosztowała flotę, była zaszyta w run()
    // i nietestowalna. Teraz: bez DOM, sieci i zegara — tę samą funkcję
    // woła run(), AUTOTEST w przeglądarce i test offline (macierz).
    // Kolejność: jawny cel → kolonia strzeżona w tym alarmie → (ręczny
    // RATUJ: para operatora / automat: DOM FLOTY) → co zostało.
    resolveRescueTarget({ where, watchAt, manual, fleetHome, activePair }) {
      return where || watchAt || (manual ? (activePair || fleetHome) : (fleetHome || activePair)) || null;
    },

    coordsOf(where) {
      // v2.102.0 (C-F3): brak minerBase nie może zabić obrony — dom floty, aktywna para.
      let b = where || CONFIG.asteroidMining.minerBase;
      if (!b || !Number.isFinite(b.galaxy)) { try { b = CONFIG.expeditions?.launchFrom || HomeBase.coords() || null; } catch { b = null; } }
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
    switchTo(coords, reason, opts = {}) {
      const a = this.planetAnchor(coords);
      if (!a) {
        log(`[RATUNEK] nie znajduję kolonii [${coords}] na liście planet — NIE ruszam floty. Reaguj ręcznie.`, "error");
        ThreatLog.add("BŁĄD", `Kolonii [${coords}] nie ma na liście planet — ewakuacja przerwana, flota nietknięta.`);
        return false;
      }
      // v2.107.0 (audyt 2, Z4): klikamy CIAŁO, na którym stoi flota. Dotąd zawsze
      // planeta → przy flocie na księżycu run() odmawiał („NA księżyc, bo atakowany"),
      // straż zbroiła się z błędnym ciałem, brama była nieosiągalna, a ratunek
      // trwał 55-100 s. Ciało z mapy hangarów (ostatni odczyt <48 h, hangar
      // niepusty) albo z opts.body; księżyc tylko, gdy para GO MA na pasku.
      let body = this.switchBodyFor(coords, opts.body || null);
      let el = a;
      if (body === "moon") {
        const m = HomeBase.moonOf(a);
        if (m) el = m; else body = "planet";
      }
      GM_setValue(this.KEY_SWITCH, JSON.stringify({ coords, at: Date.now(), reason: reason || "atak", body: body || "planet" }));
      log(`[RATUNEK] przełączam się na ${body === "moon" ? "KSIĘŻYC" : "planetę"} [${coords}], żeby wysłać flotę Z TEGO ciała.`, "warn");
      ThreatLog.add("RATUNEK", `Przełączam aktywne ciało na ${body === "moon" ? "księżyc" : "planetę"} [${coords}] — wysyłka musi wyjść stamtąd, gdzie stoi flota.`);
      el.click();
      return true;
    },
    // czysta decyzja (testowalna): "moon" | "planet" | null (nie wiemy → planeta)
    switchBodyFor(coords, forced = null) {
      if (forced === "moon" || forced === "planet") return forced;
      try {
        const map = JSON.parse(GM_getValue(FleetRecon.KEY_HANGARS, "{}")) || {};
        const e = map[coords];
        if (e && (e.total || 0) > 0 && Date.now() - (e.at || 0) < 48 * 60 * 60 * 1000 && (e.body === "moon" || e.body === "planet")) return e.body;
      } catch {}
      return null;
    },

    // Po przeładowaniu: jeśli jesteśmy tam, gdzie mieliśmy być, dokończ ratunek.
    resumeAfterSwitch() {
      let st = null;
      try { st = JSON.parse(GM_getValue(this.KEY_SWITCH, "null")); } catch {}
      if (!st?.coords) return false;
      if (Date.now() - (st.at || 0) > 5 * 60 * 1000) { GM_setValue(this.KEY_SWITCH, "null"); return false; }   // v2.102.0 (I-B3): 90 s → 5 min (dławiony tick gubił przełączenie)
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
      window.location.replace(`/galaxy?x=${b.galaxy}&y=${b.system}`);
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
    saveWatch(w) {
      // v2.104.0: ślad uzbrojenia — 21:49:08 straż pojawiła się „znikąd"; każde
      // przejście nieuzbrojona → uzbrojona zapisuje wołającego do dziennika.
      try {
        const prev = this.watch();
        if (w && w.armed && !prev.armed) {
          const st = String((new Error()).stack || "").split("\n").slice(2, 5).map(l => l.trim().replace(/^at\s+/, "").replace(/\(.*?:(\d+):\d+\)$/, ":$1")).join(" < ");
          ThreatLog.add("odczyt", `Straż UZBROJONA: [${RescueQueue.str(w.at) || "?"}] dom=${w.homeBody || "?"} refugium=${w.refugeBody || "?"} trigger=${w.trigger || "?"} ← ${st.slice(0, 220)}`);
        }
      } catch {}
      GM_setValue(this.KEY_WATCH, JSON.stringify(w));
    },
    disarm(why) {
      const w = this.watch();
      if (!w.armed) return;
      GM_setValue(this.KEY_WATCH, "null");
      try { RescueQueue.dropPending(w.at, `rozbrojenie straży (${why})`); } catch {}   // v2.104.0
      try { GM_setValue("ogamex_save_total", "null"); } catch {}   // v2.104.0: suma ratunku żyje tylko z tą strażą
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
      if (this.watch().armed) {                  // already saving for this alert
        // Straż trzyma ciało puste — to JEST działanie, ale niech ma stempel:
        // „uzbrojona bez ani jednego zapisu" to stan, o którym chcemy wiedzieć.
        let wNow = this.normalizeWatch();   // v2.102.0 (C-F1)
        // v2.102.4 (D6): ręczny RATUJ w oknie kandydata = trigger „manual" → returnHome
        // nigdy; skoro alarm jest prawdziwy, straż przechodzi na „threat".
        if (wNow.trigger !== "threat") { wNow = { ...wNow, trigger: "threat" }; this.saveWatch(wNow); }
        if ((wNow.saves || 0) > 0) DefenceWatchdog.note(`straż aktywna, zapisów: ${wNow.saves}`);
        // ── v2.78.0: JEDYNE nowe wyjście z tej gałęzi ──
        // Wszystko powyżej i wszystko poniżej zostaje bez zmian. Tu dotąd był
        // sam `return false` — i właśnie tędy uciekał drugi atak na inną
        // kolonię. Ratunek pierwszej kolonii nie przechodzi przez ten warunek
        // (przy pierwszym ataku `armed` jest fałszem), więc ta linia nie ma
        // jak wpłynąć na ścieżkę, która działa.
        if (await RescueQueue.tryNext(wNow).catch((e) => {
          log(`[KOLEJKA] błąd: ${e.message} — pierwsza kolonia pozostaje chroniona.`, "error");
          return false;
        })) return true;
        // ── v2.87.1: OBA CIAŁA STRZEŻONEJ KOLONII POD ATAKIEM ──
        // Zaobserwowane NA ŻYWO 12.08 14:28: straż uzbrojona po pierwszym
        // ataku (flota ewakuowana na refugium), wróg dosłał DRUGĄ flotę na
        // drugie ciało tej samej pary — a ta gałąź kończyła się głuchym
        // `return false`: brama ucieczki w powietrze żyje w run(), do
        // którego uzbrojona straż nigdy nie dochodziła. Flota stała na
        // refugium pod nadlatującym uderzeniem; uratował ją ręczny Deploy
        // ownera. Teraz: oba ciała strzeżonej pary pod atakiem → run() →
        // delegacja do AirSave → wszystko w powietrze.
        try {
          const guardedKey = RescueQueue.str(wNow.at);
          const bodiesNow = ThreatMonitor.attackBodiesFor(guardedKey);   // v2.102.4
          if (guardedKey && bodiesNow.length >= 2 && AirSave.decideFor(wNow.at) === "air") {
            log(`[UCIECZKA] OBA ciała strzeżonej kolonii [${guardedKey}] pod atakiem — skok w obrębie pary nie ratuje, wysyłam wszystko w powietrze.`, "error");
            ThreatLog.add("ATAK", `Oba ciała [${guardedKey}] pod atakiem przy uzbrojonej straży — ucieczka w powietrze zamiast skoku w parze.`);
            return this.run({ auto: true, where: wNow.at, reason: `AUTOMAT: oba ciała [${guardedKey}] pod atakiem` });
          }
        } catch (e) { log(`[UCIECZKA] błąd sprawdzenia pary strzeżonej: ${e.message}`, "warn"); }
        // ── v2.100.0: ATAK W CIAŁO, NA KTÓRYM STOI URATOWANA FLOTA ──
        // Audyt 25.08 (D1): fale na księżyc przeszły, straż wciąż uzbrojona
        // (flota na planecie = refugium), napastnik dosyła atak NA PLANETĘ.
        // Jedno atakowane ciało → gałąź wyżej milczy, zamiatanie startuje
        // z księżyca i zastaje pusty hangar. Flota stała pod atakiem.
        // Decyzja przez czystą funkcję swapDecision (test-fale.js):
        // atak w ciało z flotą → skok na drugie; drugie też atakowane →
        // gałąź „oba ciała" wyżej już to załatwiła.
        try {
          // v2.100.1: flota w powietrzu (ucieczka w toku) = nie ma czego przenosić;
          // skok „w ciemno" psuł refugeBody i palił zapisy (audyt 25.08, F1).
          if (CONFIG.threatAlarm?.bodyAwareGuard !== false && !wNow.returning && AirSave.decideFor(wNow.at) !== "active") {
            const guardedKey = RescueQueue.str(wNow.at);
            const bodiesNow = ThreatMonitor.attackBodiesFor(guardedKey);   // v2.102.4
            const fleetBody = wNow.refugeBody || null;
            if (guardedKey && this.swapDecision({ attacked: bodiesNow, fleetBody }) === "move") {
              const other = fleetBody === "moon" ? "planet" : "moon";
              const nm = (b) => (b === "moon" ? "KSIĘŻYC" : "PLANETĘ");
              if (Date.now() - (wNow.lastAt || 0) < this.MIN_RESAVE_MS) {
                this._sayOnce("moveSoon", `[STRAŻ] atak w ${nm(fleetBody)} [${guardedKey}], gdzie stoi flota — poprzedni ruch jeszcze ląduje, skok za chwilę.`, "warn");
                return false;
              }
              log(`[STRAŻ] atak w ${nm(fleetBody)} [${guardedKey}] — TAM stoi uratowana flota. Przenoszę ją na ${nm(other)} (czyste ciało).`, "error");
              ThreatLog.add("ATAK", `Atak w ciało z flotą (${fleetBody}) [${guardedKey}] przy uzbrojonej straży — skok ${fleetBody} → ${other}.`);
              return this.swapWithinPair(wNow, fleetBody, other, `AUTOMAT: atak w ${fleetBody} [${guardedKey}], flota tam stoi`);
            }
          }
        } catch (e) { log(`[STRAŻ] błąd decyzji ciała: ${e.message}`, "warn"); }
        return false;
      }
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
      // ── v2.86.5: Ślepa ścieżka paska nie zna celu — celem jest DOM FLOTY ──
      // I to z pełną maszynerią przełączenia kolonii (switchTo), tą samą,
      // która ratowała zdalną kolonię bojowo 12.08 12:33. Dzięki temu
      // ratunek to szybki skok W OBRĘBIE pary domu, a nie wielominutowy lot
      // międzykolonijny z aktywnego ciała (13:41: 38 min na widoczną
      // planetę). Ścieżka z celem z listy — bez zmian.
      let target = ev?.attacks > 0 ? (ev.targets || [])[0] : null;
      // v2.108.0: cel z PAMIĘCI ATAKU (wiersz ATTACK widziany wcześniej, dolot ≤ 20 min),
      // zanim ślepa ścieżka zacznie bronić „wszystkich kolonii z flotą".
      if (!target) {
        try {
          const mem = JSON.parse(GM_getValue("ogamex_atk_until_map", "{}")) || {};
          const now = Date.now();
          const live = Object.keys(mem).filter(k => /^\d+:\d+:\d+$/.test(k) && mem[k] > now && mem[k] - now <= 20 * 60 * 1000).sort((a, b) => mem[a] - mem[b]);
          if (live.length) { target = live[0]; ThreatLog.add("odczyt", `Cel ratunku z PAMIĘCI ATAKU: [${target}] (lista/pasek nie oddają wiersza).`); }
        } catch {}
      }
      if (!target) {
        // v2.106.5 — 27.08 08:17 (prawdziwy atak z własnego układu, lista ślepa):
        // „dom floty" z pola panelu wskazał [5:125:4], gdzie hangar był PUSTY,
        // a flota stała na innej kolonii — bot ratował pustkę, flota nie ruszona.
        // Ślepy alarm broni WSZYSTKICH kolonii z flotą w hangarze (mapa
        // hangarów, największa pierwsza); pozostałe idą do kolejki ratunków.
        // v2.110.2 (27.08 11:26:13): po końcu symulacji alarm jeszcze „żył" (histereza),
        // a lista pokazała 0 ataków → ślepa ścieżka poleciała bronić [3:272:7] i wysłała
        // DRUGĄ ucieczkę. Ślepy alarm tylko, gdy to PASEK (żywy, <90 s) widzi obcych
        // i nie trwa właśnie zerowy odczyt — gasnący alarm z listy nie jest „celem nieznanym".
        let blindOk = false;
        try { const st = ThreatMonitor.state(); blindOk = !!(st && st.count > 0 && st.src === "bar" && Date.now() - (st.seenAt || 0) < 90 * 1000 && !st.zeroAt); } catch {}
        if (!blindOk) { DefenceWatchdog.note("alarm bez celu i bez żywego paska z obcymi — ślepa ścieżka wstrzymana (gasnący alarm?)"); return false; }
        let cands = []; try { cands = FleetRecon.hangarTargets(1); } catch {}
        if (cands.length) {
          target = cands[0];
          GM_setValue("ogamex_blind_targets", JSON.stringify({ at: Date.now(), keys: cands }));
          ThreatLog.add("ATAK", `Ślepy alarm (cel nieznany): bronię WSZYSTKICH kolonii z flotą — ${cands.map(k => `[${k}]`).join(", ")} (największa pierwsza).`);
          log(`[RATUNEK] ślepy alarm — cel nieznany, ratuję po kolei kolonie z flotą: ${cands.join(", ")}.`, "error");
        } else {
          // v2.104.0: dom floty z mapy hangarów (fallback: pole „Start ekspedycji").
          let fhk = null; try { fhk = FleetRecon.fleetHome(); } catch {}
          if (fhk) { target = fhk; ThreatLog.add("odczyt", `Ślepy alarm: bronię domu floty [${fhk}] (mapa hangarów / „Start ekspedycji").`); }
        }
      }
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
        // ── v2.70.0: STRAŻNIK BEZPIECZNEJ STRONY ──
        // Wiersz ataku mówi, w KTÓRE ciało leci (ikona przy celu). Jeśli flota
        // stoi już na ciele PRZECIWNYM do atakowanego, ratunek „z aktywnego na
        // przeciwne" przeniósłby ją PROSTO POD UDERZENIE (np. atak na planetę
        // po łup z kopalń, gdy flota mieszka na księżycu — tryb księżycowy
        // czyni ten scenariusz głównym). Wtedy nie ruszamy niczego.
        // v2.75.1: strażnik obowiązuje na KAŻDEJ kolonii, nie tylko bazie —
        // podczas eventu flota mieszka na różnych księżycach; atak na planetę
        // kolonii przy flocie na jej księżycu nie może wywołać ratunku, który
        // przeniósłby flotę prosto pod uderzenie. currentBody() opisuje parę
        // AKTYWNĄ, więc porównanie jest miarodajne tylko, gdy stoimy na
        // atakowanej kolonii — w przeciwnym razie decyzję podejmuje korekta
        // ciała na formularzu (widzi, gdzie naprawdę stoi flota).
        // v2.85.0: ciało celu PER KOLONIA; przy ataku na OBA ciała pary
        // nie istnieje „bezpieczna strona" — strażnik się wyłącza, a decyzję
        // przejmuje ucieczka w powietrze w run().
        let atkBody = (ev?.targetBodies || {})[target] || ev?.targetBody || null;
        // v2.102.3 (16:26:11): odczyt z samego paska nie zna ciała → ratunek
        // startował z planety NA KSIĘŻYC (pod atak). Pamięć ciała z ostatniego
        // widzianego wiersza tej pary (ważna do dolotu + 10 min).
        if (!atkBody) {
          try {
            const m = JSON.parse(GM_getValue("ogamex_atk_body_" + target, "null"));
            if (m && m.body && m.until && Date.now() < m.until) { atkBody = m.body; ThreatLog.add("odczyt", `Ciało celu z pamięci ostatniego wiersza: ${atkBody} (atak tej pary jeszcze leci).`); }
          } catch {}
        }
        const pairBodies = (ev?.targetBodiesAll || {})[target] || [];
        const active = this.activeCoords();
        if (atkBody && active === target && pairBodies.length < 2) {
          const cur = this.currentBody();
          if (cur && cur !== atkBody) {
            this._sayOnce("safeside", `[RATUNEK] atak celuje w ${atkBody === "moon" ? "KSIĘŻYC" : "PLANETĘ"} [${target}], a flota stoi na ${cur === "moon" ? "księżycu" : "planecie"} — po bezpiecznej stronie. NIE ruszam floty (ruch wprowadziłby ją pod atak).`);
            ThreatLog.add("ATAK", `Cel: ${atkBody === "moon" ? "księżyc" : "planeta"}; flota na przeciwnym ciele — zostaje na miejscu.`);
            DefenceWatchdog.note(`strażnik bezpiecznej strony: atak w ${atkBody}, flota na ${cur} [${target}]`);
            // v2.102.0 (C-F8): „bezpieczna strona" też ZBROI straż — inaczej fale
            // ekspedycji lądujące na atakowanym ciele nie były zamiatane.
            try {
              const w0 = this.watch();
              if (!w0.armed) {
                this.saveWatch({ armed: true, trigger: "threat", homeBody: cur, refugeBody: cur, at: where, since: Date.now(), saves: 0, lastAt: 0 });
                ThreatLog.add("STRAŻ", `Straż uzbrojona bez ruchu floty (bezpieczna strona) — zamiatam ${atkBody === "moon" ? "księżyc" : "planetę"} z wracających fal.`);
              }
            } catch {}
            // v2.102.4: currentBody() to ciało AKTYWNE w UI, nie położenie floty —
            // zamiast ślepo trzymać, WERYFIKUJEMY hangar atakowanego ciała
            // (pusty = flota naprawdę po bezpiecznej stronie; koszt 2-3 przeładowania).
            try { return await this.swapWithinPair(this.watch(), atkBody, cur, "strażnik bezpiecznej strony — weryfikacja hangaru", { sweep: true, verify: true }); } catch {}
            return false;
          }
        }
        if (active && active !== target) {
          // Klik przeładuje stronę; ratunek dokończy się w resumeAfterSwitch().
          if (this.switchTo(target, `AUTOMAT: atak na [${target}]`)) return true;
          // Świadomie NIE ruszamy floty — ale to MUSI zostawić ślad, inaczej
          // wygląda jak zwykły spokój (nadzorca v2.76.0).
          // v2.102.0 (C-F4/F5): cel spoza listy planet NIE blokuje obrony —
          // ratujemy DOM FLOTY (run bez celu), zamiast milczeć co tick.
          const fhome = CONFIG.expeditions?.launchFrom || null;
          const ap = HomeBase.coords();
          const onHome = !!(fhome && ap && ap.galaxy === fhome.galaxy && ap.system === fhome.system && ap.position === fhome.position);
          if (!onHome) {
            // Aktywna para to INNA (nieatakowana) kolonia — nie ruszamy jej floty.
            DefenceWatchdog.note(`kolonia [${target}] spoza listy planet — ratunek wstrzymany, potrzebna ręka`);
            return false;
          }
          DefenceWatchdog.note(`kolonia [${target}] spoza listy planet — ratuję dom floty (aktywna para = dom)`);
          this._sayOnce("badtarget", `[RATUNEK] cel ataku [${target}] nie jest na liście planet — ratuję dom floty.`, "warn");
          where = null;
        }
      }
      return this.run({
        auto: true,
        where,
        reason: where ? `AUTOMAT: atak na [${target}]` : "AUTOMAT: obca flota w pasku misji",
      });
    },

    // v2.77.2: poziom logu jako parametr. Domyslnie „error” — decyzje obrony
    // maja byc czerwone i widoczne. Ale rutyna („powrot poczeka, bo ratunek
    // jeszcze leci”) czerwona byc nie moze: czerwony na normalnej pracy uczy
    // operatora ignorowac czerwony, a wtedy przegapi ten prawdziwy.
    _sayOnce(key, msg, level = "error") {
      this._said = this._said || {};
      if (this._said[key] && Date.now() - this._said[key] < 5 * 60 * 1000) return;
      this._said[key] = Date.now();
      log(msg, level);
    },

    // v2.21.0 — the other half. Without it a false alarm would park the
    // economy on the moon indefinitely: mining and expeditions both launch
    // from the base planet, so an empty planet earns nothing. The alert clears
    // itself 10min after the last foreign sighting; everything comes back and
    // the bot resumes on its own.
    async returnHome({ byOperator = false } = {}) {
      const w = this.normalizeWatch();   // v2.102.0 (C-F1)
      // v2.106.0: flota skoczyła BRAMĄ na inny księżyc → powrót też bramą.
      if (w.armed && w.refugeBody === "gate") {
        if (!byOperator && ThreatMonitor.active()) return false;
        return GateSave.returnHome(w, { byOperator });
      }
      // v2.102.0 (B6): flota już na ciele domowym (refugium = dom) i cisza →
      // nie ma czego ściągać; straż schodzi bez wysyłania pustej misji.
      if (!byOperator && w.armed && w.homeBody && w.refugeBody === w.homeBody && !ThreatMonitor.active() && ((w.saves || 0) > 0 || !w.lastSendAt)) {
        this.disarm("flota na ciele domowym, alarm minął");
        return false;
      }
      // v2.106.2 — 18:37:56→19:22: straż uzbrojona przez ratunek, który 20 s
      // później skończył się „nothing to save — aborting" (saves=0). Powrót
      // wymaga saves≥1, więc taka straż wisiała 45 min i blokowała FS
      // („czekam ze startem: straż obrony uzbrojona"). Alarm zgasł, żadna
      // wysyłka nie została potwierdzona, 3 min ciszy → straż schodzi sama.
      if (!byOperator && w.armed && !w.saves && !ThreatMonitor.active()) {
        const ref = Math.max(w.since || 0, w.lastAt || 0, w.lastSendAt || 0);
        if (ref && Date.now() - ref > 3 * 60 * 1000) {
          this.disarm("straż bez żadnej potwierdzonej wysyłki, alarm minął — nie ma czego ściągać");
          return false;
        }
      }
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
        // v2.102.3 (16:25:15): powrót NIGDY przed widzianym dolotem ataku + 60 s,
        // nawet gdy alarm zszedł (błędnie). To jest twardy bezpiecznik.
        {
          let until = 0;
          try { until = (JSON.parse(GM_getValue("ogamex_atk_until_map", "{}")) || {})[RescueQueue.str(w.at)] || 0; } catch {}
          // v2.102.4: granica = MIN(dolot pary, bezpiecznik). Prawdziwy atak widziany
          // ciągle podnosi bezpiecznik aż do dolotu; wabik zawrócony zatrzymuje go
          // ≤20 min po ostatnim widzeniu — powrót nie czeka 3 h na nic.
          const fuse = parseInt(GM_getValue("ogamex_atk_fuse", "0")) || 0;
          if (until && fuse) until = Math.min(until, fuse);
          if (until && Date.now() < until + 60 * 1000) {
            this._sayOnce("untilwait", `[POWRÓT] widziany atak dolatuje ${new Date(until).toLocaleTimeString("pl-PL")} — powrót dopiero minutę po dolocie.`, "warn");
            return false;
          }
        }
        // v2.100.1 (F4): flota w powietrzu (ucieczka) — powrót nie ma czego
        // ściągać i nie wolno mu rozbroić straży „bo pusto"; czeka na lądowanie.
        try {
          if (AirSave.decideFor(w.at) === "active") {
            this._sayOnce("airwait", "[POWRÓT] ucieczka w powietrze jeszcze trwa — powrót po jej lądowaniu.", "info");
            return false;
          }
        } catch {}
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
        // v2.86.5: okno domknięcia wg realnego czasu lotu (hop = 3 min po
        // staremu; powrót międzykolonijny trwa tyle, co ratunek).
        const doneAfterMs = Math.max(3 * 60 * 1000, (w.lastFlightMs || 0) + 60000);
        if (age > doneAfterMs) {
          ThreatLog.add("POWRÓT", `Powrót wysłany ${Math.round(age / 1000)}s temu — lot trwał najwyżej ~${Math.round(doneAfterMs / 60000)} min, więc jest po wszystkim. Straż zdjęta.`);
          this.disarm("powrót dawno dolecial — zamykam alarm");
          return false;
        }
        this._sayOnce("returning", `[RATUNEK] powrót już leci (${Math.round(age / 1000)}s temu) — nie wysyłam drugiego.`, "info");
        return false;
      }
      // ── v2.74.5: nie zawracaj floty, której RATUNEK jeszcze leci ──
      // Incydent 6.08 12:32: alarm zszedł 20 s po wysłaniu ratunku (lot 81 s
      // na te same koordy); powrót wystartował od razu, zastał PUSTE refugium
      // i rozbroił straż — a ratunek wylądował minutę później na planecie
      // i nikt go już nie ściągnął. Powrót czeka, aż ratunek fizycznie
      // doleci: 130 s od stempla wysyłki/utworzenia (hop = 81 s + zapas).
      if (!byOperator) {
        const ref = Math.max(w.lastSendAt || 0, w.lastAt || 0);
        // v2.86.5: lądowanie wg REALNEGO czasu lotu ratunku (hop = 130 s
        // jak dotąd; lot międzykolonijny = jego czas + minuta zapasu).
        const landAt = ref + Math.max(130000, (w.lastFlightMs || 0) + 60000);
        if (ref && Date.now() < landAt) {
          this._sayOnce("waitland", `[POWRÓT] ratunek jeszcze w locie (~${Math.ceil((landAt - Date.now()) / 1000)}s do lądowania) — powrót poczeka.`, "info");
          return false;
        }
      }
      // v2.104.7: dom = księżyc, a księżyca już NIE MA (Destroy 26.08 18:26)?
      // Powrót „na księżyc" kręciłby się w kółko (brak przełącznika na kroku 2,
      // 3 nieudane próby, backoff 5 min, i od nowa). Flota zostaje na planecie,
      // straż zdjęta, głośny wpis — start misji sam spada na planetę (v2.82).
      if ((w.homeBody || "planet") === "moon" && HomeBase.pairHasMoon(w.at) === false) {
        const k = RescueQueue.str(w.at) || "?";
        log(`[KSIĘŻYC ZNISZCZONY] para [${k}] nie ma już księżyca — powrót odwołany, flota ZOSTAJE na planecie. Wszystkie starty (ekspedycje/FS/mining) idą teraz z planety; falanga je widzi. Plan odbudowy: MOON-STRATEGY-2026-08-26.md.`, "error");
        ThreatLog.add("ATAK", `🌑 KSIĘŻYC [${k}] ZNISZCZONY — flota zostaje na planecie, straż zdjęta. Bez księżyca falanga widzi loty. Odbuduj (moonshot) — MOON-STRATEGY-2026-08-26.md.`);
        GM_setValue("ogamex_moon_lost_" + k, String(Date.now()));
        this.disarm("księżyc zniszczony — powrót niemożliwy");
        try { MoonRebuild.schedule(w.at, "księżyc zniszczony"); } catch {}   // v2.105.0
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
          byOperator: !!byOperator,   // v2.104.0
          atCoords: w.at || CONFIG.asteroidMining.minerBase,
          targetBody: home,     // …and this leg flies back to where the fleet lives
          launchBody: refuge,   // …starting from the body it fled to
          fleetUrl: url,
          step: "switch_to_body",
          timestamp: Date.now(),
        }));
        this.saveWatch({ ...w, returning: true, returnAt: Date.now() });
        // v2.79.0: stempel okna obrony — wysyłki stoją, aż powrót wyląduje
        // i surowce (paliwo!) wrócą na konto ciała.
        DefenceHold.stamp();
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
      const w = this.normalizeWatch();   // v2.102.0 (C-F1)
      if (!w.armed) return false;
      // Ostatnia linia obrony przed zatorem: straż uzbrojona godzinę bez
      // zagrożenia to nie alarm, tylko zapomniany stan. Sama się nie odblokuje,
      // a każde jej odpalenie rusza CAŁĄ flotą.
      let airActive = false;
      try { airActive = AirSave.decideFor(w.at) === "active"; } catch {}
      let untilPair = 0; try { untilPair = (JSON.parse(GM_getValue("ogamex_atk_until_map", "{}")) || {})[RescueQueue.str(w.at)] || 0; const f = parseInt(GM_getValue("ogamex_atk_fuse", "0")) || 0; if (untilPair && f) untilPair = Math.min(untilPair, f); } catch {}
      if (w.since && Date.now() - w.since > this.MAX_ARMED_MS && !ThreatMonitor.active() && !airActive && Date.now() >= untilPair + 60 * 1000) {
        if (w.refugeBody && w.homeBody && w.refugeBody !== w.homeBody) {
          // v2.107.1 (27.08 09:12): push „flota poza domem (moon)" bez koordów po
          // 16 h przerwy — straż z wczoraj na [5:125:4] (hangar PUSTY), a flota
          // stała bezpiecznie na księżycu [2:21:1]. Teraz: koordy w komunikacie,
          // a gdy mapa hangarów (<48 h) mówi „hangar tej pary pusty" → info, nie BŁĄD.
          const pairK = RescueQueue.str(w.at);
          let known = null; try { const e = (JSON.parse(GM_getValue(FleetRecon.KEY_HANGARS, "{}")) || {})[pairK]; if (e && Date.now() - (e.at || 0) < 48 * 60 * 60 * 1000) known = e.total || 0; } catch {}
          if (known === 0) {
            log(`[STRAŻ] bezpiecznik zdejmuje zwietrzałą straż [${pairK}] — hangar tej pary pusty wg ostatniego odczytu, nic do ściągania.`, "info");
          } else {
            log(`[STRAŻ] bezpiecznik zdejmuje straż [${pairK}], a flota stoi na ${w.refugeBody === "moon" ? "księżycu" : "planecie"} (dom: ${w.homeBody === "moon" ? "księżyc" : "planeta"}) — ŚCIĄGNIJ JĄ RĘCZNIE (WRÓĆ NA BAZĘ).`, "error");
            ThreatLog.add("BŁĄD", `Straż [${pairK}] zdjęta bezpiecznikiem, flota poza domem (${w.refugeBody}) — wróć ręcznie przyciskiem WRÓĆ NA BAZĘ.`);
          }
        }
        ThreatLog.add("BŁĄD", `Straż była uzbrojona ponad ${Math.round(this.MAX_ARMED_MS / 60000)} min bez zagrożenia — zdejmuję jako zator stanu.`);
        this.disarm("bezpiecznik: uzbrojona zbyt długo bez zagrożenia");
        return false;
      }
      if (!ThreatMonitor.active()) {
        // Don't disarm out from under returnHome() — it needs the armed state
        // to know there is something on the moon to bring back.
        if (CONFIG.threatAlarm?.autoReturn) return false;
        // v2.102.4 (D5): bez rozbrajania — po włączeniu auto-powrotu straż wraca
        // normalnie; bezpiecznik 60 min zostaje jedynym wyjściem.
        this._sayOnce("noautoret", "[STRAŻ] alarm minął, auto-powrót OFF — flota zostaje na refugium; włącz auto-powrót albo WRÓĆ NA BAZĘ.", "warn");
        return false;
        return false;
      }
      if (this.running) return false;
      // ── v2.101.0: tempo zamiatania wg zegara POWROTÓW i dolotu wroga ──
      let plan = null;
      try {
        const key = RescueQueue.str(w.at);
        const ev = ThreatMonitor.events();
        const minEta = (ev?.targetMinEta || {})[key] || 0;
        const attackAt = minEta > 0 ? (ev.at || Date.now()) + minEta * 1000 : 0;
        const bodies = (ev?.targetBodiesAll || {})[key] || [];
        const atkBody = bodies.length === 1 ? bodies[0] : null;
        plan = this.sweepPlan({ now: Date.now(), lastAt: w.lastAt || 0, returns: OwnReturns.landingsAt(key, atkBody), attackAt });
        this.warnDoomed(plan.doomed, attackAt, key);
      } catch (e) { plan = null; }
      if (plan ? !plan.due : (Date.now() - (w.lastAt || 0) < this.MIN_RESAVE_MS)) return false;
      if ((w.saves || 0) >= this.MAX_SAVES_PER_ALERT) {
        if (!w.capped) { this.saveWatch({ ...w, capped: true }); log(`[MOON SAVE] limit ${this.MAX_SAVES_PER_ALERT} zapisów na alarm osiągnięty — straż stoi. SPRAWDŹ GRĘ.`, "error"); }
        return false;
      }
      // ── v2.100.0: ZAMIATANIE STARTUJE Z ATAKOWANEGO CIAŁA ──
      // Dotąd sweep startował z ciała AKTYWNEGO w UI (= z którego był
      // pierwszy ratunek). Gdy napastnik przeniósł atak na drugie ciało,
      // zamiatanie sprzątało puste ciało, a wracające fale ekspedycji
      // lądowały pod atakiem. Teraz: jedno atakowane ciało → start z niego
      // (switch_to_body), cel = drugie; oba → ucieczka w powietrze (jej
      // własne zamiatanie w AirSave.tick() zbiera fale w trakcie lotu).
      // v2.100.1 (F3): ucieczka w powietrze tej pary w toku → ŻADNE zamiatanie
      // straży (ani nowe, ani stare) — stare run() wywłaszcza pending i zabiłoby
      // lot dodatkowy ucieczki; zamiata wyłącznie AirSave.tick().
      try { if (AirSave.decideFor(w.at) === "active") return false; } catch {}
      try {
        if (CONFIG.threatAlarm?.bodyAwareGuard !== false && !w.returning) {
          const key = RescueQueue.str(w.at);
          const bodies = ThreatMonitor.attackBodiesFor(key);   // v2.102.4: lista ∪ pamięć (∪ nadwyżka paska = oba)
          if (bodies.length >= 2) {
            const v = AirSave.decideFor(w.at);
            if (v === "air") {
              ThreatLog.add("STRAŻ", `Zamiatanie: oba ciała [${key}] pod atakiem — ucieczka w powietrze zamiast skoku.`);
              return this.run({ auto: true, where: w.at, reason: `AUTOMAT: oba ciała [${key}] pod atakiem (zamiatanie)` });
            }
          } else if (bodies.length === 1 && (bodies[0] === "moon" || bodies[0] === "planet")) {
            const atk = bodies[0], other = atk === "moon" ? "planet" : "moon";
            ThreatLog.add("STRAŻ", `Zamiatanie nr ${(w.saves || 0) + 1}: sprzątam atakowane ciało (${atk}) → ${other}.`);
            return this.swapWithinPair(w, atk, other, `straż wielofalowa — sprzątam ${atk === "moon" ? "księżyc" : "planetę"}`, { sweep: true });
          }
        }
      } catch (e) { log(`[STRAŻ] błąd zamiatania świadomego ciała: ${e.message} — zamiatam po staremu.`, "warn"); }
      ThreatLog.add("STRAŻ", `Zamiatanie nr ${(w.saves || 0) + 1}: sprawdzam, czy coś wróciło na bazę.`);
      return this.run({ sweep: true, reason: "straż wielofalowa — sprzątam planetę" });
    },

    // ── v2.100.0: CZYSTA decyzja skoku w obrębie pary (test-fale.js) ──
    // attacked = ciała pary z listy ruchów, fleetBody = ciało, na którym stoi
    // flota (refugeBody straży). "air" = oba pod atakiem; "move" = atak w ciało
    // z flotą, drugie czyste; "hold" = flota po bezpiecznej stronie (albo
    // nic nie leci); "legacy" = nie wiemy, gdzie flota — stara ścieżka.
    // v2.100.1: commit ciała floty po POTWIERDZONEJ wysyłce skoku (obie ścieżki
    // potwierdzenia mogą wołać — zapis idempotentny).
    // ── v2.102.0 (C4 recenzji): porażka wysyłki ratunku = szybki retry Z BACKOFFEM ──
    // 20 s, 40 s, 80 s … do 5 min; licznik zeruje potwierdzona wysyłka
    // (commitGuardSwap). Bez tego pętla „formularz pada → reload → formularz"
    // mieliła stronę co 20 s przez cały alarm i pchała BŁĄD za każdym razem.
    noteRescueFail(why) {
      try {
        const w = this.watch();
        if (!w.armed) return;
        const fails = (w.fails || 0) + 1;
        const backoff = Math.min(20 * 1000 * Math.pow(2, fails - 1), 5 * 60 * 1000);
        this.saveWatch({ ...w, fails, lastAt: Date.now() - this.MIN_RESAVE_MS + backoff });
        DefenceWatchdog.note(`ratunek nieudany (${why}) — próba ${fails}, następna za ~${Math.round(backoff / 1000)} s`);
        if (fails === 3) { log(`[RATUNEK] 3 nieudane wysyłki z rzędu (${why}) — zwalniam tempo prób do maks. 5 min. SPRAWDŹ FORMULARZ RĘCZNIE.`, "error"); ThreatLog.add("BŁĄD", `Ratunek: 3 nieudane wysyłki (${why}) — sprawdź formularz ręcznie.`); }
      } catch {}
    },

    // ── v2.102.0 (C-F1): flaga `returning` WYGASA po realnym czasie lotu ──
    // Dotąd gasł ją tylko returnHome, a ten wychodzi na active() — więc gdy
    // alarm wrócił w trakcie powrotu, `returning` zostawało true na cały
    // alarm: gałąź „move" i zamiatanie świadome ciała (obie `!returning`)
    // milczały, a stare zamiatanie startowało z pustego refugium. Flota stała
    // w domu pod 2. falą. Po wygaśnięciu: flota jest w DOMU (refugeBody=home).
    normalizeWatch() {
      const w = this.watch();
      if (!w.armed || !w.returning || !w.returnAt) return w;
      const doneAfterMs = Math.max(3 * 60 * 1000, (w.lastFlightMs || 0) + 60000);
      if (Date.now() - w.returnAt < doneAfterMs) return w;
      const w2 = { ...w, returning: false, returnAt: 0, refugeBody: w.homeBody || w.refugeBody };
      this.saveWatch(w2);
      ThreatLog.add("odczyt", `Powrót sprzed ${Math.round((Date.now() - w.returnAt) / 60000)} min uznany za wylądowany — flota na ${w2.refugeBody === "moon" ? "księżycu" : "planecie"} (dom); straż pilnuje dalej.`);
      return w2;
    },

    // v2.104.0 (recenzja W4): flip formularza (dom/refugium odwrócone) zapisuje
    // kierunki TAM, gdzie żyje ta kolonia: straż — tylko gdy to strzeżona para;
    // kolonia z kolejki — jej wpis pending. Nieuzbrojona straż = nic (zjawa).
    noteFlip(mission, homeBody, refugeBody) {
      try {
        const w = this.watch();
        if (!w.armed) return;
        const mk = RescueQueue.str(mission && mission.atCoords);
        if (!mk || RescueQueue.str(w.at) === mk) { this.saveWatch({ ...w, homeBody, refugeBody }); return; }
        const st = RescueQueue.state();
        const e = (st.pending || []).find(x => RescueQueue.str(x.at) === mk);
        if (e) { e.homeBody = homeBody; e.refugeBody = refugeBody; RescueQueue.save(st); }
      } catch {}
    },

    // v2.104.0: jeden głośny komunikat na 5 min per para (nie co tick — audyt W2).
    shoutBothHit(at, why) {
      const k = AirSave.key(at) || "?";
      const saidKey = `ogamex_bothhit_said_${k}`;
      if (Date.now() - (parseInt(GM_getValue(saidKey, "0")) || 0) < 5 * 60 * 1000) { DefenceWatchdog.note(`oba ciała [${k}] atakowane, ${why} — flota nie ruszona (komunikat zdławiony)`); return; }
      GM_setValue(saidKey, String(Date.now()));
      let eta = ""; try { const ev = ThreatMonitor.events(); const mn = (ev?.targetMinEta || {})[k], mx = (ev?.targetMaxEta || {})[k]; if (mn || mx) eta = ` Doloty: ${mn ? Math.round(mn / 60) : "?"}–${mx ? Math.round(mx / 60) : "?"} min.`; } catch {}
      log(`[RATUNEK] OBA ciała [${k}] pod atakiem, a ${why} — NIE przenoszę floty w obrębie pary (leciałaby pod uderzenie).${eta} SPRAWDŹ GRĘ.`, "error");
      ThreatLog.add("BŁĄD", `Oba ciała [${k}] atakowane, ${why} — flota NIE ruszona. Ratuj ręcznie.`);
      try { Notifier.push("OGameX: oba ciała kolonii pod atakiem", `[${k}] — bot nie ma jak uciec, ratuj ręcznie.`, "urgent", "rotating_light"); } catch {}
    },

    commitGuardSwap(mission) {
      if (!mission || !mission.guardSwap || !mission.targetBody) return;
      const w = this.watch();
      if (!w.armed) return;
      // v2.101.0: limit zapisów liczy TYLKO potwierdzone wysyłki (pusty hangar
      // nie zjada limitu) — dedup po znaczniku misji (dwie ścieżki potwierdzenia).
      const stamp = mission.timestamp || 0;
      const counted = stamp && w.lastCountedStamp === stamp;
      if (w.refugeBody === mission.targetBody && counted) return;
      this.saveWatch({ ...w, refugeBody: mission.targetBody, homeBody: (mission.verify && mission.launchBody) ? mission.launchBody : w.homeBody, saves: (w.saves || 0) + (counted ? 0 : 1), lastCountedStamp: stamp || w.lastCountedStamp, fails: 0 });
      if (w.refugeBody !== mission.targetBody) ThreatLog.add("RATUNEK", `Straż: flota stoi teraz na ${mission.targetBody === "moon" ? "księżycu" : "planecie"} (potwierdzone).`);
    },

    // ── v2.101.0: CZYSTE tempo zamiatania wg zegara powrotów (test-zamiatanie.js) ──
    // returns = czasy lądowań naszych fal na atakowanym ciele (ms epoch),
    // attackAt = najbliższe uderzenie wroga (ms epoch, 0 = nieznane).
    //  • coś wylądowało od ostatniego zamiatania → zamiataj po FAST (20 s),
    //  • uderzenie za < 3 min → też FAST (każda sekunda się liczy),
    //  • inaczej stary krok MIN (90 s) — spokojny alarm nie mieli strony.
    //  • doomed = powroty lądujące < 60 s przed uderzeniem: nie zdążymy
    //    (3 przeładowania + formularz) — tylko głośne ostrzeżenie.
    sweepPlan({ now, lastAt, returns, attackAt, minGap, fastGap, fastWindow, doomWindow, soonGap }) {
      const MIN = minGap ?? 90000, FAST = fastGap ?? 20000, WIN = fastWindow ?? 180000, DOOM = doomWindow ?? 60000;
      // v2.102.1 (test 25.08 11:36-11:37): samo „wróg blisko" bez znanego lądowania
      // mieliło 4 puste zamiatania po 3 przeładowania w 100 s. Lądowanie → FAST,
      // sama bliskość → SOON (45 s); MIN zostaje krokiem spokojnym.
      const SOON = soonGap ?? 45000;
      const last = lastAt || 0;
      const since = now - last;
      const rs = (returns || []).filter(t => Number.isFinite(t));
      const landed = rs.filter(t => t > last && t <= now).length;
      const soon = !!(attackAt && attackAt > now && attackAt - now < WIN);
      const gap = landed ? FAST : (soon ? Math.min(SOON, MIN) : MIN);
      const doomed = attackAt ? rs.filter(t => t > now && t < attackAt && attackAt - t < DOOM) : [];
      return { due: since >= gap, gap, landed, soon, doomed };
    },

    warnDoomed(doomed, attackAt, key) {
      if (!doomed || !doomed.length) return;
      let said = {};
      try { said = JSON.parse(GM_getValue("ogamex_doomed_said", "{}")) || {}; } catch {}
      let changed = false;
      for (const t of doomed) {
        const id = `${key}:${Math.round(t / 20000)}`;   // kubełek 20 s — odliczanie dryfuje o sekundy między tickami
        if (said[id]) continue;
        said[id] = Date.now(); changed = true;
        const secs = Math.max(0, Math.round((attackAt - t) / 1000));
        log(`[STRAŻ] FALA NIE DO URATOWANIA: powrót na [${key}] ląduje ${secs} s przed uderzeniem — automat nie zdąży jej przenieść (formularz trwa dłużej). Jeśli możesz, ZAWRÓĆ ją ręcznie albo przenieś od razu po lądowaniu.`, "error");
        ThreatLog.add("ATAK", `Powrót na [${key}] ląduje ${secs} s przed uderzeniem — poza zasięgiem automatu. Ratuj ręcznie.`);
      }
      if (changed) {
        for (const k of Object.keys(said)) if (Date.now() - said[k] > 6 * 60 * 60 * 1000) delete said[k];
        GM_setValue("ogamex_doomed_said", JSON.stringify(said));
      }
    },

    swapDecision({ attacked, fleetBody }) {
      const a = [...new Set((attacked || []).filter(b => b === "moon" || b === "planet"))];
      if (a.length >= 2) return "air";
      if (!a.length) return "hold";
      if (fleetBody !== "moon" && fleetBody !== "planet") return "legacy";
      return a[0] === fleetBody ? "move" : "hold";
    },

    // ── v2.100.0: skok w obrębie strzeżonej pary z JAWNYM ciałem startu ──
    // Ta sama maszyneria co returnHome (switch_to_body → formularz), ale
    // kierunek podaje wołający. flippedBody=true wyłącza korekty ciała na
    // formularzu (one zakładają PIERWSZY ratunek alarmu). homeBody zostaje —
    // powrót po alarmie nadal wie, gdzie dom; refugeBody = nowe miejsce floty.
    async swapWithinPair(w, from, to, reason, { sweep = false, verify = false } = {}) {
      if (this.running) return false;
      if (!w || !w.armed || !w.at) return false;
      if (from === to || !["moon", "planet"].includes(from) || !["moon", "planet"].includes(to)) return false;
      const url = this.homeUrl(w.at);
      if (!url) return false;
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") {
        let kind = "?";
        try { const pm = JSON.parse(pending); kind = pm.moonSave || pm.fleetSave ? "obrona" : (pm.type || "?"); } catch {}
        if (kind === "obrona") return false;              // ratunek/powrót w toku — nie dublować
        ThreatLog.add("RATUNEK", `Wywłaszczenie: przerwane zadanie ${kind}, żeby zrobić skok ${from} → ${to}.`);
        GM_setValue("pending_mission", null);
      }
      this.running = true;
      try {
        GM_setValue("pending_mission", JSON.stringify({
          type: "moon_save_direct",
          moonSave: true,
          sweep: !!sweep,
          flippedBody: true,     // ciało startu jawne — bez korekt formularza
          guardSwap: true,       // v2.100.1: refugeBody zapisze się DOPIERO po potwierdzonej wysyłce
          verify: !!verify,      // v2.102.4: strażnik weryfikujący — potwierdzona wysyłka = flota BYŁA na ciele startu (dom)
          atCoords: w.at,
          launchBody: from,
          targetBody: to,
          homeBody: w.homeBody || from,
          fleetUrl: url,
          step: "switch_to_body",
          timestamp: Date.now(),
        }));
        this.saveState({ at: Date.now(), reason });
        // v2.100.1 (F1): refugeBody NIE zmienia się tutaj — pusty hangar (flota
        // w locie) kończył się „aborting", a straż już wierzyła, że flota stoi
        // na nowym ciele. Zapis robi commitGuardSwap po potwierdzeniu gry.
        // v2.101.0: `saves` rośnie dopiero po potwierdzonej wysyłce (commitGuardSwap).
        this.saveWatch({ ...w, lastAt: Date.now() });
        DefenceHold.stamp();
        const nameOf = (b) => (b === "moon" ? "KSIĘŻYC" : "PLANETĘ");
        log(`RATUNEK FLOTY: ${nameOf(from)} → ${nameOf(to)} na [${w.at.galaxy}:${w.at.system}:${w.at.position}] (${reason}).`, sweep ? "fleet" : "success");
        ThreatLog.add("RATUNEK", `Start: ${nameOf(from)} → ${nameOf(to)} (${reason}). Potwierdzonych wysyłek w tym alarmie: ${w.saves || 0}.`);
        await AntiDetection.sleep(400 + Math.random() * 600);
        window.location.replace("/");
        return true;
      } catch (err) {
        log(`[MOON SAVE] skok ${from} → ${to} nieudany: ${err.message}`, "error");
        return false;
      } finally {
        this.running = false;
      }
    },

    async run({ manual = false, sweep = false, auto = false, reason = "manual", where = null, queued = false, noGate = false } = {}) {
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
        let pm = null;
        try { pm = JSON.parse(pending); kind = pm?.type || kind; } catch {}
        // ── v2.100.1 (N1, luka od 2.85.0): NIE wywłaszczaj WŁASNEJ obrony ──
        // Start ucieczki w powietrze zapisuje pending i przeładowuje stronę;
        // pierwszy tick obrony (1,5 s) wchodził tu PRZED obsługą formularza
        // (3-8 s) i kasował własny start — ucieczka nigdy nie ruszała, po
        // 5 min markFailed. Świeże (<3 min) zadanie ratunku/FS/skoku zostaje;
        // starsze = zator formularza, wolno przejąć.
        if (pm && (pm.moonSave || pm.fleetSave) && Date.now() - (pm.timestamp || 0) < 3 * 60 * 1000) {
          DefenceWatchdog.note(`ratunek w toku (${kind}) — nowy run() ustępuje`);
          return false;
        }
        log(`[RATUNEK] przerywam trwające zadanie (${kind}) — ratunek floty ma pierwszeństwo.`, "warn");
        ThreatLog.add("RATUNEK", `Wywłaszczenie: przerwane zadanie ${kind}, żeby nie czekać na wolny slot.`);
        GM_setValue("pending_mission", null);
      }
      this.running = true;
      try {
        // v2.75.4: coordsOf(null) domyślnie zwraca BAZĘ, więc stary zapis
        // `coordsOf(where) || coordsOf(watch().at)` NIGDY nie sięgał po
        // watch().at — zamiatanie straży na atakowanej kolonii celowało
        // w bazę (incydent 22:18 06.08: sweep [2:277:8] poleciał w [3:272:7]).
        // Kolejność: jawne where → kolonia z alarmu → dopiero baza.
        // ── v2.85.1: ratunek bez celu chroni AKTYWNĄ parę, nie starą bazę ──
        // Incydent 12.08 10:56 NA ŻYWO: atak ACS na księżyc [2:277:8] wykryty
        // ze ŚCIEŻKI PASKA (lista ruchów bez wierszy → where=null), a fallback
        // wysłał wszystko z aktywnego księżyca... Deployem do [3:272:7] —
        // 1 h 25 min lotu przez pół wszechświata zamiast skoku <1 min na
        // planetę TEJ pary. Flota ocalała (lot = nietykalność), ale straż
        // uzbroiła się na złej kolonii i auto-powrót nie miał czego ściągać.
        // ── v2.86.3: RATUNEK BEZ CELU BRONI DOMU FLOTY ──
        // KATASTROFA 12.08 13:10 — utrata floty głównej na [2:277:8]:
        // Ibra646 [2:277:11] (ten sam układ, ~3 min lotu) zaatakował, a lista
        // ruchów ZNOWU nie oddała wiersza (pasek 1 obcy / lista 0 → cel
        // nieznany). Fallback v2.85.1 „chroń aktywną parę" trafił w księżyc
        // MINERÓW [3:272:7], bo v2.84 sam przełącza aktywne ciało przy każdej
        // wysyłce górniczej — obrona sprzątała kolonię, przy której bot
        // PRACOWAŁ, zamiast tej, na której MIESZKA flota. Ostatnie zamiatanie
        // dotarło na [2:277:8] 4 sekundy po uderzeniu.
        // Ratunek bez znanego celu broni od teraz DOMU FLOTY: punktu startu
        // ekspedycji (tam z definicji stoi flota główna i tam wracają fale),
        // dopiero potem aktywnej pary, na końcu minerBase.
        let fleetHome = CONFIG.expeditions?.launchFrom || null;
        try { const fhk = FleetRecon.fleetHome(); if (fhk) fleetHome = RescueQueue.obj(fhk) || fleetHome; } catch {}   // v2.104.0
        // v2.87.0: wybór celu przez CZYSTĄ funkcję (testowaną macierzą
        // offline i w autoteście) — semantyka 2.86.5 bez zmian: ręczny
        // RATUJ chroni parę operatora, automat bez celu chroni dom floty.
        const at = this.coordsOf(this.resolveRescueTarget({
          where, watchAt: this.watch().at, manual, fleetHome, activePair: HomeBase.coords(),
        }));
        // ── v2.85.0: UCIECZKA W POWIETRZE — decyzja PRZED zwykłym ratunkiem ──
        // Oba ciała TEJ pary pod atakiem = ewakuacja w obrębie pary przenosi
        // flotę pod drugie uderzenie; wtedy (i tylko wtedy) całość leci
        // powolnym Deployem do innej kolonii. Każde „nie" (wyłączone, jedno
        // ciało, świeża porażka, zamiatanie, kolejka, ręczny RATUJ) = stara,
        // bojowo potwierdzona ścieżka — dno regresji to 2.84.0.
        // v2.103.2: KOLEJKA też — incydent 21:23 (symulacja `both` na [5:67:5]
        // przy trwającym alarmie bazy): ratunek z kolejki przeniósł flotę
        // księżyc → planeta TEJ SAMEJ pary, choć planeta też była atakowana.
        // Kolejka nie może ruszyć floty w obręb pary, gdy oba ciała są celem:
        // wolna ucieczka w powietrze → leci; zajęta (inna kolonia w locie) →
        // NIE ruszamy niczego i krzyczymy.
        if (!sweep && !manual) {
          const airVerdict = AirSave.decideFor(at);
          if (airVerdict === "active") {
            DefenceWatchdog.note(`ucieczka w powietrze w toku dla [${AirSave.key(at)}] — zwykły ratunek wstrzymany`);
            return false;
          }
          const bothHit = (() => { try { return ThreatMonitor.attackBodiesFor(AirSave.key(at)).length >= 2; } catch { return false; } })();
          if (queued && bothHit) {
            const ast = AirSave.state();
            const busy = ast && ast.phase && ["arming", "launched", "recalled"].includes(ast.phase) && AirSave.key(ast.at) !== AirSave.key(at);
            if (busy || airVerdict !== "air") {
              const why = busy ? `ucieczka w powietrze zajęta przez [${AirSave.key(ast.at)}]` : `ucieczka niedostępna (${airVerdict})`;
              this.shoutBothHit(at, why);
              return false;
            }
          }
          if (airVerdict === "air") {
            let maxEta = 0;
            try { maxEta = (ThreatMonitor.events()?.targetMaxEta || {})[AirSave.key(at)] || 0; } catch {}
            // v2.102.4: wiersz ukryty przez fork → dolot z pamięci pary (inaczej zawrócenie po 2 min = lądowanie pod atak)
            if (!maxEta) { try { const u = (JSON.parse(GM_getValue("ogamex_atk_until_map", "{}")) || {})[AirSave.key(at)] || 0; if (u > Date.now()) maxEta = Math.round((u - Date.now()) / 1000); } catch {} }
            if (await AirSave.launch(at, reason, maxEta)) return true;
            // v2.104.0 (audyt K2): oba ciała pod atakiem, a ucieczka nie ruszyła
            // (brak refugium na pasku) → skok w parze = pod uderzenie. NIE ruszamy.
            if (bothHit) { this.shoutBothHit(at, "ucieczka w powietrze nie wystartowała (brak refugium na pasku planet?)"); return false; }
          }
          // ucieczka „swap" po świeżej porażce, a oba ciała nadal atakowane → też stop
          if (bothHit && airVerdict === "swap" && AirSave.enabled()) { this.shoutBothHit(at, `ucieczka niedostępna (${airVerdict})`); return false; }
        }
        // ── v2.106.0: BRAMA SKOKOWA PRZED DEPLOYEM ──
        // Flota na KSIĘŻYCU tej pary, ratunek nie jest zamiataniem/kolejką,
        // brama włączona i bez świeżej porażki → skok na inny księżyc (0 s).
        // Każda porażka bramy wraca tu z noGate=true → Deploy jak dotąd.
        try {
          const activePair0 = HomeBase.coords();
          const samePair0 = !!(at && activePair0 && activePair0.galaxy === at.galaxy && activePair0.system === at.system && activePair0.position === at.position);
          if (!noGate && !sweep && !queued && samePair0 && this.currentBody() === "moon" && GateSave.canTry(at)) {
            this.saveState({ at: Date.now(), reason });
            const w0g = this.watch();
            this.saveWatch({ ...w0g, armed: true, at, homeBody: "moon", refugeBody: w0g.refugeBody || "moon", since: w0g.since || Date.now(), trigger: w0g.trigger || (manual ? "manual" : "threat"), saves: w0g.saves || 0, lastAt: Date.now() });
            DefenceHold.stamp();
            GateSave.start(at, reason);
            await AntiDetection.sleep(300 + Math.random() * 400);
            window.location.replace("/");
            return true;
          }
        } catch (e) { log(`[BRAMA] błąd decyzji: ${e.message} — ratunek Deployem.`, "warn"); }
        const href = this.targetUrl(at);
        // ── v2.28.0: uciekaj na DRUGIE ciało, nie zawsze na księżyc ──
        // Właściciel: „jeśli flota stoi na księżycu i leci atak na księżyc, ma
        // przenieść na planetę i odwrotnie" — i zamierza używać raz jednego,
        // raz drugiego. Okazuje się, że nie trzeba wiedzieć, w co celuje atak:
        // napastnik szpieguje i celuje tam, gdzie WIDZI flotę, więc ucieczka na
        // przeciwne ciało jest właściwa w obu przypadkach. To usuwa zależność
        // od rozpoznania celu, którego nigdy nie udało się potwierdzić.
        const from = this.currentBody() || "planet";
        // v2.86.5: skok w obrębie pary → przeciwne ciało (po staremu).
        // Lot MIĘDZYKOLONIJNY (aktywna para ≠ cel) → celuj w KSIĘŻYC celu:
        // lądowanie na planecie stoi w falandze wroga (ratunek 13:41
        // kliknął planet-icon i leciał 38 min na widoczną planetę).
        const activePair = HomeBase.coords();
        const crossColony = !!(at && activePair && (activePair.galaxy !== at.galaxy || activePair.system !== at.system || activePair.position !== at.position));
        const to = crossColony ? "moon" : (from === "moon" ? "planet" : "moon");
        // v2.102.4: zamiatanie/ratunek w parze NIE może celować w znane atakowane
        // ciało (legacy sweep startował z ciała AKTYWNEGO w UI = np. planeta
        // z uratowaną flotą → lot NA księżyc pod atak).
        if (!crossColony && at) {
          const atkBodies = ThreatMonitor.attackBodiesFor(`${at.galaxy}:${at.system}:${at.position}`);
          if (atkBodies.length === 1 && atkBodies[0] === to) {
            DefenceWatchdog.note(`ratunek ${from}→${to} odrzucony: ${to} jest atakowane (lista/pamięć)`);
            log(`[RATUNEK] nie wysyłam ${from === "moon" ? "z księżyca" : "z planety"} NA ${to === "moon" ? "KSIĘŻYC" : "PLANETĘ"} — to ciało jest atakowane. Zamiatanie pójdzie z atakowanego ciała.`, "warn");
            return false;
          }
        }
        // ── v2.110.0 (decyzja operatora 27.08): ATAK NA KSIĘŻYC z flotą → nie na planetę pary
        // (widoczna w falandze), tylko Deploy na KSIĘŻYC-SĄSIADA w tym samym układzie
        // (AirSave: 10 %, wszystko + surowce − rezerwa, zawrót po przejściu ataków — dziś 10:17
        // zadziałało wzorowo). Planeta pary zostaje jako ostatnia deska, gdy sąsiada nie ma.
        try {
          if (!sweep && !manual && !queued && !crossColony && from === "moon" && to === "planet" && at && AirSave.enabled() && CONFIG.threatAlarm?.airOnMoonAttack !== false) {
            const ref = AirSave.refuge(at);
            const sameSys = !!(ref && ref.galaxy === at.galaxy && ref.system === at.system);
            const verdict = AirSave.decideFor(at);   // "swap" = tylko jedno ciało atakowane (nasz przypadek), "active" = już leci
            let recentFail = false; try { const fa = (JSON.parse(GM_getValue(AirSave.KEY_FAIL, "{}")) || {})[AirSave.key(at)] || 0; recentFail = fa && Date.now() - fa < 10 * 60 * 1000; } catch {}
            if (sameSys && (verdict === "air" || (verdict === "swap" && !recentFail))) {
              let maxEta = 0;
              try { maxEta = (ThreatMonitor.events()?.targetMaxEta || {})[AirSave.key(at)] || 0; } catch {}
              if (!maxEta) { try { const u = (JSON.parse(GM_getValue("ogamex_atk_until_map", "{}")) || {})[AirSave.key(at)] || 0; if (u > Date.now()) maxEta = Math.round((u - Date.now()) / 1000); } catch {} }
              log(`[RATUNEK] atak na KSIĘŻYC [${AirSave.key(at)}] — zamiast planety pary lecę na księżyc-sąsiada [${AirSave.key(ref)}] (Deploy, zawrót po przejściu ataków).`, "warn");
              if (await AirSave.launch(at, reason + " — atak na księżyc, sąsiad w układzie", maxEta)) return true;
              log("[RATUNEK] ucieczka na sąsiada nie ruszyła — ratuję na planetę pary.", "warn");
            } else if (!sameSys) {
              DefenceWatchdog.note(`brak księżyca-sąsiada w układzie [${AirSave.key(at)}] — ratunek na planetę pary`);
            }
          }
        } catch (e) { log(`[RATUNEK] błąd wyboru sąsiada: ${e.message} — ratuję na planetę pary.`, "warn"); }
        const w0 = this.watch();
        GM_setValue("pending_mission", JSON.stringify({
          type: "moon_save_direct",
          moonSave: true,
          sweep: !!sweep, // v2.70.3: zamiatanie nie flipuje na drugie ciało
          guardSwap: true, // v2.102.4: refugeBody/saves dopiero po POTWIERDZONEJ wysyłce (commitGuardSwap)
          atCoords: at,
          targetBody: to,
          // v2.78.0: ratunek z kolejki dotyczy INNEJ kolonii, więc jej
          // domem jest ciało, na którym stoi ONA, a nie dom pierwszej.
          homeBody: queued ? from : (w0.homeBody || from),
          fleetUrl: href,
          step: "select_ships_direct",
          timestamp: Date.now(),
        }));
        this.saveState({ at: Date.now(), reason });
        // Arm (or re-arm) the multi-wave watcher on every save, including the
        // manual one: pressing the button once is the operator saying "we are
        // under attack", and everything that lands afterwards has to go too.
        const w = this.watch();
        const nameOf = (b) => (b === "moon" ? "KSIĘŻYC" : "PLANETĘ");
        if (queued) {
          // ── v2.78.0: ratunek Z KOLEJKI nie tyka straży pierwszej kolonii ──
          // saveWatch() nadpisałoby `at`, więc powrót ściągnąłby TĘ kolonię,
          // a flota pierwszej została na ciele ucieczki na zawsze — czyli
          // nowa funkcja zjadłaby starą. Zamiast tego dopisujemy się do
          // listy oczekujących; promocja po powrocie pierwszej wpuści nas
          // w ten sam, sprawdzony returnHome().
          RescueQueue.addPending({ at, homeBody: from, refugeBody: to, savedAt: Date.now() });
          log(`RATUNEK Z KOLEJKI: ${nameOf(from)} → ${nameOf(to)} na [${at.galaxy}:${at.system}:${at.position}] (${reason}). Straż pierwszej kolonii nietknięta.`, "success");
          ThreatLog.add("RATUNEK", `KOLEJKA: ${nameOf(from)} → ${nameOf(to)} na [${at.galaxy}:${at.system}:${at.position}] (${reason}). Powrót tej kolonii pójdzie zaraz po powrocie pierwszej.`);
        } else {
        // Remember WHO started this: the alarm may undo its own saves, nobody
        // else's. A sweep inherits the trigger of the save it continues.
        const trigger = w.trigger || (auto || ThreatMonitor.active() ? "threat" : "manual");
        // homeBody is where the fleet LIVES — recorded on the first save of an
        // alert and never overwritten by the sweeps, so the return always knows
        // where to put everything back regardless of which body it is today.
        // v2.102.4 (D4): refugeBody = tam, gdzie flota JEST (from) do potwierdzenia;
        // pusty hangar/porażka nie może „przenieść" floty w pamięci straży.
        this.saveWatch({ armed: true, trigger, homeBody: w.homeBody || from, refugeBody: w.refugeBody || from, at,
                         lastAt: Date.now(), saves: (w.saves || 0), since: w.since || Date.now() });
        DefenceHold.stamp(); // v2.79.0: ratunek w powietrzu = cisza na wysyłkach
        log(`RATUNEK FLOTY: ${nameOf(from)} → ${nameOf(to)} na tych samych koordach (${reason}). Wszystkie statki i wszystkie surowce.`, "success");
        ThreatLog.add("RATUNEK", `Start: ${nameOf(from)} → ${nameOf(to)} (${reason}). Zapis nr ${(w.saves || 0) + 1} w tym alarmie.`);
        }
        await AntiDetection.sleep(400 + Math.random() * 600); // emergency: barely any delay
        window.location.replace(href);
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
  //  KOLEJKA RATUNKÓW (v2.78.0) — drugi atak na INNĄ kolonię
  // ═══════════════════════════════════════════════════════════════
  // Do 2.77.2 jeden alarm = jedna kolonia. Gdy straż była już uzbrojona,
  // autoSaveOnThreat kończył się `return false` i drugi atak — na inną
  // kolonię — przechodził bez żadnej reakcji.
  //
  // Cała ta warstwa mieszka WYŁĄCZNIE w tamtej gałęzi. Przy pierwszym ataku
  // `armed` jest fałszem, więc kod nawet do niej nie wchodzi: pierwszy
  // ratunek leci dokładnie tą samą trasą, co przebieg z 7.08 10:41 (46 s od
  // wykrycia do floty w powietrzu). Nowe może się odpalić tylko tam, gdzie
  // dotąd nie działo się nic — i to jest jedyny powód, dla którego ta zmiana
  // nie może zepsuć działającej obrony.
  //
  // Powrót: straż pierwszej kolonii zostaje NIETKNIĘTA, kolejne lądują na
  // liście oczekujących. Gdy powrót pierwszej się kończy, zamiast rozbroić
  // straż PROMUJEMY następną kolonię do tej samej struktury — więc ściąga ją
  // ten sam, sprawdzony returnHome(), a nie świeżo napisany kod.
  const RescueQueue = {
    KEY: "ogamex_rescue_queue",
    MAX_COLONIES: 5,   // limit PER ALARM, liczony w koloniach, nie w zapisach

    state() {
      try {
        const v = JSON.parse(GM_getValue(this.KEY, "null"));
        return (v && typeof v === "object") ? { done: v.done || [], pending: v.pending || [] } : { done: [], pending: [] };
      } catch { return { done: [], pending: [] }; }
    },
    save(st) { GM_setValue(this.KEY, JSON.stringify(st)); },

    // Koniec alarmu kasuje listę obsłużonych kolonii, ale NIE oczekujące
    // powroty — one mają sens dopiero po alarmie i muszą go przeżyć.
    endAlarm() {
      GM_setValue("ogamex_blind_targets", "null");   // v2.106.5
      const st = this.state();
      if (!(st.done || []).length) return;
      st.done = [];
      this.save(st);
    },

    str(at) {
      if (!at) return null;
      if (typeof at === "string") return /^\d+:\d+:\d+$/.test(at) ? at : null;
      return Number.isFinite(at.galaxy) ? `${at.galaxy}:${at.system}:${at.position}` : null;
    },
    obj(t) {
      const m = /^(\d+):(\d+):(\d+)$/.exec(String(t || ""));
      return m ? { galaxy: +m[1], system: +m[2], position: +m[3] } : null;
    },

    // CZYSTA decyzja — bez DOM, sieci i zegara. Dzięki temu sprawdza ją
    // zarówno test offline (test-kolejka.js), jak i AUTOTEST w przeglądarce,
    // na tej samej funkcji, którą wywołuje prawdziwy alarm.
    nextTarget({ targets, guarded, done }) {
      const skip = new Set([guarded, ...(done || [])].filter(Boolean));
      for (const t of (targets || [])) {
        if (!t || typeof t !== "string") continue;
        if (skip.has(t)) continue;
        return t;
      }
      return null;
    },

    // Ile atakowanych kolonii nikt jeszcze nie ruszył — karma dla nadzorcy.
    // Bez tego awaria kolejki byłaby NIEWIDOCZNA: straż uzbrojona z jednym
    // zapisem wygląda jak sukces, choć druga kolonia stoi bez reakcji.
    unhandledCount(w) {
      try {
        if (CONFIG.threatAlarm?.rescueQueue === false) return 0;
        const ev = ThreatMonitor.events();
        if (!ev || !(ev.attacks > 0)) return 0;
        const skip = new Set([this.str(w && w.at), ...(this.state().done || [])].filter(Boolean));
        return (ev.targets || []).filter(t => t && !skip.has(t)).length;
      } catch { return 0; }
    },

    markDone(coords) {
      const st = this.state();
      if (!st.done.includes(coords)) st.done.push(coords);
      this.save(st);
    },
    addPending(entry) {
      this.dropPending(entry && entry.at, "nowy wpis tej samej kolonii");   // v2.104.0: jeden wpis na kolonię
      const st = this.state();
      st.pending.push(entry);
      this.save(st);
    },
    // v2.104.0 (audyt): wpis kolejki traci sens, gdy kolonia uciekła w powietrze,
    // straż została rozbrojona albo hangar okazał się pusty — dotąd przeżywał
    // wszystko (4 h) i wskakiwał przy zupełnie innym powrocie (21:44:54).
    dropPending(coords, why) {
      try {
        const k = this.str(coords); if (!k) return;
        const st = this.state(); const before = (st.pending || []).length;
        st.pending = (st.pending || []).filter(e => this.str(e.at) !== k);
        if (st.pending.length !== before) { this.save(st); log(`[KOLEJKA] wpis [${k}] skasowany: ${why}.`, "info"); }
      } catch {}
    },

    // Wywoływane WYŁĄCZNIE z gałęzi „straż już uzbrojona".
    async tryNext(w) {
      if (CONFIG.threatAlarm?.rescueQueue === false) return false;
      const ev = ThreatMonitor.events();
      // v2.106.5: ślepy alarm — lista celów z mapy hangarów (ważna 15 min, tylko w alarmie)
      let blind = [];
      try { const b = JSON.parse(GM_getValue("ogamex_blind_targets", "null")); if (b && Date.now() - (b.at || 0) < 15 * 60 * 1000 && ThreatMonitor.active()) blind = b.keys || []; } catch {}
      if ((!ev || !(ev.attacks > 0)) && !blind.length) return false;
      if (MoonSave.running) return false;
      const st = this.state();
      const guarded = this.str(w && w.at);
      const next = this.nextTarget({ targets: [...new Set([...((ev && ev.targets) || []), ...blind])], guarded, done: st.done });
      if (!next) return false;
      const at = this.obj(next);
      if (!at) return false;
      // Limit liczony w KOLONIACH, nie w zapisach: alarm na trzech koloniach
      // nie może wyczerpać budżetu zamiatania pierwszej z nich.
      if ((st.done || []).length >= this.MAX_COLONIES) {
        this.markDone(next);   // nie próbuj tej samej w kółko co 30 s
        log(`[KOLEJKA] limit ${this.MAX_COLONIES} kolonii w jednym alarmie osiągnięty — [${next}] NIE ruszona. SPRAWDŹ GRĘ.`, "error");
        ThreatLog.add("BŁĄD", `Kolejka ratunków: limit ${this.MAX_COLONIES} kolonii na alarm. Kolonia [${next}] została BEZ REAKCJI — sprawdź grę.`);
        return false;
      }
      // Strażnik bezpiecznej strony nie ma tu zastosowania z tego samego
      // powodu, co przy pierwszym ratunku na obcej kolonii: obowiązuje tylko,
      // gdy stoimy na atakowanym ciele (`active === target`), a tu z definicji
      // stoimy gdzie indziej. O ciało zadba korekta na formularzu — ta sama,
      // która obsługuje pierwszy ratunek zdalnej kolonii.
      // v2.102.0 (C-F2): „done" DOPIERO po udanym run() — zderzenie z zamiataniem
      // (świeży pending obrony) dawało drugiej kolonii jedną próbę i koniec.
      const saidKey = `ogamex_queue_said_${next}`;
      if (Date.now() - (parseInt(GM_getValue(saidKey, "0")) || 0) > 5 * 60 * 1000) {
        GM_setValue(saidKey, String(Date.now()));
        log(`[KOLEJKA] DRUGI ATAK w trwającym alarmie: kolonia [${next}]. Straż pierwszej ([${guarded || "?"}]) zostaje nietknięta — ratuję TĘ kolonię osobno.`, "error");
        ThreatLog.add("ATAK", `KOLEJKA: drugi atak na [${next}] podczas alarmu na [${guarded || "?"}] — ewakuuję również tę kolonię.`);
      }
      const ok = await MoonSave.run({ auto: true, queued: true, where: at, reason: `AUTOMAT: drugi atak na [${next}]` });
      if (ok) this.markDone(next);
      else DefenceWatchdog.note(`kolejka: ratunek [${next}] nie ruszył (slot zajęty/odmowa) — ponowię w następnym ticku`);
      return ok;
    },

    // ── v2.88.3: promocja TYLKO świeżych wpisów ──
    // Incydent 12.08 23:00 (tuż po TEŚCIE ALARMU): promocja wyjęła z kolejki
    // wpis [3:272:7] zapisany GODZINY wcześniej (bitwa 15:26) — wpis TEJ
    // SAMEJ kolonii, która właśnie wróciła, z ODWROTNYM kierunkiem
    // (dom=planeta, refugium=księżyc). Drugi powrót ruszył księżyc→planeta
    // i tylko dlatego nie wywiózł 10 mld statków + 9,9 bln deuteru w złą
    // stronę, że flota lądowała 5 s PO jego kontroli hangaru („refugium
    // puste — abort"). Wpis przeżył, bo powrót jego alarmu skończył się
    // ścieżką abortu, która nie tyka kolejki — z założenia „pending musi
    // przeżyć alarm", więc TTL i dedup są jedynym płotem.
    PENDING_MAX_AGE_MS: 4 * 60 * 60 * 1000, // backstop alarmu to 3 h (długie doloty ACS) — zombie-wpisy kasuje dropPending (v2.104.0)

    // CZYSTA decyzja (jak nextTarget) — testowana offline w test-kolejka.js.
    staleReason(nx, justReturned, now, maxAgeMs) {
      const at = nx && nx.at;
      const coords = typeof at === "string"
        ? (/^\d+:\d+:\d+$/.test(at) ? at : null)
        : (at && Number.isFinite(at.galaxy) ? `${at.galaxy}:${at.system}:${at.position}` : null);
      if (!coords) return "wpis bez koordynatów";
      if (justReturned && coords === justReturned) return "ta kolonia właśnie wróciła — jej flota już stoi w domu";
      if (now - (nx.savedAt || 0) > maxAgeMs) return "wpis starszy niż 4 h — jego alarm dawno wygasł, kierunki opisują nieaktualny stan";
      return null;
    },

    // Po zakończonym powrocie pierwszej kolonii: zamiast rozbroić straż,
    // wstaw w nią następną kolonię z kolejki. Powrót obsłuży ją tym samym
    // kodem, który właśnie zadziałał.
    promoteNext(why, justReturned = null) {
      const st = this.state();
      while ((st.pending || []).length) {
        const nx = st.pending.shift();
        this.save(st);
        const coords = this.str(nx.at) || "?";
        let stale = this.staleReason(nx, justReturned, Date.now(), this.PENDING_MAX_AGE_MS);
        try { const a = AirSave.state(); if (!stale && a && a.phase && this.str(a.at) === coords) stale = "ta kolonia jest w ucieczce w powietrze — wraca sama"; } catch {}
        if (stale) {
          log(`[KOLEJKA] wpis [${coords}] ODRZUCONY: ${stale}. Flota nie rusza według nieaktualnego kierunku.`, "warn");
          ThreatLog.add("odczyt", `KOLEJKA: wpis [${coords}] odrzucony (${stale}).`);
          continue;
        }
        MoonSave.saveWatch({
          armed: true, trigger: "threat",
          homeBody: nx.homeBody, refugeBody: nx.refugeBody,
          at: nx.at,
          // lastAt = moment ratunku TEJ kolonii, więc zapora „130 s na
          // lądowanie" liczy się od prawdy, a nie od chwili promocji.
          lastAt: nx.savedAt || Date.now(),
          lastSendAt: nx.savedAt || Date.now(),   // v2.104.0 (audyt W4): okno „ratunek jeszcze leci" liczy się od prawdy
          saves: 1, since: Date.now(),
        });
        log(`[KOLEJKA] ${why} — biorę następną kolonię z kolejki: [${coords}]. Zostało: ${st.pending.length}.`, "success");
        ThreatLog.add("POWRÓT", `KOLEJKA: ściągam kolonię [${coords}] (${why}). W kolejce zostało: ${st.pending.length}.`);
        return true;
      }
      return false;
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
    // ── v2.62.0: OSTATNIA fala serii zabiera CAŁY hangar ──
    // Udział fali to floor do 2 cyfr znaczących (humanRoundDown), więc po
    // wysłaniu wszystkich fal w hangarze zostawała reszta z zaokrąglenia —
    // przy flocie liczonej w miliardach potrafiło to być ~10% floty stojące
    // bezużytecznie do powrotu serii (właściciel: 14/14 ekspedycji w locie,
    // a flota nadal na planecie). Seria z założenia commit-uje CAŁĄ flotę
    // („flota ÷ fale"), więc ostatnia fala domyka ją do zera: bierze wszystko,
    // co zostało z typów ekspedycyjnych, zamiast zamrożonego udziału.
    // v2.66.7: „ostatniość" liczy się też PO SLOTACH, nie tylko po liczniku
    // serii. Właściciel (10:18, 14/14 w powietrzu, 31 mld myśliwców w domu):
    // licznik serii wystartował od nowa przy zmianie fal 10→14, więc do jego
    // „14. wysyłki" było daleko, a sloty już były pełne — nadwyżka z produkcji
    // (miliardy/h) czekała w hangarze. Fala, która zapełnia OSTATNI wolny slot
    // ekspedycji, zabiera cały hangar: w nasyconej rotacji domyka to hangar
    // do zera przy każdym zwolnionym slocie.
    const slotsNow = ExpeditionRunner.slots();
    const capNow = ExpeditionRunner.waveCap();
    const fillingLastSlot = slotsNow.live && capNow > 0 && slotsNow.used >= capNow - 1;
    const lastOfBurst = divisor === 1 || fillingLastSlot || (useFrozen && (frozen.sent || 0) >= divisor - 1);
    // ── v2.68.2: zamiatanie ma GÓRNY LIMIT — 3× udział fali na typ ──
    // Incydent 05.08 09:35: licznik serii wskazał 14/14 dokładnie w chwili,
    // gdy w hangarze stała CAŁA flota bojowa (świeżo zawrócona z porannego
    // FS) — i „cały hangar" wywiózł 86,7 mld statków jedną ekspedycją.
    // Zamiatanie ma sprzątać RESZTĘ z zaokrąglenia i nadwyżkę produkcji
    // (ułamek udziału na falę), a nie zapakowaną flotę główną. Limit 3×
    // udziału: nadwyżka znika w rotacji (produkcja ~0,3× udziału między
    // falami), a zaparkowana flota zostaje w domu.
    const SWEEP_CAP_X = 3;
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
        // v2.62.0/2.68.2: ostatnia fala zamiata hangar, ale najwyżej do 3×
        // udziału — patrz SWEEP_CAP_X wyżej.
        const base = frozen.sizes[type] || 0;
        const want = lastOfBurst ? Math.min(available, Math.max(base, (base || Math.ceil(available / divisor)) * SWEEP_CAP_X)) : base;
        const qty = Math.min(want, available);
        if (qty > 0) plan.push({ type, qty, available });
        else empty.push(type);
        continue;
      }
      // `share` to udział, jaki typ POWINIEN wnieść (flota ÷ fale) i to on jest
      // zamrażany; `qty` to tyle, ile hangar może dać w tej chwili. Zamrożenie
      // liczby przyciętej zabetonowałoby pusty hangar na kolejne `waves` wysyłek.
      const fleet = available + inAir(type);
      // v2.62.0: przy 1 fali nie ma czego dzielić — bez tego humanRoundDown
      // ścinał całą flotę do 2 cyfr znaczących i reszta zostawała w hangarze.
      let share = fleet > 0 ? (divisor === 1 ? fleet : Math.max(1, humanRoundDown(fleet / divisor))) : 0;
      if (share === 0 && roster[type] > 0) share = roster[type]; // cały typ w powietrzu
      if (share > 0) shares[type] = share;
      // v2.66.7/2.68.2: zamiatająca fala bierze do 3× udziału także na ŚWIEŻEJ
      // serii (udziały zamrażają się normalnie — kolejne fale wracają do podziału).
      const qty = lastOfBurst ? Math.min(available, Math.max(share, share * SWEEP_CAP_X)) : Math.min(share, available);
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
    if (lastOfBurst && divisor > 1 && plan.length) {
      const why = fillingLastSlot ? `zapełniam ostatni wolny slot (${Math.min(slotsNow.used + 1, capNow)}/${capNow})` : `ostatnia fala serii (${divisor}/${divisor})`;
      log(`ZAMIATANIE: ${why} — fala powiększona do maks. ${SWEEP_CAP_X}× udziału: ${plan.map(p => `${p.type}×${p.qty}`).join(", ")}. Nadwyżka produkcji nie czeka, a zaparkowana flota główna zostaje w domu.`, "fleet");
    }
    return { plan, skipped, empty, frozen: !!useFrozen };
  }

  const ExpeditionRunner = {
    running: false,
    _warned: {},

    // v2.82.0: fale lecą na poz. 16 systemu AKTUALNEGO ciała — operator
    // zmienia miejsce startu przełączeniem planety w grze. expeditions.base
    // zostaje jako świadome, sztywne nadpisanie (null = podążaj za graczem).
    base() {
      const b = HomeBase.expo();
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
      // v2.79.0: hold trwa całe okno obrony (alarm + straż + lot ratunku),
      // a nie do sekundy, w której obce floty znikną z paska.
      if (!DefenceHold.allows("ekspedycje")) return;
      // v2.79.0: fala kosztuje paliwo — rezerwa na ewakuację jest nietykalna.
      if (!Fuel.allows("ekspedycje")) return;
      // A wave click navigates through 3 pages — never start one on top of a
      // mining/farm dispatch (they share the single pending_mission slot).
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") return;
      if (AsteroidMiner.running || InactiveFarmer.running) return;

      this.running = true;
      try {
        const url = this.fleetUrl();
        if (!url) {
          this._say("link", "Expeditions ON but no target yet — open any Galaxy page once so the bot can read the Expedition link from row 16.", "warn");
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
          holdingMinutes: cfg.discoverer40 ? 40 : 0, // v2.103.0: Odkrywca
          launchAt: b, // v2.84.0: skąd ma wyjść fala (formularz przełączy ciało)
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
        log(`EXPEDITION wave → [${b.galaxy}:${b.system}:16] for ${cfg.discoverer40 ? "40min (Odkrywca)" : cfg.holdingHours + "h"} (1/${cfg.waves} of the fleet, ${slots.used}/${slots.total || "?"} slots used)`, "success");
        await AntiDetection.shortDelay();
        window.location.replace(url);
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
        // v2.104.1: oddajemy stronę skanerowi TYLKO przy włączonym miningu — przy
        // wyłączonym wisiał stary skan (3/155, next [3:61]) i po każdej fali bot
        // jeździł na [3:61], gdzie nikt nic nie skanował (log 26.08 09:33-09:48).
        if (next && CONFIG.asteroidMining?.enabled && !busy && !minersOut && !ThreatMonitor.active()) {
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


  // ── EXPO-DURATION (v2.103.0) ──────────────────────────────────────────
  // Wybór opcji „Expedition duration" po TEKŚCIE opcji (markupu selecta nie
  // znamy). minutes>0 (Odkrywca: 40) → szuka „40 min"/„40 minutes"/„0.67 h";
  // brak → minutesHit=false i zwykły wybór godzinowy. Czysta funkcja — test
  // test-odkrywca.js.
  function pickExpeditionDuration(opts, { hours = "1", minutes = 0 } = {}) {
    const txt = o => (o.textContent || "").replace(/\s+/g, " ").trim();
    let minutesHit = false, option = null;
    if (minutes > 0) {
      const hFrac = (minutes / 60).toFixed(2).replace(/0+$/, "");
      option = opts.find(o => {
        const t = txt(o);
        const mm = t.match(/^(\d+)\s*min/i);
        if (mm && parseInt(mm[1]) === minutes) return true;
        const hh = t.match(/^(\d+[.,]\d+)\s*(h|hour)/i);
        if (hh && hh[1].replace(",", ".").startsWith(hFrac.slice(0, 3))) return true;
        const v = String(o.value ?? "");
        return v === String(minutes) && /min/i.test(t);
      }) || null;
      minutesHit = !!option;
    }
    if (!option) {
      option = opts.find(o => { const t = txt(o); return !/min/i.test(t) && t.match(/^(\d+)\b/)?.[1] === String(hours); }) || null;
    }
    return { option, minutesHit };
  }
  // ── /EXPO-DURATION ─────────────────────────────────────────────────────

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
      let el = document.querySelector(
        "a.planet-select.selected, .planet-select.selected, .smallplanet.active, .planetlink.active"
      );
      // v2.107.0: flota na KSIĘŻYCU — zaznaczony jest moon-select, nie planet-select;
      // bez tego hangar księżyca nigdy nie trafiał do mapy hangarów (ślepy alarm
      // i switchTo go nie widziały). Koordy siedzą w wierszu pary (jak activeCoords).
      if (!el) {
        const mEl = document.querySelector("a.moon-select.selected, .moon-select.selected");
        const row = mEl ? (mEl.closest("li, div, tr") || mEl.parentElement) : null;
        const mm = String(row?.textContent || "").match(/(\d+):(\d+):(\d+)/);
        return mm ? `${mm[1]}:${mm[2]}:${mm[3]}` : null;
      }
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
        body: (() => { try { return MoonSave.currentBody(); } catch { return null; } })(),   // v2.107.0: ciało hangaru (moon/planet)
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
      this.homeGuard(snap);
      return snap;
    },

    // ── v2.88.1: STRAŻNIK DOMU FLOTY ──
    // INCYDENT 15:24: po przeprowadzce floty pole „Start ekspedycji" dalej
    // wskazywało 2:277:8 — a ślepy alarm z paska broni TEGO pola, więc
    // obrona poleciałaby w pustą kolonię. Bot i tak odwiedza stronę floty
    // przy każdej wysyłce: notuje hangar per para koordów i KRZYCZY
    // (log + dziennik z pushem), gdy największa flota mieszka gdzie indziej
    // niż pole. Czysty alarm — flotą nie rusza. Dom porównujemy z jego
    // MAKSIMUM z 48 h, żeby chwilowo pusty hangar (fleet save w nocy,
    // flota w powietrzu) nie robił fałszywego alarmu.
    KEY_HANGARS: "ogamex_hangar_map",

    // v2.104.0 (audyt): DOM FLOTY = pole „Start ekspedycji", chyba że mapa
    // hangarów (48 h) mówi wyraźnie, że flota mieszka gdzie indziej (≥1 mld
    // i ≥2× maksimum domu) — wtedy tam. Używane przez ślepy alarm z paska
    // i ratunek bez celu (dotąd broniły bazy z configu, gdy flota stała na
    // innej kolonii — kształt katastrofy 13:10, 25.08 flota na [5:67:5]).
    fleetHome() {
      try {
        const fh = CONFIG.expeditions?.launchFrom;
        const homeKey = (fh && Number.isFinite(fh.galaxy)) ? `${fh.galaxy}:${fh.system}:${fh.position}` : null;
        let map = {}; try { map = JSON.parse(GM_getValue(this.KEY_HANGARS, "{}")) || {}; } catch { map = {}; }
        const v = this.homeVerdict({ map, homeKey: homeKey || "" });
        return v ? v.key : homeKey;
      } catch { return null; }
    },

    // v2.106.5: wszystkie pary z flotą w hangarze (ostatni odczyt <48 h), największa pierwsza.
    hangarTargets(minTotal = 1) {
      let map = {}; try { map = JSON.parse(GM_getValue(this.KEY_HANGARS, "{}")) || {}; } catch { map = {}; }
      return Object.keys(map)
        .filter(k => /^\d+:\d+:\d+$/.test(k) && (map[k].total || 0) >= minTotal && Date.now() - (map[k].at || 0) < 48 * 60 * 60 * 1000)
        .sort((a, b) => (map[b].total || 0) - (map[a].total || 0));
    },
    homeGuard(snap) {
      try {
        if (!snap || !snap.planet || !/^\d+:\d+:\d+$/.test(snap.planet)) return;
        let map = {}; try { map = JSON.parse(GM_getValue(this.KEY_HANGARS, "{}")) || {}; } catch { map = {}; }
        const cur = (snap.ships || []).reduce((a, sh) => a + (sh.qty || 0), 0);
        const e = map[snap.planet] || {};
        const maxFresh = (Date.now() - (e.maxAt || 0) < 48 * 60 * 60 * 1000) ? (e.max || 0) : 0;
        // v2.107.0: body = na którym ciele pary widzieliśmy flotę (switchTo klika to ciało)
        map[snap.planet] = cur >= maxFresh
          ? { total: cur, max: cur, maxAt: Date.now(), at: Date.now(), body: snap.body || null }
          : { total: cur, max: maxFresh, maxAt: e.maxAt, at: Date.now(), body: snap.body || null };
        for (const k of Object.keys(map)) if (Date.now() - (map[k].at || 0) > 48 * 60 * 60 * 1000) delete map[k];
        GM_setValue(this.KEY_HANGARS, JSON.stringify(map));
        const fh = CONFIG.expeditions?.launchFrom;
        if (!fh || !Number.isFinite(fh.galaxy)) return;
        const homeKey = `${fh.galaxy}:${fh.system}:${fh.position}`;
        const v = this.homeVerdict({ map, homeKey });
        if (!v) return;
        const KEY_AT = "ogamex_homeguard_warned_at";
        if (Date.now() - (parseInt(GM_getValue(KEY_AT, "0")) || 0) < 6 * 60 * 60 * 1000) return;
        GM_setValue(KEY_AT, String(Date.now()));
        log(`[DOM FLOTY] „Start ekspedycji" = [${homeKey}], ale największy hangar widzę na [${v.key}] (${v.total.toLocaleString()} statków vs ${v.homeMax.toLocaleString()} w domu przez 48 h). Ślepy alarm z paska broni POLA — popraw „Start ekspedycji" w panelu, inaczej ratunek poleci w złą kolonię.`, "error");
        ThreatLog.add("BŁĄD", `Dom floty ≠ realny hangar: pole [${homeKey}], największa flota na [${v.key}]. Popraw „Start ekspedycji", inaczej ślepy alarm broni złej kolonii.`);
      } catch {}
    },

    // czysta decyzja (testowalna macierzą): największy hangar ≠ dom pola
    // + wyraźna przewaga (≥1 mld statków i ≥2× maksimum domu z 48 h) —
    // księżyc minerów (7,5 mld) obok floty głównej (setki mld) NIE alarmuje.
    homeVerdict({ map, homeKey }) {
      const homeMax = (map[homeKey] && (map[homeKey].max || map[homeKey].total)) || 0;
      let key = null, total = 0;
      for (const k of Object.keys(map)) {
        const t = (map[k] && map[k].total) || 0;
        if (k !== homeKey && t > total) { total = t; key = k; }
      }
      if (!key) return null;
      if (total < 1e9 || total < 2 * homeMax) return null;
      return { key, total, homeMax };
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
          window.location.replace(realHref);
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
          window.location.replace(hit.el.href || href);
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
    // Najpierw skasuj duchy (wpisy, ktorych gra juz nie widzi), potem policz.
    const m = document.body.textContent.match(/(\d+)\s*Missions?:\s*(\d+)\s*Own/);
    if (m) {
      const own = parseInt(m[2]);
      // swiezo wyslana flota moze jeszcze nie byc na liscie gry (~30 s) —
      // wtedy nie przycinaj, bo skasowalibysmy realny lot
      const sinceSend = Date.now() - (parseInt(GM_getValue("ogamex_last_dispatch_at", "0")) || 0);
      if (sinceSend > 30000) {
        const dropped = MiningFlights.reconcile(own);
        if (dropped > 0)
          log(`Rejestr lotow: skasowano ${dropped} wpis(y)-duchy (gra widzi ${own} misji) — budzet odblokowany.`, "asteroid");
      }
    }
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
  let _lastHandleAt = 0, _lastHandleKey = "";   // v2.102.0 (E-2)
  // ── v2.74.2: WERYFIKACJA pól statków po wpisaniu (ratunek/FS) ──
  // Formularz floty przelicza się po każdym input/change i potrafi WYZEROWAĆ
  // pole wpisane chwilę wcześniej. Incydent 05.08 23:22: log mówił
  // „załadowane: … BATTLE_CRUISER×1381054574 …", a 1,38 mld BC zostało
  // w domu. Po wpisaniu czytamy więc każde pole Z POWROTEM, dopisujemy braki
  // (2 rundy) i dopiero to uznajemy za załadowane.
  async function verifyShipInputs(tag, excludeUpper = []) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    for (let round = 1; round <= 2; round++) {
      await AntiDetection.sleep(600 + Math.random() * 300);
      const bad = [];
      for (const el of document.querySelectorAll("[data-ship-type]")) {
        const type = el.dataset.shipType;
        const want = parseInt(el.dataset.shipQuantity || "0") || 0;
        if (!type || want <= 0 || excludeUpper.includes(type.toUpperCase())) continue;
        const item = el.closest(".ship-item") || el.parentElement;
        const input = item?.querySelector("input.numberFormatInput, input[type='text']");
        if (!input) continue;
        const have = parseInt((input.value || "0").replace(/[^\d]/g, "")) || 0;
        if (have < want) {
          bad.push(`${type} (${have.toLocaleString()}/${want.toLocaleString()})`);
          if (nativeSetter) nativeSetter.call(input, want); else input.value = want;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      if (!bad.length) {
        if (round > 1) log(`[${tag}] weryfikacja pól statków: komplet po dopisaniu.`, "fleet");
        return true;
      }
      log(`[${tag}] weryfikacja pól statków (runda ${round}): formularz zgubił ${bad.join(", ")} — wpisuję ponownie.`, "warn");
    }
    log(`[${tag}] UWAGA: po 2 rundach dopisywania formularz wciąż gubił pola — lecę z tym, co stoi w formularzu (szczegóły wyżej).`, "error");
    return false;
  }

  // ── v2.80.2: PROM ma sie przedstawiac jako PROM ──
  // Prom (MoonFerry) jedzie DOKLADNIE ta sama maszyneria co ratunek, wiec
  // jego kroki logowaly sie jako [MOON SAVE] i [RATUNEK]. 07.08 o 13:28
  // wlasciciel zobaczyl w logu „[RATUNEK] przelaczam aktywne cialo" oraz
  // „[MOON SAVE] cel: KSIEZYC" przy rutynowym kursie promu i uznal, ze bot
  // ucieka przed atakiem. Slusznie — tak to wygladalo.
  //
  // Dziennik rozroznial to od poczatku (wpisy „odczyt/PROM", zeby nie
  // falszowac licznikow obrony), ale log na zywo nie. Slowa zarezerwowane
  // dla sytuacji awaryjnej musza opisywac sytuacje awaryjna, inaczej
  // przestaja cokolwiek znaczyc — dokladnie ta sama zasada, dla ktorej
  // rutynowe czekanie przestalo byc czerwone w v2.77.2.
  function missionTag(fallback) {
    try {
      const p = GM_getValue("pending_mission", null);
      if (p && p !== "null" && /moon_ferry/.test(p)) return "PROM";
    } catch {}
    return fallback;
  }

  // ── v2.74.0: rezerwa deuteru przy ratunku/FS ──
  // Wywoływane PO kliknięciu btn-all-res na kroku 3: zdejmuje z pola deuteru
  // kwotę rezerwy, żeby ciało nie zostało z zerem paliwa (flota wracająca
  // z ekspedycji musi mieć za co uciec). Wiersz deuteru znajdujemy po parach
  // btn-res-full — na tym forku są 3 w kolejności metal/kryształ/deuter
  // (żywy zrzut step3-clickables 05.08 23:03). Bez trafienia: nic nie ruszamy.
  async function applyDeutReserve(tag) {
    const reserve = Math.max(0, parseInt(CONFIG.threatAlarm?.deutReserve) || 0);
    if (!reserve) return;
    try {
      const fulls = [...document.querySelectorAll("a.btn-res-full, .btn-res-full")];
      if (fulls.length < 3) { log(`[${tag}] rezerwa deuteru: nie widzę 3 wierszy surowców (${fulls.length}) — zostawiam jak jest.`, "warn"); return; }
      // v2.102.0 (E-8): wiersz deuteru po NAZWIE, nie po pozycji — closest("div")
      // potrafił objąć wszystkie 3 wiersze i trafić w pole metalu.
      // Wiersz = największy przodek, który zawiera TYLKO ten jeden przycisk „pełny".
      const rowOf = (f) => {
        let row = f.parentElement;
        while (row && row.parentElement && row.parentElement.querySelectorAll("a.btn-res-full, .btn-res-full").length === 1) row = row.parentElement;
        return row || f.parentElement;
      };
      const byName = fulls.find(f => /deut/i.test((rowOf(f)?.textContent || "") + " " + (rowOf(f)?.querySelector("input")?.name || "")));
      const full = byName || fulls[2];
      const row = rowOf(full);
      const input = row?.querySelector("input[name*='deut' i]") || row?.querySelector("input") ||
                    full.parentElement?.querySelector("input");
      if (!input) { log(`[${tag}] rezerwa deuteru: brak pola przy wierszu deuteru — zostawiam jak jest.`, "warn"); return; }
      const current = parseInt((input.value || "0").replace(/[^\d]/g, "")) || 0;
      if (current <= reserve) { log(`[${tag}] rezerwa deuteru: w zbiorniku ${current.toLocaleString()} ≤ rezerwa — nie zabieram deuteru wcale.`, "fleet"); }
      const keep = Math.max(0, current - reserve);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, keep); else input.value = keep;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      log(`[${tag}] rezerwa deuteru: zostawiam ${Math.min(current, reserve).toLocaleString()} na ciele, zabieram ${keep.toLocaleString()}.`, "fleet");
      await AntiDetection.sleep(300 + Math.random() * 300);
    } catch (e) { log(`[${tag}] rezerwa deuteru: błąd (${e.message}) — surowce bez zmian.`, "warn"); }
  }

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
    // ── v2.102.0 (E-2): dwa wywołania na jednej stronie (init 2 s + tick 3-8 s) ──
    // Pierwsze przesuwa krok i nawiguje; blokada zwalnia się PRZED dojściem
    // nawigacji, więc drugie widziało już nowy krok i nawigowało gdzie indziej
    // (formularz na NIEprzełączonym ciele → „flota już tu jest" → disarm).
    // Jeśli w tym dokumencie poprzednie wywołanie <15 s temu zmieniło krok,
    // to ono nawiguje — my ustępujemy.
    {
      const key = `${mission.type || "?"}|${mission.step || "?"}`;
      const sameType = _lastHandleKey && _lastHandleKey.split("|")[0] === (mission.type || "?");
      if (_lastHandleAt && Date.now() - _lastHandleAt < 15000 && sameType && _lastHandleKey !== key) {
        _handlingMission = false;
        return;
      }
      _lastHandleAt = Date.now(); _lastHandleKey = key;
    }
    if (Date.now() - mission.timestamp > 5 * 60 * 1000) {
      log("Pending mission expired, clearing", "warn");
      GM_setValue("pending_mission", null);
      _handlingMission = false; // v2.10.10: same — a leaked flag made this fn a no-op until next reload
      return;
    }

    // ── v2.73.1: misja ratunku/promu celująca w ciało, którego już NIE MAMY ──
    // Incydent 22:25 05.08: właściciel przeniósł bazę [3:269:8]→[3:272:7]
    // W TRAKCIE alarmu. Wiszący ratunek celował w stare koordy i PĘTLIŁ się
    // (przełączanie ciał odświeża timestamp, więc 5-minutowe wygasanie go
    // nie łapało). Ratunek zawsze celuje w NASZE ciało — jeśli koordów misji
    // nie ma na liście planet, ta misja jest miną z poprzedniej bazy.
    if (mission.moonSave && mission.atCoords) {
      // v2.75.4: NIE ufać GameState.getPlanets() — na tym forku parsuje JEDNĄ
      // planetę (aktywną) z 30, więc każda misja na nie-aktywną kolonię
      // wychodziła jako „nieistniejąca" i ROZBRAJAŁA straż (incydent 22:18
      // 06.08: baza [3:272:7] uznana za nieistniejącą, straż zdjęta, flota
      // została na planecie bez auto-powrotu). Jedyne wiarygodne źródło listy
      // naszych ciał to ownBodies() (select skrótów planet + cache GM).
      // Pusta lista = „nie wiem" — misji wtedy nie ruszamy.
      const own = ThreatMonitor.ownBodies();
      const c = mission.atCoords;
      const ours = own.has(`${c.galaxy}:${c.system}:${c.position}`);
      if (own.size > 1 && !ours) {
        log(`[RATUNEK] porzucam wiszącą misję ${mission.type} → [${c.galaxy}:${c.system}:${c.position}] — nie mamy tam żadnego ciała (przenosiny bazy).`, "warn");
        ThreatLog.add("odczyt", `Porzucona misja ${mission.type} na nieistniejące ciało [${c.galaxy}:${c.system}:${c.position}] (baza przeniesiona) — to sprzątanie, nie awaria.`);
        // v2.73.2: powrót na ciało, którego nie mamy, będzie ponawiany przez
        // straż w kółko (incydent 22:54: BŁĄD + głos co kilka minut). Straż
        // pilnowała STAREJ bazy — zdejmij ją razem z misją.
        MoonSave.disarm("cel ratunku/powrotu nie istnieje (przenosiny bazy)");
        GM_setValue("pending_mission", null);
        _handlingMission = false;
        return;
      }
    }

    // ── v2.68.4: bot OFF przerywa RUTYNOWE misje w toku ──
    // Incydent 05.08 10:32-10:33: właściciel wyłączył bota o 10:32:17, a fala
    // ekspedycji #15 i tak wyszła o 10:33:38 — misja w toku wznawiała się przy
    // każdym przeładowaniu strony, bo ta funkcja nie sprawdzała głównego
    // wyłącznika. OFF ma znaczyć STOP. Wyjątek: ratunek (moonSave) — przyciski
    // RATUJ/WRÓĆ działają także przy wyłączonym bocie i porzucenie ewakuacji
    // w połowie formularza byłoby gorsze niż jej dokończenie.
    if (!CONFIG.enabled && !mission.moonSave) {
      log(`Bot OFF — porzucam misję w toku (${mission.type}). Włącz bota, jeśli ma dokończyć.`, "warn");
      GM_setValue("pending_mission", null);
      _handlingMission = false;
      return;
    }

    const page = GameState.getCurrentPage();
    log(`Continuing mission: ${mission.type}, step: ${mission.step}, page: ${page}`, "fleet");

    try {
      // ═══ v2.106.0: SKOK BRAMĄ — krok formularza (switch_to_body idzie generyczną ścieżką niżej) ═══
      if (mission.type === "gate_jump" && mission.step === "select_ships_direct") {
        const onGate = /jumpgate/i.test(location.pathname);
        if (!onGate) {
          if (mission.gateNavOnce) return GateSave.fallback(mission, "nie jestem na stronie bramy (brak bramy na tym księżycu?)");
          mission.gateNavOnce = true; mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
          await AntiDetection.sleep(500 + Math.random() * 500);
          window.location.replace("/building/jumpgate");
          return;
        }
        if (MoonSave.currentBody() !== "moon") return GateSave.fallback(mission, "aktywne ciało nie jest księżycem");
        const hereAt = HomeBase.coords();
        if (hereAt && GateSave.key(hereAt) !== GateSave.key(mission.atCoords)) return GateSave.fallback(mission, `brama otwarta na [${GateSave.key(hereAt)}], a ratunek dotyczy [${GateSave.key(mission.atCoords)}]`);
        await AntiDetection.sleep(800 + Math.random() * 700);
        const sel = GateSave.destSelect();
        const shipsSec = GateSave.sectionOf("Ships");
        const resSec = GateSave.sectionOf("Resources");
        const jump = GateSave.jumpButton();
        if (!sel || !shipsSec || !jump) {
          // v2.107.2 (27.08 09:34, powrót bramą po teście): zrzut był PUSTY — #content/.content
          // trafiło w pusty element. Bierzemy pierwszy host z treścią, a do zrzutu
          // dokładamy TEKST strony (cooldown bramy fork pisze tekstem, nie formularzem).
          const host = [...document.querySelectorAll("#content, .content, main")].find(h => (h.textContent || "").trim().length > 40) || document.body;
          const pageTxt = (document.body.textContent || "").replace(/\s+/g, " ").trim().slice(0, 600);
          // v2.107.3 (zrzut ekranu 27.08 09:36): „Jumpgate is cooling down : 25:57" — czysty
          // tekst zamiast formularza. Odczytujemy czas: powrót ponowi się PO cooldownie
          // (nie co 5 min na ślepo); ratunek → od razu Deploy (brama i tak nie skoczy).
          // v2.107.7 (zrzut ekranu 27.08 09:48, [4:297:9]): pusty hangar = brak formularza,
          // tylko „There are no ships on this planet at this time." → nie ma czego skakać:
          // ratunek = hangar pusty (cicho, bez Deployu z pustego), powrót = flota nie tu.
          if (/no ships on this planet/i.test(document.body.textContent || "")) {
            GM_setValue("pending_mission", null);
            log(`[BRAMA] hangar księżyca [${GateSave.key(mission.atCoords)}] pusty — nic do przeniesienia bramą${mission.gateReturn ? " (powrót: floty tu nie ma — sprawdź, gdzie stoi)" : ""}.`, mission.gateReturn ? "warn" : "info");
            if (mission.gateReturn) ThreatLog.add("BŁĄD", `Powrót bramą z [${GateSave.key(mission.atCoords)}]: hangar pusty — flota stoi gdzie indziej.`);
            return;
          }
          // v2.110.1: cooldown szukany w CAŁYM tekście strony (10:49–11:09 zrzut 600 znaków kończył się przed „cooling down")
          const fullTxt = (document.body.textContent || "").replace(/\s+/g, " ");
          const cd = fullTxt.match(/cooling\s*down\s*:?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
          if (cd) {
            const secs = cd[3] ? (+cd[1] * 3600 + +cd[2] * 60 + +cd[3]) : (+cd[1] * 60 + +cd[2]);
            const readyAt = Date.now() + secs * 1000;
            GM_setValue("ogamex_gate_ready_at_" + GateSave.key(mission.atCoords), String(readyAt));
            if (mission.gateReturn) GM_setValue("ogamex_gate_return_try", String(readyAt - 5 * 60 * 1000 + 15 * 1000));
            log(`[BRAMA] cooldown bramy [${GateSave.key(mission.atCoords)}]: ${cd[1]}:${cd[2]}${cd[3] ? ":" + cd[3] : ""} — gotowa ok. ${new Date(readyAt).toLocaleTimeString("pl-PL")}.`, "info");
            return GateSave.fallback(mission, `brama w cooldownie (${cd[1]}:${cd[2]})`);
          }
          log(`[BRAMA DOM] jumpgate (brak: ${!sel ? "select celu " : ""}${!shipsSec ? "sekcji Ships " : ""}${!jump ? "przycisku Jump" : ""}) TEKST: ${pageTxt} | HTML: ${(host.innerHTML || "").replace(/\s+/g, " ").slice(0, 3000)}`, mission.gateReturn ? "info" : "error");
          return GateSave.fallback(mission, "nie rozpoznałem formularza bramy — zrzut wyżej");
        }
        // cel
        let attacked = [];
        try { attacked = Object.keys(ThreatMonitor.events()?.targetBodiesAll || {}); } catch {}
        let dest = null;
        if (mission.forceTarget) {
          const fk = GateSave.key(mission.forceTarget);
          dest = [...sel.options].map(o => ({ o, k: (((o.textContent || "").match(/(\d+):(\d+):(\d+)/) || []).slice(1).join(":")) })).find(x => x.k === fk) || null;
          if (!dest) return GateSave.fallback(mission, `księżyca domowego [${fk}] nie ma na liście bramy`);
        } else {
          dest = GateSave.pickDestination(sel, mission.atCoords, attacked);
          if (!dest) return GateSave.fallback(mission, "brak księżyca docelowego (wszystkie atakowane albo lista pusta)");
        }
        sel.value = dest.o.value; await GateSave.fireChange(sel);
        const destKey = (((dest.o.textContent || "").match(/(\d+):(\d+):(\d+)/) || []).slice(1).join(":"));
        // statki: zbiorczy „»" (ostatni kandydat w sekcji Ships), potem per-statek
        const inputs = GateSave.shipInputs(shipsSec);
        const btns = GateSave.maxButtons(shipsSec);
        if (btns.length) { btns[btns.length - 1].click(); await AntiDetection.sleep(700); }
        if (GateSave.inputSum(inputs) === 0) { for (const b of btns) { b.click(); await AntiDetection.sleep(120); } await AntiDetection.sleep(500); }
        const total = GateSave.inputSum(inputs);
        if (total === 0) {
          log(`[BRAMA DOM] Ships (przyciski max nie zadziałały, kandydatów: ${btns.length}): ${(shipsSec.innerHTML || "").replace(/\s+/g, " ").slice(0, 3000)}`, "error");
          return GateSave.fallback(mission, "nie udało się zaznaczyć statków (hangar pusty albo nieznany przycisk max)");
        }
        // surowce (opcjonalnie)
        let resTotal = 0;
        if (CONFIG.jumpGate?.takeResources !== false && resSec) {
          for (const b of GateSave.maxButtons(resSec)) { b.click(); await AntiDetection.sleep(150); }
          await AntiDetection.sleep(400);
          // v2.107.4 (27.08 09:31): skok poszedł BEZ surowców — przyciski max sekcji
          // Resources nie zadziałały (zero logu), flota wylądowała na księżycu z 0 deuteru
          // = unieruchomiona, a 33 bln deuteru zostało na atakowanym księżycu.
          // Teraz: sprawdzamy sumę pól; gdy 0 → wpisujemy ręcznie z nagłówka gry
          // (metal/kryształ/deuter, deuter minus rezerwa MoonSave); dalej 0 → zrzut DOM.
          const resInputs = GateSave.shipInputs(resSec);
          resTotal = GateSave.inputSum(resInputs);
          if (resTotal === 0 && resInputs.length) {
            const readHdr = (cls) => { try { const el = document.querySelector(cls); const m = el && (el.textContent || "").match(/\d[\d.,\s ']*/); const n = m ? parseInt(m[0].replace(/[^\d]/g, ""), 10) : NaN; return Number.isFinite(n) ? n : 0; } catch { return 0; } };
            const reserve = Number(CONFIG.threatAlarm?.deutReserve ?? 0) || 0;
            const have = { metal: readHdr(".resource-item-metal"), crystal: readHdr(".resource-item-crystal"), deuterium: Math.max(0, readHdr(".resource-item-deuterium") - reserve) };
            const kindOf = (i) => { const s = `${i.id} ${i.name} ${i.className} ${i.placeholder} ${(i.closest("tr, li, div")?.textContent || "").slice(0, 60)}`.toLowerCase(); return /deut/.test(s) ? "deuterium" : /cryst|krysz/.test(s) ? "crystal" : /metal/.test(s) ? "metal" : null; };
            const order = ["metal", "crystal", "deuterium"];
            // v2.107.8 (zrzut 27.08 09:50): „Cargo space : used / total" — surowce wchodzą tylko
            // do ładowni zaznaczonych statków. Gdy suma > ładownia, priorytet: DEUTER (paliwo
            // dla floty na schronie) → kryształ → metal.
            const cargoM = (document.body.textContent || "").replace(/\s+/g, " ").match(/cargo\s*space\s*:?\s*([\d.,\s ']+)\s*\/\s*([\d.,\s ']+)/i);
            const cargoTotal = cargoM ? (parseInt(String(cargoM[2]).replace(/[^\d]/g, ""), 10) || 0) : 0;
            if (cargoTotal > 0) {
              let left = cargoTotal;
              for (const k of ["deuterium", "crystal", "metal"]) { const take = Math.min(have[k] || 0, left); have[k] = take; left -= take; }
              log(`[BRAMA] ładownia bramy: ${cargoTotal.toLocaleString("pl-PL")} — po limicie deuter ${have.deuterium.toLocaleString("pl-PL")}, kryształ ${have.crystal.toLocaleString("pl-PL")}, metal ${have.metal.toLocaleString("pl-PL")}.`, "info");
            }
            resInputs.forEach((i, idx) => {
              const k = kindOf(i) || order[idx] || null;
              if (!k) return;
              i.value = String(have[k] || 0);
              i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true }));
            });
            await AntiDetection.sleep(400);
            resTotal = GateSave.inputSum(resInputs);
            log(`[BRAMA] surowce wpisane ręcznie (max nie zadziałał): metal ${have.metal.toLocaleString("pl-PL")}, kryształ ${have.crystal.toLocaleString("pl-PL")}, deuter ${have.deuterium.toLocaleString("pl-PL")} → suma w polach ${resTotal.toLocaleString("pl-PL")}.`, resTotal ? "info" : "warn");
          }
          if (resTotal === 0) log(`[BRAMA DOM] Resources (pól: ${resInputs.length}, suma 0): ${(resSec.innerHTML || "").replace(/\s+/g, " ").slice(0, 2500)}`, "warn");
          // v2.107.6 (zasada operatora 27.08): REZERWA DEUTERU obowiązuje też przy bramie —
          // na księżycu musi zostać paliwo dla flot lądujących później (fale z ekspedycji),
          // bo bez niego same nie uciekną. Przycinamy pole deuteru niezależnie od tego,
          // czy wypełnił je przycisk „max", czy wpis ręczny.
          try {
            const reserve = Number(CONFIG.threatAlarm?.deutReserve ?? 0) || 0;
            if (reserve > 0) {
              const hdr = (() => { const el = document.querySelector(".resource-item-deuterium"); const m = el && (el.textContent || "").match(/\d[\d.,\s ']*/); const n = m ? parseInt(m[0].replace(/[^\d]/g, ""), 10) : NaN; return Number.isFinite(n) ? n : null; })();
              const dIn = resInputs.find(i => /deut/i.test(`${i.id} ${i.name} ${i.className} ${i.placeholder} ${(i.closest("tr, li, div")?.textContent || "").slice(0, 60)}`)) || resInputs[2] || null;
              if (dIn && hdr !== null) {
                const cur = parseInt(String(dIn.value || "0").replace(/[^\d]/g, ""), 10) || 0;
                const allowed = Math.max(0, hdr - reserve);
                if (cur > allowed) {
                  dIn.value = String(allowed);
                  dIn.dispatchEvent(new Event("input", { bubbles: true })); dIn.dispatchEvent(new Event("change", { bubbles: true }));
                  await AntiDetection.sleep(300);
                  resTotal = GateSave.inputSum(resInputs);
                  log(`[BRAMA] rezerwa deuteru: zostawiam ${reserve.toLocaleString("pl-PL")} na księżycu, zabieram ${allowed.toLocaleString("pl-PL")} (pole miało ${cur.toLocaleString("pl-PL")}).`, "info");
                }
              }
            }
          } catch (e) { log(`[BRAMA] rezerwa deuteru: błąd przycinania (${e.message}) — pole bez zmian.`, "warn"); }
        } else if (CONFIG.jumpGate?.takeResources !== false) {
          log(`[BRAMA DOM] brak sekcji Resources na stronie bramy — skok bez surowców. Strona: ${(document.body.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500)}`, "warn");
        }
        const jb = GateSave.jumpButton();
        if (!jb || jb.disabled || /disabled/i.test(jb.className || "")) return GateSave.fallback(mission, "przycisk Jump nieaktywny (cooldown bramy?)");
        log(`[BRAMA] skaczę: [${GateSave.key(mission.atCoords)}] → [${destKey}], statków w polach: ${total.toLocaleString("pl-PL")}.`, "success");
        ThreatLog.add("RATUNEK", `Brama: skok [${GateSave.key(mission.atCoords)}] → [${destKey}] (${total.toLocaleString("pl-PL")} statków).`);
        mission.step = "verify"; mission.destKey = destKey; mission.timestamp = Date.now();
        // v2.107.5: po skoku brama ŹRÓDŁOWA ma cooldown (na żywo 27.08: ~30 min) — zapamiętaj,
        // żeby kolejny alarm na tej parze nie próbował bramy, tylko od razu zamiatał Deployem.
        GM_setValue("ogamex_gate_ready_at_" + GateSave.key(mission.atCoords), String(Date.now() + 30 * 60 * 1000));
        GM_setValue("pending_mission", JSON.stringify(mission));
        jb.click();
        await AntiDetection.sleep(3500 + Math.random() * 1500);
        window.location.replace("/fleet");
        return;
      }
      if (mission.type === "gate_jump" && mission.step === "verify") {
        if (page !== "fleet") {
          if (mission.verifyOnce) { GM_setValue("pending_mission", null); return; }
          mission.verifyOnce = true; mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
          await AntiDetection.sleep(500); window.location.replace("/fleet"); return;
        }
        await AntiDetection.sleep(1200);
        const left = [...document.querySelectorAll("[data-ship-type]")].reduce((a, e) => a + (parseInt(e.dataset.shipQuantity || "0", 10) || 0), 0);
        GM_setValue("pending_mission", null);
        const fromK = GateSave.key(mission.atCoords);
        if (left === 0) {
          if (mission.gateReturn) {
            GateSave.save(null);
            log(`[BRAMA] ✅ flota wróciła bramą na księżyc domowy [${mission.destKey}].`, "success");
            ThreatLog.add("POWRÓT", `Brama: flota z powrotem na [${mission.destKey}].`);
            MoonSave.disarm("powrót bramą zakończony");
            GM_setValue(GateSave.KEY_RECON, JSON.stringify({ key: mission.destKey, at: Date.now() }));   // v2.109.1
          } else {
            GateSave.save({ at: mission.atCoords, homeKey: fromK, to: mission.destKey, jumpedAt: Date.now() });
            const w = MoonSave.watch();
            MoonSave.saveWatch({ ...w, armed: true, at: mission.atCoords, homeBody: "moon", refugeBody: "gate", gateTo: mission.destKey, saves: (w.saves || 0) + 1, lastAt: Date.now(), lastSendAt: Date.now(), since: w.since || Date.now(), trigger: w.trigger || "threat" });
            log(`[BRAMA] ✅ flota skoczyła na księżyc [${mission.destKey}] — poza zasięgiem ataku, bez lotu. Po alarmie wrócę bramą (cooldown → próby co 5 min).`, "success");
            ThreatLog.add("RATUNEK", `Brama: flota na [${mission.destKey}]. Powrót bramą po alarmie.`);
            GM_setValue(GateSave.KEY_RECON, JSON.stringify({ key: mission.destKey, at: Date.now() }));   // v2.109.1
          }
        } else {
          log(`[BRAMA] po kliknięciu Jump na księżycu [${fromK}] nadal stoi ${left.toLocaleString("pl-PL")} statków — skok NIE zadziałał.`, "error");
          if (!mission.gateReturn) await GateSave.fallback(mission, "po Jump flota nadal na miejscu");
        }
        return;
      }

      // ═══ v2.105.0: ODBUDOWA KSIĘŻYCA — misja bez formularza floty ═══
      if (mission.type === "moon_form") {
        const c = mission.atCoords, k = MoonRebuild.key(c);
        const bail = async (why, lvl) => {
          log(`[KSIĘŻYC] odbudowa [${k}] przerwana: ${why}`, lvl || "error");
          ThreatLog.add("BŁĄD", `Odbudowa księżyca [${k}] przerwana: ${why}`);
          GM_setValue("pending_mission", null);
        };
        const onPage = /moonformation/i.test(location.pathname);
        if (mission.step === "switch_planet") {
          const anchor = HomeBase.pairAnchor(c);
          if (!anchor) {
            if (mission.noSidebarOnce) return bail("nie widzę pary na pasku planet");
            mission.noSidebarOnce = true; mission.timestamp = Date.now();
            GM_setValue("pending_mission", JSON.stringify(mission));
            await AntiDetection.sleep(500 + Math.random() * 500);
            window.location.replace("/");
            return;
          }
          if (HomeBase.moonOf(anchor)) return bail("para ma już księżyc — nic do roboty", "info");
          const hereAt = HomeBase.coords();
          const samePair = hereAt && hereAt.galaxy === c.galaxy && hereAt.system === c.system && hereAt.position === c.position;
          const onPlanet = MoonSave.currentBody() === "planet";
          mission.step = "open_page"; mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
          await AntiDetection.sleep(600 + Math.random() * 600);
          if (samePair && onPlanet) { window.location.replace("/home/moonformation"); return; }
          log(`[KSIĘŻYC] przełączam aktywne ciało na planetę [${k}]…`, "fleet");
          anchor.click();
          return;
        }
        if (mission.step === "open_page") {
          mission.step = "form"; mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
          if (!onPage) { await AntiDetection.sleep(600 + Math.random() * 600); window.location.replace("/home/moonformation"); return; }
        }
        if (mission.step === "form") {
          if (!onPage) return bail("nie jestem na stronie Moon Creation (przekierowanie?)");
          const head = (document.body.textContent || "").match(/Moon\s*Creation\s*\[(\d+):(\d+):(\d+)\]/i);
          if (head && `${head[1]}:${head[2]}:${head[3]}` !== k) return bail(`strona pokazuje [${head[1]}:${head[2]}:${head[3]}], a odbudowa dotyczy [${k}]`);
          const { input, btn } = MoonRebuild.formEls();
          if (!input || !btn) {
            const host = document.querySelector("#content, .content, main") || document.body;
            log(`[KSIĘŻYC DOM] moonformation (brak ${!input ? "pola średnicy" : "przycisku Form a moon"}): ${(host.innerHTML || "").replace(/\s+/g, " ").slice(0, 3000)}`, "error");
            return bail("nie znalazłem pola/przycisku — zrzut markupu wyżej, dopiszę selektor");
          }
          const metal = MoonRebuild.readMetal();
          const want = parseInt(mission.diameterKm) || 8944;
          const cands = [want, ...MoonRebuild.DIAMETERS.filter(d => d < want)];
          const share = Math.min(1, Math.max(0.01, parseFloat(CONFIG.moonRebuild?.maxMetalShare) || 0.25));
          const budget = metal === null ? null : Math.floor(metal * share);
          let chosen = null, cost = null;
          for (const d of cands) {
            await MoonRebuild.setDiameter(input, d);
            cost = MoonRebuild.readRequirement();
            const last = d === cands[cands.length - 1];
            log(`[KSIĘŻYC] średnica ${d} km → koszt ${cost === null ? "?" : cost.toLocaleString("pl-PL")} metalu (mam ${metal === null ? "?" : metal.toLocaleString("pl-PL")}, budżet ${Math.round(share * 100)}% = ${budget === null ? "?" : budget.toLocaleString("pl-PL")}).`, "info");
            // v2.105.4: w budżecie → bierzemy; najmniejsza średnica → wystarczy, że stać
            if (cost === null || metal === null || cost <= budget || (last && cost <= metal)) { chosen = d; break; }
          }
          if (!chosen) return bail(`za mało metalu nawet na 1 000 km (koszt ${cost}, mam ${metal})`);
          if (btn.disabled || /disabled/i.test(btn.className || "")) return bail("przycisk Form a moon nieaktywny");
          log(`[KSIĘŻYC] klikam „Form a moon" — ${chosen} km dla [${k}].`, "warn");
          ThreatLog.add("KSIĘŻYC", `Form a moon: ${chosen} km dla [${k}] (koszt ${cost ? cost.toLocaleString("pl-PL") : "?"} metalu).`);
          mission.step = "verify"; mission.chosenKm = chosen; mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
          btn.click();
          await AntiDetection.sleep(3500 + Math.random() * 1500);
          if (/moonformation/i.test(location.pathname)) window.location.replace("/");
          return;
        }
        if (mission.step === "verify") {
          const has = HomeBase.pairHasMoon(c);
          if (has === null) {
            if (mission.verifyOnce) return bail("nie widzę paska planet do weryfikacji");
            mission.verifyOnce = true; mission.timestamp = Date.now();
            GM_setValue("pending_mission", JSON.stringify(mission));
            await AntiDetection.sleep(500); window.location.replace("/"); return;
          }
          GM_setValue("pending_mission", null);
          if (has) {
            const wasLost = !!GM_getValue("ogamex_moon_lost_" + k, "");
            GM_setValue("ogamex_moon_lost_" + k, "");
            log(`[KSIĘŻYC] ✅ księżyc [${k}] ODBUDOWANY (${mission.chosenKm} km).${wasLost ? " Flota stoi na planecie po ucieczce — przenoszę ją z powrotem na księżyc." : ""}`, "success");
            ThreatLog.add("ATAK", `🌕 Księżyc [${k}] odbudowany (${mission.chosenKm} km).${wasLost ? " Flota wraca na księżyc." : ""}`);
            // v2.105.1: po Destroy flota uciekła na planetę — po odbudowie sama
            // wraca na nowy księżyc (ten sam ratunek co RATUJ FLOTĘ, cel = księżyc
            // tej pary; cel nieznany → bot doczyta go z galaktyki).
            if (wasLost) {
              _handlingMission = false;
              setTimeout(() => MoonSave.run({ manual: true, reason: "powrót na odbudowany księżyc", where: c }).catch(err => log(`[KSIĘŻYC] powrót floty na nowy księżyc nie ruszył: ${err.message}`, "error")), 2500 + Math.random() * 1500);
            }
          } else {
            log(`[KSIĘŻYC] po kliknięciu „Form a moon" pasek planet nadal nie pokazuje księżyca [${k}] — sprawdź w grze (komunikat błędu? koszt?). Ponowię za 10 min (maks. 3/dobę).`, "error");
            ThreatLog.add("BŁĄD", `Form a moon nie dał księżyca [${k}] — sprawdź w grze.`);
          }
          return;
        }
        return bail(`nieznany krok ${mission.step}`);
      }

      // ── Planet switch step: we landed on a planet page, now go to fleet ──
      if (mission.step === "switch_planet_then_fleet" && mission.switchToFleetUrl) {
        log(`Planet switched. Navigating to fleet: ${mission.switchToFleetUrl}`, "fleet");
        mission.step = "select_ships_direct";
        mission.timestamp = Date.now();
        GM_setValue("pending_mission", JSON.stringify(mission));
        await AntiDetection.sleep(1000 + Math.random() * 1500);
        window.location.replace(mission.switchToFleetUrl);
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
          window.location.replace("/");
          return;
        }
        // v2.104.0 (audyt): skrót tylko, gdy to TA SAMA PARA — 21:44:56 powrót dla
        // [5:67:5] „był już na planecie"… planecie [3:272:7].
        const hereAt = HomeBase.coords();
        const wantAt = mission.atCoords || null;
        const samePairHere = !wantAt || !hereAt || (hereAt.galaxy === wantAt.galaxy && hereAt.system === wantAt.system && hereAt.position === wantAt.position);
        if (here === want && samePairHere) {
          log(`[RATUNEK] jesteśmy już na właściwym ciele (${want === "moon" ? "księżyc" : "planeta"}) — lecę prosto do formularza.`, "fleet");
          mission.step = "select_ships_direct";
          mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
          await AntiDetection.sleep(500 + Math.random() * 500);
          window.location.replace(mission.fleetUrl);
          return;
        }
        // Find the base entry in the sidebar. The game renders each moon right
        // after its planet, so the pair identifies itself by adjacency — no
        // coordinate parsing, and it works whichever half is currently active.
        const b = mission.atCoords || HomeBase.coords();
        let target = null;
        // ── v2.87.2: NAJPIERW dopasowanie po KOORDACH z tekstu kotwicy ──
        // Incydent NA ŻYWO 14:35: powrót do [5:67:5] przy aktywnej Colony 11
        // — stara heurystyka (href/zaznaczona para) wzięła AKTYWNĄ parę
        // i powrót załadował hangar OBCEJ kolonii (4 statki kolonizacyjne,
        // 215 mln HC, 849 mld surowców) w 37-minutowy lot. pairAnchor
        // dopasowuje parę po koordach w tekście — ta sama mechanika, którą
        // brama launchAt bezbłędnie przełącza pary od v2.84.
        const anchorByCoords = b ? HomeBase.pairAnchor(b) : null;
        if (anchorByCoords) target = want === "moon" ? (HomeBase.moonOf(anchorByCoords) || anchorByCoords) : anchorByCoords;
        const planets = [...document.querySelectorAll("a.planet-select, .planet-select")];
        if (!target) for (const p of planets) {
          const href = p.getAttribute("href") || "";
          const isBase = b && href.includes(`${b.galaxy}`) && href.includes(`${b.system}`) && href.includes(`${b.position}`);
          // v2.82.0: STOP na następnym wpisie planety — bez tego para BEZ
          // księżyca „pożyczała" księżyc kolejnej planety z listy i cała
          // wysyłka szła z cudzego ciała.
          let moon = p.nextElementSibling;
          while (moon && !(moon.classList && moon.classList.contains("moon-select"))) {
            if (moon.classList && moon.classList.contains("planet-select")) { moon = null; break; }
            moon = moon.nextElementSibling;
          }
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
        log(`[${missionTag("RATUNEK")}] przełączam aktywne ciało na ${want === "moon" ? "księżyc" : "planetę"} bazy…`, "fleet");
        mission.step = "switch_planet_then_fleet";
        mission.switchToFleetUrl = mission.fleetUrl;
        mission.timestamp = Date.now();
        GM_setValue("pending_mission", JSON.stringify(mission));
        await AntiDetection.sleep(600 + Math.random() * 600);
        const href = target.getAttribute("href");
        if (href && href.length > 1) window.location.replace(href); else target.click();
        return;
      }

      // ── Direct asteroid mining: fleet URL has coords + mission pre-set ──
      // 3-step form on same page: Select ships → Confirm destination → Send fleet
      if (mission.step === "select_ships_direct" && page === "fleet") {
        // ── v2.69.0: TRYB KSIĘŻYCOWY — rutynowe wysyłki startują z księżyca ──
        // Jeden punkt przewężenia zamiast czterech miejsc tworzenia misji:
        // każda misja (mining/ekspedycja/złom) przechodzi tędy przed
        // formularzem. Zła strona startu → przełącz na księżyc bazy tą samą
        // maszynerią, którą FS i powrót ratunku mają potwierdzoną na żywo.
        // Ratunek (moonSave) i FS mają własną logikę ciała — nietykane.
        // v2.74.8: farm STARTUJE Z AKTUALNEGO ciała (decyzja właściciela 06.08
        // przed eventem idle-farming) — właściciel przenosi flotę między
        // planetami/księżycami, żeby skrócić doloty; wymuszony start z bazy
        // niweczyłby te przenosiny.
        // ── v2.84.0: START Z WPISANYCH KOORDÓW (launchAt) ──
        // Misja niesie punkt startu wybrany przy jej tworzeniu: sztywne
        // koordy z panelu (minery ↔ ekspedycje mogą mieć RÓŻNE) albo ciało
        // aktywne. Jeśli aktywna jest INNA para — bot klika właściwy wpis
        // na pasku planet (planetę lub jej księżyc wg baseBody) i wraca do
        // formularza tą samą mechaniką co rotacja minerów. Ratunek i FS
        // mają własną logikę startu — nietykane. Farm (v2.91.0) niesie
        // launchAt TYLKO przy wpisanych koordach, więc sam wybiera, czy tędy
        // przechodzi; bez koordów launchAt nie istnieje i nic się nie zmienia.
        if (mission.launchAt && !mission.moonSave && !mission.fleetSave && !mission.originChecked) {
          const want = mission.launchAt;
          const here = HomeBase.read();
          const samePair = here && here.galaxy === want.galaxy && here.system === want.system && here.position === want.position;
          if (here && !samePair) {
            mission.originChecked = true; // jedna korekta pary na misję — bez pętli
            const anchor = HomeBase.pairAnchor(want);
            if (anchor) {
              const wantMoon = (want.body || (CONFIG.baseBody === "moon" ? "moon" : "planet")) === "moon";
              const targetEl = wantMoon ? (HomeBase.moonOf(anchor) || anchor) : anchor;
              if (wantMoon && targetEl === anchor) {
                log(`[START] para [${want.galaxy}:${want.system}:${want.position}] nie ma księżyca — startuję z PLANETY (falanga widzi ten lot).`, "warn");
              }
              mission.step = "switch_planet_then_fleet";
              mission.switchToFleetUrl = mission.fleetUrl;
              mission.timestamp = Date.now();
              GM_setValue("pending_mission", JSON.stringify(mission));
              log(`[START] misja ${mission.type} startuje z [${want.galaxy}:${want.system}:${want.position}]${targetEl !== anchor ? " (księżyc)" : ""} — przełączam aktywne ciało.`, "fleet");
              await AntiDetection.sleep(600 + Math.random() * 600);
              const href = targetEl.getAttribute("href");
              if (href && href.length > 1) window.location.replace(href); else targetEl.click();
              return;
            }
            // Koordów nie ma na pasku planet (literówka w panelu / nie nasza
            // kolonia) — głośno i dalej z aktywnego ciała, żeby nie zamrozić
            // rotacji wysyłek na zawsze.
            log(`[START] nie znalazłem [${want.galaxy}:${want.system}:${want.position}] na liście planet — SPRAWDŹ koordy startu w panelu. Startuję z aktywnego ciała.`, "error");
            GM_setValue("pending_mission", JSON.stringify(mission));
          }
        }
        // v2.82.0: „księżyc bazy" → „księżyc AKTUALNEGO układu". Operator
        // wybiera miejsce startu przełączeniem planety; tryb księżycowy
        // dokręca tylko CIAŁO w obrębie tej pary. Układ bez księżyca =
        // start z planety (świadomy koszt: falanga widzi ten lot).
        if (CONFIG.baseBody === "moon" && !mission.moonSave && !mission.fleetSave && (!mission.farm || mission.launchAt) && !mission.launchChecked) {
          const here = MoonSave.currentBody();
          if (here && here !== "moon") {
            mission.launchChecked = true; // jedna korekta na misję — bez pętli
            if (HomeBase.pairMoon()) {
              mission.step = "switch_to_body";
              mission.launchBody = "moon";
              mission.atCoords = mission.atCoords || HomeBase.coords();
              mission.timestamp = Date.now();
              GM_setValue("pending_mission", JSON.stringify(mission));
              log(`[BAZA=KSIĘŻYC] misja ${mission.type} miała startować z planety — przełączam na księżyc aktualnego układu przed wysyłką.`, "warn");
              _lastHandleAt = 0; setTimeout(() => { handlePendingMission().catch(() => {}); }, 1200);
              return;
            }
            GM_setValue("pending_mission", JSON.stringify(mission)); // launchChecked przeżywa przeładowanie
            log(`[BAZA=KSIĘŻYC] aktualny układ nie ma księżyca — misja ${mission.type} startuje z PLANETY (falanga widzi ten lot).`, "warn");
          }
        }
        // ── v2.87.2: FORMULARZ NIGDY NIE WYSYŁA Z OBCEJ KOLONII ──
        // Ratunek/powrót niesie atCoords = kolonię, o którą chodzi. Jeśli
        // formularz otworzył się na INNEJ parze (nietrafione przełączenie —
        // incydent 14:35), to załadowałby jej hangar i wysłał go w lot.
        // Jedna próba korekty przez pairAnchor; druga porażka = głośne
        // przerwanie. Flota z obcej kolonii nie może latać „przy okazji".
        if (mission.moonSave && mission.atCoords) {
          const herePair = HomeBase.read();
          const wantPair = mission.atCoords;
          const samePairNow = herePair && herePair.galaxy === wantPair.galaxy && herePair.system === wantPair.system && herePair.position === wantPair.position;
          if (herePair && !samePairNow) {
            if (!mission.pairChecked) {
              mission.pairChecked = true;
              const a2 = HomeBase.pairAnchor(wantPair);
              if (a2) {
                const el2 = (mission.launchBody === "moon") ? (HomeBase.moonOf(a2) || a2) : a2;
                mission.step = "switch_planet_then_fleet";
                mission.switchToFleetUrl = mission.fleetUrl;
                mission.timestamp = Date.now();
                GM_setValue("pending_mission", JSON.stringify(mission));
                log(`[RATUNEK] formularz otworzył się na OBCEJ kolonii [${herePair.galaxy}:${herePair.system}:${herePair.position}] zamiast [${wantPair.galaxy}:${wantPair.system}:${wantPair.position}] — przełączam i wracam do formularza.`, "warn");
                await AntiDetection.sleep(500 + Math.random() * 500);
                const h2 = el2.getAttribute("href");
                if (h2 && h2.length > 1) window.location.replace(h2); else el2.click();
                return;
              }
            }
            log(`[RATUNEK] PRZERWANE: formularz na obcej kolonii [${herePair.galaxy}:${herePair.system}:${herePair.position}], cel to [${wantPair.galaxy}:${wantPair.system}:${wantPair.position}] — floty z obcej kolonii NIE ruszam.`, "error");
            DefenceWatchdog.note(`ratunek/powrót przerwany: formularz na obcej kolonii, cel [${wantPair.galaxy}:${wantPair.system}:${wantPair.position}]`);
            GM_setValue("pending_mission", null);
            return;
          }
        }
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
        // v2.99.5: recycle wypięty ze strażników duplikatu — ekspedycje lecą na
        // ten sam cel [baza:16], więc „flota już leci na 16" blokowała recyklery.
        if (!mission.expedition && !mission.moonSave && !mission.fleetSave && !mission.recycle) try {
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
        const alreadyFlying = (mission.expedition || mission.moonSave || mission.fleetSave || mission.recycle) ? null : await fleetAlreadyFlyingTo(missionCoord);
        if (alreadyFlying) {
          log(`DUPLICATE BLOCKED (server events via ${alreadyFlying}): a fleet is already en route to [${missionCoord}]. Aborting send.`, "warn");
          GM_setValue("pending_mission", null);
          return;
        }

        // v2.90.0: etykieta po typie misji (wcześniej wszystko szło jako
        // „direct asteroid”, także ataki farmy i loty po złom).
        log(`Fleet page loaded (${mission.farm ? "farm attack" : mission.recycle ? "recycle" : mission.expedition ? "expedition" : "direct asteroid"}). Starting 3-step dispatch...`, "fleet");

        // ── v2.83.0: OFF ma znaczyć STOP także W ŚRODKU formularza ──
        // v2.68.4 przerywa misję przy WZNOWIENIU (przeładowanie strony), ale
        // klik OFF w trakcie 3 kroków nie był nigdzie sprawdzany — 12.08
        // 08:48:42 właściciel wyłączył bota, a fala ekspedycji i tak wyszła
        // sekundę później. Bramka przed każdym klikiem pchającym formularz
        // naprzód. Wyjątek jak w 2.68.4: ratunek (moonSave) zawsze dokańcza —
        // porzucenie ewakuacji w połowie jest gorsze niż jej dokończenie.
        const offAbort = (where) => {
          if (CONFIG.enabled || mission.moonSave) return false;
          log(`Bot OFF — przerywam misję ${mission.type} przed krokiem „${where}". Nic nie zostało wysłane.`, "warn");
          GM_setValue("pending_mission", null);
          return true;
        };

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
            if (dispatchOk) {
              const simStart = parseInt(GM_getValue("ogamex_threat_sim_started", "0")) || 0;
              if (simStart && Date.now() - simStart < 15 * 60 * 1000) {
                const secs = Math.round((Date.now() - simStart) / 1000);
                log(`[TEST] E2E: od startu symulacji do WYSŁANIA ratunku ${secs} s${secs > 120 ? " — ZA WOLNO na atak z układu (2-3 min)" : ""}.`, secs > 120 ? "error" : "success");
                ThreatLog.add("odczyt", `TEST E2E: start → wysyłka ratunku ${secs} s.`);
              }
            }
            if (!dispatchOk) {
              // v2.102.0 (E-4): porażka ratunku = natychmiastowy retry straży (lastAt=0)
              // + ślad dla nadzorcy, zamiast cichych 90 s.
              MoonSave.noteRescueFail("wysyłka nie doszła do skutku");
            }
            if (mission.airSave && dispatchOk) { try { AirSave.afterSend(mission); } catch {} } // v2.85.0
            if (mission.guardSwap && dispatchOk) { try { MoonSave.commitGuardSwap(mission); } catch {} } // v2.100.1
            if (dispatchOk) log(`[${missionTag("MOON SAVE")}] fleet and resources are on the moon.`, "success");
            return;
          }
          if (mission.fleetSave) {
            if (dispatchOk) FleetSave.markLaunched(mission);
            else log("[FS] wysyłka nie doszła do skutku — planer spróbuje ponownie, dopóki okno pasuje.", "warn");
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
          // v2.59.0: recykling ma własną flagę od 2.48.0, ale finishDispatch
          // o niej nie wiedział — po locie po złom przechodził do księgowości
          // MININGA i (przy porażce) ustawiał pauzę skanera z czasu lotu
          // recyklerów. Złom niczego nie mówi o tym, gdzie są minery.
          if (mission.recycle) {
            if (dispatchOk) log("[ZŁOM] recyklery wysłane po pole złomu.", "success");
            else {
              // v2.99.6: nieudana wysyłka nie pali 10-min blokady ponowienia
              // (25.08 07:54: duplikat → blokada → 10 min ciszy na galaktyce bazy).
              GM_setValue(DebrisCollector.KEY_SENT, "0");
              log("[ZŁOM] wysyłka recyklerów nie doszła do skutku — spróbuję przy następnej wizycie.", "warn");
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
            try { const ld = JSON.parse(GM_getValue("ogamex_last_dispatch", "null")); if (ld) GM_setValue("ogamex_last_dispatch", JSON.stringify({ ...ld, consumedAt: Date.now() })); } catch {}   // v2.104.0
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

        // ── v2.66.2: NIE klikaj wyłączonego przycisku ──
        // Dwa razy w logach (02.08 12:47 i 03.08 23:21) bot kliknął „Next"
        // z klasą `disabled` — gra jeszcze przeliczała wybór statków (fala to
        // kilkanaście typów wpisywanych po kolei). Klik w martwy przycisk nic
        // nie robi, następny krok nigdy nie wstaje, 12 s timeoutu i fala
        // przepada. Czekamy, aż przycisk ożyje, z twardym limitem czasu.
        const isDisabled = (el) => !el ? true
          : (el.disabled || el.classList.contains("disabled") || el.getAttribute("aria-disabled") === "true");
        const findButton = (text) => {
          const fleetArea = document.querySelector("#content, .content, main, #fleet, .fleet-content, .fleet-form") || document.body;
          let btn = Array.from(fleetArea.querySelectorAll("a, button, input[type='submit']")).find(
            el => el.textContent.trim() === text && el.offsetParent !== null
          );
          if (!btn) btn = fleetArea.querySelector(`input[value="${text}"]`);
          if (!btn) {
            btn = Array.from(document.querySelectorAll("a, button, input[type='submit']")).find(
              el => el.textContent.trim() === text && el.offsetParent !== null &&
                    !el.closest(".sidebar, nav, .planet-list, #ogx-bot-panel") &&
                    !el.classList.contains("text-item") && !el.classList.contains("resource-item")
            );
          }
          return btn || null;
        };
        // v2.66.3: 9 s nie starczało — ostatnia fala serii (CAŁY hangar,
        // 23:26 w logu: 33,7 mld myśliwców w jednym formularzu) trzyma Next
        // martwym dłużej, bo gra waliduje gigantyczne liczby po stronie
        // serwera. 25 s + na koniec mówimy PRAWDĘ: „był, ale martwy przez
        // cały czas" to co innego niż „nie było go wcale", i zrzucamy tekst
        // okolicy formularza — jeśli gra wypisała powód (np. brak deuteru),
        // będzie w logu.
        const clickButtonWhenEnabled = async (text, label, maxWaitMs = 25000) => {
          const start = Date.now();
          let waited = false, lastSeen = null;
          while (Date.now() - start < maxWaitMs) {
            const btn = findButton(text);
            lastSeen = btn;
            if (btn && !isDisabled(btn)) {
              if (waited) log(`Przycisk "${text}" ożył po ${((Date.now() - start) / 1000).toFixed(1)}s — klikam.`, "fleet");
              btn.click();
              log(`Clicked "${text}" (${btn.tagName}.${btn.className} id=${btn.id}) [${label}]`, "fleet");
              return true;
            }
            if (btn && !waited) {
              waited = true;
              log(`Przycisk "${text}" jest wyłączony (gra jeszcze liczy) — czekam, zamiast klikać w martwy element.`, "fleet");
            }
            await AntiDetection.sleep(400);
          }
          const formTxt = (document.querySelector("#content, .content, form") || document.body)
            .textContent.replace(/\s+/g, " ").trim();
          log(lastSeen
            ? `Przycisk "${text}" przez ${Math.round(maxWaitMs / 1000)}s pozostał WYŁĄCZONY [${label}] — gra nie przyjmuje tej floty. Tekst formularza: …${formTxt.slice(-400)}`
            : `Przycisk "${text}" w ogóle nie istnieje na stronie [${label}].`, "error");
          return false;
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
          // ── v2.75.1: ratuj z CIAŁA, w które leci atak — na każdej kolonii ──
          // Po przełączeniu na atakowaną kolonię aktywna robi się PLANETA
          // (kotwica na liście), a atak zwykle celuje w księżyc z flotą.
          // Zamiast ładować to, co stoi na bezpiecznym ciele (i wysyłać je
          // POD atak), od razu przeskakujemy na ciało atakowane i ratujemy
          // stamtąd — tą samą maszynerią co flip przy pustym hangarze.
          // v2.85.0: ciało celu per kolonia (mission.atCoords), z globalnym
          // fallbackiem. Ucieczka w powietrze nie flipuje „na atakowane
          // ciało" — atakowane są OBA; startujemy stamtąd, gdzie stoi flota.
          const missionKey = mission.atCoords ? `${mission.atCoords.galaxy}:${mission.atCoords.system}:${mission.atCoords.position}` : null;
          const atkNow = (() => { try { return (missionKey && ThreatMonitor.attackBodyFor(missionKey)) || ThreatMonitor.events()?.targetBody || null; } catch { return null; } })();   // v2.102.4: + pamięć ciała
          if (!mission.moonReturn && !mission.flippedBody && !mission.sweep && !mission.airSave
              && (MoonSave.watch().saves || 0) <= 1 && ThreatMonitor.active()
              && atkNow && bodyNow && bodyNow !== atkNow) {
            log(`[MOON SAVE] atak celuje w ${atkNow === "moon" ? "KSIĘŻYC" : "PLANETĘ"}, a stoję na ${bodyNow === "moon" ? "księżycu" : "planecie"} — przełączam się na atakowane ciało i ratuję stamtąd.`, "warn");
            ThreatLog.add("RATUNEK", `Cel ataku: ${atkNow === "moon" ? "księżyc" : "planeta"} → ratuję z niego na ${bodyNow === "moon" ? "księżyc" : "planetę"}.`);
            mission.flippedBody = true;
            mission.launchBody = atkNow;
            mission.targetBody = bodyNow;
            mission.step = "switch_to_body";
            mission.timestamp = Date.now();
            GM_setValue("pending_mission", JSON.stringify(mission));
            MoonSave.noteFlip(mission, atkNow, bodyNow);   // v2.104.0: straż tylko dla strzeżonej pary; kolejka → jej wpis
            await AntiDetection.sleep(500 + Math.random() * 500);
            window.location.replace("/");
            return;
          }
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          const loaded = [];
          let loadedTotal = 0;   // v2.104.0
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
            loadedTotal += available;
            // Emergency: no human-pacing delay here. Every second counts and a
            // fleet save is exactly the moment a real player also hammers it.
          }
          if (!loaded.length) {
            // ── v2.66.0: pusty hangar przy AKTYWNYM alarmie = flota stoi na
            // DRUGIM ciele tych samych koordynatów. Dotąd ratunek kończył się
            // tu słowem „aborting" — a wielka flota zostawała na atakowanym
            // księżycu, podczas gdy bot z czystym sumieniem ratował pustą
            // planetę. Przełączamy się na drugie ciało i ratujemy STAMTĄD
            // (kierunek odwraca się sam: from=ciało aktywne po przełączeniu).
            // Jedna próba — jeśli i tam pusto, flota jest w powietrzu i nie ma
            // czego ratować.
            // ── v2.70.3: flip TYLKO przy PIERWSZYM ratunku alarmu ──
            // Przy ZAMIATANIU pusty hangar znaczy „nic nowego nie wylądowało",
            // a nie „szukaj floty po drugiej stronie". Incydent 16:20: po
            // udanej ewakuacji księżyc→planeta straż zastała pusty księżyc
            // i flip przeniósł flotę z bezpiecznej planety Z POWROTEM na
            // atakowany księżyc (dolot 16 s przed uderzeniem — uratował nas
            // tylko odwrót wroga) oraz przestawił homeBody, przez co powrót
            // odstawił flotę na złe ciało. Dodatkowo: flip nigdy nie może
            // uczynić celem ciała, w które leci atak.
            const hereB = MoonSave.currentBody() || "planet";
            const emptyKey = mission.atCoords ? `${mission.atCoords.galaxy}:${mission.atCoords.system}:${mission.atCoords.position}` : null;
            const atkB = (() => { try { return (emptyKey && ThreatMonitor.attackBodyFor(emptyKey)) || ThreatMonitor.events()?.targetBody || null; } catch { return null; } })();   // v2.102.4: + pamięć ciała
            // v2.85.0: ucieczka w powietrze MUSI znaleźć flotę — pusty hangar
            // na aktywnym ciele = flota stoi na DRUGIM ciele TEJ pary; flip
            // bez warunku „atak w drugie ciało", bo atakowane są oba.
            if (!mission.moonReturn && !mission.flippedBody && !mission.sweep
                && (mission.airSave || ((MoonSave.watch().saves || 0) <= 1 && ThreatMonitor.active() && atkB !== hereB))) {
              const here = hereB;
              const other = here === "moon" ? "planet" : "moon";
              log(`[MOON SAVE] hangar na ${here === "moon" ? "księżycu" : "planecie"} PUSTY, a alarm trwa — flota stoi na ${other === "moon" ? "księżycu" : "planecie"}. Przełączam się i ratuję stamtąd.`, "warn");
              ThreatLog.add("RATUNEK", `Hangar ${here} pusty przy alarmie → flota na ${other}. Przełączam ciało i ratuję ${other} → ${here}.`);
              mission.flippedBody = true;
              mission.launchBody = other;
              // v2.85.0: przy ucieczce w powietrze CEL to inna kolonia —
              // targetBody misji zostaje nietknięte (planeta refugium).
              if (!mission.airSave) mission.targetBody = here;
              mission.step = "switch_to_body";
              mission.timestamp = Date.now();
              GM_setValue("pending_mission", JSON.stringify(mission));
              // Straż musi wiedzieć, gdzie jest dom, żeby powrót szedł w dobrą
              // stronę. Ucieczka w powietrze nie zbroi straży — nie tykamy.
              if (!mission.airSave) MoonSave.noteFlip(mission, other, here);   // v2.104.0
              await AntiDetection.sleep(500 + Math.random() * 500);
              window.location.replace("/");
              return;
            }
            log(`[${missionTag("MOON SAVE")}] nothing on this planet to save — aborting.`, "warn");
            DefenceWatchdog.note(`hangar pusty na ${MoonSave.currentBody() || "?"} — nie ma czego ratować`);
            GM_setValue("pending_mission", null);
            if (!mission.moonReturn) { try { RescueQueue.dropPending(mission.atCoords, "pusty hangar przy ratunku"); } catch {} }   // v2.104.0
            // v2.34.0: przy POWROCIE pusto na refugium znaczy, że nie ma czego
            // ściągać — flota już wróciła albo jest w drodze. Ponawianie tego
            // co pięć minut to była właśnie ta pętla, którą właściciel widział.
            if (mission.moonReturn) {
              // ── v2.74.5: pusto może znaczyć „ratunek WCIĄŻ LECI" ──
              // 6.08 12:32: powrót dotarł na refugium 24 s po wysłaniu ratunku
              // (lot 81 s), zastał pustkę i rozbroił straż — ratunek wylądował
              // minutę później bez opieki. Jeśli od wysyłki/utworzenia ratunku
              // nie minęło 130 s, straż ZOSTAJE i powrót ponowi się po locie.
              const w = MoonSave.watch();
              const ref = Math.max(w.lastSendAt || 0, w.lastAt || 0);
              if (w.armed && ref && Date.now() < ref + Math.max(130000, (w.lastFlightMs || 0) + 60000)) {
                log("[POWRÓT] refugium puste, ale ratunek jeszcze leci — straż zostaje, ponowię po lądowaniu.", "warn");
                ThreatLog.add("POWRÓT", "Refugium puste, ale ratunek w locie — czekam na lądowanie (straż uzbrojona).");
                MoonSave.saveWatch({ ...w, returning: false });
                return;
              }
              ThreatLog.add("POWRÓT", "Na refugium pusto — nie ma czego ściągać. Straż zdjęta.");
              MoonSave.disarm("refugium puste — powrót bezprzedmiotowy");
            }
            return;
          }
          // ── v2.104.0: PING-PONG RESZTEK (22 pancerniki 21:44–21:50) ──
          // Ratunek zapisuje, ile statków zawiózł; automatyczny powrót, który
          // zastaje na refugium < 20% tego (nowo zbudowane statki, resztki), nie
          // wysyła nic — statki na refugium są bezpieczne, a straż schodzi.
          // Nie dotyczy ręcznego WRÓĆ NA BAZĘ ani trwającego alarmu.
          try {
            const KEY_ST = "ogamex_save_total";
            if (mission.moonSave && !mission.moonReturn && !mission.ferry && !mission.fleetSave && !mission.sweep && loadedTotal > 0) {
              GM_setValue(KEY_ST, JSON.stringify({ at: Date.now(), total: loadedTotal, key: RescueQueue.str(mission.atCoords) }));
            } else if (mission.moonReturn && !mission.byOperator && !ThreatMonitor.active()) {
              const sv = JSON.parse(GM_getValue(KEY_ST, "null"));
              if (sv && sv.total > 0 && sv.key === RescueQueue.str(mission.atCoords) && Date.now() - (sv.at || 0) < 6 * 60 * 60 * 1000 && loadedTotal < 0.2 * sv.total) {
                log(`[POWRÓT] na refugium tylko resztki (${loadedTotal.toLocaleString()} vs ${sv.total.toLocaleString()} zawiezionych) — nie przerzucam, straż schodzi.`, "warn");
                ThreatLog.add("POWRÓT", `Na refugium resztki (${loadedTotal} z ${sv.total}) — powrót pominięty, straż zdjęta.`);
                GM_setValue("pending_mission", null);
                MoonSave.disarm("na refugium tylko resztki");
                return;
              }
            }
          } catch {}
          log(`[${missionTag("MOON SAVE")}] loading everything: ${loaded.join(", ")}`, "success");
          await verifyShipInputs("MOON SAVE"); // v2.74.2: formularz gubi pola
          // v2.71.0: prom to logistyka — wpis "odczyt" nie zaburza liczników obrony.
          ThreatLog.add(mission.ferry ? "odczyt" : "RATUNEK", `${mission.ferry ? "PROM załadowany" : "Załadowano"}: ${loaded.join(", ")}`);
        } else

        // ── v2.60.0: Fleet Save — wszystko POZA wykluczeniami (minery zostają) ──
        // Ta sama mechanika co ratunek (natywny setter + input/change), tylko
        // z filtrem: excludeTypes z konfiguracji FS (domyślnie ASTEROID_MINER —
        // minery pracują nocą i nie mają czego szukać na FS).
        if (mission.fleetSave) {
          // v2.74.4: minery zostają w domu TYLKO gdy mining pracuje (po to tam
          // są). Mining wyłączony = 7,5 mld minerów to zwykły cel na księżycu
          // (właściciel 05.08: „minery zostały na moonie") — lecą z FS-em.
          const excludeCfg = (CONFIG.fleetSave?.excludeTypes || ["ASTEROID_MINER"]).map(t => String(t).toUpperCase());
          const exclude = CONFIG.asteroidMining?.enabled ? excludeCfg : excludeCfg.filter(t => t !== "ASTEROID_MINER");
          if (excludeCfg.length !== exclude.length) log("[FS] mining wyłączony — minery NIE zostają, lecą z flotą.", "fleet");
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          const loaded = [];
          for (const el of document.querySelectorAll("[data-ship-type]")) {
            const type = el.dataset.shipType;
            const available = parseInt(el.dataset.shipQuantity || "0") || 0;
            if (!type || available <= 0) continue;
            if (exclude.includes(type.toUpperCase())) continue;
            const item = el.closest(".ship-item") || el.parentElement;
            const input = item?.querySelector("input.numberFormatInput, input[type='text']");
            if (!input) continue;
            if (nativeSetter) nativeSetter.call(input, available); else input.value = available;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            loaded.push(`${type}×${available}`);
            await AntiDetection.sleep(120 + Math.random() * 380);
          }
          if (!loaded.length) {
            // v2.66.0: bez tego stempla tick ponawiał start co 30 s przez całe
            // okno — nawigacyjny młyn przy księżycu bez floty.
            GM_setValue("ogamex_fs_fail_at", String(Date.now()));
            log(`[FS] na księżycu startowym nie ma floty do wysłania (poza wykluczeniami) — nic nie robię. Ships: ${shipDump}`, "warn");
            GM_setValue("pending_mission", null);
            return;
          }
          log(`[FS] załadowane: ${loaded.join(", ")}${mission.fsMeasure ? " (pomiar — wysyłki nie będzie)" : ""}`, "fleet");
          await verifyShipInputs("FS", exclude); // v2.74.2: formularz gubi pola (BC 23:22)
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
            stampDispatchFailIfMining(mission); // v2.95.0: porazka farmy/zlomu/ratunku nie parkuje skanera
            GM_setValue("pending_mission", null);
            return;
          }
          log(`Expedition wave composition (1/${mission.waves} of the fleet): ${filled.join(", ")}`, "fleet");
        } else {

        // Find the ship to send. Farm missions name their ship explicitly
        // (HEAVY_CARGO); asteroid missions try configured types first, then
        // fall back to ASTEROID/MINER naming.
        // v2.59.0: recycle też nazywa swój statek (RECYCLER). Bez tego warunku
        // lot po złom wpadał do gałęzi górniczej i ładował MINERY — czyli
        // pierwszy prawdziwy złom wysłałby flotę górniczą zamiast recyklerów.
        const shipTypesToTry = (mission.farm || mission.recycle)
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
          // v2.59.0: recycle dołącza do farm — zapis liczby RECYCLERÓW jako
          // „minerów w domu" psułby decyzję równoległą mininga.
          if (!mission.farm && !mission.recycle) {
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
            // v2.90.0: etykieta po typie misji — „Asteroid Miners” przy ataku
            // farmy Heavy Cargo myliło ownera w logach.
            const shipLabel = (mission.farm || mission.recycle) ? (mission.shipType || "ships").replace("_", " ") : "Asteroid Miners";
            log(`Selected ${toSend}/${available} ${shipLabel} (input: ${input.className})`, "fleet");
          } else {
            log(`No ${mission.farm || mission.recycle ? mission.shipType : "Asteroid Miners"} available (found: ${available}, input: ${!!input})`, "error");
            stampDispatchFailIfMining(mission); // v2.95.0: porazka farmy/zlomu/ratunku nie parkuje skanera
            // v2.11.1: farm with 0 HC on the active planet would otherwise
            // burn through the whole target queue (each retry stamps a target
            // cooldown and navigates for nothing). Pause the sweep instead.
            if (mission.farm) {
              FarmState.clear();
              GM_setValue("ogamex_farm_cooldown_until", String(Date.now() + 10 * 60 * 1000));
              log(`Farm: no ${mission.shipType} on the active body — sweep paused 10min.`, "warn");
              GM_setValue("pending_mission", null);
              return;
            }
            await finishDispatch(false);
            return;
          }
        } else {
          // ── v2.69.0: w trybie księżycowym NIE szukamy minerów po koloniach ──
          // One mieszkają na księżycu bazy; pusty hangar = są w powietrzu.
          // Stara rotacja przełączałaby aktywne ciało na kolonię i cała taktyka
          // "wszystko z księżyca" rozjechałaby się po jednej pustej wysyłce.
          if (CONFIG.baseBody === "moon") {
            log("Brak minerów na aktywnym księżycu — są w powietrzu. Czekam na powrót (tryb księżycowy: bez rotacji po koloniach).", "asteroid");
            GM_setValue("pending_mission", null);
            const storedReturnMoon = parseInt(GM_getValue("ogamex_fleet_return_at", "0")) || 0;
            if (!(storedReturnMoon > Date.now())) GM_setValue("ogamex_fleet_return_at", String(Date.now() + 10 * 60 * 1000));
            return;
          }
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
            window.location.replace(nextPlanet.link);
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
            stampDispatchFailIfMining(mission); // v2.95.0: porazka farmy/zlomu/ratunku nie parkuje skanera
            await finishDispatch(false);
            return;
          }
        }
        } // end single-ship-type path (v2.14.0)

        await AntiDetection.sleep(1000 + Math.random() * 1500);
        if (offAbort("step1→2")) return;

        // Click "Next" — step 1 → step 2
        if (!await clickButtonWhenEnabled("Next", "step1→2")) {
          dumpButtons("step1-fail");
          // v2.66.6: bez zabytkowego „Cannot find Next button" — powód porażki
          // (martwy przycisk vs brak przycisku) wypisał już clickButtonWhenEnabled
          // linijkę wyżej; drugi komunikat twierdził, że przycisku „nie było",
          // także wtedy, gdy stał na stronie wyłączony (mylił właściciela 09:51).
          log("Krok 1 nieudany — wycofuję wysyłkę (szczegóły wyżej).", "error");
            stampDispatchFailIfMining(mission); // v2.95.0: porazka farmy/zlomu/ratunku nie parkuje skanera
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
            stampDispatchFailIfMining(mission); // v2.95.0: porazka farmy/zlomu/ratunku nie parkuje skanera
          await finishDispatch(false);
          return;
        }
        log("Step 2 loaded (destination)", "fleet");
        dumpButtons("step2");

        // ── v2.66.5: sprawdź, czy formularz CELUJE tam, gdzie misja ──
        // Incydent 2026-08-04 09:50: formularz wczytał się BEZ parametrów
        // z URL — cel został domyślny (własna planeta 3:269:8 zamiast
        // 3:269:16), cel=źródło, gra wyszarzyła Next i fala przepadła po 25 s
        // czekania. Zrzut właściciela pokazał to wprost. Koordy celu siedzą
        // w polach #fleet2_target_x/y/z (markup potwierdzony na żywo przy
        // pomiarze FS) — porównaj z celem misji i popraw, ZANIM klikniemy.
        try {
          const wantCoord = coordsFromFleetUrl(mission.fleetUrl);
          const fx = document.getElementById("fleet2_target_x");
          const fy = document.getElementById("fleet2_target_y");
          const fz = document.getElementById("fleet2_target_z");
          if (wantCoord && wantCoord.split(":").length === 3 && fx && fy && fz) {
            const [wg, ws, wp] = wantCoord.split(":");
            const have = `${fx.value}:${fy.value}:${fz.value}`;
            if (have !== `${wg}:${ws}:${wp}`) {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
              for (const [el, v] of [[fx, wg], [fy, ws], [fz, wp]]) {
                if (setter) setter.call(el, v); else el.value = v;
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
              }
              log(`[CEL] formularz pokazywał [${have}], a misja leci na [${wg}:${ws}:${wp}] — poprawiłem pola celu (URL nie zaaplikował parametrów).`, "warn");
              // v2.97.4: sama korekta koordow NIE wystarcza, gdy formularz
              // otworzyl sie z domyslnym celem-KSIEZYCEM (aktywna para) - typ
              // celu zostawal "Moon" i gra odrzucala wysylke modalem "There is
              // no planet or moons on this target" (incydent 15.08 19:21: farm
              // z ksiezyca [4:132:8] na planety [4:406:x], krok 3 padal
              // timeoutem seriami). Misja z planet=1 w URL leci ZAWSZE na
              // planete - dopnij typ ta sama mechanika co ratunek
              // (data-planet-type=1, z pominieciem sidebara).
              if (/[?&]planet=1(?:&|$)/.test(mission.fleetUrl || "")) {
                const inSidebarCel = (el) => !!el.closest(".planet-select, .moon-select, .sidebar, nav, #ogx-bot-panel");
                const planetBtn = [...document.querySelectorAll('[data-planet-type="1"]')].filter(el => !inSidebarCel(el))[0];
                if (planetBtn) {
                  planetBtn.click();
                  log("[CEL] typ celu dopiety na PLANETE (formularz startowal z celem-ksiezycem).", "fleet");
                } else {
                  log("[CEL] nie znalazlem przelacznika typu celu (data-planet-type=1) - jesli gra odrzuci wysylke, wklej zrzut [MOON DOM].", "warn");
                }
              }
              await AntiDetection.sleep(700 + Math.random() * 500); // niech gra przeliczy trasę
            }
          }
        } catch {}

        // ── v2.26.0: the moon is a DESTINATION TYPE, not a link ──
        // Owner walked the form by hand and showed what the game actually does:
        // step 2's Destination panel offers planet / moon / debris for the SAME
        // coordinates, and step 3 then offers Transport / Deploy / Collect.
        // There is no moon link in the galaxy row to learn — which is why the
        // fleet save sat "cel nieznany" through every visit. Target the base
        // coords like any other fleet and pick the body here.
        if (mission.moonSave || mission.fleetSave) {
          // v2.28.0: the target body is decided at dispatch time and carried on
          // the mission, because "flee" and "home" are no longer fixed to moon
          // and planet — either can be the base. Old missions without the field
          // keep the pre-2.28 meaning.
          // v2.60.0: Fleet Save używa tego samego, sprawdzonego na żywo
          // przełącznika ciała (data-planet-type=2) — cel FS to zawsze księżyc.
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
            log(`[${missionTag("MOON SAVE")}] cel: ${wantMoon ? "KSIĘŻYC" : "PLANETA"} — kliknięto ${pick.tagName}.${(pick.className || "").toString().split(" ")[0] || "-"}`, "fleet");
            ThreatLog.add("RATUNEK", `Cel ustawiony: ${wantMoon ? "KSIĘŻYC" : "PLANETA"}`);
            await AntiDetection.sleep(400 + Math.random() * 400);
          } else {
            log(`[MOON SAVE] NIE ZNALAZŁEM przełącznika ${wantMoon ? "księżyca" : "planety"} na kroku 2 — lecę z domyślnym celem (to jest PLANETA). Zrzut panelu wyżej: przyślij go, dopiszę selektor.`, "error");
            ThreatLog.add("BŁĄD", `Nie znalazłem przełącznika ${wantMoon ? "księżyca" : "planety"} na kroku 2 — cel domyślny (PLANETA).`);
            // v2.60.0: dla ratunku (te same koordy, oba ciała nasze) lot z celem
            // domyślnym to świadoma kontynuacja. Dla FS cel domyślny = PLANETA
            // na OBCYCH koordach — tam nie wolno niczego wysłać. Przerwij.
            if (mission.moonSave && wantMoon && !mission.airSave) {
              // v2.102.0 (E-5): ratunek na KSIĘŻYC bez przełącznika = lot na planetę
              // (źródło) — nie wysyłamy byle gdzie; retry straży od razu.
              log("[RATUNEK] brak przełącznika księżyca na kroku 2 — NIE wysyłam na domyślną planetę. Ponowię.", "error");
              ThreatLog.add("BŁĄD", "Ratunek: brak przełącznika księżyca na kroku 2 — wysyłka przerwana, ponawiam.");
              MoonSave.noteRescueFail("brak przełącznika księżyca");
              GM_setValue("pending_mission", null);
              await AntiDetection.sleep(600 + Math.random() * 600);
              window.location.replace("/");
              return;
            }
            if (mission.fleetSave) {
              log("[FS] bez przełącznika księżyca NIE wysyłam — flota zostaje w domu.", "error");
              GM_setValue("pending_mission", null);
              await AntiDetection.sleep(600 + Math.random() * 600);
              window.location.replace("/");
              return;
            }
          }
        }

        // ── v2.68.1: złom — cel „pole złomu" wybieram SAM, nie ufam URL-owi ──
        // Link zbierania powinien ustawić typ celu, ale formularz potrafi
        // zgubić parametry URL (incydent 09:50 4.08 — poprawka [CEL] wyżej
        // ratuje wtedy tylko koordy). Przełącznik ciała znamy z żywego zrzutu
        // ratunku: data-planet-type 1=Planet, 2=Moon, 3=Debris.
        if (mission.recycle) {
          const panel = document.querySelector("#fleet2, .fleet2, .destination, [class*='destination']") || document.body;
          const inSidebar = (el) => !!el.closest(".planet-select, .moon-select, .sidebar, nav, #ogx-bot-panel");
          const debrisBtn = [...panel.querySelectorAll("[data-planet-type='3']")].filter(el => !inSidebar(el))[0];
          if (debrisBtn) {
            debrisBtn.click();
            log("[ZŁOM] cel: POLE ZŁOMU — kliknięto przełącznik data-planet-type=3.", "fleet");
            await AntiDetection.sleep(400 + Math.random() * 400);
          } else {
            log(`[ZŁOM] brak przełącznika pola złomu na kroku 2 — liczę na parametry linku. Panel: ${(panel.innerHTML || "").replace(/\s+/g, " ").trim().slice(0, 400)}`, "warn");
          }
        }

        // ── v2.60.0: FS — prędkość lotu (główna dźwignia długości FS) ──
        // Markupu suwaka NIKT jeszcze nie widział (nota: „trzeba zrzucić
        // osobno"), więc: najpierw próby po ZNACZENIU (select z opcjami %,
        // input[type=range], klikalne „10%"), zawsze zrzut okolic formularza
        // do logu, a o skutku i tak decyduje bramka niżej — na czasie lotu,
        // który pokazuje SAMA GRA. Nieustawiona prędkość ≠ zła wysyłka:
        // najwyżej okno nie zmieści się w 2×T i bot odmówi startu.
        if (mission.fleetSave || mission.airSave) { // v2.85.0: ucieczka w powietrze leci wolno tym samym kodem
          const pct = Math.max(1, Math.min(100, parseInt(mission.speedPercent) || 100)); // v2.74.1: fork ma też 3% i 5%
          let speedSet = false;
          // 1) select, którego opcje wyglądają jak procenty (wzorzec „po tekście”
          //    — ten sam, którym ustawiamy czas trwania ekspedycji)
          for (const sel of document.querySelectorAll("select")) {
            const opts = [...sel.options];
            if (!opts.some(o => /%/.test(o.textContent || ""))) continue;
            const hit = opts.find(o => ((o.textContent || "").replace(/\s+/g, "").match(/^(\d{1,3})%$/) || [])[1] === String(pct));
            if (!hit) continue;
            sel.value = hit.value;
            sel.dispatchEvent(new Event("input", { bubbles: true }));
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            speedSet = true;
            break;
          }
          // 2) suwak: skala 1-10 (klasyczne 10%-100%) albo 10-100
          if (!speedSet) {
            const r = document.querySelector("input[type='range']");
            if (r) {
              const min = parseFloat(r.min || "1"), max = parseFloat(r.max || "10");
              const value = max <= 10 ? Math.max(min, Math.round(pct / 10)) : Math.max(min, Math.min(max, pct));
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
              if (setter) setter.call(r, value); else r.value = value;
              r.dispatchEvent(new Event("input", { bubbles: true }));
              r.dispatchEvent(new Event("change", { bubbles: true }));
              speedSet = true;
            }
          }
          // 3) klikalny element z dokładnym tekstem „NN%"
          if (!speedSet) {
            const el = [...document.querySelectorAll("a, button, span, div, label")]
              .find(e => e.offsetParent !== null && (e.textContent || "").trim() === `${pct}%`);
            if (el) { el.click(); speedSet = true; }
          }
          // 4) v2.66.8: NA TYM FORKU suwak to rząd GOŁYCH liczb, bez znaku % —
          // zrzut właściciela (04.08, krok 2, sekcja Briefing): „Speed:
          // 3 5 10 20 30 40 50 60 70 80 90 100" z podświetloną setką.
          // Rząd rozpoznajemy po komplecie wartości (rodzic, którego dzieci
          // mają teksty „3", „10" i „50") — samo „10" występuje na stronie
          // w tysiącu innych miejsc i klikanie po gołym tekście byłoby ruletką.
          if (!speedSet) {
            const txt = (e) => (e.textContent || "").trim();
            const hundreds = [...document.querySelectorAll("a, span, button, div, td, li")]
              .filter(e => txt(e) === "100" && e.offsetParent !== null && !e.closest("#ogx-bot-panel"));
            for (const h of hundreds) {
              const row = h.parentElement;
              if (!row) continue;
              const kids = [...row.children];
              const texts = kids.map(txt);
              if (!(texts.includes("3") && texts.includes("10") && texts.includes("50"))) continue;
              const target = kids.find(k => txt(k) === String(pct));
              if (target) { target.click(); speedSet = true; }
              break;
            }
          }
          // v2.63.0: poprzedni zrzut łapał NAGŁÓWEK strony (selektor trafiał
          // w document.body) — bezużyteczny. Kotwicą jest panel celu
          // (#target_planet_type_container — potwierdzony na żywo 16:36),
          // zrzucamy jego okolicę + listę wszystkiego, co wygląda jak "NN%".
          if (!speedSet && GM_getValue("ogamex_fs_speed_dumped", "") !== "2") {
            GM_setValue("ogamex_fs_speed_dumped", "2");
            const dest = document.getElementById("target_planet_type_container");
            const host = (dest && (dest.closest("form") || dest.parentElement?.parentElement?.parentElement))
              || document.querySelector("#content, .content") || document.body;
            log(`[FS DOM] krok 2 — okolica formularza (szukam suwaka prędkości): ${(host.innerHTML || "").replace(/\s+/g, " ").trim().slice(0, 3000)}`, "error");
            const pctEls = [...document.querySelectorAll("a, span, div, li, button, option, label")]
              .filter(e => /^\s*\d{1,3}\s*%\s*$/.test(e.textContent || "")).slice(0, 12);
            log(pctEls.length
              ? `[FS DOM] elementy z "%": ${pctEls.map(e => `${e.tagName}.${String(e.className).split(" ")[0] || "-"}#${e.id || "-"}[${(e.textContent || "").trim()}]`).join(", ")}`
              : "[FS DOM] na stronie nie ma ŻADNEGO elementu z samym \"NN%\" — suwak może być na innym kroku albo mieć inną formę.", "error");
          }
          log(`[FS] prędkość ${pct}%: ${speedSet ? "ustawiona" : "NIE ustawiona (markup w logu — przyślij go). Gra poleci z domyślną."}`, speedSet ? "fleet" : "warn");
          // pozwól grze przeliczyć czas lotu po zmianie prędkości
          await AntiDetection.sleep(1200 + Math.random() * 800);
        }

        // ── v2.10.0: learn cargo-per-miner from the confirmation page ──
        // OGameX shows the selected fleet's total cargo capacity here. Divide
        // by the miners we selected to learn one miner's capacity, which feeds
        // AsteroidYieldTracker.minersNeeded(). Only learn when we know how many
        // we sent (dispatchInfo.toSend) and the user hasn't pinned it in config.
        try {
          // v2.90.0: ucz się WYŁĄCZNIE na locie minerów — Heavy Cargo farmy ma
          // inną ładowność (463 750 vs 20 750) i tylko hałasował strażnikiem
          // rozsądku („Odrzucam odczyt ładowności…” przy każdym ataku).
          if (!mission.farm && !mission.expedition && !mission.recycle
              && !CONFIG.asteroidMining.cargoPerMiner && dispatchInfo.toSend > 0) {
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
        // v2.66.8: ten fork podpisuje czas lotu „Duration of flight (one way):
        // 00:35" — format MM:SS (jeden dwukropek), więc wzorzec HH:MM:SS wyżej
        // NIGDY go nie łapał. Dotyczy WSZYSTKICH misji: mining też wreszcie
        // dostaje czas lotu z formularza, zamiast odtwarzać go z paska po
        // wysyłce. Przy dłuższych lotach gra może pokazać H:MM:SS — trzeci
        // człon jest opcjonalny.
        if (!capturedFlightMs) {
          const fm2 = step2Text.match(/Duration\s*of\s*flight[^0-9]{0,40}?(\d{1,3}):(\d{2})(?::(\d{2}))?/i);
          if (fm2) {
            capturedFlightMs = fm2[3] !== undefined
              ? (parseInt(fm2[1]) * 3600 + parseInt(fm2[2]) * 60 + parseInt(fm2[3])) * 1000
              : (parseInt(fm2[1]) * 60 + parseInt(fm2[2])) * 1000;
            log(`Captured flight time (Duration of flight): ${fm2[1]}:${fm2[2]}${fm2[3] !== undefined ? ":" + fm2[3] : ""} → ${Math.round(capturedFlightMs / 1000)}s one-way`, "fleet");
          }
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

        // ── v2.99.0 KALIBRACJA: para (Δ systemów, minuty) z realnego lotu ──
        // Tylko misje górnicze — jeden typ statku (ASTEROID_MINER), 100%
        // prędkości, ta sama galaktyka. Cel z fleetUrl (x=g&y=s), start z
        // launchAt misji (fallback: HomeBase.mining() — to samo źródło,
        // którym planer liczy dystanse, więc mapowanie jest spójne).
        if (capturedFlightMs > 0 && mission.type === "asteroid_mining_direct") {
          try {
            const calUrl = (mission.fleetUrl || "").match(/[?&]x=(\d+)&y=(\d+)/);
            const calFrom = mission.launchAt || HomeBase.mining();
            if (calUrl && calFrom && parseInt(calUrl[1]) === calFrom.galaxy) {
              FlightCalibration.record(Math.abs(parseInt(calUrl[2]) - calFrom.system), capturedFlightMs / 60000);
            }
          } catch (e) { log(`[KALIBRACJA] zapis próbki nieudany (nie blokuje wysyłki): ${e.message}`, "warn"); }
        }

        // ── v2.86.5: KAŻDY ratunek niesie realny czas lotu ──
        // Straż i powrót liczą lądowanie od niego, nie od założenia
        // „hop < 130 s” (13:41: ratunek 38 min — straż zdjęłaby się pół
        // godziny przed lądowaniem, a flota siadłaby na planecie bez opieki).
        if (mission.moonSave && capturedFlightMs > 0 && !mission.flightMs) {
          mission.flightMs = capturedFlightMs;
          GM_setValue("pending_mission", JSON.stringify(mission));
        }
        // ── v2.85.0: UCIECZKA W POWIETRZE — bramka arytmetyki ──
        // Zawrócić można tylko lot, który jeszcze leci — czas lotu z kroku 2
        // musi pokrywać okno „ostatni dolot ataku + bufor". Za krótki lot =
        // uczciwa odmowa i powrót kolonii na zwykły ratunek (swap > nic).
        if (mission.airSave) {
          if (capturedFlightMs > 0) {
            mission.flightMs = capturedFlightMs;
            GM_setValue("pending_mission", JSON.stringify(mission));
            const neededMs = Math.max(0, (mission.holdUntilMs || 0) - Date.now()) + 60000;
            if (capturedFlightMs < neededMs && mission.airExtra) {
              // v2.100.0: lot dodatkowy (zamiatanie) za krótki — NIE tykamy stanu
              // głównej ucieczki; fala zostaje, straż w parze przejmie ją po powrocie.
              log(`[UCIECZKA] fala z zamiatania: lot ${Math.round(capturedFlightMs / 60000)} min < wymagane ${Math.ceil(neededMs / 60000)} min — tej fali nie wysyłam w powietrze.`, "warn");
              GM_setValue("pending_mission", null);
              return;
            }
            if (capturedFlightMs < neededMs) {
              log(`[UCIECZKA] lot ${Math.round(capturedFlightMs / 60000)} min KRÓTSZY niż wymagane ${Math.ceil(neededMs / 60000)} min (ostatni dolot + bufor) — NIE wysyłam w powietrze, kolonia wraca na zwykły ratunek.`, "error");
              ThreatLog.add("BŁĄD", `Ucieczka w powietrze odwołana: lot ${Math.round(capturedFlightMs / 60000)} min < wymagane ${Math.ceil(neededMs / 60000)} min. Przechodzę na ratunek na drugie ciało.`);
              AirSave.markFailed(mission.atCoords, "lot za krótki na okno zawrócenia");
              AirSave.save(null);
              GM_setValue("pending_mission", null);
              return;
            }
          } else {
            log("[UCIECZKA] nie odczytałem czasu lotu w kroku 2 — wysyłam mimo to (wolny Deploy do innej kolonii to godziny lotu vs minuty dolotu ataku).", "warn");
          }
        }
        // ── v2.60.0: FS — bramka arytmetyki na PRAWDZIWYM czasie lotu ──
        // To jest serce bezpieczeństwa FS: decyzja nie zapada na szacunku ani
        // na niezweryfikowanym markupli, tylko na czasie lotu, który gra sama
        // pokazuje w kroku 2 (capturedFlightMs — ten sam odczyt, którego mining
        // używa od miesięcy). Zawrócona flota wraca po 2×opóźnieniu, więc okno
        // do powrotu musi mieścić się w 2×T minus margines na samo zawrócenie.
        // Nie mieści się (albo to tylko pomiar) → NIE wysyłamy, T zapisany,
        // planer od teraz liczy start bez wchodzenia w formularz.
        let fsOnStep3 = false;
        if (mission.fleetSave) {
          // v2.63.0: pomiar 16:36 pokazał, że krok 2 tego forka NIE pokazuje
          // czasu lotu tam, gdzie czyta go mining (capturedFlightMs=0).
          // Przy pomiarze wchodzimy więc na krok 3 (misja + podsumowanie) —
          // BEZ dotykania „Send fleet" — i próbujemy odczytać czas tam.
          // Nadal nic → zrzut kroku 3 do logu i uczciwa odmowa.
          // v2.104.5: 26.08 17:46 — pomiar odczytał 432 min na kroku 3, a
          // PRAWDZIWY start FS 3 s później odmówił „nie odczytałem czasu lotu",
          // bo krok 3 czytał tylko pomiar. Teraz każda wysyłka FS bez czasu
          // z kroku 2 idzie na krok 3 po odczyt (dalej bez „Send fleet");
          // wysyłka pomija potem drugie „Next", bo już jest na kroku 3.
          if (mission.fleetSave && !(capturedFlightMs > 0)) {
            if (await clickButtonWhenEnabled("Next", mission.fsMeasure ? "fs-measure step2→3" : "fs step2→3 (odczyt czasu)")) {
              fsOnStep3 = true;
              await waitForStepChange(() => Array.from(document.querySelectorAll("a, button, input[type='submit'], input[type='button']")).some(el => {
                if (el.offsetParent === null) return false;
                const txt = (el.value || el.textContent || "").trim().toLowerCase();
                return txt.includes("send fleet");
              }), 12000);
              const t3 = document.body.textContent;
              const m3 = t3.match(/(?:[Ff]light\s*(?:time|duration)|[Dd]uration|[Cc]zas\s*lotu)[\s:]*(\d{1,2}):(\d{2}):(\d{2})/);
              if (m3) capturedFlightMs = (parseInt(m3[1]) * 3600 + parseInt(m3[2]) * 60 + parseInt(m3[3])) * 1000;
              // v2.66.8: format tego forka — „Duration of flight … MM:SS"
              if (!(capturedFlightMs > 0)) {
                const m3b = t3.match(/Duration\s*of\s*flight[^0-9]{0,40}?(\d{1,3}):(\d{2})(?::(\d{2}))?/i);
                if (m3b) capturedFlightMs = m3b[3] !== undefined
                  ? (parseInt(m3b[1]) * 3600 + parseInt(m3b[2]) * 60 + parseInt(m3b[3])) * 1000
                  : (parseInt(m3b[1]) * 60 + parseInt(m3b[2])) * 1000;
              }
              if (!(capturedFlightMs > 0)) {
                const el3 = document.querySelector("[class*='flight'], [class*='duration'], [id*='duration' i], [id*='flight' i]");
                const tm3 = el3 && (el3.textContent || "").match(/(\d{1,2}):(\d{2}):(\d{2})/);
                if (tm3) capturedFlightMs = (parseInt(tm3[1]) * 3600 + parseInt(tm3[2]) * 60 + parseInt(tm3[3])) * 1000;
              }
              if (capturedFlightMs > 0) {
                log(`[FS] czas lotu odczytany na kroku 3: ${Math.round(capturedFlightMs / 60000)} min.`, "info");
              } else if (GM_getValue("ogamex_fs_step3_dumped", "") !== "1") {
                GM_setValue("ogamex_fs_step3_dumped", "1");
                const host3 = document.querySelector("#content, .content") || document.body;
                log(`[FS DOM] krok 3 (szukam czasu lotu): ${(host3.innerHTML || "").replace(/\s+/g, " ").trim().slice(0, 3000)}`, "error");
              }
            }
          }
          if (capturedFlightMs > 0) FleetSave.noteFlightMs(capturedFlightMs);
          const windowMs = (mission.returnAtMs || 0) - Date.now();
          const maxMs = capturedFlightMs > 0 ? 2 * capturedFlightMs - 2 * FleetSave.LAUNCH_MARGIN_MS : 0;
          const fits = capturedFlightMs > 0 && windowMs > 0 && windowMs <= maxMs;
          if (mission.fsMeasure || !fits) {
            const hhmm = (ms) => new Date(ms).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
            const why = mission.fsMeasure
              ? (capturedFlightMs > 0
                ? `pomiar zakończony — czas lotu ${Math.round(capturedFlightMs / 60000)} min, maksymalny FS ${Math.round(Math.max(0, maxMs) / 60000)} min`
                : "pomiar NIE odczytał czasu lotu na kroku 2 ani 3 — przyślij linie [FS DOM] z logu")
              : !(capturedFlightMs > 0) ? "nie odczytałem czasu lotu z formularza (zrzut prędkości wyżej w logu)"
              : windowMs <= 0 ? "godzina powrotu już minęła"
              : `okno ${Math.round(windowMs / 60000)} min > maks. ${Math.round(maxMs / 60000)} min — start opłaca się o ${hhmm((mission.returnAtMs || 0) - maxMs)}`;
            // Nieudany odczyt czasu lotu nie może napędzać pomiaru co 15 min
            // (2 nawigacje + formularz za każdym razem) — automat odsunięty,
            // przycisk „Zmierz trasę" działa od ręki.
            if (!(capturedFlightMs > 0)) GM_setValue("ogamex_fs_measure_at", String(Date.now() + 3 * 60 * 60 * 1000));
            log(`[FS] NIE wysyłam: ${why}.`, mission.fsMeasure ? "success" : "warn");
            // v2.75.6: odmowa bez pauzy PĘTLIŁA start co tick (07.08 08:10–08:13:
            // 7× „Start FS" w 2,5 min, zero wysyłek), a powód szedł tylko do
            // zwykłego logu — dziennik pokazywał pętlę bez wyjaśnienia.
            // Każda odmowa nie-pomiarowa: 10 min pauzy + powód do dziennika.
            if (!mission.fsMeasure) {
              GM_setValue("ogamex_fs_fail_at", String(Date.now()));
              ThreatLog.add("FS", `NIE wysyłam: ${why}. Następna próba za 10 min.`);
            }
            GM_setValue("pending_mission", null);
            await AntiDetection.sleep(600 + Math.random() * 600);
            window.location.replace("/");
            return;
          }
          // wysyłamy — zapisz zmierzony T w misji, żeby stempel po wysyłce
          // (markLaunched) miał go pod ręką także na ścieżce z nawigacją
          mission.capturedFlightMs = capturedFlightMs;
          mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
        }

        await AntiDetection.sleep(800 + Math.random() * 1200);
        if (offAbort("step2→3")) return;

        // Click "Next" — step 2 → step 3 (FS mógł już tam wejść po czas lotu)
        if (!fsOnStep3 && !await clickButtonWhenEnabled("Next", "step2→3")) {
          dumpButtons("step2-fail");
          // v2.66.6: jak w kroku 1 — prawdziwy powód jest linijkę wyżej.
          log("Krok 2 nieudany — wycofuję wysyłkę (szczegóły wyżej).", "error");
            stampDispatchFailIfMining(mission); // v2.95.0: porazka farmy/zlomu/ratunku nie parkuje skanera
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
            stampDispatchFailIfMining(mission); // v2.95.0: porazka farmy/zlomu/ratunku nie parkuje skanera
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
            log(`[${missionTag("MOON SAVE")}] mission: "${(picked.textContent || "").trim().slice(0, 30)}" (${picked.className})`, "fleet");
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
            log(`[${missionTag("MOON SAVE")}] all resources loaded.`, "fleet");
          } else {
            const fulls = [...document.querySelectorAll("a.btn-res-full, .btn-res-full")];
            fulls.forEach(b => b.click());
            log(fulls.length
              ? `[MOON SAVE] loaded resources via ${fulls.length} per-resource max buttons.`
              : "[MOON SAVE] no resource-load button found — ships fly, resources stay.", fulls.length ? "fleet" : "warn");
          }
          await AntiDetection.sleep(400 + Math.random() * 400);
          await applyDeutReserve(missionTag("MOON SAVE")); // v2.74.0: paliwo dla spóźnialskich
        }

        // ── v2.60.0: FS — misja Stacjonuj + surowce z księżyca ──
        // Ten sam sprawdzony wzorzec co ratunek (mission-item po klasie/tekście,
        // btn-all-res), ale TRANSPORT tu odpada twardo: gdy zawrócenie zawiedzie,
        // stacjonująca flota zostaje bezpieczna na naszym księżycu, a transport
        // rozładowałby się i wrócił do domu w środku nocy — dokładnie w okno,
        // przed którym FS ma chronić.
        if (mission.fleetSave) {
          const missions = [...document.querySelectorAll(".mission-item, [class*='mission-item']")];
          const nameOf = (el) => `${el.className || ""} ${el.textContent || ""}`.toUpperCase();
          let picked = null, matched = null;
          for (const want of MoonSave.MISSION_CANDIDATES) {
            if (want === "TRANSPORT") break; // dla FS transport nie jest zapasem
            picked = missions.find(m => nameOf(m).includes(want));
            if (picked) { matched = want; break; }
          }
          if (!picked) {
            log(`[FS] brak misji stacjonowania na kroku 3 — NIE wysyłam. Dostępne: ${missions.map(m => `${(m.textContent || "").trim().slice(0, 20)}[${m.className}]`).join(", ") || "NONE"}`, "error");
            GM_setValue("pending_mission", null);
            await AntiDetection.sleep(600 + Math.random() * 600);
            window.location.replace("/");
            return;
          }
          log(`[FS] misja: "${(picked.textContent || "").trim().slice(0, 30)}" (${matched})`, "fleet");
          picked.click();
          await AntiDetection.sleep(500 + Math.random() * 500);
          const allRes = document.querySelector("a.btn-all-res, .btn-all-res");
          if (allRes) { allRes.click(); log("[FS] surowce z księżyca załadowane.", "fleet"); }
          await AntiDetection.sleep(400 + Math.random() * 400);
          await applyDeutReserve("FS"); // v2.74.0: paliwo dla spóźnialskich
        }

        // ── v2.68.1: złom — misja „Collect" klikana jawnie, albo wcale ──
        // Ten build ma A.mission-item.COLLECT (widziane na żywo w zrzucie
        // step3-clickables 4.08 22:12). Bez trafienia NIE wysyłam: domyślna
        // misja z całym hangarem recyklerów to loteria, a złom poczeka.
        if (mission.recycle) {
          const missions = [...document.querySelectorAll(".mission-item, [class*='mission-item']")];
          const nameOf = (el) => `${el.className || ""} ${el.textContent || ""}`.toUpperCase();
          const picked = missions.find(m => /COLLECT|HARVEST|RECYCL/.test(nameOf(m)));
          if (!picked) {
            log(`[ZŁOM] brak misji Collect/Harvest na kroku 3 — NIE wysyłam. Dostępne: ${missions.map(m => `${(m.textContent || "").trim().slice(0, 20)}[${m.className}]`).join(", ") || "NONE"}`, "error");
            GM_setValue("pending_mission", null);
            await AntiDetection.sleep(600 + Math.random() * 600);
            window.location.replace("/");
            return;
          }
          log(`[ZŁOM] misja: "${(picked.textContent || "").trim().slice(0, 30)}" (${picked.className})`, "fleet");
          picked.click();
          await AntiDetection.sleep(500 + Math.random() * 500);
        }

        // ── v2.72.0: farma — misja ATTACK klikana jawnie, albo wcale ──
        // Dotąd farma ufała parametrowi mission=8 z URL-a, a ten formularz
        // potrafi zgubić parametry (incydent 09:50 4.08 — cel domyślny mimo
        // koordów w URL). mission=8 nigdy nie było potwierdzone na żywo na tym
        // forku (numeracja jest własna: ekspedycja=1, asteroida=12). Zła misja
        // = flota leci nie wiadomo po co. Wzorzec sprawdzony przy złomie:
        // mission-item po klasie/tekście, bez trafienia NIE wysyłamy + zrzut.
        if (mission.farm) {
          const missions = [...document.querySelectorAll(".mission-item, [class*='mission-item']")];
          const nameOf = (el) => `${el.className || ""} ${el.textContent || ""}`.toUpperCase();
          const picked = missions.find(m => /ATTACK|ATAK/.test(nameOf(m)) && !/ACS|MISSILE|DESTR/.test(nameOf(m)));
          if (!picked) {
            log(`[FARM] brak misji Attack na kroku 3 — NIE wysyłam. Dostępne: ${missions.map(m => `${(m.textContent || "").trim().slice(0, 20)}[${m.className}]`).join(", ") || "NONE"}`, "error");
            FarmState.clear();
            GM_setValue("ogamex_farm_cooldown_until", String(Date.now() + 30 * 60 * 1000));
            GM_setValue("pending_mission", null);
            await AntiDetection.sleep(600 + Math.random() * 600);
            window.location.replace("/");
            return;
          }
          log(`[FARM] misja: "${(picked.textContent || "").trim().slice(0, 30)}" (${picked.className})`, "fleet");
          picked.click();
          await AntiDetection.sleep(500 + Math.random() * 500);
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
            if (!opts.some(o => /\b\d+\s*(hour|hours|h|godz|min)/i.test(o.textContent || ""))) continue;
            // v2.103.0: ODKRYWCA — najpierw opcja 40 min; gdy jej nie ma (inna
            // klasa), głośno i na godziny.
            const pick = pickExpeditionDuration(opts, { hours: want, minutes: mission.holdingMinutes || 0 });
            if (mission.holdingMinutes && !pick.minutesHit && Date.now() - (parseInt(GM_getValue("ogamex_disc40_warned", "0")) || 0) > 15 * 60 * 1000) {
              GM_setValue("ogamex_disc40_warned", String(Date.now()));
              log(`[ODKRYWCA] brak opcji „${mission.holdingMinutes} min" w formularzu (masz: ${opts.map(o => (o.textContent || "").trim()).join(", ")}) — klasa to nie Odkrywca? Wysyłam na ${want}h.`, "warn");
            }
            const hit = pick.option;
            if (!hit) { log(`Expedition: no "${want}h" option (have: ${opts.map(o => (o.textContent || "").trim()).join(", ")}) — leaving the default.`, "warn"); continue; }
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
          // v2.83.0: ostatnia szansa wyłącznika — OFF kliknięty w trakcie
          // kroków 1-3 ma zatrzymać wysyłkę TERAZ, nie po fakcie.
          if (offAbort("Send fleet")) return;
          const flyingNow = (mission.expedition || mission.moonSave || mission.fleetSave || mission.recycle) ? null : await fleetAlreadyFlyingTo(missionCoord, { skipDom: true });
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
              coord: (mission.expedition || mission.fleetSave) ? null : missionCoord,
              at: Date.now(),
              releaseAt: (mission.expedition || mission.fleetSave) ? Date.now() : releaseAt,
              farm: !!mission.farm,
              expedition: !!mission.expedition,
              fleetSave: !!mission.fleetSave,
            });
            if (!mission.expedition && !mission.recycle && !mission.fleetSave && missionCoord && releaseAt) DispatchedAsteroids.release(missionCoord, releaseAt);
            // v2.39.1: osobny licznik NASZYCH lotow gorniczych (limit rownoleglych
            // lotow). Stemplujemy PRZED klikiem — nawigacja potrafi zabic wszystko,
            // co jest po nim.
            if (!mission.expedition && !mission.farm && !mission.moonSave && !mission.recycle && !mission.fleetSave) {
              MiningFlights.add(missionCoord, capturedFlightMs);
            }
          }
          // v2.102.0 (E-1): ratunek NIE klika w wyszarzony „Wyślij" — czeka do 10 s,
          // aż gra skończy walidację (mało deuteru / brak misji = przycisk nieaktywny).
          if (mission.moonSave) {
            for (let i = 0; i < 20 && OnlineBonus.isDisabled(sendBtn); i++) await AntiDetection.sleep(500);
            if (OnlineBonus.isDisabled(sendBtn)) log("[RATUNEK] przycisk „Wyślij” nadal nieaktywny po 10 s — klikam mimo to i sprawdzę wynik.", "warn");
          }
          sendBtn.click();

          await AntiDetection.sleep(3000);
          // v2.102.0 (P1 recenzji): gra nawiguje po wysyłce z opóźnieniem (widziano ~4 s) —
          // ratunek czeka do 8 s, aż formularz zniknie, zanim uzna porażkę.
          if (mission.moonSave) {
            for (let i = 0; i < 10 && sendBtn.isConnected && sendBtn.offsetParent !== null; i++) await AntiDetection.sleep(500);
          }
          // v2.10.24: only a VISIBLE element with actual text counts as an
          // error. `[class*='error']` also matches hidden/empty error
          // containers baked into the page — a false positive here wiped the
          // duplicate-guard stamp (line below) after every send, killing the
          // guard exactly when it was needed.
          // v2.98.2: NIGDY nie czytaj własnego panelu jako odpowiedzi gry.
          // Incydent 17.08 14:22 (prawdziwy atak): wpis logu „INCOMING…"
          // (class="log-entry error") wpadł w [class*='error'] i ratunek
          // księżyc→planeta dostał fałszywy DISPATCH FAILED, choć gra flotę
          // PRZYJĘŁA — bot skasował stempel duplikatów i uznał ratunek za
          // nieudany. Symetrycznie [class*='success'] łapał „log-entry
          // success", więc mógł zamaskować PRAWDZIWĄ odmowę gry.
          const errorMsg = Array.from(document.querySelectorAll(".error, .alert-danger, [class*='error']"))
            .find(el => !el.closest("#ogx-bot-panel") && el.offsetParent !== null && el.textContent.trim().length > 0);
          const successMsg = Array.from(document.querySelectorAll(".success, .alert-success, [class*='success']"))
            .find(el => !el.closest("#ogx-bot-panel"));
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
            if (!mission.expedition && !mission.farm && !mission.moonSave && !mission.recycle && !mission.fleetSave) MiningFlights.dropLast();
            stampDispatchFailIfMining(mission); // v2.95.0: porazka farmy/zlomu/ratunku nie parkuje skanera
          } else if (successMsg || fleetMovement) {
            if (mission.moonSave) ThreatLog.add(mission.ferry ? "odczyt" : mission.moonReturn ? "POWRÓT" : "RATUNEK", mission.ferry ? "PROM: planeta → księżyc wysłany." : "WYSŁANE — gra przyjęła flotę.");
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
            if (capturedFlightMs > 0 && !mission.farm && !mission.expedition && !mission.moonSave && !mission.recycle && !mission.fleetSave) {
              // Round trip = flight time * 2, add 1 min buffer for processing
              const returnTime = Date.now() + capturedFlightMs * 2 + 60000;
              GM_setValue("ogamex_fleet_return_at", String(returnTime));
              const minLeft = Math.ceil((returnTime - Date.now()) / 60000);
              log(`Fleet returns in ~${minLeft}min (flight: ${Math.round(capturedFlightMs/60000)}min × 2)`, "fleet");
            } else if (!mission.farm && !mission.expedition && !mission.moonSave && !mission.recycle && !mission.fleetSave) {
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
            // v2.102.0 (E-1): dla RATUNKU brak potwierdzenia ≠ sukces. Jeśli
            // formularz z przyciskiem nadal stoi na stronie, wysyłka NIE poszła.
            const formStillHere = (() => { try { return !!(sendBtn && sendBtn.isConnected && sendBtn.offsetParent !== null); } catch { return false; } })();
            if (mission.moonSave && formStillHere) {
              log("[RATUNEK] po kliku „Wyślij” formularz nadal na stronie — wysyłka NIE poszła. Zgłaszam porażkę, ponowię od razu.", "error");
              ThreatLog.add("BŁĄD", "Ratunek: klik „Wyślij” nie wysłał floty (formularz został). Ponawiam.");
              dispatchOk = false;
            } else
            dispatchOk = true; // assume success if no error
            // Still use captured flight time if available (mining only)
            if (capturedFlightMs > 0 && !mission.farm && !mission.expedition && !mission.moonSave && !mission.recycle && !mission.fleetSave) {
              const returnTime = Date.now() + capturedFlightMs * 2 + 60000;
              GM_setValue("ogamex_fleet_return_at", String(returnTime));
              log(`Estimated return in ~${Math.ceil((capturedFlightMs * 2 + 60000) / 60000)}min`, "fleet");
            }
          }
        } else {
          dumpButtons("step3-no-send");
          log("Cannot find 'Send fleet' button (step 3)", "error");
          if (mission.moonSave) ThreatLog.add("BŁĄD", "Brak przycisku Send fleet na kroku 3 — ratunek NIE poleciał.");
            stampDispatchFailIfMining(mission); // v2.95.0: porazka farmy/zlomu/ratunku nie parkuje skanera
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
        window.location.replace(mission.fleetUrl);
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
    try { if (GateSave.reconAfterJump()) return; } catch {}   // v2.109.1

    // v2.36.0: obrona NIE jest już częścią ticku — ma własny zegar
    // (startDefenceLoop). Powód w audycie: jitter śpi WEWNĄTRZ ticku, a łańcuch
    // jest szeregowy, więc „przed każdą pauzą" nie chroniło przed pauzą, która
    // zatrzymuje cały zegar.

    // v2.107.0 (audyt 2, Z7/A8): keepalive + samonaprawa sesji stoją PRZED bramkami
    // przerwy kawowej i nocy. Dotąd siedziały ZA nimi → w 5-15 min przerwy i przez
    // całą noc zero przeładowań → sesja wygasała → odczyt paska/listy dostawał
    // stronę logowania = obrona ślepa dokładnie wtedy, gdy napastnik gra na
    // statystykę (sondy co minutę). Przeładowanie strony nie jest „aktywnością"
    // gracza — człowiek też zostawia otwartą kartę.
    if (SessionWatch.maybeRecover()) return;
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
          window.location.replace("/");
        } else {
          window.location.reload();
        }
        return;
      }
    }

    // v2.12.0: coffee breaks — full-bot pause with human macro-pacing.
    if (Humanizer.isOnBreak()) {
      log(`On break (~${Humanizer.breakLeftMin()}min left) — no activity.`, "delay");
      return;
    }
    if (Humanizer.maybeStartBreak()) return;

    // v2.10.27: background yield learning (30min throttle inside, fail-open).
    AsteroidYieldTracker.fetchReportsPeriodic().catch(() => {});

    // v2.105.0: odbudowa zniszczonego księżyca (znacznik ogamex_moon_lost_*).
    MoonRebuild.maybeStart();

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

    // v2.71.0: PROM planeta→księżyc — w trybie księżycowym co 2 h przewozi
    // wszystko, co uzbierało się na planecie (produkcja stoczni, deuter,
    // flota po nietypowym epizodzie). due() sam sprawdza alarm/straż/pending/
    // przerwy, więc tu wystarczy jedno wywołanie. Jeśli utworzył misję —
    // kończymy tick, handlePendingMission przejmie od następnego przebiegu.
    if (await MoonFerry.run().catch(() => false)) return;

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
      // v2.99.3: jeśli tick trafił na galaktyce bazy — sprawdź złom od razu
      // (tryCollectHere sam sprawdza, czy to właściwy układ).
      try { if (GameState.getCurrentPage() === "galaxy" && DebrisCollector.tryCollectHere()) return; } catch {}
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
  // ═══════════════════════════════════════════════════════════════
  //  NADZORCA OBRONY (v2.76.0) — kto pilnuje pilnującego
  // ═══════════════════════════════════════════════════════════════
  // Dwa razy w jednym tygodniu obrona ZOBACZYŁA zagrożenie i nie zrobiła
  // z nim nic: 03.08 alarm, którego nikt nie zdejmował, 07.08 atak grupowy
  // wzięty za sondę. Wspólnym mianownikiem nie jest żadna z tych logik —
  // jest nim to, że BEZCZYNNOŚĆ WYGLĄDA IDENTYCZNIE JAK SUKCES. W obu
  // przypadkach w dzienniku była po prostu cisza.
  //
  // Nadzorca odwraca ten domyślny stan. Gdy alarm trwa, a przez GRACE_MS nie
  // pojawi się ANI wysyłka floty, ANI jawnie zapisana decyzja „nie ruszam,
  // bo…", uznaje to za awarię i krzyczy: log, dziennik, powiadomienie.
  //
  // Sam flotą NIE rusza. Skoro obrona zachowała się inaczej, niż ktokolwiek
  // przewidział, to ostatnią rzeczą, jakiej chcemy, jest drugi automat
  // wysyłający flotę w nieznanym kierunku — od tego jest człowiek i przycisk
  // RATUJ. Zadaniem nadzorcy jest sprawić, żeby ten człowiek WIEDZIAŁ.
  //
  // Kontrakt działa w obie strony: każda ścieżka kończąca się „floty nie
  // ruszam" MUSI zostawić stempel przez note(). Brak stempla = awaria.
  const DefenceWatchdog = {
    KEY_DECISION: "ogamex_defence_decision",
    KEY_SINCE: "ogamex_defence_expect_since",
    KEY_ALERTED: "ogamex_defence_watchdog_alerted",
    GRACE_MS: 90 * 1000,       // wykrycie (25 s) + przełączenia stron + formularz
    REPEAT_MS: 5 * 60 * 1000,  // powtórka krzyku, dopóki nic się nie zmienia

    /** Jawna decyzja „floty nie ruszam i oto dlaczego". */
    note(why) {
      try { GM_setValue(this.KEY_DECISION, JSON.stringify({ at: Date.now(), why })); } catch {}
    },
    _decision() {
      try { return JSON.parse(GM_getValue(this.KEY_DECISION, "null")); } catch { return null; }
    },

    // CZYSTA logika werdyktu — bez DOM, sieci i zegara. Dzięki temu daje się
    // przetestować bez czekania na prawdziwy atak (test-nadzorca.js).
    verdict(s) {
      if (!s.expected) return { state: "off" };
      if (s.armed && s.saves > 0) {
        // v2.78.0: „uratowaliśmy JEDNĄ kolonię" to nie to samo, co „obrona
        // zadziałała". Bez tego warunku awaria kolejki byłaby niewidoczna:
        // straż z jednym zapisem wygląda jak sukces, choć druga kolonia
        // stoi bez reakcji. To dokładnie ta klasa błędu, co 7.08 rano.
        if ((s.unhandled || 0) > 0 && s.aliveMs >= s.graceMs) {
          return { state: "STUCK", why: `kolonie bez reakcji: ${s.unhandled}` };
        }
        return { state: "ok", why: "flota ewakuowana" };
      }
      if (s.pendingRescue) return { state: "ok", why: "ratunek w toku" };
      if (s.decisionAgeMs !== null && s.decisionAgeMs <= s.graceMs) return { state: "ok", why: "jawna decyzja" };
      if (s.aliveMs < s.graceMs) return { state: "waiting" };
      return { state: "STUCK" };
    },

    check() {
      const expected = !!(CONFIG.enabled && CONFIG.threatAlarm?.enabled
        && CONFIG.threatAlarm?.autoSave && ThreatMonitor.active());
      if (!expected) {
        // Alarm zszedł albo obrona wyłączona — zegar liczymy od nowa, żeby
        // następny alarm dostał pełne okno łaski.
        if ((parseInt(GM_getValue(this.KEY_SINCE, "0")) || 0)) {
          GM_setValue(this.KEY_SINCE, "0");
          GM_setValue(this.KEY_ALERTED, "0");
          // v2.78.0: alarm zszedł — lista obsłużonych kolonii traci sens.
          // Oczekujące POWROTY zostają: one dzieją się właśnie po alarmie.
          try { RescueQueue.endAlarm(); } catch {}
        }
        return;
      }
      let since = parseInt(GM_getValue(this.KEY_SINCE, "0")) || 0;
      if (!since) { since = Date.now(); GM_setValue(this.KEY_SINCE, String(since)); }
      const w = MoonSave.watch() || {};
      const pend = String(GM_getValue("pending_mission", null) || "");
      const pendingRescue = pend !== "" && pend !== "null"
        && /moonSave|moonReturn|moon_save|moon_ferry/i.test(pend);
      const d = this._decision();
      const v = this.verdict({
        expected: true,
        armed: !!w.armed,
        saves: w.saves || 0,
        pendingRescue,
        decisionAgeMs: d && d.at ? Date.now() - d.at : null,
        aliveMs: Date.now() - since,
        graceMs: this.GRACE_MS,
        unhandled: RescueQueue.unhandledCount(w),
      });
      if (v.state !== "STUCK") return;
      const lastAlert = parseInt(GM_getValue(this.KEY_ALERTED, "0")) || 0;
      if (Date.now() - lastAlert < this.REPEAT_MS) return;
      GM_setValue(this.KEY_ALERTED, String(Date.now()));
      const secs = Math.round((Date.now() - since) / 1000);
      const ev = ThreatMonitor.events() || {};
      const msg = /kolonie bez reakcji/.test(v.why || "")
        ? `ALARM TRWA ${secs} s. Jedna kolonia jest uratowana, ale ${(v.why.match(/\d+/) || ["?"])[0]} atakowana kolonia/e NIE ZOSTAŁA RUSZONA. `
          + `Cel: [${(ev.targets || []).join(", ") || "?"}]. SPRAWDŹ GRĘ — ratuj ręcznie przyciskiem RATUJ na tej kolonii.`
        : `ALARM TRWA ${secs} s, a flota NIE ZOSTAŁA RUSZONA i nie ma zapisanej decyzji, dlaczego. `
        + `Ataki: ${ev.attacks != null ? ev.attacks : "?"}`
        + `${ev.targets && ev.targets.length ? `, cel [${ev.targets.join(", ")}]` : ""}. `
        + `SPRAWDŹ GRĘ — jeśli flota stoi w domu, użyj przycisku RATUJ.`;
      log(`[NADZORCA] ${msg}`, "error");
      ThreatLog.add("BŁĄD", msg);
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("OGameX: OBRONA STOI — flota nieruszona!", { body: msg, tag: "ogamex-watchdog" });
        }
      } catch {}
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  AUTOTEST OBRONY (v2.77.0) — bot sprawdza sam siebie
  // ═══════════════════════════════════════════════════════════════
  // „Czy w momencie ataku bot zachowa się prawidłowo?" — na to pytanie nie
  // odpowiada czytanie kodu (dwa audyty przegapiły błąd z 07.08) ani testy
  // na kopii logiki. Odpowiada je uruchomienie PRAWDZIWEGO kodu na znanych
  // danych wejściowych.
  //
  // Autotest buduje syntetyczne wiersze wrogich flot i przepuszcza je przez
  // FleetMovements.classifyRow — tę samą funkcję, którą co 30 s karmi
  // prawdziwa lista ruchów — a potem sprawdza werdykt nadzorcy. Wszystko
  // w przeglądarce, na wgranej wersji bota, bez ruszania flotą i bez
  // czekania na napastnika.
  //
  // Czego NIE testuje: samej wysyłki floty (to robi „TEST ALARMU") oraz
  // markupu, którego gra jeszcze nam nie pokazała — dlatego wrogie wiersze
  // z prawdziwych ataków nadal lądują w logu jako [ATAK DOM].
  const DefenceSelfTest = {
    _row(cls, srcCoord, dstCoord, { moon = false, eta = 360, id = "1" } = {}) {
      return `<table><tbody><tr class="${cls}" data-fleet-id="${id}">`
        + `<td class="fleet-source-coords"><a href="#">[${srcCoord}]</a> Napastnik</td>`
        + `<td><span data-remaining-seconds="${eta}">06:00</span></td>`
        + `<td>${moon ? '<img src="/img/moon-icon.png">' : ""}<a href="#">[${dstCoord}]</a> ${moon ? "Moon" : "Planeta"}</td>`
        + `</tr></tbody></table>`;
    },
    _parse(html) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return doc.querySelector("tr");
    },

    run({ manual = false, quiet = false } = {}) {
      const fails = [];
      const ok = [];
      const check = (name, cond) => { (cond ? ok : fails).push(name); };
      const own = new Set(["3:272:7", "3:280:4"]);

      try {
        // ── A. Klasyfikacja wrogich wierszy (prawdziwy classifyRow) ──
        const A = [
          ["klasyczny atak", "row-mission-type-ATTACK row-hostile-mission", true],
          ["ACS/FEDERATION bez klasy wrogości (07.08)", "row-mission-type-FEDERATION", true],
          ["wrogi wiersz o nazwie TRANSPORT", "row-mission-type-TRANSPORT row-hostile-mission", true],
          ["nieznany typ misji = atak", "row-mission-type-NOWY_TYP_2027", true],
          ["sonda NIE jest atakiem", "row-mission-type-ESPIONAGE row-hostile-mission", false],
          ["zwykły transport NIE jest atakiem", "row-mission-type-TRANSPORT", false],
          // v2.86.2: incydent 12.08 — stacjonowanie SOJUSZNIKA (HOLD) odpaliło
          // godzinny fałszywy alarm; klasa row-friendly-mission wygrywa z nazwą.
          ["sojusznicze stacjonowanie (HOLD friendly) NIE jest atakiem", "row-mission-type-HOLD row-friendly-mission", false],
          ["sojuszniczy ACS defend (FEDERATION friendly) NIE jest atakiem", "row-mission-type-FEDERATION row-friendly-mission", false],
        ];
        for (const [name, cls, wantAttack] of A) {
          const r = FleetMovements.classifyRow(this._parse(this._row(cls, "3:248:11", "3:280:4", { moon: true })), own);
          check(`klasyfikacja: ${name}`, !!r && r.attack === wantAttack);
        }

        // ── A2. Wybór celu ratunku (v2.87.0 — CZYSTA funkcja, macierz) ──
        // Zamrożenie lekcji 13:10 na PRAWDZIWEJ funkcji, którą woła run().
        {
          const FH = { galaxy: 2, system: 277, position: 8 };
          const AP = { galaxy: 3, system: 272, position: 7 };
          const XX = { galaxy: 1, system: 1, position: 1 };
          const rrt = (o) => MoonSave.resolveRescueTarget(o);
          check("cel ratunku: jawny cel z listy wygrywa ze wszystkim",
            rrt({ where: XX, watchAt: FH, manual: false, fleetHome: FH, activePair: AP }) === XX);
          check("cel ratunku: kolonia strzeżona przed domem floty",
            rrt({ where: null, watchAt: AP, manual: false, fleetHome: FH, activePair: null }) === AP);
          check("cel ratunku: AUTOMAT bez celu → DOM FLOTY (lekcja 13:10)",
            rrt({ where: null, watchAt: null, manual: false, fleetHome: FH, activePair: AP }) === FH);
          check("cel ratunku: automat bez domu floty → aktywna para",
            rrt({ where: null, watchAt: null, manual: false, fleetHome: null, activePair: AP }) === AP);
          check("cel ratunku: ręczny RATUJ → para operatora, nie dom floty",
            rrt({ where: null, watchAt: null, manual: true, fleetHome: FH, activePair: AP }) === AP);
          check("cel ratunku: nic nie wiadomo → null (coordsOf dośle bazę)",
            rrt({ where: null, watchAt: null, manual: false, fleetHome: null, activePair: null }) === null);
        }

        // ── A3. Ucieczka w powietrze — decyzja (prawdziwe AirSave.decide) ──
        check("ucieczka: oba ciała pary pod atakiem → powietrze",
          AirSave.decide({ enabled: true, bodies: ["moon", "planet"], activePhase: null, failedAt: 0, now: Date.now() }) === "air");
        check("ucieczka: jedno ciało → zwykły ratunek",
          AirSave.decide({ enabled: true, bodies: ["moon"], activePhase: null, failedAt: 0, now: Date.now() }) === "swap");
        check("ucieczka: lot już trwa → nie dubluj",
          AirSave.decide({ enabled: true, bodies: ["moon", "planet"], activePhase: "launched", failedAt: 0, now: Date.now() }) === "active");

        // ── A4. Parser paska misji (v2.88.1 — incydent 15:24: pasek bez „Own") ──
        {
          const pb = (t) => ThreatMonitor.parseBar(t);
          const eq = (a, e) => !!a && a.total === e.total && a.own === e.own && a.foreign === e.foreign;
          check("pasek: „2 Missions: 2 Hostile\" (zero własnych) = 2 wrogów, nie ślepota",
            eq(pb("2 Missions: 2 Hostile Next: 04:15 Type: ACS Attack"), { total: 2, own: 0, foreign: 2 }));
          check("pasek: „13 Missions: 12 Own\" = 1 obcy (arytmetyka po staremu)",
            eq(pb("13 Missions: 12 Own"), { total: 13, own: 12, foreign: 1 }));
          check("pasek: „5 Missions: 3 Own, 2 Hostile\" = 2 wrogów (Hostile to twarda liczba)",
            eq(pb("5 Missions: 3 Own, 2 Hostile"), { total: 5, own: 3, foreign: 2 }));
          check("pasek: sojusznik (Friendly) nie jest wrogiem",
            eq(pb("4 Missions: 2 Own, 1 Hostile, 1 Friendly"), { total: 4, own: 2, foreign: 1 }));
          check("pasek: strona bez paska = null (ślepota ≠ czysto)",
            pb("Overview Server properties Online players: 283") === null);
          check("dom floty: wielki hangar poza polem przy małym domu = ALARM",
            (FleetRecon.homeVerdict({ map: { "2:277:8": { total: 7.5e9, max: 7.5e9 }, "5:67:9": { total: 2e11, max: 2e11 } }, homeKey: "2:277:8" }) || {}).key === "5:67:9");
          check("dom floty: księżyc minerów obok floty głównej NIE alarmuje",
            FleetRecon.homeVerdict({ map: { "5:67:9": { total: 2e11, max: 2e11 }, "3:272:7": { total: 7.5e9, max: 7.5e9 } }, homeKey: "5:67:9" }) === null);
        }

        // ── B. Odczyt celu ataku: koordy + CIAŁO (księżyc vs planeta) ──
        const rm = FleetMovements.classifyRow(this._parse(this._row("row-mission-type-ATTACK row-hostile-mission", "3:248:11", "3:280:4", { moon: true })), own);
        check("cel ataku: koordynaty [3:280:4]", rm && rm.dst === "3:280:4");
        check("cel ataku: rozpoznany KSIĘŻYC", rm && rm.dstBody === "moon");
        check("cel ataku: źródło [3:248:11]", rm && rm.src === "3:248:11");
        check("cel ataku: dolot 360 s", rm && rm.eta === 360);
        const rp = FleetMovements.classifyRow(this._parse(this._row("row-mission-type-ATTACK row-hostile-mission", "3:248:11", "3:280:4", { moon: false })), own);
        check("cel ataku: rozpoznana PLANETA", rp && rp.dstBody === "planet");

        // ── C. Własny lot nie może wyjść jako obcy ──
        const mine = FleetMovements.classifyRow(this._parse(this._row("row-mission-type-EXPEDITION", "3:272:7", "3:161:16")), own);
        check("własna ekspedycja rozpoznana jako NASZA", mine && mine.mine === true);
        const foreign = FleetMovements.classifyRow(this._parse(this._row("row-mission-type-ATTACK row-hostile-mission", "3:248:11", "3:272:7", { moon: true })), own);
        check("atak NA nas nie jest liczony jako nasz", foreign && foreign.mine === false && foreign.attack === true);

        // ── D. Nadzorca: cisza przy alarmie musi być awarią ──
        const G = DefenceWatchdog.GRACE_MS;
        const base = { expected: true, armed: false, saves: 0, pendingRescue: false, decisionAgeMs: null, aliveMs: 0, graceMs: G };
        check("nadzorca: świeży alarm = czekamy", DefenceWatchdog.verdict({ ...base, aliveMs: 1000 }).state === "waiting");
        check("nadzorca: flota ewakuowana = OK", DefenceWatchdog.verdict({ ...base, aliveMs: 5 * G, armed: true, saves: 1 }).state === "ok");
        check("nadzorca: jawna decyzja = OK", DefenceWatchdog.verdict({ ...base, aliveMs: 5 * G, decisionAgeMs: 1000 }).state === "ok");
        check("nadzorca: CISZA przy alarmie = awaria", DefenceWatchdog.verdict({ ...base, aliveMs: 5 * G }).state === "STUCK");
        check("nadzorca: straż bez ani jednego zapisu = awaria", DefenceWatchdog.verdict({ ...base, aliveMs: 5 * G, armed: true, saves: 0 }).state === "STUCK");

        // ── E. Kolejka ratunków (v2.78.0) ──
        check("kolejka: drugi atak na INNĄ kolonię trafia do ratunku",
          RescueQueue.nextTarget({ targets: ["3:272:7", "2:151:8"], guarded: "3:272:7", done: [] }) === "2:151:8");
        check("kolejka: pilnowana kolonia nie jest ratowana drugi raz",
          RescueQueue.nextTarget({ targets: ["3:272:7"], guarded: "3:272:7", done: [] }) === null);
        check("kolejka: kolonia obsłużona w tym alarmie jest pomijana",
          RescueQueue.nextTarget({ targets: ["3:272:7", "2:151:8"], guarded: "3:272:7", done: ["2:151:8"] }) === null);
        check("nadzorca: porzucona kolonia = awaria (inaczej kolejka psuje się po cichu)",
          DefenceWatchdog.verdict({ ...base, aliveMs: 5 * G, armed: true, saves: 1, unhandled: 1 }).state === "STUCK");
        check("nadzorca: komplet kolonii obsłużony = OK",
          DefenceWatchdog.verdict({ ...base, aliveMs: 5 * G, armed: true, saves: 1, unhandled: 0 }).state === "ok");
      } catch (e) {
        fails.push(`WYJĄTEK w autoteście: ${e.message}`);
      }

      const total = ok.length + fails.length;
      if (fails.length) {
        log(`[AUTOTEST] ${ok.length}/${total} OK — ${fails.length} NIEZDANYCH: ${fails.join(" | ")}`, "error");
        ThreatLog.add("BŁĄD", `AUTOTEST OBRONY NIEZDANY (${fails.length}/${total}): ${fails.join(" | ")}. Obrona może nie zadziałać — nie zostawiaj floty w domu.`);
        try {
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification("OGameX: AUTOTEST OBRONY NIEZDANY", { body: fails.join(" | "), tag: "ogamex-selftest" });
          }
        } catch {}
        return false;
      }
      if (!quiet) log(`[AUTOTEST] obrona sprawdzona: ${total}/${total} OK (klasyfikacja wrogich wierszy, odczyt celu i ciała, własne loty, nadzorca).`, "success");
      if (manual) ThreatLog.add("odczyt", `AUTOTEST OBRONY: ${total}/${total} OK — klasyfikacja, odczyt celu ataku i nadzorca działają na tej wersji bota.`);
      return true;
    },
  };

  // Własny setInterval nie da się zagłodzić: nie zależy od ticku, jitteru,
  // przerw humanizera ani okna nocnego. To jedyny sposób, żeby „obrona działa
  // 24 h" było prawdą, a nie deklaracją.
  let defenceTimer = null;
  let defenceRunning = false;
  const DEFENCE_EVERY_MS = 30 * 1000;

  // ── v2.80.0: CZUJNIK PRZERWY W OCHRONIE ──
  // 07.08, 12:11-12:23: laptop stał dwanaście minut bez ani jednego przebiegu
  // pętli obrony. Jedyny ślad to informacyjna linijka o przeładowaniu sesji —
  // czyli coś, o czym właściciel dowiedziałby się wyłącznie wtedy, gdyby sam
  // wczytał się w log. Przerwa w ochronie musi być ZDARZENIEM: wpis BŁĄD idzie
  // do dziennika, a stamtąd pushem na telefon.
  //
  // Rozróżniamy dwa przypadki, bo mają różną wagę: kilkuminutowa dziura przy
  // rzekomo działającym bocie to awaria, a wielogodzinna to po prostu
  // wyłączona przeglądarka — i budzenie kogoś o tym syreną byłoby hałasem,
  // który uczy ignorować alarmy.
  const DefenceUptime = {
    KEY: "ogamex_defence_last_tick",
    GAP_MS: 5 * 60 * 1000,        // poniżej: normalna praca (pętla co 30 s)
    OFF_MS: 3 * 60 * 60 * 1000,   // powyżej: bota po prostu nie było

    // CZYSTA klasyfikacja — bez zegara, DOM-u i sieci (test-przerwa.js).
    classify(gapMs) {
      const mins = Math.round(gapMs / 60000);
      if (gapMs < this.GAP_MS) return { level: "ok", mins };
      if (gapMs > this.OFF_MS) return { level: "off", mins };
      return { level: "gap", mins };
    },

    tick() {
      const now = Date.now();
      const last = parseInt(GM_getValue(this.KEY, "0")) || 0;
      GM_setValue(this.KEY, String(now));
      if (!last || now <= last) return null;
      const v = this.classify(now - last);
      // v2.102.0 (I-A3): dławienie timerów (karta w tle) = odstępy 45 s–5 min,
      // czyli „ok" wg klasyfikacji, a reakcja na atak 3-4× wolniejsza. Liczymy
      // 3 takie odstępy z rzędu i krzyczymy raz na 30 min.
      try {
        const gap = now - last;
        let slow = parseInt(GM_getValue("ogamex_defence_slow_ticks", "0")) || 0;
        slow = gap > 45 * 1000 && gap < this.GAP_MS ? slow + 1 : 0;
        GM_setValue("ogamex_defence_slow_ticks", String(slow));
        const said = parseInt(GM_getValue("ogamex_defence_slow_said", "0")) || 0;
        if (slow >= 3 && now - said > 30 * 60 * 1000) {
          GM_setValue("ogamex_defence_slow_said", String(now));
          log(`[OBRONA] pętla obrony chodzi co ~${Math.round(gap / 1000)} s zamiast 10-30 s — przeglądarka dławi kartę w tle. Trzymaj grę w OSOBNYM, WIDOCZNYM oknie.`, "error");
          ThreatLog.add("BŁĄD", `Karta dławiona: tick obrony co ~${Math.round(gap / 1000)} s. Reakcja na atak 3-4× wolniejsza — gra w osobnym widocznym oknie.`);
        }
      } catch {}
      if (v.level === "ok") return null;
      if (v.level === "off") {
        log(`[OBRONA] bota nie było przez ${Math.round(v.mins / 60)} h — w tym czasie nic nie pilnowało floty.`, "warn");
        ThreatLog.add("odczyt", `Bot był wyłączony przez ~${Math.round(v.mins / 60)} h (przeglądarka zamknięta). Ochrona wznowiona.`);
        return v;
      }
      const msg = `PRZERWA W OCHRONIE: przez ${v.mins} min nie było ani jednego przebiegu pętli obrony `
        + `(uśpiony laptop, zamrożona karta w tle albo zamknięta przeglądarka). Atak w tym oknie NIE zostałby wykryty. `
        + `Jeśli zostawiasz komputer, trzymaj kartę z grą na wierzchu i ustaw uśpienie na „Nigdy" przy zasilaniu sieciowym.`;
      log(`[OBRONA] ${msg}`, "error");
      ThreatLog.add("BŁĄD", msg);
      return v;
    },
  };

  let defenceRunningSince = 0;
  async function defenceTick() {
    if (defenceRunning) {                // poprzedni przebieg jeszcze trwa
      // v2.102.0 (I-A1): bezpiecznik — przebieg >45 s = zawieszony fetch/nawigacja,
      // nie „praca"; zwalniamy flagę, inaczej obrona jest martwa do przeładowania.
      if (defenceRunningSince && Date.now() - defenceRunningSince > 90 * 1000) {
        defenceRunning = false;
        log(`[OBRONA] poprzedni przebieg wisiał ${Math.round((Date.now() - defenceRunningSince) / 1000)}s — zwalniam blokadę i lecę dalej.`, "error");
        const said = parseInt(GM_getValue("ogamex_defence_latch_said", "0")) || 0;
        if (Date.now() - said > 30 * 60 * 1000) { GM_setValue("ogamex_defence_latch_said", String(Date.now())); ThreatLog.add("BŁĄD", "Tick obrony zawiesił się (>90 s) — blokada zwolniona; sprawdź sieć/serwer."); }
      } else return;
    }
    defenceRunningSince = Date.now();
    // ── v2.69.1: WIEŻA PATRZY ZAWSZE — bot OFF to tryb obserwatora ──
    // Atak 05.08 (487 mld statków) przeszedł przy przypadkowo wyłączonym
    // bocie i NIE zostawił po sobie żadnych danych: zrzuty [ATAK DOM],
    // dziennik i push żyły w pętli, którą OFF zatrzymywał. Detekcja jest
    // czysto odczytowa — nie ma powodu, żeby gasła. Przy OFF pętla dalej
    // czyta listę ruchów, pisze dziennik, zrzuca wrogie wiersze i wysyła
    // powiadomienia — ale NIE dotyka floty (aktuatory za bramką niżej;
    // każdy z nich i tak sam wymaga CONFIG.enabled).
    if (!requireLeader("defence")) return; // tylko karta-lider rusza flotą
    defenceRunning = true;
    // v2.80.0: najpierw zmierz, czy w ogóle byliśmy — dopiero potem patrz.
    // Stempel idzie w KAŻDYM ticku, także przy bocie OFF (wieża patrzy zawsze),
    // bo przerwa w obserwacji jest luką niezależnie od stanu aktuatorów.
    try { DefenceUptime.tick(); } catch {}
    try { AudioKeepalive.ensure(); } catch {}
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
      // v2.76.0: nadzorca patrzy PRZED aktuatorami — ocenia to, co (nie)
      // zrobiły poprzednie przebiegi. Dzięki temu chodzi w każdym ticku,
      // niezależnie od tego, który aktuator niżej przerwie tick swoim return.
      DefenceWatchdog.check();
      // v2.69.1: przy bocie OFF kończymy na detekcji — flota nietknięta.
      // returnHome nie sprawdza CONFIG.enabled samodzielnie, więc bramka
      // musi być tutaj, zanim cokolwiek zdąży ruszyć.
      if (!CONFIG.enabled) return;
      // v2.55.0: jeśli poprzedni tick przełączył planetę, dokończ ratunek tutaj.
      if (MoonSave.resumeAfterSwitch()) return;
      if (await MoonSave.autoSaveOnThreat().catch(() => false)) return;
      if (await MoonSave.returnHome().catch(() => false)) return;
      await MoonSave.keepPlanetEmpty().catch(() => false);

      // v2.60.0: Fleet Save żyje w pętli obrony z tego samego powodu, dla
      // którego ona istnieje: zawrócenie w środku nocy nie może zależeć od
      // schedulera, który śpi w oknie nocnym i staje na jitterze. Ratunek ma
      // pierwszeństwo — tick FS sam ustępuje przy aktywnym alarmie.
      // v2.85.0: zegar zawrócenia ucieczki w powietrze — żyje w pętli obrony
      // z tego samego powodu co FS: zawrócenie nie może zależeć od schedulera,
      // który śpi w oknie nocnym i staje na jitterze.
      await AirSave.tick().catch((e) => { log(`[UCIECZKA] błąd ticku: ${e.message}`, "error"); });
      await FleetSave.tick().catch((e) => { log(`[FS] błąd ticku: ${e.message}`, "error"); });

      // ── v2.39.0: gdy COŚ widzimy, patrz częściej ──
      // Potwierdzenie wymaga dwóch odczytów, a pętla chodzi co 30 s — więc
      // decyzja mogła zająć nawet minutę. Przy locie liczonym w minutach to
      // mieści się w normie, ale połowa okna ostrzegawczego schodziła na samo
      // czekanie na następne spojrzenie. Skoro kandydat jest, dogrywamy odczyt
      // po 10 s: potwierdzenie spada z ~60 s do ~35 s, a ruch w tle się nie
      // zmienia, bo dzieje się to tylko wtedy, gdy naprawdę coś zobaczyliśmy.
      // v2.86.0: rytm ~10 s trwa też przez 10 min PO zniknięciu kandydata —
      // wabik znika w sekundy, a właściwy atak przychodzi tuż za nim.
      // v2.86.1: to samo na 5 min po SONDZIE — skan poprzedza atak, a sonda
      // leci sekundy; kto nas ogląda, ten zaraz może uderzyć.
      const highAlertAt = parseInt(GM_getValue("ogamex_high_alert_at", "0")) || 0;
      const spyAlertAt = parseInt(GM_getValue("ogamex_spy_alert_at", "0")) || 0;
      // v2.101.0 (recenzja #8): przez CAŁY trwający alarm tick co 10 s —
      // inaczej po 10 min alarmu tempo zamiatania spadało do 30 s.
      let alarmOn = false; try { alarmOn = ThreatMonitor.active(); } catch {}
      if ((parseInt(GM_getValue(ThreatMonitor.KEY_CANDIDATE, "0")) || 0)
          || alarmOn
          || Date.now() - highAlertAt < 10 * 60 * 1000
          || Date.now() - spyAlertAt < 5 * 60 * 1000) {
        setTimeout(() => { defenceTick().catch(() => {}); }, 10 * 1000);
      }
    } catch (err) {
      log(`[RATUNEK] błąd pętli obrony: ${err.message}`, "error");
      ThreatLog.add("BŁĄD", `Pętla obrony wyrzuciła wyjątek: ${err.message}`);
    } finally {
      defenceRunning = false;
    }
  }

  // v2.77.0: autotest przy każdym starcie skryptu — świeżo wgrana wersja
  // mówi w logu, czy jej obrona w ogóle rozpoznaje atak. Zero kosztu, a
  // wyłapuje regres w klasyfikacji, zanim zrobi to napastnik.
  function runSelfTestOnBoot() {
    setTimeout(() => {
      try {
        // v2.77.2: bot przeladowuje strone co kilkanascie sekund (skan
        // galaktyki), wiec autotest przy kazdym boocie wypluwal kilkanascie
        // identycznych linii na minute i topil w nich prawdziwe wpisy obrony.
        // Sprawdzenie nadal biegnie ZAWSZE (jest darmowe) — cichnie tylko
        // raport z sukcesu: mowi po zmianie wersji i raz na 30 min.
        // Porazka krzyczy zawsze, bo to jedyny powod, dla ktorego istnieje.
        const KEY = "ogamex_selftest_last";
        const ver = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "?";
        let last = {};
        try { last = JSON.parse(GM_getValue(KEY, "{}")) || {}; } catch {}
        const quiet = last.ver === ver && last.ok === true &&
                      Date.now() - (last.at || 0) < 30 * 60 * 1000;
        const ok = DefenceSelfTest.run({ quiet });
        GM_setValue(KEY, JSON.stringify({ ver, ok, at: quiet && ok ? (last.at || Date.now()) : Date.now() }));
      } catch {}
    }, 4000);
  }

  // ═══════════════════════════════════════════════════════════════
  //  UPDATE WATCH (v2.88.1) — strażnik przestarzałej wersji
  // ═══════════════════════════════════════════════════════════════
  // INCYDENT 12.08 15:24: lekarstwo na atak z panelu Events (v2.88.0)
  // leżało na mainie od 40 minut, a bot dalej chodził na 2.87.3 —
  // Tampermonkey sprawdza aktualizacje raz na dobę. Naprawiony bug nie
  // chroni NICZEGO, dopóki nie chodzi. Ten strażnik co 30 min porównuje
  // @version z repo i krzyczy (czerwony log + dziennik z pushem), gdy
  // lokalna jest starsza. Sam niczego nie aktualizuje — od tego jest TM.
  const UpdateWatch = {
    URL: "https://raw.githubusercontent.com/Mitjano/ogamex-userscript/main/ogamex-bot.user.js",
    KEY_AT: "ogamex_updwatch_at",
    KEY_NAG: "ogamex_updwatch_nag",

    // porównanie segmentami, nie leksykalnie (2.9 < 2.88)
    newer(remote, local) {
      const pa = String(remote).split(".").map(n => parseInt(n) || 0);
      const pb = String(local).split(".").map(n => parseInt(n) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d > 0;
      }
      return false;
    },

    tick() {
      const last = parseInt(GM_getValue(this.KEY_AT, "0")) || 0;
      if (Date.now() - last < 30 * 60 * 1000) return;
      GM_setValue(this.KEY_AT, String(Date.now()));
      try {
        GM_xmlhttpRequest({
          method: "GET",
          url: this.URL + "?t=" + Date.now(),
          timeout: 20000,
          onload: (r) => {
            try {
              const m = String(r.responseText || "").match(/@version\s+([\d.]+)/);
              if (!m) return;
              const remote = m[1];
              const local = (typeof GM_info !== "undefined" && GM_info?.script?.version) || "0";
              if (!this.newer(remote, local)) return;
              log(`[UPDATE] Repo ma v${remote}, tu chodzi v${local} — poprawki obrony NIE działają na tym komputerze. Tampermonkey → Narzędzia → Sprawdź aktualizacje.`, "error");
              let nag = null; try { nag = JSON.parse(GM_getValue(this.KEY_NAG, "null")); } catch {}
              if (!nag || nag.ver !== remote || Date.now() - (nag.at || 0) > 6 * 60 * 60 * 1000) {
                GM_setValue(this.KEY_NAG, JSON.stringify({ ver: remote, at: Date.now() }));
                // dziennik sam pushuje BŁĄD na telefon (hak Notifier.fromJournal)
                ThreatLog.add("BŁĄD", `Bot PRZESTARZAŁY: repo v${remote}, lokalnie v${local}. Zaktualizuj w Tampermonkey, inaczej poprawki obrony nie chronią.`);
              }
            } catch {}
          },
        });
      } catch {}
    },
  };

  function startDefenceLoop() {
    runSelfTestOnBoot();
    if (defenceTimer) clearInterval(defenceTimer);
    defenceTimer = setInterval(() => { defenceTick().catch(() => {}); try { UpdateWatch.tick(); } catch {} }, DEFENCE_EVERY_MS);
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
          /* v2.65.3: 260px zasłaniało przyciski menu gry (Overview, Resources…)
             na 13,6-calowym ekranie właściciela. 232px kończy się przed menu. */
          width: 232px;
          background: rgba(0, 10, 30, 0.92);
          border: 1px solid #1a5276;
          border-radius: 8px;
          color: #e0e0e0;
          font-family: 'Segoe UI', Arial, sans-serif;
          font-size: 12px;
          z-index: 99999;
          box-shadow: 0 4px 20px rgba(0,0,0,0.6);
          user-select: none;
          /* v2.96.1: na 13,6-calowym MacBooku panel byl DLUZSZY niz okno,
             a position:fixed nie scrolluje sie ze strona - dol panelu
             (dziennik obrony, logi) byl nieosiagalny. Panel przewija sie sam. */
          max-height: calc(100vh - 20px);
          overflow-y: auto;
          overscroll-behavior: contain;
          scrollbar-width: thin;
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
        /* v2.65.0: pasek stanu — 5 linii odpowiada na 5 pytań bez klikania */
        #ogx-bot-panel .strip {
          padding: 7px 10px 5px;
          border-bottom: 1px solid #1a5276;
          font-size: 11px;
          line-height: 1.65;
        }
        #ogx-bot-panel .strip-row { display: flex; gap: 5px; align-items: baseline; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #ogx-bot-panel .strip-row .ico { width: 16px; flex: none; text-align: center; }
        #ogx-bot-panel .strip-row .lbl { width: 62px; flex: none; color: #8fa8b8; }
        #ogx-bot-panel .strip-row .val { color: #d7e2ea; overflow: hidden; text-overflow: ellipsis; }
        #ogx-bot-panel .strip-row .val b { color: #fff; font-weight: 600; }
        #ogx-bot-panel .strip-row.ok .val { color: #6fcf97; }
        #ogx-bot-panel .strip-row.busy .val { color: #f2b25c; }
        #ogx-bot-panel .strip-row.alert .val { color: #ff6b6b; font-weight: 700; }
        #ogx-bot-panel .strip-row.dim .val { color: #7f8c8d; }
        /* v2.65.1: sekcje = ustawienia, nie stan. Slim: 44px → ~26px na
           zwiniętą sekcję; stan pokazuje pasek na górze. */
        #ogx-bot-panel .section {
          margin-bottom: 4px;
          padding: 4px 8px;
          background: rgba(255,255,255,0.03);
          border-radius: 4px;
          border-left: 3px solid #1a5276;
        }
        #ogx-bot-panel .section.active { border-left-color: #27ae60; }
        #ogx-bot-panel .section.inactive { border-left-color: #7f8c8d; }
        #ogx-bot-panel .section-title {
          font-weight: normal;
          font-size: 11px;
          color: #b9c9d4;
          margin-bottom: 2px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        #ogx-bot-panel .section-title .mini-btn { padding: 1px 7px; font-size: 10px; }
        #ogx-bot-panel .status { font-size: 11px; color: #b7c4cd; }
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
        <span>OGameX Assistant <span style="font-size:9px;color:#7f8c8d;font-weight:normal;" title="Wersja skryptu wg Tampermonkeya — po pushu na main aktualizuje się sama (CDN ~5 min).">v${(typeof GM_info !== "undefined" && GM_info?.script?.version) || "?"}</span></span>
        <div>
          <button id="ogx-toggle" class="toggle-btn ${CONFIG.enabled ? "on" : "off"}">${CONFIG.enabled ? "ON" : "OFF"}</button>
          <span class="minimize" id="ogx-minimize">_</span>
        </div>
      </div>
      <div class="strip" id="ogx-strip">
        <div class="strip-row" id="ogx-strip-def"><span class="ico">🛡</span><span class="lbl">Obrona</span><span class="val">—</span></div>
        <div class="strip-row" id="ogx-strip-min"><span class="ico">⛏</span><span class="lbl">Mining</span><span class="val">—</span></div>
        <div class="strip-row" id="ogx-strip-exp"><span class="ico">🚀</span><span class="lbl">Ekspedycje</span><span class="val">—</span></div>
        <div class="strip-row" id="ogx-strip-fs"><span class="ico">🌙</span><span class="lbl">Fleet Save</span><span class="val">—</span></div>
        <div class="strip-row" id="ogx-strip-llm"><span class="ico">🤖</span><span class="lbl">Gemini</span><span class="val">—</span></div>
      </div>
      <div class="body" id="ogx-body">
        <div class="section ${CONFIG.asteroidMining.enabled ? "active" : "inactive"}" id="ogx-asteroid-section">
          <div class="section-title">
            <span>Ustawienia: Mining</span>
            <button class="mini-btn" id="ogx-asteroid-toggle">${CONFIG.asteroidMining.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-asteroid-status">Idle</div>
          <div class="status" id="ogx-asteroid-sizing" style="font-size:10px;color:#f39c12;margin-top:3px;">Mode: — | miners/mission: — | cargo/miner: — | est. asteroid: —</div>
          <div class="status" id="ogx-asteroid-locks" style="font-size:10px;color:#7f8c8d;margin-top:3px;" title="Which tab runs the bot + coords currently locked against re-dispatch (frees at fleet arrival, or after 1h if arrival unknown).">Tab: —</div>
          <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="KSIĘŻYC = każda rutynowa wysyłka (mining, ekspedycje, złom) startuje z księżyca bazy — falanga skanuje tylko planety, więc loty z księżyca są niewidoczne i nie da się ustawić snajperki na powrót floty (atak 05.08). Flota, minery, recyklery i deuter muszą MIESZKAĆ na księżycu — prom z planety przyciskiem RATUJ. Ratunek i FS mają własną logikę ciała.">Start wysyłek (falanga!)</span>
              <button class="mini-btn" id="ogx-base-body">${CONFIG.baseBody === "moon" ? "KSIĘŻYC" : "PLANETA"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="PROM: co 2 h automatycznie przewozi WSZYSTKO (flota, surowce, deuter minus rezerwa) z aktywnej planety na jej księżyc misją Deploy. OFF = bot NIGDY sam nie przenosi floty — przenosiny tylko ręcznie (RATUJ / Deploy). Działa wyłącznie w trybie księżycowym.">PROM planeta→księżyc</span>
              <button class="mini-btn" id="ogx-ferry-toggle">${CONFIG.moonFerry?.enabled ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Sztywny punkt startu MINERÓW, np. 3:272:7 — bot przed każdą wysyłką na asteroidę sam przełączy się na to ciało (księżyc przy trybie KSIĘŻYC). Puste = minery startują stamtąd, gdzie aktualnie jesteś. Pamiętaj: minery i deuter na paliwo muszą FIZYCZNIE stać na tym ciele.">Start minerów (g:s:p)</span>
              <input id="ogx-cfg-mining-from" type="text" placeholder="puste = tu gdzie jestem" value="${CONFIG.asteroidMining.launchFrom ? `${CONFIG.asteroidMining.launchFrom.galaxy}:${CONFIG.asteroidMining.launchFrom.system}:${CONFIG.asteroidMining.launchFrom.position}` : ""}" style="width:110px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
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
            <span>Ustawienia: Farmienie</span>
            <button class="mini-btn" id="ogx-farm-toggle">${CONFIG.inactiveFarming.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-farm-status">Idle</div>
          <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Which ship attacks inactive planets. Light Cargo / Battleship are often faster than Heavy Cargo (slot frees sooner = more attacks); Battleship survives leftover defence.">Ship type</span>
              <select id="ogx-farm-ship" style="width:120px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
                ${["LIGHT_CARGO", "HEAVY_CARGO", "BATTLESHIP"].map(s => `<option value="${s}" ${(CONFIG.inactiveFarming.shipType || "HEAVY_CARGO") === s ? "selected" : ""}>${s.replace("_", " ")}</option>`).join("")}
              </select>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Ships sent per attack on one inactive planet.">Ships / attack</span>
              <input id="ogx-farm-hc" type="number" min="1" step="1" value="${CONFIG.inactiveFarming.hcPerFlight}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="System ranges to sweep, comma-separated. Example: 3:100-200, 3:250-300. Every (i)/(I) inactive planet found is attacked; (v)/(p)/(b) skipped.">Ranges</span>
              <input id="ogx-farm-ranges" type="text" placeholder="3:100-200" value="${escapeHTML(CONFIG.inactiveFarming.ranges || "")}" style="width:120px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Sztywny punkt startu ATAKÓW, np. 3:269:8 — bot przed każdym atakiem sam przełączy się na tę parę (księżyc przy trybie KSIĘŻYC), więc można farmić inną galaktykę bez przenoszenia floty. Puste = atak startuje stamtąd, gdzie aktualnie jesteś. Statki muszą FIZYCZNIE stać na tym ciele.">Start farmienia (g:s:p)</span>
              <input id="ogx-farm-from" type="text" placeholder="puste = tu gdzie jestem" value="${CONFIG.inactiveFarming.launchFrom ? `${CONFIG.inactiveFarming.launchFrom.galaxy}:${CONFIG.inactiveFarming.launchFrom.system}:${CONFIG.inactiveFarming.launchFrom.position}` : ""}" style="width:110px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="ON = tryb sekwencyjny: każdy przebieg przemiata CAŁY zakres układ po układzie (1→koniec) i atakuje cele w kolejności napotkania — bez okrążeń po bazie i bez sortowania po łupie (wygląda przewidywalnie, ale tłuste cele nie mają pierwszeństwa). OFF = priorytet łupu (v2.97): szybkie okrążenia po znanych systemach + najtłustsze cele pierwsze — z boku wygląda jak skakanie po losowych graczach. Filtr rankingu, czarna lista i próg łupu działają w OBU trybach. Przełączenie restartuje bieżący przebieg.">Sekwencyjnie po kolei</span>
              <button class="mini-btn" id="ogx-farm-seq">${CONFIG.inactiveFarming.sequentialSweep === true ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Cel o ZNANYM srednim lupie ponizej progu jest pomijany (slot i limit atakow ida na tlustsze cele). Cele bez historii lupu atakowane normalnie — tak baza sie uczy. 0 = bez progu. Przyklad: 500000000000 = pol biliona.">Min. lup celu (0=off)</span>
              <input id="ogx-farm-minprofit" type="number" min="0" step="1000000000" value="${CONFIG.inactiveFarming.minTargetProfit || 0}" style="width:120px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Don't re-attack the same planet within this many minutes. Przy WŁĄCZONYM „Nowe okrążenie od nowa” ten zegar praktycznie nie działa — blokady i tak są zwalniane na starcie każdego przebiegu.">Target cooldown (min)</span>
              <input id="ogx-farm-cooldown" type="number" min="1" step="10" value="${CONFIG.inactiveFarming.targetCooldownMin}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Po dojściu do końca zakresu bot zwalnia WSZYSTKIE blokady i w następnym okrążeniu atakuje tych samych graczy jeszcze raz. Tempo dyktuje wtedy długość przemiatania (przy 499 systemach ok. 2 h) plus 15 min przerwy, a nie zegar cooldownu. OFF = stare zachowanie: cel zablokowany na „Target cooldown” minut niezależnie od okrążeń.">Nowe okrążenie od nowa</span>
              <button class="mini-btn" id="ogx-farm-repeat">${CONFIG.inactiveFarming.repeatEachSweep !== false ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Keep this many fleet slots unused (for mining / manual play). Limit shown on the Fleet page as 'Fleets: X/37'.">Slot reserve</span>
              <input id="ogx-farm-reserve" type="number" min="0" step="1" value="${CONFIG.inactiveFarming.slotReserve}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Atakuj TYLKO nieaktywnych z rankingiem ≤ N (ranking z tooltipa gracza w galaktyce, np. „Ranking: 2.881” = 2881). Gracze z końca rankingu mają puste kolonie — atak na nich to strata slotu i czasu lotu. 0 = bez filtra (stare zachowanie). Cel z NIEODCZYTANYM rankingiem jest atakowany normalnie, a dziennik krzyczy [FARM RANK DOM].">Max ranking celu</span>
              <input id="ogx-farm-maxrank" type="number" min="0" step="100" value="${CONFIG.inactiveFarming.maxTargetRank ?? 800}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Pełny skan zakresów odświeża BAZĘ CELÓW co tyle godzin. Pomiędzy pełnymi skanami bot krąży TYLKO po systemach ze znanymi celami w limicie rankingu — okrążenie trwa minuty zamiast godzin, więc tłuste cele obrywają dużo częściej. Statusy odświeżają się przy każdej wizycie, a wpisy niewidziane 7 dni wypadają z bazy same.">Pełny skan co (h)</span>
              <input id="ogx-farm-refresh" type="number" min="1" step="1" value="${CONFIG.inactiveFarming.dbRefreshHours ?? 12}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <button class="mini-btn" id="ogx-farm-dbdump" style="width:100%;margin-top:4px;" title="Wypisuje do dziennika całą bazę celów: koordy, gracz, ranking, kiedy widziany — posortowaną po rankingu. Nie rusza flotą.">POKAŻ BAZĘ CELÓW</button>
            <button class="mini-btn" id="ogx-farm-topdump" style="width:100%;margin-top:4px;" title="Wypisuje do dziennika TOP 15 celow wg sredniego lupu (EMA z Dziennika Grabiezy) + prog i mediane. Baza uczy sie sama: fetch dziennika co 15 min + kazde otwarcie profilu gracza.">TOP CELE (lup)</button>
            <div style="font-size:9px;color:#7f8c8d;margin-top:2px;">Pełny skan buduje bazę nieaktywnych; potem szybkie okrążenia biją tylko cele z rankingiem ≤ limitu. Mining ma pierwszeństwo — farm działa w oknach, gdy minery są w locie.</div>
          </div>
        </div>

        <div id="ogx-threat-banner" style="display:none;margin-bottom:8px;padding:8px;border-radius:4px;background:rgba(192,57,43,0.25);border:1px solid #e74c3c;color:#ff8a80;font-weight:bold;font-size:11px;line-height:1.4;"></div>

        <div class="section" id="ogx-threat-section">
          <div class="section-title">
            <span>Ustawienia: Obrona</span>
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
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Gdy podczas trwającego alarmu nadleci atak na INNĄ kolonię, bot ewakuuje również ją, nie ruszając straży pierwszej. Powroty idą po kolei. OFF = zachowanie sprzed v2.78.0 (druga kolonia bez reakcji).">Kolejka ratunków (2. kolonia)</span>
              <button class="mini-btn" id="ogx-rescue-queue">${CONFIG.threatAlarm.rescueQueue !== false ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Atak na OBA ciała jednej pary naraz (planeta + księżyc, np. Gwiazdy Śmierci „zniszcz księżyc” + atak na planetę): ewakuacja w obrębie pary nie ratuje floty, więc bot wysyła WSZYSTKO powolnym Deployem do najbliższej innej kolonii i ZAWRACA po przejściu ataków — flota w locie jest nietykalna, a zawrócenie lotu z księżyca jest niewidzialne dla falangi. OFF = zachowanie sprzed v2.85.0.">Ucieczka w powietrze (oba ciała)</span>
              <button class="mini-btn" id="ogx-air-save">${CONFIG.threatAlarm.airSave !== false ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Karta odtwarza niesłyszalny dźwięk, dzięki czemu przeglądarka nie zamraża jej ani nie dławi liczników, gdy jest w tle. NIE powstrzyma uśpienia systemu ani zamknięcia klapy — to ustaw w zasilaniu Windows („Uśpienie: Nigdy” przy zasilaniu sieciowym). Skutek uboczny: ikonka głośnika na karcie.">Nie pozwól zamrozić karty</span>
              <button class="mini-btn" id="ogx-keep-awake">${CONFIG.threatAlarm.keepAwake !== false ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Tyle deuteru ZOSTAJE na ciele przy ratunku i Fleet Save — paliwo dla floty, która wróci później (np. z ekspedycji) i sama będzie musiała uciekać. 0 = zabieraj wszystko.">Rezerwa deuteru</span>
              <input id="ogx-deut-reserve" type="number" min="0" step="100000000" value="${CONFIG.threatAlarm.deutReserve ?? 100000000000}" style="width:110px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <button class="mini-btn" id="ogx-moonback-now" style="width:100%;margin-top:4px;background:#1a5276;border-color:#2e86c1;color:#fff;" title="Ściąga flotę i surowce z ciała, na które uciekły, z powrotem na to, z którego wystartowały. Potrzebne po ręcznym ratunku — takich bot sam nie cofa.">WRÓĆ NA BAZĘ</button>
            <button class="mini-btn" id="ogx-selftest" style="width:100%;margin-top:4px;" title="Przepuszcza syntetyczne wrogie wiersze przez PRAWDZIWĄ klasyfikację bota (tę samą, którą karmi lista ruchów flot) i sprawdza werdykt nadzorcy. Nie rusza flotą, nie kosztuje nic, trwa ułamek sekundy. Odpowiada na pytanie „czy ta wersja bota rozpozna atak", bez czekania na napastnika.">AUTOTEST OBRONY (bez ruszania flotą)</button>
            <button class="mini-btn" id="ogx-threat-sim" style="width:100%;margin-top:4px;" title="Przepuszcza SYNTETYCZNY atak na bazę przez prawdziwą maszynerię obrony: kandydat → potwierdzenie ~25-35 s → EWAKUACJA całej floty i surowców na drugie ciało → po ~2 min alarm gaśnie i flota wraca automatycznie. Koszt: kilka minut miningu i dwa krótkie przeloty. To jest pełna próba generalna automatu bez czekania na wroga.">TEST ALARMU (symulacja ataku)</button>
            <button class="mini-btn" id="ogx-threat-sim-blind" style="width:100%;margin-top:4px;" title="Odtwarza DOKŁADNIE scenariusz ataku z 12.08 13:10: lista ruchów i zdarzenia serwera czyste, tylko pasek misji widzi +1 obcą flotę (tak wyglądają ataki z Twojego własnego układu). Sprawdza całą ślepą ścieżkę: cache paska → kandydat → potwierdzenie → ratunek do DOMU FLOTY → straż → powrót.">TEST ŚLEPEGO PASKA (atak z układu)</button>
            <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
              <label style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#bbb;">
                <span title="Push na telefon przez ntfy.sh przy ataku, ewakuacji, błędzie obrony i powrocie. Zainstaluj apkę ntfy (Google Play / App Store), dodaj subskrypcję tematu widocznego niżej — i tyle. Temat o losowej nazwie działa jak hasło: nie udostępniaj go.">Push na telefon (ntfy)</span>
                <button class="mini-btn" id="ogx-ntfy-toggle">—</button>
              </label>
              <div class="status" id="ogx-ntfy-topic" style="font-size:9px;user-select:text;cursor:pointer;" title="Kliknij, żeby skopiować nazwę tematu do schowka.">—</div>
              <button class="mini-btn" id="ogx-ntfy-topic-set" style="width:100%;margin-top:3px;" title="Temat ntfy jest losowany OSOBNO na każdym komputerze i przeglądarce (siedzi w pamięci Tampermonkey, która się nie synchronizuje). Dwa komputery = dwa różne tematy, a telefon słucha tylko jednego — dlatego z drugiego kompa powiadomienia nie przychodziły. Wklej tutaj temat z tego komputera, na którym push DZIAŁA, żeby oba wysyłały w to samo miejsce.">Ten sam temat na 2. komputerze</button>
              <label style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#bbb;margin-top:3px;">
                <span title="Przy ATAKU laptop mówi na głos „Uwaga! Atak na bazę!" (syntezator systemowy przez przeglądarkę). Działa, póki karta z grą żyje i dźwięk w systemie nie jest wyciszony.">Alarm głosowy (laptop)</span>
                <button class="mini-btn" id="ogx-voice-toggle">—</button>
              </label>
              <button class="mini-btn" id="ogx-ntfy-test" style="width:100%;margin-top:3px;" title="Wysyła próbne powiadomienie na temat ntfy i odtwarza próbny alarm głosowy. Jeśli telefon nie zawibruje w kilka sekund — sprawdź subskrypcję w apce.">Wyślij testowe powiadomienie</button>
            </div>
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

        <div class="section ${CONFIG.fleetSave?.enabled ? "active" : "inactive"}" id="ogx-fs-section">
          <div class="section-title">
            <span>Ustawienia: Fleet Save</span>
            <button class="mini-btn" id="ogx-fs-toggle">${CONFIG.fleetSave?.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-fs-status">—</div>
          <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="O tej godzinie flota ma być z powrotem na bazowym księżycu. Samo HH:MM znaczy NAJBLIŻSZE takie wskazanie zegara — ustawione raz, działa co dobę.">Powrót o (HH:MM)</span>
              <input id="ogx-fs-return" type="text" placeholder="09:00" value="${String(CONFIG.fleetSave?.returnAt || "").match(/^\d{1,2}:\d{2}$/) ? CONFIG.fleetSave.returnAt : ""}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Księżyc docelowy (g:s:p). Wysyłka zawsze Z bazowego księżyca. Dalszy cel = dłuższy lot = dłuższy możliwy FS.">Cel (księżyc g:s:p)</span>
              <input id="ogx-fs-target" type="text" value="${CONFIG.fleetSave?.to ? `${CONFIG.fleetSave.to.galaxy}:${CONFIG.fleetSave.to.system}:${CONFIG.fleetSave.to.position}` : ""}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Prędkość lotu w %. Wolniej = dłuższy lot = dłuższy możliwy FS (przy 10% lot trwa 10× dłużej). Maksymalny FS = 2× czas lotu w jedną stronę.">Prędkość (%)</span>
              <input id="ogx-fs-speed" type="number" min="1" max="100" step="1" value="${CONFIG.fleetSave?.speedPercent || 10}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <button class="mini-btn" id="ogx-fs-measure" style="width:100%;margin-top:4px;" title="Wchodzi w formularz wysyłki, ustawia prędkość, odczytuje czas lotu pokazany przez grę i WYCHODZI BEZ WYSYŁKI. Od tego momentu planer zna trasę i sam wyliczy godzinę startu.">Zmierz trasę (bez wysyłki)</button>
          </div>
          <div style="font-size:9px;color:#7f8c8d;margin-top:2px;">Z bazowego księżyca na inny księżyc, misja Stacjonuj, start OD RAZU (za długie okno = łańcuch pełnych rund). Statki: wszystko; minery zostają tylko przy WŁĄCZONYM miningu. Surowce z księżyca minus rezerwa deuteru. Zawracanie nieudane = flota zostaje bezpieczna na celu.</div>
        </div>

        <div class="section ${CONFIG.expeditions.enabled ? "active" : "inactive"}" id="ogx-expo-section">
          <div class="section-title">
            <span>Ustawienia: Ekspedycje</span>
            <button class="mini-btn" id="ogx-expo-toggle">${CONFIG.expeditions.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-expo-status">Idle</div>
          <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Sztywny punkt startu EKSPEDYCJI, np. 2:277:8 — bot przed każdą falą sam przełączy się na to ciało (księżyc przy trybie KSIĘŻYC), a fale lecą na poz. 16 JEGO systemu i tam wracają. Puste = fale startują stamtąd, gdzie aktualnie jesteś.">Start ekspedycji (g:s:p)</span>
              <input id="ogx-expo-from" type="text" placeholder="puste = tu gdzie jestem" value="${CONFIG.expeditions.launchFrom ? `${CONFIG.expeditions.launchFrom.galaxy}:${CONFIG.expeditions.launchFrom.system}:${CONFIG.expeditions.launchFrom.position}` : ""}" style="width:110px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Na tyle fal dzielona jest flota bojowa. Masz po 8 sztuk każdego typu → 8 fal po 1 sztuce. Nigdy więcej niż slotów ekspedycyjnych.">Fale (podział floty)</span>
              <input id="ogx-expo-waves" type="number" min="1" step="1" value="${CONFIG.expeditions.waves}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Czas postoju w kosmosie („Expedition duration" na stronie wysyłki).">Długość ekspedycji (h)</span>
              <input id="ogx-expo-hours" type="number" min="1" max="24" step="1" value="${CONFIG.expeditions.holdingHours}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Klasa ODKRYWCA: ekspedycje 40-minutowe (zamiast min. 1 h). ON = bot wybiera „40 min" w formularzu; gdy tej opcji nie ma (inna klasa), ostrzega i wysyła na tyle godzin, ile wyżej.">Odkrywca: ekspedycje 40 min</span>
              <button class="mini-btn" id="ogx-expo-disc40">${CONFIG.expeditions.discoverer40 ? "ON" : "OFF"}</button>
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
            <span>Ustawienia: Bonus</span>
            <button class="mini-btn" id="ogx-bonus-toggle">${CONFIG.onlineBonus.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-bonus-status">—</div>
          <div style="font-size:9px;color:#7f8c8d;margin-top:2px;">Klika zielony „Online bonus" w menu, gdy się pojawi → antymateria + punkty Academy. Działa razem z mining/farming.</div>
        </div>

        <div class="section">
          <div class="section-title">
            <span>Anty-detekcja</span>
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
              <span title="10% szans na 5–15 min bezczynności w środku pracy — symuluje gracza, który odszedł od klawiatury. OFF = zero losowych pauz.">Pauzy losowe (jitter)</span>
              <button class="mini-btn" id="ogx-jitter-toggle">${CONFIG.antiDetection.jitterEnabled ? "ON" : "OFF"}</button>
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
            <span>Szybkie akcje</span>
          </div>
          <button class="mini-btn" id="ogx-scan-now">Scan Asteroids</button>
          <button class="mini-btn" id="ogx-bonus-now" title="Sprawdź TERAZ, czy na stronie jest przycisk Online bonus, i kliknij go (ignoruje cooldown).">Claim Bonus</button>
          <button class="mini-btn" id="ogx-api-test" title="Odpytuje po kolei endpointy gry (eventbox, eventlist, galaxy, check-target, messages) i wypisuje do logu status HTTP oraz początek odpowiedzi. Od tego zależy, czy szybki skan i wysyłka przez API mogą działać.">Test API</button>
          <button class="mini-btn" id="ogx-fleet-recon" title="Wypisz do logu, co bot widzi na stronie floty: typy statków (data-ship-type), zapisane grupy flot, sloty flot i ekspedycji. Na stronie /fleet skanuje na świeżo, gdzie indziej pokazuje ostatni zapis.">Fleet Recon</button>
          <button class="mini-btn" id="ogx-gate-jump" title="Skok BRAMĄ: cała flota (+surowce) z AKTYWNEGO księżyca na inny księżyc z bramą — bez lotu. Ten sam mechanizm bot używa automatycznie przy ataku na księżyc. Shift+klik = POWRÓT bramą na księżyc domowy.">Skok bramą</button>
          <button class="mini-btn" id="ogx-moon-form" title="Utwórz księżyc wokół AKTYWNEJ planety (strona Moon Creation, koszt w metalu; średnica z konfiguracji, schodzi w dół, gdy brakuje metalu). Bot robi to też sam po zniszczeniu księżyca bazy.">Utwórz księżyc (tu)</button>
          <button class="mini-btn" id="ogx-flights" title="Pokazuje rejestr własnych lotów górniczych (to on wyznacza budżet równoległych wysyłek) i porównuje go z liczbą misji, którą widzi gra. Shift+klik czyści rejestr awaryjnie, gdy budżet stoi mimo pustego nieba.">Loty</button>
        
          <label style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:10px;color:#bbb;" title="Klucz API Google AI Studio (aistudio.google.com/apikey). Model czyta TYLKO raporty z misji (urobek z asteroid) tam, gdzie zwykłe parsery nie rozumieją formatu strony. Nigdy nie podejmuje decyzji o flocie. Klucz zostaje lokalnie w Tampermonkey.">
            <span>Gemini API</span>
            <input id="ogx-llm-key" type="password" placeholder="klucz AIza…/AQ…" value="" style="width:130px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
          </label>
          <div class="status" id="ogx-llm-status" style="font-size:9px;margin-top:2px;"></div>
        </div>


        <div id="ogx-log-pinned" class="log-pinned" style="display:none;"></div>
        <!-- v2.65.2: log domyślnie zwinięty do 1 linii; klik na nagłówek
             rozwija pełną listę. Przypięty log alarmowy wyżej rządzi się sam
             (pokazuje się tylko, gdy ma treść). -->
        <div id="ogx-log-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px; cursor:pointer;">
          <span style="font-size:11px; color:#8fa8b8;"><span id="ogx-log-chev">▸</span> Log</span>
          <div style="display:flex;gap:4px;">
            <button class="mini-btn" id="ogx-copy-logs" style="font-size:10px;">Copy</button>
            <button class="mini-btn" id="ogx-clear-logs" style="font-size:10px;">Clear</button>
          </div>
        </div>
        <div id="ogx-log-last" style="font-size:10px;font-family:monospace;color:#9fb2bf;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 2px;">—</div>
        <div class="log-area" id="ogx-log" style="display:none;"></div>
        <textarea id="ogx-log-textarea" style="width:100%;height:120px;font-size:9px;font-family:monospace;background:rgba(0,0,0,0.5);color:#aaa;border:1px solid #333;border-radius:4px;padding:4px;margin-top:4px;resize:vertical;display:none;box-sizing:border-box;" readonly placeholder="Kliknij Copy żeby załadować logi..."></textarea>
      </div>
    `;

    document.body.appendChild(panel);

    // Make draggable
    makeDraggable(panel, panel.querySelector(".header"));

    // Event handlers
    document.getElementById("ogx-toggle").addEventListener("click", () => {
      // v2.69.1: wyłączanie przy widocznych OBCYCH flotach wymaga potwierdzenia
      // — 05.08 atak przeszedł przy przypadkowo wyłączonym bocie.
      if (CONFIG.enabled) {
        const ev = ThreatMonitor.events();
        const bar = ThreatMonitor.read();
        const foreignNow = Math.max(ev && Date.now() - ev.at < 120000 ? (ev.hostile || 0) : 0, bar ? bar.foreign : 0);
        if (foreignNow > 0 && !window.confirm(`UWAGA: w powietrzu są ${foreignNow} obce floty!\n\nWyłączenie bota zatrzyma AUTOMATYCZNĄ OBRONĘ (ewakuację floty). Detekcja i dziennik będą dalej działać, ale flotą nikt nie ruszy.\n\nNa pewno wyłączyć?`)) return;
      }
      CONFIG.enabled = !CONFIG.enabled;
      saveConfig(CONFIG);
      const btn = document.getElementById("ogx-toggle");
      btn.textContent = CONFIG.enabled ? "ON" : "OFF";
      btn.className = `toggle-btn ${CONFIG.enabled ? "on" : "off"}`;
      if (CONFIG.enabled) {
        startScheduler();
        startDefenceLoop();
        WakeLock.acquire();
        log("Bot ENABLED", "success");
      } else {
        stopScheduler();
        // v2.69.1: pętla obrony NIE gaśnie — przechodzi w tryb obserwatora
        // (detekcja, dziennik, zrzuty [ATAK DOM], push; zero ruszania flotą).
        WakeLock.release();
        log("Bot DISABLED — obrona przechodzi w TRYB OBSERWATORA: wykrywa i alarmuje, ale flotą nie rusza.", "warn");
      }
    });

    // v2.90.0 (było either/or od v2.11.0): oba moduły mogą działać naraz —
    // repaint obu przycisków i sekcji po każdym przełączeniu.
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

    // v2.90.0: koniec either/or — oba moduły mogą być ON naraz. Mining ma
    // pierwszeństwo; farm dostaje wyłącznie okna, gdy minery są w locie.
    document.getElementById("ogx-asteroid-toggle").addEventListener("click", () => {
      CONFIG.asteroidMining.enabled = !CONFIG.asteroidMining.enabled;
      saveConfig(CONFIG);
      paintModuleToggles();
      log(`Asteroid mining ${CONFIG.asteroidMining.enabled ? "enabled" : "disabled"}`, "info");
      // v2.104.1: wyłączenie miningu kasuje trwający skan — inaczej zostaje „widmo"
      // (kolejka układów), które ciągnie nawigację po ekspedycjach i po odblokowaniu.
      if (!CONFIG.asteroidMining.enabled) { try { if (ScanState.load()?.active) { ScanState.clear(); log("Skan asteroid przerwany razem z wyłączeniem miningu — po włączeniu zacznie od nowa.", "info"); } } catch {} }
      if (CONFIG.asteroidMining.enabled && CONFIG.inactiveFarming.enabled) {
        log("Mining + farming razem: asteroidy mają PIERWSZEŃSTWO, farm wypełnia okna między lotami minerów.", "info");
      }
      updateStatusUI();
    });

    document.getElementById("ogx-farm-toggle").addEventListener("click", () => {
      CONFIG.inactiveFarming.enabled = !CONFIG.inactiveFarming.enabled;
      saveConfig(CONFIG);
      paintModuleToggles();
      log(`Inactive farming ${CONFIG.inactiveFarming.enabled ? "enabled" : "disabled"}`, "info");
      if (CONFIG.asteroidMining.enabled && CONFIG.inactiveFarming.enabled) {
        log("Mining + farming razem: asteroidy mają PIERWSZEŃSTWO, farm wypełnia okna między lotami minerów.", "info");
      }
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
      bindThreatToggle("ogx-rescue-queue", "rescueQueue", "Kolejka ratunków (2. kolonia)");
      bindThreatToggle("ogx-air-save", "airSave", "Ucieczka w powietrze (oba ciała)"); // v2.85.0
      bindThreatToggle("ogx-keep-awake", "keepAwake", "Nie pozwól zamrozić karty");
      // v2.74.0: rezerwa deuteru (paliwo dla floty wracającej z ekspedycji)
      {
        const el = document.getElementById("ogx-deut-reserve");
        if (el) el.addEventListener("change", () => {
          const v = Math.max(0, parseInt(el.value) || 0);
          el.value = v;
          CONFIG.threatAlarm.deutReserve = v;
          saveConfig(CONFIG);
          log(`Rezerwa deuteru: ${v.toLocaleString()} (zostaje na ciele przy ratunku/FS).`, "info");
        });
      }

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

      // v2.104.0 (audyt): JEDNA blokada startu dla obu symulacji. Każdy warunek
      // = stan, w którym syntetyczny atak zrobiłby coś prawdziwą flotą lub test
      // byłby głuchy (21:23 „drugi atak"→kolejka; AirSave `recalled` → ratunek
      // wstrzymany; stare wpisy kolejki → obcy powrót).
      function simBlockReason() {
        try {
          const now = Date.now();
          const simUntil = parseInt(GM_getValue("ogamex_threat_sim_until", "0")) || 0;
          const blindUntil = parseInt(GM_getValue("ogamex_threat_sim_blind_until", "0")) || 0;
          if (simUntil > now || blindUntil > now) return `symulacja trwa do ${new Date(Math.max(simUntil, blindUntil)).toLocaleTimeString("pl-PL")} — poczekaj`;
          if (ThreatMonitor.active()) return "alarm aktywny — poczekaj na „czysto”";
          const w = MoonSave.watch(); if (w.armed) return "STRAŻ UZBROJONA po poprzednim alarmie — kliknij „WRÓĆ NA BAZĘ” i poczekaj na „czysto”";
          const a = AirSave.state(); if (a && a.phase) return `ucieczka w powietrze w fazie „${a.phase}” — poczekaj na lądowanie floty`;
          const p = GM_getValue("pending_mission", null); if (p && p !== "null") { try { const pm = JSON.parse(p); if (pm && (pm.moonSave || pm.fleetSave || pm.airSave)) return `trwa zadanie obrony (${pm.type}) — poczekaj`; } catch {} }
          if (GM_getValue(MoonSave.KEY_SWITCH, "null") !== "null") return "przełączanie kolonii w toku — poczekaj";
        } catch (e) { return `błąd sprawdzenia stanu: ${e.message}`; }
        return null;
      }
      // stare wpisy kolejki przed testem — osobno od „powodu blokady" (recenzja D1)
      function simClearQueue() {
        try { const q = RescueQueue.state(); if ((q.pending || []).length) { RescueQueue.save({ done: q.done || [], pending: [] }); log(`[TEST] wyczyściłem ${q.pending.length} stary(ch) wpis(ów) kolejki ratunków przed symulacją.`, "warn"); } } catch {}
      }
      // v2.67.0: próba generalna automatu obrony — patrz tooltip przycisku.
      const simBtn = document.getElementById("ogx-threat-sim");
      if (simBtn) simBtn.addEventListener("click", () => {
        if (!CONFIG.enabled || !CONFIG.threatAlarm?.enabled) { log("[TEST] najpierw włącz bota i alarm obcej floty.", "error"); return; }
        // v2.104.0: wspólna blokada obu symulacji (simBlockReason).
        { const why = simBlockReason(); if (why) { log(`[TEST] nie startuję: ${why}.`, "error"); window.alert(`Symulacja nie ruszyła:\n${why}.`); return; } }
        simClearQueue();
        // v2.103.1: cel = para aktywnego ciała (tam, gdzie stoi flota), nie baza z configu.
        const here = HomeBase.coords();
        const simTarget = (here && Number.isFinite(here.galaxy) && Number.isFinite(here.position)) ? { galaxy: here.galaxy, system: here.system, position: here.position } : null;
        const simKey = simTarget ? `[${simTarget.galaxy}:${simTarget.system}:${simTarget.position}]` : "bazę z konfiguracji";
        if (!window.confirm(
          `SYMULACJA ATAKU na ${simKey} (aktywne ciało — stań tam, gdzie stoi flota)?\n\n` +
          "Przez 90 s obrona będzie widzieć 1 wrogi atak i przejdzie PEŁNĄ ścieżkę naprawdę:\n" +
          "• potwierdzenie ~25-35 s,\n" +
          "• EWAKUACJA całej floty i surowców na drugie ciało (planeta ↔ księżyc),\n" +
          "• po ~2 min alarm gaśnie i flota wraca automatycznie.\n\n" +
          "Koszt: kilka minut miningu i dwa krótkie przeloty. Kontynuować?")) return;
        // v2.102.0: tryb symulacji + pomiar E2E (od startu do wysyłki ratunku).
        const modeIn = String(window.prompt("Tryb symulacji: moon (atak na księżyc, 150 s) / planet / both (oba ciała → ucieczka w powietrze)", "moon") || "moon").trim().toLowerCase();
        const mode = ["moon", "planet", "both"].includes(modeIn) ? modeIn : "moon";
        GM_setValue("ogamex_threat_sim_mode", mode);
        GM_setValue("ogamex_threat_sim_target", simTarget ? JSON.stringify(simTarget) : "null");
        GM_setValue("ogamex_threat_sim_started", String(Date.now()));
        GM_setValue("ogamex_threat_sim_e2e_said", "");
        GM_setValue("ogamex_threat_sim_until", String(Date.now() + (mode === "both" ? 330 : 180) * 1000));
        log(`[TEST] SYMULACJA ATAKU uruchomiona (tryb ${mode}, cel ${simKey}) — wiersz wroga idzie przez PRAWDZIWY parser listy ruchów. Zmierzę czas od startu do wysyłki ratunku.`, "error");
        log("[TEST] SYMULACJA ATAKU uruchomiona. Obserwuj sekwencję: kandydat → ALARM → RATUNEK → koniec alarmu → POWRÓT. Wszystko poniżej to prawdziwa maszyneria obrony.", "error");
        ThreatLog.add("odczyt", `TEST: symulacja ataku uruchomiona przez operatora (tryb ${mode}).`);
      });

      // v2.87.0: symulacja ślepego paska — E2E ścieżki, która zawiodła 13:10.
      const simBlindBtn = document.getElementById("ogx-threat-sim-blind");
      if (simBlindBtn) simBlindBtn.addEventListener("click", () => {
        if (!CONFIG.enabled || !CONFIG.threatAlarm?.enabled) { log("[TEST] najpierw włącz bota i alarm obcej floty.", "error"); return; }
        { const why = simBlockReason(); if (why) { log(`[TEST] nie startuję: ${why}.`, "error"); window.alert(`Symulacja nie ruszyła:\n${why}.`); return; } }   // v2.104.0
        simClearQueue();
        if (!window.confirm(
          "SYMULACJA ŚLEPEGO PASKA (scenariusz ataku z 13:10)?\n\n" +
          "Lista ruchów i zdarzenia serwera zostają CZYSTE — tylko pasek misji dostaje syntetyczną +1 obcą flotę, dokładnie jak przy atakach z Twojego układu.\n" +
          "Oczekiwana sekwencja:\n" +
          "• PASEK: 1 obcych, lista tylko 0 — traktuję jak ATAK,\n" +
          "• kandydat → potwierdzenie ~25-35 s,\n" +
          "• RATUNEK do DOMU FLOTY (przełączenie kolonii + skok planeta↔księżyc),\n" +
          "• po ~2 min alarm gaśnie i flota wraca.\n\n" +
          "UWAGA: przez 90 s symulacji prawdziwy odczyt paska jest podmieniony — nie odpalaj przy realnym dolocie. Kontynuować?")) return;
        GM_setValue("ogamex_threat_sim_blind_until", String(Date.now() + 90 * 1000));
        log("[TEST] SYMULACJA ŚLEPEGO PASKA uruchomiona (90 s) — to jest dokładnie ścieżka, która zawiodła 12.08 13:10. Obserwuj: PASEK>lista → kandydat → ALARM → RATUNEK do domu floty → POWRÓT.", "error");
        ThreatLog.add("odczyt", "TEST: symulacja ślepego paska uruchomiona przez operatora (90 s).");
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
      {
        const dBtn = document.getElementById("ogx-expo-disc40");
        if (dBtn) dBtn.addEventListener("click", () => {
          CONFIG.expeditions.discoverer40 = !CONFIG.expeditions.discoverer40;
          saveConfig(CONFIG);
          dBtn.textContent = CONFIG.expeditions.discoverer40 ? "ON" : "OFF";
          void 0;
          log(`[ODKRYWCA] ekspedycje 40 min: ${CONFIG.expeditions.discoverer40 ? "ON — wymaga klasy Odkrywca w Academy" : "OFF"}`, "info");
        });
      }
      bindExpo("ogx-expo-gapmin", "waveGapMinSec", "Wave gap min (s)", { min: 10 });
      bindExpo("ogx-expo-gapmax", "waveGapMaxSec", "Wave gap max (s)", { min: 10 });
      bindExpo("ogx-expo-hc", "heavyCargoPerWave", "Heavy Cargo per wave", { min: 0 });
      bindExpo("ogx-expo-reserve", "slotReserve", "Expedition slot reserve", { min: 0 });
    }

    // v2.60.0: Fleet Save controls
    {
      const fsBtn = document.getElementById("ogx-fs-toggle");
      if (fsBtn) fsBtn.addEventListener("click", () => {
        // ── v2.68.3: włączenie FS wymaga potwierdzenia Z PLANEM ──
        // Incydent 05.08 09:32: omyłkowo włączony toggle + zapisana godzina
        // i zmierzona trasa = w pełni automatyczny start CAŁEJ floty dwie
        // minuty później. FS ma startować sam w nocy — więc jedyne właściwe
        // miejsce na człowieka to moment włączania, z jasną zapowiedzią,
        // KIEDY nastąpi start. Wyłączanie zostaje bez pytań (ma być szybkie).
        if (!CONFIG.fleetSave.enabled) {
          const p = FleetSave.plan(Date.now(), { ignoreEnabled: true });
          const f = (ms) => new Date(ms).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
          const kiedy = p.ok
            ? `Okno pasuje JUŻ TERAZ — start nastąpi w ciągu ~1 min:\n  start ${f(p.launchAt)} → zawrócenie ${f(p.recallAt)} → powrót ${f(p.returnAt)}.`
            : p.launchDueAt
              ? `Najbliższy automatyczny start: ok. ${f(p.launchDueAt)}.`
              : `Start wstrzymany: ${p.why}`;
          if (!window.confirm(`Włączyć Fleet Save?\n\n${kiedy}\n\nBot wyśle CAŁĄ flotę (poza minerami) + surowce z księżyca, bez dalszych pytań.`)) return;
        }
        CONFIG.fleetSave.enabled = !CONFIG.fleetSave.enabled;
        saveConfig(CONFIG);
        fsBtn.textContent = CONFIG.fleetSave.enabled ? "ON" : "OFF";
        const sec = document.getElementById("ogx-fs-section");
        if (sec) sec.className = `section ${CONFIG.fleetSave.enabled ? "active" : "inactive"}`;
        if (CONFIG.fleetSave.enabled && !FleetSave.flightMs()) {
          log("[FS] włączony, ale trasa niezmierzona — kliknij „Zmierz trasę (bez wysyłki)”, żeby planer poznał czas lotu.", "warn");
        }
        log(`Fleet Save ${CONFIG.fleetSave.enabled ? "włączony" : "wyłączony"}`, "info");
        updateStatusUI();
      });
      const fsReturn = document.getElementById("ogx-fs-return");
      if (fsReturn) fsReturn.addEventListener("change", () => {
        const v = fsReturn.value.trim();
        if (v && !/^\d{1,2}:\d{2}$/.test(v)) { log(`[FS] „${v}" to nie godzina — podaj HH:MM, np. 09:00.`, "error"); return; }
        CONFIG.fleetSave.returnAt = v || null;
        saveConfig(CONFIG);
        log(v ? `[FS] powrót ustawiony na najbliższe ${v}.` : "[FS] godzina powrotu wyczyszczona.", "info");
        updateStatusUI();
      });
      const fsTarget = document.getElementById("ogx-fs-target");
      if (fsTarget) fsTarget.addEventListener("change", () => {
        const m = fsTarget.value.trim().match(/^(\d+):(\d+):(\d+)$/);
        if (!m) { log(`[FS] „${fsTarget.value}" to nie koordynaty — podaj g:s:p, np. 3:269:5.`, "error"); return; }
        CONFIG.fleetSave.to = { galaxy: +m[1], system: +m[2], position: +m[3] };
        saveConfig(CONFIG);
        log(`[FS] cel: księżyc [${m[1]}:${m[2]}:${m[3]}]. Trasę trzeba zmierzyć od nowa (inna odległość = inny czas lotu).`, "info");
        updateStatusUI();
      });
      const fsSpeed = document.getElementById("ogx-fs-speed");
      if (fsSpeed) fsSpeed.addEventListener("change", () => {
        const v = Math.max(1, Math.min(100, parseInt(fsSpeed.value) || 10)); // v2.74.1: 3%/5% dozwolone (dłuższy lot = dłuższy FS)
        fsSpeed.value = v;
        CONFIG.fleetSave.speedPercent = v;
        saveConfig(CONFIG);
        log(`[FS] prędkość ${v}%. Trasę trzeba zmierzyć od nowa (inna prędkość = inny czas lotu).`, "info");
        updateStatusUI();
      });
      const fsMeasure = document.getElementById("ogx-fs-measure");
      if (fsMeasure) fsMeasure.addEventListener("click", () => {
        if (!window.confirm("Zmierzyć trasę FS? Bot wejdzie w formularz wysyłki, ustawi prędkość, odczyta czas lotu i WYJDZIE BEZ WYSYŁKI. Żadna flota nie poleci.")) return;
        GM_setValue("ogamex_fs_measure_at", String(Date.now()));
        FleetSave.launch({ measure: true });
        // v2.62.1: nie czekaj na tick schedulera (50-90 s) — klik ma działać od
        // razu. Gdy ta karta nie jest liderem, handlePendingMission sam powie
        // „PAUSED — another tab is running the bot", co też jest odpowiedzią.
        _lastHandleAt = 0; setTimeout(() => { handlePendingMission().catch(() => {}); }, 1200);
      });
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
      // v2.67.0: powiadomienia ntfy — temat, przełącznik, test
      {
        const nBtn = document.getElementById("ogx-ntfy-toggle");
        const nTopic = document.getElementById("ogx-ntfy-topic");
        const nSet = document.getElementById("ogx-ntfy-topic-set");
        if (nSet) nSet.addEventListener("click", () => {
          // ── v2.77.0: jeden temat na wszystkie maszyny ──
          // Temat losował się per komputer i per przeglądarka (GM storage nie
          // synchronizuje się między maszynami), więc laptop w pracy pisał na
          // temat, którego telefon nie subskrybuje — push „działał" i szedł
          // w próżnię. Objaw: w domu powiadomienia są, w pracy ich nie ma.
          const cur = Notifier.topic();
          const v = prompt(
            "Temat ntfy dla TEGO komputera.\n\n" +
            "Wklej temat z komputera, na ktorym powiadomienia DZIALAJA — wtedy oba\n" +
            "wysylaja w to samo miejsce i telefon dostaje wszystko z obu maszyn.\n" +
            "Temat dziala jak haslo: nie udostepniaj go nikomu.",
            cur);
          if (v === null) return;
          const t = String(v).trim().replace(/^https?:\/\/ntfy\.sh\//i, "").replace(/\/+$/, "");
          if (!/^[A-Za-z0-9_-]{4,64}$/.test(t)) {
            alert("Temat może mieć 4-64 znaki: litery, cyfry, myślnik, podkreślnik.");
            return;
          }
          GM_setValue(Notifier.KEY_TOPIC, t);
          log(`[PUSH] temat ntfy tego komputera ustawiony na: ${t}`, "success");
          if (nTopic) nTopic.textContent = `temat: ${t}`;
          // v2.77.1: nie klam, ze wyslano, gdy push jest wylaczony (07.08:
          // owner zobaczyl „wyslalem probne powiadomienie” przy toggle OFF).
          if (Notifier.enabled()) {
            Notifier.push("🔔 Ten komputer podłączony", `Powiadomienia z tej maszyny idą teraz na temat ${t}.`, "default", "bell");
          }
          alert(Notifier.enabled()
            ? `Ustawione: ${t}\n\nWyslalem probne powiadomienie — sprawdz telefon.`
            : `Ustawione: ${t}\n\nUWAGA: przelacznik \"Push na telefon (ntfy)\" jest OFF, wiec NIC nie wyszlo — alarmy o ataku tez nie beda wychodzic. Wlacz go w panelu.`);
        });
        const nTest = document.getElementById("ogx-ntfy-test");
        const paint = () => {
          if (nBtn) nBtn.textContent = Notifier.enabled() ? "ON" : "OFF";
          if (nTopic) nTopic.textContent = `temat: ${Notifier.topic()}`;
          if (nTopic) nTopic.style.color = Notifier.enabled() ? "#27ae60" : "#7f8c8d";
        };
        if (nBtn) nBtn.addEventListener("click", () => {
          GM_setValue(Notifier.KEY_ON, Notifier.enabled() ? "0" : "1");
          log(`Push na telefon: ${Notifier.enabled() ? "WŁĄCZONE" : "wyłączone"}.`, "info");
          paint();
        });
        if (nTopic) nTopic.addEventListener("click", () => {
          try { navigator.clipboard.writeText(Notifier.topic()); nTopic.textContent = "skopiowano ✓"; setTimeout(paint, 1200); } catch {}
        });
        if (nTest) nTest.addEventListener("click", () => {
          Notifier.push("🔔 Test powiadomień OGameX", `Działa! Temat: ${Notifier.topic()}. Bot wyśle tu alarm o ataku, ewakuacji i błędach obrony.`, "default", "bell");
          Notifier.siren(3);
          Notifier.speak("Test alarmu głosowego. Tak zabrzmi atak na bazę.", 1);
          log(`[PUSH] wysłano testowe powiadomienie na temat ${Notifier.topic()} — telefon powinien zawibrować w kilka sekund.`, "success");
        });
        const vBtn = document.getElementById("ogx-voice-toggle");
        if (vBtn) {
          const paintV = () => { vBtn.textContent = Notifier.voiceEnabled() ? "ON" : "OFF"; };
          vBtn.addEventListener("click", () => {
            GM_setValue(Notifier.KEY_VOICE, Notifier.voiceEnabled() ? "0" : "1");
            log(`Alarm głosowy: ${Notifier.voiceEnabled() ? "WŁĄCZONY" : "wyłączony"}.`, "info");
            if (Notifier.voiceEnabled()) Notifier.speak("Alarm głosowy włączony.", 1);
            paintV();
          });
          paintV();
        }
        paint();
      }
      const gateBtn = document.getElementById("ogx-gate-jump");
      if (gateBtn) gateBtn.addEventListener("click", (ev) => {
        if (ev.shiftKey) {
          const w = MoonSave.watch();
          if (w.refugeBody !== "gate") { log("[BRAMA] nie ma zapisanego skoku do cofnięcia.", "warn"); return; }
          GateSave.returnHome(w, { byOperator: true }).then(ok => { if (ok) handlePendingMission(); });
          return;
        }
        const c = HomeBase.coords();
        if (!c) { log("[BRAMA] nie odczytałem koordów aktywnej pary.", "warn"); return; }
        if (MoonSave.currentBody() !== "moon") { log("[BRAMA] aktywne ciało nie jest księżycem — przełącz na księżyc z bramą.", "warn"); return; }
        if (!window.confirm(`Skoczyć bramą CAŁĄ flotą z księżyca [${GateSave.key(c)}] na inny księżyc?`)) return;
        GM_setValue("ogamex_gate_fail_" + GateSave.key(c), "0");
        MoonSave.run({ manual: true, reason: "skok bramą (operator)", where: c }).catch(err => log(`[BRAMA] ${err.message}`, "error"));
      });
      const moonForm = document.getElementById("ogx-moon-form");
      if (moonForm) moonForm.addEventListener("click", () => {
        const c = HomeBase.coords();
        if (!c) { log("[KSIĘŻYC] nie odczytałem koordów aktywnej pary — wejdź na Overview.", "warn"); return; }
        if (HomeBase.pairHasMoon(c) === true) { log(`[KSIĘŻYC] para [${MoonRebuild.key(c)}] ma już księżyc.`, "info"); return; }
        if (!window.confirm(`Utworzyć księżyc wokół [${MoonRebuild.key(c)}]?\n\nKoszt w metalu wg średnicy (${CONFIG.moonRebuild?.diameterKm || 8944} km, w dół gdy brakuje metalu).`)) return;
        GM_setValue("pending_mission", null);
        GM_setValue(MoonRebuild.KEY_TRY, "{}");
        if (MoonRebuild.schedule(c, "przycisk operatora")) handlePendingMission();
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

      // v2.58.0: podglad/awaryjny reset rejestru lotow gorniczych. Rejestr wyznacza
      // budzet rownoleglych wysylek, wiec gdy wisi w nim duch — kopanie stoi.
      const flightsBtn = document.getElementById("ogx-flights");
      if (flightsBtn) flightsBtn.addEventListener("click", (ev) => {
        const mm = document.body.textContent.match(/(\d+)\s*Missions?:\s*(\d+)\s*Own/);
        const own = mm ? parseInt(mm[2]) : -1;
        if (ev.shiftKey) {
          MiningFlights.clear();
          GM_setValue("ogamex_fleet_return_at", "0");
          log("Rejestr lotow wyczyszczony recznie (Shift) — budzet wolny, skan wznowiony.", "asteroid");
          return;
        }
        const list = MiningFlights.list();
        log(`Rejestr lotow: ${list.length} wpis(ow); gra widzi ${own < 0 ? "?" : own} wlasnych misji.`, "asteroid");
        const now = Date.now();
        list.forEach(e => log(`  - ${e.coord} — powrot za ${Math.ceil((e.returnAt - now) / 60000)} min`, "asteroid"));
        if (list.length === 0) log("  (pusty — budzet nie blokuje wysylek)", "asteroid");
        log("Shift+klik = wyczysc rejestr awaryjnie.", "asteroid");
      });
      const stBtn = document.getElementById("ogx-selftest");
      if (stBtn) stBtn.addEventListener("click", () => {
        log("[AUTOTEST] uruchamiam sprawdzenie obrony na tej wersji bota…", "info");
        DefenceSelfTest.run({ manual: true });
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
    bindFarmNum("ogx-farm-hc", "hcPerFlight", "Ships / attack");
    bindFarmNum("ogx-farm-cooldown", "targetCooldownMin", "Target cooldown");
    bindFarmNum("ogx-farm-reserve", "slotReserve", "Slot reserve");
    bindFarmNum("ogx-farm-maxrank", "maxTargetRank", "Max ranking celu (0 = bez filtra)");
    bindFarmNum("ogx-farm-refresh", "dbRefreshHours", "Pełny skan bazy co (h)");
    // v2.89.0: podgląd bazy celów — koordy + gracz + ranking, po rankingu.
    {
      const el = document.getElementById("ogx-farm-dbdump");
      if (el) el.addEventListener("click", () => {
        openLogPanel();
        const db = FarmTargetDB.load();
        const rows = Object.entries(db)
          .map(([coord, e]) => ({ coord, ...e }))
          .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
        if (!rows.length) { log("Baza celów PUSTA — poczekaj na pełny skan zakresów.", "warn"); return; }
        const maxRank = CONFIG.inactiveFarming.maxTargetRank || 0;
        log(`── BAZA CELÓW: ${rows.length} nieaktywnych${maxRank ? `, limit rank ≤ ${maxRank}` : ""} ──`, "info");
        rows.forEach(r => {
          const age = Math.round((Date.now() - (r.seenAt || 0)) / 3600000);
          const inLimit = farmRankEligible(r.rank, maxRank) ? "✓" : "✗";
          log(`${inLimit} [${r.coord}] ${r.name} — rank ${r.rank ?? "?"} (widziany ${age}h temu)`, "info");
        });
      });
    }
    // v2.97.0: podglad priorytetu lupu
    {
      const el = document.getElementById("ogx-farm-topdump");
      if (el) el.addEventListener("click", () => {
        openLogPanel();
        const rows = FarmYieldDB.top(15);
        if (!rows.length) { log("Baza lupow PUSTA — wejdz raz na profil gracza (Plunder Journal) albo poczekaj na fetch (15 min).", "warn"); return; }
        const med = FarmYieldDB.median();
        const floor = CONFIG.inactiveFarming.minTargetProfit || 0;
        log(`── TOP CELE wg lupu (mediana ${med?.toLocaleString("pl-PL") ?? "?"}${floor ? `, prog ${floor.toLocaleString("pl-PL")}` : ", prog OFF"}) ──`, "info");
        rows.forEach((r, i) => log(`${i + 1}. [${r.coord}] ${r.player} — sredni lup ${r.p.toLocaleString("pl-PL")} (probek: ${r.n})`, "info"));
      });
    }
    {
      const el = document.getElementById("ogx-farm-repeat");
      if (el) el.addEventListener("click", () => {
        CONFIG.inactiveFarming.repeatEachSweep = CONFIG.inactiveFarming.repeatEachSweep === false;
        el.textContent = CONFIG.inactiveFarming.repeatEachSweep ? "ON" : "OFF";
        saveConfig(CONFIG);
        log(`Nowe okrążenie od nowa: ${CONFIG.inactiveFarming.repeatEachSweep ? "WŁĄCZONE — każdy przebieg atakuje wszystkich od nowa" : "wyłączone — obowiązuje Target cooldown"}.`, "info");
        updateStatusUI();
      });
    }
    // v2.98.0: tryb sekwencyjny vs priorytet łupu. Przełączenie czyści stan
    // przebiegu — stara kolejka (lap lub posortowana) nie dokańcza się w
    // nowym trybie.
    {
      const el = document.getElementById("ogx-farm-seq");
      if (el) el.addEventListener("click", () => {
        CONFIG.inactiveFarming.sequentialSweep = CONFIG.inactiveFarming.sequentialSweep !== true;
        el.textContent = CONFIG.inactiveFarming.sequentialSweep ? "ON" : "OFF";
        saveConfig(CONFIG);
        FarmState.clear();
        log(`Tryb farmy: ${CONFIG.inactiveFarming.sequentialSweep ? "SEKWENCYJNY — każdy przebieg przemiata cały zakres po kolei (1→koniec), cele w kolejności napotkania" : "PRIORYTET ŁUPU — okrążenia po znanych systemach, najtłustsze cele pierwsze"}. Bieżący przebieg zrestartowany.`, "info");
        updateStatusUI();
      });
    }
    // v2.72.0: wybór statku farmy (dropdown — wartości to żywe data-ship-type)
    {
      const el = document.getElementById("ogx-farm-ship");
      if (el) el.addEventListener("change", () => {
        CONFIG.inactiveFarming.shipType = el.value;
        saveConfig(CONFIG);
        log(`Farm ship type set to ${el.value}`, "info");
      });
    }
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
      const jitBtn = document.getElementById("ogx-jitter-toggle");
      if (jitBtn) jitBtn.addEventListener("click", () => {
        CONFIG.antiDetection.jitterEnabled = !CONFIG.antiDetection.jitterEnabled;
        saveConfig(CONFIG);
        jitBtn.textContent = CONFIG.antiDetection.jitterEnabled ? "ON" : "OFF";
        log(`Pauzy losowe (jitter): ${CONFIG.antiDetection.jitterEnabled ? "włączone" : "WYŁĄCZONE"}.`, "info");
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
        // v2.89.0: nowe zakresy = baza może nie pokrywać terenu → następne
        // podejście MUSI być pełnym skanem (okrążenia po bazie i tak filtrują
        // po zakresach, ale bez tego bot krążyłby po starym wycinku).
        GM_setValue("ogamex_farm_last_full_sweep", "0");
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
    // ── v2.84.0: sztywne punkty startu (minery / ekspedycje) ──
    // Wpis „g:s:p" → moduł startuje stamtąd (bot sam przełącza ciało);
    // puste → z aktywnego ciała. Koordy spoza listy planet przyjmujemy
    // z OSTRZEŻENIEM (pasek może być nieprzeładowany), ale mówimy głośno.
    {
      const bindLaunchFrom = (id, getCfg, setCfg, label) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("change", () => {
          const raw = (el.value || "").trim();
          if (!raw) {
            setCfg(null);
            saveConfig(CONFIG);
            log(`${label}: punkt startu wyczyszczony — start z aktywnego ciała.`, "info");
            updateStatusUI();
            return;
          }
          const m = raw.match(/^(\d+)\s*:\s*(\d+)\s*:\s*(\d+)$/);
          if (!m) {
            const cur = getCfg();
            el.value = cur ? `${cur.galaxy}:${cur.system}:${cur.position}` : "";
            log(`${label}: „${raw}" to nie koordy g:s:p — bez zmian.`, "error");
            return;
          }
          const c = { galaxy: +m[1], system: +m[2], position: +m[3] };
          setCfg(c);
          saveConfig(CONFIG);
          const known = !!HomeBase.pairAnchor(c) || ThreatMonitor.ownBodies().has(`${c.galaxy}:${c.system}:${c.position}`);
          log(`${label}: start ustawiony na [${c.galaxy}:${c.system}:${c.position}]${CONFIG.baseBody === "moon" ? " (księżyc)" : ""}.${known ? "" : " UWAGA: nie widzę tych koordów na liście planet — sprawdź wpis."}`, known ? "success" : "warn");
          updateStatusUI();
        });
      };
      bindLaunchFrom("ogx-cfg-mining-from",
        () => CONFIG.asteroidMining.launchFrom,
        (v) => { CONFIG.asteroidMining.launchFrom = v; },
        "[START MINERÓW]");
      bindLaunchFrom("ogx-expo-from",
        () => CONFIG.expeditions.launchFrom,
        (v) => { CONFIG.expeditions.launchFrom = v; },
        "[START EKSPEDYCJI]");
      bindLaunchFrom("ogx-farm-from",
        () => CONFIG.inactiveFarming.launchFrom,
        (v) => { CONFIG.inactiveFarming.launchFrom = v; },
        "[START FARMIENIA]");
      {
        const el = document.getElementById("ogx-farm-minprofit");
        if (el) el.addEventListener("change", () => {
          CONFIG.inactiveFarming.minTargetProfit = Math.max(0, parseInt(el.value) || 0);
          saveConfig(CONFIG);
          log(`Prog lupu celu: ${CONFIG.inactiveFarming.minTargetProfit ? CONFIG.inactiveFarming.minTargetProfit.toLocaleString("pl-PL") : "OFF (0)"}.`, "info");
        });
      }
    }
    // v2.83.0: przełącznik PROMU (domyślnie OFF — bot sam nie przenosi floty)
    {
      const ferryBtn = document.getElementById("ogx-ferry-toggle");
      if (ferryBtn) ferryBtn.addEventListener("click", () => {
        const on = !(CONFIG.moonFerry?.enabled);
        if (on && !window.confirm("Włączyć PROM?\n\nCo 2 h bot będzie automatycznie przewoził WSZYSTKO z aktywnej planety na jej księżyc (flota, surowce, deuter minus rezerwa). Pierwszy kurs może ruszyć od razu.")) return;
        CONFIG.moonFerry = { ...(CONFIG.moonFerry || {}), enabled: on };
        saveConfig(CONFIG);
        ferryBtn.textContent = on ? "ON" : "OFF";
        log(on ? "[PROM] włączony — co 2 h wszystko z aktywnej planety pojedzie na jej księżyc." : "[PROM] wyłączony — bot sam nie przenosi floty; przenosiny tylko ręcznie (RATUJ / Deploy).", "info");
      });
    }
    // v2.69.0: przełącznik trybu księżycowego (dotyczy mining+ekspedycje+złom)
    {
      const bbBtn = document.getElementById("ogx-base-body");
      if (bbBtn) bbBtn.addEventListener("click", () => {
        const toMoon = CONFIG.baseBody !== "moon";
        if (toMoon && !window.confirm("Start wysyłek z KSIĘŻYCA?\n\nFalanga nie widzi lotów z księżyca — koniec snajperek na powrót floty. Od v2.82.0 chodzi o księżyc AKTUALNEGO układu (tam, gdzie stoisz). WARUNEK: flota, minery, recyklery i deuter muszą stać na tym księżycu (przenieś przyciskiem RATUJ FLOTĘ, jeśli są na planecie). Układ bez księżyca = start z planety.")) return;
        CONFIG.baseBody = toMoon ? "moon" : "planet";
        saveConfig(CONFIG);
        bbBtn.textContent = toMoon ? "KSIĘŻYC" : "PLANETA";
        log(`Start rutynowych wysyłek: ${toMoon ? "KSIĘŻYC (falanga ślepa)" : "PLANETA (uwaga: falanga widzi loty!)"}`, toMoon ? "success" : "warn");
      });
    }
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
            const baseForCheck = HomeBase.mining();
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
              launchAt: HomeBase.mining(), // v2.84.0: skąd ma wyjść flota
              step: "select_ships_direct",
              resumeScan: false,
              timestamp: Date.now(),
            }));
            RateLimiter.record();
            await AntiDetection.shortDelay();
            window.location.replace(result.fleetUrl);
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

    // v2.64.0: klucz Gemini — zapis przy każdej zmianie, status pokazuje stan
    {
      const llmKey = document.getElementById("ogx-llm-key");
      const llmStatus = document.getElementById("ogx-llm-status");
      const paintLlm = () => {
        if (!llmStatus) return;
        const k = LlmParser.apiKey();
        llmStatus.textContent = k
          ? `LLM aktywny (klucz …${k.slice(-6)}, użycia dziś: ${LlmParser._usedToday()}/${LlmParser.DAILY_LIMIT})`
          : "LLM wyłączony — wklej klucz z aistudio.google.com/apikey";
        llmStatus.style.color = k ? "#27ae60" : "#7f8c8d";
      };
      if (llmKey) {
        // Nie wstawiamy klucza w value w HTML (trafiłby do zrzutów DOM w logu);
        // pole pokazuje tylko, CZY klucz jest.
        if (LlmParser.apiKey()) llmKey.placeholder = "klucz zapisany ✓";
        llmKey.addEventListener("change", () => {
          const v = llmKey.value.trim();
          if (!v) return;
          GM_setValue(LlmParser.KEY_API, v);
          llmKey.value = "";
          llmKey.placeholder = "klucz zapisany ✓";
          log("[LLM] klucz Gemini zapisany lokalnie. Model będzie czytał raporty urobku tam, gdzie zwykłe parsery nie rozumieją strony.", "success");
          paintLlm();
        });
      }
      paintLlm();
    }
    // v2.65.2: klik na nagłówek loga rozwija/zwija pełną listę
    {
      const lh = document.getElementById("ogx-log-header");
      const la = document.getElementById("ogx-log");
      const lastLine = document.getElementById("ogx-log-last");
      const chev = document.getElementById("ogx-log-chev");
      if (lh && la) {
        const openStored = GM_getValue("ogx_log_open", "0") === "1";
        const paint = (open) => {
          la.style.display = open ? "block" : "none";
          if (lastLine) lastLine.style.display = open ? "none" : "block";
          if (chev) chev.textContent = open ? "▾" : "▸";
          if (open) updateLogUI(); // v2.94.0: lista nie byla malowana w tle
        };
        paint(openStored);
        lh.addEventListener("click", (e) => {
          if (e.target.closest("button, input")) return; // Copy/Clear działają normalnie
          const open = la.style.display === "none";
          GM_setValue("ogx_log_open", open ? "1" : "0");
          paint(open);
        });
      }
    }
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
      // v2.65.1: sekcje to ustawienia — domyślnie ZWINIĘTE (stan pokazuje
      // pasek na górze). Nowe polskie tytuły = stary zapis zwinięć nie pasuje,
      // więc przy braku NOWEGO klucza zwijamy wszystko poza Szybkimi akcjami.
      let collapsed;
      {
        const raw = GM_getValue("ogx_ui_collapsed_v2", null);
        if (raw) collapsed = new Set(JSON.parse(raw));
        else {
          collapsed = new Set([...panel.querySelectorAll(".section .section-title span")]
            .map(el => (el.textContent || "").trim())
            .filter(n => n && n !== "Szybkie akcje"));
        }
      }
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
          GM_setValue("ogx_ui_collapsed_v2", JSON.stringify([...collapsed]));
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

  let _logPersistTimer = null;
  function persistLogsNow() {
    if (_logPersistTimer) { clearTimeout(_logPersistTimer); _logPersistTimer = null; }
    GM_setValue(LOG_STORAGE_KEY, JSON.stringify(logEntries));
  }
  function schedulePersistLogs() {
    if (_logPersistTimer) return;
    _logPersistTimer = setTimeout(persistLogsNow, 1000);
  }
  window.addEventListener("pagehide", persistLogsNow);

  // v2.97.2: przyciski-raporty (baza celow, top cele) pisza do logu, ktory
  // domyslnie jest ZWINIETY na dole panelu - "klikam i nic sie nie dzieje"
  // (owner 15.08 18:53). Otworz log i przewin panel do wyniku.
  function openLogPanel() {
    const la = document.getElementById("ogx-log");
    if (!la) return;
    GM_setValue("ogx_log_open", "1");
    la.style.display = "block";
    const lastLine = document.getElementById("ogx-log-last");
    if (lastLine) lastLine.style.display = "none";
    const chev = document.getElementById("ogx-log-chev");
    if (chev) chev.textContent = "\u25be";
    updateLogUI();
    try { la.scrollIntoView({ block: "nearest" }); } catch {}
  }

  function updateLogUI() {
    const logArea = document.getElementById("ogx-log");
    if (!logArea) return;

    // v2.65.2: skrót — zawsze widoczna ostatnia linia, bez rozwijania
    const last = document.getElementById("ogx-log-last");
    if (last && logEntries[0]) {
      const e = logEntries[0];
      last.textContent = `${e.time} ${e.msg}`;
      last.className = `log-entry ${e.type}`;
      last.style.cssText = "font-size:10px;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 2px;";
    }

    // All logs in main area (increased limit)
    // v2.94.0: log domyslnie zwiniety (display:none) - przebudowa 50 wpisow
    // z escapeHTML przy kazdej linii byla niewidoczna praca; pomijamy ja,
    // az operator rozwinie log (paint() wola wtedy updateLogUI).
    if (logArea.style.display !== "none") logArea.innerHTML = logEntries
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

  // ── v2.65.0: pasek stanu — dane już są liczone, tu tylko je POKAZUJEMY ──
  function updateStatusStrip() {
    const set = (id, cls, html) => {
      const row = document.getElementById(id);
      if (!row) return;
      row.className = `strip-row ${cls}`;
      row.querySelector(".val").innerHTML = html;
    };
    try {
      // 🛡 Obrona
      const ts = ThreatMonitor.state();
      const active = ThreatMonitor.active();
      const s12 = ThreatLog.summary(12);
      if (!CONFIG.threatAlarm?.enabled) set("ogx-strip-def", "dim", "wyłączona");
      else if (active) set("ogx-strip-def", "alert", `ALARM — <b>${ts?.count ?? "?"}</b> obcych flot`);
      else set("ogx-strip-def", "ok", `czysto · 12h: ${s12.alarms ? `<b>${s12.alarms}</b> alarm${s12.saves ? `, <b>${s12.saves}</b> ratunek` : ""}${s12.returns ? `, <b>${s12.returns}</b> powrót` : ""}` : "spokój"}`);

      // ⛏ Mining
      const scan = ScanState.load();
      const flights = MiningFlights.count();
      const maxF = maxMiningFleets();
      const flightsStr = `loty <b>${flights}</b>/${maxF > 0 ? maxF : "∞"}`;
      const returnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0")) || 0;
      if (!CONFIG.asteroidMining.enabled) set("ogx-strip-min", "dim", "wyłączony");
      else if (Humanizer.isOnBreak()) set("ogx-strip-min", "dim", `przerwa (kawa) · ${flightsStr}`);
      else if (AntiDetection.isSleepTime()) set("ogx-strip-min", "dim", `okno nocne · ${flightsStr}`);
      else if (scan?.active) {
        const next = scan.queue?.[0];
        set("ogx-strip-min", "busy", `skan <b>${scan.scannedCount ?? "?"}</b>/${scan.totalCount ?? "?"}${next ? ` · [${next.galaxy}:${next.system}]` : ""} · ${flightsStr}`);
      } else if (returnAt > Date.now()) {
        set("ogx-strip-min", "busy", `czekam na flotę ~<b>${Math.max(1, Math.ceil((returnAt - Date.now()) / 60000))}</b> min · ${flightsStr}`);
      } else set("ogx-strip-min", "ok", `czuwa · ${flightsStr}`);

      // 🚀 Ekspedycje
      const slots = ExpeditionRunner.slots();
      const est = ExpeditionState.load();
      const gapLeft = est?.lastSendAt ? Math.max(0, Math.round(((est.lastSendAt + (est.nextGapMs || 0)) - Date.now()) / 1000)) : null;
      // v2.79.0: „nast. ~30 s" przy wstrzymanych wysyłkach to nieprawda —
      // pasek ma mówić, że stoimy i dlaczego (obrona albo rezerwa paliwa).
      const holdWhy = DefenceHold.reason();
      const fuelLow = !holdWhy && Fuel.reserve() > 0 && Fuel.read() != null && Fuel.read() <= Fuel.reserve();
      if (!CONFIG.expeditions.enabled) set("ogx-strip-exp", "dim", "wyłączone");
      else if (holdWhy) set("ogx-strip-exp", "alert", `WSTRZYMANE — ${holdWhy}`);
      else if (fuelLow) set("ogx-strip-exp", "alert", "WSTRZYMANE — deuter na poziomie rezerwy ewakuacyjnej");
      else set("ogx-strip-exp", slots.used >= (slots.total || 14) ? "ok" : "busy",
        `<b>${slots.used ?? "?"}</b>/${slots.total || "?"}${gapLeft !== null && slots.used < (slots.total || 14) ? ` · nast. ~<b>${gapLeft}</b> s` : ""} · dziś ${est?.sentToday ?? 0}`);

      // 🌙 Fleet Save
      const fsSt = FleetSave.state();
      if (!CONFIG.fleetSave?.enabled) set("ogx-strip-fs", "dim", "wyłączony");
      else if (fsSt?.phase === "launched") set("ogx-strip-fs", "busy", FleetSave.describe().replace(/^FS:\s*/, ""));
      else if (fsSt?.phase === "recalled") set("ogx-strip-fs", "ok", FleetSave.describe().replace(/^FS:\s*/, ""));
      else if (fsSt?.phase === "recall_failed") set("ogx-strip-fs", "alert", "zawracanie NIEUDANE — sprawdź log");
      else set("ogx-strip-fs", "ok", FleetSave.describe().replace(/^FS:\s*/, ""));

      // 🤖 Gemini
      if (!LlmParser.enabled()) set("ogx-strip-llm", "dim", "brak klucza");
      else set("ogx-strip-llm", "ok", `aktywny · dziś <b>${LlmParser._usedToday()}</b>/${LlmParser.DAILY_LIMIT}`);
    } catch {}
  }

  function updateStatusUI() {
    updateStatusStrip();
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
      } else if (InactiveFarmer.yieldsToMining()) {
        ftext = "Czeka — mining ma pierwszeństwo (skan/wysyłka asteroid); farm wróci, gdy minery będą w locie";
      } else if (!InactiveFarmer.parseRanges(cfg.ranges).length) {
        ftext = "No valid ranges — set e.g. 3:100-200";
      } else {
        const st = FarmState.load();
        const free = InactiveFarmer.slotsFree();
        const totalSlots = InactiveFarmer.cachedFleetTotal() || "?";
        const dbStats = FarmTargetDB.stats(cfg.maxTargetRank || 0);
        const dbTxt = `baza: ${dbStats.eligible}/${dbStats.total} celów${cfg.maxTargetRank ? ` ≤${cfg.maxTargetRank}` : ""}`;
        if (st?.active) {
          const kind = st.mode === "lap" ? "Okrążenie" : "Pełny skan";
          ftext = `${kind} ${st.scannedCount}/${st.totalCount} | targets queued: ${st.targets?.length ?? 0} | ${dbTxt} | slots free: ${free}/${totalSlots} | attacked (cooldown): ${FarmedTargets.count()}`;
        } else {
          const cool = parseInt(GM_getValue("ogamex_farm_cooldown_until", "0")) || 0;
          const coolMin = cool > Date.now() ? Math.ceil((cool - Date.now()) / 60000) : 0;
          ftext = coolMin > 0
            ? `Sweep done — next in ~${coolMin}min | ${dbTxt} | attacked (cooldown): ${FarmedTargets.count()}`
            : `Ready — sweep starts on next tick | ${dbTxt} | slots free: ${free}/${totalSlots}`;
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

    // v2.60.0: Fleet Save status line
    const fsStatus = document.getElementById("ogx-fs-status");
    if (fsStatus) {
      const st = FleetSave.state();
      fsStatus.textContent = CONFIG.fleetSave?.enabled || st ? FleetSave.describe() : "Off";
      fsStatus.style.color = st?.phase === "recall_failed" ? "#e74c3c"
        : st?.phase === "launched" || st?.phase === "recalled" ? "#2ecc71"
        : CONFIG.fleetSave?.enabled ? "#e67e22" : "#7f8c8d";
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
        etext = "Nie znam punktu startu — otwórz stronę z listą planet";
      } else {
        const s = ExpeditionRunner.slots();
        const nextMs = ExpeditionRunner.msToNextWave();
        const eb = ExpeditionRunner.base();
        const parts = [`w powietrzu: ${s.used}/${s.total || "?"} (cap ${ExpeditionRunner.waveCap()})`];
        parts.push(nextMs > 0 ? `następna fala za ~${Math.ceil(nextMs / 1000)}s` : "fala gotowa");
        parts.push(`dziś: ${ExpeditionRunner.sentToday()}`);
        if (eb) parts.push(eb.fixed ? `start: [${eb.galaxy}:${eb.system}:${eb.position}] (sztywny)` : `start: [${eb.galaxy}:${eb.system}:${eb.position}] (tu gdzie jesteś)`);
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

    // v2.96.0: operator przeglada wiadomosci -> zbierz bany z widocznych
    // raportow bojowych (dziala nawet bez potwierdzonego endpointu fetch).
    try { CombatWatch.harvestDom(); } catch {}
    try { PlunderWatch.harvestDom(); } catch {} // v2.97.0: profil = darmowe probki lupu
    // v2.97.1: zakladki dziennika (dni) i strony raportow przelaczaja sie
    // BEZ przeladowania — harvest tylko w init widzial pierwszy widok.
    // Doczytywanie co 15 s jest idempotentne (dedup po koord|dacie) i tanie;
    // pozwala tez ZASSAC HISTORIE: owner przekliku je dni 09.08-dzis na
    // profilu, a kazdy widok laduje do bazy lupow w ciagu sekund.
    setInterval(() => {
      try { CombatWatch.harvestDom(); } catch {}
      try { PlunderWatch.harvestDom(); } catch {}
    }, 15 * 1000);

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
            if (entry.tagName === "A" && href && href !== "#") window.location.replace(entry.href);
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

    // v2.68.0: przed bramką pasywnej karty — blokadę uśpienia trzyma każda
    // karta z grą (i tak liczy się ta widoczna), więc lider może się zmienić
    // bez utraty ochrony przed snem.
    try { WakeLock.wire(); } catch {}
    try { AudioKeepalive.ensure(); } catch {}

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
      // v2.69.1: obrona-obserwator czuwa też w karcie pasywnej (requireLeader
      // i tak dopuszcza do działania tylko lidera — to jest gotowość przejęcia).
      if (CONFIG.enabled) startScheduler();
      startDefenceLoop();
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
    let wasRecycleSend = false; // v2.59.0: dto — złom nie jest lotem górniczym
    let wasFsSend = false;      // v2.60.0: dto — Fleet Save
    if (window.location.href.includes("fleetSendSuccessfully")) {
      // v2.11.0: was this a FARM send? The browser navigated here before
      // finishDispatch could run, so pending_mission still carries the type.
      // Farm sends must NOT run the mining parallel-decision below.
      let wasFarmSend = false;
      let wasMoonSend = false;
      let wasMoonReturn = false;
      let wasFerry = false;
      let pmSnap = null; // v2.85.0: ucieczka w powietrze czyta misję po wyczyszczeniu slotu
      try {
        const pm = JSON.parse(GM_getValue("pending_mission", "null"));
        pmSnap = pm;
        wasFarmSend = !!pm?.farm;
        wasExpoSend = !!pm?.expedition;
        wasMoonSend = !!pm?.moonSave;
        wasMoonReturn = !!pm?.moonReturn;
        wasFerry = !!pm?.ferry;
        wasRecycleSend = !!pm?.recycle;
        wasFsSend = !!pm?.fleetSave;
      } catch {}
      // v2.14.0: slow-navigation twin of the farm check below — if
      // finishDispatch already cleared pending_mission, the send stamp still
      // carries the kind, so an expedition never falls into the mining branch.
      if (!wasExpoSend) {
        const ls = readLastSent();
        wasExpoSend = !!(ls?.expedition && Date.now() - (ls.at || 0) < 60000);
      }
      if (wasMoonSend) {
        // v2.102.0 (blok D): pomiar E2E symulacji — tu ląduje zwykła ścieżka
        // (gra nawiguje do fleetSendSuccessfully zanim finishDispatch zdąży).
        try {
          const simStart = parseInt(GM_getValue("ogamex_threat_sim_started", "0")) || 0;
          if (simStart && Date.now() - simStart < 15 * 60 * 1000 && !GM_getValue("ogamex_threat_sim_e2e_said", "")) {
            GM_setValue("ogamex_threat_sim_e2e_said", "1");
            const secs = Math.round((Date.now() - simStart) / 1000);
            log(`[TEST] E2E: od startu symulacji do WYSŁANIA ratunku ${secs} s${secs > 120 ? " — ZA WOLNO na atak z układu (2-3 min)" : ""}.`, secs > 120 ? "error" : "success");
            ThreatLog.add("odczyt", `TEST E2E: start → wysyłka ratunku ${secs} s.`);
          }
        } catch {}
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
        if (wasMoonReturn) {
          // v2.78.0: jeśli w kolejce czeka kolonia uratowana w tym samym
          // alarmie, nie rozbrajamy straży — wstawiamy w nią tamtą kolonię
          // i pozwalamy temu samemu returnHome() ściągnąć ją następnym
          // ruchem. Pusta kolejka = zachowanie identyczne jak w 2.77.2.
          // v2.88.3: koordy kolonii, która WŁAŚNIE wróciła — promocja odrzuca
          // jej własne przestarzałe wpisy (incydent 23:00: drugi powrót tej
          // samej kolonii w odwrotną stronę z wpisu sprzed godzin).
          const justAt = RescueQueue.str(MoonSave.watch()?.at);
          // v2.104.0: ręczny WRÓĆ NA BAZĘ nie promuje kolejki (21:44:54 wskoczył stary wpis).
          const byOp = !!(pmSnap && pmSnap.byOperator);
          if (byOp || !RescueQueue.promoteNext("powrót poprzedniej kolonii zakończony", justAt)) {
            MoonSave.disarm(byOp ? "powrót ręczny wysłany" : "flota wróciła na bazę (potwierdzone po wysyłce)");
          }
        }
        // v2.74.5: stempel POTWIERDZONEJ wysyłki ratunku — powrót (returnHome)
        // czeka od tego momentu 130 s na lądowanie, zanim ruszy ściągać flotę.
        // v2.100.1 (F4): ucieczka w powietrze (główna i fale) NIE stempluje
        // straży — wielogodzinny Deploy jako lastFlightMs blokował powrót
        // aż do 60-min bezpiecznika „zator", który rozbrajał straż.
        if (!wasMoonReturn && !wasFerry && !(pmSnap && pmSnap.airSave)) {
          // v2.86.5: + realny czas lotu ratunku — od niego liczy się lądowanie.
          try { const w = MoonSave.watch(); if (w.armed) MoonSave.saveWatch({ ...w, lastSendAt: Date.now(), lastFlightMs: (pmSnap && pmSnap.flightMs) || w.lastFlightMs || 0 }); } catch {}
          try { MoonSave.commitGuardSwap(pmSnap); } catch {}   // v2.100.1 (F1)
        }
        if (wasFerry) {
          // v2.71.0: prom to logistyka, nie obrona — bez wpisu RATUNEK/POWRÓT
          // w dzienniku (zafałszowałby liczniki epizodów obrony).
          ThreatLog.add("odczyt", "PROM: planeta → księżyc wysłany (przewóz produkcji/surowców/floty).");
          log("[PROM] wysłany — wszystko z planety leci na księżyc.", "success");
        } else if (pmSnap?.airSave) {
          // v2.85.0: potwierdzona wysyłka ucieczki — stempel stanu + dziennik.
          try { AirSave.afterSend(pmSnap); } catch {}
          ThreatLog.add("RATUNEK", "UCIECZKA W POWIETRZE WYSŁANE — flota w locie do refugium, zawrócenie automatyczne po przejściu ataków.");
          log("[UCIECZKA] gra przyjęła wysyłkę — flota w powietrzu, zawrócenie wg zegara.", "success");
        } else {
          ThreatLog.add(wasMoonReturn ? "POWRÓT" : "RATUNEK", "WYSŁANE — gra przyjęła flotę (potwierdzone po przeładowaniu).");
          log("Ratunek/powrót floty wysłany — liczniki mininga nietknięte.", "fleet");
        }
      } else if (wasExpoSend) {
        GM_setValue("pending_mission", null);
        const storedExp = parseInt(GM_getValue("ogamex_inflight_fleets", "0")) || 0;
        GM_setValue("ogamex_inflight_fleets", String(storedExp + 1));
        GM_setValue("ogamex_last_dispatch_at", String(Date.now()));
        ExpeditionRunner.afterSend();
      } else if (wasFsSend) {
        // v2.60.0: gra przyjęła wysyłkę FS i przerzuciła nas tutaj, zanim
        // finishDispatch zdążył ruszyć — stempluj stan FS z misji, ZANIM
        // pending_mission zostanie wyczyszczone.
        try {
          const pm = JSON.parse(GM_getValue("pending_mission", "null"));
          if (pm?.fleetSave) FleetSave.markLaunched(pm);
        } catch {}
        GM_setValue("pending_mission", null);
      } else if (wasRecycleSend) {
        // v2.59.0: lot po złom nie jest lotem górniczym — bez tej gałęzi
        // wpadał niżej do decyzji równoległej mininga ze STARYMI liczbami
        // minerów i podbijał liczniki.
        GM_setValue("pending_mission", null);
        log("[ZŁOM] recyklery w drodze po pole złomu — liczniki mininga nietknięte.", "fleet");
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
      // v2.103.5 — FANTOM 25.08 21:35:43: strona „flota wysłana" bez rozpoznanej
      // misji (ratunek/ucieczka już sprzątnięte) wpadała tu i liczyła STARY rekord
      // minerów jako świeżą wysyłkę: „PARALLEL: sent 2 mld", zerowanie zegara
      // powrotu, +1 lotów — przy miningu OFF i bez jednego wysłanego minera.
      // Decyzja górnicza tylko dla ŚWIEŻEJ (<10 min) wysyłki i włączonego miningu;
      // rekord zużywany jednorazowo.
      const freshDisp = !!(lastDisp && Date.now() - (lastDisp.at || 0) < 10 * 60 * 1000 && !lastDisp.consumedAt);
      // v2.104.0: rekord NIE jest kasowany (minersHomeAfterLastDispatch liczy z niego
      // „minery w domu" przez maxFlightMinutes+5), tylko znakowany jako zużyty.
      if (am.enabled && am.parallelDispatch && lastDisp && freshDisp && !recentFarmSend) {
        GM_setValue("ogamex_last_dispatch", JSON.stringify({ ...lastDisp, consumedAt: Date.now() }));
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
    if (wasExpoSend || wasRecycleSend || wasFsSend) {
      log(`${wasExpoSend ? "Expedition" : wasRecycleSend ? "Recycle" : "Fleet Save"} send — mining fleet timers left untouched.`, "fleet");
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

    // ── v2.99.3: złom na galaktyce bazy — sprawdzany na KAŻDYM wejściu ──
    // Do 2.99.2 tryCollectHere() żyło tylko w gałęzi „skan aktywny", a
    // visit() jeździło na 16 głównie, gdy skan NIE był aktywny — wizyta
    // lądowała na stronie i nic nie sprawdzała (25.08: 81 mld/31 mld złomu
    // na [3:272:16] leżało mimo 20-minutowych wizyt). Teraz sprawdzenie
    // nie zależy od stanu skanu; bramki (pending/alarm/recyklery) są w środku.
    if (CONFIG.enabled && CONFIG.expeditions?.enabled && GameState.getCurrentPage() === "galaxy") {
      try { if (DebrisCollector.tryCollectHere()) return; } catch {}
    }

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
    } else if (CONFIG.enabled && CONFIG.inactiveFarming?.enabled && !InactiveFarmer.yieldsToMining()
               && FarmState.load()?.active && GameState.getCurrentPage() === "galaxy") {
      // v2.11.0: farm sweep continues on galaxy page load (mirror of the
      // asteroid resume above; farmer no-ops if a pending_mission exists).
      // v2.90.0: zamiast „mining wyłączony” — brama priorytetu (farm wznawia
      // się na galaktyce tylko w oknie, gdy mining i tak czeka na minery).
      setTimeout(() => { InactiveFarmer.run().catch(() => {}); }, 1500 + Math.random() * 1000);
    }

    // Auto-start scheduler if enabled
    // v2.69.1: pętla obrony startuje ZAWSZE — przy bocie OFF w trybie
    // obserwatora (detekcja+dziennik+push, zero ruszania flotą).
    if (CONFIG.enabled) startScheduler();
    startDefenceLoop();
    if (!CONFIG.enabled) log("Bot OFF — obrona czuwa w TRYBIE OBSERWATORA (wykrywa i alarmuje, flotą nie rusza).", "info");

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
