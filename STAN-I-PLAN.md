# OGameX Assistant — stan na 25 sierpnia 2026, ~23:30 (v2.104.0)

Notatka przekazania. Wszystko jest na `main` w `Mitjano/ogamex-userscript`
(push na main = auto-aktualizacja przez Tampermonkey, CDN cache ~5 min).
Serwer: athena.ogamex.net, gracz MCH, baza **3:269:8** (planeta + księżyc).

---

## AKTUALIZACJA 30.08, 19:00 — v3.42.0: koniec ślepej uliczki, panel mówi prawdę, sonda rozstrzyga

Trzy poprawki wynikające wprost z wieczornych zrzutów.

**1. Bot przestał klikać w panel „Events".** Pięć zrzutów (15:31, 16:06, 16:40, 17:15, 17:50)
pokazało to samo: `<div class="content" id="fleet-movement-content"></div>` — kontener istnieje
i jest PUSTY. To nie panel „zwinięty", tylko panel, którego fork nie wypełnia na stronach, po
których bot się porusza. Pięć godzin prób co 10 minut nie dało ani jednego wiersza. Teraz bot
rozpoznaje ten stan (kontener obecny, zero dzieci), mówi to raz na 6 h i **przestaje klikać**.

**2. Panel mówi prawdę.** Komunikat „⚠ lista lotów zwinięta" był mylący — sugerował, że wystarczy
coś rozwinąć. Prawda brzmi inaczej, więc wiersz Obrona pokazuje teraz
`czysto · auto-ratunek · ⚠ 13 kolonii bez nadzoru`. Operator ma widzieć, czego bot NIE pilnuje,
a nie mieć poczucie, że wszystko jest pod kontrolą.

**3. Sonda `[SONDA LISTY]` rozstrzyga zamiast sugerować.** Wcześniej mogła zamilknąć (brak
kotwicy w pasku, brak innej kolonii) i cisza była nie do odróżnienia od „nie odpaliła się".
Teraz: odpala się co 5 min zamiast co 10, do 6 prób, **zawsze zostawia ślad w logu**, a zamiast
zgadywać po współrzędnych robi porównanie **A/B** — to samo zapytanie bez parametru i z parametrem
innej kolonii. Identyczne id lotów = parametr ignorowany, koniec tematu. Różne albo widoczne
koordy pytanej kolonii = parametr działa i wpinamy to w obronę.

**Testy:** 417 sprawdzeń, zero błędów.

### Co to znaczy dla obrony kolonii (stan na teraz)
Mechanika ratunku jest gotowa i sprawdzona: bot **widzi, na które ciało leci atak** (`dstBody`
z ikony księżyca w wierszu; przy `unknown` celowo NIE skacze na drugie ciało, tylko ucieka
w powietrze), ucieka w kolejności sąsiedni księżyc w układzie → drugie ciało pary → inna kolonia,
i **zabiera surowce** (`takeResources` domyślnie ON, minus rezerwa deuteru — owner ma 0).
Brakuje wyłącznie SYGNAŁU: atak na kolonię inną niż aktywna jest niewidoczny. Sonda powie, czy da
się to naprawić czytaniem ruchów per kolonia, czy trzeba to nazwać martwym polem na stałe.

---

## AKTUALIZACJA 30.08, 18:15 — v3.41.0: flota rusza się TYLKO przy ataku + rozwiązana zagadka listy lotów

**Decyzja ownera (18:04):** „stworzyłem nowego moona na nowej planecie i bot od razu wysłał
transportery z planety na moona. Nie chcę, żeby to robił. Przenosić flotę ma tylko podczas ataku."
W logu: `18:03:54 dom = księżyc: [1:217:8] planet → [1:217:8] moon` i `HEAVY_CARGO×12 341`.

**Zmiana.** Reguła „dom = księżyc" jest od teraz OPCJĄ `CFG.homeToMoon`, **domyślnie WYŁĄCZONĄ**,
z przełącznikiem w panelu („Flota rusza się TYLKO przy ataku" / „Zwożenie na księżyc ON").
Powrót po RATUNKU działa niezależnie od tej opcji: każda ewakuacja (swap/air) zostawia w stanie
stempel `rescues[para]`, a on przez 6 h uprawnia bota do odstawienia floty na księżyc — bo skoro
sam ją wywiózł, ma ją przywieźć. Lot ma wtedy `backHome: true` i inny opis w logu
(„powrót po ratunku: planeta → księżyc").

Trzy stare testy badały SAM MECHANIZM zwożenia, więc dostały jawne `CFG_H2M` (homeToMoon=ON) —
inaczej sprawdzałyby, że opcja jest wyłączona, zamiast że mechanizm działa.

## LISTA LOTÓW — zagadka rozwiązana, klikanie nie miało szans
Zrzut z 3.40.1 (15:31, 16:06, 16:40, 17:15, 17:50) pokazuje ZA KAŻDYM RAZEM to samo:

```html
<div id="layoutFleetMovements" class="fleet-movement-wrapper">
  <div class="header"><span class="title">Events</span></div>
  <div class="content" id="fleet-movement-content"></div>
  <div class="footer"></div>
</div>
```

Kontener **istnieje i jest PUSTY** — nie „zwinięty". Nie ma czego rozwijać: fork po prostu nie
renderuje wierszy ruchów w tym panelu na stronach, na których bot bywa (`home`, `building/facility`).
Klikanie w licznik misji nigdy tego nie zmieni, a lista kandydatów miała tylko 2 pozycje, bo
`clickable()` odrzuca elementy niewidoczne (`offsetParent === null`) — czyli m.in. nagłówek tego
schowanego kontenera. **Cała ścieżka „rozwiń listę" była ślepą uliczką.**

Wniosek: wykrywanie ataków na kolonie musi iść przez `/home/fleetmovementlist` z parametrem
planety (sonda `[SONDA LISTY]` z 3.40.1 — w logu ownera jeszcze się nie pojawiła, bo odpala się
raz na 10 min i tylko gdy jest inna kolonia niż aktywna). Jeśli parametr nie działa, zostaje
pasek misji jako jedyne źródło i trzeba to nazwać wprost w panelu.

**Testy:** 415 sprawdzeń, zero błędów.

---

## AKTUALIZACJA 30.08, 13:00 — v3.40.1: wersja DIAGNOSTYCZNA (lista lotów + sonda listy ruchów)

**Co potwierdził log ownera z 3.40.0 (10:33–12:49):**
- **Cichy odczyt kolonii DZIAŁA.** Bot poznał hangary dziesięciu kolonii bez jednej nawigacji:
  [1:217:7] 12 221, [1:217:8] 12 341, [1:217:9] 12 221, [1:218:9] 12 221, [1:225:8] 12 210,
  [1:225:9] 12 221, [1:234:7] 12 221, [1:234:8] 12 221, [1:205:9] 11 110, [2:223:9] 11 113,
  [2:224:7] 11 111. Czyli na każdej kolonii stoi ~11–12 tys. statków, o których bot do dziś
  nie wiedział — i których nie miałby jak ratować.
- **Zero sztormu nawigacji.** Podwójne `[WAKE]` zniknęło. Ciche odpuszczanie przy pustym hangarze
  działa (`12:10:09 brak statków do wysłania (poza wykluczeniami)`, `12:13:01 hangar pusty`).
- **Lista lotów nadal się nie rozwija** — cykl „próba 1/2 → 2/2" co ~10 min, bez skutku, i wciąż
  tylko DWÓCH kandydatów. Czyli jawny przycisk „Fleet movements" NIE został znaleziony nawet
  na stronie floty. Zrzutu kontenera brak, bo dławik `events_dom` wynosił 6 h.

**Zmiany 3.40.1 — same DIAGNOSTYCZNE, bez wpływu na decyzje:**
1. Zrzut kontenera listy lotów co **30 minut** zamiast raz na 6 h. Bez tego każda poprawka
   wymagała pół dnia czekania na dane.
2. **SONDA `[SONDA LISTY]`**: strona floty przyjmuje `?planet=UUID` (korzysta z tego
   `Hangar.scanRemote`), więc sprawdzamy, czy `/home/fleetmovementlist` też. Jeśli tak, to
   ślepota na 13 kolonii znika BEZ rozwijania czegokolwiek w DOM — a to jest najważniejsza
   dziura obronna z audytu. Sonda tylko LOGUJE (ile wierszy i jakie współrzędne wróciły dla
   pytanej kolonii), odpala się raz na 10 minut i **po 3 próbach wyłącza się sama**.

**Czego szukamy w logu po tej wersji:** linii `[SONDA LISTY] pytałem o [x:y:z] → N wierszy,
współrzędne: …`. Jeśli wśród współrzędnych są koordy PYTANEJ kolonii, a nie tylko aktywnej pary —
przepinamy wykrywanie ataków na ten endpoint i problem listy lotów przestaje mieć znaczenie.
Plus `[LOTY DOM] … Kontener listy: …` — markup, po którym da się znaleźć właściwy przełącznik.

**Testy:** 409 sprawdzeń, zero błędów.

---

## AKTUALIZACJA 30.08, 10:45 — v3.40.0: wnioski z audytu obrony + z testu ownera 10:22

**Test ownera na 3.39.2 (10:22:32 → 10:25:39) wypadł CZYSTO** i potwierdził wszystkie poprawki
z 3.39.x: wiersz symulacji jako WARN zamiast ERROR-a, decyzja „atak w moon → drugie ciało",
`confirmPendingSend()` zdjęło `pending` w sekundę (`10:23:15 wpis nie czeka na timeout`),
komunikat „flota już wyleciała (swap → [1:217:6] planeta, ląduje 10:25:00), nie ma czego ratować"
zamiast sześciu ERROR-ów, ZERO sztormu nawigacji. Flota wróciła na księżyc sama.

Test ujawnił jednak jeszcze jedną rzecz: **ten sam alert poszedł OSIEM razy** (10:23:15–10:24:59)
mimo dławika 5 min, bo klucz dławika zawierał odliczanie („za 107s", „za 87s"…) i każda sekunda
tworzyła nowy klucz. Cyfry wypadają teraz z klucza; para nadal rozdziela alarmy z różnych kolonii.

### Zmiany 3.40.0
1. **Wiersz „Obrona" w panelu: ostrzeżenie OBOK stanu, nie zamiast.** W 3.39.0 komunikat
   „ROZWIŃ LISTĘ LOTÓW" zasłonił `czysto · auto-ratunek` — owner przestał widzieć najważniejszą
   informację w panelu. Teraz: `czysto · auto-ratunek · ⚠ lista lotów zwinięta`.
2. **Cichy odczyt pozostałych kolonii** (`recon_bg`). Audyt pokazał, że przy `reconMode="fleet"`
   i przypiętym ciele startowym bot NIE ZNA hangarów 13 kolonii — więc nawet wykryty atak kończy
   się „nie wiem, gdzie stoi flota". Teraz czyta je `Hangar.scanRemote` (fetch w tle, ZERO
   nawigacji, zero przełączania planety operatora): jedno ciało na przebieg, nie częściej niż raz
   na minutę, każde ciało raz na 45 min. To NIE jest akcja `recon` z decide() — tamta nawiguje
   i to ona zrobiła sztorm 09:59.
3. **Flaga „nie umiem rozwinąć listy lotów" nie przeżywa aktualizacji** — każda wersja przynosi
   nowych kandydatów i dostaje czystą kartę.
4. **Zrzut markupu listy lotów pokazuje KONTENER listy**, a nie górną nawigację (zrzut z 09:58:06
   pokazał `<div id="header">`, czyli menu gry — bezużyteczny). Dochodzi informacja, na której
   stronie bot próbował.
5. Dławik alertów bez odliczania (wyżej).

**Testy:** 409 sprawdzeń, zero błędów.

### DALEJ OTWARTE
- **Kanał ntfy na telefonie ownera** — push działa (HTTP 200), ale telefon subskrybuje kanał 2.x
  z Atheny. Trzeba dodać `ogamex3-d0zjvhl9eiho`. Bez tego warstwa alarmowa nie istnieje.
- **Lista lotów wciąż zwinięta.** Przycisk „Fleet movements" jest na stronie Fleet, owner siedzi
  zwykle na Overview. Następny zrzut (już z właściwego kontenera) powie, w co klikać.
- **Progi sonda vs atak**: na Genesis floty latają wolniej niż na Athenie (owner 30.08), więc
  `confirmMs` 20 s i `barHoldMs` 60 s można PODNIEŚĆ — mniej wyrywania floty na sondę, a i tak
  zdąży przy prawdziwym ataku. Do ustalenia liczb z ownerem.
- Adaptacyjne odpytywanie i lekki keepalive (mniej żądań do serwera gry) — niezrobione.

---

## AKTUALIZACJA 30.08, 10:30 — v3.39.2: koniec sztormu nawigacji + lista lotów to robota BOTA

**SZTORM 09:59:20–09:59:47 — około 90 przeładowań `/fleet` w 27 sekund.** Owner podejrzewał,
że to on klikał — nie, każdy wpis jest podpisany `← bot: lot: formularz [1:217:6]→[1:217:6]`
i idzie w parze z `[LOT] dom = księżyc` oraz `wysyłka już poszła Xs temu`, trzy razy na sekundę.

**Mechanizm.** Lot „dom = księżyc" zabiera CAŁY hangar planety, ale nasz zapis hangaru ŹRÓDŁA
zostawał nietknięty — dalej twierdził, że na planecie stoi 460 tys. statków. Dopóki wpis lotu
wisiał (do 3.38 aż 10 min, bo `pending` czekał na timeout), `!f` blokowało regułę i nikt tego nie
zauważył. Od 3.39.0 `confirmPendingSend()` zdejmuje `pending` w sekundę, a hangar CELU domyka wpis
(`09:59:15 [LOT] domknięty — flota widziana na [1:217:6 moon] (460 553)`) — i od tej sekundy
decide() wystawiał ten sam lot w kółko, bramka anty-duplikat ścinała go po jednej NAWIGACJI na
obrót, a pętla kręciła się z prędkością przeładowań strony. Czyli: 3.39.0 nie stworzyła błędu,
tylko zdjęła z niego dziesięciominutową zaślepkę.

**Naprawione trzema rzeczami:**
1. `emptySourceHangar()` — po KAŻDEJ potwierdzonej wysyłce lotu obronnego (normalna ścieżka,
   `confirmPendingSend()` i bramka anty-duplikat) hangar źródła jest zerowany. Skoro flota
   wyleciała, źródło jest puste — i decide() nie ma już powodu powtarzać lotu.
2. Bramka anty-duplikat wysyła trasę w **karencję** (`fly_block`) na resztę swojego okna, zamiast
   tylko kasować misję. Egzekutor mówi wtedy „trasa w karencji — czekam" i NIE nawiguje.
3. Karencja **tylko dla lotów obronnych** — E2E natychmiast złapał, że objęcie nią ekspedycji
   zjada falę 2 z serii (te lecą tą samą trasą co 60–90 s). Test „fala 2 też wyszła" zadziałał
   dokładnie tak, jak miał.

**LISTA LOTÓW — bot ma sobie radzić sam (owner, 30.08).** Do 3.39.1 po dwóch nieudanych próbach
bot poddawał się, prosił operatora o ręczne rozwinięcie i milczał 6 h. Zrzut z 09:58:06 pokazał
przy okazji, że heurystyka „N Missions:" trafiała w `<div id="header">`, czyli w GÓRNĄ NAWIGACJĘ.
Teraz: pierwszym kandydatem jest jawny przycisk **„Fleet movements"** (fork ma go na stronie floty,
widać na zrzucie ekranu ownera), potem jego rodzic, dopiero potem stare heurystyki — a po
wyczerpaniu listy bot czeka 10 minut i próbuje CAŁĄ listę od nowa, zamiast oddawać robotę
operatorowi. Prośba „ROZWIŃ JĄ RĘCZNIE RAZ" usunięta z kodu.

**Testy:** 407 sprawdzeń, zero błędów. Nowe kontrole w 19c pilnują zerowania źródła, karencji
trasy, wyłączenia ekspedycji z karencji i tego, że bot nie prosi już operatora o rozwijanie listy.

---

## AKTUALIZACJA 30.08 po południu — v3.39.1: WYCOFANIE rekonesansu po ETA (regresja z 3.39.0)

Zgłoszenie ownera: „coś się spierdoliło i ciągle stronę odświeża". Winna jest moja zmiana
z 3.39.0, punkt 2 — „po upływie ETA bot sam prosi o odczyt hangaru celu".

**Dlaczego to było złe.** Zamiar był dobry (wpis lotu domyka się odczytem hangaru CELU, a ten
zależał od listy lotów w grze, u ownera zwiniętej). Ale akcja `recon` trafia do egzekutora
napisanego dla ALARMU: on `Nav.go('/fleet?x=…')` albo `Nav.click(anchor)` w pasek planet, czyli
PRZEŁĄCZA operatorowi planetę i przeładowuje grę. W alarmie to uzasadniona cena (limit 3 prób,
`alarm_scan`). W rutynowej ciszy — a lotów „dom = księżyc" i ratunków jest kilka na godzinę —
oznacza to przeładowanie co przebieg pętli, czyli dokładnie to, czego owner nie znosi
(„nie chcę, żeby tak przeskakiwało po planetach", 29.08).

**Wycofane w całości.** Zostaje `confirmPendingSend()` z 3.39.0 — i to ONO usuwa właściwą
przyczynę 20-minutowego paraliżu (wpis `pending` czekający na 10-minutowy timeout, bo
`send.click()` nawiguje przed kodem potwierdzającym). Reszta 3.39.0 bez zmian.

**Wniosek na przyszłość:** do rutynowego domykania lotów wolno użyć WYŁĄCZNIE cichej ścieżki
(`Hangar.scanRemote` — fetch w tle, bez nawigacji). Akcja `recon` z decide() jest z definicji
kosztowna: nawiguje. Test w sekcji 19b pilnuje teraz, że cisza + lot po ETA nie generuje
ŻADNEJ akcji `recon` ani `fly`.

**Testy:** `node test3-all.js` — 403 sprawdzenia, zero błędów.

---

## AKTUALIZACJA 30.08 — v3.39.0 (Genesis): księgowość lotów po teście ratunku na żywo

Owner odpalił „TEST: atak na księżyc" o 09:17:56. Decyzja była poprawna (skok moon→planet,
lot 106 s, forma i wysyłka bez zarzutu), ale ujawniła cztery rzeczy.

