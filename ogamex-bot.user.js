// ==UserScript==
// @name         OGameX Assistant
// @namespace    https://github.com/Mitjano/Bybit_bot/ogamex-bot
// @version      2.9.0
// @description  Asteroid Mining & Expedition automation for OGameX (multi-universe)
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
      minersPerMission: 0, // 0 = send all available
      scanIntervalMin: 45, // minutes between range re-scans (asteroids move after each series)
      maxFlightMinutes: 20, // safety cap (whole galaxy ≈ 15min from base 6:71)
      // Ship types to use for asteroid mining, tried in order.
      // OGameX requires ASTEROID_MINER — only this ship type is allowed for asteroid missions.
      minerShipTypes: ["ASTEROID_MINER"],
      // Base planet from which miners ALWAYS launch. Set to null to fall back
      // to min-over-all-planets behavior.
      minerBase: { galaxy: 6, system: 71, position: 9 },
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
    // Returns: { found: true, fleetUrl: "/fleet?x=6&y=84&z=17&mission=12" } or { found: false }
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

        // ── Method 1: a.btn-asteroid or mission=12 link (direct fleet URL) ──
        const asteroidLink = item.querySelector("a.btn-asteroid, a[href*='mission=12']");
        if (asteroidLink) {
          const href = asteroidLink.getAttribute("href") || "";
          const timer = item.querySelector("[data-asteroid-disappear]");
          const timeLeft = timer?.textContent?.trim() || "?";
          log(`ASTEROID FOUND! Fleet URL: ${href} | Timer: ${timeLeft}`, "success");
          return { found: true, fleetUrl: href };
        }

        // ── Method 2: data-asteroid-disappear timer element ──
        const timerEl = item.querySelector("[data-asteroid-disappear]");
        if (timerEl) {
          log(`ASTEROID FOUND (timer attr)! ${timerEl.textContent.trim()}`, "success");
          const urlMatch = window.location.href.match(/[?&]x=(\d+).*?[?&]y=(\d+)/);
          const reconstructed = urlMatch
            ? `/fleet?x=${urlMatch[1]}&y=${urlMatch[2]}&z=17&mission=12`
            : null;
          return { found: true, fleetUrl: reconstructed };
        }

        // ── Method 3: text-based — timer pattern (MM:SS) in row 17 ──
        const rowText = (item.textContent || "").replace(/\s+/g, " ").trim();
        const timerMatch = rowText.match(/\((\d{1,2}:\d{2})\)/);
        if (timerMatch) {
          const urlMatch = window.location.href.match(/[?&]x=(\d+).*?[?&]y=(\d+)/);
          const reconstructed = urlMatch
            ? `/fleet?x=${urlMatch[1]}&y=${urlMatch[2]}&z=17&mission=12`
            : null;
          log(`ASTEROID FOUND (text timer)! Timer: ${timerMatch[1]}, url: ${reconstructed}`, "success");
          return { found: true, fleetUrl: reconstructed };
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

    // ── Build scan queue: all systems in all ranges, sorted ascending ──
    // Whole galaxy is within ~15min flight from base 6:71, so no flight
    // filter is applied here — dispatch-time check is the hard safety.
    // Sort is always ascending by galaxy+system so the scan walks systems
    // from low to high, regardless of where the base planet sits.
    buildScanQueue(ranges) {
      const seen = new Set();
      const queue = [];
      for (const range of ranges) {
        for (let s = range.startSystem; s <= range.endSystem; s++) {
          const key = `${range.galaxy}:${s}`;
          if (seen.has(key)) continue;
          seen.add(key);
          queue.push({ galaxy: range.galaxy, system: s });
        }
      }
      queue.sort((a, b) => a.galaxy - b.galaxy || a.system - b.system);
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

    // Calibrated against live game: distance 428 sys (6:71 → 6:499) ≈ 15min.
    // Formula: ceil(distance / 29). Used only as sanity cap at dispatch time.
    estimateFlightMinutes(systemDistance) {
      return Math.max(1, Math.ceil(systemDistance / 29));
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
    markFound(state, galaxy, system) {
      state.foundAsteroid = { galaxy, system, position: 17, label: `[${galaxy}:${system}:17]` };
      // Don't set active=false — scan should resume after dispatch
      this.save(state);
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
            log(`Scan cooldown: ${waitMin}min remaining (full scan found nothing)`, "delay");
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

      // NOTE: Do NOT clear DispatchedAsteroids here. Its own 1h TTL handles
      // expiry. Clearing on every scan caused double-dispatch when a new scan
      // started within the window (e.g. after a quick no-asteroid scan).

      // Deep fetch — scanRangesFull() does N calls because the AJAX endpoint
      // returns a random subset per call.
      const ranges = await AsteroidScanner.scanRangesFull(6);
      GM_setValue("ogamex_last_deep_fetch_at", String(Date.now()));

      if (ranges.length === 0) {
        log(`Deep fetch returned no ranges — nothing to scan`, "asteroid");
        return;
      }
      log(`Collected ${ranges.length} unique ranges from deep fetch`, "asteroid");

      // Miners launch from a single fixed base planet
      const base = CONFIG.asteroidMining.minerBase;
      if (!base) {
        log("No minerBase configured — dispatch will fail until one is set", "warn");
      }

      // Build scan queue — all systems in all ranges, sorted ascending
      const queue = AsteroidScanner.buildScanQueue(ranges);
      if (queue.length === 0) {
        log("Empty scan queue — no systems in returned ranges", "error");
        return;
      }

      const first = queue[0];
      const preview = queue.slice(0, 5)
        .map(q => `[${q.galaxy}:${q.system}]`)
        .join(", ");
      log(
        `Scan queue: ${queue.length} systems across ${ranges.length} ranges (ascending). ` +
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
          const fullQueue = AsteroidScanner.buildScanQueue(freshRanges);
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

        // Current still valid — rebuild queue so new (often lower) ranges get
        // scanned immediately after we finish this system.
        const scannedSet = new Set((scanState.scannedSystems || []).map(s => `${s.galaxy}:${s.system}`));
        const freshQueue = AsteroidScanner.buildScanQueue(freshRanges)
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
            const scanDelay = 500 + Math.random() * 800;
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
        DispatchedAsteroids.add(current.galaxy, current.system);

        if (result.fleetUrl) {
          // Direct fleet URL available — navigate to fleet page
          log(`Direct dispatch via: ${result.fleetUrl}`, "asteroid");
          // Advance scan state (don't clear) so after dispatch bot resumes from next system
          ScanState.advance(scanState);
          GM_setValue("pending_mission", JSON.stringify({
            type: "asteroid_mining_direct",
            fleetUrl: result.fleetUrl,
            shipType: "ASTEROID_MINER",
            quantity: CONFIG.asteroidMining.minersPerMission,
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
        ScanState.markFound(ScanState.load(), current.galaxy, current.system);
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
      const scanDelay = 250 + Math.random() * 400;
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

      log(`Dispatching to ${asteroid.label} from base [${base.galaxy}:${base.system}:${base.position}] (~${estMinutes}min)`, "asteroid");

      // Use direct fleet URL with mission pre-set (same as asteroid link)
      const fleetUrl = `/fleet?x=${asteroid.galaxy}&y=${asteroid.system}&z=17&mission=12`;
      GM_setValue("pending_mission", JSON.stringify({
        type: "asteroid_mining_direct",
        fleetUrl,
        shipType: "ASTEROID_MINER",
        quantity: CONFIG.asteroidMining.minersPerMission,
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
      return;
    }

    // Expire old missions (>5 minutes)
    if (Date.now() - mission.timestamp > 5 * 60 * 1000) {
      log("Pending mission expired, clearing", "warn");
      GM_setValue("pending_mission", null);
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

        // ── Helper: after dispatch, decide whether to resume scan or wait ──
        // dispatchOk=true: fleet sent, all miners gone → stop scanning, wait for return
        // dispatchOk=false: dispatch failed → resume scan (try next asteroid)
        const finishDispatch = async (dispatchOk) => {
          GM_setValue("pending_mission", null);
          if (dispatchOk) {
            // All miners sent — wait for fleet to return before scanning again
            const returnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
            if (!returnAt || returnAt < Date.now()) {
              // No return time set yet — use captured flight time or fallback
              if (capturedFlightMs > 0) {
                const rt = Date.now() + capturedFlightMs * 2 + 60000;
                GM_setValue("ogamex_fleet_return_at", String(rt));
                log(`All miners dispatched. Return in ~${Math.ceil((capturedFlightMs * 2 + 60000) / 60000)}min (from flight time)`, "asteroid");
              } else {
                const fallbackMs = CONFIG.asteroidMining.maxFlightMinutes * 2 * 60 * 1000;
                GM_setValue("ogamex_fleet_return_at", String(Date.now() + fallbackMs));
                log(`All miners dispatched. Estimated return in ~${CONFIG.asteroidMining.maxFlightMinutes * 2}min`, "asteroid");
              }
            } else {
              const minLeft = Math.ceil((returnAt - Date.now()) / 60000);
              log(`All miners dispatched. Scan paused ~${minLeft}min until fleet returns.`, "asteroid");
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
          // Send all available miners (0 = all)
          const toSend = mission.quantity > 0 ? Math.min(mission.quantity, available) : available;

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
    if (!CONFIG.enabled) return;

    // Handle any pending multi-page mission first
    await handlePendingMission();

    // Sleep check
    if (AntiDetection.isSleepTime()) {
      log("Night mode active - sleeping until " + CONFIG.antiDetection.sleepEndHour + ":00 UTC", "delay");
      return;
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
          right: 10px;
          width: 320px;
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
        </div>

        <div class="section ${CONFIG.expeditions.enabled ? "active" : "inactive"}" id="ogx-expo-section">
          <div class="section-title">
            <span>Expeditions</span>
            <button class="mini-btn" id="ogx-expo-toggle">${CONFIG.expeditions.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-expo-status">Idle</div>
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
          <button class="mini-btn" id="ogx-scan-now" style="margin-right:4px">Scan Asteroids</button>
          <button class="mini-btn" id="ogx-send-expo">Send Expedition</button>
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

    document.getElementById("ogx-expo-toggle").addEventListener("click", () => {
      CONFIG.expeditions.enabled = !CONFIG.expeditions.enabled;
      saveConfig(CONFIG);
      const btn = document.getElementById("ogx-expo-toggle");
      btn.textContent = CONFIG.expeditions.enabled ? "ON" : "OFF";
      const section = document.getElementById("ogx-expo-section");
      section.className = `section ${CONFIG.expeditions.enabled ? "active" : "inactive"}`;
      log(`Expeditions ${CONFIG.expeditions.enabled ? "enabled" : "disabled"}`, "info");
    });

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
            log(`Dispatching fleet via: ${result.fleetUrl}`, "asteroid");
            const url = window.location.href;
            const gMatch = url.match(/[?&]x=(\d+)/);
            const sMatch = url.match(/[?&]y=(\d+)/);
            const galaxy = gMatch ? parseInt(gMatch[1]) : 0;
            const system = sMatch ? parseInt(sMatch[1]) : 0;
            DispatchedAsteroids.add(galaxy, system);
            GM_setValue("pending_mission", JSON.stringify({
              type: "asteroid_mining_direct",
              fleetUrl: result.fleetUrl,
              shipType: "ASTEROID_MINER",
              quantity: CONFIG.asteroidMining.minersPerMission,
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

    document.getElementById("ogx-send-expo").addEventListener("click", () => {
      ExpeditionManager.run();
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

    // ── Handle fleetSendSuccessfully page (race condition fix) ──
    // When "Send fleet" is clicked, OGameX navigates the browser to this URL
    // BEFORE our JS finishDispatch() can run, so pending_mission is never cleared.
    // Fix it here — immediately clear pending_mission and foundAsteroid so that
    // the scheduled handlePendingMission below is a no-op (won't attempt re-dispatch).
    if (window.location.href.includes("fleetSendSuccessfully")) {
      GM_setValue("pending_mission", null);
      const afterDispatchState = ScanState.load();
      if (afterDispatchState) {
        afterDispatchState.foundAsteroid = null;
        ScanState.save(afterDispatchState);
      }
      log("Fleet sent — dispatch state cleaned up. Scan paused until fleet returns.", "asteroid");
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
      } else if (hasAsteroidFleet || (justSentFleet && storedReturnAt && storedReturnAt > Date.now())) {
        // Asteroid fleet IS active — always (re)compute timer from page header
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
          // Can't parse countdown, but we have a valid stored timer — keep it
          const minLeft = Math.ceil((storedReturnAt - Date.now()) / 60000);
          log(`Asteroid fleet active, can't parse countdown. Using stored timer (~${minLeft}min).`, "asteroid");
        } else {
          // Asteroid fleet active but no countdown and no timer — pessimistic fallback
          const fallbackMs = CONFIG.asteroidMining.maxFlightMinutes * 2 * 60 * 1000;
          GM_setValue("ogamex_fleet_return_at", String(Date.now() + fallbackMs));
          log(`Asteroid fleet active but no countdown found. Estimated ~${CONFIG.asteroidMining.maxFlightMinutes * 2}min wait.`, "asteroid");
        }
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
  }

  init();
})();
