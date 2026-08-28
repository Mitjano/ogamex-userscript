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
| 1 | Zostaw **Obserwator** (auto-ratunek OFF), całą ekonomię OFF | panel: „Obserwator (auto-ratunek OFF)" |
| 2 | Graj normalnie; zajrzyj raz na **Fleet** i raz na **Galaxy** | panel: „KALIBRACJA: 4/4" |
| 3 | **Kopiuj raport startowy** → wklej Claude'owi | potwierdzę parsery albo poprawię selektory |
| 4 | Po potwierdzeniu: **Auto-ratunek ON**, klik **TEST: atak na księżyc/planetę** | w logu pełna sekwencja lotu i zawrotu |
| 5 | Dopiero potem włączaj ekonomię: **Ekspedycje** → (gdy będą minery) **Mining** → **Złom** → **FS nocny** | każdy moduł loguje, co robi i czego mu brakuje |

## Moduły (wszystko sterowane z panelu)
| moduł | co robi | warunki, których pilnuje sam |
|---|---|---|
| **Obrona** | atak w ciało z flotą → sąsiedni księżyc w układzie (powolny Deploy + zawrót); brak sąsiada → drugie ciało pary; oba ciała → inna kolonia; atak w puste ciało → nic | nigdy nie leci NA atakowane ciało · jedna ucieczka na parę · dolot < 40 s = tylko alarm · dom = księżyc |
| **Rekonesans** | sam chodzi na `/fleet`, żeby wiedzieć, gdzie stoi flota | nigdy przy alarmie, misji ani locie |
| **FS nocny** | w oknie (domyślnie 23–7) wyprowadza flotę na najdalszą nieatakowaną kolonię, zawrót o świcie | atak w nocy → normalny ratunek wygrywa z FS |
| **Ekspedycje** | fale na poz. 16, 40 min (Odkrywca) | rozmiar fali zamrożony na serię · ostatnia fala domyka hangar · limity slotów · odstęp fal |
| **Mining** | zakresy asteroid → skan systemów → minery na poz. 17 | nie skanuje bez minerów · pomija asteroidy znikające za < 5 min |
| **Złom** | recyklery na poz. 16 i pozycję bazy | recyklery nie latają na ekspedycje, więc zawsze jest czym zbierać |
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
node test3-all.js        # 157 asercji + 45 sprawdzeń E2E + składnia; sprawdzaj `echo $?` BEZ pipe'a
```
`test3-e2e.js` uruchamia **cały kod bota na sztucznej grze w jsdom** — 14 scenariuszy, m.in. pełna ewakuacja od wykrycia ataku do „Send fleet", **zawrót floty i domknięcie lotu po jej powrocie**, ślepy alarm z paska, utrata sesji i powrót, dwa ataki naraz, atak przerywający ekonomię, dwie karty, przeładowania strony w środku misji.
Macierz `test3-decide.js` obejmuje: obronę (27 scenariuszy, w tym wszystkie incydenty 27.08 i regresje z audytu 28.08), FS nocny, okno nocne, ekspedycje z serią, mining, złom, humanizera i strażników „ekonomia nie blokuje obrony".

## Czego świadomie nie ma
Farmienia nieaktywnych, bramy skokowej, odbudowy księżyca, kolejki budynków/badań, kolonizacji. Wejdą, gdy będą potrzebne — brama i księżyce dopiero, gdy je postawisz.

## Uwagi o forku
Genesis to prawdopodobnie ten sam fork .NET co Athena, ale **nie zakładamy tego**. Przy nieznanym markupie 3.x zrzuca DOM do logu (`[LOT DOM]`, `[EXPO DOM]`, `[ZŁOM]`, `[KALIBRACJA]`) i **nie zgaduje** — dostaniesz surowy HTML do wklejenia zamiast cichego błędu.
