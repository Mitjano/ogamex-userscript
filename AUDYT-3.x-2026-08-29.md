# AUDYT 3.x — 29 sierpnia 2026 (wersja badana: v3.21.0, poprawki w v3.22.0)

Zakres: cztery niezależne przeglądy (obrona, ekonomia, testy, konfiguracja/panel) całego
`ogamex-3.user.js` z porównaniem do sprawdzonego bojowo 2.x (`ogamex-bot.user.js`, uni Athena).
Każde znalezisko poniżej zostało **zweryfikowane w kodzie** przed wpisaniem tutaj; tam gdzie
dowód jest z żywej gry, podaję znacznik czasu z logu właściciela.

Legenda: **P0** = grozi utratą floty albo surowców · **P1** = moduł nie działa lub działa gorzej
niż na Athenie · **P2** = hałas/kosmetyka.

---

## 1. Naprawione od razu (v3.22.0)

| # | Waga | Rzecz | Dowód |
|---|---|---|---|
| 1 | P0 | **Bramka anty-duplikat zjadała fale 2..N ekspedycji.** Warunek „ten sam cel z tej samej pary w ciągu 3 min" powstał dla RATUNKU (jeden lot na parę), a wszystkie fale lecą z tego samego ciała na poz. 16 co 60–90 s. 2.x wypinało z tej bramki ekspedycje wprost. Teraz ekonomia ma okno 20 s (chroni przed podwójnym klikiem po przeładowaniu), obrona bez zmian. | log 29.08 **09:27:03** „wysyłka do [1:217:16] już poszła 81s temu — nie powtarzam" |
| 2 | P0 | **Nieodczytany metal kasował sufit 25% przy stawianiu księżyca.** `budget = metal ? … : null`, a niżej `budget == null \|\| c <= budget` → przy nieudanym odczycie paska surowców bot brał PIERWSZĄ średnicę z listy (8944 km; na Athenie 6000 km = 1,8 bln metalu). Nieznany stan konta nie może znaczyć „wydaj ile chcesz" — teraz odmawia i zrzuca markup paska. | kod, `Moon.tick` |
| 3 | P1 | **Panel ukrywał powód postoju ekspedycji.** Regresja z v3.20.0: „(limit fal 2)" było wycinane, gracz widział tylko „czekam na powroty" i nie wiedział, że bot blokuje się jego własnym ustawieniem. | kod, `renderStatus` |

Nowy scenariusz **E2E 34** pilnuje punktu 1 (fala 2 wychodzi po odstępie, a bramka nadal
nie pozwala wysłać tej samej fali dwa razy).

---

## 2. Do decyzji właściciela — ustawienia (natychmiastowy zysk, zero kodu)

| Waga | Rzecz | Liczby |
|---|---|---|
| P0 | **`fale` = 2 przy 4 slotach ekspedycji.** W 3.x „fale" to LIMIT równoległych ekspedycji, nie podział floty w czasie. Dwa sloty stoją puste na okrągło. | ustaw **4** |
| P0 | **„Odkrywca 40 min" OFF, choć grasz Odkrywcą.** Cykl 70 min × 2 sloty ≈ 41 wypraw/dobę zamiast ~50 min × 4 sloty ≈ 115/dobę. | **2,8× mniej łupu** |

Obie zmiany są w panelu, nie wymagają nowej wersji skryptu.

---

## 3. Obrona — znaleziska niezałatane (najpierw te)

| # | Waga | Rzecz |
|---|---|---|
| O1 | P0 | **Lot w fazie `recalled`/`recall_clicked` ucisza parę i blokuje rekonesans, który jako jedyny mógłby go domknąć.** Fazy `done` nikt nigdy nie ustawia; wpis żyje do `recallAt + 60 min`, a przez ten czas atak na tę parę kończy się `continue` — bez alertu i bez pusha. |
| O2 | P0 | **„Bezpieczna strona" (hold) liczona z odczytu hangaru sprzed nawet 48 h**, i to tylko logiem `info` bez pusha. Jeśli sam przeniosłeś flotę, a bot tego nie odczytał, uzna atakowane ciało za puste. |
| O3 | P0 | **Ślepy alarm gaśnie w całości, gdy istnieje JAKIKOLWIEK rozpoznany atak** — także gdy dotyczy zupełnie innej, pustej kolonii. Dokładnie ten wariant, dla którego moduł powstał (incydent 12.08 na Athenie). |
| O4 | P1 | **Wrogi wiersz bez czytelnego odliczania → `eta = 0` → zagrożenie wypada ze wszystkich filtrów** (`arriveAt > now`). W panelu „Zagrożenia: brak", telefon milczy, w logu jedna linia `[ATAK DOM]`. |
| O5 | P1 | **Ślepa ucieczka zawraca po sztywnych 10 minutach**, a Genesis ma fleet speed x3 (doloty 30–60 min). Flota wraca do hangaru przed uderzeniem, a druga ucieczka już nie nastąpi. |
| O6 | P1 | **Nieczytelny pasek misji wyłącza ślepy alarm bezszelestnie** — bez logu i bez zrzutu markupu, wbrew regule „nieznany markup → zrzut, nie zgadywanie". |
| O7 | P1 | **Nadzorca jest wyłączany przez wpis `mission` bez terminu ważności** — a jedyny czyściciel tego wpisu siedzi w pętli, którą nadzorca ma wskrzeszać. Bot wygląda żywo, obrona nie istnieje. |
| O8 | P1 | **Brak „Duration of flight" nie zostawia śladu** (`if (ft) {…}` bez `else`) → wpis-widmo z terminem zawrotu dla lotu, który już wylądował. |
| O9 | P1 | **`s.pairs` nigdy nie jest czyszczone** — utracona kolonia zostaje legalnym celem ucieczki; gra odmawia misji, bot ponawia w kółko. |

