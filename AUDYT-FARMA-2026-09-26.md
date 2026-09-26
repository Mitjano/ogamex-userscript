# AUDYT: port farmy nieaktywnych (2.x → 3.x), 26.09.2026

Zlecenie ownera: przed eventem „farming inactive players” przenieść do 3.x system farmienia
z 2.x (Athena), w którym wybierało się statek, OW (BATTLESHIP) albo DT (HEAVY_CARGO).
Ten dokument to audyt i plan; **wdrożenie: v3.115.0, sekcja 8.**

## 1. Werdykt

- W 3.x farmy **nie ma wcale** (0 wystąpień „farm” w `ogamex-3.user.js`). Trzeba ją dopisać jako
  nowy moduł ekonomii, na wzór `Aster` i `Debris`.
- Logika z 2.x jest **sprawdzona bojowo** na Athenie (13–17.08, ok. 4,5 bln/dobę, czarna lista
  po 10 rozbitych atakach, dziennik łupów potwierdzony na żywo). Da się ją przenieść prawie 1:1:
  parser galaktyki, baza celów, filtr rankingu, czarna lista, priorytet łupu.
- Nie da się przenieść 1:1 **warstwy wykonawczej**: 2.x miało własny `pending_mission`, a w 3.x
  wszystkie loty idą przez jednego wykonawcę `Fly` i `Situation`. Tu siedzi całe ryzyko.
- Szacunek: **3 etapy, ok. 1 dzień pracy z testami**, plus jedna sesja weryfikacji na żywo
  przed puszczeniem farmy samopas. Pięć rzeczy musi zostać naprawionych RAZEM z portem (sekcja 4),
  bo inaczej farma osłabia obronę.

## 2. Co robi farma 2.x (inwentarz, `ogamex-bot.user.js` ~3880–4730)

| element 2.x | co robi | port do 3.x |
|---|---|---|
| `collectTargets` | czyta wiersze `.galaxy-item`, poz. 1–15, status `(i)`/`(I)`, pomija `(v)(p)(b)`, ranking z dymka gracza | 1:1, markup galaktyki ten sam (`Debris.findLink` i `Aster` czytają te same klasy na Genesis) |
| `FarmTargetDB` | baza wszystkich nieaktywnych z zakresów, nadpisywana per układ, TTL 7 dni | 1:1 do jednego klucza `Store` (nie 6 rozproszonych kluczy GM) |
| filtr rankingu `maxTargetRank` | atakuje tylko nieaktywnych z rankingiem ≤ N, nieznany ranking = atakuj + zrzut | 1:1 |
| okrążenia po bazie + pełny skan co `dbRefreshHours` | między pełnymi skanami odwiedza tylko układy ze znanymi celami | 1:1, a w 3.x **dużo szybciej** (patrz 3.3) |
| `FarmBlacklist` + `CombatWatch` | straty własne > 0 w raporcie bojowym = ban celu na 14 dni | 1:1 + poprawka endpointu (4.6) |
| `FarmYieldDB` + `PlunderWatch` | EMA łupu z Dziennika Grabieży (`/home/Partial_PlunderJournal`, potwierdzony 15.08), najtłustsze cele pierwsze, próg `minTargetProfit` | 1:1 |
| `sequentialSweep` | przełącznik „po kolei 1→koniec” zamiast priorytetu łupu | 1:1 |
| `repeatEachSweep`, `targetCooldownMin` | nowe okrążenie zwalnia wszystkie cele | 1:1 |
| **wybór statku** `shipType` | LIGHT_CARGO / HEAVY_CARGO / BATTLESHIP, `hcPerFlight` sztuk na atak | 1:1 (to jest „OW albo DT”) |
| `launchFrom` („Start farmienia g:s:p”) | atak z wpisanej pary, nie z aktywnego ciała | 1:1, w 3.x z regułą „para ma księżyc → start z księżyca” |
| `slotReserve` | ile slotów floty zostaje wolnych | 1:1, ale z nowym minimum (4.1) |
| krok 3: klik kafla **ATTACK** | jawny klik misji Attack (bez ACS/Missile/Destroy), bez trafienia NIE wysyła | musi dojść do `Fly` (4.4) |
| brak statku na ciele → pauza 10 min | żeby nie spalić kolejki celów | 1:1 |
| `farmYieldsToMining` | mining ma pierwszeństwo, farma w jego martwych oknach | zastąpione kolejnością łańcucha ekonomii (3.1) |
| `maxAttacksPerDay`, wander przez Overview, powrót na galaktykę między atakami | humanizacja | częściowo (3.3) |

## 3. Jak to wpiąć w architekturę 3.x

