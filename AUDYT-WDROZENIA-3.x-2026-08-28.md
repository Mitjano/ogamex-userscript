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

---

# 7. TRZECIA FALA — audyt regresji + 6 nowych scenariuszy E2E (v3.10.0, 28.08 wieczór)

Powód: po 21 poprawkach z fal 1–2 kod zmienił się na tyle, że poprzednie przeglądy dotyczyły już innego pliku. Trzecia fala celowała **nie w projekt, tylko w skutki poprawek** — plus w te zachowania, których symulator nigdy nie wykonał (druga połowa cyklu ratunkowego: zawrót, powrót, samonaprawa).

## 7.1 Defekty znalezione i naprawione (10)

| # | Defekt | Jak by się objawił w grze |
|---|---|---|
| **P0** | Wpis lotu `pending` był **nieśmiertelny**: `if (f.pending) return true` stało przed wszystkimi regułami wygaszania, a kasował go wyłącznie kod **po** `send.click()` — który przy natychmiastowej nawigacji nie wykonuje się wcale. Kod sprzątający przy nieudanej wysyłce był **nieosiągalny** (stał za `return this.abort(...)`). | Po jednej udanej ewakuacji wpis zostaje na dysku na stałe → `inFlightFrom` uznaje parę za „w locie" → **bot milczy przy każdym kolejnym ataku na tę parę**. Panel pokazuje zagrożenie, log nic nie mówi. Dla lotów `home`/`swap` (bez zawrotu) blokada byłaby wieczna, a „powrót na księżyc" to najczęstsza rutynowa akcja bota. |
| **P1** | Akcja `recon` kończy przebieg nawigacją (`return`), a `decide()` iteruje pary w kolejności paska planet. | Para atakowana **za 70 s** czekała, bo inna para (atak za 400 s) potrzebowała rekonesansu. Przy progu „za późno na formularz" = 40 s to realna utrata floty. |
| **P2** | Skrócona karencja po potknięciu formularza obejmowała tylko loty `air`; ratunek „na drugie ciało pary" jej nie miał. | Jedno potknięcie = 3 minuty bezczynności na trasie, przy dolotach ~5 min. |
| **P3** | `flightStale` odblokowywał obronę, ale ekonomia i rekonesans dalej patrzyły na surowe `phase === "launched"`. | Bot „odzyskiwał" obronę pary, ale przestawał odświeżać hangary — czyli i tak nie wiedział, gdzie stoi flota. |
| **P4** | Ręczna dźwignia „WRÓĆ NA BAZĘ" nie znała nowego stanu `recall_clicked`. | Awaryjny przycisk nie działał dokładnie w sytuacji, dla której powstał. |
| **P5** | Nieudana próba zawrotu nie odświeżała zegara ponowień. | 5 zbędnych żądań listy ruchów pod rząd — widoczne z drugiej strony. |
| **P6** | Alarm o „ślepym" locie wystawiany co minutę, do 12 h. | Do 720 wpisów przewijających cały dziennik obrony (limit 400) — dowody ataku wypadały z logu. |
| **P7** | Martwa zmienna po poprawce v3.7.0 + nieosiągalna gałąź sprzątania. | Ślad po niedokończonej poprawce; usunięte. |
| **P8** | Czyszczenie `Once` kasowało wpisy starsze niż godzina, więc **każdy dławik dłuższy niż 1 h działał jak 1 h**. | Szum w logu (keepalive, zrzuty DOM). |
| **P9** | `barMaxAgeMs` był martwym kluczem (CFG budowane wyłącznie z `DEFAULTS`); stare odczyty slotów blokowały ekspedycje bezterminowo. | Konfiguracja bez efektu; ekonomia zablokowana po zamrożonym rekonesansie. |

Dodatkowo z fali 2 (znalezione tym samym przeglądem, naprawione w tej samej wersji): **lot ekonomiczny blokował całą obronę** do 5 min (`if (Fly.mission()) return`), **ślepy alarm mógł ruszyć flotę na podstawie paska sprzed godziny** (strona bez paska zostawiała stary odczyt), **`phase="recalled"` ustawiane po samym kliknięciu** (nieskuteczny klik nie doczekał się drugiej próby), **lot po nieudanym zawrocie zaślepiał parę na 12 h**.