---

## 4. Ekonomia — znaleziska niezałatane

| # | Waga | Rzecz |
|---|---|---|
| E1 | P0 | **Fala „domykająca serię" zabiera CAŁY hangar bez limitu.** 2.x miało sufit `SWEEP_CAP_X = 3` po incydencie 05.08 (jedna ekspedycja wywiozła 86,7 mld statków). Przy `waves: 1` zamiata każda fala. |
| E2 | P0 | **Rezerwa slotów floty jest omijana zawsze, gdy fala bierze wszystko** (a przy `waves: 1` bierze zawsze) — ekspedycja może zająć ostatni slot i ratunek nie ma czym wyjść. Pole „rezerwa slotów" w panelu przy domyślnej konfiguracji nic nie robi. |
| E3 | P1 | **Hangar księżyca zasłania minery/recyklery stojące na planecie** (`hangars[moon] \|\| hangars[planet]` — wpis księżyca wygrywa samą obecnością, nawet z `total: 0`). |
| E4 | P1 | **Skan asteroid nie ma sufitu nawigacji**: gdy `location.search` nie pasuje do wzorca, gałąź nawigacyjna nie woła `advance()` → bot przeładowuje ten sam układ w kółko (~180/h), aż zatka `NavRate`. |
| E5 | P1 | **Zakresy asteroid z innej galaktyki odrzucane bez wyjątku** (2.x je tylko sortowało na koniec) → mining może nigdy nic nie wysłać. |
| E6 | P1 | **`aster.launchFrom` nie ma pola w panelu** — mining startuje z aktywnej planety, więc jedno kliknięcie operatora go usypia. |
| E7 | P1 | **`Moon` próbuje tylko PIERWSZEJ planety bez księżyca**; jedna za droga blokuje wszystkie pozostałe (2.x iterowało po całej liście). |
| E8 | P1 | **Nowa seria fal wymiarowana z niemal pustego hangaru** — 2.x doliczało flotę w powietrzu (`hangar + sizes × wavesInAir`). |
| E9 | P2 | `Bonus.claimable` sprawdza wyszarzenie tylko na samym elemencie (2.x szło 3 poziomy w górę) → możliwe nawigacje bez odbioru co 15 min. |
| E10 | P2 | Brak `humanRoundDown` z 2.x — fale to liczby typu 10 437 522, których żaden człowiek nie wpisuje. |

---

## 5. Testy — czego nie sprawdzają

Stan: 200 asercji decyzyjnych (z czego **116, czyli 58%, to regexy na źródle** — nic nie wykonują)
+ 118 sprawdzeń E2E / 34 scenariusze + panel. Dwa pełne przebiegi identyczne co do bajtu.

