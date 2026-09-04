# HANDOFF: Fleet Save v3.68.0 (port z Atheny) — 2026-09-04

**Do Claude Code na macOS: przeczytaj to PRZED jakąkolwiek pracą nad tym branchem.**
Kontynuacja sesji z Windows (michal). Owner: "muszę wychodzić z pracy, dokończymy na
macbooku w domu, ale claude code w domu musi wiedzieć co zrobiłeś i co ma dalej do
wdrożenia" — stąd ten plik zamiast tylko commit message.

## Gdzie to jest

Branch: `fs-atheny-port-v368` (NIE main — świadomie, patrz "Co NIE jest zrobione" niżej).
Pierwsza rzecz do zrobienia na Macu: `git fetch && git checkout fs-atheny-port-v368`.

## Kontekst tej sesji (skrót — pełny dziennik decyzji jest w historii rozmowy Windows)

1. Ta sama sesja WCZEŚNIEJ zrobiła i już **wypchnęła na main** (v3.67.0, PRZED tym
   handoffem, więc to JEST już live): auto-odbudowa księżyca po zniszczeniu, ewakuacja
   floty z gołej planety, fuel-fallback dla ratunku moon→moon, naprawa E7/expoLandings.
   To przeszło pełny audyt (5 agentów + weryfikacja adwersarialna) i jest bezpieczne.
2. Owner poprosił o odtworzenie na Genesis funkcji **Fleet Save (FS)** z Atheny (2.x,
   `ogamex-bot.user.js`, zamrożony plik) — "bardzo dobrze działała, chcę dokładnie tak
   samo". Zbadałem kod Atheny (agent workflow, w pełni) i porównałem z Genesis.
3. **KLUCZOWE odkrycie z badania**: na Athenie "FS" i "ucieczka w powietrzu przy ataku
   na oba ciała" (AirSave) to były DWA osobne, kopiowane mechanizmy zawracania. Na
   Genesis mechanizm zawrotu już jest JEDEN, generyczny (`kind:"recall"` → `Fly.recall()`,
   działa dla FS i dla ratunku w ataku identycznie) — **to NIE wymagało portu, już jest
   lepsze niż na Athenie**. Prawdziwe braki (potwierdzone też przez audyt AUDYT-FLOTA-
   2026-08-29.md, punkty R3 i Z8) to: (a) FS domyślnie wyłączony, (b) FS/ucieczka biorą
   CAŁY hangar razem z minerami/recyklerami.
4. Owner doprecyzował PRZEZ ROZMOWĘ (ważne, bo zmieniło się w trakcie — patrz niżej),
   że mechanizm FS na Athenie to: **jedna godzina powrotu** (nie okno start-koniec),
   **start natychmiast** gdy flota stoi bezczynnie na księżycu (o dowolnej porze dnia,
   nie tylko nocą), zawrót liczony WSTECZ od tej godziny na podstawie PRAWDZIWEGO czasu
   lotu z formularza. Trik na "cały czas w locie": bardzo niska prędkość (np. 3%) robi
   z jednego lotu tam-i-z-powrotem naturalnie długi wyjazd — NIE trzeba wielu pełnych
   rund (to była moja wcześniejsza nadinterpretacja audytu Atheny, owner to sprostował).

   **UWAGA**: w trakcie tej sesji owner NAJPIERW odpowiedział w AskUserQuestion, że chce
   ZOSTAWIĆ obecne okno nocne Genesis (start-koniec) — a POTEM, widząc że to nie to, o co
   mu chodziło, sprostował na "jedna godzina powrotu, start natychmiast" (mechanizm
   Atheny). **Ostateczna, obowiązująca decyzja to ta druga** — kod w tym branchu
   implementuje mechanizm Atheny (returnHour), NIE okno.

## Co ZROBIONE w tym branchu (ogamex-3.user.js, test3-decide.js, test3-e2e.js)

Wszystkie zmiany oznaczone komentarzem `v3.68.0` w kodzie — `grep -n "v3.68.0" ogamex-3.user.js` pokaże wszystko naraz.

1. **CFG.fs przeprojektowane**: `{enabled, startHour, endHour, speedPct, target}` →
   `{enabled, returnHour, returnMinute, speedPct, target}`. Migracja jednorazowa
   (`migr_fs_returnhour_v368`) przenosi stare `endHour` na `returnHour`, żeby "godzina 7"
   ustawiona wcześniej nie zniknęła po cichu (ten sam wzorzec co migracja `CFG.moon`
   z v3.67.0).
