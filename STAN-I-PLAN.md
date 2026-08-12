# OGameX Assistant — stan na 5 sierpnia 2026, ~17:00 (v2.71.0)

Notatka przekazania. Wszystko jest na `main` w `Mitjano/ogamex-userscript`
(push na main = auto-aktualizacja przez Tampermonkey, CDN cache ~5 min).
Serwer: athena.ogamex.net, gracz MCH, baza **3:269:8** (planeta + księżyc).

---

## AKTUALIZACJA 12.08 (8) — TEST ŚLEPEGO PASKA zaliczony E2E na 2.88.1 + v2.88.2 (panel forka)

- 16:09–16:14: symulacja ślepego paska przeszła CAŁY cykl w prawdziwej grze:
  kandydat → alarm → ratunek do domu floty → pusty hangar planety → sam
  przełączył się na księżyc → koniec symulacji → auto-powrót → straż zdjęta.
  Autotest na maszynie ownera: 41/41.
- Wcześniej (15:26–15:30, jeszcze 2.87.3) bot obronił się SAM w prawdziwej
  bitwie: ślepy pasek → ratunek; BLITZ (dolot 3 s) bez potwierdzania;
  KOLEJKA (drugi atak na inną kolonię); bezpiecznik obcej kolonii wykrył
  formularz na złej parze i sam się poprawił. Ataki wroga = wabiki
  (1 sonda na misji ATTACK) z NOWEGO księżyca wroga **[3:276:9]** —
  falanga prawdopodobnie sięga księżyca minerów [3:272:7].
- Zrzut [EVENTS DOM] spalił się na PUSTYM kontenerze — „obcy” był
  z symulacji, panel słusznie nic nie renderował. Ale zdradził kontener:
  `#layoutFleetMovements > #fleet-movement-content`.
- **v2.88.2**: kształt B panelu — `tr[class*='row-mission-type-']`
  w kontenerze forka czytany PRAWDZIWYM `FleetMovements.classifyRow`
  (zero zgadywania); niepewna numeracja wyłącza tylko kształt liczbowy;
  zrzut nie odpala się na symulacji ani pustym kontenerze, klucz
  przezbrojony. Zamrażarka: 46 bezpieczników.
- Księżyce wroga (kompletna lista): [2:277:11], [5:67:11], [3:245:7],
  [3:276:9]. Relokacja floty: omijać WSZYSTKIE te okolice.
- OTWARTE: pole „Start ekspedycji” wciąż 2:277:8 (ratunki celują w starą
  bazę); markup WROGIEGO wiersza panelu — potwierdzi go pierwszy prawdziwy
  atak („panel Events dołożył N” = kształt B działa).

## AKTUALIZACJA 12.08 (7) — INCYDENT 15:24: pasek bez „Own” = totalna ślepota → v2.88.1

ACS 450 mld na księżyc [3:272:7], dolot ~4 min. Bot NIE zareagował w ogóle
(zero alarmu, zero pusha) — owner uciekł ręcznie. Diagnoza z żywego logu:

1. **BUG parsera paska (główna przyczyna)**: regex wymagał segmentu „X Own”.
   Owner nie miał ŻADNYCH własnych lotów, więc pasek pokazywał
   `2 Missions: 2 Hostile` — bez „Own” → `read()` = null = „brak paska na tej
   stronie” → cache sprzed ataku mówił „czysto”. Bot był ślepy DOKŁADNIE
   wtedy, gdy cała flota stała w domu (najgroźniejszy moment).
2. Bot chodził na 2.87.3 — lekarstwo (czytnik panelu Events, 2.88.0) leżało
   na mainie od 40 min; Tampermonkey sprawdza aktualizacje raz na dobę.
3. „Start ekspedycji” dalej wskazywał stare 2:277:8 — nawet sprawny ślepy
   alarm broniłby złej kolonii.

**v2.88.1** (wszystkie trzy ogniwa zabezpieczone, 42 bezpieczniki w teście):

- `ThreatMonitor.parseBar(text)` — CZYSTA funkcja: `Own`/`Hostile`/`Friendly`
  wszystkie opcjonalne; jawne „Hostile” = twarda liczba wrogów. Macierz
  w teście offline + autotest w przeglądarce (34→41 checków).
- `UpdateWatch` — co 30 min porównuje @version z repo (raw.githubusercontent,
  nowy @connect); starsza lokalna = czerwony log co tick + dziennik BŁĄD
  z pushem (nag co 6 h / na nową wersję). Niczego sam nie aktualizuje.
- `FleetRecon.homeGuard` — hangar-mapa per para koordów (max z 48 h chroni
  przed fałszywką przy nocnym FS); największa flota ≠ pole „Start
  ekspedycji” (≥1 mld i ≥2× max domu) = log ERROR + dziennik BŁĄD z pushem.
  Progi wykluczają księżyc minerów (7,5 mld) obok floty głównej (setki mld).

OTWARTE po tej wersji: owner musi RAZ zaktualizować TM ręcznie (strażnik
wersji chroni dopiero od 2.88.1 w górę) i ustawić „Start ekspedycji” na
realny dom floty; potem strażnicy pilnują obu rzeczy sami.

## AKTUALIZACJA 12.08 (6) — popołudniowa wojna + seria 2.86.4→2.88.0

Wróg (Ibra646) po utracie łupu z 13:10 eskalował: księżyce bojowe w DWÓCH
układach ownera ([2:277:11], [5:67:11]) + trzeci gracz z [3:245:7]; sondy co
minutę, wabiki, podwójne ataki na obie strony pary, Gwiazdy Śmierci na
porzucone księżyce (~15:05). Flota główna ocalona (ręczny Deploy ownera
o 14:29 + relokacje). Każdy incydent = fix z testem w ciągu godziny:

- 2.86.4: push ⚔️ tylko przy POTWIERDZONYM alarmie.
- 2.86.5: lądowanie ratunku wg realnego czasu lotu (lastFlightMs);
  ślepa ścieżka → switchTo na dom floty; lot międzykolonijny → KSIĘŻYC;
  ręczny RATUJ chroni aktywną parę.