### 3.1 Miejsce w pętli
Łańcuch ekonomii (`ogamex-3.user.js:6167`): `Recon → Bonus → Expo → Aster → Debris`.
Nowy moduł `Farm.tick(s)` wchodzi **po `Aster`, przed `Debris`** (zachowuje decyzję z 2.x v2.90.0:
mining zarabia więcej i ma pierwszeństwo). Obrona niczego nie pyta, jak dotąd: farma stoi za tą
samą bramką `ekoWolne` i `Human.economyAllowed(s, "farm")`, a przy jakimkolwiek zagrożeniu
`attack` nic nie wysyła.

### 3.2 Lot
`Fly.start({ kind: "farm", missionType: "ATTACK", plan: [{ type: CFG.farm.shipType, qty }],
toBody: "planet", takeResources: false, speed: 100, fromKey, fromBody, toKey })`.
Ładownie muszą być puste (`takeResources: false`), bo łup wraca w tych samych ładowniach.
Wysłany atak idzie do rejestru powrotów `s.expected` z `kind: "farm"` (4.2), a nie do
`s.flights` (to stan obrony, reguła z v3.2.0).

### 3.3 Skan bez przeładowań
2.x skanowało nawigacją (pełny zakres ~500 układów ≈ 2 h). 3.x ma już skan w tle przez
`/galaxy/galaxydata?x=&y=` (`Aster.scanQuiet`, v3.110.1) — to ta sama odpowiedź, którą gra ładuje
przy strzałce układu. Farma może czytać kilka układów na przebieg bez przeładowania strony
i bez zjadania sufitu nawigacji. **Niepotwierdzone:** czy fragment `galaxydata` niesie statusy
`(i)` i ranking w dymku. Etap F1 zaczyna od zrzutu `[FARM DOM]` jednego wiersza; jeśli czegoś
brakuje, zostaje nawigacja jak w 2.x.

Świadoma różnica względem 2.x: tam każdy atak szedł „galaktyka → formularz → galaktyka”, żeby
serwer widział rytm człowieka. Szybki skan w tle jest wydajny, ale to zmiana śladu w logach
serwera — decyzja ownera w sekcji 5.

## 4. Ryzyka, które trzeba zamknąć razem z portem

**4.1 (P0) Farma nie może zająć slotu ratunku.** Każda flota pod uderzeniem dostaje własny
ratunek (reguła po stracie 10.09), a ratunek potrzebuje wolnego slotu floty. Farma przy 20+
atakach w powietrzu wypełni sloty w kilka minut. Wymóg: `farm.slotReserve` domyślnie ≥ 2 i
liczony tak samo jak w `Aster.freeSlots`/FS (`s.slots.fleet`), a przy nieznanych slotach
najwyżej jeden atak w powietrzu (wzór z FS, `:2545`). Test: decide/E2E „sloty pełne farmą,
atak na bazę → ratunek dostaje slot”.

**4.2 (P0) Powracające ataki lądują na bazie.** Flota farmy wraca z łupem na ciało startu,
co kilka minut. Obrona widzi lądowania tylko przez rejestr powrotów (`s.expected`, v3.52.0) —
to on 10.09 pokazał „6 własnych powrotów lądują PRZED uderzeniem”. Farma musi się tam
wpisywać z czasem lotu z formularza (nigdy ze wzoru, CLAUDE.md). Bez tego fala farmy
wylądowałaby niewidzialnie pod atakiem.

**4.3 (P0) Lista „rodzajów ekonomii” jest zaszyta w ~13 miejscach.** `ECO_KIND` (`:102`) to tylko
jedno z nich; reszta to literały `["expedition","asteroid","debris"]`: `:4312`, `:4431` (wyłącznik
w trakcie misji), `:4465`, `:4484` (odprowadzenie operatora), `:4531`, `:4535–4539` (okno
anty-duplikat), `:5150`, `:5156`, `:5215`, `:5266`, `:5875`, `:7180`. Rodzaj `"farm"` pominięty
w którymkolwiek z nich = atak farmy traktowany jak lot OBRONNY: trafia do `s.flights`, dostaje
zawrót, zeruje hangar źródła w stanie obrony, idzie do dziennika jako RATUNEK i budzi push.
Najpierw refaktor: wszystkie miejsca na `ECO_KIND()`, dopiero potem dopisanie `"farm"`.
Test mutacyjny: usunięcie `"farm"` z `ECO_KIND` musi wywrócić E2E.