| # | Waga | Luka |
|---|---|---|
| T1 | P0 | **Asercja o wygasaniu `pending` trafia w niewłaściwą linię** — po programowym usunięciu prawdziwego warunku z `flightStale()` test nadal przechodzi. Pilnuje defektu P0 z 28.08 tylko pozornie. |
| T2 | P0 | **Push na telefon nie jest testowany w ogóle** (`GM_xmlhttpRequest` zaślepiony). Dławik `THROTTLE.ATAK` działa po RODZAJU, nie po zagrożeniu — drugi atak w ciągu 5 min nie wygeneruje pusha i nikt tego nie łapie. |
| T3 | P0 | **Wiersz ACS („Players: 1/2") nigdy nie powstaje w atrapie** — reguła „jedna współrzędna = CEL" nie ma wykonania, tylko regex. |
| T4 | P0 | **Gra w atrapie nigdy nie odmawia wysyłki** (brak deuteru, brak slotu) — czyli ścieżka najbliższa defektowi „nieśmiertelny `pending`" nie jest przechodzona. |
| T5 | P1 | Ponowienie zawrotu po 2 min (`recall_clicked` → drugi klik) nie ma testu; asercja w scenariuszu 9 przechodzi także pusto. |
| T6 | P1 | `watchdog`, `keepalive` i `setInterval` nie wykonują się w żadnym teście. |
| T7 | P1 | **Wyciek instancji jsdom**: `run()` nie woła `window.close()`, a `setInterval` nie jest kompresowany — porzucone „karty" tykają na tym samym stanie. To jednocześnie źródło mrugania i maskowania. |
| T8 | P1 | Stały budżet 140 ms na load kontra realne pętle 8–25 s w kodzie (`while (Date.now() - t0 < 8000)`) — asercje mogą mierzyć stan częściowo zapisany. |
| T9 | P1 | Dwie asercje są tautologiami/przechodzą pusto (`… \|\| true`, `g.sent.length <= 1` przy zerze wysyłek). |

Czego atrapa nie umie odtworzyć: wiersza ACS, odmowy wysyłki, pełnego przeładowania w środku
formularza, wolnej odpowiedzi serwera, innego markupu paska misji.

---

## 6. Konfiguracja i panel

| # | Waga | Rzecz |
|---|---|---|
| K1 | P0 | **Nie ma ŻADNEGO widoku zarobku.** Zero parsowania łupu z ekspedycji. 2.x miało potwierdzone endpointy `/messages/messagedata?MessageCategoryType=FLEET_EXPEDITION` i `FLEET_OTHER`. Gracz nie ma jak stwierdzić, czy bot na siebie zarabia. |
| K2 | P1 | **Rekonesans nie liczy się do sufitu `maxNavPerHour` ani nie respektuje ciszy nocnej** — wchodzi na `/fleet` co 8 min także 23:00–05:00, kiedy konto ma „wyglądać na śpiące". |
| K3 | P1 | **Zero księżyców łamie hierarchię ucieczki**: każdy ratunek spada do „pierwsza nieatakowana kolonia z listy" — bez sprawdzenia odległości, czasu lotu i deuteru, przy 10% prędkości. |
| K4 | P1 | Progi obrony (`confirmMs`, `tooLateSec`, `barHoldMs`, `recallBufferSec`) i większość ustawień ekonomii nie są edytowalne z panelu. |
| K5 | P1 | `enabled: true` i `bonus.enabled: true` to jedyne moduły startujące bez zgody operatora — sprzeczne z instrukcją „krok 1: całą ekonomię OFF". (Bonus na wyraźne życzenie właściciela zostaje ON.) |
| K6 | P2 | Zwinięta sekcja „Ekonomia" nie pokazuje Bonusu ani Księżyców — jedynego modułu, który bezpowrotnie wydaje metal. |
| K7 | P2 | Dokumentacja rozjechała się z rzeczywistością (liczby testów, numeracja scenariuszy). |

---

## 7. Rekomendowana kolejność

1. **Ustawienia w panelu** (0 kodu, największy zysk): fale = 4, Odkrywca 40 min ON.
2. **Obrona P0**: O1 (faza `recalled` ucisza parę), O2 (hold na danych sprzed 48 h), O3 (ślepy alarm gaszony obcym atakiem).
3. **Ekonomia P0**: E1 (sufit zamiatania), E2 (rezerwa slotów).
4. **Testy P0**: T1 (asercja trafiająca w złą linię), T4 (odmowa wysyłki w atrapie), T2 (push).
5. **Widok zarobku** (K1) — bez tego nie da się ocenić, czy ekonomia ma sens.
6. Reszta P1 wg kolejności w tabelach.

Nie zaczynałem żadnego z punktów 2–6 — czekają na decyzję właściciela, bo część z nich
(zwłaszcza O1–O3) zmienia zachowanie obrony i wymaga nowych scenariuszy E2E, a nie samych regexów.

---

# Aneks — audyt kontrolny po v3.28.0 (29.08, popołudnie)

Sprawdzone na żywym kodzie, nie z pamięci: każde znalezisko odtworzone przypadkiem
testowym, który jest CZERWONY na v3.28.0 i zielony na v3.29.0 (weryfikacja przez
podmianę pliku na wersję z HEAD).

## Naprawione w v3.29.0

| # | waga | co było | co jest |
|---|---|---|---|
| **O1** | P0 | Wpis lotu z tej pary powodował `continue` w pętli obrony — atak na parę, z której cokolwiek leciało, nie dawał **ani alarmu, ani pusha**. Fazy `done` nikt nigdy nie ustawia, a `recalled` żyje do `recallAt + 60 min`, więc po udanym zawrocie para milczała godzinę. | Ratunku nadal nie ma (flota w powietrzu), ale idzie alarm `error` z pushem, dławiony 5 min: osobna treść dla floty wracającej („sprawdź, czy zdąży wylądować po uderzeniu") i dla lotu w toku. |
| **O2** | P0 | „Bezpieczna strona" (hold) zapadała na odczycie hangaru sprzed nawet **48 h** — `fleetsAt()` tyle akceptuje. Gdy właściciel sam przestawił flotę, bot uznawał atakowane ciało za puste i milczał. | Świeży odczyt (≤30 min) = spokojny hold jak dotąd. Starszy = alarm `error` z pushem („NIE WIEM, czy flota nadal stoi po bezpiecznej stronie") + rekonesans, gdy do uderzenia >90 s. |
| **O3** | P0 | Ślepy alarm gasł w całości, gdy istniał **jakikolwiek** rozpoznany atak — także na obcą, pustą kolonię. Dokładnie wariant, dla którego moduł powstał (12.08 na Athenie). | Ślepy alarm działa niezależnie od cudzych ataków; pomijane są tylko pary, które mają własne rozpoznane zagrożenie (obsługuje je pętla wyżej). Nadwyżka na pasku i tak odejmuje loty rozpoznane. |
| **E2** | P0 | Rezerwa slotów floty była omijana zawsze, gdy fala bierze cały hangar — a po zdjęciu sufitu (v3.28.0) bierze go niemal zawsze. Pole „rezerwa slotów" w panelu nie robiło NIC. | Ominięcie tylko wtedy, gdy poza ciałem startowym **nigdzie nie stoi flota** (transportery na koloniach też potrzebują slotu na ucieczkę). W przeciwnym razie rezerwa obowiązuje. |

Testy: sekcje 33–34 w `test3-decide.js` (8 asercji obronnych + 2 ekonomiczne).
6 z nich pada na v3.28.0 — to są testy regresji, nie ozdoby.

## Zweryfikowane, znalezisko NIE potwierdzone

- **T1** („asercja o wygasaniu `pending` trafia w niewłaściwą linię") — sprawdzone
  eksperymentalnie: po usunięciu z `flightStale()` warunku `f.pending && now - f.sentAt > 10 min`
  test **pada** (`osierocony wpis 'pending' NIE zaslepia obrony pary`). Asercja jest skuteczna;
  wpis z audytu porannego był błędny.

## Nadal otwarte (świadomie, w kolejności)

| # | waga | rzecz |
|---|---|---|
| T2 | P0 | Push na telefon nie jest testowany w ogóle (`GM_xmlhttpRequest` zaślepiony). Dławik `THROTTLE.ATAK` działa po RODZAJU, nie po zagrożeniu — drugi atak w ciągu 5 min może nie wygenerować pusha. Po O1/O2 przez pusha idzie więcej stanów, więc waga rośnie. |
| T4 | P0 | Gra w atrapie nigdy nie odmawia wysyłki (brak deuteru, brak slotu) — ścieżka najbliższa defektowi „nieśmiertelny `pending`" nie jest przechodzona. |
| T3 | P1 | Wiersz ACS („Players: 1/2") nie powstaje w atrapie — reguła „jedna współrzędna = CEL" ma tylko regex. |
| K1 | P0 | Zero widoku zarobku: łup z ekspedycji nie jest parsowany, więc nie da się stwierdzić, czy bot zarabia. 2.x miało potwierdzone endpointy `/messages/messagedata?MessageCategoryType=FLEET_EXPEDITION` i `FLEET_OTHER`. |
| — | — | **Obrona nigdy nie była sprawdzona na żywo na Genesis** — przycisk „TEST: atak na planetę" w panelu wciąż nieklikany. Wszystko powyżej to dowód z testów, nie z gry. |
| — | — | Mining nie ruszył ani razu — brak statków (Asteroid Miner) na koncie, nie błąd kodu. |

## Skutek uboczny do obserwacji

Patrol rekonesansu jest domyślnie WYŁĄCZONY (decyzja właściciela z 29.08), więc wiedza
o hangarach kolonii innych niż baza ekspedycyjna bierze się tylko z Twoich wizyt na
`/fleet`. Po poprawce O2 atak na taką kolonię da alarm „nie wiem, gdzie flota" zamiast
cichego „bezpieczna strona". To jest zamierzone — cisza przy ataku jest gorsza niż
zbędny alarm — ale jeśli takich alarmów będzie dużo, właściwą odpowiedzią jest włączenie
rekonesansu w trybie `fleet`, nie ściszanie obrony.
