# AUDYT PEŁNY 3.x — obrona floty i ekspedycje (v3.68.2, HEAD 8eca051)

Data: 04/05.09.2026. Zlecenie właściciela: „profesjonalny audyt, czy wszystko jest dobrze
zaplanowane i wdrożone; najważniejsza ochrona floty i ekspedycje".

---

## WERDYKT

**Obrona floty NIE jest w dobrym stanie.** Bot poprawnie wykrywa i ratuje flotę
w sytuacji podstawowej — jeden atak, jedna para, flota na jednym ciele — i ta ścieżka jest
przetestowana bojowo. Załamuje się natomiast wszędzie tam, gdzie sytuacja jest choć trochę
bardziej złożona: **atak na oba ciała pary, dwa ataki naraz, atak w trakcie innego lotu,
atak podczas Fleet Save**. We wszystkich tych układach bot nie tylko nie ratuje — on
**milczy**, bo alarmy siedzą w gałęziach `else if`, które nigdy się nie wykonują. To jest
najgorszy możliwy tryb awarii tego programu: operator widzi „bot pracuje", a flota ginie.

**Ekspedycje mają jeden defekt terminalny**, wprowadzony 04.09 w v3.68.2 (moja poprawka):
gdy flota trafi na planetę bazy, ekspedycje stają **na stałe**, bez alarmu i bez drogi
wyjścia, bo nic w bocie nie przenosi floty planeta→księżyc przy domyślnym `homeToMoon:false`.

**Największe ryzyko TERAZ**: właściciel jest pod ostrzałem i ma włączony auto-ratunek.
Trzy z ośmiu P0 (`obrona-decide#1`, `obrona-stan-lotu#1`, `obrona-fs#1`) kończą się cichą
utratą floty w scenariuszach, które na tym koncie już wystąpiły (atak na oba ciała — 26.08;
złom na własnej pozycji — moduł włączony domyślnie).

Liczby: **37 znalezisk** — 8× P0, 16× P1, 12× P2, 1× P3.

---

## METODA I JEJ GRANICE

Audyt prowadziło 8 niezależnych agentów, każdy na innym obszarze, z wspólnym „kontraktem"
zbudowanym wcześniej z CLAUDE.md, START-3.0.md i 14 plików AUDYT-*. Audytorzy nie czytali
samych komentarzy — wycinali `decide()` przez `bodyOf()` (jak `test3-decide.js`) i
**uruchamiali ją na własnych danych**, więc scenariusze awarii są odtworzone, nie wydedukowane.

Następnie każde znalezisko P0/P1 szło na **weryfikację adwersarialną**: niezależni agenci
z rozdzielnymi obiektywami (czy zarzut wynika z kodu / czy jest osiągalny przy realnym
configu / czy nie jest już gdzie indziej obsłużony) mieli go **obalić**, i obalić mogli
tylko wskazując linię kodu, która go unieważnia.

**Wynik weryfikacji: ani jeden zarzut nie został obalony.** 13 znalezisk przeszło pełną
weryfikację (P0 po trzech głosach, P1 po dwóch) — wszystkie się obroniły, a kilku
weryfikatorów odtworzyło scenariusz własnym, niezależnym skryptem. Dwa znaleziska zmieniły
wagę: `obrona-decide#4` podniesiono do P0, `obrona-wykrywanie#1` obniżono do P1.

**Czego audyt NIE ma** (przerwany limitem konta o ~01:00):
- **11 znalezisk P1 nie przeszło weryfikacji** — są oznaczone niżej jako NIEZWERYFIKOWANE.
  Pochodzą od tych samych audytorów, mają dowody z kodu, ale nikt nie próbował ich obalić.
- **Nie ma krytyka kompletności** (co audyt pominął) ani **sędziego architektury**.
  Sekcję „wzorzec konstrukcyjny" napisałem sam z materiału znalezisk — nie jest to
  niezależna ocena.