## 7.2 Nowe scenariusze symulatora (14 zamiast 8, 45 sprawdzeń zamiast 22)

Atrapa gry dostała: własne loty w Events i na liście ruchów, **przycisk zawracania** `a.x_btn_fleet_return`, stronę logowania, stronę błędu, „duchy" na pasku misji (obce floty bez wiersza) oraz sterowanie upływem czasu.

| # | Scenariusz | Co potwierdza |
|---|---|---|
| 9 | **Zawrót**: atak minął → bot klika zawracanie → flota wraca → wpis lotu zdjęty | domknięcie drugiej połowy cyklu ratunkowego, której kod nigdy wcześniej nie wykonał poza żywą grą |
| 10 | **Ślepy alarm**: pasek widzi 3 obce floty, lista pusta | przez pierwszą minutę bot NIE ucieka (nadwyżka musi być trwała), po progu ratuje największy hangar |
| 11 | **Utrata sesji**: gra oddaje stronę logowania, potem operator się loguje | bot krzyczy „SESJA", nie udaje wysyłki ze strony logowania, po powrocie sesji broni normalnie |
| 12 | **Dwa ataki naraz** na dwie pary z flotą | obie floty uratowane, **żadna nie poleciała na atakowane ciało**, obie do nieatakowanego schronu |
| 13 | **Atak w trakcie misji ekonomicznej** | ekonomia przerwana, ratunek wykonany (dawniej: obrona martwa do 5 min) |
| 14 | **Nieznany hangar przy ataku, rekonesans wyłączony** | bot melduje „nie wiem, gdzie stoi flota" — cisza przy ataku jest zakazana |

