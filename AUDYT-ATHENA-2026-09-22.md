# AUDYT — powrót na Athenę z botem 3.x (2026-09-22)

**Pytanie ownera:** bot 3.x (`ogamex-3.user.js`) jest „Genesis only" — co trzeba dostosować,
żeby grać nim TAKŻE na `athena.ogamex.net`?

**Werdykt krótko:** architektura 3.x jest w ~90% gotowa na drugie uni od urodzenia
(izolacja magazynu per-host, raport startowy, czas lotu z formularza, parsery rodem z 2.x,
które było bojowe właśnie na Athenie). Twarde blokery to trzy rzeczy: `@match`,
etykieta „(Genesis)" zaszyta w pushach oraz **konflikt ze starym 2.x, który wciąż ma
`@match athena.ogamex.net/*`**. Do tego strażnik na Macu rozumie tylko jedno uni.
Zero zgadywania markupu: parsery potwierdza raport startowy na żywo (zasada z 02.08).

Założenie robocze: gra RÓWNOLEGLE na Genesis i Athenie (słowo „też" w zleceniu).
Jeśli docelowo tylko Athena, sekcja 3 (strażnik) upraszcza się do jednej zmiennej.

---

## 1. Co JUŻ działa bez zmian (fundamenty)

| Obszar | Dowód w kodzie | Uwagi |
|---|---|---|
| Izolacja magazynu per-uni | `S.get/set` → klucz `${HOST}:ogx3_${k}` (ogamex-3.user.js:52–54) | cfg, stan, loty, kalibracje — osobne dla athena/genesis. Lekcja v2.92 wbudowana od początku 3.x. |
| Blokada „jedna karta prowadzi" | `TabLock` na `localStorage` (:5834) | localStorage jest per-origin, więc karty dwóch uni NIE walczą o lock. |
| Parsery stron | nagłówek: „Parsery przeniesione z 2.x" | 2.x było bojowe NA Athenie; endpointy (`/home/fleetmovementlist`, `Partial_AsteroidJournal`, `messages/messagedata`) te same. |
| Czas lotu | czytany z formularza + `fsMeasured` per host | kalibracja na Athenie zrobi się sama (Genesis fleet 3x vs Athena — bez znaczenia). |
| Raport startowy | moduł `Calib` (:5128) | zaprojektowany DOKŁADNIE na wejście na nowe uni; `calib_done` jest per host, więc na Athenie odpali się sam. |
| Kanał alarmowy | `TOPIC` własnością kodu, wspólny ze strażnikiem (:214) | pushe z Atheny od razu trafią na telefon — bez pułapki „nowy losowy temat" z przesiadki na Chrome (09.09). |
| Mining asteroid | pozycja 17, `Partial_AsteroidLocation`, dziennik, locki (:3565–3688) | na Athenie mining był głównym przychodem (393 bln/d) — moduł jest, i to lepszy niż w 2.x (percentyl, loty równoległe). |
| Ekspedycje, złom, FS, obrona per-ciało, Impact/Clock, tryb cichy, księżyce | całość host-agnostyczna | `moonformation` w 3.x domyślnie OFF (wydaje surowce); selektory bramy NIE istnieją w 3.x (patrz sekcja 6). |

## 2. Zmiany KONIECZNE w kodzie (P0)

**P0-1. `@match` i metadane.** Linia 7 dopuszcza tylko `genesis.ogamex.net`. Dodać
`// @match https://athena.ogamex.net/*`; poprawić `@name`/`@description` („Genesis only" znika).

**P0-2. Etykieta uni w pushach.** „(Genesis)" jest zaszyte na sztywno w ~9 tytułach:
:161 (strażnik), :245–253 (ATAK / RATUNEK / FS / BŁĄD / SONDA / EKO / POWRÓT), :5145
(raport startowy). Temat ntfy jest WSPÓLNY dla obu uni, więc atak na Athenie krzyczałby
„⚔️ ATAK (Genesis)" — owner otwiera złą grę w momencie, gdy liczą się sekundy.
Fix: stała `UNI` z `HOST` (np. `athena`/`genesis` z pierwszego członu hosta) i podstawienie
we wszystkich tytułach. Testy do poprawki razem z kodem: `test3-decide.js:1293` asertuje
dosłowny tytuł `Raport startowy gotowy (Genesis)` (reszta trafień w testach to komentarze
i przykładowe stringi hdrSafe — nie blokują).

**P0-3. Rozbrojenie starego 2.x.** `ogamex-bot.user.js` (v2.111.8) ma
`@match https://athena.ogamex.net/*` i auto-update z TEGO SAMEGO repo. Jeśli jest nadal
zainstalowany w Tampermonkey (a był — Athena to jego uni), to pierwsze wejście na Athenę
obudzi DWA boty na jednej stronie: dwie pętle nawigacji, dwa wykonawcy lotów, walka o
formularz floty. To jest ta sama klasa incydentu co „dwie instancje bota" z 09.09, tylko
gorsza, bo w jednej karcie.
Minimum: owner wyłącza/odinstalowuje 2.x w Tampermonkey PRZED wejściem na Athenę.
Porządnie: bump 2.x w repo z neutralizacją (early-return z logiem „2.x wyłączony — Athenę
prowadzi 3.x") — wtedy auto-update rozbroi go na każdej maszynie (Mac, Windows, praca),
a nie tylko tam, gdzie owner pamiętał kliknąć.

## 3. Strażnik na Macu (P1 — konieczne przy grze równoległej)

Stan: `watchdog/ogx-watchdog.py` ma JEDEN globalny `last_hb` (:67) — puls dowolnej karty
zeruje licznik ciszy. Bot pinguje gołe `GET /hb` bez informacji o hoście (:121–122).
Restart otwiera jeden `GAME_URL` = genesis (:43).

Skutki przy dwóch uni naraz:
- karta Atheny umiera, Genesis dalej pinguje → strażnik MILCZY (dokładnie ślepota,
  która 08.09 kosztowała całą flotę, tylko per-uni);
- po restarcie przeglądarki strażnik otwiera tylko Genesis; Athena wraca wyłącznie,
  jeśli przeglądarka sama przywraca sesję (do sprawdzenia w ustawieniach Chrome).

Kierunek naprawy (do rozmowy przed wdrożeniem, nie wdrażać w ciemno):
puls z identyfikacją uni (`/hb?u=athena`), stan `last_hb` per uni, próg ciszy per uni,
restart z otwarciem OBU adresów. Uwaga na wsteczną zgodność: stary bot na drugiej
maszynie pinguje bez parametru.

Gra tylko na Athenie (bez Genesis): wystarczy `OGX_WD_URL=https://athena.ogamex.net/`
w env LaunchAgenta + reinstall (`watchdog/install.sh`), zero zmian w Pythonie.

## 4. Do potwierdzenia NA ŻYWO (zasada: żadnego parsera bez dowodu z gry)

Fork .NET jest ten sam dla obu uni, ale od 18.08 (porzucenie Atheny) mógł się zmienić —
a część selektorów 3.x powstała już PO przejściu na Genesis i na Athenie nigdy nie działała:

1. **Raport startowy** (planetBar / pasek misji / events / formularz floty) — pierwsza
   sesja na Athenie w trybie Obserwator, owner klika „Kopiuj raport startowy", porównujemy.
2. **Lista prędkości FS** — `FS_SPEEDS` (:6378) pochodzi ze zrzutu GENESIS 11.09
   (3 5 10 20…100). 2.x na Athenie używało 3% (maks FS ~29 h), więc pewnie identyczna,
   ale potwierdzić przy pierwszym pomiarze FS.
3. **Złom** — logika dymka (bez linku, misja kaflem „Recycle", ikonki zamiast etykiet,
   sklejone liczby) była kalibrowana na Genesis (v3.59–3.61). 2.x na Athenie miało w tej
   komórce LINK. Pierwszy zbiór PZ nadzorowany, patrzeć na `[ZŁOM]`.
4. **Asteroidy** — pozycja 17, modal „Find asteroids", `data-asteroid-disappear`:
   rodowód z 2.x/Athena, ale potwierdzić po miesiącu przerwy.
5. **Kafle misji** (RECYCL/HARVEST vs COLLECT = zbiórka z WŁASNEJ planety) — rozstrzygnięte
   zrzutem na Genesis 01.09; na Athenie sprawdzić przy pierwszym locie.
6. **moonformation** — selektory potwierdzone na Athenie 26.08 jeszcze w 2.x; moduł w 3.x
   i tak domyślnie OFF.

## 5. Konfiguracja po stronie ownera (cfg Atheny startuje z DEFAULTS)

Magazyn per-host = na Athenie bot wstaje z fabrycznymi ustawieniami. Checklist panelu
(pierwsze wejście, PRZED włączaniem czegokolwiek):

- **Auto-ratunek: zostaje OFF (Obserwator)** do potwierdzenia raportu startowego — tak jest
  w DEFAULTS (:260) i tak ma być.
- **deutReserve** — DEFAULTS 0 (start Genesis); na Athenie historycznie 100 mld (:268).
- **Ekspedycje**: ciało startowe („startuj z") = księżyc bazy — bez tego fale lecą z AKTYWNEJ
  planety (pętla z 28.08); liczba fal pod sloty expo Atheny (kiedyś 4, sprawdzić).
- **FS**: cel = księżyc INNEJ pary niż flota (lekcja 14.09), prędkość 3%, `restHours` pod
  rytm dnia; FS wyłącznie z księżyca (falanga) — to reguła kodu, nie ustawienie.
- **quietHours (23–05) i przerwy kawowe są w DEFAULTS ON** (:314, :354) — na Genesis
  owner miał je w Firefoksie OFF; zdecydować świadomie dla Atheny.
- **aster.enabled** + `maxFlightMin` — na Athenie to był główny przychód.
- **Wykluczenia ekspedycji UWAGA**: `expo.excludeTypes` jest własnością KODU
  (`pinCodeOwned`, :444) i przez to WSPÓLNA dla obu uni. Dziś: ASTEROID_MINER,
  COLONY_SHIP, DEATH_STAR, RECYCLER, AVATAR, SPY_PROBE. Jeśli Athena ma mieć inną listę
  (np. HC zostają w domu do zwożenia surowców — decyzja z 17.09 dotyczyła Genesis),
  trzeba zmienić kod na listę per-host. Do decyzji ownera.
- Stan konta na Athenie jest NIEZNANY (porzucone 18.08 — flota mogła zostać rozbita
  albo stać nietknięta; agresorzy Splinter [3:330:13] i spółka znają cel). Pierwsza
  sesja Obserwatora to też inwentaryzacja: pary, hangary, księżyce, bramy.

## 6. Czego 3.x nie ma, a 2.x na Athenie miało (decyzje, nie blokery)

- **Farm + czarna lista z raportów bojowych** — na Athenie farm dawał 4,5 bln/d przy
  miningu 393 bln/d; niski priorytet, port tylko jeśli owner zechce.
- **Gemini czytający raporty urobku** — brak w 3.x (klucz i tak per przeglądarka).
- **GateSave (ratunek bramą skokową)** — owner ma bramy na większości księżyców Atheny;
  w 3.x ratunek to wyłącznie lot Deploy. Brama = ratunek natychmiastowy zamiast
  kilkudziesięciu sekund formularza, ale selektory w 2.x były heurystyczne i nigdy nie
  potwierdzone na żywo. Jeśli wracamy na Athenę na poważnie — kandydat na osobny temat
  po ustabilizowaniu podstaw.

## 7. Ryzyka specyficzne dla Atheny

- **ACS jest włączone** (Genesis: off) — skoordynowane fale; Impact/Clock i ratunek
  per-ciało (v3.75) są na to gotowe bojowo, ale pierwszy ACS na Athenie obserwować.
- **R4** (lista ruchów gubi ataki z własnego układu) pochodzi z incydentów WŁAŚNIE na
  Athenie (12.08, 25.08) — ślepy alarm z paska (`barExcess`) musi zostać ON.
- **~30 planet** vs 3–4 pary na Genesis: więcej nawigacji na rekonesans i hangary;
  obserwować alarmy TEMPO i sufity nawigacji, tryb cichy (zwiad kolonii raz/8 h) pomaga.
- **Dwie gry w jednej przeglądarce**: ukryta karta jest dławiona (skan ~30× wolniej,
  wake lock tylko przy widocznej karcie — SPOF z war-game 31.08). Zalecenie: dwa OKNA
  obok siebie, nie dwie karty w jednym oknie.
- Oba uni pushują na JEDEN temat ntfy — po P0-2 tytuły rozróżnią uni; dławiki pushy są
  per-host, więc alarmy z dwóch gier się nie zjadają.

## 8. Proponowany plan wdrożenia

- **F0 (kod, jeden commit):** @match + etykieta UNI w pushach + poprawka asercji
  test3-decide:1293 + neutralizacja 2.x. `node test3-all.js` zielone.
- **F1 (Athena, Obserwator):** owner wyłącza 2.x w TM (jeśli nie weszła neutralizacja),
  loguje się na Athenę, bot zbiera raport startowy → weryfikacja parserów + inwentaryzacja
  konta. Checklist panelu z sekcji 5.
- **F2 (moduły po kolei):** auto-ratunek → ekspedycje/mining → FS → złom; pierwszy lot
  każdego typu nadzorowany (zwłaszcza złom i FS — sekcja 4).
- **F3 (równoległość):** strażnik dwu-uni (sekcja 3) — dopiero po decyzji ownera,
  czy Genesis zostaje w grze.

**Otwarte pytania do ownera:** (1) Genesis równolegle czy przesiadka na Athenę?
(2) wykluczenia ekspedycji per-uni? (3) port GateSave — teraz czy po stabilizacji?

---

## 9. WDROŻENIE (22.09, decyzja ownera: „wszystko na Athenie 1:1 jak na Genesis")

**v3.106.0** (`ogamex-3.user.js`):
- `@match` obejmuje `athena.ogamex.net`; `@name` bez „(Genesis)".
- Stała `UNI` z hosta; wszystkie tytuły pushy mówią, które uni krzyczy
  (ATAK / RATUNEK / FS / BŁĄD / SONDA / EKO / POWRÓT / strażnik / raport startowy).
- Puls do strażnika niesie uni: `GET /hb?u=<uni>` (stary strażnik dopasowuje
  `startswith("/hb")` — zgodność wstecz zachowana).

**v2.112.0** (`ogamex-bot.user.js`): ROZBROJONY early-returnem po `"use strict"` —
auto-update wyłączy go na każdej maszynie. Owner powinien dodatkowo ODINSTALOWAĆ
go w Tampermonkey (skrypt loguje o tym do konsoli). Kod zostaje jako referencja.

**Strażnik** (`watchdog/ogx-watchdog.py`): stan pulsu per uni (`state["unis"]`),
martwa karta JEDNEGO uni przy żywym drugim = restart przeglądarki z kartami
WSZYSTKICH pilnowanych uni (`open -a <app> url1 url2`); uni nieożywione po
3 restartach wypada spod ochrony z pushem (wraca przy pierwszym pulsie —
owner mógł celowo zamknąć tę grę); `/status` pokazuje wiek pulsu per uni;
nowy env `OGX_WD_URLS` (jawna lista kart) obok starego `OGX_WD_URL`.
Stary bot bez `?u=` działa jak dotąd (tylko zegar globalny).

**Pozostaje po stronie ownera (sekcja 5 bez zmian):** pierwsza sesja na Athenie
w trybie Obserwator → „Kopiuj raport startowy" → potwierdzenie parserów → dopiero
wtedy auto-ratunek i moduły po kolei (F2). Checklist panelu w sekcji 5.
`expo.excludeTypes` pozostaje wspólna dla obu uni (1:1 — zgodnie z decyzją).