- P2/P3 nie były weryfikowane w ogóle (świadomy limit zakresu, nie awaria).
- Nic nie było sprawdzone na żywej grze — wyłącznie kod, testy i jsdom.

---

## P0 — do naprawy przed czymkolwiek innym

| # | obszar | miejsce | zarzut w jednym zdaniu |
|---|---|---|---|
| 1 | obrona | `ogamex-3.user.js:1405` | Atak na oba ciała pary: drugie ciało nie jest ratowane nigdy, a bot obiecuje „następny przebieg" i potem milczy |
| 2 | obrona | `:3472` | Rutynowy lot „powrót po ratunku"/„dom = księżyc" wyprzedza RATUNEK w kolejce akcji |
| 3 | obrona | `:2685` | Bramka anty-duplikat zjada ratunek po wysyłce złomu i zeruje hangar ratowanego ciała |
| 4 | stan | `:980` | Wpis lotu domyka się w chwili zawrotu — Fleet Save z wykluczeniami traci zawrót bez śladu |
| 5 | obrona | `:773` | `s.bar.at` stempluje czas parsowania, nie wiek strony — ślepy alarm stoi na snapshocie do 10 min |
| 6 | obrona | `:1355` | Lot Fleet Save zajmuje jedyny slot lotu pary — atak w tę parę nie daje ani ratunku, ani alertu |
| 7 | ekspedycje | `:1936` | v3.68.2: flota na planecie bazy = ekspedycje stają na stałe, bez naprawy i bez alarmu |
| 8 | obrona | `:3473` | Dwa ataki naraz: o kolejności ratunku decyduje pozycja na pasku planet, nie czas do uderzenia |

### P0-1. Atak na OBA ciała pary — drugie ciało nie jest ratowane nigdy (`:1405`)

Gdy flota stoi na obu ciałach pary i oba są atakowane, `decide()` wysyła ratunek **tylko
z większego hangaru** i pisze operatorowi „ratuję najpierw moon, drugie ciało w następnym
przebiegu". Następny przebieg nie może już nic zrobić: wpis lotu jest jeden **na parę**
(`inFlightFrom` dopasowuje po `fromKey`, bez `fromBody`), więc pętla łapie własny lot
i robi `continue` (`:1374`). Alertu też nie ma, bo gałąź `if (f.kind==="air" &&
f.phase==="launched")` (`:1356`) konsumuje łańcuch `else if` i ostrzeżenia z `:1363`/`:1364`
nie powstają.

**Scenariusz** (odtworzony, trzy niezależne przebiegi): para z 1 mld statków na księżycu
i 400 mln na planecie, dwie fale z dolotem 300 s — schemat z incydentu 26.08. Przebieg 1:
ratunek księżyca + `warn`. Przebieg 2 i każdy następny aż do uderzenia: **zero akcji, zero
alertów**. 400 mln statków ginie. Weryfikator wykazał dodatkowo, że nie trzeba nawet dwóch
fal — wystarczy jeden atak z nierozpoznanym `dstBody`, bo `:1082` wpisuje wtedy `"unknown"`,
a `:1377` zalicza oba ciała.

**Poprawka.** (1) Natychmiast zdjąć ciszę: przed `continue` w `:1374`, **poza** łańcuchem
`else if`, policzyć stojącą flotę na atakowanych ciałach i wypchnąć alert
`{level:"error", push:true, throttleMs:60e3}` mówiący wprost, że drugiego lotu nie będzie.
(2) Poprawić kłamstwo z `:1405` na uczciwy komunikat i **rozszerzyć dyspozytor pusha**
`:3429` na `(a.unknownPair || a.blind || a.push)` — inaczej żaden z tych alarmów nie trafi
na telefon. (3) Naprawa właściwa: kluczować loty **per CIAŁO**, nie per parę — `:2993` na
`filter(f => !(f.fromKey === m.fromKey && f.fromBody === m.fromBody))`, a `inFlightFrom`
rozbić na `inFlightFromBody(k, body)`.

