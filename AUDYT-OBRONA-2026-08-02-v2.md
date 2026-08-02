# Audyt obrony floty — 2 sierpnia 2026, wieczór (v2.53.0)

Powód: od poprzedniego audytu (v2.35.0, rano) wyszło **osiemnaście wersji**.
Zmieniło się źródło wykrywania zagrożenia, wykryto i cofnięto błąd, który
wyprowadzałby flotę z bezpiecznego miejsca, a połowa dorobionego kodu okazała
się martwa. Audyt ustala, co jest udowodnione, co jest tylko zaimplementowane
i co grozi.

## Czego oczekuje właściciel

1. Flota na `3:269:8` (planeta lub księżyc) ma być bezpieczna — priorytet.
2. Atak → przeniesienie floty i surowców na drugie ciało; po ustaniu — powrót.
3. Sondy NIE mają ruszać floty.
4. Ochrona ma działać w nocy (23:00–05:00).
5. Dziennik ataków ma przetrwać noc i powiedzieć rano, co się działo.
6. Mining to główny dochód i nie może stać.

---

## CO JEST UDOWODNIONE NA ŻYWO

| Rzecz | Dowód |
|---|---|
| Ewakuacja bazy planeta↔księżyc | ratunek 09:24, powrót 09:26 (dziennik) |
| Pętla obrony niezależna od przerw, jitteru i snu | odczyty co 30 s w logu także w trakcie 13-minutowej przerwy |
| Odczyt paska misji wykrył 6 obcych flot | 12:18:09, potwierdzanie zadziałało, flota NIE była ruszana |
| Dziennik 12 h z podsumowaniem | `[OBRONA] Ostatnie 12 h: 1 alarm(ów), 1× powrót` |
| Mining: własny licznik lotów | `0/3 flights — parallel keeps scanning` po migracji |
| Gwiazda Śmierci poza falami | skład fal bez `DEATH_STAR` mimo 1 szt. w hangarze |
| Zbieranie złomu: wizyta na bazie | `[ZŁOM] zaglądam na galaktykę bazy [3:269]` |

## KRYTYCZNE 1 — chroniona jest WYŁĄCZNIE baza

`MoonSave` buduje adres CELU, a formularz floty wysyła z planety **aktywnej**.
Kroku „przełącz się na tę planetę" nie ma. v2.52.0 próbowała ewakuować
atakowaną kolonię i przez to wysłałaby flotę **z bazy** na księżyc tamtej
kolonii — czyli sama wyprowadziłaby ją z bezpiecznego miejsca. Cofnięte
w v2.52.1 (dziś, przed jakąkolwiek szkodą).

Skutek: 29 kolonii bez ochrony. Atak na nie jest wykrywany i opisany
w dzienniku, ale flota nie rusza.

**Naprawa:** dołożyć krok przełączenia planety. Mechanizm istnieje —
dyspozytor asteroid używa `switch_planet_then_fleet`. To osobna wersja
z własnym testem, nie doklejka.

## KRYTYCZNE 2 — nowe źródło wykrywania nie zostało sprawdzone na wrogu

v2.51.0 przeniosła wykrywanie z paska misji na `/home/fleetmovementlist`.
Parser przetestowałem na markupie **naszych własnych** wierszy — od wdrożenia
nikt na nas nie leciał. Jeśli ta lista zawiera wyłącznie floty gracza (a tak
bywa w wielu silnikach), to v2.51.0 nie poprawiła wykrywania, tylko **je
wyłączyła**: obcych zawsze zero, alarm nigdy nie wstaje.

**Naprawa (v2.53.0, zrobione):** kontrola krzyżowa. Gdy pasek misji widzi obce
floty, a lista ruchów żadnej, wygrywa pasek — mniej wie, ale wie na pewno.
Do dziennika trafia wtedy wpis `BŁĄD`, a w logu pojawia się ostrzeżenie.
To zamienia cichą ślepotę na głośną degradację.

**Do zrobienia:** przy pierwszym prawdziwym ataku sprawdzić w logu, czy wiersz
obcej floty w ogóle się pojawił i jak wygląda.

