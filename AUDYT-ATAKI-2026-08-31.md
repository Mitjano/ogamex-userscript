# AUDYT OBRONY: model zagrożeń, symulacja wektorów ataku, werdykt (2026-08-31)

Zlecenie ownera: „przeprowadź audyt, analizę i symulację wszystkich możliwych
ataków — chcę mieć pewność, że wszystko mamy dobrze zaplanowane i wdrożone.
Obrona floty jest najważniejsza."

Metoda: (1) model zagrożeń dla forka Genesis, (2) **symulacja każdego wektora
na PRAWDZIWEJ funkcji decyzyjnej** — nowa stała bateria `test3-wargame.js`
(29 sprawdzeń, wpięta w `test3-all.js`), (3) audyt warstwy wykonawczej
(to, czego czysta decyzja nie widzi), (4) dowody z żywych ataków.

## 1. Werdykt ogólny

Obrona pilnowanej pary jest szczelna na poziomie decyzji — **28/29 wektorów
przeszło od razu, jeden (W12) ujawnił realną lukę, naprawioną w v3.54.0**
przed publikacją tego raportu. Dowody bojowe: dwa prawdziwe ataki 31.08
(18:48 i 19:26) — oba wykryte z listy w jednym ticku, push doszedł,
ewakuacja poszła w ~40 s od wykrycia. Realne ryzyka utraty floty leżą dziś
nie w decyzji, tylko w **warstwie środowiska** (sekcja 4: żywa karta, sesja)
i w **znanych granicach** (sekcja 5).

## 2. Model zagrożeń i wynik symulacji (test3-wargame.js)

