# OGameX Assistant 3.0 (Genesis) — start i plan

**Plik:** `ogamex-3.user.js` · `@match https://genesis.ogamex.net/*` · stan pod prefiksem `genesis.ogamex.net:ogx3_*`.
2.x (`ogamex-bot.user.js`) od v2.111.8 ma `@match` tylko `athena.ogamex.net` — skrypty się nie mieszają.

## Instalacja (raz)
1. Tampermonkey → **Utwórz nowy skrypt** → wklej zawartość `ogamex-3.user.js` → zapisz.
   (Albo: otwórz surowy plik z GitHuba — Tampermonkey zaproponuje instalację; `@updateURL`/`@downloadURL` już wskazują na repo, więc kolejne wersje przyjdą same.)
2. Wejdź na genesis.ogamex.net. Panel „OGameX 3" pojawi się w lewym górnym rogu.
3. Kliknij **Test push** i sprawdź telefon (nowy temat ntfy, inny niż na Athenie — zasubskrybuj go w aplikacji).

## Pierwszy dzień — kolejność
1. **Zostaw „Obserwator" (auto-ratunek OFF).** Bot czyta, alarmuje i pisze w logu, co *zrobiłby*, ale nie rusza flotą. To jest sprawdzian, czy fork Genesis ma ten sam markup.
2. Kliknij **Zrzut DOM** raz na przeglądzie i raz na stronie Fleet → wyślij te dwie linie z logu. Sprawdzam pasek planet, pasek misji, panel Events i hangar.
3. Kliknij **TEST: atak na księżyc** (albo na planetę). W trybie obserwatora zobaczysz w logu decyzję („[OBSERWATOR] zrobiłbym: fly …") bez ruchu floty.
4. Gdy zrzuty się zgadzają — **włącz Auto-ratunek** i powtórz test. Wtedy bot naprawdę wyśle flotę i ją zawróci.
5. **Rezerwa deuteru**: na starcie 0. Ustaw, gdy zaczniesz mieć paliwo warte pilnowania (na Athenie 100 mld).

## Co 3.0 robi dziś (etap 1)
- Czyta: pasek planet (pary + księżyce), pasek misji, **panel Events (wszystkie kolonie)** i listę ruchów (aktywna para), hangary przy każdej wizycie na `/fleet`.
- Buduje **Situation** — jeden stan: pary, hangary (ile/gdzie/kiedy), zagrożenia (cel, ciało, ETA, źródło), własne loty, loty wysłane przez bota.
- Decyduje **jedną czystą funkcją** `decide(situation, cfg, now)`:
  - atak w ciało, gdzie stoi flota → **sąsiedni księżyc w tym samym układzie** (10 %, z surowcami − rezerwa, zawrót po przejściu ataków);
  - brak sąsiada → **drugie ciało pary**, ale nigdy atakowane;
  - oba ciała pod atakiem → **inna kolonia** (powietrze) + zawrót;
  - atak w ciało, gdzie floty nie ma → **hold** (bezpieczna strona), zero ruchu;
  - cisza + flota na planecie pary z księżycem → **powrót na księżyc** (dom = księżyc);
  - dolot < 40 s → tylko alarm (formularz nie zdąży); zagrożenie świeższe niż 20 s → potwierdzenie, chyba że dolot krótki.
- Wykonuje: jeden lot (Deploy) w krokach *przełącz ciało → formularz 3 kroków → potwierdzenie*, oraz zawrót (`x_btn_fleet_return`).
- Push ntfy: ATAK (urgent), ewakuacja, BŁĄD, powrót. Głos opcjonalny.

## Czego 3.0 jeszcze NIE robi (świadomie)
Ekspedycji, miningu asteroid, farmienia nieaktywnych, Fleet Save nocnego, bramy skokowej, odbudowy księżyca, kolejki budynków. Wchodzą etapami, gdy obrona będzie potwierdzona na żywo — najpierw FS nocny i ekspedycje.

## Zasady, które 3.0 egzekwuje z definicji (lekcje 27.08 z Atheny)
| Incydent 2.x | Reguła 3.0 |
|---|---|
| Stan ucieczki wisiał 3× i blokował ratunek | lot zamyka **hangar**, nie zegar (`flights` czyszczone, gdy hangar źródła znów pełny) |
| Druga ucieczka nadpisała pierwszą | stan lotu **per para**; para w locie nie dostaje drugiej akcji |
| Straż z testu przeniosła flotę na planetę 3 s przed atakiem | brak „straży": jest tylko sytuacja; dom = księżyc, gdy para go ma |
| Ratunek przeniósł flotę **na atakowane ciało** | cel lotu nigdy nie jest ciałem, w które leci atak |
| Config z przeglądarki nadpisał kod | jeden `CFG` z panelu; wartości krytyczne są w kodzie |
| Wiersz ACS („Players: 1/2") gubił cel | jedna współrzędna bez źródła = **cel** (przeniesione z 2.111.0) |

## Testy
```
node test3-all.js        # decyzje + składnia; sprawdzaj `echo $?` BEZ pipe'a
```
`test3-decide.js` to macierz 25 asercji — każdy incydent z 27.08 jest osobnym przypadkiem.

## Uwagi o forku
Genesis to ten sam fork .NET co Athena, ale **nie zakładamy tego**: przy nieznanym markupie 3.0 zrzuca DOM do logu (`[LOT DOM]`, `[DOM]`) i **nie zgaduje**. Jeśli któryś selektor nie zadziała, w logu będzie surowy HTML do wklejenia.

## v3.1.0 — start bez klikania (gdy Genesis ruszy)
- **Raport startowy**: bot sam zbiera dowody markupu przy pierwszym kontakcie z każdą stroną (pasek planet, pasek misji, panel Events, strona Fleet — 4/4). Panel pokazuje postęp „KALIBRACJA: n/4”. Gdy komplet: klik **Kopiuj raport startowy** → wklej Claude'owi. Nie trzeba pamiętać o „Zrzut DOM”.
- **Karta przy życiu**: Screen Wake Lock (laptop nie zasypia przy widocznej karcie) + cichy dźwięk (przeglądarka nie dławi timerów w tle). Bez tego pętla obrony w karcie w tle chodzi ~1/min zamiast co 20 s.
- Kolejność pierwszego dnia bez zmian: Obserwator → raport → (po mojej weryfikacji) Auto-ratunek.
