# AUDYT: bot na nowym uniwersum GENESIS (start 28.08.2026, 18:00 GMT)

Ogłoszenie serwera: Economy **2000x dynamiczne** (start 500x, +500x/tydzień),
Fleet **3x**, Defense debris **0%**, **ACS wyłączony** (solo-ACS działa),
podbity urobek **ekspedycji** i **asteroid**. Audyt kodu v2.97.4 (13 943
linie) + STAN-I-PLAN pod kątem: co zadziała od ręki, co trzeba ustawić,
co jest ryzykiem, plan wejścia fazami.

---

## 1. CO ZADZIAŁA OD RĘKI (zero zmian w kodzie)

1. **Skrypt sam wstanie na Genesis** — `@match https://*.ogamex.net/*`
   obejmuje `genesis.ogamex.net`.
2. **Izolacja per-uni (v2.92.0) jest zdrowa** — magazyn prefiksowany
   `location.host:`, fallback do starych kluczy czyta TYLKO athena.
   Genesis startuje z czystą kartą i `enabled:false`; Athena nietknięta.
   Test test-uni-izolacja.js pilnuje tego na źródle.
3. **Auto-nauka jest idealnie skrojona pod dynamiczną ekonomię**:
   - ładowność minera uczona z formularza (`cargoPerMiner: 0` = auto),
   - urobek asteroid: okno 20 próbek, percentyl 85,
   - łup farmy: FarmYieldDB EMA α=0,5 („łup rośnie z czasem" — dokładnie
     zachowanie ekonomii +500x/tydz.).
   Nic nie jest sztywno zaszyte w kredytach — bot dostroi się sam po
   każdym skoku mnożnika.
4. **Typy misji po nazwach, nie numerach** (ATTACK/Deploy/Collect
   klikane po tekście/klasie) — odporne na numerację forka.
5. **Obrona**: parser paska z opcjonalnym Own/Hostile (v2.88.1), panel
   Events, blitz, AirSave, RescueQueue — wszystko niezależne od mnożników.
6. **UpdateWatch, ntfy, Wake Lock, humanizer** — działają per-host.

## 2. ZAŁOŻENIE DO POTWIERDZENIA W DZIEŃ 1 (zasada: żadnych ślepych endpointów)