| # | Wektor | Zachowanie bota | Werdykt |
|---|---|---|---|
| W1 | atak na księżyc z flotą | air 10% na sąsiedni księżyc + zawrót po dolocie+90 s | ✅ sym. + **na żywo 18:48 i 19:26** |
| W2 | brak sąsiedniego księżyca | swap na drugie ciało pary (100%) | ✅ sym. |
| W3 | atak na OBA ciała | powietrze do innej kolonii, zawrót po ostatnim dolocie | ✅ sym. |
| W4 | wszystko atakowane | alarm „brak refugium", nic nie leci POD uderzenie | ✅ sym. |
| W5 | wykrycie <40 s przed dolotem | ZA PÓŹNO — tylko alarm (fizyka formularza) | ✅ sym. (granica) |
| W6 | dolot 40–60 s, świeży wiersz | ratunek NATYCHMIAST (potwierdzanie pomijane, gdy zjadłoby okno) | ✅ sym. |
| W7 | dolot długi, świeży wiersz | 20 s potwierdzenia (artefakt nie rusza floty) | ✅ sym. |
| W8 | atak na puste ciało pary | „bezpieczna strona", zero ruchu | ✅ sym. + e2e 3 |
| W9 | jw., ale odczyt >30 min | NIE WIEM → rekonesans, nie ślepa wiara | ✅ sym. |
| W10 | **snajperka powrotów** (fala lądowała po odczycie) | rejestr powrotów unieważnia odczyt → recon → ratunek | ✅ sym. + e2e 37 |
| W11 | hangar nieznany | recon gdy ≥90 s; sam czerwony alarm gdy mniej | ✅ sym. |
| W12 | **druga fala ataku w trakcie ratunku, hangar pusty** | extend zawrotu — **LUKA znaleziona tym audytem, fix v3.54.0** | ✅ po fixie |
| W13 | ratunek w powietrzu + fale lądują przed uderzeniem | alarm z zegarem i liczbą statków (granica: bez 2. ratunku) | ✅ sym. |
| W14 | sama sonda | flota NIE drga (decyzja ownera 26.08) | ✅ sym. |
| W15 | sonda + atak | ratunek normalnie | ✅ sym. |
| W16 | atak widoczny TYLKO na pasku (fork gubi listę) | ślepy alarm: ucieczka największego hangaru; bez hangaru — uczciwy alarm | ✅ sym. |
| W17 | atak na kolonię spoza paska planet | czerwony alarm, nigdy cisza | ✅ sym. |
| W18 | odczyt hangaru >48 h | jak nieznany → recon | ✅ sym. |
| W19 | wpis lotu po nieudanym zawrocie | nie zaślepia pary; nowy atak = nowy ratunek + alarm o wiszącym locie | ✅ sym. |
| W20 | dwa ataki na dwie pary naraz | dwa ratunki w jednym przebiegu | ✅ sym. |
| W21 | flota na obu ciałach, atak w planetę | ratunek z CIAŁA POD ATAKIEM | ✅ sym. |
| W22 | atak w oknie nocnego FS | obrona wygrywa z FS | ✅ sym. |
| W23 | finta: zawrót napastnika → re-atak | wcześniejszy zawrót po 60 s czystego paska; nowy atak działa normalnie | ✅ sym. + **na żywo 19:44** |
| W24 | atak na kolonię bez floty | recon/alarm; główna flota zostaje w domu | ✅ sym. |
| — | Destroy na księżyc / rakiety / ACS / nieznany typ misji | regex parsera: DESTRUCT/MISSILE/ACS/nieznany = ATAK → ścieżki jak wyżej | ✅ analiza (parser z 2.x, potwierdzony bojowo na Athenie 26.08) |
| — | flota na ekspedycji | nietykalna w locie; powroty mapowane rejestrem (3.52) | ✅ na żywo (panel „Powroty") |

## 3. Luka znaleziona i naprawiona (v3.54.0)

Przedłużanie zawrotu przy „dosłanej fali" żyło wyłącznie w gałęzi „flota
w hangarze". Po ratunku hangar jest z definicji PUSTY, więc druga fala ataku
trafiała w gałąź „nie ma czego ratować" — bez extend. Skutek: ucieczka
wracała 90 s po dolocie PIERWSZEJ fali, dokładnie pod drugą. Klasyczna
dwufalówka snajperska. Fix: extend działa niezależnie od stanu hangaru
(war-game W12 pilnuje na stałe).

## 4. Warstwa wykonawcza — co nie jest decyzją, a decyduje o życiu floty

1. **ŻYWA KARTA = jedyny twardy warunek.** Bot to userscript: karta zamknięta,
   komputer uśpiony, Firefox zdławiony = zero obrony. W logu z 31.08 wielokrotnie
   „[WAKE] blokada uśpienia zwolniona" — blokada działa tylko przy WIDOCZNEJ
   karcie. Zalecenie: karta z grą na wierzchu (osobne okno), Mac podpięty do
   zasilania; docelowo stary laptop 24/7 (decyzja z 26.08 wciąż otwarta).
2. **Sesja.** Wygaśnięcie = ślepota; bot alarmuje (GOTOWOŚĆ + push „SESJA"),
   ale zalogować musi się człowiek.
3. **Samokontrola gotowości (v3.45)** melduje braki, ZANIM coś się stanie:
   hangar świeży / jest dokąd uciec / push ON — zielona linia 17:59 na żywo.
4. **Sloty floty.** Rezerwa 1 slotu chroni ratunek przed ekspedycjami; dwa
   równoczesne ataki potrzebują 2 wolnych slotów (dziś 9/21 — duży zapas,
   ale przy limicie fal 8 pilnować rezerwy ≥2 przy >1 aktywnej parze z flotą).
5. **Paliwo.** Ratunek zabiera surowce minus rezerwa deuteru (100 M); lot
   potrzebuje deuteru — przy pustym deuterze formularz odrzuci wysyłkę
   (bot zaloguje „NIE potwierdzona" i alarmuje, ale nie poleci). Przy
   obecnych zapasach (mld z ekspedycji) ryzyko pomijalne; nie zerować deuteru
   ręcznymi transferami na ciele z flotą.
6. **Dwie karty** — TabLock: jeden lider, druga karta nie dubluje (e2e 5).
7. **Okno przejściowe po deployu** (nauczka 3.53.1): stare loty/fale sprzed
   aktualizacji żyją godzinami; nowe reguły muszą działać na pustym stanie —
   zasada zapisana na stałe w procesie weryfikacji.

## 5. Znane granice (świadome, nie luki)

- **<40 s do dolotu** przy PÓŹNYM wykryciu: tylko alarm — formularz floty
  fizycznie nie zdąży. Przy żywej karcie wykrycie na pilnowanej parze trwa
  1 tick (20 s), a dolot w układzie to minuty — margines duży (bojowo: 9 min).
- **Drugi ratunek z tej samej pary** przy trwającym locie: bot nie wyśle
  (nadpisałby zawrót pierwszego) — daje precyzyjny push z zegarem lądowań.
- **Ślepy alarm** (kolonie, których listy fork nie pokazuje): broni FLOTY
  (największy hangar), nie kolonii — cel obcych lotów jest niepoznawalny.
- **Ślepy alarm ma 60 s zwłoki** (trwałość nadwyżki) — cena za odporność na
  artefakty paska.

## 6. Rekomendacje (poza kodem)

1. Karta z grą stale widoczna / komputer nie śpi — to dziś JEDYNY pojedynczy
   punkt awarii całej obrony.
2. Dzwonki w iPhone włączone nocą (ntfy nie przebije trybu cichego).
3. Przy >1 kolonii z realną flotą: rezerwa slotów 2.
4. Raz na kilka dni: przycisk „Test" w panelu (pełny cykl alarmu na sucho).
