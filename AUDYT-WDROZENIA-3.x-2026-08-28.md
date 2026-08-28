# AUDYT WDROŻENIA 3.x przed startem Genesis (28.08.2026)

Pytanie: czy wszystko jest **poprawnie zaplanowane i wdrożone**? Poniżej: co sprawdziłem, co znalazłem, co naprawiłem, co zostaje ryzykiem.
Stan wyjściowy audytu: v3.6.1 (1102 linie, 89 asercji). Stan po audycie: **v3.8.0, 113 asercji**.

## 1. Metoda
1. **Symulacja pierwszego dnia uniwersum** — odpalenie prawdziwej `decide()` i `expoPlan()` na sytuacjach, które wystąpią na Genesis: jedna planeta bez księżyca, 1 slot floty, mała flota, pusty hangar, flota w powietrzu.
2. **Ścieżki brzegowe** — flota na obu ciałach pary, atak bez znanego ciała celu, atak na kolonię spoza paska planet, dwa hangary o różnym wieku odczytu.
3. **Spójność stanu** — kto zapisuje `Situation`, gdzie są `await`, co się dzieje przy dwóch kartach.
4. **Odporność pętli** — co przeżyje wyjątek, co się stanie, gdy pętla umrze.
5. **Kompletność panelu** — czy operator ma dźwignie na wypadek, gdy bot się myli.
6. Dwa niezależne przeglądy kodu w tle (świeże oko + porównanie z 2.x) — wyniki w sekcji 5.

## 2. Znaleziska GROŹNE (naprawione)

### Z1. Flota na obu ciałach pary — bot zostawiał większy hangar pod atakiem `v3.7.0`
`fleetAt()` zwracał JEDNO miejsce postoju floty. Przy flocie na księżycu (50 statków) i planecie (200 000) oraz ataku w **planetę** bot odpowiadał „bezpieczna strona — nie ruszam floty" i zostawiał 200 000 statków pod uderzeniem. Wybór ciała zależał od tego, który hangar odczytano później — czyli od przypadku.
**Naprawa:** decyzja patrzy na każde ciało z flotą osobno (`fleetsAt`), ratuje z ciała pod atakiem; gdy oba są atakowane i na obu stoi flota — ratuje z większego i ostrzega o drugim.

### Z2. Cisza przy ataku na kolonię spoza paska planet `v3.7.0`
Pętla decyzji chodziła wyłącznie po parach z paska planet. Zagrożenie na kolonię, której na pasku nie było (strona bez sidebara, świeżo skolonizowana planeta), **znikało bez śladu — zero akcji, zero alertu**. Dla bota, którego jedynym zadaniem jest nie stracić floty, cisza przy ataku to najgorszy możliwy stan.
**Naprawa:** każde zagrożenie spoza znanych par kończy się głośnym alarmem w logu **i pushem na telefon**.

### Z3. Rezerwa slotów blokowała ekspedycje na starcie uniwersum `v3.7.1`
Na starcie masz 1 slot floty, a domyślna rezerwa (1 slot na ratunek) oznaczała, że ekspedycje **nigdy by nie poleciały** — z mylącym komunikatem w logu.
**Naprawa:** gdy fala zabiera CAŁY hangar, ratować nie ma już czego, więc wolno zająć ostatni slot. Fala częściowa nadal zostawia slot na ucieczkę.

### Z4. Wyścig zapisu stanu między kartami `v3.7.2`
`refresh()` czeka na AJAX listy ruchów, a zapisywał obiekt załadowany **przed** tym oczekiwaniem. Druga karta (albo `Hangar.scan` po przeładowaniu) mogła w tym oknie dopisać świeży odczyt hangaru — i ten odczyt przepadał. W skrajnym przypadku mógł przepaść zapis lotu obronnego, czyli bot „zapomniałby" zawrócić flotę.
**Naprawa:** zapis scalający — świeższe odczyty hangaru/slotów i loty dopisane w międzyczasie są zachowywane.

### Z5. Brak ręcznych dźwigni operatora `v3.8.0`
W 2.x przyciski „RATUJ FLOTĘ" i „WRÓĆ NA BAZĘ" wielokrotnie ratowały sytuację, gdy bot był ślepy albo się mylił (27.08: operator sam skoczył bramą i sam zawracał flotę). W 3.x ich nie było — operatorowi zostawało ręczne klikanie formularza.
**Naprawa:** oba przyciski. „RATUJ FLOTĘ TERAZ" używa **tej samej decyzji co automat** (podstawia wirtualne zagrożenie w ciało, gdzie stoi flota) i nie czeka na potwierdzenie. „WRÓĆ NA BAZĘ" zawraca trwający lot albo ściąga flotę z planety na księżyc.