## 7.3 Stan po trzeciej fali
- `node test3-all.js` → **157 asercji decyzyjnych + 45 sprawdzeń E2E + składnia, wszystko zielone** (kod wyjścia sprawdzany bez pipe'a).
- Łącznie w trzech falach: **31 defektów znalezionych i naprawionych**. Wszystkie — tak jak poprzednio — w nowym kodzie stanu i decyzji; **ani jeden w parserach przeniesionych z 2.x**.
- Trzy nowe przypadki w macierzy pilnują, żeby P0 i P1 nie wróciły (osierocony `pending` sprzed doby, lot po nieudanym zawrocie, dwie pary o różnej pilności).

## 7.4 Co zostaje otwarte (świadomie)
1. **Markup Genesis niezweryfikowany** — zero kontaktu z żywym serwerem. Wszystkie parsery pochodzą z Atheny; przy nieznanym markupie bot zrzuca DOM do logu zamiast zgadywać. To rozstrzygnie raport startowy 4/4 z pierwszego dnia.
2. **Wracające floty wroga na pasku** — jeśli fork liczy je jako „Hostile", po każdym odpartym ataku powstanie nadwyżka „pasek minus lista" i może odpalić ślepy alarm. Z kodu nie da się tego rozstrzygnąć; **do sprawdzenia na żywo** (objaw: ewakuacja tuż po tym, jak atak przeleciał). Zabezpieczenie częściowe już jest: nadwyżka musi się utrzymać 60 s (5 min przy sondach).
3. **Dolot poniżej 40 s** — na formularz floty fizycznie nie ma czasu; bot alarmuje i nic nie udaje.
4. **Mining i złom w pełnym przebiegu DOM→wysyłka** nie mają jeszcze scenariusza E2E (mają testy czystych funkcji). Powód: wymagają dołożenia do atrapy wiersza 17 galaktyki i pola złomu. Obrona ich nie dotyczy — do zrobienia, gdy moduły ruszą w grze.

---

# 8. CZWARTA FALA — 10 nowych scenariuszy E2E (v3.10.1–3.10.3)

Cel: wykonać w symulatorze te ścieżki, których kod nigdy nie przeszedł poza żywą grą. Doszło 10 scenariuszy (14 → 24) i 32 sprawdzenia (45 → 77).

## 8.1 Defekty znalezione przez nowe scenariusze

| # | Defekt | Skutek w grze |
|---|---|---|
| **1** | `Hangar.scan()` zapisywał `total: 0` na KAŻDEJ stronie `/fleet` — także na kroku 2 i 3 formularza, gdzie listy statków po prostu nie ma | bot w trakcie wysyłania floty **sam kasował sobie wiedzę o tym, gdzie ona stoi**; po przerwaniu misji meldował „nie wiem, gdzie flota" i nie ratował. Teraz zero zapisujemy tylko wtedy, gdy gra faktycznie mówi „nie masz tu floty" |
| **2** | Zawrót był wystawiany wyłącznie dla lotów, które nie są „przeterminowane" (`flightStale`) | **FS nocny trwa 8 h** — godzinę po planowanym świcie bot przestawał zawracać i pisał „sprowadź flotę ręcznie". Teraz porzucenie floty w powietrzu jest niemożliwe: zawrót działa niezależnie od wieku wpisu |
| **3** | Lot krótszy niż termin zawrotu (np. gdy nie udało się ustawić 10 %) i tak dostawał zaplanowany zawrót | flota **lądowała**, zawracać nie było czego, a wpis wisiał godzinami i zaślepiał parę. Teraz taki lot jest oznaczany jako lądowanie (`recallAt: 0`) i domyka go hangar CELU |
| **4** | Reguła z punktu 3 działała tylko w chwili odczytu czasu lotu | gdy krok 2 został pominięty (formularz już był na kroku 3 po przeładowaniu), wpis zapisywał się ze starym terminem. Teraz termin przeliczany jest przy **każdym** zapisie lotu i w chwili, gdy czas lotu staje się znany |
| **5** | „Rekonesans ustępuje ratunkowi" (P1 z fali 3) obejmowało **każdy** lot — także nocny FS | bot wysyłał FS na podstawie godzinnego odczytu hangaru zamiast najpierw sprawdzić, czy flota tam jeszcze stoi. Teraz ustępuje tylko realnemu ratunkowi, a FS na starych danych najpierw robi rekonesans |
| **6** | `errorPageGuard` nie rozpoznawał zwykłego „Internal Server Error" / 50x | przy takiej stronie bot nie wracał do gry sam |

## 8.2 Nowe scenariusze (15–24)

| # | Scenariusz | Co potwierdza |
|---|---|---|
| 15 | **FS nocny w pełnym przebiegu** | wyjście na najdalszą kolonię, 10 % prędkości, Deploy, zawrót o świcie wykonany samodzielnie |
| 16 | **Strona błędu gry** | bot ją rozpoznaje, wraca do gry i po powrocie broni normalnie |
| 17 | **Operator przełącza planetę w środku formularza** | bot nie wysyła floty z cudzej planety i mimo przerwania dowozi ratunek |
| 18 | **Potknięcie formularza** (martwy przycisk „Next") | ratunek ponawiany po 45 s — przy karencji 3 min bot stałby dłużej niż trwa dolot |
| 19 | **Nieaktualny hangar** (flota nie stoi tam, gdzie bot myśli) | nie wysyła z pustego ciała i nie milknie |
| 20 | **Nieświeży pasek** | nie ewakuuje floty na podstawie odczytu sprzed godziny |
| 21 | **Formularz bez suwaka prędkości** | ratunek i tak wychodzi, bot głośno melduje brak prędkości i nie planuje zawrotu lotu, który wyląduje |
| 22 | **Mining** | skan układów z zakresów asteroid → minery na pozycję 17, flota bojowa zostaje w domu |
| 23 | **Złom** | recyklery na pole szczątków (`data-planet-type=3`), bez floty bojowej |
| 24 | **Atak przerywa mining** | ratunek wychodzi z pełną flotą bojową mimo włączonej ekonomii |

## 8.3 Stan
- `node test3-all.js` → **164 asercje decyzyjne + 77 sprawdzeń E2E (24 scenariusze) + składnia, wszystko zielone**.
- Łącznie w czterech falach: **37 defektów** znalezionych i naprawionych.
- Symulator dostał też sterowanie czasem dla dławików ekonomii, czas lotu zależny od prędkości i wierne przeładowanie strony po wysyłce — bez tego trzy scenariusze mierzyły własne niedokładności zamiast zachowania bota.
