# HANDOFF: Fleet Save — v3.68.0 (port z Atheny) + v3.68.1 (audyt przed merge)

**Status: gałąź `fs-atheny-port-v368` przeszła audyt i pełną baterię testów na Macu.**
Sesja Windows (04.09, v3.68.0) → sesja macOS (04.09, v3.68.1). Poniżej: co było, co audyt
znalazł, co naprawione i co ZOSTAJE do decyzji ownera.

---

## CZĘŚĆ I — v3.68.0 (sesja Windows, port mechanizmu)

Owner poprosił o odtworzenie na Genesis mechanizmu Fleet Save z Atheny („bardzo dobrze
działała, chcę dokładnie tak samo”). Ustalenia z tamtej rozmowy, wciąż obowiązujące:

1. Mechanizm FS: **jedna godzina powrotu** (nie okno start–koniec), **start natychmiast**,
   gdy flota stoi bezczynnie na księżycu, o dowolnej porze doby. Trik na „cały czas
   w locie” to **bardzo niska prędkość**, a nie wiele rund.
   *(Owner NAJPIERW odpowiedział w AskUserQuestion, że chce zostawić okno nocne, a POTEM
   sprostował na mechanizm Atheny. Obowiązuje sprostowanie.)*
2. Start **tylko z księżyca**, nigdy z planety (falanga widzi planety).
3. Skonfigurowany cel (`cfg.fs.target`) jest **jedynym** wyborem — brak cichego
   podstawiania innej kolonii.
4. Mechanizm zawracania na Genesis jest JEDEN i generyczny (`kind:"recall"` → `Fly.recall()`)
   — w przeciwieństwie do Atheny, gdzie FS i AirSave miały osobne, kopiowane kopie.
   Tego NIE portowano, bo Genesis ma już lepiej.
5. Zakres wykluczania minerów/recyklerów ustalony przez ownera jako „FS + ucieczka
   w ataku”. **Część dotycząca ucieczki w ataku została w v3.68.1 cofnięta — patrz II.1.**

## CZĘŚĆ II — v3.68.1 (sesja macOS: audyt + naprawy)

Audyt: 4 równoległych audytorów adwersarialnych (`Fly.form`/wykluczenia, reguła FS
w `decide()`, CFG/migracja/panel, jakość samych testów z testem mutacyjnym). Znaleźli
**6 defektów klasy P0** i kilkanaście niższych. Wszystkie poniższe są NAPRAWIONE.

### 1. FS wywłaszczał RATUNEK (P0, potwierdzone uruchomieniem)
`RANK` nie odróżniał lotu FS od ratunku, a pętla robi `break` po pierwszym `fly` —
o wszystkim decydowała kolejność par na pasku. Cicha para z FS potrafiła zabrać jedyny
lot obrony i zostawić atakowaną flotę pod uderzeniem. Do 3.67 kolizja istniała tylko
w oknie nocnym; odkąd FS lata o każdej porze, okno to 24/7.
**Naprawa:** `prio()` spycha akcje FS na koniec kolejki; przycisk „RATUJ FLOTĘ TERAZ”
nigdy nie wybiera lotu FS; FS nie jest już powodem do przerwania ekspedycji.

### 2. Wykluczenia ekonomii w ścieżkach RATUNKU (P0)
`debris.enabled` jest **domyślnie true**, więc każda ucieczka przed atakiem zostawiałaby
wszystkie recyklery (zrzut z żywej gry: 20 983 szt.) pod uderzeniem. To odwraca regułę
z CLAUDE.md „obrona ma bezwzględny priorytet nad ekonomią” i jest regresem względem 3.67.
Dodatkowo logika była odwrócona: statek, który FAKTYCZNIE pracuje, jest w locie i w ogóle
nie ma go w formularzu — wykluczenie po fladze configu trafiało wyłącznie w statki
BEZCZYNNE, czyli dokładnie te, które Athena zabierała.
**Naprawa:** `excludeTypes` zostaje wyłącznie przy Fleet Save. *To jest świadome odstępstwo
od wcześniejszej odpowiedzi ownera („zakres = FS + ucieczka w ataku”) — cofnięcie to jedna
linia, jeśli owner zdecyduje inaczej.*

### 3. FS bez celu wysyłał flotę na PLANETĘ obcej kolonii (P0)
`body: o.hasMoon ? "moon" : "planet"` — przy domyślnym `target:null` to była ścieżka
z pudełka: bot startował z bezpiecznego księżyca i sam odstawiał flotę na widoczną planetę.
**Naprawa:** kolonie bez księżyca odpadają z wyboru; brak kandydata = alarm.

### 4. Zawrót liczony o godzinę za późno — FS był jednorazówką (P0)
`recallAt` dostawał wprost godzinę powrotu. Zawrócona flota wraca dokładnie tyle, ile już
leciała, więc żeby być w domu o T, zawrót musi paść **w połowie drogi** między startem a T.
Stara wersja wpadała w gałąź „doleci przed terminem” → flota lądowała na obcym księżycu,
wpis znikał po 30 min i FS kończył się na stałe (ze stałym celem) albo zamieniał w codzienne
wahadło (bez celu).
**Naprawa:** akcja niesie `homeAt` (godzina bycia w domu), a `Fly` przelicza to na moment
kliknięcia zawrotu, gdy pozna prawdziwy czas lotu z formularza. Lot za krótki, żeby wisieć
do godziny powrotu → **odmowa z instrukcją** („zmniejsz prędkość albo wybierz dalszy cel”),
nie ciche lądowanie.

