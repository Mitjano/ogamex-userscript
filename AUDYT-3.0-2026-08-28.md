# AUDYT: przepisać bota na 3.0 czy dostosować 2.x do nowego uni Genesis? (28.08.2026)

Kontekst: Athena w trybie urlopowym; nowe uniwersum **Genesis** startuje 28.08 10:18. Bot v2.111.7, 16 479 linii, jeden plik.

## 1. Twarde liczby (stan repo 28.08)
| metryka | wartość | komentarz |
|---|---|---|
| linie kodu | 16 479 | w tym **4 713 linii komentarzy** (29 %) — kronika incydentów w kodzie |
| moduły (`const X = {`) | ~45 | największe: ThreatMonitor ~1 300, MoonSave ~1 200, AsteroidMiner ~700, AirSave ~530, FleetSave ~470 |
| funkcje luzem | `handlePendingMission` ~2 200 linii, `createUI` ~1 450 | maszyna misji = jeden switch na 11 typów |
| typy `pending_mission` | 11 | air_save, asteroid_mining, debris, expedition, fleet_save, gate_jump, farm, moon_ferry, moon_form, moon_return, moon_save |
| klucze stanu `ogamex_*` w GM | **193** | stan rozproszony, bez jednego źródła prawdy o flocie |
| znaczniki wersji w komentarzach | 287 (v2.x) | 342 commity, **85 w ostatnich 8 dniach** |
| testy offline | 24 pliki / 369 asercji | po SYGNATURACH i regexach na źródle — kruche, nie testują zachowania maszyny stanów |
| izolacja uni | klucze GM prefiksowane hostem (`HOST:klucz`), `@match *.ogamex.net` | Genesis dostanie czysty stan automatycznie |

## 2. Gdzie bot naprawdę się „gubi" (dowody z 27.08)
Wszystkie dzisiejsze awarie to **stan**, nie parsowanie:
1. Stan ucieczki w powietrze wisiał 3× (recalled/recall_failed) i blokował symulację i ratunek — bo zamykał go zegar, nie hangar (2.111.2/2.111.4).
2. Druga ucieczka nadpisała pierwszą — **jeden globalny stan** AirSave na 30 kolonii (2.110.2 = tylko blokada).
3. Straż z symulacji (dom = planeta) przeżyła do prawdziwego ataku → auto-powrót przeniósł 1,5 bln floty na planetę 3 s przed uderzeniem (2.111.5/2.111.6).
4. Zamiatanie z jednej straży przeniosło flotę **na atakowany księżyc** (12:44) — dwie warstwy (straż, ratunek) nie dzielą jednej prawdy o tym, gdzie stoi flota i co jest atakowane.
5. Brama: zapisany config nadpisał domyślny (2.108.3), skok bez surowców (2.107.4), `pageTxt` poza zakresem (2.107.9) — każda poprawka to łata w 16k-liniowym pliku bez typów i bez testów zachowania.
6. Trzy źródła prawdy o wrogach (lista ruchów = tylko aktywna para, pasek = licznik, Events = globalny) sklejane heurystykami z 20 wersji.

Parsery natomiast są **sprawdzone bojowo** i warte zachowania: `FleetMovements.classifyRow` (+ACS), `EventsPanel`, `FleetRecon.scan`, 3-krokowy formularz floty (`FleetDispatcher`/`handlePendingMission` kroki select→destination→mission), `HomeBase` (pasek planet), parser bramy, `Humanizer/AntiDetection`, push ntfy.

## 3. Co Genesis zmienia
Nowe uni = **wczesna gra**: brak księżyców, brak bramy, brak falangi u wrogów, małe floty, ekonomia (kolonizacja, budynki, badania) ważniejsza niż obrona. Cała warstwa księżycowa (MoonSave/AirSave/GateSave/MoonRebuild/MoonFerry ≈ 3 000 linii) jest przez pierwsze tygodnie martwa. Obrona wczesnej gry = fleet save Deployem/ekspedycją na noc + surowce w budynkach. Bot v2 ma z tego: ekspedycje, mining asteroid, farmienie nieaktywnych, FS. **Nie ma**: kolejki budynków/badań, kolonizacji, handlu — to byłby nowy zakres.

## 4. Opcje
**A. Zostawić 2.x, dostosować do Genesis.** Zero pracy na start (host-prefix, @match). Ale każda następna funkcja to kolejna łata; dzisiejsze 7 awarii stanu wrócą przy pierwszym księżycu na Genesis.

**B. Przepisać wszystko od zera („3.0 big bang").** 16k linii → realnie 3–5k, ale 4–8 tygodni bez bota, i utrata 287 lekcji ukrytych w komentarzach (fork .NET: markupy, odstępstwa). Ryzyko: powtórzenie tych samych incydentów.

**C. 3.0 jako „dusiciel" (rekomendacja).** Nowy plik `ogamex-3.user.js` dla Genesis, budowany modułowo, w którym **przenosimy sprawdzone parsery 1:1**, a **przepisujemy tylko to, co się gubi**: stan i decyzje. Athena zostaje na 2.x (urlop). Rdzeń 3.0:
- `Situation` — jedno źródło prawdy: per para {ciało floty, hangar (odczyt+czas), zagrożenia z Events (cel, ciało, ETA, źródło), własne loty (Events), straż}. Zapis = jeden klucz JSON, nie 193.
- `decide(situation) → plan` — **czysta funkcja** (bez DOM, bez GM): dla każdej pary: nic / zamieć / uciekaj (sąsiad-księżyc, planeta, powietrze) / zawróć / wróć do domu. Testowana macierzą scenariuszy (dzisiejsze incydenty = pierwsze przypadki testowe).
- `execute(plan)` — jedna maszyna misji (dziś 11 typów w 2 200-liniowym switchu) sprowadzona do 1 typu „lot" + 1 „brama" z parametrami.
- Reguły twarde jako dane: dom = księżyc gdy jest; rezerwa deuteru; jedna ucieczka per para; stan zamykany hangarem, nie zegarem.
- Etapy: (1) szkielet + parsery + Situation + panel [tydzień], (2) ekonomia wczesnej gry: ekspedycje/FS/mining/farm [tydzień], (3) obrona księżycowa, gdy Genesis dojdzie do księżyców [2 tygodnie], (4) moduły nowe (kolejka budynków, kolonizacja) — osobna decyzja.

## 5. Ryzyka C i jak je zbijamy
- Dwa boty na jednym koncie/przeglądarce → `@match` per host (2.x tylko athena, 3.0 tylko genesis).
- Fork .NET na Genesis może mieć inny markup → 3.0 od pierwszego dnia z trybem „zrzuć DOM, nie zgaduj" (jak 2.x).
- Utrata wiedzy z komentarzy → sekcja „LEKCJE FORKA" w docs, wyciągnięta z 2.x przed startem (endpointy, klasy wierszy, ACS, brama, cooldowny, jitter).

## 6. Decyzje operatora (potrzebne przed startem 3.0)
1. Host Genesis (adres) — do `@match` i prefiksu stanu.
2. Zakres etapu 1–2: tylko to, co 2.x umie (ekspedycje/FS/mining/farm/obrona), czy od razu ekonomia (kolejka budynków/badań, kolonizacja)?
3. Czy Athena ma zostać pod 2.x w urlopie (bot OFF), czy wyłączamy tam skrypt całkiem?
4. Budżet czasu: 3.0 etap 1 = ~tydzień pracy zanim przewyższy 2.x w czymkolwiek.
