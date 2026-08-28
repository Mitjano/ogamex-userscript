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

## 5. Wyniki dwóch niezależnych przeglądów kodu
*(uzupełnione po zakończeniu przeglądów — patrz commity po `6b3db0e`)*

## 6. Ocena planu
Plan („dusiciel": parsery 1:1 z 2.x, stan i decyzje od nowa) **broni się** — wszystkie sześć znalezisk tego audytu to defekty w NOWYM kodzie stanu/decyzji, żaden w przeniesionych parserach. To potwierdza tezę audytu z rana: parsery były sprawdzone bojowo, a gubił się stan.
Zakres na start (obrona + rekonesans + FS nocny + ekspedycje Odkrywcy + mining + złom + humanizer) odpowiada temu, co 2.x realnie robił, minus rzeczy bezprzedmiotowe w nowym uniwersum (brama, odbudowa księżyca, farmienie nieaktywnych).
