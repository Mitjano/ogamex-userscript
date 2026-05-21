# OGameX Assistant — Userscript

Tampermonkey userscript for [OGameX](https://ogamex.net) — automates asteroid mining and expeditions across all universes (`athena`, `nexus`, etc.).

## Install

Click [**ogamex-bot.user.js**](https://raw.githubusercontent.com/Mitjano/ogamex-userscript/main/ogamex-bot.user.js) with Tampermonkey installed. Tampermonkey will detect the userscript metadata and offer to install.

## Auto-update

`@updateURL` points to this repo. Tampermonkey checks for new versions periodically — no manual reinstall needed.

## Source

This repo is the **public mirror** for auto-update only. Active development lives in private repo. Versions here are published-ready (no secrets).

## Features

- Asteroid Mining: scan galaxies, find asteroids in range, dispatch ASTEROID_MINER fleet
- Expeditions: auto-send fleet exploration
- Anti-detection: random delays, night mode, jitter, rate limiting
- Persistent state across browser reloads (Tampermonkey GM_setValue)
- Multi-universe: each universe gets isolated config + scan state