**4.4 (P0) Wybór misji na kroku 3 spada domyślnie na DEPLOY.** `Fly` (`:5097`) zna EXPEDITION,
ASTEROID, COLLECT, a każdy inny `missionType` dostaje listę `this.MISSIONS` = Deploy/Station.
Atak bez nowej gałęzi wysłałby flotę na „stacjonuj” na planetę nieaktywnego. Trzeba dopisać
`ATTACK` z wykluczeniem ACS/MISSILE/DESTR (wzór 2.x `:13064`); brak kafla = abort + zrzut.

**4.5 (P1) Własne ataki psują rozróżnianie sondy od ataku na pasku.** `Bar.parse` (`:681`)
ustawia `attackType`, gdy pole „Type:” paska mówi Attack, i to ono gasi „spyHold” ślepego
alarmu (`:1705`, `:2627`). Pole „Type:” opisuje najbliższy dolot — przy kilkunastu atakach
farmy w powietrzu to prawie zawsze NASZ atak. Skutek: rój sond w czasie farmienia wygląda jak
atak i uruchamia ewakuację (to znany koszt: fałszywe ewakuacje 26.08 i 09.09). Nie wiemy, czy
fork w „Type:” pokazuje najbliższy lot ogółem, czy najbliższy obcy — **potrzebny zrzut paska
ze zmieszanymi własnymi atakami i obcą sondą**. Do tego czasu: przy własnych atakach w
powietrzu `attackType` bez obcego wiersza ATTACK na liście nie może gasić spyHold.

**4.6 (P1) Czarna lista: w 2.x nie było potwierdzonego endpointu raportów.** Kandydaci
`CombatWatch` to `FLEET_COMBAT`, `COMBAT`, `COMBAT_REPORTS`, a w potwierdzonych endpointach
(STAN-I-PLAN) stoi `MessageCategoryType=FLEET_BATTLE_REPORT` — nie ma go na liście. Na Athenie
bany działały przez odczyt otwartej strony `/messages`. W porcie: `FLEET_BATTLE_REPORT` pierwszy,
reszta zapasowo, zbiór ze strony zostaje. Na Genesis obrona nie daje złomu (defense debris 0%),
więc rozbicie się o obronę to czysta strata — czarna lista jest tu ważniejsza niż na Athenie.

**4.7 (P1) Ekspedycje zabiorą statki farmy.** OW i DT **lecą na ekspedycje** (`expo.excludeTypes`
od v3.100.0 ich nie wyklucza), a fala na ostatni wolny slot bierze cały hangar (v3.105.0,
decyzja ownera). Farma z tego samego księżyca co ekspedycje nie będzie miała czym latać albo
zje udział fal. Rekomendacja: **farma startuje z innego księżyca** (pole „Start farmienia”,
dokładnie tak owner grał 14.08: farma z [4:132:8], minery z [3:272:7]). Wtedy nie trzeba ruszać
`excludeTypes` (własność kodu, `pinCodeOwned`) ani wzoru fal.

**4.8 (P2) Tempo i ślad.** Sufit ekonomii to 240 nawigacji/h, wspólny z ekspedycjami. Jeden
atak to 1–2 nawigacje (formularz; przy skanie nawigacją jeszcze galaktyka). Farma bez własnego
limitu wyssie budżet ekspedycji. Wymóg: własny sufit ataków/h i ataków/dobę (`maxAttacksPerDay`
z 2.x), godziny ciszy i przerwy jak reszta ekonomii.

**4.9 (P2) FS.** Gdy flota jest na Fleet Save, ekonomia stoi (`Human.economyAllowed`). Farma
z osobnego księżyca też stanie. Jeśli owner chce farmić w nocy przy FS, farma musi trafić na
listę `FS_MIMO` — to osobna decyzja.

## 5. Decyzje ownera przed wdrożeniem

1. **Uniwersum eventu:** Genesis, Athena czy oba (cfg i baza celów są per host, więc oba działają niezależnie).
2. **Skąd farma startuje:** osobny księżyc (rekomendacja, 4.7) czy baza ekspedycji z odłożeniem statków farmy.
3. **Statek i ilość domyślna:** OW czy DT i ile sztuk na atak. OW przeżyje resztki obrony, DT ma większą ładownię.
4. **Priorytet:** farma za miningiem jak w 2.x (rekomendacja) czy przed nim na czas eventu.
5. **Skan:** szybki w tle (`galaxydata`) czy „ludzki” rytm galaktyka → atak → galaktyka.
6. **Limity:** ataki na godzinę i na dobę, rezerwa slotów (min. 2).
7. **Farmienie przy FS w nocy:** tak / nie.

## 6. Plan wdrożenia

**F0 — przygotowanie (bez zmiany zachowania).** Refaktor listy rodzajów ekonomii na `ECO_KIND()` we
wszystkich 13 miejscach (4.3), kafel ATTACK w `Fly` (4.4). Testy: pełny `node test3-all.js`
bez zmian w wynikach + nowe asercje na `ECO_KIND`.