- 2.87.0: AUDYT WYKONYWALNY — resolveRescueTarget (pure + macierze offline
  i w autoteście), symulacja ŚLEPEGO PASKA (E2E ścieżki z 13:10 na żywo),
  zwykła symulacja celuje w dom floty.
- 2.87.1: uzbrojona straż PYTA AirSave przy ataku na oba ciała strzeżonej
  pary (incydent 14:28 — głuche return false; uratował ręczny Deploy).
- 2.87.2: switch_to_body po KOORDACH Z TEKSTU (pairAnchor) + formularz
  ratunku NIGDY nie wysyła z obcej kolonii (incydent 14:35: powrót załadował
  hangar Colony 11 — 4 kolonizatory + 849 mld — i wysłał do 5:67:5).
- 2.87.3: sonda policzona przez listę ≠ brakujący wiersz — pasek wygrywa
  tylko NADWYŻKĄ ponad (ataki+sondy); koniec ratunków na skany (14:38-14:50).
- 2.88.0 (P0-A): PANEL EVENTS z żywego DOM jako trzecie źródło — czytany
  kształtem z fetchServerEvents (tr.eventFleet), wiersze dołączają do
  klasyfikacji (cel+dolot+ciało → blitz i air-save działają dla ataków
  niewidzialnych dla listy), cache 3 min; fork bez tr.eventFleet =
  jednorazowy zrzut [EVENTS DOM] (czekamy na wklejkę ownera → selektory
  z faktów w 2.88.1). Zamrażarka: 23 checki, autotest ~34.