### P0-2. Lot rutynowy wyprzedza ratunek (`:3472`)

`prio()` spycha na koniec kolejki **wyłącznie** akcje z flagą `fs`. Lot „powrót po ratunku"
/ „dom = księżyc" (`:1220-1221`) ma `kind:"fly"` bez `fs` i bez `rescue`, więc dostaje ten
sam rank 0 co ratunek — a `sort` jest stabilny, czyli decyduje kolejność kolonii na pasku
planet. Pętla robi `break` po pierwszym `fly`, a w kolejnych przebiegach
`if (Fly.mission()) return` (`:3461`) blokuje całą listę akcji do końca misji.
**To jest ten sam P0, który v3.68.1 naprawiła dla Fleet Save — tylko dla lotu domowego.**
Działa przy domyślnej konfiguracji, bo `backFromRescue` nie pyta o `homeToMoon`.

**Poprawka.** Odwrócić warunek z listy wyjątków na listę uprawnionych:
`const prio = (a) => (a.kind === "fly" && !a.rescue && !a.blind ? 0.5 : 0)`.
Sam sort nie wystarczy — gdy ratunek odpadnie na `Fly.blocked()`, pętla zejdzie niżej
i mimo wszystko wypali lot rutynowy. Dlatego w gałęzi `if (a.kind === "fly")` (`:3529`),
**przed** `Fly.blocked`, dodać twardy strażnik: `if (hasRescue && !a.rescue && !a.blind) continue`.

### P0-3. Bramka anty-duplikat zjada ratunek po wysyłce złomu (`:2685`)

Bramka porównuje tylko `toKey`, `from` i czas — **nie porównuje rodzaju misji ani ciała**.
Pole złomu leży na własnej pozycji bazy, więc wysyłka złomu stempluje
`last_send{from:K, toKey:K}`, a lot ratunkowy „drugie ciało pary" (`:1424`) ma dokładnie
`fromKey === toKey === K`. Bramka uznaje ratunek za duplikat, kasuje misję **i woła
`emptySourceHangar` na ciele pod atakiem** (`:2701`) — czyli fałszuje stan na „tu nic nie ma".

**Scenariusz.** Baza z księżycem i planetą, kolonie w innych układach (brak
`neighbourMoon`), więc ratunek zawsze idzie ścieżką „drugie ciało pary". T+0: recyklery na
złom. T+60 s: atak na planetę, gdzie stoi 340 000 statków z powrotu ekspedycji. Bramka
kasuje ratunek, zeruje hangar planety ze świeżym stemplem — następny przebieg widzi
„flota na moon, bezpieczna strona" → HOLD, zero alertów. Fałszywy odczyt jest świeży, więc
nie ma nawet rekonesansu. **340 000 statków ginie w ciszy.**

**Poprawka.** Dopisać do stempla `last_send` ciała i `startedAt` misji, a warunek bramki
zaostrzyć o `ls.kind === m.kind`, oba ciała oraz `(ls.at||0) >= (m.startedAt||0)` — sam ten
ostatni składnik zabija fałszywy alarm, bo stempel złomu jest starszy niż start misji
ratunkowej, a przy prawdziwym duplikacie po przeładowaniu warunek nadal zachodzi.
Dodatkowo `emptySourceHangar` wolno wołać wyłącznie dla lotu tego samego rodzaju.

### P0-4. Wpis lotu domyka się w chwili zawrotu (`:980`)

Ochrona przed przedwczesnym domknięciem wpisu (fix v3.53.1, po utracie zawrotu 11 mln
statków) działa tylko **przed** terminem zawrotu i tylko w fazie `launched`:
`f.recallAt && f.phase === "launched" && h.at < f.recallAt`. Od v3.68.1 hangar źródła po
Fleet Save **nigdy nie jest pusty** (wykluczenia zostawiają recyklery, `debris.enabled`
domyślnie `true`), więc każdy odczyt bazy po `recallAt` albo po kliknięciu zawrotu kasuje
wpis lotu, który fizycznie wciąż leci.