## KRYTYCZNE 3 — martwy kod udający funkcje

Serwer to aplikacja .NET; trasy z open-source'owego OGameX (Laravel) nie
istnieją. Potwierdzone 404: `eventbox`, `eventlist`, `check-target`.
Z tej samej rodziny, a więc niemal na pewno też martwe:

- `Phalanx.scanAttacker()` → `/ajax/phalanx/scan`
- `FleetApi.send()` → `/ajax/fleet/dispatch/send-fleet` (przełącznik „Wysyłka przez API")
- `FleetApi.recall()` → przycisk **„Odwołaj wysyłkę"**
- `GalaxyAjax` → `/ajax/galaxy` (oddaje stronę HTML)

Przycisk w panelu, który nigdy nie zadziała, jest gorszy niż jego brak: w
sytuacji, gdy będzie potrzebny, właściciel straci na niego czas.

**Rekomendacja:** usunąć te cztery ścieżki albo oznaczyć w panelu jako
niedostępne na tym serwerze. Zostawić wyłącznie `ApiSniffer` i `Test API`.

## WYSOKIE 4 — MoonSave: 413 linii, 64 punkty wyjścia

Dług z porannego audytu (wtedy 32 wyjścia) **urósł dwukrotnie**. Przy takiej
liczbie bramek każda nowa zapora ma dużą szansę zablokować istniejące wyjście —
dokładnie to zdarzyło się rano (v2.33 → v2.34 → v2.35). Dopóki to nie zostanie
sprowadzone do jednej maszyny stanu, każda zmiana w obronie jest ryzykowna.

## WYSOKIE 5 — sondy: poprawka zależy od KRYTYCZNE 2

„Sonda nie rusza flotą" działa tylko wtedy, gdy lista ruchów flot pokazuje
obce floty. Jeśli nie pokazuje, obrona wraca na pasek i sondy znów będą
ewakuować flotę. To nie jest błąd — to świadomy wybór bezpieczeństwa — ale
właściciel musi wiedzieć, że ta poprawka nie jest jeszcze potwierdzona.

## ŚREDNIE 6 — mining traci czas na „Scan stranded off galaxy page"

Wpis pojawia się po niemal każdej wysyłce ekspedycji: fala przejmuje nawigację
w środku przebiegu skanera, skaner się gubi i wraca. Kilkanaście sekund co
~70 s, czyli rząd 10–20% czasu skanowania — na głównym źródle dochodu.

## ŚREDNIE 7 — zbieranie złomu nigdy nie widziało złomu

Wizyta na galaktyce bazy działa, ale komórki z prawdziwym polem złomu jeszcze
nie było. Bot zrzuci jej markup do logu i **nie wyśle floty w nieznane** —
zachowanie jest bezpieczne, ale funkcja pozostaje niepotwierdzona.

## ŚREDNIE 8 — wspólny slot `pending_mission` (z porannego audytu, otwarte)

Cztery moduły dzielą jeden stan trzykrokowego formularza. Ratunek ma
wywłaszczenie, więc najgorszy skutek jest zdjęty, ale przyczyna została.

---

## Rekomendowana kolejność

1. **Potwierdzić KRYTYCZNE 2** przy pierwszym ataku (nic nie trzeba kodować —
   wystarczy przeczytać log i dziennik).
2. **Sprzątnąć martwy kod** (KRYTYCZNE 3) — pół godziny, usuwa fałszywe
   poczucie funkcji.
3. **Przełączanie planety** (KRYTYCZNE 1) — daje ochronę 29 koloniom.
4. **MoonSave na maszynę stanu** (WYSOKIE 4) — dopiero potem, bo to przepisanie.
5. Skaner vs ekspedycje (ŚREDNIE 6) — czysty zysk dla mininga.

## Czego NIE robić

Nie dorabiać kolejnych funkcji na endpointach z upstreamu bez potwierdzenia
jednego zapytania na żywo. Ta lekcja kosztowała dziś pięć wersji (2.40–2.44),
z których wszystkie trafiły do kosza.
