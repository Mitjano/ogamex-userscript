# Audyt zarządzania flotą i bezpieczeństwa (29.08.2026, v3.35.0)

Metoda: lekcje z Atheny (`AUDYT-HUBY-2-OBRONA-2026-08-27.md`, sekcje „czerwona/niebieska
drużyna" A1–A9 / Z1–Z10, `MOON-STRATEGY-2026-08-26.md`, `AUDYT-OBRONA-2026-08-06.md`)
skonfrontowane linia po linii z kodem 3.x. Każde znalezisko sprawdzone w źródle, nie
z pamięci; poprawki mają testy czerwone na wersji sprzed poprawki.

Kontekst konta na dziś: jedna baza [1:217:6] (planeta + **świeży księżyc z 20:28**),
ekspedycje 4/4 z serią 4 fal, cała flota bojowa w rotacji, 374 minery, brak bramy
skoku, FS nocny WYŁĄCZONY, rekonesans „tylko ciała z flotą".

## 1. Zasady Atheny, które 3.x spełnia (sprawdzone w kodzie)

| zasada z Atheny | stan w 3.x |
|---|---|
| **Z1** Flota w locie > księżyc > planeta | Ekspedycje trzymają flotę w powietrzu (4/4 sloty), reguła „dom = księżyc" ściąga resztę z planety na księżyc. |
| **Z5** Obrona per para, nie tylko dla pary aktywnej | `decide()` iteruje WSZYSTKIE pary z paska; pasek i Events są globalne, lista ruchów dociągana fetchem. |
| **Z7** Keepalive zawsze, także w przerwie i w nocy | `setInterval(keepalive, 60e3)` poza humanizerem; przerwy dotyczą wyłącznie ekonomii. Sesja utracona → jedna nawigacja po 2 min (Athena: 15 min ślepoty). |
| **Z8** Noc = flota w powietrzu, minery też | Lot FS nie ma listy statków, więc bierze cały hangar razem z minerami. (Moduł jest jednak OFF — patrz F3.) |
| Sonda nie rusza flotą | `Rows.SPY` klasyfikuje sondy osobno; `attack:false`, próg paska dla „Type: Spy" wydłużony do 5 min. |
| Ratunek nigdy NA atakowane ciało | `anyRefuge`/`neighbourMoon` odrzucają pary z zagrożeniem; drugie ciało pary tylko gdy nieatakowane. |
| Jedna ucieczka na parę, stan zamykany hangarem | `inFlightFrom` + domykanie wpisu widokiem floty w hangarze celu/źródła. |
| Zniszczenie księżyca (Destroy) to atak | `Rows.ATTACK` zawiera `DESTRUCT|DESTROY` → flota ucieka z księżyca. |
| Ślepy alarm, gdy pasek widzi więcej niż lista | `barExcess` + próg trwania; broni kolonii z największym hangarem, kolejne w następnych przebiegach. |

## 2. Naprawione dziś

| # | waga | znalezisko | poprawka |
|---|---|---|---|
| **F1** | P0 | **Po postawieniu księżyca wracające fale zostawały na planecie.** Reguła „dom = księżyc" pytała `fleetAt()`, czyli JEDNO „gdzie mieszka flota" — przy 73 tys. statków na księżycu zwracało „moon", więc statki lądujące na planecie nie były domem i nikt ich nie ruszał. Dokładnie łup ze ścieżki A5 Atheny (snajperka powrotów). | v3.34.0: reguła patrzy wprost na hangar PLANETY (odczyt <30 min, cokolwiek >0). Efekt uboczny pożądany: każdy taki lot wiezie surowce planety na księżyc, a to jedyny dopływ deuteru na ciało, które go nie produkuje. |
| **F2** | P0 | **Bot nie wiedział, kiedy jego flota wraca.** `s.own` (własne loty, w tym powroty z ETA) było parsowane i **nigdy nieużywane**, a wiersz powrotu znika z listy w sekundzie lądowania. Po powrocie fali statki stały na planecie do przypadkowego odczytu hangaru — do ~8 min. | v3.35.0: termin każdego własnego powrotu zapisywany w stanie (`landings`); po jego minięciu obrona wymusza odczyt hangaru tego ciała, a kolejny przebieg odsyła statki na księżyc. |
| **F3** | P0 | Dławik pusha liczony po RODZAJU zdarzenia — atak na drugą kolonię w ciągu 5 min po pierwszym nie dawał powiadomienia. | v3.33.0: klucz = rodzaj + współrzędne. Push testowany naprawdę (koniec zaślepki `GM_xmlhttpRequest`). |

## 3. Otwarte — ryzyka i decyzje właściciela

| # | waga | rzecz | rekomendacja |
|---|---|---|---|
| **R1** | P0 | **Push nie dociera na telefon.** Bot wysyła (HTTP 200), ale nikt nie subskrybuje tematu. Cała obrona kończy się wtedy na czerwonym panelu w przeglądarce. | Zapisać telefon na `ogamex3-d0zjvhl9eiho` w aplikacji ntfy; wyłączyć optymalizację baterii dla niej. |
| **R2** | P0 | **Obrona nigdy nie sprawdzona na żywo na Genesis.** Wszystko powyżej to dowód z testów. | „TEST: atak na planetę" i „TEST: atak na księżyc" w panelu — po zapisaniu telefonu. |
| **R3** | P1 | **FS nocny OFF.** W nocy flota, która akurat nie jest na ekspedycji, stoi na księżycu. Athena traciła tak księżyce (Destroy + snajperka). Przy 4/4 ekspedycjach ryzyko jest ograniczone, ale okna między falami istnieją. | Włączyć FS 23–7 albo świadomie przyjąć ryzyko; FS bierze też minery. |
| **R4** | P1 | **Atak z własnego układu** fork gubi na liście — reaguje wtedy ślepy alarm, który potrzebuje 60 s trwania nadwyżki na pasku. Przy uderzeniu o ETA ~90 s zostaje ~30 s na formularz. To ograniczenie Atheny (A2), nie regresja. | Zostawić; skrócenie progu = fałszywe ewakuacje na sondach. |
| **R5** | P1 | **Sonda maskuje typ w pasku** („Type: Spy" wydłuża próg do 5 min) — rój sond przed atakiem z własnego układu opóźnia ślepy alarm. Świadome ryzyko odziedziczone po 2.x (A9). | Zostawić, ale wiedzieć, że seria sond = moment podwyższonej czujności. |
| **R6** | P1 | **Ślepy alarm ratuje jedną kolonię na przebieg** (największy hangar), kolejne dopiero w następnych tickach. Athena zaleca „broń WSZYSTKICH" (Z3). Przy jednej bazie bez znaczenia; przy rozbudowie kont — istotne. | Do zrobienia, gdy powstanie druga kolonia z realną flotą. |
| **R7** | P2 | **Brak bramy skoku** na Genesis, więc cała strategia „schronów" (Z2) nie ma zastosowania. Ucieczka to zawsze Deploy + zawrót. | Nic do zrobienia dziś. |
| **R8** | P2 | **Rezerwa deuteru = 0** — każdy lot obronny i „dom = księżyc" zabiera z ciała wszystkie surowce. Dla obrony to dobrze (surowce uciekają razem z flotą), dla rozbudowy planety mniej. | Świadoma decyzja; jeśli chcesz budować na planecie, ustaw rezerwę albo licz się z pustą kasą. |
| **R9** | P2 | **374 minery leżą bezczynnie** — mining OFF, a minery są w wykluczeniach ekspedycji, więc nie latają nigdzie. | Włączyć mining albo świadomie zostawić. |
| **K1** | P0 | Wciąż **zero widoku zarobku** — łup z ekspedycji nie jest parsowany. | Otwarte z porannego audytu. |

## 4. Wnioski

Obrona 3.x jest dziś bliżej lekcji Atheny niż sama Athena w chwili incydentów: ma jedno
źródło prawdy, czystą decyzję z testami, obronę per para i keepalive poza humanizerem.
Dwie realne dziury w zarządzaniu flotą (statki zostające na planecie po powrocie i brak
wiedzy o terminach powrotów) zostały dziś zamknięte i mają testy regresji.

Największe ryzyko nie jest już w kodzie, tylko w łańcuchu powiadomienia: **push, którego
nikt nie odbiera, jest wart tyle, co jego brak** — i to jest jedyna rzecz na tej liście,
której bot nie naprawi sam.
