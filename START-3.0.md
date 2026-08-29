# OGameX Assistant 3.x (Genesis) — start i obsługa

**Plik:** `ogamex-3.user.js` · `@match https://genesis.ogamex.net/*` · stan pod prefiksem `genesis.ogamex.net:ogx3_*`.
2.x (`ogamex-bot.user.js`) od v2.111.8 ma `@match` tylko `athena.ogamex.net` — skrypty się nie mieszają.
Profil gracza: **ODKRYWCA** (ekspedycje 40 min ustawione domyślnie).

## Instalacja (raz)
1. Tampermonkey → **Utwórz nowy skrypt** → wklej `ogamex-3.user.js` → zapisz. (Albo otwórz surowy plik z GitHuba — `@updateURL`/`@downloadURL` wskazują na repo, więc kolejne wersje przyjdą same.)
2. Wejdź na genesis.ogamex.net — panel „OGameX 3" w lewym górnym rogu.
3. **Test push** → zasubskrybuj w telefonie temat pokazany w panelu (inny niż na Athenie).

## Pierwszy dzień — dokładna kolejność
| krok | co robisz | po czym poznasz, że OK |
|---|---|---|
| 1 | Zostaw **Obserwator** (auto-ratunek OFF), całą ekonomię OFF | pasek stanu: 🛡 Obrona — „czysto · obserwator" |
| 2 | Graj normalnie; zajrzyj raz na **Fleet** i raz na **Galaxy** | panel: „KALIBRACJA: 4/4" |
| 3 | **Kopiuj raport startowy** → wklej Claude'owi | potwierdzę parsery albo poprawię selektory |
| 4 | Po potwierdzeniu: **Auto-ratunek ON**, klik **TEST: atak na księżyc/planetę** | w logu pełna sekwencja lotu i zawrotu |
| 5 | Dopiero potem włączaj ekonomię: **Ekspedycje** → (gdy będą minery) **Mining** → **Złom** → **FS nocny** | każdy moduł loguje, co robi i czego mu brakuje |

## Panel (v3.11.0 — wygląd jak na Athenie)
Szerokość **232 px**, więc kończy się przed menu gry (Overview, Resources…) i niczego nie zasłania.
- **Pasek stanu** na górze — pięć linii, pięć odpowiedzi bez klikania: Obrona / Flota / Ekspedycje / Mining / Fleet Save. Kolor niesie znaczenie: zielony = spokój, pomarańczowy = praca, czerwony = alarm.
- **Ustawienia siedzą w zwiniętych sekcjach** (klik w tytuł rozwija). Co jest otwarte, przeżywa przeładowanie.
- **Nagłówek jest przeciągalny**, „_” zwija panel do samego nagłówka. Pozycja i zwinięcie zapisują się w GM storage.
- **Atak rozwija zwinięty panel** i maluje go na czerwono — obrony nie da się przegapić przez schowany panel.
- **RATUJ FLOTĘ TERAZ / WRÓĆ NA BAZĘ** są zawsze widoczne (nie chowają się w sekcji).
- **Dziennik obrony** — ostatnie 25 zdarzeń (ATAK / RATUNEK / POWRÓT / BŁĄD) w panelu, nie tylko w pushu.