**F1 — rozpoznanie na żywo (tryb Obserwator).** Moduł czyta galaktykę i zrzuca `[FARM DOM]`
(wiersz celu, ranking), liczy cele, niczego nie wysyła. Równolegle sonda endpointu raportów
(`FLEET_BATTLE_REPORT`) i dziennika łupów z logiem, który działa. Owner przysyła zrzut paska
z własnymi atakami (4.5).

**F2 — port logiki i lotów.** Baza celów, filtr rankingu, czarna lista, łup, kolejka; `Farm.tick`
w łańcuchu; `s.expected` z `kind:"farm"`; rezerwa slotów; limity; panel (sekcja Farma: ON/OFF,
statek OW/DT/MT, sztuk na atak, zakresy, start farmienia, ranking, próg łupu, rezerwa slotów,
sekwencyjnie, TOP CELE). Testy decide: rezerwa slotów przy ataku, brak farmy przy zagrożeniu,
czarna lista, sortowanie po łupie. E2E (obowiązkowe przy zmianie stanu lotów): atak farmy
wysłany z kafla ATTACK, nie trafia do `s.flights`; farma wypełniła sloty → ratunek dostaje slot;
powrót farmy lądujący przed uderzeniem jest widoczny dla obrony; wyłącznik farmy gasi misję
w trakcie. Każdy nowy test z mutacją (cofnięcie poprawki musi go wywrócić).

**F3 — pierwszy atak nadzorowany na żywo, potem event.** Jeden cel, owner patrzy na log
(`[FARM] misja:`, `[POWRÓT] zapamiętany … (farm)`), potem pełne okrążenie z limitem.

## 7. Czego nie wiemy (sprawdzić na żywo, nie zgadywać)

- czy `/galaxy/galaxydata` niesie statusy `(i)/(I)` i ranking gracza,
- numer i klasa kafla Attack na Genesis (2.x klikało po tekście — tu też),
- który endpoint raportów bojowych odpowiada na Genesis/Athenie,
- co pokazuje pole „Type:” paska przy mieszance własnych ataków i obcej sondy,
- czy dziennik łupów na Genesis ma ten sam format wiersza co na Athenie.

## 8. Wdrożenie v3.115.0 (26.09, decyzje ownera)

Odpowiedzi ownera na sekcję 5: (1) tylko Athena; (2) „start z” ustawiany ręcznie, bo owner
przenosi farmę między galaktykami (2 → 3); (3) jak w 2.x: wybór OW/DT i sztuk na atak;
(4) farma za miningiem; (5) ludzki rytm 2.x; (6) bez limitów — gdy farma ON, bot cały czas
wysyła; (7) farma lata także przy FS.

Co weszło:
- moduł `Farm` (parsery galaktyki, baza celów, okrążenia, filtr rankingu, czarna lista z raportów
  bojowych z `FLEET_BATTLE_REPORT` na pierwszym miejscu, łup z dziennika grabieży, tryb sekwencyjny),
  panel „Ustawienia: Farma”;
- P0 z sekcji 4 zamknięte: rezerwa slotów (min. 1, domyślnie 2, liczona też na żywym formularzu),
  rejestr powrotów z osobnym sufitem dla farmy, `ECO_KIND()` zamiast 13 literałów, kafel ATTACK
  w `Fly` z wykluczeniem ACS/rakiet/niszczenia;
- za mało statków na atak = pauza do najbliższego powrotu floty farmy (cel wraca do kolejki);
- farma nie pyta o przerwy, godziny ciszy, sufit nawigacji ani FS; ustępuje tylko operatorowi,
  który zmienił stronę, i obronie (atak na konto = zero ataków farmy).

Świadomie NIE zrobione: 4.5 (pole „Type:” paska przy własnych atakach) — ten sam efekt dają dziś
fale ekspedycji („Type: Expedition”), więc farma nie pogarsza rozróżniania sond; czeka na zrzut paska.

Testy: E2E 80a–80i (parsery na tekstach z żywej gry, pełny atak, rezerwa slotu dla ratunku pod
atakiem, brak statków, cisza+przerwa, kafel ACS, czarna lista, brak „start z”); mutacje M1–M6
(każda wywraca właściwą asercję); pełny `test3-all` zielony.

NIESPRAWDZONE NA ŻYWO (patrz sekcja 7): wiersz galaktyki Atheny w 3.x (`[FARMA DOM]`, `[FARMA RANK DOM]`),
kafel Attack (`[LOT] misja: „Attack”`), endpoint raportów (`[FARMA BAN] endpoint … potwierdzony`).
Pierwszy atak obserwować w logu.
