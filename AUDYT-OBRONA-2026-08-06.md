# Audyt obrony floty — 2026-08-06 (po zmianach v2.75.0–v2.75.2)

Cel: potwierdzić, że po zmianach pod event (farm/FS z aktualnego ciała, ratunek
na każdej kolonii) bot chroni flotę w KAŻDYM scenariuszu co najmniej tak dobrze
jak dotychczas. Przegląd kodu ścieżka po ścieżce; odniesienia do żywego
incydentu z 21:05–21:10 (atak 120 mld BS z [3:248:11] na księżyc bazy — obrona
zadziałała, zero strat).

## Macierz scenariuszy (MoonSave / ratunek)

| # | Atak na | Flota na | Aktywne ciało w chwili alarmu | Zachowanie po v2.75.1 | Ocena |
|---|---------|----------|-------------------------------|------------------------|-------|
| A | księżyc bazy | księżycu bazy | księżyc bazy (tryb księżycowy, typowe) | run() bezpośrednio: Deploy księżyc→planeta, wszystko | jak dotychczas ✅ |
| B | księżyc bazy | księżycu bazy | INNA kolonia | switchTo(baza) → flip na atakowane ciało → Deploy księżyc→planeta | **LEPIEJ**: stary strażnik v2.70.0 porównywał ciało AKTYWNEJ (obcej!) kolonii z celem ataku i przy nieszczęśliwym układzie **blokował ratunek bazy**. 06.08 21:06 przeszło tylko dlatego, że aktywne ciało przypadkiem też było księżycem. Naprawione ✅ |
| C | księżyc kolonii | księżycu kolonii | ta kolonia | jak A, na kolonii (v2.55.0) | jak dotychczas ✅ |
| D | księżyc kolonii | księżycu kolonii | gdzie indziej | switchTo(kolonia) → **nowy flip v2.75.1** od razu na atakowane ciało → Deploy | szybciej o 1 nawigację (poprzednio: odkrycie pustego hangaru planety) ✅ |
| E | planeta (rajd po surowce) | księżycu | atakowana para | strażnik bezpiecznej strony: flota NIE rusza się (ruch = pod uderzenie) | rozszerzone z bazy na każdą kolonię ✅ |
| F | planeta | księżycu | gdzie indziej | switch → aktywna=planeta=cel ataku → hangar pusty → flip ZABLOKOWANY (v2.70.3: flip nie może celować w atakowane ciało) → abort, flota zostaje na księżycu | poprawnie ✅ |
| G | cel-ciało nieznane (brak ikony) | dowolnie | dowolnie | stare zachowanie v2.28: ucieczka na przeciwne ciało względem floty (flip przy pustym hangarze bez zmian) | jak dotychczas ✅ |
| H | fale wielokrotne | — | — | sweeps wyłączone z obu flipów (`mission.sweep`), licznik `saves<=1` | jak dotychczas ✅ |
| I | powrót po alarmie | — | — | `moonReturn` wyłączony z obu flipów; homeBody/refugeBody przy flipie ustawiane tak, że powrót odstawia flotę na ciało, na którym mieszkała | jak dotychczas ✅ (żywy dowód 21:09:52) |
| J | kolonii nie ma na liście planet | — | — | switchTo: głośny błąd, flota NIETKNIĘTA, reakcja ręczna | jak dotychczas ✅ |

## Interakcje modułów przy alarmie

- **Farm** (v2.74.8, start z aktualnego ciała): przy obcej flocie w pasku misji
  farmienie wstrzymane (`Farming on hold`), ratunek wywłaszcza pending_mission
  (v2.36.0). Bez zmian. ✅
- **FS** (v2.75.0+): tick ustępuje alarmowi (`ThreatMonitor.active() ||
  MoonSave.watch().armed` → return) — FS nie zabiera floty spod ręki ratunku. ✅
- **Ekspedycje/mining**: wywłaszczane przez ratunek jak dotychczas. ✅
- **Pętla obrony**: co 30 s, niezależna od schedulera i okna nocnego. Bez zmian. ✅

## FS — zmiany pod event i ich bezpieczeństwo

- Start z aktualnie aktywnego KSIĘŻYCA; z planety nigdy (falanga) — tick czeka
  i ostrzega co 10 min.
