# OGameX Assistant — instrukcje dla Claude Code

**Dwa skrypty, dwa uniwersa. Push na `main` = auto-deploy; bump `// @version` przy KAŻDEJ zmianie.**

| plik | uni | stan | uwaga |
|---|---|---|---|
| `ogamex-3.user.js` | **genesis.ogamex.net** | **AKTYWNY ROZWÓJ** (v3.101.1, ~6,7k linii) | tu idzie cała nowa praca; profil gracza: ODKRYWCA; gra chodzi w **Chrome** (od 09.09) |
| `ogamex-bot.user.js` | athena.ogamex.net | zamrożony (v2.111.8, 16,5k linii) | konto na urlopie; ruszać tylko na wyraźną prośbę |

- Genesis ma **fleet speed x3** (Athena x4) — loty są dłuższe. Bot **nigdy nie liczy czasu lotu ze wzoru**, tylko czyta „Duration of flight" z formularza; każda nowa decyzja zależna od czasu lotu ma to robić tak samo.
- Serwer: fork **.NET**, nie Laravel `lanedirt/OGameX`. Nie budować na endpointach niepotwierdzonych na żywo; nowy markup najpierw zrzuć do logu (`[... DOM]`), potem parser.
- Język: polski (logi, commity, dokumenty). Użytkownik = obrońca; **obrona floty ma bezwzględny priorytet nad ekonomią**.
- Przy fałszywym alarmie prosić o ZRZUT EKRANU paska misji, nie o log.
- **Opis lotu (`m.why`) bywa KONTRAKTEM między modułami, nie tylko tekstem do logu.** `Fly` rozpoznaje po nim falę biorącą cały hangar (fraza „cały hangar") i dopiero wtedy odprowadza operatora na jego stronę. Zmiana brzmienia komunikatu w `expoPlan` po cichu zabiła odprowadzanie w v3.101.0 — złapało to E2E sc. 36. Przed zmianą tekstu: `grep` po frazie.
- **Rozmiar fali ekspedycji (v3.101.0):** udział jednej fali = `(hangar + flota w powietrzu z tej bazy) / min(fale, sloty expo)`. NIE `hangar / wolne sloty` i NIE „ostatni wolny slot bierze wszystko" — ta reguła zlepiała fale trwale i zabijała jeden slot. Szczegóły i symulacje: HANDOFF sekcja 19 i 19a. Niepełny rejestr powrotów skalujemy liczbą lotów z GRY (`expo.used`), nigdy licznikiem serii — ten liczy fale wysłane, nie te w powietrzu.
- **Lista `expo.excludeTypes` jest WŁASNOŚCIĄ KODU** (`pinCodeOwned`), bo `saveCfg` zapisuje cały CFG i schowek z poprzedniej wersji nadpisałby ją na zawsze (panel nie ma pola, żeby to odkręcić). Stan na v3.100.0: w domu zostają minery, kolonizatory, GŚ, recyklery, avatary i **sondy**; **light i heavy cargo LECĄ na ekspedycje** (owner 19.09 cofnął wykluczenia z 07.09 i 16.09). Nie „przywracać" starej listy z pamięci — historia jest w komentarzu przy `DEFAULTS`.

## 3.0 (Genesis) — architektura, której trzeba się trzymać
Kolejność czytania: `START-3.0.md` → `AUDYT-3.0-2026-08-28.md` → kod.
1. **Parsery** (`PlanetBar`, `Bar`, `Rows`, `Hangar`) — przeniesione z 2.x, sprawdzone bojowo. Zmieniać tylko z dowodem z żywej gry.
2. **`Situation`** — JEDNO źródło prawdy (pary, hangary, zagrożenia, własne loty, loty bota) w jednym kluczu. Nie dokładać rozproszonych kluczy stanu — to był grzech 2.x (193 klucze).
3. **`decide(situation, cfg, now)`** — CZYSTA funkcja: bez DOM, bez GM, bez `Date.now()`. Każda zmiana zachowania obrony = zmiana tutaj + nowy przypadek w `test3-decide.js`.
4. **`Fly`** — JEDEN wykonawca wszystkich lotów (ratunek, FS, ekspedycja, mining, złom) sterowany polami misji: `plan` (statki), `missionType` (DEPLOY/EXPEDITION/ASTEROID/COLLECT), `takeResources`, `duration`, `toBody` (planet/moon/debris).
5. **Ekonomia** (`Expo`, `Aster`, `Debris`) — wołana TYLKO gdy obrona nie ma nic do roboty; jej loty **nie trafiają** do `situation.flights`, bo to stan obrony. Pyta `Human.economyAllowed()`; obrona nigdy nie pyta.

6. **Żadna nawigacja bota nie może być cicha ani nieograniczona** (incydent 28.08 22:17): każde `location.replace` idzie przez `Nav.go(url, why)`, który zapisuje POWÓD i **wymusza zapis logu** (debounce 800 ms kasował powody przy przeładowaniu — w logu zostawały same linie startowe). Każda pętla nawigacji ma sufit: misja 6 nawigacji bez otwarcia formularza, wejście na Fleet przy alarmie 3 próby, ekonomia respektuje karencję `fly_block` po abortcie. Linia startowa mówi, na jakiej stronie jesteś i kto Cię tam przywiódł; ≥5 startów/min = `[TEMPO]` w logu.
7. **Żaden wpis stanu nie może być wieczny.** Każde pole (`pending`, `flights`, `fly_block`, `bar`, `slots`) ma termin ważności — wpis bez terminu zamienia się w ciche wyłączenie obrony (defekt P0, 28.08). Jedna definicja „ten lot już nic nie znaczy" = `flightStale()`; używają jej obrona, ekonomia i rekonesans.
8. **Ekonomia nigdy nie stoi na drodze ratunku** — trwająca ekspedycja/mining/złom jest przerywana przy alarmie, a jej loty nie trafiają do `situation.flights`.

Reguły twarde: dom = księżyc, gdy para go ma · nic nie leci NA atakowane ciało · **KAŻDA flota pod uderzeniem dostaje własny ratunek** (reguła „jedna ucieczka na parę" obowiązywała do v3.74 i 10.09 kosztowała ~152 mln statków — nie przywracać jej w żadnej postaci) · **stan lotu zamyka hangar, nie zegar** · nieznany markup → zrzut, nie zgadywanie · **kanał push budzi TYLKO obroną** — kłopoty ekonomii mają rodzaj „EKO" (v3.77.0), bo kanał pełen nieszkodliwych alarmów przestaje być czytany.

## Testy
- 3.x: `node test3-all.js` (decyzyjne + macierz bojowa 672 + war-game + E2E na sztucznej grze w jsdom + panel + zegar + składnia). Wymaga `npm install jsdom` w katalogu repo (node_modules nie jest commitowane). **Nowe zachowanie obrony = nowy scenariusz w `test3-e2e.js`**, nie tylko regex w `test3-decide.js` — regexy pilnują, żeby poprawka nie zniknęła, ale niczego nie wykonują. **Pipe zjada kod wyjścia** — sprawdzaj `echo $?` bez pipe'a (27.08 v2.108.0 poszła na produkcję z czerwonym testem przez `| tail -1`).
- **Wolniejsza maszyna (laptop Windows): `OGX_SETTLE_MS=400 node test3-all.js`.** Harness E2E po każdym ticku czeka stałe 140 ms realnego czasu na osadzenie się asynchronicznej pracy bota; na laptopie to za mało i losowe scenariusze (8, 34, 39, 41, 47, 57…) mrugają czerwono — z oknem 400 ms ten sam kod przechodzi w całości (14.09, cztery przebiegi kontrolne, także na v3.95.1). Na Macu domyślne 140 ms zostaje. Czerwone E2E o ZMIENNYM zbiorze scenariuszy = najpierw sprawdź okno, dopiero potem szukaj regresji.
- Trzy AUTOMATY-kontrakty (właściciel 14.09: „pilnuj, żeby przy update tego nie popsuć"): macierz `test3-matrix.js` 672/672, blok 77 w `test3-decide.js` (noc 13.09: 6/6 ratunków i pushy), E2E 60b/43b/43c.
- 2.x: `node test-all.js` (24 zestawy, wycinają funkcje po DOKŁADNEJ sygnaturze).

## Historia i kontekst
- **`HANDOFF-2026-09-14.md` — CZYTAĆ NAJPIERW** (sekcja 8 = sesja popołudniowa 14.09 na Windows, v3.96.0: Sekcje 9–18 = 14–19.09 (przenosiny, noc, v3.96.1–3.100.0; 17 = fala domykająca bierze cały hangar z formularza + podejrzenie drugiego bota; 15 = fork wysyła mniej, niż wpisano, ekspedycje bez sond i LC; 16 = osłona przełączników panelu, lądowanie w trakcie wysyłki; **18 = v3.100.0, transportery WRACAJĄ na ekspedycje; 19 = v3.101.0, rozmiar fali z CAŁEJ floty + moja pomyłka w diagnozie**); odczyt stanu z Chrome na Macu: `tools/mac_chrome_state.py`.
  zamknięte cztery P0 warstwy wykonawczej i cztery P0 odbudowy księżyca, lekcje o harnessie E2E).
  Pełny stan po dwóch dobach obrony floty:
  dwa incydenty (strata uniknięta ręcznie 13.09, nalot na trzy księżyce 14.09), wszystko, co
  poszło na produkcję v3.86→v3.95.3, TRZY AUTOMATY, których nie wolno popsuć (macierz 672
  scenariuszy, odtworzona noc 13.09, E2E fal wracających), zasady pracy z tej sesji, lista
  otwartych P0/P1 i ścieżki odczytu stanu bota **na Windows**.
- `AUDYT-ODBUDOWY-2026-09-14.md` — 16 zweryfikowanych znalezisk w łańcuchu odbudowy księżyca.
- `HANDOFF-2026-09-11.md` — poprzedni stan (11–13.09).** Stan po naprawach 09–11.09 (v3.73–v3.76),
  przesiadka na Chrome, lista rzeczy OTWARTYCH (m.in. temat ntfy, przez który alarmy nie
  dochodzą na telefon) i temat na dalej: obrona przed zniszczeniem księżyców [2:224:7]
  i [2:224:10]. Zawiera też dwie moje pomyłki z tych dni, żeby ich nie powtórzyć.
- `STAN-I-PLAN.md` — dziennik 2.x (ostatnie sekcje = 27.08: brama, ucieczka na sąsiedni księżyc, pamięć ataku, 7 błędów stanu).
- `AUDYT-3.0-2026-08-28.md` — dlaczego 3.0 i co przenosimy.
- `AUDYT-3.x-2026-08-29.md` — pełny audyt czterech warstw (obrona/ekonomia/testy/panel) z listą otwartych P0.
- `AUDYT-FLOTA-2026-08-29.md` — audyt zarządzania flotą: lekcje Atheny (A1–A9/Z1–Z10) skonfrontowane z 3.x.
- Audyty 2.x: `AUDYT-HUBY-2026-08-27.md`, `AUDYT-HUBY-2-OBRONA-2026-08-27.md`, `MOON-STRATEGY-2026-08-26.md`.
- Fakty o forku (potwierdzone zrzutami): panel **Events i pasek misji są GLOBALNE** (wszystkie kolonie), lista `/home/fleetmovementlist` pokazuje tylko aktywną parę · wiersz ACS ma „Players: 1/2" zamiast źródła, więc jedyna współrzędna to CEL · przełącznik ciała celu to `data-planet-type` (1=planeta, 2=księżyc) · misja „stacjonuj" to `.mission-item.DEPLOY` · zawrót to `a.x_btn_fleet_return` · czas lotu: „Duration of flight … MM:SS" (ponad dobę: „1d 08:41:48") · **formularz floty: pola celu `#fleet2_target_x/y/z` są wypełnione Z URL-a, więc bywają w DOM-ie już na kroku 1 — nie są dowodem, że krok 2 wstał; przycisk „Next" kroku 1 leży POZA `#content`, więc przeżywa czyszczenie kontenera pod render kroku 2 (v3.99.3)** · **napis „Duration of flight” jest na stronie już na kroku 1 (bez czasu) — dowodem kroku 2 jest dopiero czas lotu > 0; odmowa gry to okno sweetalert2 (`.swal2-popup`, tytuł „Error”, np. „Ships not found.” po Next kroku 1) — kroku 2 wtedy nie ma (v3.99.4)**.
