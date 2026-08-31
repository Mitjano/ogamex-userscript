# AUDYT: mapowanie własnych flot i ochrona powrotów (2026-08-31)

**STATUS: WDROŻONE w v3.52.0 (etapy A+B; etap C świadomie pominięty).**
Testy: `test3-decide.js` sekcje R1–R6 + wzorce, `test3-e2e.js` scenariusz 37
(pełna ścieżka: wysyłka → rejestr → chirurgia „fala wylądowała pod atak" →
ponowny odczyt hangaru → ratunek). Cała bateria `test3-all.js` 2× zielona.
Tego samego dnia o 18:48 był PRAWDZIWY atak na [1:217:6] (jeszcze na 3.51.0):
ewakuacja zadziałała, a fale ekspedycji lądowały ~22 min PO uderzeniu — czyli
dokładnie okno, które rejestr od teraz obejmuje alarmem i rekonesansem.

Pytanie właściciela: „bot ma mapować każdą wysłaną flotę i wiedzieć, kiedy wraca.
Jak ktoś nas zaatakuje, będzie wiedział, co kiedy wraca i co bronić albo wysyłać."

Scenariusz zagrożenia = **snajperka powrotów** (ścieżka A5 z Atheny, nazwana już
w komentarzu przy v3.35.0): napastnik widzi rytm ekspedycji i celuje uderzeniem
w księżyc [1:217:6] tuż po lądowaniu fali. Dziś bot ratuje tylko to, co stało
w hangarze w momencie alarmu.

## 1. Co bot już wie (stan v3.51.0)

| Wiedza | Gdzie | Użycie |
|---|---|---|
| Loty obronne (air/home/swap): sentAt, flightMs, recallAt, fazy | `s.flights` | pełne (zawrót, extend, alarmy) |
| Ekspedycje: skład fali, czas lotu (loguje „czas lotu 980 s"), czas trwania (40 min) | **nigdzie** — dane są w ręku przy wysyłce i wyrzucane | brak |
| Terminy własnych powrotów z listy ruchów | `s.landings` (v3.35.0) | tylko gałąź ciszy: recon hangaru po lądowaniu |
| Sloty expo used/total | `s.slots.expo` | tylko limit fal |

Ekspedycje celowo NIE trafiają do `s.flights` (v3.2.0: wpisana tam ekspedycja
zaślepiłaby obronę pary). Słuszne — ale skutkiem ubocznym jest amnezja: bot
nie zna terminów powrotu ~2 mln statków na falę.

## 2. Luki

- **L1 — pominięta para przy trwającym ratunku.** `decide()` przy ataku na parę
  z żywym wpisem lotu robi `continue` (ok. linii 878–890): fala lądująca pod
  uderzenie dostaje tylko push „reaguj ręcznie". Drugiego ratunku nie ma.
- **L2 — fałszywe domknięcie ratunku.** Wpis lotu z zawrotem domyka się, gdy
  hangar ŹRÓDŁA pokaże statki >60 s po wysyłce (ok. linii 679). Lądująca fala
  ekspedycji wygląda identycznie jak powrót ratunku → wpis „domknięty — flota
  widziana", stan bota rozjeżdża się z rzeczywistością (ratunek wciąż leci,
  a bot myśli, że wrócił; zawrót/extend przestają go dotyczyć).
- **L3 — brak prognozy powrotów.** Bot nie umie powiedzieć „fala ~2 mln szt.
  ląduje 18 s przed uderzeniem" ani zaplanować recon+ratunek tuż po lądowaniu.
  `s.landings` łapie termin tylko wtedy, gdy refresh zdąży zobaczyć wiersz
  powrotu na liście (znika w sekundzie lądowania) — i tylko dla aktywnej pary.
- **L4 — fale w powietrzu poza analizą.** Nowe fale są słusznie wstrzymywane
  przy alarmie (`expoPlan`: „alarm — obrona ma pierwszeństwo"), ale fale już
  wysłane nie są ani policzone, ani zawracane, ani uwzględniane w decyzji.

## 3. Plan: REJESTR POWROTÓW (`s.expected`)

Osobny rejestr, NIE `s.flights` — zero ryzyka zaślepienia obrony (lekcja v3.2.0).

### Etap A — mapowanie wysyłek (fundament, bez zmiany zachowania)
1. Każda wysyłka (ekspedycja, asteroida, złom) dopisuje wpis:
   `{kind, fromKey, fromBody, ships, total, sentAt, flightMs, holdMs,`
   `returnAt = sentAt + 2*flightMs + holdMs, waveNo}`.
   Dane są już w ręku w maszynie Fly (m.flightMs z kroku 3, duration z planu).
2. Korekta z listy ruchów: wiersz `isReturn` z ETA nadpisuje szacunek
   (dokładny zegar > arytmetyka). Wygaszanie wpisu: `returnAt + 60 min`.
3. Panel: sekcja „Powroty" — ile statków i o której ląduje (operator widzi to,
   co bot). `s.landings` zostaje (źródło korekt), rejestr jest nadrzędny.

### Etap B — obrona używa rejestru (właściwa poprawa)
4. **Ratunek uzupełniający.** W gałęzi ataku na parę k (także gdy trwa ratunek
   — zamiast `continue`): fale z `returnAt` < najbliższe uderzenie:
   - lądowanie ≥ ~120 s przed uderzeniem → recon hangaru zaraz po `returnAt`
     i natychmiastowy ratunek świeżo wylądowanych (bez `confirmMs` — zagrożenie
     już potwierdzone; obowiązuje tylko `tooLateSec`),
   - lądowanie < `tooLateSec` przed uderzeniem → wczesny push z konkretem:
     „fala ~N szt. ląduje X s przed uderzeniem — NIE ZDĄŻĘ, rozważ ręczny zawrót".
5. **Naprawa L2.** Domykanie wpisu ratunku pyta rejestr: jeśli w ±2 min od
   odczytu hangaru wypadał spodziewany powrót ekspedycji, wpisu nie domykaj
   (to obce statki w hangarze, nie powrót ratunku).
6. **Alarm z mapą.** Push o ataku od razu wylicza z rejestru, które fale
   wpadają w okno dolotu — operator wie w sekundę, czy musi siadać do gry.

### Etap C — świadomie POMIJAM (na teraz)
- Zawracanie fal ekspedycji w locie: klik w listę ruchów na forku = nowy,
  kruchy markup; zysk umiarkowany (zawrócona fala i tak ląduje w okno ataku).
  Wracać tylko, jeśli snajperka faktycznie wystąpi na Genesis.
- „Wysyłanie obrony pod lądowanie": nie ma czym — cała flota bojowa jest
  w falach; stacjonarna obrona to osobny temat (AUDYT-HUBY-2-OBRONA).

## 4. Testy (przed wdrożeniem — lekcja 25.08)
`test-powroty.js`: macierz `decide()` z rejestrem — fala przed uderzeniem
(ratunek uzupełniający), fala po uderzeniu (cisza), fala < tooLateSec (alarm),
trwający ratunek + lądowanie (brak fałszywego domknięcia, jest drugi ratunek),
rejestr pusty (zachowanie identyczne jak dziś).

## 5. Szczera granica
Lotu snajperskiego z dolotem < 40 s nie przeskoczymy — formularz floty
potrzebuje czasu. Realny zysk to: drugi ratunek dla fal lądujących w środku
alarmu (L1), koniec rozjazdu stanu (L2) i push, który mówi konkretnie,
co i kiedy wpada pod uderzenie (L3).