## Moduły (wszystko sterowane z panelu)
| moduł | co robi | warunki, których pilnuje sam |
|---|---|---|
| **Obrona** | atak w ciało z flotą → sąsiedni księżyc w układzie (powolny Deploy + zawrót); brak sąsiada → drugie ciało pary; oba ciała → inna kolonia; atak w puste ciało → nic | nigdy nie leci NA atakowane ciało · jedna ucieczka na parę · dolot < 40 s = tylko alarm · dom = księżyc |
| **Rekonesans** | **domyślnie WYŁĄCZONY** — tak jak na Athenie, gdzie hangar czytał się przy okazji. Hangar bierze się z: (1) każdej Twojej wizyty na /fleet, (2) cichego pobrania strony floty w TLE przed wysyłką ekspedycji (bez przełączania planety), (3) alarmu — wtedy bot ma prawo wejść na atakowane ciało (3 próby). Patrol można włączyć w panelu: tylko flota → wszystkie → OFF | nie przełącza Ci planety, gdy grasz · alarm jest osobną ścieżką |
| **FS nocny** | w oknie (domyślnie 23–7) wyprowadza flotę na najdalszą nieatakowaną kolonię, zawrót o świcie | atak w nocy → normalny ratunek wygrywa z FS |
| **Ekspedycje** | fale na poz. 16, 40 min (Odkrywca) | rozmiar fali zamrożony na serię · ostatnia fala domyka hangar · limity slotów · odstęp fal |
| **Mining** | zakresy asteroid → skan systemów → minery na poz. 17, **flota dobierana pod urobek**, resztą minerów kolejne asteroidy (loty równoległe) | nie skanuje bez minerów · pomija asteroidy znikające przed dolotem · zostawia wolne sloty (rezerwa) · lot poniżej połowy sensownej fali czeka na powroty |
| **Złom** | recyklery na poz. 16 i pozycję bazy | recyklery nie latają na ekspedycje, więc zawsze jest czym zbierać |
| **Bonus online** | odbiera zielony „Online bonus" z menu = antymateria + **punkty Akademii** (przeniesione z 2.x, domyślnie ON) | nie rusza flotą · nigdy przy alarmie ani w trakcie misji · odliczanie/wyszarzony przycisk = nie klika · odbiór potwierdzany po przeładowaniu |
| **Księżyce** | stawia księżyc przy planecie bez księżyca (`/home/moonformation`) — **domyślnie OFF, bo WYDAJE metal bezpowrotnie** | sufit udziału metalu (domyślnie 25%) · średnica dobierana w dół · 3 próby na planetę na dobę · nieznany markup = zrzut do logu |
| **Humanizer** | przerwy 5–15 min co 35–65 min, noc bez ekonomii | **dotyczy wyłącznie ekonomii** — obrona, rekonesans i keepalive chodzą zawsze |
| **Karta przy życiu** | Wake Lock + cichy dźwięk | bez tego pętla w tle chodzi ~1/min zamiast co 20 s |

