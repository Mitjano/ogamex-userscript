# Audyt 2: obrona hubów — atakujący vs obrońca (27.08.2026, v2.106.2)

Uzupełnia `AUDYT-HUBY-2026-08-27.md`. Pytanie: czy obrona i przenoszenie floty zadziałają na KAŻDYM księżycu, z którego lecą ekspedycje i mining? Odpowiedź dziś: **nie** — działają w pełni tylko dla pary, na której stoi przeglądarka / która jest strzeżona. Poniżej ścieżki ataku, odpowiedź obrony i co trzeba zmienić w planie.

## 1. Liczby, które rządzą obroną (z kodu)
- Pętla obrony: co 30 s; co 10 s gdy kandydat/alarm/GOTOWOŚĆ (sonda 5 min, obca flota 10 min). GOTOWOŚĆ zmienia TYLKO tempo pętli — nie zatrzymuje miningu/ekspedycji, nie przygotowuje ciała ani bramy.
- Potwierdzenie: 25 s (lista) / 12 s (sam pasek) / 0 s BLITZ (ETA<120 s, ale tylko gdy lista SKLASYFIKOWAŁA wiersz — ataki z własnego układu lista gubi → BLITZ nie działa, płacimy 12 s).
- Ratunek pary AKTYWNEJ, flota na księżycu, atak na księżyc: brama ≈ 25–40 s; Deploy na planetę: 2 przeładowania + formularz ≈ 25–40 s po potwierdzeniu.
- **Ratunek hubu NIEAKTYWNEGO (atak na jego księżyc): 4–5 przeładowań, ≈ 55–100 s od pierwszego zobaczenia.** Powód: `switchTo` klika TYLKO `a.planet-select` → lądujemy na PLANECIE hubu; `run()` odmawia „nie wysyłam NA księżyc, bo atakowany” (zmarnowany tick), następny tick uzbraja straż „bezpieczna strona” z błędnym ciałem i dopiero weryfikacja hangaru przenosi flotę księżyc→planeta. **Brama jest dla hubu nieaktywnego STRUKTURALNIE nieosiągalna** (`currentBody()==="moon"` nigdy nie zachodzi po `switchTo`; ratunki z kolejki mają `queued` → brama wyłączona).
- Sesja wylogowana: 15 min ślepoty BEZ samonaprawy (bot celowo nie nawiguje). Keepalive siedzi ZA bramką przerw/nocy → w przerwie kawowej i w nocy nie ma keepalive → to jest droga do wylogowania.
- Przerwa kawowa 5–15 min co 35–65 min: obrona DZIAŁA (ratunek/straż/powietrze/FS chodzą, `emergencyOnly` wyłącza tylko naukę), ale skaner może stać na galaktyce bez paska; cache paska 3 min; samonaprawa nawigacją 3–5 min.
- Lider kart: przejęcie po zamknięciu ≤3 min; karta w tle przejmowana przez widoczną po 20 s; zdławiona karta lidera = ticki 45 s–5 min bez przejęcia.
- Zamiatanie wracających fal: TYLKO para strzeżona, co 20/45/90 s, cap 40 zapisów na alarm.

## 2. Mining jako hub
- Minery startują z `HomeBase.mining()` (launchFrom albo ciało aktywne) i wracają tam, skąd wyleciały. Rejestr `MiningFlights` i `ogamex_fleet_return_at` NIE znają ciała startu → przy kilku hubach jeden zegar/rejestr na wszystkie (ekonomiczna dziura, nie militarna).
- Ratunek/powietrze/prom biorą WSZYSTKO, minery też. FS wyklucza minery gdy mining włączony → **w nocy minery zostają na księżycu = cel dla Destroy**, a to 27 mld statków. Gdy mining OFF, minery lecą z FS.
- Minery wracające na hub pod atakiem: zamiatane tylko, jeśli to para strzeżona. Hub miningu MUSI być w zbiorze strzeżonych.
- Po zniszczeniu księżyca hubu miningu bot cicho przechodzi na start z planety („falanga widzi ten lot”) — mining się samoleczy, ale traci osłonę; nikt nie sprawdza `launchFrom`.

## 3. Czerwona drużyna — ścieżki ataku na układ 3 hubów
A1. **Blitz w hub, na którym NIE stoi przeglądarka.** 55–100 s reakcji → ETA 60–90 s z sąsiedniego układu trafia. Napastnik [5:126:4] jest o 1 układ od bazy. *Obrona dziś: przegrana.*
A2. **Atak z własnego układu** (lista ruchów go gubi): brak BLITZ, cel nieznany → bot broni `fleetHome()`; przy 3 wyrównanych hubach werdykt = null → broni pola „Start ekspedycji” = jeden hub, pozostałe stoją. Dokładny kształt straty z 12.08. *Huby to POGARSZAJĄ.*
A3. **Dwa huby w jednym ticku.** Pierwszy przebieg bierze `targets[0]`; drugi hub czeka tick i idzie kolejką: bez bramy, bez zamiatania, bez eskalacji „oba ciała”, zablokowany gdy powietrze zajęte.
A4. **Wypalenie bramy fintą.** Sonda + mały atak na hub A → bot skacze bramą (cooldown 30–40 min na A **i na księżycu docelowym**). Prawdziwe uderzenie 5 min później w hub B (albo w cel skoku) → brama niedostępna → Deploy 81 s na planetę → planeta widoczna w falandze → snajperka 1 s po lądowaniu. Jeśli celem skoków są inne huby, jedna finta rozbraja dwie bramy naraz.
A5. **Destroy + snajperka powrotów** (to, co robią teraz): zniszczyć księżyc hubu, fale/minery wracają na planetę o znanej sekundzie. Z 3 hubami koszt ×3, ale każda fala na nieustrzeżonym hubie i tak nie jest zamiatana → oni dostają 1/N floty za każdą zniszczoną parę.
A6. **Atak w planetę-refugium 81 s po ratunku.** Deploy księżyc→planeta ma znany czas; atak w planetę wysłany tak, by wylądować ~90 s po skoku. Bot ma skok zwrotny (body-aware swap) — 90 s `MIN_RESAVE_MS` + formularz ≈ na styk.
A7. **Okno potwierdzenia jako wabik.** W 12–25 s przed alarmem `DefenceHold` nie działa: skaner może odjechać na galaktykę (brak paska), fala ekspedycji zająć `pending_mission` — kolejny odczyt ślepy, ratunek musi wywłaszczać.
A8. **Zegar operatora.** Przerwy kawowe co 35–65 min + noc: keepalive wyłączony → wylogowanie → 15 min pełnej ślepoty. Napastnik nie zna momentu, ale gra na statystykę (sonduje co minutę — widać w logu 18:46–18:54: 9 sond).
A9. **Rój sond + Type:Spy.** Od 2.105.5 sondy nie ruszają flotą. Ale sonda za sondą maskuje w pasku typ „najbliższego lotu” — atak z własnego układu + sonda przed nim = pasek pokazuje Spy → bot NIE alarmuje z nadwyżki paska. (Świadome ryzyko z 26.08; przy hubach rośnie.)