2. **Nowa funkcja `fsReturnAt(fs, d)`** (obok istniejącej `nightWindow`) — liczy NASTĘPNE
   wystąpienie skonfigurowanej godziny powrotu. Wołana w `Situation.refresh()` (POZA
   `decide()`, ten sam powód co `nightWindow` — strefa czasowa maszyny nie może wejść do
   czystej funkcji), wynik w `s.fsReturnAt`.
3. **`s.night` przestało być liczone z `CFG.fs`** — FS nie ma już okna, więc nic nie woła
   `nightWindow(CFG.fs, ...)`. `s.night`/`nightWindow()` jako FUNKCJA zostały (test
   "21. OKNO NOCNE" nadal je testuje bezpośrednio, niezmienione), po prostu nic
   produkcyjnego już ich nie woła — jeśli w przyszłości nikt tego nie potrzebuje, można
   je usunąć, ale zostawiłem jako martwy, nieszkodliwy kod (mniejsze ryzyko niż usuwanie
   pod presją czasu).
4. **`Human.economyAllowed()`** — pauza ekonomii "bo flota jest na FS" teraz sprawdza
   REALNY stan floty (`s.flights` z `fs:true` i `phase!=="done"`), nie zgaduje po zegarze
   okna (które i tak już nie istnieje).
5. **Reguła FS w `decide()`** (gałąź ciszy, szukaj "FLEET SAVE"):
   - Wyzwala się OD RAZU (bez `s.night.active`), gdy flota stoi bezczynnie **na
     księżycu**. Jeśli flota jest TYLKO na planecie — nowy alert "nie wysyłam stamtąd
     (falanga), czekam aż będzie na księżycu" (port zasady Atheny "z planety nigdy").
   - Cel: jeśli `cfg.fs.target` ustawiony — jest JEDYNYM wyborem (Athena: brak
     cichego podstawiania innej kolonii; jeśli cel nieznany/bez księżyca/atakowany →
     alert, nie zgadywanie zastępcze). Bez ustawionego celu: stare zachowanie Genesis
     (najdalsza bezpieczna kolonia).
   - `recallAt: s.fsReturnAt` (nie okno).
   - Niesie `excludeTypes: evacExclude` (patrz punkt 6).
6. **`evacExclude`** — nowa stała liczona na starcie `decide()`: `["ASTEROID_MINER"]`
   gdy `cfg.aster.enabled`, `["RECYCLER"]` gdy `cfg.debris.enabled` (WARUNKOWE, jak na
   Athenie — bezczynny miner/recykler leci normalnie). Dodane też do DWÓCH istniejących
   akcji ratunku w ataku (`neighbourMoon` i `anyRefuge` — to były "AirSave" Atheny) —
   **decyzja ownera z AskUserQuestion: zakres = FS + ucieczka w ataku, NIE ślepy alarm**
   (ten ostatni świadomie pominięty, można dorobić później jeśli owner zapyta).
7. **`Fly.form()`** — nowy tryb ładowania statków: gdy brak `m.plan` ALE jest
   `m.excludeTypes`, bierze WSZYSTKO oprócz wykluczonych typów (zamiast dosłownie
   wszystkiego). Dwa miejsca (ładowanie + runda weryfikacji pól) zmienione spójnie.
   Nowa gałąź "tylko wykluczone typy w hangarze" (quiet abort, nie error) — inaczej
   hangar z samymi minerami dawałby fałszywy `[LOT DOM] nie znalazłem pól statków` ERROR.
8. **`emptySourceHangar`** (wołane po `Fly.confirmed()`) — POMIJANE, gdy `m.excludeTypes`
   niepuste, bo zerowanie całego hangaru skłamałoby "nic tu nie ma", gdy w rzeczywistości
   miner/recykler zostały w domu (ryzyko: obrona nie widziałaby zostawionej floty przy
   ataku, dopóki nie przyjdzie świeższy odczyt).
9. **Panel UI**: pole "od X do Y" zmienione na "wróć o HH", dodane pola "cel (księżyc)
   g:s:p" i "prędkość %" (na Athenie prędkość i cel NIE były w panelu — teraz są, bo
   owner aktywnie o nich mówił jako o dźwigniach). Status FS w pasku pokazuje realny
   stan (w drodze / w domu), nie okno.
10. **Testy**: `test3-decide.js` sekcja "20. FLEET SAVE" przepisana od zera (start od
    razu, cel stały z walidacją, cel automatyczny, excludeTypes warunkowe, start tylko z
    księżyca, brak duplikatu przy ataku). Sekcja "22. HUMANIZER" zaktualizowana pod nowy
    warunek. `test3-e2e.js` sekcja "15. FLEET SAVE" przepisana (start od razu zamiast
    okna) + NOWA sekcja "15b" — pełny test end-to-end na PRAWDZIWYM hangarze mieszanym
    (BATTLESHIP + ASTEROID_MINER), potwierdza że miner FAKTYCZNIE zostaje w formularzu
    gry, nie tylko w akcji decide().