**Skutek.** Zawrót nie zostanie wystawiony nigdy, alert z `:1432` też nie zadziała (pętla
iteruje po `s.flights`), flota ląduje na obcym księżycu — dokładnie ten P0, który v3.68.1
miała naprawić. Wariant z fazą `recall_clicked` jest jeszcze pewniejszy: mechanizm „zawrót
bez potwierdzenia — ponawiam po 2 min" nie ma czego ponawiać.

**Poprawka.** Oderwać ochronę od zegara i oprzeć ją na fazie:
`const rescueStillOut = f.recallAt && ["launched","recall_clicked"].includes(f.phase)`.
Domykanie hangarem zostaje dla fazy `recalled` i twardego sufitu 12 h; zwolnienie pary spod
blokady obrony i tak załatwia `flightStale()`. Drugi strażnik: zapisywać przy wysyłce, ile
statków **celowo** zostało w domu (`f.leftHome`) i wymagać `h.total > (f.leftHome || 0)`.

### P0-5. `s.bar.at` stempluje czas parsowania, nie wiek strony (`:773`)

`Bar.read()` czyta `document.body.textContent` **bieżącej** strony, a `:773` stempluje
wynik `at: now`. Licznik misji jest jednak wyrenderowany przez serwer przy załadowaniu
strony i — w odróżnieniu od odliczań w wierszach — nie ma tykającego bliźniaka. Wszystkie
trzy bramki świeżości paska (3 min, 90 s, 5 min) mierzą więc coś, co zawsze wynosi zero.

**Scenariusz.** Cicha noc, bot siedzi na `/home` załadowanym o 02:14 (keepalive przeładowuje
dopiero po 10 min bez nawigacji). O 02:16 napastnik startuje atak z **własnego układu**,
którego fork gubi na liście ruchów — czyli dokładnie ta klasa ataku, dla której zbudowano
ślepy alarm. Pasek ze strony z 02:14 pokazuje 0 Hostile, `excess = 0`, **ślepy alarm nie
istnieje do 02:24**. Na Genesis (×3) atak wewnątrzukładowy dolatuje w kilka minut.
Drugi skutek tego samego stempla: gałąź `:833-845` uznaje snapshot sprzed ataku za „pasek
czysty od ≥60 s" i kasuje z `s.threats` zagrożenia niepotwierdzone w ostatnich 30 s.

**Poprawka.** Wprowadzić stałą per-wykonanie `const PAGE_AT = Date.now()` (nie `Store`, bo
to GM storage współdzielone między kartami) i stemplować `at: PAGE_AT`. Ponieważ po tej
zmianie pasek starzeje się szybciej, niż keepalive przeładowuje, dodać w `defenceTick`
odświeżenie `/home` przy `Date.now() - s.bar.at > CFG.barMaxAgeMs` z własnym dławikiem —
albo taniej: przepuścić HTML z `Rows.fetchList` przez `Bar.parse` i użyć go jako paska.

### P0-6. Fleet Save zajmuje jedyny slot lotu pary (`:1355`)

Gałąź ataku robi `const f = inFlightFrom(k); if (f) { ... continue; }`. Dla lotu FS
(`kind:"air"`, `phase:"launched"`) pierwsza gałąź wykonuje tylko warunkowy `extend`
i **nie dopisuje żadnego alertu** — łatka „milczeć nie wolno" z v3.29.0 wstawiła alert
wyłącznie w `else if`/`else`. Jednocześnie FS celowo **zostawia statki w domu**
(wykluczenia), więc przesłanka „flota w powietrzu, nie ma czego ratować" jest przy FS
z definicji fałszywa.