- Czas lotu kluczowany po faktycznej pozycji startu (`originCoords()` — odczyt
  koordów z wiersza listy planet, ta sama metoda co potwierdzony na żywo
  `MoonSave.activeCoords`; v2.75.2 zastąpiła zawodny `getCurrentPlanet`,
  który na tym forku dawał „planet ?"). Po teleporcie → świeży pomiar trasy.
- Ostatnia linia obrony bez zmian: bramka 2T na kroku 2 liczy na czasie lotu
  odczytanym NA ŻYWO z formularza — nawet ze złym cache zawrócenie nigdy nie
  wypadnie po dolocie (wysyłka zostaje odrzucona zamiast ryzykować).
- Nieudane zawrócenie = stacjonowanie na WŁASNYM księżycu-celu (bezpieczna
  porażka, jak dotychczas).

## Znane ograniczenia (bez zmian vs stan sprzed eventu)

1. Dwa RÓWNOCZESNE ataki na różne kolonie: ratunek obsługuje pierwszy cel
   z listy; drugi wymaga reakcji po zamknięciu pierwszego cyklu.
2. Cel FS (`to`) jest jeden, stały z panelu — po teleporcie daleko od celu lot
   się wydłuża (to bezpieczne, ale runda FS trwa dłużej). W razie potrzeby
   przestawić „Cel" w panelu.
3. Ratunek wymaga widocznej listy planet (jest na każdej stronie gry poza
   nielicznymi widokami — wtedy bot sam przechodzi na Overview).

---

# Audyt pełny — 2026-08-06 wieczór (v2.75.3)

Zlecenie właściciela: „mam bardzo dużo agresywnych sąsiadów i nie mogę sobie
pozwolić na faila — sprawdź, czy bot w każdym przypadku ochroni flotę".
Przegląd WSZYSTKICH ścieżek dotykających floty: ThreatMonitor (detekcja),
FleetMovements (parser), MoonSave (ratunek/straż/powrót), FleetSave, maszyna
pending_mission, pętla obrony, TabLock, handlery fleetSendSuccessfully.

## ZNALEZIONE I NAPRAWIONE w v2.75.3

1. **KRYTYCZNE (regres v2.75.0): zawracanie FS nie znalazłoby lotu z nowego
   księżyca.** `_findOurRow` rozpoznawał nasz lot po `config.from` (dawna
   baza) + `config.to`. Po zmianie „FS z aktualnego księżyca" lot startuje
   z innych koordów, więc wiersz nie pasowałby do wzorca: maszyna uznałaby
   lot za „zawrócony ręcznie" i zamknęła cykl, a flota poleciałaby na cel
   i tam stacjonowała (bezpieczna porażka, ale FS martwy). Naprawa: koordy
   startu są STEMPLOWANE w stanie FS przy wysyłce (`from` w markLaunched)
   i wiersz szuka się po nich; stare stany bez stempla używają configu jak
   dotąd.
2. **NISKIE: własny lot „Collect" (złom tego forka) mógł podnieść alarm.**
   Typ COLLECT nie był na żadnej liście (ATTACK/SPY/SAFE), więc przy
   chwilowo pustym `ownBodies()` klasyfikował się jako „typ spoza znanych
   list = atak". Dodany do SAFE — obcy lot COLLECT i tak nie może uderzyć
   we flotę.

## SPRAWDZONE I ZDROWE (bez zmian)

- **Detekcja**: lista ruchów flot z klasyfikacją po ŹRÓDLE (własna wysyłka
  nie wychodzi jako obca), kontrola krzyżowa z paskiem misji (rozbieżność =
  głośna degradacja do paska), nieznany typ misji = atak (bezpieczny błąd),
  kandydat 25 s + BLITZ <2 min bez czekania, alarm zdejmowany WYŁĄCZNIE
  potwierdzonym „zero obcych" (nie upływem czasu), backstop 3 h.
- **Tryb obserwatora**: detekcja+dziennik+push działają też przy bocie OFF;
  aktuatory za bramką CONFIG.enabled.
- **Ratunek**: wywłaszcza pending_mission, własna pętla 30 s odporna na
  jitter/przerwy/okno nocne, limit zapisów na alarm, bezpiecznik straży 1 h,
  powrót czeka 130 s na lądowanie ratunku (wyścig z 6.08 12:32 zamknięty),
  flip nigdy nie celuje w atakowane ciało, po v2.75.1 strażnik bezpiecznej
  strony na każdej kolonii i tylko przy miarodajnym odczycie.
- **FS**: bramka 2T na kroku 2 liczy na czasie lotu odczytanym NA ŻYWO
  z formularza — zła pamięć trasy nie może dać zawrócenia po dolocie
  (wysyłka zostaje odrzucona); wykrywanie ręcznego zawrócenia; porażka
  zawracania = stacjonowanie na własnym księżycu; tick ustępuje alarmowi.
- **Farm przy pustym ciele**: pauza 10 min zamiast palenia kolejki celów.
- **fleetSendSuccessfully**: każda odmiana wysyłki (ratunek/powrót/prom/
  ekspedycja/FS/złom/farm/mining) ma własną gałąź księgowania — bez
  krzyżowego zatruwania liczników.

## ZNANE OGRANICZENIA (świadome, do zapamiętania)

1. Zmiana karty-lidera po padzie poprzedniej: do ~3,5 min bez detekcji
   i ratunku (STALE_MS 3 min + tick 30 s). Nie otwierać wielu kart bez
   potrzeby.
2. FS wysyła to, co stoi na AKTYWNYM księżycu w chwili startu rundy — po
   powrocie rundy flota jest tam, skąd wystartowała; przełączenie się na
   inny księżyc = następna runda weźmie TAMTEJSZY hangar.
3. Dwa równoczesne ataki na różne kolonie: ratunek pierwszej, druga ręcznie.
4. Atak rozdzielony planeta+księżyc tej samej pary jest niedodgowalny skokiem
   ciał (ograniczenie gry) — na to jest FS w powietrzu.
5. `getCurrentPlanet()` bywa ślepy na tym forku („planet ?") — wszystko
   krytyczne czyta koordy z wiersza listy planet (activeCoords/originCoords).