## Zasady, które 3.x egzekwuje z definicji (lekcje 27.08 z Atheny)
| Incydent 2.x | Reguła 3.x |
|---|---|
| Stan ucieczki wisiał i blokował ratunek | lot zamyka **hangar**, nie zegar |
| Druga ucieczka nadpisała pierwszą | stan lotu **per para** |
| Straż z testu przeniosła flotę na planetę 3 s przed atakiem | brak „straży" — jest tylko sytuacja; dom = księżyc |
| Ratunek poleciał **na atakowane ciało** | cel lotu nigdy nie jest ciałem pod atakiem |
| Przerwa kawowa usypiała keepalive → wylogowanie | przerwy dotyczą tylko ekonomii |
| Ekspedycja/mining blokowały obronę wspólnym slotem misji | loty ekonomiczne **nie trafiają** do stanu lotów obronnych |
| Config z przeglądarki nadpisał kod | jeden `CFG`, wartości krytyczne w kodzie |
| Wiersz ACS („Players: 1/2") gubił cel | jedna współrzędna bez źródła = **cel** |

## Co zmieniła trzecia fala audytu (v3.10.0, 28.08)
| Defekt | Skutek w grze, gdyby został | Reguła teraz |
|---|---|---|
| Wpis lotu `pending` był nieśmiertelny | klik „Send fleet" nawiguje natychmiast, kod potwierdzający nie wykonuje się → wpis zostaje **na zawsze**, a bot **milczy przy każdym kolejnym ataku na tę parę** | `pending` wygasa po 10 min; sprząta go też abort i nieudana wysyłka |
| Rekonesans wywłaszczał ratunek | para atakowana za 70 s czekała, bo inna para (za 400 s) potrzebowała rekonesansu | akcje sortowane: **ratunek zawsze pierwszy**, rekonesans ustępuje |
| Karencja 3 min po potknięciu formularza | jedno potknięcie = bezczynność dłuższa niż dolot | ratunek ponawiany po 45 s (rutyna nadal 3 min) |
| Lot ekonomiczny blokował obronę | ekspedycja/mining trzymały „misję" do 5 min = tyle, ile dolot | alarm **przerywa ekonomię** natychmiast |
| Ślepy alarm ze starego paska | strona bez paska (formularz, błąd, logowanie) zostawiała stary odczyt → ewakuacja na danych sprzed godziny | pasek starszy niż 3 min nie jest dowodem |
| Zawrót „kliknięty" = „zawrócony" | nieskuteczny klik nie doczekał się drugiej próby | stan `recall_clicked`, ponowienie po 2 min, potwierdzenie dopiero wierszem powrotnym |
| Lot po nieudanym zawrocie zaślepiał parę na 12 h | cisza przy ataku | `flightStale` — jedna definicja dla obrony, ekonomii i rekonesansu + alarm do operatora |

## Testy
```
node test3-all.js        # 164 asercje + 77 sprawdzeń E2E + 19 sprawdzeń panelu + składnia; sprawdzaj `echo $?` BEZ pipe'a
#                          wymaga: npm install jsdom  (w katalogu repo)
```
`test3-e2e.js` uruchamia **cały kod bota na sztucznej grze w jsdom** — **24 scenariusze**: pełna ewakuacja od wykrycia ataku do „Send fleet", zawrót floty i domknięcie lotu po powrocie, FS nocny (wyjście wieczorem + zawrót o świcie), ślepy alarm z paska i pasek nieświeży, utrata sesji, strona błędu gry, dwa ataki naraz, atak przerywający ekonomię, potknięcie formularza, przejęcie planety przez operatora w trakcie misji, nieaktualny hangar, formularz bez suwaka prędkości, mining, złom, dwie karty, przeładowania strony w środku misji.
Macierz `test3-decide.js` obejmuje: obronę (27 scenariuszy, w tym wszystkie incydenty 27.08 i regresje z audytu 28.08), FS nocny, okno nocne, ekspedycje z serią, mining, złom, humanizera i strażników „ekonomia nie blokuje obrony".

## Gdy bot przeładowuje grę w kółko (v3.12.0)
Log mówi to teraz wprost: linia startowa kończy się adresem strony i „← bot: <powód>" albo „← otwarte ręcznie", a przy ≥5 startach na minutę pojawia się wiersz **[TEMPO]** z ostatnią nawigacją bota. Twarde bezpieczniki: misja przerywa się po **6 nawigacjach** bez otwarcia formularza, wejście na Fleet przy alarmie po **3 próbach** (potem push „nie mogę odczytać hangaru"), a ekonomia respektuje 3-minutową karencję po nieudanym locie, więc nie startuje od nowa w tę samą pętlę.
Czego [TEMPO] **nie** robi: nie krzyczy na Twoje klikanie. Każde kliknięcie w tym forku to pełne przeładowanie strony, więc przy rozbudowie budynków bywa i 18 startów na minutę — alarm liczy wyłącznie przeładowania z powodem „← bot:". Rekonesans też ustępuje: gdy klikasz po grze, nie przełącza Ci planety (najdalej przez 5 min).
Nadzorca (przeładowanie po 3 min ciszy pętli) **nie działa przy bocie OFF** — wyłączony bot ma prawo milczeć; wcześniej co 10 min przeładowywał grę i słał push „BŁĄD".

Incydent źródłowy: 28.08 22:17–22:22 — ~30 przeładowań w 5 minut, w logu SAME linie startowe, koniec dopiero na limicie czasu misji (push „BŁĄD"). Powody ginęły, bo log zapisywał się do GM storage z opóźnieniem 800 ms, a każda nawigacja następuje natychmiast po wpisie.

## Czego świadomie nie ma
Farmienia nieaktywnych, bramy skokowej, kolejki budynków/badań, kolonizacji, czytania raportów przez Gemini, czarnej listy farmy. Wejdą, gdy będą potrzebne — brama i księżyce dopiero, gdy je postawisz.

## Prędkość uniwersum (Genesis x3, Athena miała x4)
Genesis jest **wolniejszy od Atheny** — te same trasy trwają ok. 1/3 dłużej. Dla bota to w większości przezroczyste: **czas lotu jest zawsze czytany z formularza** („Duration of flight"), nigdy liczony ze wzoru, więc zawrót, „lądowanie zamiast wiszenia" i FS nocny same się dostrajają do mnożnika.
Co z tego wynika w praktyce:
- ataki lecą dłużej → **więcej czasu na reakcję** (progi 20 s na potwierdzenie i 40 s „za późno na formularz" zależą od bota, nie od uniwersum);
- ucieczka na 10% wisi w powietrzu dłużej → zawrót prawie zawsze ma sens, rzadziej dochodzi do lądowania na kolonii docelowej;
- **mining wymagał poprawki**: minery lecą dłużej, więc filtr „asteroida musi żyć ≥5 min" bywał za krótki. Od v3.10.4 bot porównuje TTL asteroidy z **rzeczywistym czasem lotu** (+10% zapasu) i przerywa wysyłkę, jeśli asteroida zniknie przed dolotem;
- ekspedycje: dolot na poz. 16 dłuższy, ale czas trzymania (40 min u Odkrywcy) ustawiany osobno — cykl fali po prostu trwa dłużej.

## Uwagi o forku
Genesis to prawdopodobnie ten sam fork .NET co Athena, ale **nie zakładamy tego**. Przy nieznanym markupie 3.x zrzuca DOM do logu (`[LOT DOM]`, `[EXPO DOM]`, `[ZŁOM]`, `[KALIBRACJA]`) i **nie zgaduje** — dostaniesz surowy HTML do wklejenia zamiast cichego błędu.