OTWARTE: potwierdzenie kształtu panelu Events na żywo (zrzut [EVENTS DOM]
albo działający merge „panel dołożył N wierszy"); relokacja floty do układu
BEZ wrogich księżyców (w toku — [5:67] też ma wrogi księżyc!); pierwszy
bojowy lot AirSave; „Start ekspedycji" do zaktualizowania po osiedleniu.

---

## AKTUALIZACJA 12.08 (5) — KATASTROFA 13:10 i seria 2.85.1→2.86.5

**UTRATA FLOTY GŁÓWNEJ 13:10** (Ibra646 [2:277:11], księżyc w układzie ownera,
~200 mld statków, loot 74 bln). Sekcja zwłok i lekcje: patrz pamięć projektu
+ test-cel-ratunku.js (15 bezpieczników zamrożonych na źródle).

Nowy model zagrożenia: wróg NA KSIĘŻYCU w układzie ownera — falanga na
planetę, sondy co minutę, loty NIEWIDZIALNE dla fleetmovementlist ORAZ
zdarzeń serwera (3× potwierdzone; tylko pasek je liczy), wabiki
wyślij-zawróć, wywiad przez „sojusznika" (HOLD 017 przed uderzeniem).

Wydania dnia (wszystkie z testami, od 2.86.3 z rytuałem symulacji):
- 2.85.1: ratunek bez celu → aktywna para (WSPÓŁWINNE katastrofy z v2.84
  auto-przełączaniem — bot bronił kolonii, przy której PRACOWAŁ).
- 2.86.0/2.86.1: gotowość 10 s po wabiku / po sondzie.
- 2.86.2: row-friendly-mission ≠ atak (sojusznik 017; autotest 25/25).
- 2.86.3: PO KATASTROFIE — ratunek bez celu broni DOMU FLOTY
  (expeditions.launchFrom); pasek cache 3 min + WYGRYWA z kłamiącą listą.
  Bojowo potwierdzone 13:41 (wykrył jego niewidzialne floty, ratunek do
  domu floty, wróg zawrócił).
- 2.86.4: push ⚔️ dopiero przy POTWIERDZONYM alarmie (sondy pchały syrenę).
- 2.86.5: lądowanie ratunku wg REALNEGO czasu lotu (lastFlightMs; 13:41
  ratunek 38 min lądował bez opieki, bo automat zakładał hop <130 s);
  ślepa ścieżka syntetyzuje cel=dom floty i idzie przez switchTo (skok
  w parze zamiast lotu międzykolonijnego); lot międzykolonijny → KSIĘŻYC;
  ręczny RATUJ chroni aktywną parę.

OTWARTE P0-A (następne, osobne wydanie + symulacja): czytnik panelu Events
z DOM (cel+ciało+dolot dla ataków niewidzialnych dla endpointów — przywraca
blitz i ucieczkę w powietrze przeciwko atakom z układu). STRATEGICZNE:
przeprowadzka domu floty poza układ [2:277] (falanga+sondy Ibry) — decyzja
ownera w toku.

---

## AKTUALIZACJA 12.08 (4) — v2.85.0: UCIECZKA W POWIETRZE + kolejka wg ETA + ciało per kolonia

Zielone światło ownera na P1+P2 z audytu. Zamyka JEDYNY scenariusz utraty
floty: atak na OBA ciała jednej pary naraz (GS „zniszcz księżyc" + atak na
planetę) — ewakuacja w obrębie pary przenosiła flotę pod drugie uderzenie.

**AirSave (moduł, po FleetSave):** gdy `ev.targetBodiesAll[kolonia]` ma oba
ciała → zamiast swapa CAŁA flota+surowce (− rezerwa deuteru) leci powolnym
Deployem (prędkość z `fleetSave.speedPercent`, domyślnie 10%) do najbliższej
innej kolonii i jest ZAWRACANA po ostatnim dolocie ataku + 2 min
(x_btn_fleet_return — ta sama kontrolka co FS). Warstwa NA istniejącej
ścieżce: decyzja w MoonSave.run() (sweep/kolejka/ręczny RATUJ = po staremu);
każda porażka (brak refugium, lot za krótki wg bramki arytmetyki na kroku 2,
5× nieudane zawrócenie) = głośny wpis + markFailed → powrót na zwykły
ratunek na 10 min. Przełącznik w panelu Obrona („Ucieczka w powietrze"),
domyślnie ON. Zegar w pętli obrony (AirSave.tick przed FS.tick).
Test: `test-ucieczka.js` (decyzja + arytmetyka zawrócenia, 14 przypadków).

**P2 precyzja:** `ev.targets` sortowane wg NAJKRÓTSZEGO dolotu (kolonia
z najbliższym uderzeniem ratowana pierwsza — dotyczy też kolejki), nowe mapy
`ev.targetBodies` (ciało celu PER KOLONIA — flipy na formularzu i strażnik
bezpiecznej strony czytają per-kolonia zamiast globalnego 1. wiersza),
`ev.targetBodiesAll` (zestaw ciał — wyzwalacz ucieczki; strażnik bezpiecznej
strony WYŁĄCZA się przy obu ciałach), `ev.targetMaxEta` (zegar zawrócenia).

NIEPRZETESTOWANE NA ŻYWO: pierwszy realny atak na oba ciała = pierwsza
bojowa próba ucieczki. Symulacja ataku NIE ćwiczy tej ścieżki (syntetyczne
zdarzenia nie mają targetBodiesAll) — celowo, żeby nie wysyłała floty na
wielogodzinny lot przy każdym teście.

---

## AKTUALIZACJA 12.08 (3) — v2.84.0: punkt startu PER MODUŁ (minery ≠ ekspedycje)

Problem ownera: asteroidy spawnują się ZAWSZE w g3 (tam większość planet),
a ekspedycje po przeprowadzce lecą z g2 — po 2.82.0 („start z aktywnego
ciała") minery były martwe, bo asteroidy z g3 wypadały na bramce „inna
galaktyka niż punkt startu".

Rozwiązanie: `asteroidMining.launchFrom` + `expeditions.launchFrom`
(pola „g:s:p" w panelu; puste = z aktywnego ciała, jak w 2.82.0):
- Misja dostaje `launchAt` przy TWORZENIU; nowa bramka w handlePendingMission
  (przed bramką księżycową) porównuje aktywną parę z launchAt — inna para →
  klik właściwego wpisu na pasku planet (księżyc przy baseBody=moon,
  fallback planeta gdy para bez księżyca) → switch_planet_then_fleet →
  formularz. Koordy spoza listy planet = głośny error + start z aktywnego.
- Minery: kolejka skanu/TTL/dispatch liczone od `HomeBase.mining()`.
- Ekspedycje: cel = poz. 16 systemu `HomeBase.expo()` (launchFrom → stare
  `expeditions.base` → aktywne ciało); powroty wracają na ciało startu (gra).
- Złom (DebrisCollector) chodzi za punktem startu EKSPEDYCJI (tam leżą pola
  po falach; recyklery mieszkają przy flocie ekspedycyjnej).
- Farm/FS/ratunek — bez zmian (własna logika startu).

Operacyjnie: owner wpisuje start minerów 3:272:7 (księżyc, minery+deuter
muszą tam FIZYCZNIE stać), ekspedycje puste (lecą stamtąd, gdzie stoi)
albo przypięte do księżyca w g2. UWAGA: bramka paliwa czyta deuter z
AKTYWNEGO ciała — przy sztywnym starcie odczyt bywa z innego ciała
(fail-open; realna odmowa i tak wyjdzie na formularzu).

---

## AKTUALIZACJA 12.08 (2) — v2.83.0: PROM na przełącznik (OFF) + OFF przerywa formularz

Feedback ownera po porannym logu (jeszcze na 2.81.0):
1. **PROM domyślnie WYŁĄCZONY** (`moonFerry.enabled:false`, przycisk „PROM
   planeta→księżyc" w sekcji Mining, confirm przy włączaniu). 08:48 prom tuż
   po starcie sam wywiózł całą flotę + 11,8 bln deuteru na księżyc — owner
   nie chce, by bot KIEDYKOLWIEK przenosił flotę bez wyraźnej zgody.
   Samonaprawa „flota na złym ciele" działa tylko przy PROM=ON.
2. **OFF = STOP także w środku 3-krokowego formularza**: v2.68.4 przerywała
   misję tylko przy wznowieniu po przeładowaniu; klik OFF w trakcie kroków
   nie był sprawdzany (08:48:42 OFF → 08:48:43 fala i tak wyszła). Nowy
   `offAbort()` przed klikiem step1→2, step2→3 i przed „Send fleet".
   Wyjątek bez zmian: ratunek (moonSave) zawsze dokańcza.

---

## AKTUALIZACJA 12.08 — v2.82.0: START Z AKTUALNEGO CIAŁA (HomeBase)

**Decyzja ownera:** agresywni sąsiedzi → mining i ekspedycje mają startować
z planety/księżyca AKTYWNEGO w pasku planet, nie ze sztywnej bazy [3:272:7].
Zmiana miejsca startu = przełączenie planety w grze, zero konfiguracji.

Nowy moduł `HomeBase` (koordy aktywnego ciała z paska planet + cache GM
`ogamex_home_body`; fallback `minerBase`). Konsumenci przełączeni na dynamikę:
- **Mining**: kolejka skanu, TTL-vs-dolot, dispatch (auto+ręczny) liczą od
  aktywnego ciała; asteroida w innej galaktyce niż aktywne ciało = pomijana.
- **Ekspedycje**: fale lecą na poz. 16 systemu aktywnego ciała
  (`expeditions.base` zostało jako świadome sztywne nadpisanie, null = podążaj).
- **Złom (DebrisCollector)**: zagląda na galaktykę aktywnego układu.
  UWAGA: złom po ekspedycjach z POPRZEDNIEGO miejsca startu zostaje tam —
  zebrać ręcznie albo wrócić ciałem.
- **Prom (MoonFerry)**: planeta → księżyc AKTUALNEGO układu; układ bez
  księżyca = prom pominięty (stempel 2 h).
- **Tryb księżycowy** (`baseBody:"moon"`): dokręca tylko CIAŁO w obrębie
  aktualnej pary (planeta→jej księżyc). Układ bez księżyca = start z planety
  + głośny warn (falanga widzi lot).
- **Bezpiecznik w switch_to_body**: szukanie księżyca pary STOPUJE na
  następnym wpisie planety — bezksiężycowa para nie „pożyczy" już cudzego
  księżyca z listy.

NIETKNIĘTE: obrona (ratunek/straż/RescueQueue), FS (od v2.75.0 i tak startuje
z aktywnego księżyca), farm (od v2.74.8 startuje z aktualnego ciała).
`minerBase` w configu zostaje wyłącznie jako fallback, gdy nie widać paska.

---

## AKTUALIZACJA 05.08 ~23:40 (dom) — przenosiny bazy + FS potwierdzony

**BAZA PRZENIESIONA: [3:269:8] → [3:272:7]** (agresor „Ay"/Sniper wskoczył do
starego układu na 3 min lotu; 40 mld Reaperów odparte o 22:21 automatem).
Migracja v2.73.0 + bezpiecznik misji-min v2.73.1/2 (misja ratunku na ciało
spoza listy planet = porzucenie + zdjęcie straży). W nowym układzie na
poz. 15 siedzi Sniper Nova (i) — na razie nieaktywny, ale to sąsiad-ryzyko.

**FS DZIAŁA end-to-end** (3 cykle na żywo): wysyłka → auto-zawrócenie klikiem
(x_btn_fleet_return; bot sam rozwija listę flot od v2.74.0) → powrót.
Trasa [3:272:7]→[3:272:2] (księżyc Colony 27): 10% = 263 min (maks FS 8,7 h),
**3% = 878 min (maks FS ~29 h — całonocny)**; 3%/5% dozwolone od v2.74.1.

Nowe w v2.72–2.74.2: farmienie z jawnym ATTACK + wybór statku (LC/HC/BS),
alarm głosowy + syrena 10 s na laptopie, wersja w nagłówku panelu,
**rezerwa deuteru** (domyślnie 1 mld zostaje przy ratunku/FS — paliwo dla
flot wracających z ekspedycji, pole w Obronie), **weryfikacja pól statków
po wpisaniu** (formularz gubi pojedyncze pola po re-renderze — 23:22
BATTLE_CRUISER 1,38 mld został w domu; teraz odczyt zwrotny + dopisanie).

OTWARTE: event idle farming (planeta po przenosinach ma ~30 min blokady
misji ofensywnych; farmienie nieprzetestowane na żywo — patrz sekcja
FARMIENIE), pierwszy atak w nowym układzie = test v2.70.3.

## PRZECZYTAJ NAJPIERW — PRZEKAZANIE 05.08 (praca → dom)

**Priorytet ownera, wprost: „Obrona floty jest najważniejsza i nie może raz
działać raz nie."** Wszystko inne jest drugorzędne. Zanim cokolwiek zmienisz
w obronie — przeczytaj tę sekcję i incydent 16:18 poniżej w całości.

### Co się dziś wydarzyło (2026-08-05) — trzy prawdziwe ataki, jeden bug

Obrona odparła **3 ataki** w pełni automatycznie (wykrycie → ewakuacja na
drugie ciało w ~24 s → napastnik zawraca → auto-powrót). ZERO strat floty:

1. **12:30** — atak z [3:248:11] „Moon" (87,2 mld Battleship). Ewakuacja
   księżyc→planeta, powrót 12:32 „planeta → księżyc" ✓ poprawnie.
2. **15:09** — atak „HOME" z [3:254:9] (4 floty, ~190 mld). Jak wyżej ✓.
   (HOME to niemal na pewno Sniper Grus — ten od masakry 11:00, gdy bot
   był OFF; liczba Reaperów się zgadza.)
3. **16:18** — znowu [3:248:11] (87,2 mld BS, dolot 5 min). Ewakuacja OK,
   napastnik zawrócił, ALE powrót odstawił flotę na **PLANETĘ** zamiast na
   księżyc. To NIE była awaria powrotu — to **flip pustego hangaru**:

### Incydent 16:18 — anatomia buga (v2.70.3 naprawia)

Sekwencja z dziennika: 16:18:58 ratunek księżyc→planeta ✓ → 16:20:40 straż
wielofalowa (zamiatanie co 90 s) robi drugi przebieg → 16:20:52 zastaje
**pusty hangar na księżycu przy trwającym alarmie** → stary „flip" uznaje
„flota pewnie na drugim ciele" → **przenosi flotę z bezpiecznej planety
Z POWROTEM na atakowany księżyc** (dolot 16 s przed uderzeniem! uratował
nas tylko odwrót wroga) i **nadpisuje homeBody=planet** w notatkach straży
→ 16:22:11 powrót sumiennie odstawia flotę „do domu" = na planetę.

**Dlaczego „raz działa, raz nie":** flip odpalał TYLKO gdy alarm trwał na
tyle długo, że zamiatanie trafiło na pusty hangar. W atakach 1-2 wróg
zawrócił szybko → flip nie wykonał się wcale → wszystko działało. Bug był
timing-dependent, siedział w kodzie od v2.66.0.

**Fix v2.70.3 (live, pushnięte ~16:30):** flip wyłącznie przy PIERWSZYM
ratunku alarmu — warunek `!mission.moonReturn && !mission.flippedBody &&
!mission.sweep && saves<=1 && ThreatMonitor.active() && atkB!==hereB`
(ogamex-bot.user.js, gałąź moonSave w select_ships_direct, szukaj
„v2.70.3"). Zamiatanie z pustym hangarem = „nic nowego nie wylądowało",
koniec. Flip nigdy nie może też celować w ciało, w które leci atak.

### v2.71.0 — PROM planeta→księżyc (samonaprawa, pushnięte ~17:00)

Moduł `MoonFerry` (przed DebrisCollector) + hook w schedulerTick (za
OnlineBonus). W trybie księżycowym co 2 h (pierwszy kurs OD RAZU po
aktualizacji) tworzy misję `moon_ferry_direct`: przewozi WSZYSTKO z planety
na księżyc (ta sama maszyneria co ratunek: Deploy + wszystkie statki
+ surowce). Kluczowe flagi misji: `moonSave:true` (obsługa formularza),
`ferry:true` (własne wpisy „odczyt/PROM" w dzienniku — NIE fałszuje
liczników obrony), `sweep:true` (twardo wyłącza flip). Pusta planeta =
cichy abort („nothing on this planet to save"). Ustępuje wszystkiemu:
alarm/straż/pending/przerwy/okno nocne (patrz `MoonFerry.due()`).
Efekt: każdy stan „flota na złym ciele" — z dowolnej przyczyny — naprawia
się sam najpóźniej po 2 h.

### NA CO ZWRÓCIĆ UWAGĘ W DOMU (kolejność ważności)

1. **Sprawdź, że prom zadziałał**: w logu `[PROM] planeta → księżyc` +
   flota (36,9 mld LF, 16,1 mld BS, minery, recyklery, 12 GS, AVATAR…)
   ma stać NA KSIĘŻYCU [3:269:8]. Jeśli stoi na planecie — prom nie
   ruszył, diagnozuj `MoonFerry.due()` (klucz GM `ogamex_ferry_at`).
2. **Następny atak = test v2.70.3.** Sąsiedzi ([3:248:11] i [3:254:9])
   atakują seryjnie — kolejny przyjdzie. Poprawny przebieg w dzienniku:
   RATUNEK księżyc→planeta → (zamiatanie może logować „nothing to save",
   to OK) → **ŻADNEGO wpisu „Hangar … pusty przy alarmie → przełączam"**
   → POWRÓT „planeta → księżyc". Jeśli zobaczysz flip przy zamiataniu —
   v2.70.3 nie zadziałał, to P0.
3. **NIE dotykaj gałęzi moonSave w select_ships_direct ani zapisu
   homeBody/refugeBody w MoonSave.saveWatch bez przeczytania incydentu
   16:18.** Każda zmiana tam = ryzyko powtórki „flota wraca na atakowane
   ciało".
4. **Mining i Ekspedycje są OFF od 15:54** (owner wyłączył po ataku).
   Włączyć może sam owner, gdy uzna że spokój. FS też OFF.
5. **FS live-click zawracania (a.x_btn_fleet_return) nadal NIEPRZETESTOWANY**
   — pierwsze zawrócenie było ręczne. Następny cykl FS = test; czytać log.
6. **Gemini: brak klucza na tej maszynie** (GM storage nie synchronizuje
   się między laptopami — w domu klucz pewnie jest, sprawdź panel).
7. Drobne z dziś: licznik alarmów w pasku liczy epizody (v2.70.2, „3 alarm"
   = poprawnie); dumpy wrogich wierszy szukaj po `[ATAK DOM]`.

### Pomysły otwarte (owner zainteresowany, nic nie obiecane)

- Ewakuacja awaryjna poza układ, gdy atak leci na OBA ciała naraz
  (dziś: ratunek przerzuca tylko planeta↔księżyc tych samych koordów).
- Podgląd nicku agresora (galaktyka [3:248] / [3:254]) do dziennika.
- Rotacja księżyców ODRADZONA (koszt/chaos > zysk; falanga i tak nie
  widzi księżyców) — zamiast tego wdrożony blitz fast-track (<120 s ETA
  = alarm bez 25 s potwierdzania, v2.70.1).

---

## FARMIENIE (EVENT IDLE FARMING) — audyt + v2.72.0 (05.08 wieczór, dom)

Audyt przed eventem wykazał: farmienie NIGDY nie biegło na żywo (zero kluczy
`ogamex_farm*` w GM storage), a misja szła w ciemno na `mission=8` z URL-a —
parametr niepotwierdzony na tym forku (numeracja własna: ekspedycja=1,
asteroida=12) i formularz potrafi gubić parametry (incydent 09:50 4.08).

v2.72.0: (1) krok 3 klika misję **ATTACK jawnie** po klasie/tekście
mission-item — bez trafienia NIE wysyła (zrzut dostępnych misji do logu,
sweep pauza 30 min); (2) **wybór statku** w Ustawienia: Farmienie
(LIGHT_CARGO / HEAVY_CARGO / BATTLESHIP, klucz `inactiveFarming.shipType`) —
taktyka eventowa: szybszy statek = slot szybciej wolny, BS na wypadek obrony;
(3) start ze złego ciała naprawia istniejący chokepoint v2.69.0 (baza=księżyc).
Zabezpieczenia nietknięte: alarm wstrzymuje farmienie, mining wygrywa z farmą.

**Pierwszy atak farmy obserwować w logu**: `[FARM DOM] first target row`
(weryfikacja parsera statusów (i)/(I)) i `[FARM] misja: …` (weryfikacja
ATTACK). Jeśli „brak misji Attack na kroku 3" — przysłać zrzut z logu.

## ZASADA, KTÓREJ NIE WOLNO ZŁAMAĆ

**Nie buduj niczego na endpointach, których nie potwierdziłeś na żywo.**
Rano założyłem, że athena to open-source OGameX (Laravel) i zbudowałem pięć
wersji (2.40–2.44) na trasach z `lanedirt/OGameX`. Wszystkie oddały 404 —
serwer jest w .NET. Cała praca poszła do kosza, a jedna wersja (2.52.0)
wysyłałaby flotę **z bazy** zamiast z atakowanej kolonii.

Metoda, która zadziałała: `ApiSniffer` podpina się pod `fetch`/`XMLHttpRequest`
strony i notuje, co gra odpytuje **sama z siebie**. Tak znaleźliśmy prawdziwe
adresy. Gdy potrzeba nowego — najpierw zrzut markupu do logu, potem parser.

## PRAWDZIWE ENDPOINTY TEGO SERWERA (potwierdzone)

```
GET /home/fleetmovementlist                                  ← lista ruchów flot (podstawa obrony)
GET /home/Partial_AsteroidJournal                            ← dziennik wypraw górniczych
GET /home/Partial_ExpeditionJournal                          ← dziennik ekspedycji
GET /messages/messagedata?MessageCategoryType=FLEET_OTHER&page=1
GET /messages/messagedata?MessageCategoryType=FLEET_EXPEDITION&page=1
GET /messages/messagedata?MessageCategoryType=FLEET_BATTLE_REPORT&page=1
GET /home/combatreport?id=<uuid>
```

Martwe (404 albo strona HTML): wszystko z `/ajax/fleet/*`, `/ajax/galaxy`,
`/ajax/messages`, `/ajax/phalanx/scan`. Kod, który na nich stał, usunięty
w 2.54.0. Nie wskrzeszać.

**`/overview` NIE ISTNIEJE na tym serwerze** (ustalone 2026-08-03: każda
strona błędu miała `aspxerrorpath=/overview` — to bot sam na nią wchodził).
Przegląd gry żyje pod `/` (logo ma `href="/"`). Wszystkie nawigacje
podmienione w 2.63.0; nowy kod ma używać `/`.

Markup wiersza listy ruchów flot:
```html
<tr data-fleet-id="4649f6fc-…" class="row-mission-type-EXPEDITION">
  <td data-remaining-seconds="213" …>03:33</td>
  <td><img data-tooltip-content="Expedition" /></td>
  <td> Yoyoyoyoyo <a class="fleet-source-coords">[3:269:8]</a> </td>
  <td><span data-tooltip-content="… Light Cargo : 330.000.000 …"></span></td>
```
Typ misji jest podany **nazwą**, nie numerem — dlatego odpada problem
numeracji forka (w linkach galaktyki ekspedycja to `mission=1`, asteroida
`mission=12`, co nie zgadza się z upstreamem).

---

## AUDYT 2026-08-03 (v2.59.0) — co naprawiono

1. **P0, alarm:** od 2.32.0 potwierdzony alarm NIGDY nie był zdejmowany —
   `this.clear()` wypadło z gałęzi „obce floty zniknęły" (zostało tylko
   w nieosiągalnej gałęzi kandydata). Skutek: `active()` trzymało 3 h
   (BACKSTOP), auto-powrót z refugium nie odpalał, ekspedycje/farmienie
   stały, straż zamiatała co 90 s, log „alarm zdjęty" spamował co 30 s.
   Naprawione — clear() wrócił na miejsce.
2. **Ekspedycje:** RECYCLER dopisany do wykluczeń (domyślne + migracja
   zapisanej konfiguracji). Recyklery zostają w domu do zbierania złomu.
3. **Złom (latentny):** misja `debris_recycle_direct` w kroku 1 formularza
   wpadała do gałęzi górniczej i załadowałaby MINERY zamiast recyklerów
   (pierwszy realny złom = flota górnicza na polu złomu). Naprawione +
   recycle wypięty z księgowości mininga (finishDispatch, init handler,
   ogamex_last_dispatch).
4. **Alarm, czułość:** 20-sekundowe okno ślepoty po własnej wysyłce dotyczy
   teraz TYLKO odczytu z paska — sklasyfikowany odczyt z listy ruchów flot
   nie może pomylić własnej floty z obcą (fale co 60-90 s zjadały ~25%
   czasu czuwania).
5. **Dziennik:** wpis „ATAK" z refreshEvents dławiony (zmiana obrazu albo
   5 min) — wcześniej 120×/h przy trwającym ataku, groziło wypchnięciem
   ważnych wpisów z limitu 600.
6. **404:** `fleetAlreadyFlyingTo` odpytywał martwe `/ajax/fleet/*` przy
   każdej wysyłce górniczej (ominięte przy sprzątaniu 2.54.0). Teraz
   najpierw potwierdzony `/home/fleetmovementlist`, martwe adresy za bramką
   `Ajax.supported`.

**Znane luki zgłoszone, ale NIE ruszone (świadomie):**
- Ratunek kolonii zawsze wysyła Z PLANETY (`switchTo` klika kotwicę
  planety). Jeśli flota kolonii stoi na jej księżycu, a atak leci na
  księżyc — ratunek zastanie pustą planetę i zakończy się „nothing to
  save", flota zostanie na atakowanym księżycu. Cel z listy ruchów flot
  to gołe koordy, bez rozróżnienia planeta/księżyc. Do przemyślenia razem
  z maszyną stanu MoonSave (pkt 2 niżej).
- Klasyfikacja sonda/atak nadal niepotwierdzona na prawdziwym ataku
  (pkt „CO JEST WDROŻONE, ALE NIEPOTWIERDZONE").

## v2.61.0 (2026-08-03 wieczór) — strona błędu nie zabija już bota

Incydent ×2: OGameX oddał `/Error/NotFound` i bot stał na niej GODZINAMI —
całe odzyskiwanie wisiało na jednym setTimeout, a przeglądarka w karcie w tle
dławi/gubi timery (oszczędzanie pamięci). Naprawy:
- **strażnik interwałowy** (60 s) ponawia powrót do gry aż do skutku,
  po 6 próbach eskalacja na lobby `/` (init umie kliknąć Play);
- **pętla obrony startuje TAKŻE na stronie błędu** — odczyt zagrożeń idzie
  fetchem (lista ruchów), ratunek nawiguje prosto do formularza;
- epizod strony błędu jest **widoczny w dzienniku obrony** (start + czas trwania);
- `markUnsupported` hartowany: tylko 404/405 i NIGDY dla adresu, który już
  kiedyś działał (czkawka 404 podczas awarii nie wyłączy fleetmovementlist).
Czego kod nie naprawi: **całkowicie uśpiona/odzyskana karta** (browser
discard) nie wykonuje ŻADNEGO JS. Właściciel ma wyłączyć usypianie kart dla
athena.ogamex.net i trzymać bota w osobnym oknie.

## CO DZIAŁA I JEST POTWIERDZONE NA ŻYWO

- **Mining asteroid** — główny dochód. Własny licznik lotów (`MiningFlights`),
  prawidłowy dobór liczby minerów, ładowność 20 750/minera uczona z raportów.
- **Ekspedycje** — 14 fal, skład zamrażany na serię, Galleon i Falcon wracają
  do składu, Gwiazda Śmierci wykluczona (spowalniała falę do 26 min w jedną stronę).
- **Ewakuacja bazy** planeta↔księżyc + powrót — ratunek 09:24, powrót 09:26.
- **Pętla obrony co 30 s**, niezależna od przerw, jitteru i okna nocnego 23–05.
- **Dziennik ataków**: zdarzenia ważne żyją 12 h, rutynowe odczyty mają własny
  limit 60 i nie mogą ich wypchnąć. Podsumowanie w panelu i raz na godzinę w logu.

## ✅ POTWIERDZONE BOJOWO 05.08.2026 15:09-15:13 — PEŁNA AUTOMATYCZNA OBRONA

Drugi atak dnia (gracz HOME z księżyca [3:254:9], 4 floty: 98 mld Reaperów +
93 mld pancerników, przylot ~6 min) — bot obronił się CAŁKOWICIE SAM:
wykrycie 15:09:35 (wiersze `row-mission-type-ATTACK row-hostile-mission`
sklasyfikowane, surowy HTML w logu przez [ATAK DOM]) → RATUNEK w 24 s od
wykrycia (całość z księżyca na planetę, lot 81 s) → napastnik ZAWRÓCIŁ
wszystkie floty 15:11 → alarm zszedł natychmiast (fix P0) → auto-POWRÓT
na księżyc 15:12:55 → straż rozbrojona → [BAZA=KSIĘŻYC] przywrócił start
z księżyca → ekspedycje pojechały dalej. ZERO STRAT. Punkty 1 (klasyfikacja)
z sekcji niżej są tym samym potwierdzone na żywo. Kontrast z porankiem
(11:00, bot OFF, −11,2 bln) jest ostatecznym argumentem: bot ma być ON.

## CO JEST WDROŻONE, ALE NIEPOTWIERDZONE NA PRAWDZIWYM ATAKU

1. **Klasyfikacja sonda/atak** (2.51.0). Parser listy ruchów flot sprawdzony
   wyłącznie na NASZYCH wierszach — od wdrożenia nikt nie atakował. Jeśli ta
   lista zawiera tylko floty gracza, klasyfikacja nie działa.
   Zabezpieczenie (2.53.0): gdy pasek misji widzi obcych, a lista nie —
   **wygrywa pasek**, w logu i dzienniku ląduje ostrzeżenie.
   **Do zrobienia: przy pierwszym ataku przeczytać dziennik i sprawdzić, czy
   wiersz obcej floty w ogóle się pojawił.** Nic do kodowania.
2. **Ewakuacja innej kolonii niż baza** (2.55.0) — przełączanie aktywnej
   planety klikiem w kotwicę na liście planet, potem wysyłka. Testy na
   syntetycznym DOM przechodzą; na żywym ataku nie było.
3. **Zbieranie złomu po ekspedycjach** (2.48.0) — wizyta na galaktyce bazy
   działa, ale pola złomu jeszcze nie było. Gdy nie ma linku zbierania, bot
   zrzuca markup i **nie wysyła floty w nieznane**.

---

## DO WDROŻENIA

### 1. Fleet Save — WDROŻONE w v2.60.0 (2026-08-03), czeka na pierwszy przebieg

Cały cykl jest w kodzie: panel (sekcja „Fleet Save (nocny)": godzina powrotu
HH:MM — **najbliższe wskazanie zegara, powtarza się co dobę**; cel g:s:p;
prędkość %; przycisk „Zmierz trasę (bez wysyłki)"), tick w PĘTLI OBRONY
(odporny na noc/przerwy — zawrócenie o 4:00 musi zadziałać), wysyłka przez
sprawdzony na żywo formularz (ciało=moon `data-planet-type=2`, misja DEPLOY,
`btn-all-res`), statki wszystkie poza `excludeTypes` (ASTEROID_MINER).

Jak obeszliśmy dwa brakujące markupy — **nic nie leci na zgadywanym markupie**:
- **prędkość (krok 2):** trzy próby po znaczeniu (select z opcjami %,
  input[type=range], klikalne „NN%") + jednorazowy zrzut okolic formularza do
  logu (`[FS DOM] krok 2`). Nieustawiona prędkość nie psuje niczego, bo…
- **bramka arytmetyki:** przed Send bot czyta czas lotu, który pokazuje SAMA
  GRA (`capturedFlightMs`) i wysyła TYLKO gdy okno ≤ 2×T − 2×3 min. Nie pasuje
  → odmowa + zapis T (planer odtąd liczy godzinę startu bez formularza).
  „Zmierz trasę" robi dokładnie to samo i zawsze kończy bez wysyłki.
- **zawracanie:** o `recallAt` fetch listy ruchów, nasz wiersz po koordach
  from/to, kontrolka po znaczeniu (recall/callback/revoke/retreat/cancel/zawróć
  w href/action/data-*), wykonanie + WERYFIKACJA (wiersz zniknął / return /
  eta przeskoczyła). 3 próby co 60 s; porażka = zrzut końca wiersza + głośny
  błąd + powiadomienie — a flota **doleci na nasz księżyc i tam zostanie**
  (stacjonowanie = bezpieczna porażka; TRANSPORT jest dla FS odrzucany twardo,
  bo rozładowałby się i wrócił w środku nocy).

**Pierwsze uruchomienie:** kliknij „Zmierz trasę" (pozna T), ustaw powrót
(np. 09:00), włącz. Pierwszy pełny cykl przeczytać w logu/dzienniku — zwłaszcza
czy zawrócenie znalazło kontrolkę (jak nie: zrzut wiersza jest w logu, dopisać
selektor). UWAGA operacyjna: FS zabiera to, co stoi na bazowym KSIĘŻYCU w
chwili startu — fale ekspedycji wracające w nocy na planetę są poza FS.

### 2. MoonSave na maszynę stanu (dług z audytu, WYSOKIE 4)

413 linii, **64 punkty wyjścia**. Rano ta plątanina wygenerowała serię poprawek,
gdzie każda odsłaniała następną (2.33 → 2.34 → 2.35).

**Warunek wejścia: jeden potwierdzony ratunek w dzienniku.** To jedyna ścieżka
obrony potwierdzona na żywym ruchu i przepisanie jej bez wzorca do porównania
byłoby wymianą znanego na nieznane. Plan: wydzielić `decide()` zwracające jedną
akcję (`ratuj` / `wróć` / `czekaj` / `nic`), mechanikę wysyłki zostawić bez
zmian, obie ścieżki puścić równolegle w trybie porównawczym przez dobę.

### 3. Uczenie się urobku z właściwych źródeł

`/home/Partial_AsteroidJournal` i `messagedata?…FLEET_OTHER` są podpięte, ale
parser nadal jest ten stary („unknown message markup"). Trzeba zobaczyć zrzut
`[RAPORTY] …` i napisać parser pod ten markup. Zysk: trafniejszy dobór liczby
minerów na lot, czyli wprost większy urobek.

### 4. Drobne

- Ochrona kolonii innych niż baza działa tylko wtedy, gdy kolonia jest widoczna
  na liście planet — przy 30 planetach warto sprawdzić, czy lista nie jest
  przewijana/ucinana.
- `pending_mission` to nadal jeden slot dla czterech modułów (dług z porannego
  audytu, ŚREDNIE 8). Ratunek ma wywłaszczenie, więc najgorszy skutek zdjęty.

---

## Dokumenty w repo

- `AUDYT-OBRONA-2026-08-02-v2.md` — audyt wieczorny + stan wykonania
- `AUDYT-2026-08-02.md` — audyt poranny (v2.35.0)
- `ENDPOINTY-OGAMEX-2026-08-02.md` — analiza endpointów z nagłówkiem o tym,
  dlaczego większość nie dotyczy tego serwera


---

## AKTUALIZACJA 3 sierpnia wieczorem (v2.58 → v2.66.1)

Zrobione od czasu noty powyżej:
- **P0 (2.59.0):** alarm nigdy nie był zdejmowany — `clear()` wróciło na
  miejsce; auto-powrót działa. Recyklery zostają w domu (zbieranie złomu).
- **Fleet Save (2.60–2.63):** pełny cykl start→stacjonuj→zawróć→powrót,
  planer z 3-min marginesem, pomiar trasy na kroku 3, strona błędu nie
  zostawia martwego bota, `/overview` → `/` (nie istnieje na athenie).
  NIEPRZETESTOWANE NA ŻYWO: kontrolka zawracania i suwak prędkości (zrzuty
  czekają w kodzie). Przed nocnym użyciem: JEDEN nadzorowany test.
- **Gemini (2.64.x):** klucz w panelu, czyta raporty urobku z
  Partial_AsteroidJournal — POTWIERDZONE NA ŻYWO 22:16 (`odczytano 1 raport`,
  próbka 18,2 bln zgodna z ładownością). Strażnik ładowności (odrzut >3×).
  Twarda zasada: model tylko czyta / eskaluje, nigdy nie decyduje o flocie.
- **UX panelu (2.65.x):** pasek stanu 5 linii (Obrona/Mining/Ekspedycje/FS/
  Gemini), slim sekcje PL zwinięte domyślnie, log 1-liniowy, szerokość 232px.
- **Audyt obrony (2.66.0):** flota na KSIĘŻYCU nie była chroniona (ratunek
  szedł z ciała aktywnego = planety, „nothing to save", flota zostawała pod
  atakiem) — naprawione flipem na drugie ciało przy pustym hangarze i alarmie.
  Nieznany typ obcej misji = ATAK (było: nie podnosił alarmu). Gemini jako
  drugie oko obrony (wyłącznie eskalacja). Jitter dostał przełącznik (2.66.1).

Otwarte (kolejność):
1. Nadzorowany test FS (~40 min okno) — odblokuje selektory zawracania+prędkości.
2. Pierwszy prawdziwy atak — zweryfikuje wrogie wiersze w fleetmovementlist.
3. MoonSave → maszyna stanu (po pierwszym potwierdzonym ratunku).

## AKTUALIZACJA 4 sierpnia (v2.66.5–2.66.9) — FS przeszedł pierwszy żywy cykl

- **Pierwszy żywy FS 14:36**: pomiar → wysyłka → Deploy+surowce z księżyca →
  zawrócenie. Prędkość = RZĄD GOŁYCH LICZB bez „%" (Speed: 3 5 10 … 100);
  czas lotu = „Duration of flight (one way): MM:SS" (wzorzec wspólny — mining
  też czyta teraz czas z formularza). Trasa 3:269:8→5 przy 10% = 263 min
  w jedną stronę (GS spowalnia flotę) → maks. FS ~8,7 h — **bliski księżyc
  wystarcza na całą noc**.
- **Kontrolka zawracania ZŁAPANA na żywo**: `a.x_btn_fleet_return
  [data-fleet-id]`, href="#" (handler JS) → klik w żywym DOM na /fleet
  (panel „Fleet movements", rozwinięcie przy wielu flotach), auto-confirm.
  Pierwsze zawrócenie wykonane RĘCZNIE przez ownera (wykrywacz nie znał
  klasy — naprawione w 2.66.9); wiersz powrotny bez przycisku = sukces.
  KLIK NA ŻYWO jeszcze niepotwierdzony — sprawdzić przy następnym cyklu FS.
- Sonda szpiegowska 09:49 zignorowana poprawnie — lista ruchów POKAZUJE obce
  floty (połowa wielkiej niewiadomej obrony rozstrzygnięta na TAK).
- Ekspedycje: fala zapełniająca ostatni slot zabiera CAŁY hangar (2.66.7);
  krok 2 poprawia koordy celu, gdy formularz zgubi parametry URL (2.66.5).

## AKTUALIZACJA 4 sierpnia późny wieczór (v2.68.0–2.68.1)

- **v2.68.0 Wake Lock**: bot ON = Screen Wake Lock (macOS i Windows bez
  admina); karta z grą musi być widoczna, klapa otwarta. Bot OFF zdejmuje.
- **v2.68.1 złom z ekspedycji** (zgłoszenie: „złom leży na 16 i nikt nie
  leci"): wizyta po złom co 20 min zawsze przy bezczynności (stary warunek
  „minery w locie" nie zachodził nigdy przy pustych skanach — to była
  główna przyczyna); bramka na pusty hangar recyklerów; krok 2 jawnie klika
  Debris (data-planet-type=3), krok 3 jawnie klika COLLECT albo NIE wysyła.
  DO POTWIERDZENIA na żywo: pierwszy log `[ZŁOM] misja: "Collect"` po
  przegranej ekspedycji.
