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
