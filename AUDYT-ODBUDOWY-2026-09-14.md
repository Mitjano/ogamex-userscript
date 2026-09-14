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

## OTWARTE — P0

**Licznik prób nie jest kasowany po UDANEJ odbudowie.** Sukcesy zużywają tę samą dobową pulę
co porażki, więc druga strata księżyca tego samego dnia może trafić na wyczerpany limit.
Częściowo złagodzone w v3.95.1 (odbudowa ma własny limit 20 i karencję 60 s), ale samo
kasowanie po sukcesie nadal nie istnieje.

**Jedna nieudana odbudowa potrafi zjeść cały limit w ~60 s.** Cztery nawigacje bez efektu =
jedna „próba", a pod ostrzałem kolizje ze stroną idą jedna za drugą. Przy limicie 3 (nowe
księżyce) zamyka parę na dobę. Dla odbudowy limit jest teraz 20, ale mechanizm zjadania został.

**Odrzucony submit „Form a moon" nie jest rozpoznawany.** Bot uznaje próbę za wykonaną, choć
gra jej nie przyjęła — nie ma odpowiednika weryfikacji, którą ma wysyłka floty.

**Potwierdzenie odbudowy i zwóz floty stoją za tą samą bramką, którą v3.95.0 miała ominąć.**
Czyli nawet po udanym postawieniu księżyca krok „zwieź flotę z planety na nowy księżyc" może
nie ruszyć pod ostrzałem. To jest krok 6 doktryny DESTROY.

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
