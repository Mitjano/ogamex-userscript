# AUDYT wdrożenia v3.56.0 — złom po ekspedycjach (PZ po piratach), 2026-09-01

Zlecenie ownera: sprawdzić, czy port mechanizmu z Atheny (DebrisCollector 2.48–2.99)
na Genesis został wdrożony poprawnie. Audyt = prześledzenie CAŁEJ ścieżki w kodzie
(tick → nawigacja → Fly krok 1/2/3 → domknięcie) + wykonanie jej na atrapie gry.

## Werdykt: wdrożone POPRAWNIE, luka zamknięta scenariuszem E2E 39

Do audytu ścieżka złomu miała tylko regexy w `test3-decide.js` (sekcja 24) — flaga
`this.debris` w atrapie E2E była MARTWA (żaden scenariusz jej nie używał), więc kod
nigdy nie był WYKONANY w teście. Nowy **scenariusz 39** odtwarza dokładnie przypadek
ownera: ekspedycje przypięte do [1:217:6], operator gra na [1:100:5], PZ na [1:217:16]
→ bot zagląda do układu 1:217 (nie 1:100), przełącza się na księżyc bazy ekspedycyjnej,
wysyła CAŁY hangar recyklerów (i nic poza nimi) misją Collect na cel typu „złom",
a lot nie trafia do `flights` (nie zablokuje ratunku). 6/6 sprawdzeń OK.

## Co zweryfikowano w kodzie (v3.56.0)

1. **Wersje spójne**: `@version 3.56.0` = `const VERSION` (pierwszy przebieg baterii
   złapał rozjazd — naprawione przed wypchnięciem).
2. **Klucz układu**: `Debris.tick` bierze `CFG.expo.launchFrom ?? aktywna para` —
   ten sam wzorzec co `Expo` (1495) i `Aster` (1821); recyklery liczone z hangaru
   TEGO klucza (księżyc przed planetą), `fromBody` spójny z wyborem hangaru.
3. **Migracja**: `migr_debris_on_v356` po definicji `saveCfg` (Store dostępny),
   jednorazowa — ręczne wyłączenie w panelu po migracji NIE zostanie cofnięte;
   świeże instalacje mają `enabled: true` w DEFAULTS (jak `collectDebris` 2.x).
4. **Strażnicy tick**: alarm z dolotem w przyszłości blokuje; `Human.economyAllowed`
   (przerwy/noc/operator gra — zwraca POWÓD, nie bool: warunek `if (…) return false`
   jest poprawny); `Fly.blocked` (karencja trasy po abortcie); bramka `everyMin`;
   trwająca misja Fly blokuje.
5. **Fly krok po kroku dla `kind:"debris"`**: switch na ciało startu (z zapisem
   `eco_return` — operator wraca na swoją stronę) → plan clampowany do ŻYWEGO stanu
   hangaru (`Math.min(want, have)` + odczyt zwrotny pól, stale-plan = cichy abort)
   → krok 2: koordy + `data-planet-type=3` → krok 3: misja **jawnie** COLLECT/HARVEST/
   RECYCL albo abort BEZ wysyłki (zasada 2.x v2.68.1) → potwierdzenie
   `fleetSendSuccessfully`/pusty hangar → rejestr powrotów (`expected`, 2×flightMs)
   → lot NIE w `flights` → anty-duplikat okno 20 s (ekonomia), sufit 6 nawigacji.
6. **Świeżość hangaru bazy ekspedycyjnej**: rekonesans v3.21.0 przy ustawionym
   `launchFrom` pilnuje WYŁĄCZNIE tego ciała → warunek „znany hangar" jest w praktyce
   spełniony inną drogą niż lekcja 2.x v2.99.3 (null ≠ zero), ale spełniony.

## Świadome granice (te same co na Athenie — nie wady wdrożenia)

- Recyklery muszą stać na ciele startu ekspedycji; gdy księżyc ma flotę, a recyklery
  stoją na PLANECIE pary, `hangars[moon] || hangars[planet]` bierze księżyc i planeta
  nie jest widziana. Na koncie ownera recyklery mieszkają z flotą (wykluczone
  z ekspedycji) — bez znaczenia w praktyce.
- Po nawigacji na galaktykę wysyłka rusza po ~60 s (bramka ponowienia `debris_at`);
  jeśli w tym oknie coś innego przestawi stronę, próba wraca za chwilę.
- Zbierane jest pole na poz. 16 i na POZYCJI bazy ekspedycyjnej; złom po bitwie przy
  innej kolonii wymaga ręcznego zbioru (identycznie 2.x).

## Niesprawdzone na żywo

Pierwszy realny lot po złom na Genesis: selektory `.col-debris`/tooltip
`rel^=debris`/`.mission-item COLLECT` przeniesione z 2.x, gdzie były potwierdzone
bojowo (zrzut 4.08 22:12) — ale to fork, więc przy pierwszym PZ sprawdzić linię
`[ZŁOM]` w logu; przy braku linku zbierania poleci zrzut markupu (`debris_dom`).

Bateria po zmianach: `node test3-all.js` → exit 0, 528 OK (decide 24 z 2 nowymi
regexami + E2E sc. 39 + panel + składnia).
