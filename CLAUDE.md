# OGameX Assistant — instrukcje dla Claude Code

**Dwa skrypty, dwa uniwersa. Push na `main` = auto-deploy; bump `// @version` przy KAŻDEJ zmianie.**

| plik | uni | stan | uwaga |
|---|---|---|---|
| `ogamex-3.user.js` | **genesis.ogamex.net** | **AKTYWNY ROZWÓJ** (v3.10.3, ~1600 linii) | tu idzie cała nowa praca; profil gracza: ODKRYWCA |
| `ogamex-bot.user.js` | athena.ogamex.net | zamrożony (v2.111.8, 16,5k linii) | konto na urlopie; ruszać tylko na wyraźną prośbę |

- Serwer: fork **.NET**, nie Laravel `lanedirt/OGameX`. Nie budować na endpointach niepotwierdzonych na żywo; nowy markup najpierw zrzuć do logu (`[... DOM]`), potem parser.
- Język: polski (logi, commity, dokumenty). Użytkownik = obrońca; **obrona floty ma bezwzględny priorytet nad ekonomią**.
- Przy fałszywym alarmie prosić o ZRZUT EKRANU paska misji, nie o log.

## 3.0 (Genesis) — architektura, której trzeba się trzymać
Kolejność czytania: `START-3.0.md` → `AUDYT-3.0-2026-08-28.md` → kod.
1. **Parsery** (`PlanetBar`, `Bar`, `Rows`, `Hangar`) — przeniesione z 2.x, sprawdzone bojowo. Zmieniać tylko z dowodem z żywej gry.
2. **`Situation`** — JEDNO źródło prawdy (pary, hangary, zagrożenia, własne loty, loty bota) w jednym kluczu. Nie dokładać rozproszonych kluczy stanu — to był grzech 2.x (193 klucze).
3. **`decide(situation, cfg, now)`** — CZYSTA funkcja: bez DOM, bez GM, bez `Date.now()`. Każda zmiana zachowania obrony = zmiana tutaj + nowy przypadek w `test3-decide.js`.
4. **`Fly`** — JEDEN wykonawca wszystkich lotów (ratunek, FS, ekspedycja, mining, złom) sterowany polami misji: `plan` (statki), `missionType` (DEPLOY/EXPEDITION/ASTEROID/COLLECT), `takeResources`, `duration`, `toBody` (planet/moon/debris).
5. **Ekonomia** (`Expo`, `Aster`, `Debris`) — wołana TYLKO gdy obrona nie ma nic do roboty; jej loty **nie trafiają** do `situation.flights`, bo to stan obrony. Pyta `Human.economyAllowed()`; obrona nigdy nie pyta.

6. **Żaden wpis stanu nie może być wieczny.** Każde pole (`pending`, `flights`, `fly_block`, `bar`, `slots`) ma termin ważności — wpis bez terminu zamienia się w ciche wyłączenie obrony (defekt P0, 28.08). Jedna definicja „ten lot już nic nie znaczy" = `flightStale()`; używają jej obrona, ekonomia i rekonesans.
7. **Ekonomia nigdy nie stoi na drodze ratunku** — trwająca ekspedycja/mining/złom jest przerywana przy alarmie, a jej loty nie trafiają do `situation.flights`.

Reguły twarde: dom = księżyc, gdy para go ma · nic nie leci NA atakowane ciało · jedna ucieczka na parę · **stan lotu zamyka hangar, nie zegar** · nieznany markup → zrzut, nie zgadywanie.

## Testy
- 3.x: `node test3-all.js` (164 asercje decyzyjne + 77 sprawdzeń E2E / 24 scenariusze na sztucznej grze w jsdom + składnia). **Nowe zachowanie obrony = nowy scenariusz w `test3-e2e.js`**, nie tylko regex w `test3-decide.js` — regexy pilnują, żeby poprawka nie zniknęła, ale niczego nie wykonują. **Pipe zjada kod wyjścia** — sprawdzaj `echo $?` bez pipe'a (27.08 v2.108.0 poszła na produkcję z czerwonym testem przez `| tail -1`).
- 2.x: `node test-all.js` (24 zestawy, wycinają funkcje po DOKŁADNEJ sygnaturze).

## Historia i kontekst
- `STAN-I-PLAN.md` — dziennik 2.x (ostatnie sekcje = 27.08: brama, ucieczka na sąsiedni księżyc, pamięć ataku, 7 błędów stanu).
- `AUDYT-3.0-2026-08-28.md` — dlaczego 3.0 i co przenosimy.
- Audyty 2.x: `AUDYT-HUBY-2026-08-27.md`, `AUDYT-HUBY-2-OBRONA-2026-08-27.md`, `MOON-STRATEGY-2026-08-26.md`.
- Fakty o forku (potwierdzone zrzutami): panel **Events i pasek misji są GLOBALNE** (wszystkie kolonie), lista `/home/fleetmovementlist` pokazuje tylko aktywną parę · wiersz ACS ma „Players: 1/2" zamiast źródła, więc jedyna współrzędna to CEL · przełącznik ciała celu to `data-planet-type` (1=planeta, 2=księżyc) · misja „stacjonuj" to `.mission-item.DEPLOY` · zawrót to `a.x_btn_fleet_return` · czas lotu: „Duration of flight … MM:SS".
