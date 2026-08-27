# Audyt: ekspedycje z 2–3 księżyców-hubów (27.08.2026, v2.106.2)

Cel: flota podzielona na 2–3 księżyce („huby”), fale ekspedycji rotują między nimi, każdy hub ma własny FS i własną obronę. Motyw: snajperka po zniszczeniu księżyca (fale wracają na planetę) — z 3 hubami napastnik musi zniszczyć 3 księżyce (3× 500 mld GŚ, każda misja z 38–47 % ryzykiem utraty wszystkich GŚ).

Trzy niezależne przeglądy kodu (ekspedycje, FS, obrona/paliwo). Numery linii wg v2.106.2.

## 0. Werdykt w jednym akapicie
Rotacja fal między hubami jest **tania** (dyspozytor już niesie `launchAt` z ciałem, cel = poz. 16 układu hubu, rozmiar fali liczony z hangaru ciała startu). FS per hub jest **średni** (stan FS to jeden lot — trzeba mapy po hubie). Prawdziwy koszt to **obrona**: straż (`ogamex_moonsave_watch`) jest JEDNYM rekordem = jedna pilnowana para; zamiatanie wracających fal działa tylko dla pary strzeżonej; `DefenceHold` jest globalny; ucieczka w powietrze to jeden lot; brama tylko dla pary aktywnej. **Bez przebudowy obrony huby 2–3 są chronione słabiej niż dziś baza** (pierwszy ratunek z kolejki tak, zamiatanie fal i skok bramą — nie). Dlatego kolejność: najpierw obrona per para, potem rotacja i FS.

## 1. Ekspedycje — co jest, co trzeba zmienić
Jest: `mission.launchAt {g,s,p,body}` + korekta pary w formularzu (L11211–11252), cel `z=16` układu hubu (L9691), rozmiar fali z hangaru ŻYWEGO ciała startu (L9612), bramka duplikatu celu wyłączona dla ekspedycji.
Do zmiany:
- `CONFIG.expeditions.launchFrom` → lista `hubs[]` (L250), `HomeBase.expo(i)`/`forModule` z ciałem per hub (L4799–4812), `ExpeditionRunner.base()/fleetUrl()` wg kursora rotacji (L9682–9698), `afterSend()` przesuwa kursor tylko po POTWIERDZONEJ wysyłce (L9843).
- **Rozmiary fal per hub**: `burst.sizes/sent`, `roster`, `inAir()` (L9557–9596, L9660–9666) są jednym cache bez koordów — fala hubu B byłaby liczona z hangaru hubu A, a globalny licznik slotów „w powietrzu” dublowany. Reset bursta przy `slots.used===0` (L9786) — per hub.
- Sloty (14) i zegar odstępu fal są globalne (L9701–9749) — podział: fale idą po kolei A,B,C, wspólny zegar wystarczy.
- `Fuel.allows("ekspedycje")` (L9763) czyta deuter ciała, które AKURAT jest na ekranie, PRZED przełączeniem hubu → fałszywe blokady/przepuszczenia. Przenieść bramkę za przełączenie (przy `select_ships_direct`) albo dodać mapę deuteru per koordy (jak `ogamex_hangar_map`).
- `DebrisCollector.base()` (L5100, L5181): złom po ekspedycjach leży w 2–3 układach — dziś odwiedza jeden.
- `FleetRecon.fleetHome()/homeGuard()` (L10059–10094): „dom floty” = jedno pole; przy 3 wyrównanych hubach werdykt = null i stały fałszywy alarm `[DOM FLOTY]`. Dom → ZBIÓR hubów.
- Panel: `ogx-expo-from` (L14068) parsuje jedną koordę; status pokazuje jeden start.

## 2. FS — jeden lot → mapa lotów
Jest: `KEY_T` (czasy lotu) już kluczowany po trasie start→cel@prędkość; planer 2T i łańcuch rund per obiekt stanu; `switch_to_body` potrafi przełączyć na dowolną parę.
Do zmiany:
- `ogamex_fs_state` → mapa `{ "g:s:p": {phase, sentAt, flightMs, recallAt, returnAt, from, to, fleetId} }` z migracją starego kształtu (L5371–5376).
- `routeKey/flightMs/noteFlightMs` z jawnym startem (dziś: ciało aktywne, L5391–5412); `plan(hub)`, `describe(hub)`, `launch({hub})`, `markLaunched` po `pm.atCoords`.
- **`fleetId` musi być zapisany** (dziś lokalny, L5670) — przy 2–3 lotach na ten sam cel dopasowanie po tekście koordów (`_findOurRow`, L5626) jest niejednoznaczne; weryfikacja po zawróceniu (L5784) woła `_findOurRow` bez `st` → bierze starą bazę (utajony błąd, przy hubach fatalny).
- Klucze pauz globalne → z sufiksem hubu: `ogamex_fs_fail_at`, `_measure_at`, `_body_warn_at`, `_wait_said/why` (pusty hangar hubu B pauzowałby hub A).
- `_recalling` (mutex) i budżet nawigacji `/fleet` (L5772) per hub; zawracania wielu hubów w jednej wizycie na `/fleet`.
- `tick()` (L5485) → pętla po hubach: bramki globalne raz (alarm/straż/pending), bramki per hub osobno, kolejka startów (jeden hub w formularzu naraz; 3 huby ≈ kilka minut dryfu — `markLaunched` liczy zawrócenie od realnego startu, więc dryf jest samokorygujący).
- Bramka „aktywne ciało musi być księżycem” (L5545) → „przełącz na hub X i sprawdź, że to księżyc”.
- Globalne zostają: cel, godzina powrotu, prędkość, wykluczenia. UI: wiersz statusu per hub. `running` (L5483) to martwy kod.