Genesis to ten sam operator i niemal na pewno ten sam silnik .NET co
athena, ale **endpointy trzeba potwierdzić na żywo** zanim moduły
zaczną na nich polegać (lekcja z sekcji „ZASADA, KTÓREJ NIE WOLNO
ZŁAMAĆ"). Bot robi to sam — wystarczy przeczytać log:

- `/home/fleetmovementlist` — pierwszy odczyt obrony (bez błędów 404),
- `Partial_AsteroidJournal` / `Partial_ExpeditionJournal` /
  `Partial_PlunderJournal` — logi `[RAPORTY]` / `[FARM LUP]`,
- markup wiersza galaktyki (ranking w tooltipie) — brak `[FARM RANK DOM]`.

Wszystkie parsery mają fail-open + jednorazowy zrzut markupu, więc
odmienny fork nie oślepi bota — poprosi o zrzut.

## 3. KONFIGURACJA NA GENESIS (czysta karta = wszystko od nowa w panelu)

| Ustawienie | Wartość na start | Dlaczego |
|---|---|---|
| ntfy temat + ON | wkleić temat (może być ten sam co na athenie) | magazyn per-host — pusty |
| Klucz Gemini | wkleić ponownie | j.w. |
| `baseBody` | **PLANETA** | świeże uni nie ma księżyca; tryb „moon" bez księżyca = głośne warny przy każdej wysyłce |
| `deutReserve` | **0** (podnieść z rozwojem) | domyślne 100 mld > cały skarbiec przez tygodnie → ratunek/FS zostawiałby CAŁY deuter na lootowanym ciele |
| `minerBase` / `launchFrom` | wpisać bazę Genesis | domyślny fallback to athena [3:272:7] |
| Ekspedycje `waves` | **1–2** (potem w górę) | domyślne 8 fal kroi flotę, której jeszcze nie ma; sloty ekspedycji z astrofizyki będą wąskie |
| Farm `ranges`, `minTargetProfit` | puste / 0 | farm i tak martwy do ~tygodnia 2 (patrz §4.5) |
| FS | OFF do czasu księżyca | FS projektowany księżyc→księżyc |

Moduły na dzień 1: **onlineBonus ON** (jest w defaultach), **threatAlarm
ON** (jest w defaultach), reszta OFF do odblokowania technologii.

## 4. SPECYFIKA GENESIS — analiza per cecha serwera

### 4.1 Dynamiczna ekonomia 500x→2000x (+500x/tydz.)
Najlepsza możliwa wiadomość dla tego bota: wszystkie wielkości uczone.
Jedyny efekt uboczny: po każdym skoku mnożnika percentyl 85 z okna 20
próbek będzie przez kilka(naście) lotów ZANIŻONY → flota minerów chwilowo
za mała na asteroidę (zostawia resztę). `bufferFactor 1.15` amortyzuje;
samo się dostraja w ~1 dzień. Nic nie robić, ewentualnie po skoku
mnożnika podbić ręcznie `bufferFactor` na 1.3 na dobę.

### 4.2 Fleet speed 3x — JEDYNY twardy dług kalibracyjny
`estimateFlightMinutes` = `max(11, ceil(11 + Δ/15))` — dwupunktowa
kalibracja **z atheny** (2026-05-21). Używana w 6 miejscach do
planowania skanu i bramki TTL asteroid (`maxFlightMinutes: 45`).
- Jeśli loty na Genesis będą SZYBSZE → formuła konserwatywna: bot
  niepotrzebnie odpuści asteroidy z krótkim TTL (utracony urobek, zero
  ryzyka).
- Jeśli WOLNIEJSZE → ryzyko wysyłki na asteroidę, która zdespawnuje
  przed dolotem (strata slotu, nie floty).
Realny czas lotu i tak jest czytany z formularza przed Send (bramka
arytmetyki v2.66.x), więc to koszt efektywności, nie bezpieczeństwa.
**TODO po starcie miningu**: dwa pomiary (bliski i daleki system) z
formularza → nowa para stałych. Docelowo (propozycja niżej): auto-nauka
per-host.

### 4.3 Wysoki urobek ekspedycji („profitable early-mid")
Ekspedycje = **główny moduł zarobkowy Genesis w early-mid** (zanim
będzie ASTEROID_MINER). Moduł gotowy, ale defaulty są late-game'owe.
Wykluczenia (miner/kolonizator/GS/recykler/AVATAR) poprawne od dnia 1.
Kolejność na świeżym koncie: astrofizyka → małe cargo → fale 1–2 →
zwiększać fale wraz ze slotami. `collectDebris` zostaje ON (po
przegranej fali złom na poz. 16 zbierany recyklerami — jak będą).

### 4.4 Wysoki urobek asteroid
Rdzeń bota. Wejdzie w mid-game (wymaga ASTEROID_MINER w stoczni).
Zakresy skanu ustawić dopiero po zaobserwowaniu, w której galaktyce
Genesis spawnuje asteroidy (na athenie: g3 = galaktyka z większością
planet graczy). Priorytet mining>farm (v2.90.0) zostaje.

### 4.5 Nowe uni = brak nieaktywnych na starcie
Status (i) pojawia się po 7 dniach nieaktywności → farm martwy do
~4-11.09. Potem złote żniwa: fala porzuconych kont z pierwszego tygodnia
(klasyka nowych uni). Wtedy: ranges, pełny skan buduje bazę celów,
seeding Plunder Journal, `minTargetProfit` 0 przez pierwsze okrążenia.
`maxTargetRank 800` na małym uni przepuszcza prawie wszystkich — OK,
ewentualnie zbić do ~200 gdy populacja urośnie.

### 4.6 ACS wyłączony
Model zagrożenia PROSTSZY: żadnych ataków łączonych — pojedynczy
napastnik, jeden wiersz ATTACK. Cała maszyneria obrony (pasek, lista,
panel Events, blitz <120 s, AirSave) działa bez zmian; scenariusz
„ACS 450 mld" z 12.08 na Genesis niemożliwy. Solo-ACS (spowalnianie
własnej floty) bot ignoruje — nie używa.

