# Endpointy OGameX — co bot może z nich wyciągnąć (2026-08-02)

Źródło: `routes/web.php` z open-source'owego OGameX (lanedirt/OGameX) plus
kontrolery. **Uwaga:** athena.ogamex.net to FORK — asteroidy, Galleon, Falcon,
Planet Bomber i Reaper nie istnieją w wersji upstream. Trasy bazowe fork
zachowuje (potwierdzone na `eventbox`/`eventlist`), ale każdy endpoint trzeba
sprawdzić na żywo, zanim się na nim oprzemy.

## WDROŻONE

### `/ajax/fleet/eventbox/fetch` → JSON `{hostile, neutral, friendly, eventTime}`
### `/ajax/fleet/eventlist/fetch` → HTML `<tr class="eventFleet" data-mission-type="N">`
Podstawa v2.40.0. Serwer klasyfikuje jako *hostile* typy misji 1, 2, 6, 9, 10 —
czyli szpiegowanie (6) też, dlatego sam licznik nie wystarcza i trzeba czytać
`data-mission-type` z listy.

---

## PRIORYTET 1 — `POST /ajax/galaxy`

```
POST /ajax/galaxy   { galaxy, system, _token }
→ JSON { success, system: { galaxyContent, availableProbes, availableRecyclers,
         canColonize, ... }, newAjaxToken, reservedPositions }
```

Skaner asteroid **nawiguje** dziś do `/galaxy?x=&y=` osobno dla każdego z 87
systemów: pełne przeładowanie strony, 3–6 s na system, plus stan „Scan stranded
off galaxy page. Resuming at …", który w logu z 2 sierpnia pojawia się co
kilkanaście linijek. Przez AJAX to jedno zapytanie na system, bez nawigacji
i bez gubienia stanu.

Skutek: pełny obieg 87 systemów spada z ~8 minut do ~1 minuty, a znalezione
asteroidy mają dłuższy zapas TTL (dziś regularnie odpadają na
`SKIP … would vanish before arrival`). To jest największe pojedyncze
usprawnienie dla głównego źródła dochodu.

Do zweryfikowania na żywo: czy fork zwraca w tym JSON-ie dane asteroidy
(`data-asteroid-disappear`, `btn-asteroid`), czy trzyma je tylko w HTML.

## PRIORYTET 2 — `GET /ajax/messages`

```
GET /ajax/messages?tab=fleets&subtab=<klucz>&pagination=1   → HTML listy
GET /ajax/messages/{messageId}?tab=&subtab=                 → HTML wiadomości
```

Dziś w logu leci `Yield fetch (page): unknown message markup — generic block
scan found 1 candidate(s)` — bot zgaduje strukturę wiadomości. Te dwa
endpointy dają listę i treść raportu wprost. Zyskuje na tym uczenie się
`cargoPerMiner` i `expectedResources`, czyli dobór liczby minerów na lot.

## PRIORYTET 3 — `POST /ajax/fleet/dispatch/send-fleet`

```
POST /ajax/fleet/dispatch/send-fleet
  token, galaxy, system, position, type, mission, speed, holdingtime,
  metal, crystal, deuterium, am202: N, am203: N, ...   (am + ID jednostki)
```

Zastępuje cały trzykrokowy taniec po DOM. Dziś jedna fala ekspedycji to 4
przeładowania strony i ~20 s, z ryzykiem błędów typu `Clicked "Next"
(A.btn-continue disabled)` → `Step 3 never loaded` (przepadła fala o 12:47).
Przez API to jedno żądanie, bez wyścigów o stan formularza.

Zastrzeżenie: to jest zmiana o największym zasięgu w całym bocie i dotyka
ścieżki, która rusza całą flotą. Wchodzić etapami — najpierw ekspedycje
(najczęstsze i najmniej groźne w razie pomyłki), mining i ratunek dopiero po
kilku dniach czystych logów. Tempo humanizera zostaje bez zmian: zysk ma iść
w niezawodność, nie w częstotliwość.

Mapowanie `am###` trzeba odczytać raz z formularza floty (fork ma własne
statki) i zapamiętać.

## PRIORYTET 4 — `POST /ajax/fleet/dispatch/check-target`

Walidacja celu bez otwierania formularza — prawdopodobnie zwraca czas lotu
i zużycie deuteru. Pozwoliłoby odrzucać asteroidy z za krótkim TTL **przed**
nawigacją, zamiast po wejściu w formularz.

## PRIORYTET 5 — `POST /ajax/phalanx/scan`

```
POST /ajax/phalanx/scan { galaxy, system, position }
```
Działa tylko z księżyca z Sensor Phalanx. Właściciel ma księżyce przy każdej
planecie. Wiersz zdarzenia daje nam ŹRÓDŁO ataku, więc bot mógłby przeskanować
planetę napastnika i zobaczyć skład floty — czyli dokładnie to, o co pytał
właściciel („sondy max 10 000 sztuk, atak to setki tysięcy"). Kosztuje deuter,
więc tylko przy potwierdzonym ataku.

## PRIORYTET 6 — `POST /ajax/fleet/dispatch/recall-fleet`

Odwołanie własnej floty w locie. Zastosowanie: atak wykryty, gdy minery są
w drodze — zamiast czekać na powrót pod uderzenie, ściągamy je od razu.

## PRIORYTET 7 — `GET/POST /ajax/fleet/templates`

Standardowe floty. Skład fali ekspedycji dałoby się zapisać jako szablon
zamiast wpisywać go za każdym razem — mniej klikania, mniej okazji do błędu.

---

## Reszta (przydatne, mniejszy zysk)

| Endpoint | Zastosowanie |
|---|---|
| `GET /ajax/resources`, `/ajax/facilities`, `/ajax/research`, `/ajax/shipyard` | tani odczyt stanu bez przeładowania strony |
| `POST /shipyard/add-buildrequest` | automatyczna odbudowa minerów/transportowców z nadwyżki |
| `POST /ajax/highscore` | lista graczy do farmienia bez chodzenia po galaktyce |
| `GET /ajax/jumpgate` + `POST /ajax/jumpgate/execute` | natychmiastowy skok floty księżyc→księżyc (obrona bez czasu lotu) |
| `POST /ajax/galaxy/missile-attack` | rakiety na obronę celu przed farmieniem |
| `GET /merchant/scrap` + `POST /merchant/scrap/execute` | złomowanie (na serwerze trwa event „100% Scrap") |
| `GET /ajax/fleet/union/available`, `POST /ajax/fleet/union/join` | ACS — nieistotne bez sojuszu |
| `GET /buddies/online`, `/chat/*` | zero wartości dla bota |
| `/admin/*` | tylko dla administracji serwera |

## Czego NIE ma

Nie ma endpointu, który podawałby skład obcej floty bez falangi — potwierdza
to, że heurystyka „licz sztuki" nie mogła zadziałać.