## 3. Obrona — najdroższa część
Co działa dla wielu par: detekcja per cel (`targets[]`, `targetBodiesAll`, `attackBodiesFor(key)`), pamięci per koordy (`ogamex_atk_until_map`, `ogamex_atk_body_*`, `ogamex_gate_fail_*`, `ogamex_airsave_fail`, `ogamex_hangar_map`), `switchTo/resumeAfterSwitch` + `pairAnchor`, `RescueQueue` (ratuje 2–5 kolonii per alarm, powroty szeregowo), `MoonRebuild` per para.
Co się łamie:
1. **Jedna straż** (`ogamex_moonsave_watch`, L8403–8427): hub B atakowany przy strzeżonym A dostaje JEDEN ratunek z kolejki i nic więcej — bez zamiatania fal, bez skoku ciał, bez eskalacji „oba ciała”, bez auto-powrotu aż A wróci (L15761).
2. **Zamiatanie tylko dla pary strzeżonej** (`keepPlanetEmpty` L8813, `OwnReturns.landingsAt(key)` L6027): fale lądujące na nieustrzeżonym hubie w trakcie alarmu NIE są zamiatane. To jest dokładnie scenariusz snajperki. `MAX_SAVES_PER_ALERT` per straż.
3. `targets[0]` przy pierwszym przebiegu (L8529): dwa huby trafione w tym samym ticku → drugi czeka tick i idzie słabszą ścieżką.
4. `DefenceHold` globalny (L3134): alarm na A zamraża ekspedycje/mining na B i C.
5. Paliwo bez pamięci per koordy (L3171–3201).
6. `fleetHome()` zakłada jeden dominujący hangar (L10105: ≥1e9 i ≥2× dom) — przy 3 równych hubach zwraca null → ślepe alarmy bronią jednego hubu.
7. AirSave = jeden lot globalnie (L6057); `refuge()` wyklucza tylko atakowaną parę (L6143) — może polecieć na hub, który też jest atakowany; ratunek z kolejki potrzebujący powietrza jest odrzucany, gdy powietrze zajęte (L9174).
8. GateSave: jeden rekord stanu, jeden `targetMoon`, skok tylko dla pary AKTYWNEJ, nigdy dla ratunku z kolejki (L9192–9207); `ogamex_gate_return_try` globalny.
9. `ogamex_atk_until`/`ogamex_atk_fuse` globalne; klucze `_sayOnce` bez koordów (komunikat o A wycisza identyczny o B na 5 min).

## 4. Plan wdrożenia (kolejność wg ryzyka)
**Etap A — obrona per para (fundament, ~2 sesje pracy, wysokie ryzyko regresji → symulator + testy):**
- straż jako mapa po `g:s:p` (`watchFor(key)`), `keepPlanetEmpty` w pętli po strażach, licznik zapisów per klucz;
- wszystkie `ev.targets` w pierwszym przebiegu; `DefenceHold` per para; `AirSave.refuge` wyklucza atakowane; brama także dla ratunku z kolejki (gdy hub aktywny da się przełączyć);
- `fleetHome` → zbiór hubów z konfiguracji; `_sayOnce`/fuse per koordy.
Efekt uboczny: naprawia dzisiejsze słabości przy ataku na 2 kolonie naraz — wart zrobienia niezależnie od hubów.

**Etap B — rotacja ekspedycji (~1 sesja, niskie ryzyko):** `hubs[]` w panelu, kursor rotacji, burst/roster per hub, bramka paliwa po przełączeniu, `DebrisCollector` po hubach, status per hub. Podział floty i deuteru: ręcznie bramą (2 skoki, cooldown 30–40 min) albo przycisk „Rozwieź flotę” Deployem księżyc→księżyc.

**Etap C — FS per hub (~1–2 sesje, średnie ryzyko):** mapa stanów, `fleetId`, klucze pauz per hub, kolejka startów, pętla zawracań na jednej wizycie `/fleet`, UI per hub.

**Etap D (opcja):** balansowanie hubów (bot sam przerzuca flotę/deuter), pamięć deuteru per koordy, rotacja celów FS.

## 5. Ryzyka i decyzje do podjęcia
- Bramy: skok ratunkowy zużywa cooldown hubu; rozwożenie floty robić Deployem, nie bramą.
- Cooldown bramy + Destroy na 2 huby naraz → drugi hub idzie Deployem na planetę (jak dziś).
- Testy offline wycinają funkcje po SYGNATURZE — każda zmiana sygnatury = poprawka testów (test-fale, test-zamiatanie, test-ucieczka, test-cel-ratunku, test-kolejka, test-ratunek-nietykalny).
- Do decyzji: koordy 2–3 hubów, cel FS (wspólny), czy Etap A ma iść pierwszy (rekomendacja: TAK).