### Z6. Wyjątek w ekonomii mógł wywalić przebieg obrony; martwa pętla nie miała nadzorcy `v3.7.3`
Wszystkie moduły dzieliły jeden `try`. Dodatkowo nic nie sprawdzało, czy pętla obrony w ogóle jeszcze się odbija — a bot martwy, który wygląda na żywego, to stan, który w 2.x kosztował flotę.
**Naprawa:** ekonomia w osobnym `try` (jej błąd nie dotyka obrony); trzy błędy rdzenia z rzędu → push „bot może być ŚLEPY"; **nadzorca** przeładowuje stronę po 3 min ciszy pętli (z dławikiem, nigdy w trakcie lotu).

## 3. Sprawdzone i POPRAWNE (bez zmian)
- Atak w ciało bez floty → zero ruchu (bezpieczna strona).
- Cel lotu nigdy nie jest ciałem, w które leci atak.
- Jedna ucieczka na parę; druga para dostaje własny ratunek niezależnie.
- Sondy nie ruszają flotą; sojusznicze misje nie liczą się jako atak.
- Odczyt hangaru starszy niż 48 h → alarm, nie ruch floty na podstawie starych danych.
- Loty ekonomiczne (ekspedycja, mining, złom) **nie trafiają** do stanu lotów obronnych — nie mogą zablokować ratunku.
- Przerwy humanizera i okno nocne dotyczą wyłącznie ekonomii; obrona, rekonesans i keepalive chodzą zawsze.
- Ekspedycje: rozmiar fali zamrożony na serię, ostatnia fala domyka hangar, limity slotów, odstęp fal, 40 min dla Odkrywcy.
- Mining: nie skanuje bez minerów w hangarze (zero jałowej nawigacji), pomija asteroidy znikające za < 5 min.
- Złom: recyklery świadomie nie latają na ekspedycje, więc zawsze jest czym zbierać.

## 4. Ryzyka, które ZOSTAJĄ (nie da się ich zamknąć kodem przed startem)
| ryzyko | dlaczego zostaje | co je ogranicza |
|---|---|---|
| **Markup Genesis może się różnić od Atheny** | zero kontaktu z serwerem | tryb Obserwator na start, raport startowy 4/4, zrzuty DOM zamiast zgadywania |
| Zero testów na żywo całej ścieżki lotu | serwer nie wystartował | test symulacji w panelu jako pierwsza rzecz po kalibracji |
| Dolot < 40 s | formularz fizycznie nie zdąży | tylko alarm + push; to samo ograniczenie miał 2.x |
| Atak w chwili, gdy flota ląduje z ekspedycji | okno kilkunastu sekund | rekonesans co 8 min, ale to nie zamyka okna |
| Bot działa tylko przy otwartej karcie | natura userscriptu | Wake Lock, cichy dźwięk, nadzorca, push na telefon |

## 5. Wyniki dwóch niezależnych przeglądów kodu → **12 defektów, wszystkie naprawione** (`v3.9.0`, `v3.9.1`)

Dwa przeglądy (świeże oko na kod 3.x + porównanie lekcja-po-lekcji z 2.x) znalazły to, czego sam nie zobaczyłem. Najgroźniejsze:

| # | defekt | jak by się objawił w grze | naprawa |
|---|---|---|---|
| **K1** | **`TabLock` blokował bota przed samym sobą** — id karty losowane przy KAŻDYM ładowaniu strony, a bot nawiguje na każdym kroku ratunku | po pierwszej nawigacji bot milczy 90 s, potem znowu — **praktycznie by nie działał**, a panel wyglądałby na żywy | id w `sessionStorage` (przeżywa nawigacje tej karty); karta widoczna przejmuje od zdławionej w tle |
| **K2** | **lot „dom = księżyc" nigdy się nie domykał** — wpis czekał na zapełnienie hangaru ŹRÓDŁA, które przy planeta→księżyc zostaje puste | po pierwszej rutynowej akcji para była uznawana za „w locie" i przez **12 h bot nie bronił jej wcale** | lot bez zawrotu domyka hangar CELU; twardy limit 30 min |
| **K3** | **zawrót nie utrwalał się** — `recall` mutował obiekt spoza zapisywanego stanu | zawrót klikany w kółko, lot nigdy nie domknięty, para trwale zablokowana, dziennik zaśmiecony | praca na obiekcie z zapisywanego stanu |
| **K4** | **sondy blokowały rekonesans i ekonomię** — wpadały do tej samej bramki co ataki | przy ciągłym sondowaniu hangary się starzeją → bot przestaje wiedzieć, gdzie stoi flota | bramki reagują tylko na `attack` |
| **K5** | **deadlock „nie wiem, gdzie flota" + „nie sprawdzę, bo alarm"** | pierwszy atak po instalacji = zero akcji przez cały dolot | nowa akcja `recon`: przy ataku i nieznanym hangarze bot idzie sprawdzić, jeśli ma >90 s |
| **K6** | **lot zapisywany PO kliknięciu „Send fleet"** (klik potrafi nawigować natychmiast) | flota ucieka **bez zaplanowanego zawrotu** i zostaje na refugium; ekspedycja mogła polecieć dwa razy | zapis + stempel PRZED klikiem, wpis `pending` zdejmowany po potwierdzeniu |
| **K7** | brak weryfikacji pól statków (2.x: log mówił „załadowane 1,38 mld", statki zostały w domu) | „udana" ewakuacja zostawiająca flotę pod ostrzałem | dwie rundy odczytu pól z powrotem |
| **K8** | cichy `null`, gdy nie rozpoznano paska planet na `/fleet` | bot trwale ślepy na położenie floty i **nikt się o tym nie dowie** | zrzut DOM + push |
| **K9** | wrogi wiersz o nieparsowalnym celu znikał bez śladu | atak w nieznanym markupie = zero linii w logu | zrzut wiersza + push |
| **K10** | brak karencji po nieudanym locie | ta sama akcja co 5 min w nieskończoność | karencja trasy 3 min |
| **K11** | płytki merge configu | po aktualizacji brak nowych pól → `NaN` w humanizerze | scalanie głębokie |
| **K12** | kod startowy poza `try` | wyjątek = panel zielony, `setInterval` nigdy zarejestrowany, bot martwy | każdy krok startu w osobnym `try` |

Osobno, jako **braki wobec 2.x** (naprawione w `v3.9.1`):
- **Pasek misji nie był źródłem decyzji.** Fork nie pokazuje na liście ataków z własnego układu — w 2.x kosztowało to flotę (12.08) i o włos drugą (25.08). 3.x czytał pasek tylko do panelu. Teraz nadwyżka „pasek minus rozpoznane wiersze" utrzymująca się >60 s (przy „Type: Spy" — 5 min) uruchamia **ślepy alarm**: bot nie zgaduje celu, tylko ratuje kolonię, w której naprawdę stoi flota.
- **Godziny ciszy były podpięte pod Fleet Save**, więc przy FS OFF (domyślnie) ekonomia chodziłaby 24/7 — głośniej niż 2.x. Teraz cisza ma własne okno z dziennym jitterem granic, plus sufit 240 nawigacji/h dla ekonomii (obrona nielimitowana).
- **Brak detektora strony błędu forka** (2.x stał na niej godzinami). Teraz wykrycie + powrót do gry.
- **Sesja:** pominięcie odczytu przy „sesja padła" sprawiało, że nic nie mogło stwierdzić jej powrotu — sztywne 15 min ślepoty. Teraz ponawianie i samonaprawa nawigacją po 2 min.

## 5b. TEST E2E — bot uruchomiony na sztucznej grze (`v3.9.3`)
Pytanie „czy obrona **działa**" nie da się zamknąć testem wzorców w źródle. Dlatego powstał `test3-e2e.js`: **cały plik `ogamex-3.user.js` uruchamiany w jsdom na atrapie forka** (pasek planet, pasek misji, panel Events, lista ruchów po AJAX, trzykrokowy formularz floty), gdzie nawigacja = ponowne wykonanie skryptu, tak jak w przeglądarce.

Co przechodzi (22 sprawdzenia):
- **pełna ścieżka ewakuacji**: wykrycie ataku → decyzja → przełączenie ciała → wypełnienie hangaru → 3 kroki formularza → „Send fleet"; flota wylatuje z atakowanego księżyca **na sąsiedni księżyc**, zabiera cały hangar, misja to Deploy, hangar źródła pustoszeje;
- **lot zapisany w stanie z zaplanowanym zawrotem** (bez tego flota zostaje na refugium na zawsze);
- atak na planetę przy flocie na księżycu → **zero ruchu** i komunikat o bezpiecznej stronie;
- tryb Obserwatora: alarm bez ruchu floty;
- dwie karty: druga ustępuje, brak podwójnej wysyłki;
- **wielokrotne przeładowania strony nie gubią misji** i nie powodują drugiej wysyłki;
- atak na **nieaktywną** kolonię (której lista ruchów nie pokazuje) → bot ją zauważa i wyprowadza flotę;
- ekspedycja leci i **nie zapisuje się jako lot obronny**.

Symulator wykrył trzy defekty niewidoczne dla testów wzorcowych — wszystkie naprawione:
1. rekonesans przy ataku szedł zawsze na **planetę**, więc przy flocie na księżycu bot zostawał w stanie „nie wiem, gdzie flota";
2. rekonesans nie sprawdzał **drugiego ciała pary**, więc nie potrafił stwierdzić „bezpiecznej strony";
3. **`ReferenceError: homeKey`** w module ekspedycji — błąd wywalał całą ekonomię (łapany, ale ekspedycje nigdy by nie poleciały).

## 6. Ocena planu
Plan („dusiciel": parsery 1:1 z 2.x, stan i decyzje od nowa) **broni się** — wszystkie sześć znalezisk tego audytu to defekty w NOWYM kodzie stanu/decyzji, żaden w przeniesionych parserach. To potwierdza tezę audytu z rana: parsery były sprawdzone bojowo, a gubił się stan.
Zakres na start (obrona + rekonesans + FS nocny + ekspedycje Odkrywcy + mining + złom + humanizer) odpowiada temu, co 2.x realnie robił, minus rzeczy bezprzedmiotowe w nowym uniwersum (brama, odbudowa księżyca, farmienie nieaktywnych).