**Scenariusz.** FS startuje o 04:00, na księżycu zostają recyklery, na planecie tej samej
pary 800 mln statków z powrotów ekspedycji. O 07:00 wróg uderza w planetę za 300 s.
`decide()` zwraca **pustą listę akcji i pustą listę alertów**. Ten sam stan bez lotu FS
daje normalny ratunek. Do 3.67 kolizja istniała tylko w oknie nocnym — od 3.68 lot FS jest
stanem normalnym przez większość doby.

**Poprawka.** Przenieść wyliczenie `hitBodies` przed `:1355` i dodać wyjątek: gdy
`f.fs && f.phase === "launched" && hitBodies.length`, nie robić `continue`, tylko
przepuścić parę do normalnej ścieżki ratunku — FS jest lotem **dobrowolnym**, a obrona ma
bezwzględny priorytet. Żeby drugi wpis nie zaślepił zawrotu FS, `inFlightFrom` ma
preferować wpis nie-FS.

### P0-7. v3.68.2: flota na planecie bazy zatrzymuje ekspedycje na stałe (`:1936`)

**To jest regresja wprowadzona 04.09 przy naprawie zgłoszenia właściciela.** `expoHomeBody`
zwraca teraz `"moon"` bezwarunkowo, gdy para ma księżyc, a plan nie ma **żadnego wyjścia
awaryjnego** dla stanu „księżyc pusty, flota stoi na planecie tej samej pary". Powstaje stan
terminalny: `expoPlan` na zmianę odpowiada „brak statków do wysłania" i „hangar moon
nieznany/stary", a nic w bocie nie przenosi floty planeta→księżyc (`homeToMoon` domyślnie
`false`; jednorazowy zwóz `Moon` działa tylko tuż po postawieniu księżyca).

Flota trafia na planetę bazy trzema realnymi drogami: (a) atak na księżyc bez sąsiedniego
księżyca w układzie — bot **sam** ewakuuje moon→planet, (b) statki zbudowane w stoczni
planety (u właściciela 04.09 stały tam 4 minery), (c) księżyc zniszczony i fale wróciły na
gołą planetę. Od tej chwili bot co ~15 min pisze w logu „brak statków do wysłania" na
poziomie `info` — **zero wpisu w dzienniku, zero pusha**. Priorytet nr 2 właściciela stoi
bezterminowo.

**Poprawka.** Nie cofać `:1936` (naprawia realny incydent), tylko **dodać brakujące
wyjście**: jednorazowy zwóz planeta→księżyc wąsko dla pary startowej ekspedycji, gdy odczyt
księżyca jest świeży i nie ma tam nic poza wykluczeniami, a na planecie jest flota. To nie
łamie reguły właściciela „flota rusza się tylko przy ataku", bo jest ograniczone do jednej
pary i odpalane raz. Do tego alarm z pushem, gdy stan trwa dłużej niż np. 30 min.

### P0-8. Dwa ataki naraz: kolejność z paska planet, nie z czasu do uderzenia (`:3473`)

Sortowanie akcji zna tylko **rodzaj** akcji i flagę `fs`. Dwa ratunki mają identyczny klucz,
więc stabilny `sort` zachowuje kolejność wystawienia, a ta wynika z kolejności kolonii na
pasku planet. Ani ETA uderzenia, ani wielkość ratowanego hangaru nie wchodzą do decyzji,
a `break` po pierwszym `fly` oddaje jedyny slot misji na cały przebieg.

**Scenariusz.** Skoordynowany nalot: kolonia A (pusty księżyc, 1000 statków) — dolot 600 s;
kolonia B (1,5 bln statków) — dolot 80 s. A jest wcześniej na pasku, więc bot ratuje A,
a B czeka na koniec misji i wpada w `secs < tooLateSec`, dostając tylko „ZA PÓŹNO na
formularz". **Ratowana jest kolonia, której nic nie groziło.**