**1. Wpis lotu wisiał 10 minut zamiast sekund — i to jest sedno.** `send.click()` NAWIGUJE
NATYCHMIAST, więc kod stojący za klikiem (ten, który zdejmuje `pending` z wpisu lotu) nigdy się
nie wykonał. Wpis `pending` blokuje parę aż do 10-minutowego timeoutu: `09:28:46 wpis "swap"
wisi 10 min bez potwierdzenia — zdejmuję` i DOPIERO po tym `dom = księżyc`. Druga noga tak samo
(09:38:53). Ratunek trwał 106 s, paraliż 20 minut — bez powrotu na księżyc i bez ekspedycji.
FIX: `confirmPendingSend()` w pętli obrony czyta dowód wysyłki z adresu gry
(`/fleet?fleetSendSuccessfully`) i zdejmuje `pending` po przeładowaniu; bramka anty-duplikat
(„wysyłka już poszła Xs temu") robi to samo.

**2. Wpis domykał się wyłącznie odczytem hangaru CELU, a ten zależał od `s.landings`,** czyli od
LISTY LOTÓW w grze — a ta jest u ownera zwinięta i bot nie umie jej rozwinąć (`09:24:19` i
`09:25:06` próba 1/2 i 2/2, wcześniej 03:57:55 pełny zrzut z prośbą „ROZWIŃ JĄ RĘCZNIE RAZ").
FIX: po upływie ETA lotu bot SAM prosi o odczyt hangaru celu. Zasada „stan lotu zamykany
HANGAREM, nie zegarem" zostaje — zegar mówi tylko, KIEDY warto spojrzeć. Loty z zawrotem
(ucieczka w powietrze) są z tego wyłączone: mają czekać w powietrzu.
**DLA OWNERA:** i tak rozwiń raz „> Fleet movements" w grze — gra zapamiętuje ten wybór.
Od 3.39.0 panel o to krzyczy w wierszu Obrona, zamiast chować to w logu o 3:57 w nocy.

**3. Sześć ERROR-ów „nie wiem, gdzie stoi flota" w trakcie alarmu** (09:18:38–09:20:38), choć bot
minutę wcześniej sam wysłał z tej pary ratunek i wpis lotu leżał w stanie. FIX: gdy z pary trwa
lot, komunikat brzmi „flota już wyleciała (swap → [1:217:6] planeta, ląduje 09:20:24), nie ma
czego ratować" i jest ostrzeżeniem, nie błędem. **Rekonesans zostaje w obu przypadkach** —
„coś stąd wyleciało" nie dowodzi, że hangar jest pusty (mogły dojść nowe statki).

**4. Fałszywe `[TEMPO]` o pętli keepalive.** Jedna nawigacja bota tłumaczyła KAŻDE przeładowanie
przez następne 20 s, także te wyklikane przez ownera (08:49:50 keepalive → /home, a potem
/messages, /messages?planet, /wiki dostały etykietę „bot: keepalive"). Detektor pętli zgłaszał
coś, czego nie było. FIX: ślad nawigacji bota zużywa się po pierwszym przeładowaniu.
To samo dotyczyło `[TEMPO]` „lot: formularz" o 08:28:34. **Keepalive NIE był w pętli.**

Drobne przy okazji: wiersz symulacji dostał opis (koniec `[ATAK DOM] wrogi wiersz (ATTACK, sim):
undefined` przy każdym teście) i nie jest już zgłaszany jako ERROR; blokada uśpienia zakładana
pod zamkiem (podwójne „[WAKE] blokada uśpienia zwolniona" brało się z dwóch równoległych
`ensure()`); `[BONUS] nie odbieram…` raz na godzinę zamiast co pół.

**Testy:** `node test3-all.js` — 404 sprawdzenia, zero błędów. Nowe sekcje 19b i 19c w
`test3-decide.js` odtwarzają incydent: alarm z lotem w powietrzu (komunikat, poziom, ETA,
zachowany rekonesans), rekonesans celu po ETA, brak powtarzania go przy świeżym odczycie,
oraz wyłączenie lotów z zawrotem.

**NIEROZSTRZYGNIĘTE (decyzja ownera).** Fala domykająca ekspedycji wysyła CAŁY hangar, więc flota
jest w powietrzu niemal bez przerwy — test ratunku o 09:18 uratował 21 368 statków (11
kolonizatorów, 20 983 recyklery, 374 minery), bo cała flota bojowa (110 087 HC, 114 876 HF,
111 183 BS…) wyleciała o 08:29 na ekspedycję. To nie jest bug, tylko skutek ustawień: jeśli część
floty ma zostawać w domu, właściwym hamulcem jest `excludeTypes` albo świadoma zmiana reguły
zamiatania. Do tego wciąż otwarte: pomiar łupu z ekspedycji (wymaga parsowania wiadomości
o powrotach) i priorytet 3 z audytu wydajności Firefoxa (przerysowywanie logu, zapis co 800 ms,
ściąganie 209 KB co 15 min).

---

## AKTUALIZACJA 30.08 — v3.38.0 (Genesis): rozmiar fali ekspedycji z dzielnika malejącego + koniec fałszywego „Obrona: BŁĄD"

Zgłoszenie ownera (30.08, ~08:20): „bot wysłał trzecią flotę, a jeszcze bardzo dużo statków
zostało; mam wrażenie, że na Athenie działało to inaczej". Panel: ekspedycje 3/4, hangar
księżyca [1:217:6] = 238 343 szt. (z tego 21 368 to wykluczenia: 20 983 recyklery,
374 minery, 11 kolonizatorów).

**Co było.** `expoPlan` liczyło rozmiar fali jako `floor(ilość / fale)` i ZAMRAŻAŁO wynik
w `burst.sizes` na całą serię (port reguły z 2.x — inaczej każda kolejna fala dzieliła resztę
i seria wygasała). Skutek uboczny: ekspedycje wracające W TRAKCIE serii nie trafiały do fal
2..N-1, bo te słały porcję sprzed serii. Log 30.08: hangar 41 711 szt. o 08:00 → 197 408 szt.
o 08:08, a fale dalej po ~72 tys. Cała nadwyżka spadała na falę domykającą.
Wrażenie ownera o Athenie jest trafne, ale różnica idzie w drugą stronę: 2.x miało
`SWEEP_CAP_X` (fala domykająca ≤ 3× udziału), zdjęte w v3.28.0 — na Athenie w domu zostawało
WIĘCEJ, nie mniej.

**Co jest.** `share(qty) = floor(qty / left)`, gdzie `left` = ile fal serii jeszcze zostało.
Gdy nic nie wraca, wynik identyczny jak przy zamrażaniu (po 1. fali 200 z 800 zostaje 600,
600/3 = 200 — fale nadal równe). Gdy wraca, nadwyżka rozkłada się natychmiast, a fala
domykająca zastaje normalną porcję zamiast 217 tys. statków. `burst.sizes` zniknęło ze stanu
serii — został sam licznik `sent`. Opis fali w logu mówi teraz „fala 2/4 — 66 666 szt."
zamiast „1/4 floty" (potrzebne, żeby dało się w ogóle zmierzyć, czy większa fala = większy łup).

**Drugi błąd z tego samego logu (05:06 i 06:51):** `[LOT] przerwany: brak pól statków`,
a w zrzucie same wykluczenia — `COLONY_SHIP(11), RECYCLER(20983), ASTEROID_MINER(374)`.
Bramka `if (!avail.length) skip` w `expoPlan` działa na odczycie hangaru sprzed nawigacji,
więc gdy w międzyczasie zostały tylko statki spoza planu, bot i tak otwierał formularz,
nie wypełniał żadnego pola i leciał ERROR → `Journal.add("BŁĄD")` → push „⚠️ Obrona: BŁĄD"
na telefon o piątej rano. Teraz `Fly.form()` rozpoznaje ten przypadek (są elementy statków,
ale żaden nie jest w planie) i odpuszcza falę cichym abortem: warn w logu, 3-minutowa
karencja trasy, ZERO wpisu w dzienniku i zero pusha. Nieznany markup dalej krzyczy jak dotąd.

**Testy:** `node test3-all.js` — 0 błędów. Nowa sekcja 17b w `test3-decide.js` odtwarza
incydent (hangar rośnie w środku serii → 2. fala 666 z 2000, nie porcja sprzed serii;
pełna seria 1000 → 250/250/250/250 i zero resztek; stary `burst` z 3.37 ignorowany)
plus dwie kontrole źródła w sekcji 19.

**NIEROZSTRZYGNIĘTE — do zmierzenia przez ownera.** Czy gigantyczna fala domykająca w ogóle
się opłaca. W klasycznym OGame łup z ekspedycji ma sufit powiązany z rankingiem i ładownością;
jeśli ten fork liczy podobnie, fala z 217 tys. statków przywozi tyle samo, co dużo mniejsza.
Wzoru forka nie znam i nie zgadywałem. Log ma już rozmiar wysłanej fali — brakuje strony
przychodowej, czyli parsowania wiadomości z powrotów ekspedycji (osobna robota, nie jedna
linijka, jak wcześniej napisałem). Dopiero to powie, ile fal ma sens.

**UWAGA do suwaka „fale":** `lastOfBurst` zapala się także przy `expo.used >= cap - 1`,
a `cap = min(fale, sloty ekspedycji)`. Przy 4 slotach czwarta wysyłka ZAWSZE zamiata hangar,
niezależnie od tego, czy ustawisz 4 fale, czy 14. Po v3.38.0 nie boli, bo fale 1–3 zabierają
już równe porcje bieżącego hangaru.

---

## AKTUALIZACJA 25.08 (32) — v2.104.0: PEŁNY AUDYT po dniu symulacji (4 przeglądy) i konsolidacja poprawek

Powód: 21:18–21:50 seria symulacji ujawniła 3 realne dziury, a moje szybkie
poprawki 2.103.2–2.103.6 dołożyły 2 własne (MoonSave.armed() ≠ straż
uzbrojona; kotwica czekania na sondy odnawiana co tick). Owner: „za każdym
razem zweryfikuj, czy zmiany nie psują czegoś w innym miejscu". Cztery
niezależne audyty (dzisiejsze zmiany / maszyna stanu straży-kolejki-ucieczki /
alarm z paska vs wszystkie incydenty z historii / symulacja-Odkrywca-mining-
baza) → jedna łatka 2.104.0.

**Naprawione (zweryfikowane TESTEM offline, NIESPRAWDZONE na żywo):**
1. `barExcessDecision` — CZYSTA decyzja o nadwyżce paska (blok BAR-EXCESS):
   nadwyżka = pasek − ataki − sondy w locie; czekanie na sondy tylko gdy mogą
   ją tłumaczyć WYLĄDOWANE, kotwica = start kandydata (nie odczyt), cap 120 s,
   pasek z cache + sondy → 20 s na żywy pasek (nadwyżka zostaje). Test
   `test-nadwyzka.js` wykonuje prawdziwą funkcję: 21:34 (0), 16:22 (alarm po
   10 s, kotwica nie ucieka), 13:10 (alarm), daleka sonda (alarm), cache.
   W stanie alarmu `excess=0`, póki trwa czekanie (jedna sonda eta≤30 s przy
   uzbrojonej straży robiła „oba ciała" → 14-h Deploy).
2. `attackBodiesFor`: „nadwyżka paska = oba ciała" TYLKO dla pary strzeżonej
   (dla każdej pary blokowało ratunek drugiej kolonii z kolejki).
3. `MoonSave.run`: oba ciała pod atakiem + ucieczka nie ruszyła / niedostępna
   → flota NIE rusza w obrębie pary (dotąd „legalny" skok pod uderzenie =
   21:23); `shoutBothHit` z dławikiem 5 min (push urgent).
4. **Ślepy alarm z paska broni DOMU FLOTY**: `FleetRecon.fleetHome()` = pole
   „Start ekspedycji", chyba że mapa hangarów (48 h) mówi ≥1 mld i ≥2× —
   wtedy tam. Użyte w `autoSaveOnThreat` i `run()`. (Dotąd 3:272:7 z configu,
   gdy flota stała na 5:67:5 — kształt 13:10.)
5. `switch_to_body`: „jesteśmy już na właściwym ciele" tylko w TEJ SAMEJ parze
   (21:44:56 powrót dla 5:67:5 otworzył formularz na planecie 3:272:7).
6. Kolejka: `dropPending` przy ucieczce w powietrze / rozbrojeniu / pustym
   hangarze; jeden wpis na kolonię; TTL 45 min (było 4 h); ręczny WRÓĆ NA
   BAZĘ nie promuje kolejki (21:44:54 wskoczył wpis z 21:23); wpis kolonii w
   ucieczce odrzucany; promowany wpis dostaje `lastSendAt`.
7. Flipy formularza piszą straż tylko, gdy uzbrojona (nie tworzą zjawy).
8. `saveWatch`: każde uzbrojenie straży zapisuje w dzienniku, KTO (stack) —
   ślad na „zjawę" 21:49:08 (autotest sprawdzony: nie pisze stanu; jedna
   instancja — owner potwierdził brak Windows; źródło NIEZNANE, instrumentacja).
9. Ping-pong resztek: ratunek zapisuje `ogamex_save_total`; automatyczny
   powrót zastający <20% tego (np. 22 nowo zbudowane BS) nic nie wysyła i
   rozbraja straż (nie dotyczy ręcznego powrotu i trwającego alarmu; sweep
   nie nadpisuje sumy).
10. Symulacje: `simBlockReason` dla OBU przycisków (także „TEST ŚLEPEGO
    PASKA", który nie miał żadnej blokady): symulacja/alarm/straż/AirSave
    phase/pending obrony/KEY_SWITCH; stare wpisy kolejki czyszczone przed
    testem; sprzątanie po symulacji dla klucza CELU + zerowanie sim_target/
    sim_started.
11. Mining: rekord `ogamex_last_dispatch` znakowany `consumedAt` (nie
    kasowany — `minersHomeAfterLastDispatch` go potrzebuje); finishDispatch
    też znakuje.
12. Odkrywca: `continue` zamiast `break` przy obcym selekcie z „min";
    ostrzeżenie o braku opcji 40 min raz na 15 min.

**Recenzja adwersarialna diffu przed pushem (5. przegląd):** brak blokerów;
wdrożone: TTL kolejki z powrotem 4 h (45 min porzucałoby POTRZEBNY powrót
drugiej kolonii przy długim dolocie ACS — zombie-wpisy i tak kasuje
`dropPending`); kotwica czekania na sondy = kandydat, a w trwającym alarmie
`firstAt` (kandydat resetuje się co 5 min); flip formularza przy ratunku z
kolejki aktualizuje WPIS kolejki, nie straż pierwszej kolonii (`noteFlip`);
`ogamex_save_total` kasowane przy rozbrojeniu; czyszczenie kolejki przed
symulacją poza „powodem blokady". **OTWARTA DECYZJA (W2):** przy koncie z
JEDNĄ parą (Genesis, dni 1–14) „oba ciała pod atakiem + brak refugium" =
STOP z pushem, a nie skok na ciało z późniejszym dolotem — bot nie zna
dolotów per ciało (tylko min/max per para; są w komunikacie). Do zrobienia
przed Genesis: eta per ciało w `events()` i skok na później atakowane, gdy
różnica ≥3 min.

**Świadomie NIE zrobione (do decyzji):** sonda w drodze powrotnej jako
„w locie" (brak dowodu, że fork ją pokazuje z eta>0); koordynacja dwóch
instancji (owner: jedna); `markFailed` ucieczki nie zdejmuje kolonii z
`done` kolejki; podwójna ścieżka potwierdzenia powrotu (fleetSendSuccessfully
vs finishDispatch) nieujednolicona; hipoteza „pasek liczy sondy w locie"
oparta na 2 obserwacjach (21:34 tak; 16:22 sonda wylądowana) — przy
nadwyżce log pokazuje ataki/sondy/w locie, żeby zbierać dowody.

**NA ŻYWO niesprawdzone:** wszystko powyżej. Procedura: owner ustawia
„Start ekspedycji" = 5:67:5, status „czysto", stoi na księżycu 5:67:5,
TEST ALARMU `both` → oczekiwane: cel [5:67:5] → UCIECZKA W POWIETRZE do
innej kolonii → ZAWRÓCONA → flota wraca; w dzienniku wpis „Straż UZBROJONA
… ←" ze śladem.

## AKTUALIZACJA 25.08 (31) — v2.103.4–2.103.5: komunikat odmowy symulacji + fantom „PARALLEL: sent"

- 2.103.4: odmowa startu symulacji mówi wprost, co kliknąć (straż uzbrojona →
  „WRÓĆ NA BAZĘ"), plus alert. Kontekst: po fałszywym alarmie 21:34 straż
  bazy [3:272:7] została uzbrojona; „WRÓĆ NA BAZĘ" przeniosło 22 nowe
  pancerniki planeta→księżyc i rozbroiło straż (21:45:09).
- 2.103.5: fantom 21:35:43 „PARALLEL: sent 2 000 000 000 miners" przy
  miningu OFF i zerowej wysyłce — strona „flota wysłana" bez rozpoznanej
  misji wpadała do gałęzi miningu ze STARYM `ogamex_last_dispatch`. Teraz:
  decyzja górnicza tylko przy `asteroidMining.enabled` i rekordzie <10 min,
  rekord zużywany jednorazowo (stary kasowany).
- Stan po 21:45: straż rozbrojona, kolejka pusta, flota na księżycu [5:67:5].
  **Otwarte: owner ma ustawić „Start ekspedycji" = 5:67:5** (bot broni
  3:272:7 przy ślepym alarmie) i zrobić test `both` z księżyca 5:67:5.

## AKTUALIZACJA 25.08 (30) — v2.103.3: FAŁSZYWY ALARM z paska (3 sondy = „3 ataki")

- 21:32:46 / 21:34:21: pasek 3 obcych, lista 0 ataków + 3 sondy → ścieżka
  „nadwyżka paska" (v2.102.3: pasek nie liczy sond) uznała 3 za ATAK na
  oba ciała → **ucieczka w powietrze całej floty** (Deploy 3% 5:67:5→5:67:9,
  14 h 37 min lotu, 43 bln deuteru) bez żadnego ataku; potem to samo na
  bazie. Owner: „nie było ataku, tylko trzy skany". Wniosek: pasek forka
  LICZY sondy W LOCIE; 16:22 („ACS + sonda = 1 Hostile") sonda była już
  wylądowana — lista trzyma wiersz dłużej niż pasek.
- v2.103.3: nadwyżka = pasek − ataki − sondy w locie (eta>30 s); wylądowane
  sondy dalej nie maskują (16:22 pokryte). Nadwyżka ≤ liczba sond →
  potwierdzenie czeka do lądowania sond (spyMaxEta+10 s) — trwa dalej = atak.
  Log pokazuje „w locie N". `barCountsProbes=true` = liczyć wszystkie sondy.
- test-kolejka.js: 5 checków (formuła + scenariusze 21:34 / 16:22 / ACS+sonda).
- OTWARTE: potwierdzenie, czy zawrócenie ucieczki z 21:33 (zegar ~21:34)
  faktycznie zawróciło Deploy 14 h — owner sprawdza ruchy floty.

## AKTUALIZACJA 25.08 (29) — v2.103.2: kolejka ratunków vs atak na OBA ciała drugiej kolonii

- Incydent 21:23 (test): druga symulacja (`both`, cel [5:67:5]) odpalona,
  gdy alarm pierwszej (baza [3:272:7]) jeszcze trwał → bot uznał ją za
  „drugi atak w trwającym alarmie" → KOLEJKA przeniosła flotę księżyc →
  PLANETA [5:67:5], choć planeta też była atakowana. Realna dziura: przy
  prawdziwym ACS na oba ciała kolonii poza bazą podczas alarmu flota
  poleciałaby pod uderzenie (ucieczka w powietrze była wyłączona dla
  `queued`).
- v2.103.2: gałąź ucieczki w powietrze obejmuje kolejkę. Oba ciała drugiej
  kolonii pod atakiem: ucieczka wolna → leci; zajęta (inna kolonia w locie)
  lub niedostępna → flota NIE ruszona + BŁĄD + push „ratuj ręcznie".
  Start symulacji zablokowany, póki trwa alarm/symulacja/straż uzbrojona
  (komunikat z godziną końca). Puste zamiatania co 45 s przy „wróg blisko"
  to zachowanie zamierzone (v2.102.1), nie bug.
- test-kolejka.js: 3 checki źródłowe. Bateria: wszystko OK.

## AKTUALIZACJA 25.08 (28) — v2.103.1: symulacja ataku celuje w aktywne ciało

- Incydent 21:19 (test „both" po wgraniu 2.103.0): flota stała na księżycu
  [5:67:5] (po Deployu), a symulacja wstrzykiwała atak na BAZĘ z configu
  [3:272:7] — bot przełączył się tam, hangar pusty na obu ciałach → „MOON
  SAVE nothing to save — aborting". Obrona zadziałała poprawnie wobec tego,
  co widziała; test po prostu bił w złe miejsce. Prawdziwy atak na [5:67:5]
  obsłużyłby (od v2.55/2.75.1 ewakuuje TĘ kolonię, na którą leci atak).
- v2.103.1: przy starcie symulacji cel = para aktywnego ciała
  (`HomeBase.coords()` → `ogamex_threat_sim_target`); okno potwierdzenia
  i log pokazują cel. Fallback: baza z configu. Zasada: **symulację
  odpalać stojąc na ciele, gdzie stoi flota.**

## AKTUALIZACJA 25.08 (27) — v2.103.0: Odkrywca — ekspedycje 40 min

- Owner rozważa zmianę klasy na ODKRYWCĘ (test jutro 26.08; na Genesis to
  właściwy wybór: tygodnie 1–3 zarabiają ekspedycje, +30% łupu i 40-min cykl
  = ~1,5× lotów na slot). Dług: wybór „Expedition duration" łapał tylko
  „N Hours", opcję „40 Minutes" by pominął → wysyłka na 1 h, zysk z klasy
  przepada.
- v2.103.0: przełącznik w Ustawieniach ekspedycji **„Odkrywca: ekspedycje
  40 min"** (`expeditions.discoverer40`, domyślnie OFF). ON → pending_mission
  niesie `holdingMinutes: 40`, krok 3 formularza przez `pickExpeditionDuration`
  (blok EXPO-DURATION) wybiera „40 Minutes"/„40 min"/„0.67 Hours"; gdy opcji
  nie ma (klasa to nie Odkrywca) — WARN i wysyłka na holdingHours. OFF →
  zachowanie jak dotąd (opcje w minutach nie maskują godzin).
- Test `test-odkrywca.js` (10 checków) w baterii. Bateria: wszystko OK.

Procedura jutro: Academy → Discoverer → Select; w panelu Ekspedycje →
„Odkrywca: ekspedycje 40 min" ON; po pierwszej fali sprawdzić log
„Expedition duration set to 40 Minutes" (a nie WARN [ODKRYWCA]).

## AKTUALIZACJA 25.08 (26) — v2.102.3–2.102.4: PRAWDZIWY ATAK 16:13–16:33 i pamięć ataku

- INCYDENT: ACS Ibry z [3:250:3] — 712 mld Reaperów + 2×136 mld BS na
  księżyc. Flota uratowana **ręcznym klikiem ownera** + zamiataniem 16:28:02.
  Bot zawiódł: 16:22:47/16:27:48 alarm ZDJĘTY, bo 2 wylądowane sondy
  (eta~0) na liście ≥ 1 Hostile na pasku → „zero" → 16:25:15 AUTO-POWRÓT
  wiózł flotę POD atak; 16:14/16:21 kandydat kasowany przez „czystą" listę
  (fork gubi wiersz ACS); 16:26:11 ratunek z samego paska bez ciała celu
  PLANETA→KSIĘŻYC (pod atak) — uratował flip pustego hangaru.
- v2.102.3: nadwyżka paska vs ataki + sondy W LOCIE (wylądowane nie
  maskują; `barCountsProbes`); **PAMIĘĆ ATAKU** (`ogamex_atk_until` + ciało
  celu per para) — dopóki widziany dolot nie minął: alarm nie gaśnie,
  kandydat nie ginie, powrót nie rusza (+60 s), ratunek zna ciało celu;
  alarm/kandydat gasną WYŁĄCZNIE od żywego paska z zerem.
- v2.102.4 (3 audyty adwersarialne + recenzja; replay ataku na nowym
  kodzie: błędy się nie powtarzają): pamięć pisana zawsze gdy są wiersze,
  sufit 3 h, ETA sanity, bezpiecznik powrotu ≤20 min; wabik zawrócony =
  żywy pasek 0×2 → czyszczenie; `ThreatMonitor.attackBodiesFor/attackBodyFor`
  = lista ∪ pamięć — jedno źródło prawdy o ciele celu (flipy formularza,
  zamiatanie, straż, AirSave); ratunek nigdy NA znane atakowane ciało;
  refugeBody dopiero po `commitGuardSwap`; auto-powrót OFF nie rozbraja;
  ręczny RATUJ w oknie kandydata → trigger threat; strandowanie floty =
  BŁĄD push. Bateria: wszystko OK.

OTWARTE: po wgraniu v2.102.4 klik „TEST: symulacja ataku" w grze; brak
jeszcze bojowego potwierdzenia pamięci ataku na żywo. Genesis 28.08 18:00 GMT.

## AKTUALIZACJA 25.08 (25) — v2.100.0–2.102.2: straż świadoma ciała, zamiatanie, pierwsza bojowa ucieczka

- v2.100.0 (audyt 25.08): D1 atak w ciało z uratowaną flotą przy uzbrojonej
  straży → skok na drugie ciało, zamiatanie startuje z ATAKOWANEGO ciała;
  D2 zegar zawrócenia przesuwa się z dosłanymi falami (max dolot − 1 min);
  D3 faza `recalled` blokuje ratunek tylko do lądowania; D4 wracające fale
  ekspedycji/asteroid lecą tym samym Deployem do refugium. Wyłącznik
  `threatAlarm.bodyAwareGuard` (OFF = 2.99.6). Testy: test-fale.js.
- v2.100.1: 6 poprawek po 2 recenzjach. v2.101.0: zamiatanie wg zegara
  powrotów + ostrzeżenie o falach nie do uratowania. v2.102.0: „obrona bez
  cichej ślepoty" (4 audyty adwersarialne). v2.102.1: puste zamiatania przy
  „wróg blisko" co 45 s (lądowanie nadal 20 s).
- 12:45 test „both": **PIERWSZE bojowe potwierdzenie ucieczki w powietrze**.
  v2.102.2: zegar zawrócenia od czasu odczytu zdarzeń (koniec dryfu +1 s/tick),
  detektor ręcznego zawrócenia nie zagłusza logu ZAWRÓCONA, BLITZ tylko przy
  nieaktywnym alarmie.

## AKTUALIZACJA 25.08 (24) — v2.99.1–2.99.6: ślepy alarm, szybszy skan, złom na 16

- v2.99.1 (20.08): ślepy alarm sam idzie po wzrok — wymuszony przegląd „/"
  po 5 min bez odczytu. v2.99.2 (22.08): skan asteroid 1–3 s między
  układami, limit nawigacji 450/h (decyzja ownera).
- v2.99.3–2.99.6: złom na [baza:16] zbierany naprawdę — sprawdzenie na
  każdym wejściu na galaktykę bazy, link z tooltipa/fallback po koordach
  (test-zlom.js); `recyclersHome()` czytało zwiad jak mapę, a to tablica →
  zawsze 0 recyklerów (naprawione); recycle wypięty ze strażników duplikatu
  (ekspedycje na ten sam cel blokowały wysyłkę); nieudana wysyłka zeruje
  10-min blokadę.

## AKTUALIZACJA 18.08 (23) — v2.99.0: kalibracja czasu lotu per-serwer (GENESIS)

Kontekst: 28.08 18:00 GMT startuje nowe uni **Genesis** (eco 2000x dynamiczne
od 500x +500x/tydz., fleet **x3** vs athena x4, defense debris 0%, ACS off,
podbity yield ekspedycji i asteroid). **Owner PRZENOSI się na Genesis i
porzuca athenę** (decyzja 18.08). Pełny audyt gotowości + config startowy
+ plan fazowy F0–F4: `AUDYT-GENESIS-2026-08-18.md`.

Jedyny twardy dług z audytu (P1) wdrożony w **v2.99.0**:

- **Problem**: `estimateFlightMinutes` = `max(11, ceil(11 + Δ/15))` — stałe
  z dwupunktowej kalibracji NA ATHENIE (x4). Na Genesis (x3) loty są ~4/3
  dłuższe → wzór ZANIŻA dolot, bramka TTL (margines 5 min) wypuszcza minery
  na asteroidy, które despawnują przed dolotem (strata slotu i paliwa).
- **Fix**: blok `FLIGHT-CAL` (markery) — `FlightCalibration`: przy każdej
  wysyłce górniczej krok 2 i tak czyta realny czas lotu (capturedFlightMs,
  v2.66.8); teraz para (Δ systemów, minuty) idzie do magazynu per-host
  (`ogamex_flight_cal`, cap 30 próbek). Po ≥2 próbkach o rozrzucie Δ≥20
  najmniejsze kwadraty liczą własne `a + b·Δ`; estimate = ceil + 2 min
  marginesu (bramka woli odpuścić asteroidę niż wysłać na despawn).
  Uczenie TYLKO z `asteroid_mining_direct` (jeden statek, 100% prędkości,
  ta sama galaktyka; start z launchAt misji, fallback HomeBase.mining() —
  to samo źródło, którym planer liczy dystanse). Ujemne nachylenie (szum)
  przycinane do 0. Do czasu nauki: stary wzór atheny (na x4 konserwatywny).
- Test `test-kalibracja-lotu.js` (26 checków, wykonuje blok): odtwarza
  kalibrację atheny z jej 2 punktów, scenariusz Genesis 4/3 (wzór atheny
  dawał 26 min przy Δ217, realnie 32), cap, zepsuty JSON, zamrożenia
  integracji. Bateria: wszystko OK.
- Efekt na Genesis: po pierwszych 2 lotach minerów w różne odległości bot
  sam się kalibruje — zero konfiguracji. Athena: nic się nie zmienia do
  czasu nauki, a po nauce estymaty tylko dokładniejsze.

Operacyjnie na dzień 0 Genesis (szczegóły w audycie): baseBody=PLANETA,
deutReserve=0, ntfy+Gemini wkleić od nowa (magazyn per-host pusty), fale
ekspedycji 1–2; tygodnie 1–3 zarabiają EKSPEDYCJE, farm martwy do ~04.09
(statusy (i) po 7 dniach), mining od odblokowania ASTEROID_MINER.

## AKTUALIZACJA 17.08 (22) — v2.98.2: fałszywy DISPATCH FAILED z własnego logu (podczas PRAWDZIWEGO ataku)

- INCYDENT 14:21-14:23: 3 floty ATTACK na księżyc [3:272:7] (dolot ~5 min).
  Ratunek księżyc→planeta załadował wszystko (9,5 mld HC + 4,3 mld minerów
  + 11 DS + 14 bln deuteru), kliknął Send — i dostał „DISPATCH FAILED!
  Error: 14:22:38 INCOMING: 4 foreign fleet(s)…". To NIE była odmowa gry:
  kontrola po-wysyłkowa szuka `[class*='error']` i złapała WŁASNY wpis
  logu (`<div class="log-entry error">INCOMING…</div>`) — alarm dopisał go
  w trakcie 3-krokowego formularza, log był otwarty. Gra flotę najpewniej
  PRZYJĘŁA (RECON 14:23:03: ships NONE — hangar pusty, flota w locie);
  bot mimo to skasował stempel duplikatów i uznał ratunek za nieudany.
- v2.98.2: errorMsg i successMsg wykluczają `#ogx-bot-panel` (symetrycznie:
  `[class*='success']` łapał `log-entry success` i mógł MASKOWAĆ prawdziwą
  odmowę). Ten sam wzorzec-lekcja co [ATAK DOM]/przyciski: KAŻDY odczyt
  DOM strony musi wykluczać własny panel — grep po `querySelector` bez
  `#ogx-bot-panel` przy następnym audycie.

## AKTUALIZACJA 17.08 (21) — v2.98.1: głośny alarm „mining martwy przez inną galaktykę"

- Incydent 10:03: asteroida [3:158:17] z TTL 91 min ODRZUCONA logiem
  „flight ~Infinitymin" — po przeprowadzce aktywne ciało = księżyc
  [2:151:9] (g2), pole „Start minerów (g:s:p)" PUSTE, więc punkt startu
  miningu podążał za aktywnym ciałem; asteroidy spawnują się tylko w g3
  → bramka TTL (inna galaktyka = Infinity, v2.82) odrzucała KAŻDE
  znalezisko. buildScanQueue filtruje zasięg tylko same-galaxy, więc bot
  w kółko skanował 63 systemy g3 i po cichu wyrzucał wyniki.
- Fix operacyjny: owner wpisuje „Start minerów" = ciało w g3, gdzie
  fizycznie stoją minery z deuterem (jak 3:272:7 przy v2.84).
- v2.98.1: skip międzygalaktyczny loguje BŁĄD (throttle 1 h) z instrukcją
  co uzupełnić — koniec cichej śmierci miningu tą ścieżką.

## AKTUALIZACJA 17.08 (20) — v2.98.0: przełącznik „Sekwencyjnie po kolei"

- Owner zgłosił (z Windows): „bot atakuje losowe osoby z przedziału zamiast
  po kolei 1→499". Diagnoza: to priorytet łupu z v2.97.0 (jego życzenie
  z 15.08) + okrążenia po bazie z v2.89 — kolejność wg opłacalności wygląda
  z boku losowo. Zakres i filtr rankingu były respektowane cały czas.
- Decyzja ownera: ma być PRZEŁĄCZNIK. v2.98.0 dodaje `sequentialSweep`
  (UI: „Sekwencyjnie po kolei", domyślnie OFF = priorytet łupu bez zmian).
  ON = każdy przebieg to pełne przemiatanie zakresów układ po układzie,
  cele w kolejności napotkania (bez laps, bez sortowania po łupie).
  Filtr rankingu, czarna lista i próg łupu działają w obu trybach.
  Przełączenie w UI robi `FarmState.clear()` — stara kolejka nie dokańcza
  się w nowym trybie. Configi bez klucza dostają OFF przez deepMerge.
- LEKCJA (Windows↔Mac): lokalne repo na Windows było na v2.90.2, a main na
  v2.97.4 — przed pracą ZAWSZE `git pull`, pierwszy patch poszedł do kosza.

## AKTUALIZACJA 15.08 (19) — v2.97.1–4: seeding łupów + dwa bugi z żywego seedowania

Seria po v2.97.0 (wszystko z obserwacji ownera na żywo):

- **v2.97.1**: zakładki dni dziennika i strony raportów przełączają się BEZ
  przeładowania — harvest (Combat+Plunder) doczytywany co 15 s; pozwala
  zassać historię: przeklikanie dni na profilu (farm od 13.08 — wcześniejsze
  dni puste). Endpoint `Partial_PlunderJournal` POTWIERDZONY na żywo 19:17
  (`[FARM LUP] dziennik (fetch): 383 wpisy`).
- **v2.97.2**: „POKAŻ BAZĘ CELÓW"/„TOP CELE" pisały do zwiniętego logu poza
  ekranem („klikam i nic się nie dzieje") — otwierają log + scroll. Przy
  okazji decyzja ownera: top-lista ma być automatem, nie widokiem — jest
  (sortowanie w dispatchNext + okrążeniach od v2.97.0).
- **v2.97.3**: dedup dziennika MARTWY przez kaskadę capa: lista seen (600)
  mniejsza niż widok (638 wierszy) — każdy dodany wpis wypychał ten, który
  za chwilę sprawdzaliśmy; bot uczył się tych samych 638 wpisów co 15 s
  (3× ta sama linia w logu). Nauka paczką (learnBatch: 1 odczyt + 1 zapis),
  cap 4000, test kaskady 650 wierszy. Dane niezepsute (EMA idempotentna).
- **v2.97.4**: INCYDENT 19:21 — formularz floty przestał aplikować parametry
  URL; korektor [CEL] (v2.66.5) poprawiał koordy, ale TYP celu zostawał
  „Moon" (formularz otwierał się z domyślnym celem = aktywny księżyc
  [4:132:8]) → gra odrzucała wysyłkę modalem „There is no planet or moons
  on this target", krok 3 padał timeoutami seriami. Fix: misje z `planet=1`
  w URL po korekcie koordów dopinają typ celu przełącznikiem
  `data-planet-type="1"` (ta sama mechanika co ratunek, sidebar wykluczony).

Bateria: 151 checków OK. OTWARTE: potwierdzenie na żywo dopięcia typu
(log `[CEL] typ celu dopiety na PLANETE`); jeśli przełącznika nie ma
w DOM — poprosić ownera o zrzut [MOON DOM].

## AKTUALIZACJA 15.08 (18) — v2.97.0: PRIORYTET ŁUPU (top-tier lista celów)

Życzenie ownera (~18:20, ze zrzutem Dziennika Grabieży): klasyfikacja
najlepszych celów i lista top-tier atakowana pierwsza — maksymalizacja
zysku, nie tracić limitu ataków/dobę na drobnicę. Rozrzut na żywo:
Abutre [4:372:3] 5,1 bln vs Ratatosk [4:378:x] ~240 mld = 20×.

**v2.97.0** (blok FARM-YIELD, markery):

- `FarmYieldDB`: koord → EMA łupu (α=0,5, bo łup rośnie z czasem od
  poprzedniego farmnięcia), liczba próbek, gracz; TTL 30 dni; mediana
  (wynik eksploracyjny dla nieznanych), sumy per system, top(n).
- `PlunderWatch`: dwa źródła — fetch `/home/Partial_PlunderJournal`
  (kandydat; bracia Asteroid/Expedition potwierdzeni na żywo; 0 wierszy
  → jednorazowy zrzut markupu) + `harvestDom` na stronie z „Plunder
  Journal" (profil gracza; parsuje czysty tekst, potwierdzone testem na
  wierszach 1:1 ze zrzutu). Dedup wpisów po koord|data. Self-throttle
  15 min, wołane z farm.run() + w init.
- `dispatchNext`: cele sortowane malejąco po znanym EMA; nieznane dostają
  MEDIANĘ znanych (eksploracja w środku kolejki); nowy config/panel
  `minTargetProfit` („Min. łup celu", 0=off) wycina ZNANĄ drobnicę —
  nieznane cele nigdy (baza musi się uczyć).
- `eligibleSystems` (okrążenie po bazie): systemy w kolejności sumy
  znanych łupów malejąco.
- Panel: przycisk „TOP CELE (lup)" — top 15 z medianą i progiem.

Test test-farm-lup.js (18 checków, wykonuje blok na wierszach 1:1)
ZŁAPAŁ bug przed wdrożeniem: chciwa klasa kwoty połykała spację i DATĘ
następnego wiersza (5,1e22, 1 wiersz zamiast 4) — kwota przepisana na
grupy tysięcy. Zluzowane jedno zamrożenie w test-farm-ban (filtr, nie
sąsiedztwo shift). Bateria: 145 OK.

Seeding: wejście na profil → Plunder Journal uczy bazę od ręki; przy
progu zacznij od ~300–500 mld dopiero PO kilku okrążeniach nauki.
OTWARTE: potwierdzenie endpointu Partial_PlunderJournal na żywo
(log `[FARM LUP] dziennik (fetch)` vs zrzut).

## AKTUALIZACJA 15.08 (17) — v2.96.0: CZARNA LISTA FARMY (raporty bojowe)

Zgłoszenie ownera ~09:40 ze zrzutem /messages: ostatnie ~10 ataków farmy
(po 30 mln HC) rozbiło się o obronę planet Sith Campeador w [4:36]–[4:37]
(raport: MCH straty 360.000.000, Resources 0, debris 288 mld) — nieaktywny
NIE znaczy bezbronny, a okrążenia wracały na te same koordy.

**v2.96.0** (blok FARM-BAN, markery do testu):

- `FarmBlacklist`: koordy z własnymi stratami > 0 → ban 14 dni (TTL,
  ponowny raport odświeża stempel).
- `CombatWatch`: dwa źródła banów — (a) fetch listy raportów bojowych
  (kandydaci `MessageCategoryType=FLEET_COMBAT/COMBAT/COMBAT_REPORTS`,
  działający adres zapamiętywany; żaden nie odpowie → jednorazowy log),
  (b) `harvestDom` na OTWARTEJ stronie /messages — parsuje czysty tekst
  widoczny na ekranie, działa na pewno (potwierdzone testem na tekście 1:1
  ze zrzutu ownera). Self-throttle 10 min, wołane z farm.run() przed
  każdą decyzją + w init na stronie wiadomości.
- Parser: fragment ZA tytułem raportu + wycięta data/godzina (test złapał
  bug: koordy [4:37:11] z nagłówka wpadały jako „straty 37"); pierwsza para
  „gracz : liczba" (poza Resources/Debris) = straty atakującego.
- Farm: collectTargets pomija zbanowane (licznik w logu), dispatchNext
  i afterSend filtrują kolejkę (cele sprzed bana).

Test: test-farm-ban.js WYKONUJE blok na sztucznym magazynie (parse na
żywym tekście, ban tylko przy stratach, TTL, integracje) — 15 checków.
Bateria: 128 OK. Seeding: wystarczy, że owner raz przejdzie strony
raportów (harvestDom zbierze wszystkie rozbite) ALBO endpoint odpowie.

OTWARTE: potwierdzenie, który kandydat endpointu combat działa na żywo
(log `[FARM BAN] endpoint raportow bojowych potwierdzony`).

## AKTUALIZACJA 15.08 (16) — v2.95.0: porażka farmy PARKOWAŁA skaner asteroid

Incydent ~09:00 (zgłoszenie ownera: „są asteroidy, a bot ich nie szuka, bo
farmi 4 galaktykę; mining ma pierwszeństwo"): w logu kręci się `Dispatch
cooldown: Xmin (last dispatch failed)`, farm mieli ataki #32–38, skaner stoi.

Sedno: stempel `ogamex_dispatch_fail_at` (10-minutowy cooldown SKANERA
asteroid po nieudanej wysyłce) był wbijany w 9 miejscach warunkiem
`!mission.expedition` — czyli przy porażce KAŻDEJ misji poza ekspedycjami,
także farmy/złomu/ratunku. V2.66.3 naprawiła to tylko dla ekspedycji; farm
był wtedy either/or z miningiem, więc nie bolało. Od v2.90.0 (równoległość)
jedna wpadka farmy (timeout kroku formularza itp.) = mining zaparkowany na
10 min przy wolnych asteroidach, a farm w tym czasie legalnie wypełnia okno
— dokładnie odwrotność zamierzonego priorytetu.

**v2.95.0**: helper `stampDispatchFailIfMining(mission)` — stempel pada
TYLKO gdy misja jest górnicza (macierz 5 flag, ta sama co przy zdejmowaniu
lotu z licznika minerów); wszystkie 9 miejsc przełączone. Priorytet bez
zmian: prawdziwa porażka MININGU dalej daje 10 min cooldownu.

Test: 3 zamrożenia w test-farm-start.js (helper+macierz, zero starych
stempli, min 8 wywołań); bateria 113 checków OK.

Uwaga kontekstowa: farm przeniesiony przez ownera na start [4:132:8]
(księżyc, 4 gala) — ping-pong ciał mining[3:272:7]↔farm[4:132:8] działa.

## AKTUALIZACJA 15.08 (15) — v2.94.0: audyt wydajności, 5 optymalizacji

Audyt po v2.93.0 (timery, magazyn, rendering, DOM). Werdykt: timery zdrowe
(obrona 30 s z 2 lekkimi AJAX-ami jak sama gra, TabLock 10 s po localStorage,
watchdog 60 s, status 5 s), console.log tylko 6 — główne koszty to były
serializacje i niewidoczny rendering:

1. **Dziennik logów z debouncem**: zapis do magazynu max 1/s (było: pełna
   serializacja 300 wpisów przy KAŻDEJ linii) + flush na `pagehide`, żeby
   wpisy sprzed samej nawigacji nie ginęły.
2. **updateLogUI**: log jest domyślnie ZWINIĘTY, a mimo to każda linia
   przebudowywała innerHTML 50 wpisów z escapeHTML — teraz pomijane przy
   zwiniętym; rozwinięcie (paint) od razu odmalowuje listę.
3. **ThreatLog.all() cache 30 s**: pasek statusu liczy summary() co 5 s,
   a każde wywołanie parsowało do 600 wpisów × 400 znaków; add() zeruje cache.
4. **FarmTargetDB.updateSystem**: większość systemów przemiatania jest pusta —
   porównanie przed/po pomija zapis całej bazy (dziesiątki KB) na taki system;
   systemy z celami dalej zapisują (świeży seenAt dla TTL).
5. (v2.93.0, dla kompletu) location.replace() + przycinanie wpisów do 600 zn.

Testy: test-nawigacja-log rozszerzony o 5 zamrożeń; bateria 110 checków OK.
Poza zakresem (świadomie): throttling ukrytej karty — to przeglądarka, jedyne
lekarstwo to klik odblokowujący dźwięk podtrzymujący; oraz koszt samych
nawigacji gry (pełne przeładowania) — to rytm anty-detekcji, nie marnotrawstwo.

## AKTUALIZACJA 15.08 (14) — v2.93.0: higiena wydajności (Firefox mulił)

Obserwacja ownera ~10:00: Firefox i strony gry lagują po kilku godzinach
pracy bota. Dwie przyczyny po stronie bota, obie zdjęte:

1. **Historia karty**: wszystkie 39 programowych nawigacji szło przez
   `window.location.href =` — każda dokłada wpis do historii karty, bot robi
   tysiące przeładowań dziennie, a Firefox serializuje historię sesji w tle →
   po godzinach muli cała przeglądarka. Teraz WSZĘDZIE `location.replace()`
   (dla serwera identyczny GET, historia nie rośnie). Kliknięcia w prawdziwe
   elementy (`.click()`) bez zmian.
2. **Dziennik logów**: 300 wpisów serializowanych do magazynu przy KAŻDYM
   wpisie, a zrzuty debugowe (step3-clickables itp.) mają ~10 KB/linia —
   megabajtowe JSON-y mieliły CPU non stop. log() przycina wpisy do 600
   znaków przed zapisem (znacznik „[uciete]"); na żywo pełny tekst.

Test: test-nawigacja-log.js (zero href=, min 30 replace(), przycinanie w
log()); bateria 105 checków OK. Kontekst dnia: throttling ukrytej karty
(dźwięk podtrzymujący czeka na klik po restarcie przeglądarki) spowolnił
skan ~30× i farm głodował priorytetem — po kliknięciu w kartę wraca samo.
Ekonomia z dzienników 15.08: mining 393,6 bln/dzień vs farm 4,5 bln/dzień
(1 lot minerów ≈ 12× cały dzień farmy) — priorytet mining>farm słuszny.

OTWARTE: ewentualny bezpiecznik „farm dostaje okno, gdy skan miningu stoi
>X min" — czeka na decyzję ownera (zmienia świadomy priorytet v2.90.0).

## AKTUALIZACJA 14.08 (13) — v2.92.0: izolacja per-uni NAPRAWDĘ działa (bug od v2.9.0)

Incydent 22:11: owner zalogował się świeżym kontem na **vega.ogamex.net** —
bot pokazał config, kolejkę farmy („6 targets queued", reserve 4), liczniki
bonusów i stan minerów Z ATHENY i próbował działać. Diagnoza: izolacja v2.9.0
nadpisywała `window.GM_setValue/getValue`, ale w sandboxie Tampermonkeya gołe
identyfikatory GM_* rozwiązują się w scope sandboxa, nie przez window —
nadpiska była MARTWA od zawsze; wszystkie uni dzieliły jeden nieprefiksowany
magazyn (migracja nexus→athena „działała" tylko dlatego).

**v2.92.0**: oryginały łapane top-level PRZED IIFE (`__gmGetRaw/__gmSetRaw`),
wewnątrz IIFE `GM_getValue/GM_setValue` cieniowane constami z prefiksem
`location.host:` — każde z ~580 istniejących wywołań trafia w wrappery
leksykalnie. Fallback migracyjny: TYLKO athena czyta stare nieprefiksowane
klucze (zapisy już prefiksowane, prefiks z czasem przejmuje wszystko). Inne
uni startują z czystą kartą → DEFAULT_CONFIG (enabled:false) = bot na Vedze
po aktualizacji stoi, dopóki owner świadomie go nie skonfiguruje.

Test: test-uni-izolacja.js WYKONUJE blok UNI-ISO na sztucznym magazynie
(Vega nie widzi Atheny, zapisy nie krzyżują się, fallback tylko athena)
+ zamrożenie kształtu (capture przed IIFE, zero window.GM_*). Cała bateria OK.

UWAGA operacyjna: do czasu aktualizacji TM na maszynie ownera NIE klikać
w panel na Vedze (zapisy lecą do wspólnego magazynu i psują Athenę).
Śmieci, które Vega zdążyła zapisać przed fixem (np. licznik online bonus
„#3 today"), zostają w legacy — athena je z czasem nadpisze prefiksowanymi.

## AKTUALIZACJA 14.08 (12) — v2.91.0: „Start farmienia" — farm atakuje z wpisanych koordów

Decyzja ownera (20:55): galaktyka 3 przefarmiona, przenosimy farm do innej
galaktyki (np. 4), ale flota ma MIESZKAĆ na księżycu bazy — farm dostaje
punkt startu jak minery/ekspedycje.

- Panel: nowe pole „Start farmienia (g:s:p)" pod Ranges (ten sam
  bindLaunchFrom co minery/ekspedycje; puste = stare zachowanie v2.74.8:
  start z aktywnego ciała).
- `HomeBase.farm()`: wpisane koordy → forModule (sztywna para + ciało wg
  trybu KSIĘŻYC); puste → null, misja nie niesie launchAt.
- Brama v2.84 w select_ships_direct wpuszcza teraz farm: `!mission.farm`
  zdjęty z guardu launchAt (farm bez koordów i tak nie ma launchAt), a
  korekta ciała trybu KSIĘŻYC to `(!mission.farm || mission.launchAt)` —
  farm ze sztywnym startem dostaje pełną korektę pary i ciała, farm bez
  koordów zostaje przy decyzji v2.74.8.
- Test: test-farm-start.js (7 bezpieczników na źródle) dopisany do
  test-all.js; cała bateria + składnia OK.

Użycie: w polu „Start farmienia" wpisać 3:269:8 (tryb KSIĘŻYC sam wybierze
księżyc pary), w Ranges np. `4:1-499`. Zmiana zakresów sama czyści bazę celów
i wymusza pełny skan. UWAGA: loty międzygalaktyczne są DŁUGIE — tempo okrążeń
spadnie; ranking ≤ 800 dalej filtruje cele.

OTWARTE: pierwszy atak z bramą launchAt na żywo (patrzeć na log
`[START] misja inactive_farm_direct startuje z …`); klik „TEST: symulacja
ataku" po wgraniu.

## AKTUALIZACJA 14.08 (11) — v2.90.1/2: okrążenie po przerwie + INCYDENT puli wysyłek

- v2.90.1: start po przerwie (np. rano) z niepustą bazą = najpierw JEDNO
  okrążenie po znanych celach, pełny skan zaraz po (flaga stale_lap_done).
- **INCYDENT 11:00-11:21 (na 2.90.0): klincz priorytetu.** Farm wysłał 76
  ataków, każdy `RateLimiter.record()` → pula 20 wysyłek/h zapchana → mining
  stał na `canAct()` („Rate limit reached") z WOLNĄ asteroidą (TTL 47 min),
  a farm mu „ustępował" (predykat widział mining jako aktywny). Nikt nie
  pracował ponad 20 min. **v2.90.2**: ataki farmy NIE zapisują się do puli
  minerów — ten sam świadomy wzorzec co ekspedycje (komentarz przy
  expedition_direct); pula 20/h ma JEDNEGO konsumenta bramki: skaner
  asteroid. Tempo farmy ograniczają humanizer + NavRateLimiter (wspólny).
  Jednorazowa migracja czyści zapchaną pulę (inaczej mining stałby do
  godziny po wgraniu poprawki). LEKCJA: przy łączeniu modułów sprawdź
  WSZYSTKIE wspólne zasoby (sloty, pending_mission, RateLimiter, NavRate) —
  priorytet na jednym zasobie nie chroni przed inwersją na innym.

## AKTUALIZACJA 14.08 (10) — v2.90.0: koniec either/or, mining > farming

- v2.89.0 potwierdzona bojowo (09:37-09:40): parser rankingu trafia w markup
  (rank 361/728/656 zaatakowane, 28 pustych pominiętych w 7 systemach, zero
  [FARM RANK DOM]). Jeden atak przepadł na ZNANYM wyścigu formularza
  (Next disabled → step 2 timeout) — kolejne dwa przeszły czysto.
- Owner: mining zarabia więcej → asteroidy mają pierwszeństwo. Problem:
  moduły były EITHER/OR — włączenie farmy WYŁĄCZAŁO mining (widoczne w logu
  09:37:39). v2.90.0: oba moduły mogą być ON naraz; farm rusza się TYLKO gdy
  skaner asteroid śpi: minery w locie (fleet_return_at>now; parallel ZERUJE
  ten timer gdy dalej skanuje!), cooldown po porażce wysyłki (10 min) albo
  przerwa między skanami (scan_cooldown_until). Predykat farmYieldsToMining
  (blok FARM-PRIO) + test-farm-priorytet.js (10 przypadków).
- Stan farmy nietknięty przy ustąpieniu — przerwane okrążenie samo wznawia
  się w następnym oknie. Status sekcji: „Czeka — mining ma pierwszeństwo…".
- Kosmetyka: logi wysyłki po typie misji (koniec „direct asteroid"/„Asteroid
  Miners" przy atakach farmy); uczenie ładowności minerów pomija loty
  farm/ekspedycja/złom (szum „Odrzucam odczyt ładowności 463 750").
- PO WGRANIU: włączyć OBA moduły i sprawdzić rytm w logu — mining skanuje,
  po „Miners in flight" farm przejmuje okno, po powrocie minerów ustępuje.

## AKTUALIZACJA 14.08 (9) — v2.89.0: farm z filtrem rankingu + baza celów

- Problem (owner): bot atakował KAŻDEGO nieaktywnego; łup z graczy z końca
  rankingu (2000+) nie zwracał czasu lotu — puste kolonie zjadały sloty.
- Ranking bierzemy z tooltipa gracza w wierszu galaktyki („Ranking: 2.881").
  Parser czyta tekst wiersza ORAZ atrybuty data-tooltip-content/title/data-title;
  separatory tysięcy: kropka/przecinek/nbsp/spacja. **Nieznany ranking =
  fail-open (atakuj) + jednorazowy zrzut [FARM RANK DOM]** — jeśli markup forka
  jest inny, bot NIE ślepnie, tylko prosi o zrzut do utwardzenia parsera.
- Nowe ustawienia farmy: **Max ranking celu** (domyślnie 800; 0 = bez filtra,
  do limitu WŁĄCZNIE) i **Pełny skan co (h)** (domyślnie 12).
- **Baza celów** (`ogamex_farm_target_db`): pełny skan zakresów buduje bazę
  (koordy + gracz + ranking + seenAt); między pełnymi skanami bot robi
  OKRĄŻENIA tylko po systemach ze znanymi celami w limicie → minuty zamiast
  ~2 h, tłuste cele obrywają wielokrotnie częściej. Każda wizyta w systemie
  NADPISUJE jego wpisy (cel, który ożył, wypada), wpisy niewidziane 7 dni
  gasną. Przycisk **POKAŻ BAZĘ CELÓW** wypisuje bazę do dziennika.
- Stempel pełnego skanu stawiany dopiero na KOŃCU przebiegu (przerwany skan
  nie udaje świeżej bazy). Zmiana zakresów zeruje stempel → wymusza pełny skan.
- test-farm-rank.js (17 przypadków) w test-all; wszystkie testy czytające
  źródło bota dostały normalizację CRLF (checkout z autocrlf psuł markery
  z `\n` — bramki wysyłek i ratunek nietykalny padały na świeżym checkoucie).
- DO ZROBIENIA PO WGRANIU: sprawdzić w dzienniku, czy przy pełnym skanie
  pojawia się `rank N` przy celach; jeśli leci [FARM RANK DOM] — wkleić zrzut.

## AKTUALIZACJA 12.08 (8) — TEST ŚLEPEGO PASKA zaliczony E2E na 2.88.1 + v2.88.2 (panel forka)

- 16:09–16:14: symulacja ślepego paska przeszła CAŁY cykl w prawdziwej grze:
  kandydat → alarm → ratunek do domu floty → pusty hangar planety → sam
  przełączył się na księżyc → koniec symulacji → auto-powrót → straż zdjęta.
  Autotest na maszynie ownera: 41/41.
- Wcześniej (15:26–15:30, jeszcze 2.87.3) bot obronił się SAM w prawdziwej
  bitwie: ślepy pasek → ratunek; BLITZ (dolot 3 s) bez potwierdzania;
  KOLEJKA (drugi atak na inną kolonię); bezpiecznik obcej kolonii wykrył
  formularz na złej parze i sam się poprawił. Ataki wroga = wabiki
  (1 sonda na misji ATTACK) z NOWEGO księżyca wroga **[3:276:9]** —
  falanga prawdopodobnie sięga księżyca minerów [3:272:7].
- Zrzut [EVENTS DOM] spalił się na PUSTYM kontenerze — „obcy” był
  z symulacji, panel słusznie nic nie renderował. Ale zdradził kontener:
  `#layoutFleetMovements > #fleet-movement-content`.
- **v2.88.2**: kształt B panelu — `tr[class*='row-mission-type-']`
  w kontenerze forka czytany PRAWDZIWYM `FleetMovements.classifyRow`
  (zero zgadywania); niepewna numeracja wyłącza tylko kształt liczbowy;
  zrzut nie odpala się na symulacji ani pustym kontenerze, klucz
  przezbrojony. Zamrażarka: 46 bezpieczników.
- Księżyce wroga (kompletna lista): [2:277:11], [5:67:11], [3:245:7],
  [3:276:9]. Relokacja floty: omijać WSZYSTKIE te okolice.
- OTWARTE: pole „Start ekspedycji” wciąż 2:277:8 (ratunki celują w starą
  bazę); markup WROGIEGO wiersza panelu — potwierdzi go pierwszy prawdziwy
  atak („panel Events dołożył N” = kształt B działa).

## AKTUALIZACJA 12.08 (7) — INCYDENT 15:24: pasek bez „Own” = totalna ślepota → v2.88.1

ACS 450 mld na księżyc [3:272:7], dolot ~4 min. Bot NIE zareagował w ogóle
(zero alarmu, zero pusha) — owner uciekł ręcznie. Diagnoza z żywego logu:

1. **BUG parsera paska (główna przyczyna)**: regex wymagał segmentu „X Own”.
   Owner nie miał ŻADNYCH własnych lotów, więc pasek pokazywał
   `2 Missions: 2 Hostile` — bez „Own” → `read()` = null = „brak paska na tej
   stronie” → cache sprzed ataku mówił „czysto”. Bot był ślepy DOKŁADNIE
   wtedy, gdy cała flota stała w domu (najgroźniejszy moment).
2. Bot chodził na 2.87.3 — lekarstwo (czytnik panelu Events, 2.88.0) leżało
   na mainie od 40 min; Tampermonkey sprawdza aktualizacje raz na dobę.
3. „Start ekspedycji” dalej wskazywał stare 2:277:8 — nawet sprawny ślepy
   alarm broniłby złej kolonii.

**v2.88.1** (wszystkie trzy ogniwa zabezpieczone, 42 bezpieczniki w teście):

- `ThreatMonitor.parseBar(text)` — CZYSTA funkcja: `Own`/`Hostile`/`Friendly`
  wszystkie opcjonalne; jawne „Hostile” = twarda liczba wrogów. Macierz
  w teście offline + autotest w przeglądarce (34→41 checków).
- `UpdateWatch` — co 30 min porównuje @version z repo (raw.githubusercontent,
  nowy @connect); starsza lokalna = czerwony log co tick + dziennik BŁĄD
  z pushem (nag co 6 h / na nową wersję). Niczego sam nie aktualizuje.
- `FleetRecon.homeGuard` — hangar-mapa per para koordów (max z 48 h chroni
  przed fałszywką przy nocnym FS); największa flota ≠ pole „Start
  ekspedycji” (≥1 mld i ≥2× max domu) = log ERROR + dziennik BŁĄD z pushem.
  Progi wykluczają księżyc minerów (7,5 mld) obok floty głównej (setki mld).

OTWARTE po tej wersji: owner musi RAZ zaktualizować TM ręcznie (strażnik
wersji chroni dopiero od 2.88.1 w górę) i ustawić „Start ekspedycji” na
realny dom floty; potem strażnicy pilnują obu rzeczy sami.

## AKTUALIZACJA 12.08 (6) — popołudniowa wojna + seria 2.86.4→2.88.0

Wróg (Ibra646) po utracie łupu z 13:10 eskalował: księżyce bojowe w DWÓCH
układach ownera ([2:277:11], [5:67:11]) + trzeci gracz z [3:245:7]; sondy co
minutę, wabiki, podwójne ataki na obie strony pary, Gwiazdy Śmierci na
porzucone księżyce (~15:05). Flota główna ocalona (ręczny Deploy ownera
o 14:29 + relokacje). Każdy incydent = fix z testem w ciągu godziny:

- 2.86.4: push ⚔️ tylko przy POTWIERDZONYM alarmie.
- 2.86.5: lądowanie ratunku wg realnego czasu lotu (lastFlightMs);
  ślepa ścieżka → switchTo na dom floty; lot międzykolonijny → KSIĘŻYC;
  ręczny RATUJ chroni aktywną parę.
- 2.87.0: AUDYT WYKONYWALNY — resolveRescueTarget (pure + macierze offline
  i w autoteście), symulacja ŚLEPEGO PASKA (E2E ścieżki z 13:10 na żywo),
  zwykła symulacja celuje w dom floty.
- 2.87.1: uzbrojona straż PYTA AirSave przy ataku na oba ciała strzeżonej
  pary (incydent 14:28 — głuche return false; uratował ręczny Deploy).
- 2.87.2: switch_to_body po KOORDACH Z TEKSTU (pairAnchor) + formularz
  ratunku NIGDY nie wysyła z obcej kolonii (incydent 14:35: powrót załadował
  hangar Colony 11 — 4 kolonizatory + 849 mld — i wysłał do 5:67:5).
- 2.87.3: sonda policzona przez listę ≠ brakujący wiersz — pasek wygrywa
  tylko NADWYŻKĄ ponad (ataki+sondy); koniec ratunków na skany (14:38-14:50).
- 2.88.0 (P0-A): PANEL EVENTS z żywego DOM jako trzecie źródło — czytany
  kształtem z fetchServerEvents (tr.eventFleet), wiersze dołączają do
  klasyfikacji (cel+dolot+ciało → blitz i air-save działają dla ataków
  niewidzialnych dla listy), cache 3 min; fork bez tr.eventFleet =
  jednorazowy zrzut [EVENTS DOM] (czekamy na wklejkę ownera → selektory
  z faktów w 2.88.1). Zamrażarka: 23 checki, autotest ~34.

OTWARTE: potwierdzenie kształtu panelu Events na żywo (zrzut [EVENTS DOM]
albo działający merge „panel dołożył N wierszy"); relokacja floty do układu
BEZ wrogich księżyców (w toku — [5:67] też ma wrogi księżyc!); pierwszy
bojowy lot AirSave; „Start ekspedycji" do zaktualizowania po osiedleniu.

---

## AKTUALIZACJA 12.08 (5) — KATASTROFA 13:10 i seria 2.85.1→2.86.5

**UTRATA FLOTY GŁÓWNEJ 13:10** (Ibra646 [2:277:11], księżyc w układzie ownera,
~200 mld statków, loot 74 bln). Sekcja zwłok i lekcje: patrz pamięć projektu
+ test-cel-ratunku.js (15 bezpieczników zamrożonych na źródle).

Nowy model zagrożenia: wróg NA KSIĘŻYCU w układzie ownera — falanga na
planetę, sondy co minutę, loty NIEWIDZIALNE dla fleetmovementlist ORAZ
zdarzeń serwera (3× potwierdzone; tylko pasek je liczy), wabiki
wyślij-zawróć, wywiad przez „sojusznika" (HOLD 017 przed uderzeniem).

Wydania dnia (wszystkie z testami, od 2.86.3 z rytuałem symulacji):
- 2.85.1: ratunek bez celu → aktywna para (WSPÓŁWINNE katastrofy z v2.84
  auto-przełączaniem — bot bronił kolonii, przy której PRACOWAŁ).
- 2.86.0/2.86.1: gotowość 10 s po wabiku / po sondzie.
- 2.86.2: row-friendly-mission ≠ atak (sojusznik 017; autotest 25/25).
- 2.86.3: PO KATASTROFIE — ratunek bez celu broni DOMU FLOTY
  (expeditions.launchFrom); pasek cache 3 min + WYGRYWA z kłamiącą listą.
  Bojowo potwierdzone 13:41 (wykrył jego niewidzialne floty, ratunek do
  domu floty, wróg zawrócił).
- 2.86.4: push ⚔️ dopiero przy POTWIERDZONYM alarmie (sondy pchały syrenę).
- 2.86.5: lądowanie ratunku wg REALNEGO czasu lotu (lastFlightMs; 13:41
  ratunek 38 min lądował bez opieki, bo automat zakładał hop <130 s);
  ślepa ścieżka syntetyzuje cel=dom floty i idzie przez switchTo (skok
  w parze zamiast lotu międzykolonijnego); lot międzykolonijny → KSIĘŻYC;
  ręczny RATUJ chroni aktywną parę.

OTWARTE P0-A (następne, osobne wydanie + symulacja): czytnik panelu Events
z DOM (cel+ciało+dolot dla ataków niewidzialnych dla endpointów — przywraca
blitz i ucieczkę w powietrze przeciwko atakom z układu). STRATEGICZNE:
przeprowadzka domu floty poza układ [2:277] (falanga+sondy Ibry) — decyzja
ownera w toku.

---

## AKTUALIZACJA 12.08 (4) — v2.85.0: UCIECZKA W POWIETRZE + kolejka wg ETA + ciało per kolonia

Zielone światło ownera na P1+P2 z audytu. Zamyka JEDYNY scenariusz utraty
floty: atak na OBA ciała jednej pary naraz (GS „zniszcz księżyc" + atak na
planetę) — ewakuacja w obrębie pary przenosiła flotę pod drugie uderzenie.

**AirSave (moduł, po FleetSave):** gdy `ev.targetBodiesAll[kolonia]` ma oba
ciała → zamiast swapa CAŁA flota+surowce (− rezerwa deuteru) leci powolnym
Deployem (prędkość z `fleetSave.speedPercent`, domyślnie 10%) do najbliższej
innej kolonii i jest ZAWRACANA po ostatnim dolocie ataku + 2 min
(x_btn_fleet_return — ta sama kontrolka co FS). Warstwa NA istniejącej
ścieżce: decyzja w MoonSave.run() (sweep/kolejka/ręczny RATUJ = po staremu);
każda porażka (brak refugium, lot za krótki wg bramki arytmetyki na kroku 2,
5× nieudane zawrócenie) = głośny wpis + markFailed → powrót na zwykły
ratunek na 10 min. Przełącznik w panelu Obrona („Ucieczka w powietrze"),
domyślnie ON. Zegar w pętli obrony (AirSave.tick przed FS.tick).
Test: `test-ucieczka.js` (decyzja + arytmetyka zawrócenia, 14 przypadków).

**P2 precyzja:** `ev.targets` sortowane wg NAJKRÓTSZEGO dolotu (kolonia
z najbliższym uderzeniem ratowana pierwsza — dotyczy też kolejki), nowe mapy
`ev.targetBodies` (ciało celu PER KOLONIA — flipy na formularzu i strażnik
bezpiecznej strony czytają per-kolonia zamiast globalnego 1. wiersza),
`ev.targetBodiesAll` (zestaw ciał — wyzwalacz ucieczki; strażnik bezpiecznej
strony WYŁĄCZA się przy obu ciałach), `ev.targetMaxEta` (zegar zawrócenia).

NIEPRZETESTOWANE NA ŻYWO: pierwszy realny atak na oba ciała = pierwsza
bojowa próba ucieczki. Symulacja ataku NIE ćwiczy tej ścieżki (syntetyczne
zdarzenia nie mają targetBodiesAll) — celowo, żeby nie wysyłała floty na
wielogodzinny lot przy każdym teście.

---

## AKTUALIZACJA 12.08 (3) — v2.84.0: punkt startu PER MODUŁ (minery ≠ ekspedycje)

Problem ownera: asteroidy spawnują się ZAWSZE w g3 (tam większość planet),
a ekspedycje po przeprowadzce lecą z g2 — po 2.82.0 („start z aktywnego
ciała") minery były martwe, bo asteroidy z g3 wypadały na bramce „inna
galaktyka niż punkt startu".

Rozwiązanie: `asteroidMining.launchFrom` + `expeditions.launchFrom`
(pola „g:s:p" w panelu; puste = z aktywnego ciała, jak w 2.82.0):
- Misja dostaje `launchAt` przy TWORZENIU; nowa bramka w handlePendingMission
  (przed bramką księżycową) porównuje aktywną parę z launchAt — inna para →
  klik właściwego wpisu na pasku planet (księżyc przy baseBody=moon,
  fallback planeta gdy para bez księżyca) → switch_planet_then_fleet →
  formularz. Koordy spoza listy planet = głośny error + start z aktywnego.
- Minery: kolejka skanu/TTL/dispatch liczone od `HomeBase.mining()`.
- Ekspedycje: cel = poz. 16 systemu `HomeBase.expo()` (launchFrom → stare
  `expeditions.base` → aktywne ciało); powroty wracają na ciało startu (gra).
- Złom (DebrisCollector) chodzi za punktem startu EKSPEDYCJI (tam leżą pola
  po falach; recyklery mieszkają przy flocie ekspedycyjnej).
- Farm/FS/ratunek — bez zmian (własna logika startu).

Operacyjnie: owner wpisuje start minerów 3:272:7 (księżyc, minery+deuter
muszą tam FIZYCZNIE stać), ekspedycje puste (lecą stamtąd, gdzie stoi)
albo przypięte do księżyca w g2. UWAGA: bramka paliwa czyta deuter z
AKTYWNEGO ciała — przy sztywnym starcie odczyt bywa z innego ciała
(fail-open; realna odmowa i tak wyjdzie na formularzu).

---

## AKTUALIZACJA 12.08 (2) — v2.83.0: PROM na przełącznik (OFF) + OFF przerywa formularz

Feedback ownera po porannym logu (jeszcze na 2.81.0):
1. **PROM domyślnie WYŁĄCZONY** (`moonFerry.enabled:false`, przycisk „PROM
   planeta→księżyc" w sekcji Mining, confirm przy włączaniu). 08:48 prom tuż
   po starcie sam wywiózł całą flotę + 11,8 bln deuteru na księżyc — owner
   nie chce, by bot KIEDYKOLWIEK przenosił flotę bez wyraźnej zgody.
   Samonaprawa „flota na złym ciele" działa tylko przy PROM=ON.
2. **OFF = STOP także w środku 3-krokowego formularza**: v2.68.4 przerywała
   misję tylko przy wznowieniu po przeładowaniu; klik OFF w trakcie kroków
   nie był sprawdzany (08:48:42 OFF → 08:48:43 fala i tak wyszła). Nowy
   `offAbort()` przed klikiem step1→2, step2→3 i przed „Send fleet".
   Wyjątek bez zmian: ratunek (moonSave) zawsze dokańcza.

---

## AKTUALIZACJA 12.08 — v2.82.0: START Z AKTUALNEGO CIAŁA (HomeBase)

**Decyzja ownera:** agresywni sąsiedzi → mining i ekspedycje mają startować
z planety/księżyca AKTYWNEGO w pasku planet, nie ze sztywnej bazy [3:272:7].
Zmiana miejsca startu = przełączenie planety w grze, zero konfiguracji.

Nowy moduł `HomeBase` (koordy aktywnego ciała z paska planet + cache GM
`ogamex_home_body`; fallback `minerBase`). Konsumenci przełączeni na dynamikę:
- **Mining**: kolejka skanu, TTL-vs-dolot, dispatch (auto+ręczny) liczą od
  aktywnego ciała; asteroida w innej galaktyce niż aktywne ciało = pomijana.
- **Ekspedycje**: fale lecą na poz. 16 systemu aktywnego ciała
  (`expeditions.base` zostało jako świadome sztywne nadpisanie, null = podążaj).
- **Złom (DebrisCollector)**: zagląda na galaktykę aktywnego układu.
  UWAGA: złom po ekspedycjach z POPRZEDNIEGO miejsca startu zostaje tam —
  zebrać ręcznie albo wrócić ciałem.
- **Prom (MoonFerry)**: planeta → księżyc AKTUALNEGO układu; układ bez
  księżyca = prom pominięty (stempel 2 h).
- **Tryb księżycowy** (`baseBody:"moon"`): dokręca tylko CIAŁO w obrębie
  aktualnej pary (planeta→jej księżyc). Układ bez księżyca = start z planety
  + głośny warn (falanga widzi lot).
- **Bezpiecznik w switch_to_body**: szukanie księżyca pary STOPUJE na
  następnym wpisie planety — bezksiężycowa para nie „pożyczy" już cudzego
  księżyca z listy.

NIETKNIĘTE: obrona (ratunek/straż/RescueQueue), FS (od v2.75.0 i tak startuje
z aktywnego księżyca), farm (od v2.74.8 startuje z aktualnego ciała).
`minerBase` w configu zostaje wyłącznie jako fallback, gdy nie widać paska.

---

## AKTUALIZACJA 05.08 ~23:40 (dom) — przenosiny bazy + FS potwierdzony

**BAZA PRZENIESIONA: [3:269:8] → [3:272:7]** (agresor „Ay"/Sniper wskoczył do
starego układu na 3 min lotu; 40 mld Reaperów odparte o 22:21 automatem).
Migracja v2.73.0 + bezpiecznik misji-min v2.73.1/2 (misja ratunku na ciało
spoza listy planet = porzucenie + zdjęcie straży). W nowym układzie na
poz. 15 siedzi Sniper Nova (i) — na razie nieaktywny, ale to sąsiad-ryzyko.

**FS DZIAŁA end-to-end** (3 cykle na żywo): wysyłka → auto-zawrócenie klikiem
(x_btn_fleet_return; bot sam rozwija listę flot od v2.74.0) → powrót.
Trasa [3:272:7]→[3:272:2] (księżyc Colony 27): 10% = 263 min (maks FS 8,7 h),
**3% = 878 min (maks FS ~29 h — całonocny)**; 3%/5% dozwolone od v2.74.1.

Nowe w v2.72–2.74.2: farmienie z jawnym ATTACK + wybór statku (LC/HC/BS),
alarm głosowy + syrena 10 s na laptopie, wersja w nagłówku panelu,
**rezerwa deuteru** (domyślnie 1 mld zostaje przy ratunku/FS — paliwo dla
flot wracających z ekspedycji, pole w Obronie), **weryfikacja pól statków
po wpisaniu** (formularz gubi pojedyncze pola po re-renderze — 23:22
BATTLE_CRUISER 1,38 mld został w domu; teraz odczyt zwrotny + dopisanie).

OTWARTE: event idle farming (planeta po przenosinach ma ~30 min blokady
misji ofensywnych; farmienie nieprzetestowane na żywo — patrz sekcja
FARMIENIE), pierwszy atak w nowym układzie = test v2.70.3.

## PRZECZYTAJ NAJPIERW — PRZEKAZANIE 05.08 (praca → dom)

**Priorytet ownera, wprost: „Obrona floty jest najważniejsza i nie może raz
działać raz nie."** Wszystko inne jest drugorzędne. Zanim cokolwiek zmienisz
w obronie — przeczytaj tę sekcję i incydent 16:18 poniżej w całości.

### Co się dziś wydarzyło (2026-08-05) — trzy prawdziwe ataki, jeden bug

Obrona odparła **3 ataki** w pełni automatycznie (wykrycie → ewakuacja na
drugie ciało w ~24 s → napastnik zawraca → auto-powrót). ZERO strat floty:

1. **12:30** — atak z [3:248:11] „Moon" (87,2 mld Battleship). Ewakuacja
   księżyc→planeta, powrót 12:32 „planeta → księżyc" ✓ poprawnie.
2. **15:09** — atak „HOME" z [3:254:9] (4 floty, ~190 mld). Jak wyżej ✓.
   (HOME to niemal na pewno Sniper Grus — ten od masakry 11:00, gdy bot
   był OFF; liczba Reaperów się zgadza.)
3. **16:18** — znowu [3:248:11] (87,2 mld BS, dolot 5 min). Ewakuacja OK,
   napastnik zawrócił, ALE powrót odstawił flotę na **PLANETĘ** zamiast na
   księżyc. To NIE była awaria powrotu — to **flip pustego hangaru**:

### Incydent 16:18 — anatomia buga (v2.70.3 naprawia)

Sekwencja z dziennika: 16:18:58 ratunek księżyc→planeta ✓ → 16:20:40 straż
wielofalowa (zamiatanie co 90 s) robi drugi przebieg → 16:20:52 zastaje
**pusty hangar na księżycu przy trwającym alarmie** → stary „flip" uznaje
„flota pewnie na drugim ciele" → **przenosi flotę z bezpiecznej planety
Z POWROTEM na atakowany księżyc** (dolot 16 s przed uderzeniem! uratował
nas tylko odwrót wroga) i **nadpisuje homeBody=planet** w notatkach straży
→ 16:22:11 powrót sumiennie odstawia flotę „do domu" = na planetę.

**Dlaczego „raz działa, raz nie":** flip odpalał TYLKO gdy alarm trwał na
tyle długo, że zamiatanie trafiło na pusty hangar. W atakach 1-2 wróg
zawrócił szybko → flip nie wykonał się wcale → wszystko działało. Bug był
timing-dependent, siedział w kodzie od v2.66.0.

**Fix v2.70.3 (live, pushnięte ~16:30):** flip wyłącznie przy PIERWSZYM
ratunku alarmu — warunek `!mission.moonReturn && !mission.flippedBody &&
!mission.sweep && saves<=1 && ThreatMonitor.active() && atkB!==hereB`
(ogamex-bot.user.js, gałąź moonSave w select_ships_direct, szukaj
„v2.70.3"). Zamiatanie z pustym hangarem = „nic nowego nie wylądowało",
koniec. Flip nigdy nie może też celować w ciało, w które leci atak.

### v2.71.0 — PROM planeta→księżyc (samonaprawa, pushnięte ~17:00)

Moduł `MoonFerry` (przed DebrisCollector) + hook w schedulerTick (za
OnlineBonus). W trybie księżycowym co 2 h (pierwszy kurs OD RAZU po
aktualizacji) tworzy misję `moon_ferry_direct`: przewozi WSZYSTKO z planety
na księżyc (ta sama maszyneria co ratunek: Deploy + wszystkie statki
+ surowce). Kluczowe flagi misji: `moonSave:true` (obsługa formularza),
`ferry:true` (własne wpisy „odczyt/PROM" w dzienniku — NIE fałszuje
liczników obrony), `sweep:true` (twardo wyłącza flip). Pusta planeta =
cichy abort („nothing on this planet to save"). Ustępuje wszystkiemu:
alarm/straż/pending/przerwy/okno nocne (patrz `MoonFerry.due()`).
Efekt: każdy stan „flota na złym ciele" — z dowolnej przyczyny — naprawia
się sam najpóźniej po 2 h.

### NA CO ZWRÓCIĆ UWAGĘ W DOMU (kolejność ważności)

1. **Sprawdź, że prom zadziałał**: w logu `[PROM] planeta → księżyc` +
   flota (36,9 mld LF, 16,1 mld BS, minery, recyklery, 12 GS, AVATAR…)
   ma stać NA KSIĘŻYCU [3:269:8]. Jeśli stoi na planecie — prom nie
   ruszył, diagnozuj `MoonFerry.due()` (klucz GM `ogamex_ferry_at`).
2. **Następny atak = test v2.70.3.** Sąsiedzi ([3:248:11] i [3:254:9])
   atakują seryjnie — kolejny przyjdzie. Poprawny przebieg w dzienniku:
   RATUNEK księżyc→planeta → (zamiatanie może logować „nothing to save",
   to OK) → **ŻADNEGO wpisu „Hangar … pusty przy alarmie → przełączam"**
   → POWRÓT „planeta → księżyc". Jeśli zobaczysz flip przy zamiataniu —
   v2.70.3 nie zadziałał, to P0.
3. **NIE dotykaj gałęzi moonSave w select_ships_direct ani zapisu
   homeBody/refugeBody w MoonSave.saveWatch bez przeczytania incydentu
   16:18.** Każda zmiana tam = ryzyko powtórki „flota wraca na atakowane
   ciało".
4. **Mining i Ekspedycje są OFF od 15:54** (owner wyłączył po ataku).
   Włączyć może sam owner, gdy uzna że spokój. FS też OFF.
5. **FS live-click zawracania (a.x_btn_fleet_return) nadal NIEPRZETESTOWANY**
   — pierwsze zawrócenie było ręczne. Następny cykl FS = test; czytać log.
6. **Gemini: brak klucza na tej maszynie** (GM storage nie synchronizuje
   się między laptopami — w domu klucz pewnie jest, sprawdź panel).
7. Drobne z dziś: licznik alarmów w pasku liczy epizody (v2.70.2, „3 alarm"
   = poprawnie); dumpy wrogich wierszy szukaj po `[ATAK DOM]`.

### Pomysły otwarte (owner zainteresowany, nic nie obiecane)

- Ewakuacja awaryjna poza układ, gdy atak leci na OBA ciała naraz
  (dziś: ratunek przerzuca tylko planeta↔księżyc tych samych koordów).
- Podgląd nicku agresora (galaktyka [3:248] / [3:254]) do dziennika.
- Rotacja księżyców ODRADZONA (koszt/chaos > zysk; falanga i tak nie
  widzi księżyców) — zamiast tego wdrożony blitz fast-track (<120 s ETA
  = alarm bez 25 s potwierdzania, v2.70.1).

---

## FARMIENIE (EVENT IDLE FARMING) — audyt + v2.72.0 (05.08 wieczór, dom)

Audyt przed eventem wykazał: farmienie NIGDY nie biegło na żywo (zero kluczy
`ogamex_farm*` w GM storage), a misja szła w ciemno na `mission=8` z URL-a —
parametr niepotwierdzony na tym forku (numeracja własna: ekspedycja=1,
asteroida=12) i formularz potrafi gubić parametry (incydent 09:50 4.08).

v2.72.0: (1) krok 3 klika misję **ATTACK jawnie** po klasie/tekście
mission-item — bez trafienia NIE wysyła (zrzut dostępnych misji do logu,
sweep pauza 30 min); (2) **wybór statku** w Ustawienia: Farmienie
(LIGHT_CARGO / HEAVY_CARGO / BATTLESHIP, klucz `inactiveFarming.shipType`) —
taktyka eventowa: szybszy statek = slot szybciej wolny, BS na wypadek obrony;
(3) start ze złego ciała naprawia istniejący chokepoint v2.69.0 (baza=księżyc).
Zabezpieczenia nietknięte: alarm wstrzymuje farmienie, mining wygrywa z farmą.

**Pierwszy atak farmy obserwować w logu**: `[FARM DOM] first target row`
(weryfikacja parsera statusów (i)/(I)) i `[FARM] misja: …` (weryfikacja
ATTACK). Jeśli „brak misji Attack na kroku 3" — przysłać zrzut z logu.

## ZASADA, KTÓREJ NIE WOLNO ZŁAMAĆ

**Nie buduj niczego na endpointach, których nie potwierdziłeś na żywo.**
Rano założyłem, że athena to open-source OGameX (Laravel) i zbudowałem pięć
wersji (2.40–2.44) na trasach z `lanedirt/OGameX`. Wszystkie oddały 404 —
serwer jest w .NET. Cała praca poszła do kosza, a jedna wersja (2.52.0)
wysyłałaby flotę **z bazy** zamiast z atakowanej kolonii.

Metoda, która zadziałała: `ApiSniffer` podpina się pod `fetch`/`XMLHttpRequest`
strony i notuje, co gra odpytuje **sama z siebie**. Tak znaleźliśmy prawdziwe
adresy. Gdy potrzeba nowego — najpierw zrzut markupu do logu, potem parser.

## PRAWDZIWE ENDPOINTY TEGO SERWERA (potwierdzone)

```
GET /home/fleetmovementlist                                  ← lista ruchów flot (podstawa obrony)
GET /home/Partial_AsteroidJournal                            ← dziennik wypraw górniczych
GET /home/Partial_ExpeditionJournal                          ← dziennik ekspedycji
GET /messages/messagedata?MessageCategoryType=FLEET_OTHER&page=1
GET /messages/messagedata?MessageCategoryType=FLEET_EXPEDITION&page=1
GET /messages/messagedata?MessageCategoryType=FLEET_BATTLE_REPORT&page=1
GET /home/combatreport?id=<uuid>
```

Martwe (404 albo strona HTML): wszystko z `/ajax/fleet/*`, `/ajax/galaxy`,
`/ajax/messages`, `/ajax/phalanx/scan`. Kod, który na nich stał, usunięty
w 2.54.0. Nie wskrzeszać.

**`/overview` NIE ISTNIEJE na tym serwerze** (ustalone 2026-08-03: każda
strona błędu miała `aspxerrorpath=/overview` — to bot sam na nią wchodził).
Przegląd gry żyje pod `/` (logo ma `href="/"`). Wszystkie nawigacje
podmienione w 2.63.0; nowy kod ma używać `/`.

Markup wiersza listy ruchów flot:
```html
<tr data-fleet-id="4649f6fc-…" class="row-mission-type-EXPEDITION">
  <td data-remaining-seconds="213" …>03:33</td>
  <td><img data-tooltip-content="Expedition" /></td>
  <td> Yoyoyoyoyo <a class="fleet-source-coords">[3:269:8]</a> </td>
  <td><span data-tooltip-content="… Light Cargo : 330.000.000 …"></span></td>
```
Typ misji jest podany **nazwą**, nie numerem — dlatego odpada problem
numeracji forka (w linkach galaktyki ekspedycja to `mission=1`, asteroida
`mission=12`, co nie zgadza się z upstreamem).

---

## AUDYT 2026-08-03 (v2.59.0) — co naprawiono

1. **P0, alarm:** od 2.32.0 potwierdzony alarm NIGDY nie był zdejmowany —
   `this.clear()` wypadło z gałęzi „obce floty zniknęły" (zostało tylko
   w nieosiągalnej gałęzi kandydata). Skutek: `active()` trzymało 3 h
   (BACKSTOP), auto-powrót z refugium nie odpalał, ekspedycje/farmienie
   stały, straż zamiatała co 90 s, log „alarm zdjęty" spamował co 30 s.
   Naprawione — clear() wrócił na miejsce.
2. **Ekspedycje:** RECYCLER dopisany do wykluczeń (domyślne + migracja
   zapisanej konfiguracji). Recyklery zostają w domu do zbierania złomu.
3. **Złom (latentny):** misja `debris_recycle_direct` w kroku 1 formularza
   wpadała do gałęzi górniczej i załadowałaby MINERY zamiast recyklerów
   (pierwszy realny złom = flota górnicza na polu złomu). Naprawione +
   recycle wypięty z księgowości mininga (finishDispatch, init handler,
   ogamex_last_dispatch).
4. **Alarm, czułość:** 20-sekundowe okno ślepoty po własnej wysyłce dotyczy
   teraz TYLKO odczytu z paska — sklasyfikowany odczyt z listy ruchów flot
   nie może pomylić własnej floty z obcą (fale co 60-90 s zjadały ~25%
   czasu czuwania).
5. **Dziennik:** wpis „ATAK" z refreshEvents dławiony (zmiana obrazu albo
   5 min) — wcześniej 120×/h przy trwającym ataku, groziło wypchnięciem
   ważnych wpisów z limitu 600.
6. **404:** `fleetAlreadyFlyingTo` odpytywał martwe `/ajax/fleet/*` przy
   każdej wysyłce górniczej (ominięte przy sprzątaniu 2.54.0). Teraz
   najpierw potwierdzony `/home/fleetmovementlist`, martwe adresy za bramką
   `Ajax.supported`.

**Znane luki zgłoszone, ale NIE ruszone (świadomie):**
- Ratunek kolonii zawsze wysyła Z PLANETY (`switchTo` klika kotwicę
  planety). Jeśli flota kolonii stoi na jej księżycu, a atak leci na
  księżyc — ratunek zastanie pustą planetę i zakończy się „nothing to
  save", flota zostanie na atakowanym księżycu. Cel z listy ruchów flot
  to gołe koordy, bez rozróżnienia planeta/księżyc. Do przemyślenia razem
  z maszyną stanu MoonSave (pkt 2 niżej).
- Klasyfikacja sonda/atak nadal niepotwierdzona na prawdziwym ataku
  (pkt „CO JEST WDROŻONE, ALE NIEPOTWIERDZONE").

## v2.61.0 (2026-08-03 wieczór) — strona błędu nie zabija już bota

Incydent ×2: OGameX oddał `/Error/NotFound` i bot stał na niej GODZINAMI —
całe odzyskiwanie wisiało na jednym setTimeout, a przeglądarka w karcie w tle
dławi/gubi timery (oszczędzanie pamięci). Naprawy:
- **strażnik interwałowy** (60 s) ponawia powrót do gry aż do skutku,
  po 6 próbach eskalacja na lobby `/` (init umie kliknąć Play);
- **pętla obrony startuje TAKŻE na stronie błędu** — odczyt zagrożeń idzie
  fetchem (lista ruchów), ratunek nawiguje prosto do formularza;
- epizod strony błędu jest **widoczny w dzienniku obrony** (start + czas trwania);
- `markUnsupported` hartowany: tylko 404/405 i NIGDY dla adresu, który już
  kiedyś działał (czkawka 404 podczas awarii nie wyłączy fleetmovementlist).
Czego kod nie naprawi: **całkowicie uśpiona/odzyskana karta** (browser
discard) nie wykonuje ŻADNEGO JS. Właściciel ma wyłączyć usypianie kart dla
athena.ogamex.net i trzymać bota w osobnym oknie.

## CO DZIAŁA I JEST POTWIERDZONE NA ŻYWO

- **Mining asteroid** — główny dochód. Własny licznik lotów (`MiningFlights`),
  prawidłowy dobór liczby minerów, ładowność 20 750/minera uczona z raportów.
- **Ekspedycje** — 14 fal, skład zamrażany na serię, Galleon i Falcon wracają
  do składu, Gwiazda Śmierci wykluczona (spowalniała falę do 26 min w jedną stronę).
- **Ewakuacja bazy** planeta↔księżyc + powrót — ratunek 09:24, powrót 09:26.
- **Pętla obrony co 30 s**, niezależna od przerw, jitteru i okna nocnego 23–05.
- **Dziennik ataków**: zdarzenia ważne żyją 12 h, rutynowe odczyty mają własny
  limit 60 i nie mogą ich wypchnąć. Podsumowanie w panelu i raz na godzinę w logu.

## ✅ POTWIERDZONE BOJOWO 05.08.2026 15:09-15:13 — PEŁNA AUTOMATYCZNA OBRONA

Drugi atak dnia (gracz HOME z księżyca [3:254:9], 4 floty: 98 mld Reaperów +
93 mld pancerników, przylot ~6 min) — bot obronił się CAŁKOWICIE SAM:
wykrycie 15:09:35 (wiersze `row-mission-type-ATTACK row-hostile-mission`
sklasyfikowane, surowy HTML w logu przez [ATAK DOM]) → RATUNEK w 24 s od
wykrycia (całość z księżyca na planetę, lot 81 s) → napastnik ZAWRÓCIŁ
wszystkie floty 15:11 → alarm zszedł natychmiast (fix P0) → auto-POWRÓT
na księżyc 15:12:55 → straż rozbrojona → [BAZA=KSIĘŻYC] przywrócił start
z księżyca → ekspedycje pojechały dalej. ZERO STRAT. Punkty 1 (klasyfikacja)
z sekcji niżej są tym samym potwierdzone na żywo. Kontrast z porankiem
(11:00, bot OFF, −11,2 bln) jest ostatecznym argumentem: bot ma być ON.

## CO JEST WDROŻONE, ALE NIEPOTWIERDZONE NA PRAWDZIWYM ATAKU

1. **Klasyfikacja sonda/atak** (2.51.0). Parser listy ruchów flot sprawdzony
   wyłącznie na NASZYCH wierszach — od wdrożenia nikt nie atakował. Jeśli ta
   lista zawiera tylko floty gracza, klasyfikacja nie działa.
   Zabezpieczenie (2.53.0): gdy pasek misji widzi obcych, a lista nie —
   **wygrywa pasek**, w logu i dzienniku ląduje ostrzeżenie.
   **Do zrobienia: przy pierwszym ataku przeczytać dziennik i sprawdzić, czy
   wiersz obcej floty w ogóle się pojawił.** Nic do kodowania.
2. **Ewakuacja innej kolonii niż baza** (2.55.0) — przełączanie aktywnej
   planety klikiem w kotwicę na liście planet, potem wysyłka. Testy na
   syntetycznym DOM przechodzą; na żywym ataku nie było.
3. **Zbieranie złomu po ekspedycjach** (2.48.0) — wizyta na galaktyce bazy
   działa, ale pola złomu jeszcze nie było. Gdy nie ma linku zbierania, bot
   zrzuca markup i **nie wysyła floty w nieznane**.

---

## DO WDROŻENIA

### 1. Fleet Save — WDROŻONE w v2.60.0 (2026-08-03), czeka na pierwszy przebieg

Cały cykl jest w kodzie: panel (sekcja „Fleet Save (nocny)": godzina powrotu
HH:MM — **najbliższe wskazanie zegara, powtarza się co dobę**; cel g:s:p;
prędkość %; przycisk „Zmierz trasę (bez wysyłki)"), tick w PĘTLI OBRONY
(odporny na noc/przerwy — zawrócenie o 4:00 musi zadziałać), wysyłka przez
sprawdzony na żywo formularz (ciało=moon `data-planet-type=2`, misja DEPLOY,
`btn-all-res`), statki wszystkie poza `excludeTypes` (ASTEROID_MINER).

Jak obeszliśmy dwa brakujące markupy — **nic nie leci na zgadywanym markupie**:
- **prędkość (krok 2):** trzy próby po znaczeniu (select z opcjami %,
  input[type=range], klikalne „NN%") + jednorazowy zrzut okolic formularza do
  logu (`[FS DOM] krok 2`). Nieustawiona prędkość nie psuje niczego, bo…
- **bramka arytmetyki:** przed Send bot czyta czas lotu, który pokazuje SAMA
  GRA (`capturedFlightMs`) i wysyła TYLKO gdy okno ≤ 2×T − 2×3 min. Nie pasuje
  → odmowa + zapis T (planer odtąd liczy godzinę startu bez formularza).
  „Zmierz trasę" robi dokładnie to samo i zawsze kończy bez wysyłki.
- **zawracanie:** o `recallAt` fetch listy ruchów, nasz wiersz po koordach
  from/to, kontrolka po znaczeniu (recall/callback/revoke/retreat/cancel/zawróć
  w href/action/data-*), wykonanie + WERYFIKACJA (wiersz zniknął / return /
  eta przeskoczyła). 3 próby co 60 s; porażka = zrzut końca wiersza + głośny
  błąd + powiadomienie — a flota **doleci na nasz księżyc i tam zostanie**
  (stacjonowanie = bezpieczna porażka; TRANSPORT jest dla FS odrzucany twardo,
  bo rozładowałby się i wrócił w środku nocy).

**Pierwsze uruchomienie:** kliknij „Zmierz trasę" (pozna T), ustaw powrót
(np. 09:00), włącz. Pierwszy pełny cykl przeczytać w logu/dzienniku — zwłaszcza
czy zawrócenie znalazło kontrolkę (jak nie: zrzut wiersza jest w logu, dopisać
selektor). UWAGA operacyjna: FS zabiera to, co stoi na bazowym KSIĘŻYCU w
chwili startu — fale ekspedycji wracające w nocy na planetę są poza FS.

### 2. MoonSave na maszynę stanu (dług z audytu, WYSOKIE 4)

413 linii, **64 punkty wyjścia**. Rano ta plątanina wygenerowała serię poprawek,
gdzie każda odsłaniała następną (2.33 → 2.34 → 2.35).

**Warunek wejścia: jeden potwierdzony ratunek w dzienniku.** To jedyna ścieżka
obrony potwierdzona na żywym ruchu i przepisanie jej bez wzorca do porównania
byłoby wymianą znanego na nieznane. Plan: wydzielić `decide()` zwracające jedną
akcję (`ratuj` / `wróć` / `czekaj` / `nic`), mechanikę wysyłki zostawić bez
zmian, obie ścieżki puścić równolegle w trybie porównawczym przez dobę.

### 3. Uczenie się urobku z właściwych źródeł

`/home/Partial_AsteroidJournal` i `messagedata?…FLEET_OTHER` są podpięte, ale
parser nadal jest ten stary („unknown message markup"). Trzeba zobaczyć zrzut
`[RAPORTY] …` i napisać parser pod ten markup. Zysk: trafniejszy dobór liczby
minerów na lot, czyli wprost większy urobek.

### 4. Drobne

- Ochrona kolonii innych niż baza działa tylko wtedy, gdy kolonia jest widoczna
  na liście planet — przy 30 planetach warto sprawdzić, czy lista nie jest
  przewijana/ucinana.
- `pending_mission` to nadal jeden slot dla czterech modułów (dług z porannego
  audytu, ŚREDNIE 8). Ratunek ma wywłaszczenie, więc najgorszy skutek zdjęty.

---

## Dokumenty w repo

- `AUDYT-OBRONA-2026-08-02-v2.md` — audyt wieczorny + stan wykonania
- `AUDYT-2026-08-02.md` — audyt poranny (v2.35.0)
- `ENDPOINTY-OGAMEX-2026-08-02.md` — analiza endpointów z nagłówkiem o tym,
  dlaczego większość nie dotyczy tego serwera


---

## AKTUALIZACJA 3 sierpnia wieczorem (v2.58 → v2.66.1)

Zrobione od czasu noty powyżej:
- **P0 (2.59.0):** alarm nigdy nie był zdejmowany — `clear()` wróciło na
  miejsce; auto-powrót działa. Recyklery zostają w domu (zbieranie złomu).
- **Fleet Save (2.60–2.63):** pełny cykl start→stacjonuj→zawróć→powrót,
  planer z 3-min marginesem, pomiar trasy na kroku 3, strona błędu nie
  zostawia martwego bota, `/overview` → `/` (nie istnieje na athenie).
  NIEPRZETESTOWANE NA ŻYWO: kontrolka zawracania i suwak prędkości (zrzuty
  czekają w kodzie). Przed nocnym użyciem: JEDEN nadzorowany test.
- **Gemini (2.64.x):** klucz w panelu, czyta raporty urobku z
  Partial_AsteroidJournal — POTWIERDZONE NA ŻYWO 22:16 (`odczytano 1 raport`,
  próbka 18,2 bln zgodna z ładownością). Strażnik ładowności (odrzut >3×).
  Twarda zasada: model tylko czyta / eskaluje, nigdy nie decyduje o flocie.
- **UX panelu (2.65.x):** pasek stanu 5 linii (Obrona/Mining/Ekspedycje/FS/
  Gemini), slim sekcje PL zwinięte domyślnie, log 1-liniowy, szerokość 232px.
- **Audyt obrony (2.66.0):** flota na KSIĘŻYCU nie była chroniona (ratunek
  szedł z ciała aktywnego = planety, „nothing to save", flota zostawała pod
  atakiem) — naprawione flipem na drugie ciało przy pustym hangarze i alarmie.
  Nieznany typ obcej misji = ATAK (było: nie podnosił alarmu). Gemini jako
  drugie oko obrony (wyłącznie eskalacja). Jitter dostał przełącznik (2.66.1).

Otwarte (kolejność):
1. Nadzorowany test FS (~40 min okno) — odblokuje selektory zawracania+prędkości.
2. Pierwszy prawdziwy atak — zweryfikuje wrogie wiersze w fleetmovementlist.
3. MoonSave → maszyna stanu (po pierwszym potwierdzonym ratunku).

## AKTUALIZACJA 4 sierpnia (v2.66.5–2.66.9) — FS przeszedł pierwszy żywy cykl

- **Pierwszy żywy FS 14:36**: pomiar → wysyłka → Deploy+surowce z księżyca →
  zawrócenie. Prędkość = RZĄD GOŁYCH LICZB bez „%" (Speed: 3 5 10 … 100);
  czas lotu = „Duration of flight (one way): MM:SS" (wzorzec wspólny — mining
  też czyta teraz czas z formularza). Trasa 3:269:8→5 przy 10% = 263 min
  w jedną stronę (GS spowalnia flotę) → maks. FS ~8,7 h — **bliski księżyc
  wystarcza na całą noc**.
- **Kontrolka zawracania ZŁAPANA na żywo**: `a.x_btn_fleet_return
  [data-fleet-id]`, href="#" (handler JS) → klik w żywym DOM na /fleet
  (panel „Fleet movements", rozwinięcie przy wielu flotach), auto-confirm.
  Pierwsze zawrócenie wykonane RĘCZNIE przez ownera (wykrywacz nie znał
  klasy — naprawione w 2.66.9); wiersz powrotny bez przycisku = sukces.
  KLIK NA ŻYWO jeszcze niepotwierdzony — sprawdzić przy następnym cyklu FS.
- Sonda szpiegowska 09:49 zignorowana poprawnie — lista ruchów POKAZUJE obce
  floty (połowa wielkiej niewiadomej obrony rozstrzygnięta na TAK).
- Ekspedycje: fala zapełniająca ostatni slot zabiera CAŁY hangar (2.66.7);
  krok 2 poprawia koordy celu, gdy formularz zgubi parametry URL (2.66.5).

## AKTUALIZACJA 4 sierpnia późny wieczór (v2.68.0–2.68.1)

- **v2.68.0 Wake Lock**: bot ON = Screen Wake Lock (macOS i Windows bez
  admina); karta z grą musi być widoczna, klapa otwarta. Bot OFF zdejmuje.
- **v2.68.1 złom z ekspedycji** (zgłoszenie: „złom leży na 16 i nikt nie
  leci"): wizyta po złom co 20 min zawsze przy bezczynności (stary warunek
  „minery w locie" nie zachodził nigdy przy pustych skanach — to była
  główna przyczyna); bramka na pusty hangar recyklerów; krok 2 jawnie klika
  Debris (data-planet-type=3), krok 3 jawnie klika COLLECT albo NIE wysyła.
  DO POTWIERDZENIA na żywo: pierwszy log `[ZŁOM] misja: "Collect"` po
  przegranej ekspedycji.

## AKTUALIZACJA 25 sierpnia (v2.99.3) — złom na 16 wciąż leżał

- Zgłoszenie: po walce z obcymi na ekspedycji [3:272:16] miało 81 mld metalu
  / 31 mld kryształu, a bot „zaglądał co 20 min" i nic nie wysyłał.
- Przyczyna: `visit()` jeździło na galaktykę bazy głównie przy NIEaktywnym
  skanie, a `tryCollectHere()` po dojeździe żyło tylko w gałęzi init
  „skan AKTYWNY" — wizyta lądowała na stronie i nic nie sprawdzała. Drugi
  cichy hamulec: `recyclersHome()` bez zwiadu zwracało 0 = „nie jedź".
- Naprawa: sprawdzenie złomu na KAŻDYM wejściu na galaktykę bazy (init +
  tick schedulera), niezależnie od skanu; brak zwiadu = null (jedziemy);
  `findDebrisLink()` szuka linku także w tooltipie (rel/id `debris{g}_{s}_{p}`),
  a bez linku jedzie po samych koordach (krok 2/3 i tak klikają Debris +
  Collect jawnie albo NIE wysyłają). Test: `test-zlom.js` (10 checków).
- DO POTWIERDZENIA na żywo: log `[ZŁOM] pole złomu na [3:272:16] — wysyłam
  recyklery` → `[ZŁOM] misja: "Collect"`.
- **v2.99.4 (07:40):** po 2.99.3 bot ZOBACZYŁ złom, ale „zero recyklerów" —
  `recyclersHome()` czytało `recon.ships.RECYCLER`, a zwiad zapisuje tablicę
  `[{type, qty}]` → zawsze 0. Ta bramka blokowała zbieranie od 2.48.0.
  Naprawione (szukanie po `type`), test wykonuje prawdziwe ciało.
- **v2.99.5 (07:58):** recyklery doszły do formularza i padły na strażniku
  duplikatu („flota już leci na [3:272:16]" — to ekspedycje). Recycle wypięty
  ze wszystkich 3 strażników duplikatu (lokalny + 2× lista ruchów).

## AKTUALIZACJA 25 sierpnia (v2.100.0–2.102.0) — audyt „dlaczego bot nie podniósł floty"

Owner: „pomimo wielu audytów straciłem flotę — w momencie próby i prawdziwego
ataku bot nie podniósł floty". 4 równoległe audyty adwersarialne (wykrywanie,
decyzja, formularz, runtime) + 2 recenzje każdego diffu przed pushem.

**Trzy przyczyny systemowe:**
1. Symulacja ataku wpisywała gotowe zdarzenie i wracała PRZED siecią — nie
   testowała listy ruchów, arbitrażu pasek-vs-lista, ciała celu, blitza ani
   strażnika bezpiecznej strony; karta widoczna, operator klika → zero
   dławienia. Każdy błąd niżej był dla niej niewidoczny z konstrukcji.
2. Prawdziwe ataki z tego samego układu (księżyc Ibry) są niewidoczne dla listy
   i endpointów — jedynym źródłem jest pasek, a logika pracowała przeciw niemu.
3. Kilka mechanizmów „cichej ślepoty" (zawieszony fetch, wylogowanie, karta w
   tle) — panel czysty, bot nic nie czyta.

**v2.100.x** — straż świadoma ciała (refugeBody vs atakowane ciało), ochrona
fal w ucieczce w powietrze, N1: run() wywłaszczał WŁASNY start ucieczki na
1. ticku po przeładowaniu (ucieczka w powietrze prawdopodobnie NIGDY nie
działała live od 2.85.0).
**v2.101.0** — zamiatanie wg zegara powrotów (OwnReturns + pamięć lądowań
10 min; sweepPlan: lądowanie / wróg <3 min → 20 s), ostrzeżenie „fala nie do
uratowania" (<60 s przed uderzeniem), tick 10 s przez cały alarm.
**v2.102.0** — blok A: fetchT (timeout 8 s) na każdym fetch obrony, bezpiecznik
zawieszonego ticku (90 s), SessionWatch (wylogowanie = BŁĄD+push, pasek z DOM
nie jest odczytem), alarm/kandydat z PASKA gasi tylko ŻYWY pasek (+2 zerowe
odczyty ≥15 s), backstop 3 h od ostatniego widzenia, CONFIRM 12 s dla ataków
tylko z paska, ton keepalive −44 dBFS, karta widoczna przejmuje lidera,
wykrywanie dławienia (3× >45 s), skan bez żywego paska >3 min → strona „/".
Blok B: `returning` wygasa po czasie lotu (normalizeWatch), kolejka „done"
dopiero po udanym run(), cel spoza listy planet → ratunek domu floty (tylko
gdy aktywna para = dom), Gemini nie nadpisuje celu obcymi koordami, AirSave
wykrywa ręczne zawrócenie (po pierwszym zobaczeniu wiersza), „bezpieczna
strona" zbroi straż, coordsOf fallback, brak przełącznika księżyca = przerwij.
Blok C: „Wyślij" czeka na aktywny przycisk, brak potwierdzenia ≠ sukces dla
ratunku (formularz nadal na stronie po 8 s = porażka), retry z backoffem
20 s→5 min, guard wyścigu dwóch wywołań obsługi misji.
Blok D: symulacja PRZEZ PARSER — syntetyczny wrogi wiersz HTML (kształt forka)
wchodzi do classifyRow razem z prawdziwymi; tryby moon/planet/both; pomiar
E2E start→wysyłka w logu.

**Środowisko (Firefox, poza kodem):** about:config
`dom.timeout.enable_budget_timer_throttling=false`,
`dom.min_background_timeout_value=100`, `browser.tabs.unloadOnLowMemory=false`;
gra w osobnym, zawsze widocznym oknie, jedna karta. Fizyczny limit: fala
lądująca <~30 s przed uderzeniem i atak z układu <~60 s dolotu są poza
zasięgiem automatyki UI — rekomendacja z 12.08 (dom floty poza układem Ibry)
nadal aktualna.

DO POTWIERDZENIA: symulacja (tryb moon, potem both) z widoczną kartą —
log `[TEST] E2E: … s` <60 s; potem z kartą w tle — czy pojawia się BŁĄD
„karta dławiona".

## AKTUALIZACJA 26–27 sierpnia (v2.104.0 → v2.106.2) — Destroy księżyca, brama, huby
**Co się stało 26.08:** dzień fałszywych alarmów od sond (2.104.2–.4 kręciły stoperami; rozwiązanie 2.104.6/2.105.6: pasek gry pisze wprost `Type: Spy` — parseBar czyta to pole, okno 1200 znaków zwinięte do spacji, bo wcięcia HTML wypychały „Type:” poza 160 znaków). 18:26 i 18:28 **3× Destroy po 500 mld GŚ z [5:126:4]** zniszczyło księżyc bazy [5:125:4]; flota uratowana na planetę (25 s + 81 s). Napastnik sonduje co minutę, blitzuje 1-statkowymi atakami, uderza w chwilę po lądowaniu floty na planecie (falanga).

**Wdrożone i na żywo potwierdzone:**
- 2.104.5 FS: czas lotu z kroku 3 także przy wysyłce (fork nie pokazuje go w kroku 2) — bez tego FS nigdy nie wysyłał.
- 2.104.7 para bez księżyca: powrót odwołany, atak na planetę = ucieczka w powietrze; `HomeBase.pairHasMoon`.
- **2.105.x ODBUDOWA KSIĘŻYCA** (`MoonRebuild`): fork ma `/home/moonformation` („Form a moon” za metal); bot stawia księżyc przy KAŻDEJ planecie bez księżyca (baza po Destroy najpierw), średnica 8944→1000 w dół aż koszt ≤ 25 % metalu (`moonRebuild.maxMetalShare`), po odbudowie flota sama wraca z planety na księżyc. **Potwierdzone 18:32: [2:21:4] 6000 km za 1,8 bln.** Koszt rośnie wykładniczo (8944 km = 89 bln).
- 2.105.5 decyzja operatora: pasek `Type: Spy` + lista bez ataków = sondy, flota NIE rusza (dowolna liczba). Ruch tylko na ATTACK/DESTROY.
- 2.106.1 FS loguje powód czekania; 2.106.2 martwa straż (saves=0 po „nothing to save”) schodzi sama 3 min po alarmie (blokowała FS 45 min).
- Odrzucone przez operatora: okresowy prom po odbudowie (2.105.2, cofnięty), bot na serwerze Hetzner (obce IP = ryzyko multikonta; alternatywa: stary laptop w domu na domowym IP).

**Wdrożone, NIEPOTWIERDZONE na żywo:**
- **2.106.0 RATUNEK BRAMĄ (`GateSave`, `/building/jumpgate`)**: atak na księżyc z flotą → skok bramą na inny nieatakowany księżyc (statki + surowce przez przyciski „»”, weryfikacja pustego hangaru), porażka → Deploy jak dotąd, powrót bramą po alarmie (cooldown → co 5 min). Przycisk „Skok bramą” (Shift = powrót). **Selektory ze zrzutów, do pierwszego testu przyciskiem; przy porażce log `[BRAMA DOM]`.** Cooldown bramy 30–40 min — patrz audyt 2 (finta wypala bramy).

**Audyty do przeczytania przed dalszą pracą (kolejność):**
1. `MOON-STRATEGY-2026-08-26.md` — mechanika Destroy/odbudowy.
2. `AUDYT-HUBY-2026-08-27.md` — plan „ekspedycje z 2–3 księżyców”: rotacja tania, FS per hub średni, OBRONA najdroższa (jedna straż = jedna para).
3. `AUDYT-HUBY-2-OBRONA-2026-08-27.md` — atakujący vs obrońca: hub nieaktywny ratowany w 55–100 s (`switchTo` klika tylko planetę, brama nieosiągalna), finta wypalająca bramy → księżyce-SCHRONY, ślepy alarm → bronić wszystkich hubów, keepalive wyłączony w przerwach/nocy.

**DO WDROŻENIA (uzgodniona kolejność; obrona przed rotacją):**
- **Etap A (obrona per para — warunek hubów, warte zrobienia i bez hubów):** straż jako mapa po `g:s:p` + zamiatanie/licznik/DefenceHold per para; `switchTo` na KSIĘŻYC pary gdy tam stoi flota + brama dla ratunków z kolejki; ślepy alarm → wszystkie huby wg `ogamex_hangar_map`; `jumpGate.havens[]` (schrony jako jedyne cele skoków); AirSave refugium wyklucza atakowane, stan per para; wszystkie `ev.targets` w 1. przebiegu; GOTOWOŚĆ zamraża rutynę hubu + prewencyjne ciało aktywne; keepalive poza bramkami przerw/nocy, wylogowanie → próba `/` po 2 min; symulator celujący w hub nieaktywny. Do zrobienia OD RAZU (jedna baza): switchTo na księżyc, schrony, keepalive.
- **Etap B (rotacja ekspedycji):** `expeditions.hubs[]`, kursor, burst/roster per hub, bramka paliwa PO przełączeniu hubu, `DebrisCollector` po hubach, `fleetHome` = zbiór, przycisk „Rozwieź flotę” Deployem (nie bramą).
- **Etap C (FS per hub):** `ogamex_fs_state` → mapa z migracją, zapisany `fleetId`, `routeKey(origin)`, klucze pauz per hub, kolejka startów, zawracania na jednej wizycie `/fleet`, UI per hub; poprawić utajony błąd `_findOurRow` bez `st` (L~5784).
- Otwarte decyzje operatora: koordy 2–3 hubów, koordy schronów (daleko od [5:126]), cel FS (wspólny), czy przywrócić „Type: Spy + 2+ obcych = 5 min trwałości”, mniejsze fale (1/28), FS nocny z minerami.
- Nie do zamknięcia kodem: snajperka wracających ekspedycji po Destroy (nie da się ich zawrócić), ETA < 30 s, laptop uśpiony.

**Stan w grze 26.08 wieczór:** baza [5:125:4] (księżyc odbudowany? — sprawdzić pasek planet), flota była na księżycu [2:21:1] (operator skoczył bramą), FS cel [2:21:4] zmierzony 876 min. Napastnik [5:126:4].

## AKTUALIZACJA 27.08 rano (v2.106.3–2.106.5) — prawdziwy atak, flota NIE podniesiona
08:17 atak widoczny TYLKO w pasku (1→2 obcych, lista 0, sondy 0; atak z własnego układu — lista forka go nie oddaje). Cel nieznany → bot bronił „domu floty" [5:125:4] (pole „Start ekspedycji"), gdzie hangar był PUSTY; flota stała na innej kolonii (sonda o 08:19 poszła na [3:269:9]; hangar z LF 51 mld widziany na [3:272:7]). „Oba ciała" z nadwyżki paska → ucieczka w powietrze pustej pary; formularze otwierały się na obcych koloniach; operator wyłączył bota 08:17:48. Push na telefon NIE dotarł (log milczał — nie wiadomo: OFF/inny temat/sieć).
Wdrożone: 2.106.3 pasek loguje `Type:`; 2.106.4 push loguje wysyłkę (temat, HTTP) i pominięcie; **2.106.5 ślepy alarm broni WSZYSTKICH kolonii z flotą** (`FleetRecon.hangarTargets`, największa pierwsza, reszta przez `RescueQueue.tryNext` z `ogamex_blind_targets`, ważne 15 min). To domyka ścieżkę A2 z audytu 2 dla obecnej bazy. NIEPOTWIERDZONE na żywo.
Do sprawdzenia na laptopie w pracy: panel „Push na telefon (ntfy)" ON + ten sam temat co w telefonie (temat jest per przeglądarka!); gdzie stała flota i czy została stracona.

**HIPOTEZA DO SPRAWDZENIA W PRACY (27.08, otwarta):** lista ruchów `/home/fleetmovementlist` oddaje wrogie wiersze TYLKO dla AKTYWNEJ planety/pary (26.08 Destroy na aktywnej [5:125:4] → wiersze były; 27.08 08:17 atak na inną kolonię → lista 0, pasek 1–2; wcześniejsze „panel Events dołożył wiersz, którego lista nie oddała"). Test: przy sondzie/ataku porównać tabelę Events na atakowanej i innej kolonii. Jeśli potwierdzone → pierwszy punkt Etapu A: przy nadwyżce paska bot OBCHODZI kolonie z flotą (`FleetRecon.hangarTargets`) i czyta listę na każdej, aż znajdzie wiersz z celem+ciałem; dopiero wtedy ratuje (brama/powietrze przy nieznanym celu, nie skok w parze). Pytania otwarte do operatora: gdzie stała flota 27.08 08:17, czy stracona, stan push (ON/temat) na laptopie domowym.

## AKTUALIZACJA 27.08 (praca, Windows) — v2.107.0: Etap A „od razu" (3 punkty bez koordów hubów)
Wdrożone, testy offline zielone (`test-etap-a.js`, 24 sprawdzenia), **NIEPOTWIERDZONE na żywo**:
- **`switchTo` na KSIĘŻYC pary, gdy tam stoi flota** (audyt 2, Z4): `MoonSave.switchBodyFor(coords)` czyta ciało z mapy hangarów (`ogamex_hangar_map[k].body`, ostatni odczyt <48 h, hangar niepusty); księżyc klikany tylko, gdy para GO MA na pasku (`HomeBase.moonOf`). Po przełączeniu `run()` widzi `currentBody()==="moon"` → brama osiągalna także dla kolonii nieaktywnej; odmowa „NA księżyc, bo atakowany" znika (from=moon → to=planet). Warunek: mapa hangarów musi ZNAĆ ciało — `FleetRecon.scan()` zapisuje `body` (`MoonSave.currentBody()`), a `activePlanet()` widzi teraz też `moon-select.selected` (dotąd hangar księżyca w ogóle nie trafiał do mapy!). Mapa wypełni się przy pierwszej wizycie `/fleet` na księżycu z flotą.
- **`jumpGate.havens: []`** (Z2): gdy niepuste — brama skacze WYŁĄCZNIE na schrony (`GateSave.pickDestination`); brak dostępnego schronu (nie ma na liście / atakowany) → null → ratunek Deployem, nigdy skok na hub. **Do wpisania w configu bota (`CONFIG.jumpGate.havens`, format `{ galaxy, system, position }`) po decyzji operatora o koordach schronów.** Puste = zachowanie 2.106.0.
- **Keepalive + samonaprawa sesji PRZED bramkami przerwy/nocy** (Z7/A8): blok keepalive (12 min) przeniesiony nad `Humanizer.isOnBreak()`/`isSleepTime()`; nowe `SessionWatch.maybeRecover()` — 2 min po wykryciu strony logowania jedna nawigacja na `/` (nie częściej niż co 15 min, nie przy `pending_mission`).
Nie zrobione z Etapu A (wymaga decyzji/koordów lub większej przebudowy): straż jako mapa per para, brama dla ratunków Z KOLEJKI (`queued` nadal wyłącza bramę — stan `GateSave` jest jeden), AirSave per para, GOTOWOŚĆ, wszystkie `ev.targets`, symulator celujący w hub nieaktywny, obchód kolonii przy nadwyżce paska (czeka na wynik testu Events).
Do potwierdzenia w grze: (1) po wizycie `/fleet` na księżycu z flotą — w `ogamex_hangar_map` wpis ma `body:"moon"`; (2) symulacja ataku na kolonię nieaktywną z flotą na księżycu → log „przełączam się na KSIĘŻYC [...]”; (3) brama z pustym `havens` działa jak dotąd.

## AKTUALIZACJA 27.08 (praca, cd.) — v2.107.1–2.107.8: BRAMA POTWIERDZONA NA ŻYWO + 7 poprawek z testu
**Test 09:30 (symulacja `moon` na [2:21:1], cała flota 1,55 bln statków na księżycu):** brama zadziałała pierwszy raz na żywo — skok [2:21:1] → [2:151:8] w ~34 s od pierwszego zobaczenia (09:30:34 → 09:31:08), weryfikacja pustego hangaru OK. Straż 2× zamiotła pusty księżyc (Deploy → planeta, „nothing to save"). Powrót bramą po alarmie: cooldown (~30 min po skoku).
**Ujawnione i naprawione:**
- 2.107.1 bezpiecznik straży podaje koordy pary; pusty hangar wg mapy = info, nie push (09:12 fałszywy push „flota poza domem" z zwietrzałej straży [5:125:4] po 16 h przerwy).
- 2.107.2 powrót bramą w cooldownie = info bez pusha; zrzut strony bramy z TEKSTEM (dotąd pusty HTML).
- 2.107.3 parser „Jumpgate is cooling down : mm:ss" → `ogamex_gate_ready_at_<k>`; powrót ponawiany PO cooldownie, ratunek od razu Deployem.
- **2.107.4 SKOK POSZEDŁ BEZ SUROWCÓW** (przyciski „»" sekcji Resources nie zadziałały, zero logu; flota na [2:151:8] z 0 deuteru = unieruchomiona, 33 bln deuteru zostało na [2:21:1]). Teraz: suma pól po „max", gdy 0 → wpis ręczny z nagłówka gry, gdy nadal 0 → `[BRAMA DOM] Resources`. NIEPOTWIERDZONE na żywo.
- 2.107.5 `canTry` zna cooldown (parser + 30 min po własnym skoku) → kolejny atak na tę parę od razu Deployem (bez 10–15 s na stronie bramy).
- 2.107.6 **zasada operatora: rezerwa deuteru (`threatAlarm.deutReserve` = 100 mld) obowiązuje też przy bramie** — pole deuteru przycięte do dostępny−rezerwa po „max" i po wpisie ręcznym.
- 2.107.7 strona bramy z pustym hangarem = tylko tekst „There are no ships on this planet at this time." (zrzut [4:297:9]) → cicho, bez Deployu z pustego.
- 2.107.8 zrzut formularza bramy (Ships: per statek „»"+pole, zbiorczo „»" i czerwony **„0"** = czyść; Resources: 3 pola z „»", „Cargo space : used / total", przycisk Jump) → „0" wykluczony z kandydatów max; limit ładowni z priorytetem deuter → kryształ → metal.
**Stan floty:** po teście na księżycu [2:151:8] (Colony 2) bez surowców; powrót bramą na [2:21:1] oczekiwany ~09:57–10:00 (brama nie potrzebuje deuteru). Surowce zostały na [2:21:1].
**Otwarte decyzje operatora (zadane 27.08):** koordy 2 schronów (propozycja [7:499:6], [7:209:7] — wszystkie 30 planet mają księżyce); rezerwa deuteru także na schronie przy powrocie; fale 1/28; straż starsza niż 6 h przy starcie bota = zdjąć bez ruchu floty. Push: temat `ogamex-mch-6v3khpb6h388` działa (HTTP 200).
**Do potwierdzenia na żywo:** surowce przy skoku (2.107.4/6/8), test B (switchTo na KSIĘŻYC kolonii nieaktywnej — tryb `planet`, po powrocie floty i zejściu cooldownu), test Events przy sondzie.

## AKTUALIZACJA 27.08 ~10:30 — PRAWDZIWY ATAK, brama WYŁĄCZONA decyzją operatora, v2.107.9–2.108.1
**10:10:36** lista: ATTACK → [2:151:8] (tam flota po teście bramy), ETA 07:16, lądowanie 10:17:53; sekundę później lista i pasek 0 → „kandydat zniknął po 0 s" — ZERO ratunku. Powrót bramą 10:03/10:08/10:15 padał na moim błędzie 2.107.8 (`pageTxt is not defined`). **Operator sam skoczył bramą na [2:21:1] w ostatniej chwili (10:16:35).** Potem pasek `Type: ACS Attack` 2 obce → ucieczka w powietrze [2:21:1] → księżyc [2:21:4] Deploy 10 % z 16 bln deuteru (rezerwa 100 mld została) — zadziałało, zawrót wg zegara.
Wnioski: (1) napastnik ma nas na sondzie co minutę i znajduje flotę 40 min po skoku; (2) lista I PASEK oddają wrogie wiersze najwyraźniej tylko dla AKTYWNEJ pary — hipoteza z rana wzmocniona; (3) ucieczka w powietrze księżyc→księżyc w układzie = najlepsza ścieżka (surowce lecą, bez cooldownu, niewidoczna dla falangi).
Wdrożone: 2.107.9/10 hotfix `pageTxt`; **2.108.0 PAMIĘĆ ATAKU Z LISTY** — wiersz ATTACK z celem i dolotem ≤ 20 min = atak aż do dolotu (`ogamex_atk_until_map`), cel ratunku z pamięci, także gdy `r`=null; **2.108.1 `jumpGate.enabled: false` — DECYZJA OPERATORA: bot NIE teleportuje floty** (kod bramy zostaje, przycisk ręczny działa). NIEPOTWIERDZONE na żywo: pamięć ataku.
Otwarte: powietrze jako ścieżka główna przy ataku na sam księżyc (dziś tylko przy „oba ciała") — do decyzji; obchód kolonii przy nadwyżce paska; straż > 6 h; fale 1/28. Lekcja procesu: `node test-all.js` przez pipe zjada exit code — sprawdzaj `$?` bez pipe (2.108.0 poszło z czerwonym testem).

## AKTUALIZACJA 27.08 ~10:50 — v2.108.2–2.109.0: BRAMA ON ze schronem [7:209:7]
10:37 prawdziwy atak na księżyc [2:21:1] (ETA 05:07) → bot (2.108.2) skoczył bramą [2:21:1]→[2:151:9] w 34 s **z całą flotą i 21,5 bln surowców** (wpis ręczny 2.107.4 działa; rezerwa 100 mld została). Skok poszedł MIMO `enabled:false` w DEFAULT_CONFIG — zapisany config z przeglądarki miał stare `true` (2.108.3 wymusiło OFF w loadConfig). **Operator po tym skoku zdecydował: BRAMA ON** → 2.109.0: `enabled:true`, `havens=[[7:209:7]]` (jedyny cel skoku; [7:499:6] NIE ma bramy), enabled+havens sterowane z repo (loadConfig nadpisuje zapis). Powrót ze schronu nadal BRAMĄ (wypala bramę schronu na ~30 min) — do zrobienia: powrót Deployem księżyc→księżyc. 2.108.2: zwietrzała straż „refugium=brama" schodzi, gdy flota już w domu wg hangaru.
Stan ~10:50: flota + surowce na [2:151:9]; powrót bramą na [2:21:1] po cooldownie (~11:08). Otwarte: zrzut ROZWINIĘTEGO paska flot przy sondzie (markup do wykrywania celu dla wielu księżyców — warunek operatora dla „powietrze jako ścieżka główna"); straż > 6 h przy starcie; powrót ze schronu Deployem.

## AKTUALIZACJA 27.08 ~11:50 — v2.110.0–2.111.0: brama OFF ostatecznie, sąsiedni księżyc, Events = globalne źródło
**Decyzje operatora:** „nie mieliśmy używać jumpgate" → 2.110.0 brama OFF wymuszona w loadConfig (powrót do domu ze schronu dozwolony; ostatni skok 11:15 z całą flotą i surowcami). Atak na SAM księżyc z flotą → **Deploy na księżyc-sąsiada w tym samym układzie + zawrót** (`threatAlarm.airOnMoonAttack`, ścieżka AirSave; potwierdzone testem 11:23: 50 s, cała flota + surowce − rezerwa).
**Błędy testu 11:26 (naprawione 2.110.2):** gasnący alarm po symulacji odpalił ślepy alarm → DRUGA ucieczka z [3:272:7] nadpisała stan pierwszej (jeden stan AirSave) → bot stracił pamięć głównej floty w locie; operator zawrócił ręcznie. Teraz: ślepy alarm tylko z żywego paska (<90 s, bez zerowego odczytu); druga para nie dostaje powietrza, póki pierwsza leci.
**ZRZUTY ROZSTRZYGAJĄCE (Events):** (1) z [3:272:7] Events pokazuje własny lot [2:21:1]→[2:21:4]; (2) 10:16:55 z aktywnej [2:21:1] Events pokazuje wrogi **ACS Attack „Players: 1/2" → Moon [2:151:8]** — **Events i pasek są GLOBALNE, lista `/home/fleetmovementlist` = tylko aktywna para.** Przyczyna ślepoty 10:16: wiersz ACS ma JEDNĄ współrzędną (źródło = „Players: x/y"), `classifyRow` brał ją jako źródło → cel null → wiersz odrzucony. **2.111.0: jedna współrzędna bez .fleet-source-coords = CEL.** Markup wiersza Events: czas · ikona misji · [źródło lub „Players: 1/2"] · liczba statków · strzałka · „Moon [g:s:p]" · ikona gracza (ACS ma ▼ rozwijany).
**Napastnik:** księżyc **[2:22:1]** (układ obok domu [2:21:1]), 1,68 bln statków, dolot 5 min, sondy co minutę. Zalecenie (decyzja operatora, otwarta): przenieść dom floty poza jego zasięg (inna galaktyka, np. [7:209:7]/[7:209:8]).
**Otwarte:** przeniesienie domu floty; straż > 6 h przy starcie = zdjąć bez ruchu (brak decyzji); AirSave per para; powrót z powietrza czytany z Events (dziś „lotu nie ma na liście" przy innej parze aktywnej); Etap A reszta.

## ZAMKNIĘCIE 27.08 ~12:45 — v2.111.1–2.111.4, testy A/B zaliczone, flota na [3:272:7]
- 2.111.1 brak własnego lotu na liście ≠ zawrót (5 prób, zrzut listy+Events, push). **Zrzut 12:16:45 pokazał prawdę: lista MIAŁA nasz lot jako `row-fleet-return` — zawrót z próby 1 zadziałał, przeładowanie strony zjadło zapis stanu; `_findOurRows` wyklucza `return` → fałszywe 5× „nie znajduję" + push + recall_failed.** 2.111.3: wiersz powrotny z naszymi koordami = zawrót potwierdzony.
- 2.111.2/2.111.4: stan ucieczki (każda faza poza arming) domyka się, gdy świeży odczyt hangaru pary (po wysyłce/zawrocie) pokazuje flotę — dotąd wisiał do 10 min po zegarze (recalled) lub 2 h (recall_failed) i BLOKOWAŁ symulację i ratunek pary. **Wniosek: stan powietrza weryfikować hangarem, nie zegarem.** Panel Events przy zawrocie był PUSTY (0 wierszy) — własny lot nie zawsze tam jest; lista ruchów z aktywnej pary go pokazuje.
- **Testy 27.08 (2.111.x, flota 1,55 bln na księżycu [3:272:7]):** A `moon` → ucieczka na [3:272:2] w 46–57 s z całą flotą i surowcami (−100 mld deuteru), zawrót OK, bez ślepego alarmu; B `planet` → bezpieczna strona, flota nietknięta, zamiatanie planety (852 mln HC → księżyc, 21 s). Test ślepego paska pominięty (ścieżka awaryjna).
- **Wywiad:** sondy Lucky [3:250:3] i Paparazzi [4:63:9] co ~1 min na [3:272:7] I [3:272:2] od 11:54 — nowy dom i refugium już znane. Napastnik główny: [2:22:1] (1,68 bln), obok starego domu [2:21:1].
- **Otwarte decyzje operatora:** dom floty (zostać na [3:272:7] czy gal. 6/7); straż > 6 h przy starcie bota; wyciszenie pushy przy symulacjach. **Do kodu (następna sesja):** stan powietrza per para; Events jako główne źródło celu (2.111.0 ACS OK, dalej: dedup/priorytet); zawrót przez Events gdy lista ślepa; straż per para; obchód hangarów.
