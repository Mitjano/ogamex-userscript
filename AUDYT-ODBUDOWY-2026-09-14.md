# AUDYT ŁAŃCUCHA ODBUDOWY KSIĘŻYCA — 14.09.2026

Pięć niezależnych wymiarów (warunki wywołania · znacznik straty · limity prób · wykonanie ·
po odbudowie). Każde znalezisko atakowane przez osobnego sceptyka z instrukcją „domyślnie uznaj
za nierealne". 46 agentów, zero błędów wykonania. Niżej **tylko to, co przetrwało weryfikację**.

Audyt czytał v3.95.0. Dwie pozycje naprawiłem tego samego dnia — reszta jest **OTWARTA**
i to jest lista do pracy.

> Uwaga o wiarygodności: to są diagnozy z czytania kodu, potwierdzone przez drugiego agenta,
> ale **nieodtworzone testem**. Zanim coś z tej listy naprawisz, napisz najpierw test, który
> pada — inaczej powtórzysz błąd z 13.09, kiedy poprawka szła bez dowodu.

---

## ZROBIONE

**[P0] `Moon.tick` zabijał się sam przy każdym nadlatującym ataku.** Trzecia linia funkcji
wychodziła przy dowolnym wrogim locie na koncie — a księżyc ginie właśnie podczas nalotu.
Naprawione w **v3.95.1**: bramka nie dotyczy odbudowy (`!this.doOdbudowy(s) && …`).
To samo złapał niezależnie scenariusz E2E 43c.

**[P1] Znacznik straty czytał tylko pasek planet ŻYWEJ strony.** `Bar.fetchFresh` pobiera pełne
`/home` co ~100 s, ma tam pasek planet i go wyrzucał, więc `moonLost` czekał na realne
przeładowanie (keepalive: do 10 minut). Naprawione w **v3.95.2** — wykrycie straty schodzi
do ~100 s. Tylko utrata; „nagle ma księżyc" zostaje przy żywej stronie.

---

## P0 — ZAMKNIĘTE w v3.96.0 (14.09 popołudnie, E2E 68 + decide 82)

**Licznik prób nie jest kasowany po UDANEJ odbudowie.** → Sukces kasuje `st.tries[key]`;
druga strata tego samego dnia idzie od razu (68a–c).

**Jedna nieudana odbudowa potrafi zjeść cały limit w ~60 s.** → Po v3.95.1 (limit 20, karencja
60 s dla odbudowy) i po rozpoznawaniu odrzuconego submitu (niżej) jedno podejście = jedna próba;
mechanizm „4 nawigacje = próba" zostaje jako sufit kolizji ze stroną. Bez osobnej zmiany.

**Odrzucony submit „Form a moon" nie jest rozpoznawany.** → Kliknięcie z ustawionym `m.km`,
strona formowania nadal stoi, księżyca nie ma = odmowa gry: liczona jako próba, tekst strony
do logu, przy odbudowie wpis BŁĄD (push). Bez klikania w kółko (68d–g).

**Potwierdzenie odbudowy i zwóz floty stoją za tą samą bramką, którą v3.95.0 miała ominąć.**
→ Weryfikacja „para ma już księżyc?" idzie PRZED bramką ataków; wołający daje modułowi przebieg
także pod ostrzałem, gdy czeka weryfikacja albo zwóz (`Moon.pending()`); zwóz ma własny znacznik
`st.zwoz`, który czeka na pierwszą ciszę (godzinę), zamiast przepaść (68h–m).

## OTWARTE — P1

**Przełączenie planety pod odbudowę przestawia jedyny per-parowy detektor ataków i nigdy go
nie przywraca.** Lista ruchów dotyczy AKTYWNEJ pary; odbudowa przestawia aktywną parę i zostawia
ją przestawioną. Tu jest realne ryzyko dla obrony, nie tylko dla ekonomii.

**Przy znaczniku `planet_drift` bot otworzy formularz OBCEJ planety i tam wyda metal.**
Sesja stoi wtedy na innej kolonii, niż bot sądzi.

**Martwy klucz w `s.pairs` (porzucona/utracona kolonia) trwale blokuje odbudowę pozostałych par.**
`target()` zwraca pierwszą bezksiężycową parę i nie idzie dalej, gdy tamta jest nieosiągalna.

**`target()` nie priorytetyzuje utraconego księżyca**, a obejście ekonomii jest globalne dla konta.

**Flota ewakuowana PRZED odbudową nie wraca nigdy** — zwóz po odbudowie jej nie obejmuje.

## OTWARTE — P2

- Pierwsza bezksiężycowa para spoza paska planet blokuje odbudowę reszty.
- `navs` nie jest zerowane po realnym postępie, więc każda obca nawigacja zamienia się w próbę.
- Odbudowa nie dociera na telefon: alarm o stracie krzyczy, odwołanie alarmu milczy.
- Przeterminowana próba kasowana bez sprawdzenia, czy księżyc jednak powstał.
- `s.moonLost` bez terminu ważności; `target()` nie nakłada karencji na parę, której nie widzi.