### 4.7 Defense debris 0%
- Rozbicie się o obronę nieaktywnego = **czysta strata bez pola złomu**
  → FarmBlacklist (ban 14 dni przy własnych stratach, v2.96.0) jest
  jeszcze ważniejszy niż na athenie. Jest i działa.
- Mniej złomu w uni ogółem → księżyce później (moon-chance z pól po
  bitwach flot) → tryb księżycowy, FS i prom odsuwają się w czasie.
  Symetrycznie: wrogie falangi (wymagają księżyca) też później —
  pierwsze tygodnie są bezpieczniejsze dla lotów z planety.

## 5. RYZYKA OPERACYJNE

1. **Dwa uni naraz na jednej maszynie**: dwie aktywne karty bota =
   2× obciążenie Firefoksa (lekcje v2.93/2.94). Karta w tle jest
   dławiona (throttling) — bot na Genesis w tle będzie zwalniał, chyba
   że dostanie własne okno + klik odblokowujący dźwięk podtrzymujący.
   Rekomendacja: na czas rozkręcania Genesis trzymać oba w OSOBNYCH
   oknach; jeśli laptop muli — osobny profil przeglądarki.
2. **Nie klikać w panel na Genesis przed aktualizacją TM do ≥2.92.0**
   — na tej maszynie już nieaktualne (2.97.4 + UpdateWatch), ale gdyby
   gra szła z innego urządzenia: najpierw wymusić aktualizację skryptu.
3. **Domyślne `enabled:false`** — bot na Genesis stoi, dopóki nie
   zostanie świadomie włączony. To celowe (v2.92.0), nie bug.

## 6. PROPOZYCJE ZMIAN W KODZIE (do decyzji ownera — NIC nie wdrożone)

1. **[P1] Auto-kalibracja czasu lotu per-host**: bot już czyta realny
   czas lotu z formularza przy każdej wysyłce — wystarczy zapisywać pary
   (Δ systemów, minuty) do GM per-host i po ≥2 punktach liczyć własne
   `a + Δ/b` zamiast stałych z atheny. Zdejmuje §4.2 na zawsze i dla
   każdego przyszłego uni. ~40 linii + test.
2. **[P2] `deutReserve` skalowane**: zamiast sztywnych 100 mld —
   np. min(100 mld, 10% stanu deuteru). Chroni świeże konta bez
   pamiętania o panelu.
3. **[P3] Wyciszenie warna „tryb moon bez księżyca"** do 1×/h na
   świeżych kontach (dziś przy każdej wysyłce, jeśli ktoś zostawi
   default). Alternatywa zerokosztowa: ustawić baseBody=planeta w
   panelu (§3) i wrócić do tematu przy pierwszym księżycu.

## 7. PLAN WEJŚCIA FAZAMI

- **F0 — 28.08, 18:00 GMT (dzień 0)**: rejestracja, wejście na
  `genesis.ogamex.net` (skrypt wstanie sam), konfiguracja z §3,
  bot ON z samym onlineBonus+threatAlarm. Sprawdzić w logu odczyt
  `fleetmovementlist` (§2). Early game = ręczna rozbudowa (bot nie
  buduje i budować nie musi — kopalnie na 500x rosną same z siebie).
- **F1 — tydzień 1**: astrofizyka + małe cargo → ekspedycje ON
  (1–2 fale). Czytać `[RAPORTY]`/dziennik ekspedycji — potwierdza
  endpointy. To główny dochód tej fazy (serwer celowo podbił yield).
- **F2 — gdy ASTEROID_MINER dostępny**: mining ON, zakresy pod
  galaktykę spawnu, 2 pomiary lotu → rekalibracja §4.2 (albo wdrożenie
  P1 przed startem — 10 dni zapasu do 28.08).