**Poprawka.** Doklejać do akcji `etaMs` i `saveTotal`, a sort rozbudować o trzy stopnie:
rodzaj → pilność (najkrótszy dolot) → wielkość hangaru; plus głośny alarm o parach
odłożonych przed `break`.

---

## P1 zweryfikowane (obroniły się przed weryfikatorami)

- **`:519` Awaria listy ruchów flot jest całkowicie cicha.** `Rows.fetchList` przy HTTP≠200
  i w `catch` zwraca `{ok:false, rows:[]}` bez linii logu; `Situation.refresh` nigdy nie
  czyta `ok`, więc „nie udało się odczytać" jest nieodróżnialne od „nie ma lotów". Nie ma
  stempla ostatniego udanego odczytu, więc `defenceReadiness` też tego nie widzi. Główny
  detektor ataku może być martwy godzinami. *(zejście z P0 na P1 — bo pasek misji jest
  niezależną drugą drogą wykrycia)*
- **`:3452` Rozpoczęta misja FS / lotu domowego nie jest przerywana przy ataku.**
  Wywłaszczenie działa tylko dla `ECO`, a misje `kind:"fly"`/`"home"` do niej nie należą —
  `if (Fly.mission()) return` blokuje wtedy `fly`, `recall` i `extend`.
- **`:2993` Nowy lot z pary kasuje wpis lotu wciąż lecącego z drugiego ciała tej pary.**
- **`:1055` Jedno „Type: Spy" na pasku ucisza ślepy alarm na 5 minut** — pole `Type:` opisuje
  jedną misję (najbliższy dolot), a nie rodzaj całej nadwyżki, więc sondy uciszają reakcję
  na lecący za nimi atak. To standardowy schemat napastnika.
- **`:660` Nieudane przywrócenie planety w `scanRemote` jest połykane** — sesja zostaje
  zaparkowana na obcej kolonii, a lista ruchów raportuje wtedy złą parę.

## P1 NIEZWERYFIKOWANE (limit konta przerwał weryfikację)

Mają dowody z kodu od audytorów, ale nikt nie próbował ich obalić — traktować jako mocne
poszlaki, nie jako fakty.

- `:3460` Wypełnianie formularza ekonomii zamraża całą pętlę obrony na 30–80 s.
- `:3450` Misja Fleet Save nie jest przerywana przy alarmie (druga strona P1 `:3452`).
- `:1267` FS wysyła osobny lot z **każdego** księżyca z flotą — bez `launchFrom` i bez rezerwy slotów.
- `:763` Duch księżyca: po zniszczeniu księżyca wpis hangaru żyje 48 h i udaje miejsce postoju floty.
- `:2902` Pętla „lot za krótki": FS ponawia 3 nieudane misje/h, z godzinnym pushem BŁĄD i zielonym paskiem stanu.
- `:2057` Po v3.68.2 nikt już nie czyta hangaru **planety** bazy przy `recon:false` (domyślne) — przez co gałąź „powrót po ratunku" jest głodzona.
- `:980` Lądująca fala ekspedycji cicho kasuje wpis ratunku po terminie zawrotu.
- `:2579` Fleet Save stempluje `s.rescues` — bot zwozi flotę mimo „tylko przy ataku" i gasi ratunek pary na 30 min.
- `:3472` `prio()` spycha FS za `fly`, ale nie za `recall` — FS wywłaszcza **zawrót** ucieczki.
- `:490` Reguła „nieznany typ misji = ATAK" nie ma ani jednej asercji — mutacja przechodzi 696/696.
- `:621` Push ślepego alarmu pilnuje tylko regex — da się go wyłączyć i bateria zostaje zielona.

## P2 / P3 (nieweryfikowane, świadomy limit zakresu)