## Co ZWERYFIKOWANE

- `node test3-decide.js` — **100% zielono** (szybkie, deterministyczne, bez prawdziwych
  timerów — ufaj temu wynikowi bez zastrzeżeń).
- `node test3-e2e.js` — uruchomione 4× pod rząd na Windows. Za KAŻDYM razem realny czas
  ~3-4 min przy `user`+`sys` bliskim zeru (`time node test3-e2e.js`) — to znaczy, że
  proces Node stał zawieszony przez system, nie liczył — Windows w tej sesji ma
  nawracający problem z usypianiem procesów w tle (obserwowane też WCZEŚNIEJ w tej samej
  sesji, przed tym branchem, niezwiązane z FS). Efekt: w KAŻDYM z 4 przebiegów padały
  INNE, losowe, niezwiązane z FS scenariusze (ekspedycje, dubel ataku, formularz) —
  klasyczny objaw zegara realnego skaczącego do przodu w trakcie zawieszenia. **Moje
  nowe scenariusze FS (15, 15b) przeszły czysto we WSZYSTKICH 4 przebiegach** — to
  mocny, ale nie 100%-pewny dowód poprawności (nie ma ani jednego w pełni czystego
  przebiegu CAŁEGO pliku e2e w tym branchu).

## Co NIE jest zrobione — DOKŁADNIE to jest do zrobienia na Macu

1. **Uruchom `node test3-e2e.js` (i `node test3-all.js`) na czysto na Macu.** Inne
   środowisko może nie mieć problemu z zawieszaniem procesów, jakiego doświadczał
   Windows — jeśli dostaniesz jeden w pełni czysty przebieg (0 FAIL), to wystarczający
   dowód. Jeśli macOS ma TEN SAM objaw (`time node test3-e2e.js` pokazuje duży `real`
   przy znikomym `user`+`sys`), traktuj FAIL-e jako artefakt środowiska, NIE jako
   dowód błędu w kodzie — ale spróbuj kilka razy i sprawdź, czy błędy pojawiają się w
   RÓŻNYCH miejscach za każdym razem (flaki) czy zawsze w TYCH SAMYCH (prawdziwy bug).
2. **Rozważ audyt przed push**, tak jak przy v3.67.0 (owner poprosił o to explicite przy
   poprzedniej dużej zmianie i było warto — audyt znalazł 19 prawdziwych błędów). Ten
   branch jest mniejszy niż v3.67.0, ale dotyka `Fly.form()` — funkcji używanej przez
   WSZYSTKIE typy lotów (ekspedycje, ratunek, złom, minery), nie tylko FS — warto
   sprawdzić, czy zmiana w ładowaniu statków (`want`/`excl`) nie ma efektów ubocznych
   dla ścieżek, które NIE ustawiają `excludeTypes` (powinno być bezpieczne — `excl` jest
   pustym Setem, gdy `m.excludeTypes` nie istnieje — ale to jest DOKŁADNIE ten rodzaj
   rzeczy, którą adwersarialny audyt łapie, a ja mogę przeoczyć).
3. **Merge do main i push, TYLKO po powyższym.** Branch: `fs-atheny-port-v368`.
   `git checkout main && git merge fs-atheny-port-v368 && git push origin main`
   (albo PR, jeśli owner wtedy tak zechce).
4. **Po pushu**: przypomnij ownerowi, żeby ustawił `cfg.fs.target` (stały księżyc) i
   `cfg.fs.returnHour` w panelu — bez tego FS poleci z domyślnym `returnHour=7,
   target=null` (najdalsza kolonia), co MOŻE nie być tym, czego chce.
5. **Nierozstrzygnięte podczas tej sesji** (jeśli owner zapyta, nie zgaduj — dopytaj):
   czy wykluczenie minerów/recyklerów (`excludeTypes`) ma objąć też ślepy alarm
   (`blind:true` w kodzie) — świadomie pominięte w tej sesji, zakres był "FS + ucieczka
   w ataku" tylko.

## Ważne przypomnienia z CLAUDE.md (nie zapomnij)

- `ogamex-3.user.js` = Genesis, AKTYWNY rozwój. `ogamex-bot.user.js` = Athena,
  ZAMROŻONY, tylko do odczytu jako źródło wzorców — NIE edytuj.
- Bump `@version` przy KAŻDEJ zmianie (już zrobione: 3.68.0).
- Push na `main` = auto-deploy na żywego bota w ataku — stąd branch, nie bezpośredni push.
- `node test3-all.js` PRZED każdym pushem na main.