## 4. Niebieska drużyna — zasady, które wygrywają
Z1. **Flota w locie > na księżycu > na planecie.** Każda decyzja ma prowadzić w lewo tej listy. Planeta tylko jako ostatnia deska.
Z2. **Bramy hubów są zasobem obronnym — nie zużywać ich na cele skoków.** Konfiguracja: 1–2 **księżyce-schrony** (nie huby, z bramą, daleko od [5:126]) jako WYŁĄCZNE cele skoków. Finta w A wypala A+schron, huby B/C zostają naładowane. Powrót ze schronu Deployem (księżyc→księżyc, niewidoczny) albo bramą po cooldownie.
Z3. **Cel nieznany = broń WSZYSTKICH hubów**, nie jednego. Ślepy alarm (pasek widzi, lista nie): kolejno huby wg wielkości hangaru (`ogamex_hangar_map` już to ma). Koszt: kilka formularzy. Zysk: zamyka A2.
Z4. **Hub nieaktywny musi mieć tę samą ścieżkę co aktywny.** `switchTo` ma klikać księżyc pary, gdy flota stoi na księżycu (mapa hangarów/`ogamex_atk_body_*`); brama dostępna dla ratunków z kolejki; brak odmowy „na księżyc, bo atakowany” gdy flota STOI na tym księżycu.
Z5. **Straż per para** (mapa), zamiatanie per para, `DefenceHold` per para, licznik zapisów per para. Bez tego hub #2 to kolonia bez obrony.
Z6. **GOTOWOŚĆ ma coś robić**: po sondzie na hub — zamrozić rutynę na TYM hubie (bez nawigacji na galaktykę), prewencyjnie ustawić aktywne ciało na księżyc hubu z największym hangarem, jeśli nic nie jest w toku. To skraca reakcję z 55–100 s do 25–40 s bez ruszania floty.
Z7. **Keepalive zawsze** (także w przerwie i nocy) — inaczej A8. Sesja padła → jedna próba nawigacji na `/` po 2 min, nie 15 min ciszy.
Z8. **Noc = wszystko w powietrzu**, minery też (FS z minerami, gdy mining śpi w oknie nocnym).
Z9. **Huby daleko od napastnika** (inna galaktyka/ ≥100 układów od [5:126]) — GŚ lecą godziny, blitzy słabną; falanga widzi tylko planety, więc odległość liczy się dla ataków flotą.
Z10. **Fale mniejsze** (1/28) — ogranicza A5 do ~3,5 % na zniszczoną parę.

## 5. Korekta planu (Etap A rozszerzony — to jest warunek hubów)
1. Straż jako mapa po parze + zamiatanie/licznik/DefenceHold per para (jak w audycie 1).
2. `switchTo` → księżyc pary, gdy tam stoi flota; ratunek nie odmawia ruchu z ciała, na którym stoi flota; brama dla ratunków z kolejki i po `switchTo`.
3. Ślepy alarm → wszystkie huby wg hangaru (Z3).
4. Cele skoków tylko ze zbioru schronów (config `jumpGate.havens[]`); powrót ze schronu Deployem/bramą.
5. AirSave: refugium wyklucza atakowane pary; stan powietrza per para (2 loty naraz).
6. GOTOWOŚĆ: hold rutyny na hubie + prewencyjne ciało aktywne (Z6).
7. Keepalive poza bramkami przerw/nocy; wylogowanie → próba `/` po 2 min.
8. Wszystkie `ev.targets` w pierwszym przebiegu.
9. FS nocny z minerami (opcja); `MiningFlights` z ciałem startu.
10. Testy: symulator ataku musi umieć celować w hub nieaktywny (`ogamex_threat_sim_target` per hub) — bez tego nie da się sprawdzić punktu 2 offline.

Kolejność bez zmian: A (obrona) → B (rotacja) → C (FS per hub). Rotacja ekspedycji PRZED punktami 1–4 daje napastnikowi więcej celów bez obrony — nie robić.

## 6. Co zrobić już dziś, bez hubów (dotyczy obecnej bazy)
- Schron dla skoków (Z2) i havens w configu — nawet z jednym hubem finta wypala bramę bazy i cel.
- Keepalive w przerwach (Z7) — samodzielna dziura, niezależna od hubów.
- `switchTo` na księżyc (Z4) — dziś każda kolonia poza aktywną ma 55–100 s reakcji.