`:1356` `extend` wskrzesza zawrót lotu, który ma wylądować · `:3810` `Impact.alarms()` bez
bramki wieku krzyczy „RECKI TERAZ" o dawno spadłych falach · `:3472` FS wyprzedza `recall`
i `extend` · `:2596` loty „rescue" bez ataku nie mają sufitu prób · `:3055` `Fly.recall`
przełącza ciało poza `Nav.click`, bez licznika · `:1523` FS gasi całą ekonomię, w tym
odbudowę księżyca i pracę recyklerów, które sam zostawił „bo pracują" · `:565` v3.68.2
poszła bez scenariusza E2E · `:1890` `ExpoLink` zapisuje link bez id misji i już się nie
douczy · `:1936` flota na planecie trwale zatrzymuje ekspedycje (duplikat P0-7) · `:2125`
licznik serii fal bez terminu ważności — po przerwie cały hangar w jednej fali · `:2685`
bramka anty-duplikat bez rodzaju lotu blokuje recyklery · `:3008` zapasowe potwierdzenie
wysyłki martwe dla fal cząstkowych · `:35` reguła „ratunek w powietrzu ⇒ ekonomia stoi" bez
wykonującej asercji.

---

## WZORZEC KONSTRUKCYJNY — to nie są przypadkowe błędy

*(synteza własna; niezależny sędzia architektury nie zdążył się wypowiedzieć)*

Osiem P0 i większość P1 sprowadza się do **trzech wad konstrukcyjnych**, nie do ośmiu
osobnych pomyłek:

**1. Jednostką obrony jest PARA, a powinno być CIAŁO.** `inFlightFrom` szuka po `fromKey`,
`Fly.form` kasuje wpisy po `fromKey`, „jedna ucieczka na parę" jest regułą twardą.
Tymczasem atak celuje w **ciało**, i flota stoi na **ciele**. Stąd P0-1 (drugie ciało nigdy
nie ratowane), P0-6 (FS zajmuje slot pary), P1 `:2993` (nowy lot kasuje cudzy wpis).
Naprawa: klucz `fromKey|fromBody` wszędzie tam, gdzie dziś jest sam `fromKey`.

**2. Jeden lot na przebieg + `break` + brak pojęcia pilności.** Pętla akcji oddaje jedyny
slot pierwszej akcji `fly`, a o kolejności decyduje pasek planet. Stąd P0-2, P0-8 i P1
`:3452`. Naprawa: pilność (`etaMs`) jako składnik sortowania, twarde pierwszeństwo
`rescue`/`blind` nad wszystkim, oraz wywłaszczanie **każdej** misji dobrowolnej — nie tylko
ekonomicznej — gdy gdziekolwiek trwa alarm.

**3. Świeżość odczytu jest mylona z prawdą o stanie.** `s.bar.at` stempluje moment
parsowania zamiast wieku strony (P0-5); wpis lotu domyka się „bo hangar nie jest pusty",
choć od v3.68.1 nigdy pusty nie bywa (P0-4); ekspedycje wybierały ciało startowe po
świeżości odczytu zamiast po tym, gdzie stoi flota (naprawione w v3.68.2 — i ta naprawa
wprowadziła P0-7). **To dokładnie ta sama pomyłka pojęciowa w czterech miejscach.**

Dwie obserwacje dodatkowe, ważniejsze niż pojedyncze błędy:

- **Alarmy siedzą w gałęziach `else if`, które przy trwającym locie nigdy się nie wykonują.**
  Reguła projektu brzmi „milczeć nie wolno", a w praktyce w trzech P0 bot milczy dokładnie
  wtedy, gdy sytuacja jest najgorsza. Każdy alarm krytyczny powinien powstawać **poza**
  łańcuchem warunków, przed `continue`.
- **Push na telefon dostają tylko `unknownPair` i `blind`** (`:3429`). Wszystkie nowe alarmy
  krytyczne z tego audytu byłyby niewidoczne, dopóki dyspozytor nie dostanie flagi `push`.

---

## CO ROBIĆ W NASTĘPNEJ KOLEJNOŚCI

