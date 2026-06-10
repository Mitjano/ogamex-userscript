// ==UserScript==
// @name         OGameX Assistant
// @namespace    https://github.com/Mitjano/Bybit_bot/ogamex-bot
// @version      2.10.10
// @description  Asteroid Mining automation for OGameX (multi-universe, fresh-scan on every cycle, TTL-aware dispatch with 5min safety margin; v2.10.0 adds right-sized fleets + parallel dispatch: send only the miners needed to carry the asteroid's resources and keep the rest mining other asteroids in parallel, with auto-learned cargo/yield)
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
      cargoPerMiner: 0,             // cargo capacity of ONE asteroid miner; 0 = auto-learn from the fleet confirmation page
      expectedResourcesPerAsteroid: 0, // expected resources per asteroid; 0 = auto-learn from mission reports (set manually to seed before learning)
      bufferFactor: 1.15,           // over-provision factor vs the estimate (covers above-average asteroids)
      yieldSampleSize: 20,          // rolling window of "resources found" reports used for the estimate
      estimatePercentile: 85,       // size the fleet against this percentile of samples (not the mean) so big asteroids aren't under-served
      learnFromReports: true,       // parse asteroid mining reports to learn expectedResources (see AsteroidYieldTracker)
      scanIntervalMin: 45, // minutes between range re-scans (asteroids move after each series)
      maxFlightMinutes: 45, // safety cap on one-way flight time; ranges beyond this are skipped. Formula max(11, ceil(11+Δ/15)) hits 45min at Δ=499 (max same-galaxy distance), so 45 ensures every range the game reports gets scanned. Lower values silently drop far ranges and the bot keeps spinning on a few empty close ones.
      // Ship types to use for asteroid mining, tried in order.
      // OGameX requires ASTEROID_MINER — only this ship type is allowed for asteroid missions.
      minerShipTypes: ["ASTEROID_MINER"],
      // Base planet from which miners ALWAYS launch. Set to null to fall back
      // to min-over-all-planets behavior. Per-host storage means each universe
      // remembers its own base independently (set via UI or saved config).
      minerBase: { galaxy: 3, system: 269, position: 8 },
    },
    expeditions: {
      enabled: false,
      fleetComposition: { HEAVY_CARGO: 50, PATHFINDER: 5 },
      holdingTimeHours: 1,
      maxConcurrent: 2, // max simultaneous expeditions
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
      // antiDetection is code-controlled — never override from saved config
      merged.antiDetection = { ...DEFAULT_CONFIG.antiDetection };
      // v2.9.2: Expeditions UI removed — force off so any old saved-state
      // that had expeditions.enabled=true doesn't keep running with no UI
      // to turn it off.
      if (merged.expeditions) merged.expeditions.enabled = false;

      // v2.9.3 migration: v2.9.0 default minerBase was 6:71:9 (old nexus
      // playthrough). Athena users got that saved in their host-scoped
      // storage on first toggle, then v2.9.1+ bumped the default to
      // 3:269:8 but deepMerge kept the stale saved value. Result: bot
      // sorted "closest-first" against the WRONG galaxy and dispatched
      // fleets that arrived after the asteroid TTL. One-shot reset.
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
      return merged;
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  function saveConfig(config) {
    GM_setValue("ogamex_bot_config", JSON.stringify(config));
  }

  let CONFIG = loadConfig();

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
      const hour = new Date().getUTCHours();
      if (sleepStartHour < sleepEndHour) {
        return hour >= sleepStartHour && hour < sleepEndHour;
      }
      return hour >= sleepStartHour || hour < sleepEndHour;
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
          return [];
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
          return [];
        }

        // Parse pairs: [6:45:17] ? [6:85:17] → range {galaxy:6, start:45, end:85}
        const coords = [];
        const regex = /\[(\d+):(\d+):(\d+)\]/g;
        let match;
        while ((match = regex.exec(html)) !== null) {
          coords.push({ galaxy: parseInt(match[1]), system: parseInt(match[2]) });
        }

        // Group into pairs (each consecutive pair = one range)
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

        // Do NOT merge overlapping ranges — each pair from the game is an
        // independent search area. Merging loses information and can cause
        // the bot to scan outside the intended boundaries.
        // Sort by startSystem ascending for linear scanning.
        rawRanges.sort((a, b) => a.galaxy - b.galaxy || a.startSystem - b.startSystem);
        const ranges = rawRanges;

        if (ranges.length === 0) {
          log("No asteroid ranges found", "asteroid");
        } else {
          const labels = ranges.map(r => `[${r.galaxy}:${r.startSystem}-${r.endSystem}]`).join(", ");
          log(`Found ${ranges.length} asteroid ranges: ${labels}`, "asteroid");
        }

        return ranges;
      } catch (err) {
        log(`Asteroid range scan error: ${err.message}`, "error");
        return [];
      }
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
      // Sort ranges so the closest one (to base) is scanned first,
      // but stay sequential ascending inside each range — otherwise we
      // interleave systems across ranges when two ranges have overlapping
      // distance bands (e.g. [185-209] and [331-355] from base 269).
      const sortedRanges = [...ranges];
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
      const containing = state.ranges.filter(r => inRange(r, galaxy, system));
      if (containing.length === 0) return 0;
      const others = state.ranges.filter(r => !containing.includes(r));
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
    TTL: 60 * 60 * 1000, // 1 hour — asteroids move after each series

    _load() {
      try {
        const raw = GM_getValue(this.KEY, "[]");
        // Filter out expired entries
        return JSON.parse(raw).filter(e => Date.now() - e.at < this.TTL);
      } catch { return []; }
    },

    add(galaxy, system) {
      const entries = this._load();
      entries.push({ coord: `${galaxy}:${system}`, at: Date.now() });
      GM_setValue(this.KEY, JSON.stringify(entries));
    },

    has(galaxy, system) {
      return this._load().some(e => e.coord === `${galaxy}:${system}`);
    },

    clear() {
      GM_setValue(this.KEY, "[]");
    },
  };

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
    scanReports() {
      if (!CONFIG.asteroidMining.learnFromReports) return;
      try {
        const path = location.pathname.toLowerCase();
        const looksLikeMessages = /message|communication|report|nachricht|wiadomo/.test(path) ||
          /Asteroid\s*Mining/i.test(document.body.textContent || "");
        if (!looksLikeMessages) return;

        // Candidate report containers — try a few common message selectors.
        const containers = document.querySelectorAll(
          ".message, .msg, .messageContent, [data-message-id], .message_item, li.message, .communication-item"
        );
        if (containers.length === 0) return;

        const seen = new Set(JSON.parse(GM_getValue(this.SEEN_REPORTS_KEY, "[]")));
        let learned = 0, dumped = 0;

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
            // Grab metal/crystal/deuterium amounts. Try labelled numbers first,
            // then fall back to all grouped numbers near resource words.
            const nums = [];
            const re = /(?:metal|crystal|kristall|kryszta|deuterium|deuter)\D{0,12}?([\d.,\s]{2,})/gi;
            let m;
            while ((m = re.exec(text)) !== null) {
              const v = parseInt((m[1] || "").replace(/[^\d]/g, ""), 10);
              if (Number.isFinite(v) && v > 0) nums.push(v);
            }
            resources = nums.reduce((a, b) => a + b, 0);
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
        if (learned > 0) log(`Parsed ${learned} new asteroid report(s) for yield learning`, "asteroid");
      } catch (err) {
        log(`Report scan error (non-fatal): ${err.message}`, "warn");
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

  // ═══════════════════════════════════════════════════════════════
  //  ASTEROID MINER: Main asteroid mining logic
  // ═══════════════════════════════════════════════════════════════

  const AsteroidMiner = {
    running: false,

    // ── Main entry: called on every page load and scheduler tick ──
    async run() {
      if (!CONFIG.asteroidMining.enabled || !CONFIG.enabled) return;
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
        log("Empty scan queue — no systems in returned ranges (or all beyond maxFlight)", "error");
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
      // Wait for DOM to fully render — increased to ensure row 17 is visible
      await AntiDetection.sleep(900 + Math.random() * 800);

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
        const cooldownMin = CONFIG.asteroidMining.scanIntervalMin || 45;
        log(`Scan complete — no asteroids found. Waiting ${cooldownMin}min before next scan.`, "asteroid");
        ScanState.clear();
        // Set a cooldown timer so scheduler doesn't restart immediately
        GM_setValue("ogamex_scan_cooldown_until", String(Date.now() + cooldownMin * 60 * 1000));
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
      const freshRanges = await AsteroidScanner.scanRanges();
      if (freshRanges.length === 0) {
        log("Range verify: no active ranges — scan complete", "asteroid");
        ScanState.clear();
        return;
      }

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
          // Ranges shifted, current is stale — drop history, restart fresh.
          const baseCfg = CONFIG.asteroidMining.minerBase;
          const maxFlightCfg = CONFIG.asteroidMining.maxFlightMinutes;
          const fullQueue = AsteroidScanner.buildScanQueue(freshRanges, baseCfg, maxFlightCfg);
          scanState.ranges = freshRanges;
          scanState.scannedSystems = [];
          scanState.scannedCount = 0;
          scanState.queue = fullQueue;
          scanState.totalCount = fullQueue.length;
          ScanState.save(scanState);

          if (fullQueue.length === 0) {
            log(`Range verify: no systems in ranges ${freshLabels} — scan complete`, "asteroid");
            ScanState.clear();
            return;
          }
          const jumpTo = fullQueue[0];
          log(`Range verify: current [${current.galaxy}:${current.system}] outside new ranges ${freshLabels} — resetting to [${jumpTo.galaxy}:${jumpTo.system}] (${fullQueue.length} systems)`, "asteroid");
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
        scanState.ranges = freshRanges;
        scanState.queue = [current, ...rest];
        scanState.totalCount = scanState.scannedCount + scanState.queue.length;
        ScanState.save(scanState);
        log(`Range verify: ranges changed to ${freshLabels} — queue rebuilt (${scanState.queue.length} systems, current [${current.galaxy}:${current.system}] kept)`, "asteroid");
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
            log("Scan complete — all ranges checked", "asteroid");
            ScanState.clear();
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
              log("Scan complete — all ranges checked", "asteroid");
              ScanState.clear();
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
        const cooldownMin = CONFIG.asteroidMining.scanIntervalMin || 45;
        log(`Scan complete: ${scanState.scannedCount} systems checked, no asteroids. Cooldown ${cooldownMin}min.`, "asteroid");
        ScanState.clear();
        GM_setValue("ogamex_scan_cooldown_until", String(Date.now() + cooldownMin * 60 * 1000));
        return;
      }

      // Navigate to next system
      const scanDelay = humanScanDelayMs();
      log(`Next: [${next.galaxy}:${next.system}] in ${Math.round(scanDelay)}ms...`, "asteroid");
      await AntiDetection.sleep(scanDelay);
      scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "next system");
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
  //  EXPEDITION MANAGER: Auto-send expeditions
  // ═══════════════════════════════════════════════════════════════

  const ExpeditionManager = {
    running: false,

    async run() {
      if (!CONFIG.expeditions.enabled || !CONFIG.enabled) return;
      if (AntiDetection.isSleepTime()) {
        log("Sleep time - expeditions paused", "delay");
        return;
      }

      this.running = true;
      try {
        // Rate limit check
        if (!RateLimiter.canAct()) {
          log(`Rate limit reached (${RateLimiter.maxPerHour}/hr). Waiting...`, "delay");
          return;
        }

        // Check expedition slots
        const expoSlots = GameState.getExpeditionSlots();
        if (expoSlots.used >= Math.min(expoSlots.total, CONFIG.expeditions.maxConcurrent)) {
          log(`Expedition slots full (${expoSlots.used}/${expoSlots.total})`, "expedition");
          return;
        }

        // Get current or first planet
        const planets = GameState.getPlanets();
        if (planets.length === 0) {
          log("No planets found", "error");
          return;
        }

        const fromPlanet = planets[Math.floor(Math.random() * planets.length)]; // Random planet

        // Store expedition mission
        GM_setValue("pending_mission", JSON.stringify({
          type: "expedition",
          missionId: 15,
          shipType: "HEAVY_CARGO", // Primary ship
          quantity: CONFIG.expeditions.fleetComposition.HEAVY_CARGO || 50,
          target: {
            galaxy: fromPlanet.galaxy,
            system: fromPlanet.system,
            position: 16, // Deep Space
          },
          fromPlanet,
          holdingTime: CONFIG.expeditions.holdingTimeHours,
          step: "select_ships",
          timestamp: Date.now(),
        }));

        RateLimiter.record();
        await AntiDetection.delay("expedition dispatch");
        FleetDispatcher.goToFleet(fromPlanet);
      } catch (err) {
        log(`Expedition error: ${err.message}`, "error");
      } finally {
        this.running = false;
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
  function minersHomeAfterLastDispatch() {
    let d = null;
    try { d = JSON.parse(GM_getValue("ogamex_last_dispatch", "null")); } catch {}
    if (!d || !Number.isFinite(d.available) || !Number.isFinite(d.toSend)) return -1;
    const maxAgeMs = (CONFIG.asteroidMining.maxFlightMinutes * 2 + 10) * 60 * 1000;
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
    const inflight = inflightFleetCount(); // reconciles with the live "M Own" page bar
    const maxConc = maxMiningFleets(); // floor(totalMinersToUse / perFlight), or maxConcurrentMiningFleets
    const concOk = maxConc <= 0 || inflight < maxConc;

    const canParallel = am.parallelDispatch &&
      minersLeftHome >= (am.minMinersPerMission || 1) &&
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
      : minersLeftHome < (am.minMinersPerMission || 1) ? "no miners left home"
      : slotsFree <= 0 ? "fleet slots full"
      : `flight budget reached (${inflight}/${maxConc} flights)`;
    log(`WAIT (${reason}): scan paused ~${Math.ceil((returnAt - Date.now()) / 60000)}min until a fleet returns.`, "asteroid");
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  //  MISSION FLOW HANDLER: Continue multi-page fleet dispatch
  // ═══════════════════════════════════════════════════════════════

  let _handlingMission = false;
  async function handlePendingMission() {
    if (_handlingMission) return;
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

      // ── Direct asteroid mining: fleet URL has coords + mission pre-set ──
      // 3-step form on same page: Select ships → Confirm destination → Send fleet
      if (mission.step === "select_ships_direct" && page === "fleet") {
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
                ScanState.clear(); // queue exhausted — let scheduler start a fresh scan
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
            log("Scan complete — all ranges checked", "asteroid");
            ScanState.clear();
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
          btn.click();
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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

        // Find miner ship: try configured types first, then fall back to ASTEROID/MINER naming
        const shipTypesToTry = [
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
          GM_setValue("ogamex_last_dispatch", JSON.stringify({ available, toSend, at: Date.now() }));

          if (input && toSend > 0) {
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) nativeSetter.call(input, toSend);
            else input.value = toSend;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            log(`Selected ${toSend}/${available} Asteroid Miners (input: ${input.className})`, "fleet");
          } else {
            log(`No Asteroid Miners available (found: ${available}, input: ${!!input})`, "error");
            GM_setValue("ogamex_dispatch_fail_at", String(Date.now()));
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
          sendBtn.click();
          sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

          await AntiDetection.sleep(3000);
          const errorMsg = document.querySelector(".error, .alert-danger, [class*='error']");
          const successMsg = document.querySelector(".success, .alert-success, [class*='success']");
          const fleetMovement = document.body.textContent.includes("fleet movement") ||
                                document.body.textContent.includes("Fleet movement");

          if (errorMsg) {
            log(`DISPATCH FAILED! Error: ${errorMsg.textContent.trim().substring(0, 100)}`, "error");
            GM_setValue("ogamex_dispatch_fail_at", String(Date.now()));
          } else if (successMsg || fleetMovement) {
            log("FLEET SENT! All miners dispatched!", "success");
            GM_setValue("ogamex_dispatch_fail_at", "0");
            GM_setValue("ogamex_tried_planets", "[]"); // reset planet rotation
            GM_setValue("ogamex_last_switched_planet", "");
            dispatchOk = true;

            // Use captured flight time from step 2 (actual asteroid mining flight time)
            if (capturedFlightMs > 0) {
              // Round trip = flight time * 2, add 1 min buffer for processing
              const returnTime = Date.now() + capturedFlightMs * 2 + 60000;
              GM_setValue("ogamex_fleet_return_at", String(returnTime));
              const minLeft = Math.ceil((returnTime - Date.now()) / 60000);
              log(`Fleet returns in ~${minLeft}min (flight: ${Math.round(capturedFlightMs/60000)}min × 2)`, "fleet");
            } else {
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
            // Still use captured flight time if available
            if (capturedFlightMs > 0) {
              const returnTime = Date.now() + capturedFlightMs * 2 + 60000;
              GM_setValue("ogamex_fleet_return_at", String(returnTime));
              log(`Estimated return in ~${Math.ceil((capturedFlightMs * 2 + 60000) / 60000)}min`, "fleet");
            }
          }
        } else {
          dumpButtons("step3-no-send");
          log("Cannot find 'Send fleet' button (step 3)", "error");
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
    // v2.10.10: heartbeat for the watchdog — recorded before ANY early return
    // so a disabled bot doesn't look "dead".
    GM_setValue("ogamex_last_tick_at", String(Date.now()));
    if (!CONFIG.enabled) return;

    // Handle any pending multi-page mission first
    await handlePendingMission();

    // Sleep check
    if (AntiDetection.isSleepTime()) {
      log("Night mode active - sleeping until " + CONFIG.antiDetection.sleepEndHour + ":00 UTC", "delay");
      return;
    }

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

    // Run asteroid mining
    const scanState = ScanState.load();
    const scanActive = scanState?.active;

    // Jitter — skip when scan is actively running (don't delay mid-scan)
    if (!scanActive) await AntiDetection.jitter();
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

    // Run expeditions if due
    if (CONFIG.expeditions.enabled && !ExpeditionManager.running) {
      await ExpeditionManager.run();
    }
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
    // First run after random 3-8 seconds
    setTimeout(() => {
      schedulerTick();
      scheduleNext();
    }, 3000 + Math.random() * 5000);
    log("Scheduler started", "info");
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

        <div class="section">
          <div class="section-title">
            <span>Anti-Detection</span>
            <span class="status ${AntiDetection.isSleepTime() ? "off" : "on"}">${AntiDetection.isSleepTime() ? "SLEEP" : "ACTIVE"}</span>
          </div>
          <div class="status">Delay: ${CONFIG.antiDetection.minDelaySeconds}-${CONFIG.antiDetection.maxDelaySeconds}s | Sleep: ${CONFIG.antiDetection.sleepStartHour}:00-${CONFIG.antiDetection.sleepEndHour}:00 UTC</div>
        </div>

        <div class="section">
          <div class="section-title">
            <span>Quick Actions</span>
          </div>
          <button class="mini-btn" id="ogx-scan-now">Scan Asteroids</button>
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
        log("Bot ENABLED", "success");
      } else {
        stopScheduler();
        log("Bot DISABLED", "info");
      }
    });

    document.getElementById("ogx-asteroid-toggle").addEventListener("click", () => {
      CONFIG.asteroidMining.enabled = !CONFIG.asteroidMining.enabled;
      saveConfig(CONFIG);
      const btn = document.getElementById("ogx-asteroid-toggle");
      btn.textContent = CONFIG.asteroidMining.enabled ? "ON" : "OFF";
      const section = document.getElementById("ogx-asteroid-section");
      section.className = `section ${CONFIG.asteroidMining.enabled ? "active" : "inactive"}`;
      log(`Asteroid mining ${CONFIG.asteroidMining.enabled ? "enabled" : "disabled"}`, "info");
    });

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
      const inflight = inflightFleetCount();
      const maxFleets = maxMiningFleets();
      const mode = am.parallelDispatch ? "parallel" : "serial";
      const needStr = need > 0 ? need.toLocaleString() : "all";
      const cargoStr = cargo > 0 ? cargo.toLocaleString() : "?";
      const estStr = est > 0 ? est.toLocaleString() : "?";
      const flightsStr = maxFleets > 0 ? `${inflight}/${maxFleets}` : `${inflight}/∞`;
      sizing.textContent = `Mode: ${mode} | per flight: ${needStr} | flights: ${flightsStr} | cargo/miner: ${cargoStr} | est: ${estStr}`;
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

    // Only run on game pages (not login)
    if (window.location.pathname.includes("/home") || window.location.pathname === "/") {
      return;
    }

    const SCRIPT_VERSION = (typeof GM_info !== "undefined" && GM_info?.script?.version) || "?";
    log(`OGameX Assistant v${SCRIPT_VERSION} loaded`, "info");

    // v2.10.10: timestamp of the last real page load — read by the scheduler
    // keepalive to detect long stretches with no navigation (session risk).
    GM_setValue("ogamex_last_pageload_at", String(Date.now()));

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
    if (window.location.href.includes("fleetSendSuccessfully")) {
      GM_setValue("pending_mission", null);
      const afterDispatchState = ScanState.load();
      if (afterDispatchState) {
        afterDispatchState.foundAsteroid = null;
        ScanState.save(afterDispatchState);
      }
      const am = CONFIG.asteroidMining;
      let lastDisp = null;
      try { lastDisp = JSON.parse(GM_getValue("ogamex_last_dispatch", "null")); } catch {}
      if (am.parallelDispatch && lastDisp) {
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
          ScanState.clear(); // queue exhausted → let scheduler cooldown / start a fresh scan
        }
      } else {
        log("Fleet sent — dispatch state cleaned up. Scan paused until a fleet returns.", "asteroid");
      }
    }

    // ── Cleanup stale data on startup ──
    GM_setValue("ogamex_tried_planets", "[]");
    GM_setValue("ogamex_last_switched_planet", "");

    // ── Smart fleet return timer check on startup ──
    // ALWAYS scan page header for active asteroid fleet, regardless of stored timer.
    // This recovers from scenarios where the timer was never persisted (e.g. dispatch
    // failure path didn't save it) — preventing the bot from scanning while miners
    // are still in flight.
    {
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
          const inflight = inflightFleetCount();
          const budgetOk = maxFleets <= 0 || inflight < maxFleets;
          if (slotsFree > 0 && haveMiners && budgetOk) {
            GM_setValue("ogamex_fleet_return_at", "0"); // capacity + (likely) miners + budget → keep scanning
            const homeStr = known ? `~${minersHome}` : "unknown→verify at dispatch";
            const budgetStr = maxFleets > 0 ? `, ${inflight}/${maxFleets} flights` : "";
            log(`Asteroid fleet in flight, ${homeStr} miners home + ${slotsFree} slot(s) free${budgetStr} — parallel keeps scanning.`, "asteroid");
          } else {
            const why = !budgetOk ? `flight budget reached (${inflight}/${maxFleets})`
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
      setTimeout(() => AsteroidMiner.run(), 3000 + Math.random() * 2000);
    }

    // Auto-start scheduler if enabled
    if (CONFIG.enabled) {
      startScheduler();
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
