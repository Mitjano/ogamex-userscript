# AUDYT OBRONY — 30.08.2026, 10:25 (v3.39.2, Genesis)
Pytanie ownera: „czy teraz bot obroni flotę, jak nas ktoś zaatakuje?" oraz „nie dostaję
powiadomień na telefon o ataku, tak jak było na Athenie".

## 1. PUSH NA TELEFON — działa, tylko nie jesteś zapisany na ten kanał
Dowód z logu 09:17:56 (symulacja ataku):
`[PUSH] wysłano (urgent) na ogamex3-d0zjvhl9eiho: ⚔️ ATAK (Genesis) — HTTP 200`
HTTP 200 = ntfy.sh przyjęło wiadomość. Transport jest sprawny, priorytet `urgent`
(przebija tryb cichy telefonu). Skoro nic nie doszło, telefon nie subskrybuje kanału.

**Kanał generuje się LOSOWO przy pierwszym uruchomieniu skryptu** (`Notifier.topic()` — losowe
12 znaków, zapisane w GM storage per host). Na Athenie chodzi **2.x na innym hoście**, więc ma
INNY kanał. To dlatego tam powiadomienia działają, a tu nie.

**DO ZROBIENIA (30 sekund):** w aplikacji ntfy dodaj subskrypcję kanału **`ogamex3-d0zjvhl9eiho`**
(dokładnie ten ciąg widnieje w panelu pod „Push ON"). Potem kliknij w panelu **„Test push"** —
musi przyjść. Kanał jest jawny, więc kto go zna, może na niego pisać; nie publikuj go nigdzie.

## 2. CZY BOT OBRONI FLOTĘ — odpowiedź zależy od TEGO, GDZIE przyjdzie atak

### 2a. Atak na [1:217:6] (para bazowa, aktywna) — TAK
Dowiedzione dzisiaj na żywo: symulacja o 09:17:56, decyzja o 09:18:32, wysyłka potwierdzona
o 09:18:38 — **36 sekund od wykrycia do floty w powietrzu**, skok księżyc→planeta, Deploy,
bez błędu. Auto-ratunek jest ON, hangar tej pary jest czytany na bieżąco, rekonesans jest na nią
ustawiony. To jest ciało, na którym stoi Twoja flota (94 977 szt. w hangarze + reszta w powietrzu
na ekspedycjach), więc główne ryzyko jest pokryte.

### 2b. Atak na którąkolwiek z pozostałych 13 kolonii — SŁABO, i to jest realna dziura
Bot ma trzy źródła wiedzy o wrogich lotach:

| źródło | zasięg | stan teraz |
|---|---|---|
| panel **Events** w DOM (`readEvents`) | **wszystkie kolonie** | **MARTWE** — wymaga rozwiniętej listy lotów, a ta jest zwinięta |
| lista AJAX `/home/fleetmovementlist` | **tylko aktywna para** (komentarz kodu, linia 286 i 333) | działa |
| pasek misji → ŚLEPY ALARM | sama LICZBA obcych flot, bez celu | działa, próg 60 s |

Czyli przy zwiniętej liście lotów **jedynym źródłem informacji o ataku na inną kolonię jest
ślepy alarm**, który wie tylko „widzę N obcych flot" — nie wie gdzie, nie wie kiedy uderzą.
Reaguje dopiero po 60 sekundach utrzymującej się nadwyżki i **działa tylko wtedy, gdy wie,
gdzie stoi flota**; w przeciwnym razie zostaje sam alert „ŚLEPY ALARM: pasek widzi N obcych,
ale nie wiem, gdzie stoi flota".

A hangarów pozostałych kolonii bot **nie zna**, bo rekonesans jest ustawiony na
**„tylko [1:217:6]"** (widoczne w panelu). Odczyt powstaje wyłącznie wtedy, gdy sam wejdziesz
na ich zakładkę Flota.

**Wniosek: flota główna jest chroniona, ale wszystko, co stoi na 13 koloniach (transportery,
recyklery, cokolwiek), jest praktycznie bez ochrony — i bot nawet nie wie, że tam stoi.**

## 3. Dlaczego lista lotów DALEJ jest zwinięta mimo 3.39.2
Dwie przyczyny:
1. Przycisk **„Fleet movements"**, którego szukam od 3.39.2, jest na stronie **Fleet** — a zrzut
   ownera pokazuje **/home (Overview)**. Na przeglądzie tego przycisku nie ma, więc lista
   kandydatów nadal kończy się niczym.
2. Flaga `events_open.dumped` z poprzedniej wersji siedzi w storage i od razu zapala ostrzeżenie.

## 4. BŁĄD UX, KTÓRY WPROWADZIŁEM W 3.39.0 — ostrzeżenie ZASŁANIA stan obrony
Wiersz „Obrona" pokazuje `ROZWIŃ LISTĘ LOTÓ…` **zamiast** `czysto · auto-ratunek`. Owner nie
widzi więc najważniejszej informacji w całym panelu: czy obrona w ogóle jest czysta. Ostrzeżenie
ma być OBOK stanu, nigdy zamiast niego. Do poprawy natychmiast.

## 5. Pozostałe obserwacje z panelu i logu
- `Dziennik obrony 10:07 BŁĄD` — wpis z 10:07:42 `[LOT] przerwany: 5 min bez potwierdzenia
  wysyłki`, po nim karencja trasy. Lot „dom = księżyc" nie doszedł do skutku; kolejny poszedł.
- `Ekspedycje 4/4 · fl 4/19` — wszystkie sloty ekspedycji zajęte, 4 z 19 slotów floty w użyciu.
- `Fleet Save wyłączony` — zgodnie z decyzją ownera (robi FS ręcznie, bota wtedy wyłącza).
- `Mining wyłączony`, ekonomia M OFF / Z OFF.

## 6. REKOMENDACJE (kolejność = wartość obronna)
1. **Zapisz telefon na kanał `ogamex3-d0zjvhl9eiho`** i zweryfikuj przyciskiem „Test push".
   Bez tego cała warstwa alarmowania nie istnieje, choćby bot działał idealnie.
2. **Napraw wiersz Obrona w panelu** (ostrzeżenie obok stanu, nie zamiast). Mój błąd.
3. **Rozwiązać listę lotów naprawdę:** próbować rozwinięcia także wtedy, gdy bot jest na /fleet,
   czyścić flagę `dumped` przy każdej nowej wersji i przy wejściu na Fleet. Dopóki lista jest
   zwinięta, atak na 13 kolonii jest niewidoczny inaczej niż jako liczba na pasku.
4. **Rekonesans: rozważyć tryb „wszystkie" albo choć okresowy odczyt kolonii z flotą.** Dziś bot
   nie wie, co stoi na 13 ciałach, więc nawet wykryty atak nie da się obsłużyć („nie wiem, gdzie
   stoi flota"). Kompromis: czytać w tle (`scanRemote`, bez przełączania planety) rzadziej,
   np. co 45 min — to nie rusza stroną operatora.
5. Dopiero potem: adaptacyjne odpytywanie i lekki keepalive (mniej żądań do serwera gry).