Kolejność wg stosunku wartości do ryzyka. Pozycje 1–3 są tanie i zdejmują ciszę, czyli
najgorszy tryb awarii; dopiero potem zmiany strukturalne.

1. **Zdjąć ciszę + push na alarmy krytyczne** (P0-1 cz. 1–2, P0-6 cz. 3). Alerty poza
   łańcuchem `else if`, flaga `push`, rozszerzenie dyspozytora `:3429`. ~1 h. Nie zmienia
   żadnej decyzji o locie, więc ryzyko regresji minimalne, a operator przestaje być ślepy.
2. **Twarde pierwszeństwo ratunku w kolejce** (P0-2). Odwrócenie `prio()` + strażnik przed
   `Fly.blocked`. ~1 h, mały diff, natychmiastowy zysk.
3. **Bramka anty-duplikat: rodzaj i ciało w stemplu** (P0-3). ~1 h. Zdejmuje scenariusz
   cichej utraty floty przy włączonym złomie, który jest **domyślnie włączony**.
4. **Wyjście awaryjne dla ekspedycji** (P0-7) — moja dzisiejsza regresja. Jednorazowy zwóz
   planeta→księżyc dla pary startowej + alarm. ~2 h. Odblokowuje priorytet nr 2.
5. **Ochrona wpisu lotu oparta na FAZIE, nie na zegarze** (P0-4) + `leftHome`. ~2 h.
   Wymaga nowego scenariusza E2E, bo to dokładnie klasa błędu z incydentu 11 mln statków.
6. **`PAGE_AT` zamiast `at: now` dla paska** (P0-5) + odświeżanie paska przy przeterminowaniu.
   ~2 h; uwaga: zmienia częstotliwość nawigacji, więc wymaga sprawdzenia limitów.
7. **Klucz `fromKey|fromBody` w miejsce `fromKey`** (P0-1 cz. 3, P0-6, P1 `:2993`). ~4–6 h,
   to jest zmiana strukturalna — osobny commit, własna bateria scenariuszy, nie mieszać
   z powyższymi.
8. **Pilność w sortowaniu akcji** (P0-8) + alarm o parach odłożonych. ~2 h.

Dodatkowo, poza kolejnością: **zamknąć dziury w dowodach** — `Rows.classify` nie ma ani
jednej asercji, mimo że to warstwa, której CLAUDE.md zabrania ruszać bez dowodu z żywej gry,
a push ślepego alarmu pilnuje wyłącznie regex. Obie luki przepuszczają mutację przy zielonej
baterii.

---

## JAK PRZEPROWADZONO AUDYT

Trzy fazy, agenci pracujący równolegle. **Kontrakt**: 2 agentów zbudowało listę
obowiązujących reguł (CLAUDE.md, START-3.0.md, 14 plików AUDYT-*) i mapę modułów z główną
pętlą. **Audyt**: 8 agentów, każdy na osobnym obszarze (4× obrona, 2× ekspedycje, 1× Fleet
Save i utrata księżyca, 1× testy i architektura), z zakazem modyfikowania repo i nakazem
uruchamiania kodu zamiast czytania komentarzy. **Weryfikacja**: niezależni adwersarze
z rozdzielnymi obiektywami próbowali obalić każde P0/P1, mogąc to zrobić wyłącznie
wskazaniem linii kodu.

Zużycie: ok. 6,1 mln tokenów agentów, 1 500 wywołań narzędzi, ~91 minut. Dwa przebiegi
zostały przerwane limitem konta — pierwszy stracił całą fazę audytu (odtworzony), drugi
uciął weryfikację 11 znalezisk P1 oraz obu sędziów.

**Granice tego audytu**: żaden wniosek nie był sprawdzony na żywej grze; nie badano wyścigów
między kartami, zachowania po utracie sesji, przy skoku zegara ani przy błędach sieci
(krytyk kompletności nie zdążył wystartować); P2/P3 nie były weryfikowane.