- **F3 — ~tydzień 2 (pojawiają się (i))**: farm ON, pełny skan buduje
  bazę, seeding Plunder Journal, blacklista pilnuje obron (debris 0%!).
- **F4 — pierwszy księżyc**: baseBody=moon, FS, prom wg potrzeb —
  dokładnie obecna konfiguracja atheny.

## 8. OBRONA FLOTY NA GENESIS (dopisane 18.08 na pytanie ownera)

**Co działa od dnia 1:** threatAlarm (default ON), odczyt
`fleetmovementlist`, parser paska, klasyfikacja, blitz <120 s, push ntfy.
Wykrywanie ataku jest kompletne od pierwszej minuty.

**Luka wczesnej gry: ratunek nie ma DOKĄD uciec.** Cała maszyneria
ewakuacji (MoonSave/AirSave/FS) zakłada, że istnieje drugie ciało:
- MoonSave: przerzut planeta↔księżyc tej samej pary — **brak księżyca =
  brak ścieżki**;
- AirSave: Deploy do najbliższej INNEJ kolonii — **brak kolonii = brak
  refugium**;
- FS: celuje jawnie w księżyc (`data-planet-type=2`) — martwy do
  pierwszego księżyca.
Z jedną planetą i bez księżyca bot wykryje atak, zaalarmuje, pchnie
push… i nie będzie miał czym zareagować. To nie bug — to geometria.

**Dlaczego to małe ryzyko na starcie:** flota z tygodni 1–2 to grosze
(kilka cargo), noob-protection typowo osłania małych, ACS off = tylko
solo ataki, a falanga wymaga KSIĘŻYCA — których w uni z debris 0% z
obrony długo prawie nie będzie. Realne zagrożenie rośnie razem z flotą,
a do tego czasu powinny istnieć kolonie.

**Plan obrony fazami:**
1. **Tydzień 1–2**: flota żyje w powietrzu — ekspedycje kręcą się
   niemal ciągle (i tak są głównym dochodem; flota w locie jest
   nietykalna). Na noc: ostatnia fala przed snem = naturalny mini-FS.
2. **Druga kolonia = priorytet strategiczny #1** (statek kolonizacyjny
   zaraz po astro): od tego momentu AirSave i RescueQueue mają cel —
   pełna automatyczna ewakuacja wraca do gry. Kolonię stawiać w INNYM
   układzie (ucieczka poza zasięg jednego napastnika).
3. **Obrona statyczna opłaca się tu BARDZIEJ niż na athenie**: debris
   0% z obrony = napastnik nie ma z rozbicia wieżyczek ani grama złomu
   — turtling zniechęca ekonomicznie. Kilka poziomów wież wcześnie =
   sondy i drobni odpuszczają.
4. **Pierwszy księżyc**: baseBody=moon, FS nocny, prom — pełna
   konfiguracja znana z atheny. Wróg z falangą też dopiero od swojego
   księżyca, więc wyścig jest symetryczny.

**Opcjonalny pomysł (P4, do decyzji — NIE wdrożone):** tryb „ratunek
bez refugium" = przy potwierdzonym ataku i braku drugiego ciała wysłać
flotę+surowce w dowolny lot (np. Deploy 10% w stronę własnej przyszłej
kolonii albo transport na pusty slot) i zawrócić po przejściu ataku —
mechanika zawracania (x_btn_fleet_return) już jest w FS/AirSave. Sens
wdrażać tylko, jeśli flota urośnie szybciej niż stanie druga kolonia.

## WERDYKT

Bot jest w ~90% gotowy na Genesis bez dotykania kodu — architektura
per-host + auto-nauka zrobiły robotę. Jedyny realny dług techniczny to
kalibracja czasu lotu (P1, warto wdrożyć przed 28.08), reszta to
konfiguracja panelu (§3) i dyscyplina fazowa (§7). Największa zmiana
względem atheny jest strategiczna, nie techniczna: przez pierwsze 2–3
tygodnie zarabiają ekspedycje, nie mining/farm.