### 5. Brak dławika — pętla ponawiania bez końca (P0)
Karencja dla lotów `air` to 45 s (pisana dla ratunku pod ostrzałem), a `decide()` jest
deterministyczna: przy braku deuteru albo martwym formularzu bot ponawiał FS w kółko,
do kilkuset przeładowań gry na godzinę.
**Naprawa:** własny sufit `fs_try` — 3 nieudane próby na godzinę na trasę, potem cisza
z jedną linią w logu. Udana wysyłka zwalnia budżet. Ratunek zostaje bez sufitu.

### 6. Migracja mogła cicho nie zadziałać (P0)
Warunek czytał magazyn PO tym, jak migracje debris/moon wywołały `saveCfg()` — a ten
zapisuje cały CFG, w tym świeżo dołożony domyślny `returnHour: 7`. Instalacja skacząca
z ≤3.66 prosto na 3.68 traciłaby ustawioną godzinę bez śladu w logu.
**Naprawa:** rozstrzyga STARY kształt (`endHour` + `startHour`), a stare klucze są usuwane.

### Niższe, też naprawione
- `emptySourceHangar` było **pomijane w całości** przy wykluczeniach → hangar udawał pełną
  flotę przez 48 h („flota-duch”: drugi FS z pustego księżyca, a przy ataku ratunek floty,
  której nie ma). Teraz zeruje ZAWSZE, ale zostawia to, co naprawdę zostało — na wszystkich
  trzech ścieżkach domknięcia wysyłki.
- `Human.economyAllowed()` nie pytało `flightStale()` → wpis po nieudanym zawrocie gasił
  ekonomię do twardego sufitu 12 h.
- Panel pozwalał wpisać prędkość spoza kroku 10, a gra zna tylko wielokrotności 10 —
  „3%” oznaczało lot 100% i LĄDOWANIE, czyli odwrotność sensu FS.
- `fsReturnAt` z NaN dawało Invalid Date → lot bez zawrotu, bez linii w logu.
- Alerty FS bez `throttleMs` spamowały co 60 s; rekonesans przed FS przestawiał
  operatorowi planetę w środku gry (teraz cichy, w tle).

### Testy (było 164+77, jest znacznie więcej — i mierzą realny kod)
- `test3-ui.js` był **CZERWONY**: lista ID wymagała `ogx3-fs-b`, którego panel już nie ma.
- `test3-decide.js` asertował, że FS leci na `5:100:4` — parę **bez księżyca**. Test
  wykonywał więc blocker z punktu 3 i świecił na zielono. Poprawione + `toBody === "moon"`.
- `test3-wargame.js` W22 („obrona wygrywa z FS”) karmił decide polami, których od 3.68 nie
  ma (`startHour`/`night`), więc gałąź FS nie mogła się odpalić — **fałszywie zielony**
  jedyny strażnik tej reguły. Przepisany, plus W22b/W22c.
- Nowe sekcje 50–52 w `test3-decide.js` (ratunek bez wykluczeń, cel zawsze księżyc, dławik,
  arytmetyka `fsReturnAt` **wykonywana**, kolejka akcji **wykonywana**) i 15b/15c w e2e.
- **Testy mutacyjne**: potwierdzone, że nowe asercje PADAJĄ przy cofnięciu poprawek
  (priorytet FS, zawrót w połowie drogi, zerowanie hangaru). Dwie pierwsze wersje asercji
  były puste — zostały wzmocnione dopiero po tym, jak mutacja przez nie przeszła.

### Weryfikacja na macOS
`node test3-all.js` — **zielone**, komplet zestawów (decide, wargame, e2e 190 sprawdzeń,
panel, zegar, składnia). E2E ma realny czas ~2:15 przy ~45 s CPU (czeka na timery) —
to normalne, nie objaw zawieszenia. Uwaga: audyt potwierdził, że **flaki występują też na
macOS** (~1 na 4 przebiegi, sekcja 39/złom), więc teza z v3.68.0, że to problem Windows,
była fałszywa.

---

## CO ZOSTAJE DO DECYZJI OWNERA (nie zgadywać — zapytać)

1. **FS 24/7 wyklucza się z ekonomią.** Skoro flota ma być stale w powietrzu, a ekspedycje
   potrzebują tej samej floty, przy `fs.enabled` + domyślnym `economyAtNight:false`
   ekspedycje/mining/złom praktycznie nie ruszą. To nie jest błąd, to konsekwencja
   mechanizmu — ale owner powinien wybrać świadomie (np. FS tylko w oknie nocnym, albo
   `economyAtNight:true`).
2. **FS jest nadal `enabled: false`** i nie ma migracji włączającej. Handoff v3.68.0
   sugerował, że po pushu FS „poleci z domyślnymi ustawieniami” — **nie poleci**, dopóki
   owner nie kliknie w panelu.
3. **Wykluczenia przy ucieczce w ataku** — cofnięte wbrew wcześniejszej odpowiedzi ownera
   (uzasadnienie w II.2). Do potwierdzenia albo odwrócenia.
4. **Ślepy alarm** (`blind:true`) nadal bez wykluczeń — świadomie, zakres tego nie obejmował.
5. **`returnMinute`** istnieje w CFG i działa, ale panel ma zaszyte `:00` — nie ma jak
   ustawić minut z interfejsu.
6. **Cel wpisany błędnie** (literówka, cudzy księżyc) = FS trwale martwy, a pasek stanu
   nadal świeci na zielono. Walidacja celu względem paska planet nie została dorobiona.

## Przypomnienia z CLAUDE.md
- `ogamex-3.user.js` = Genesis, aktywny rozwój. `ogamex-bot.user.js` = Athena, ZAMROŻONY.
- Push na `main` = auto-deploy na żywego bota. `node test3-all.js` PRZED każdym pushem,
  kod wyjścia sprawdzać **bez pipe’a**.
