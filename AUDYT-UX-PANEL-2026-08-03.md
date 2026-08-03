# Audyt UX panelu OGameX Assistant — 3 sierpnia 2026 (v2.64.2)

Kontekst: MacBook Air 13,6″ (1470×956 pkt). Panel: 260 px szerokości, stała
pozycja lewy-górny róg. Zmierzone w kodzie: **16 sekcji, 21 pól, 22 przyciski,
34 tooltipy, 14 linii statusu, log 200 px + przypięty log 60 px + textarea.**
Panel urósł organicznie przez ~60 wersji — każda funkcja dokładała wiersz,
nikt nie projektował całości.

## Diagnoza — pięć problemów w kolejności wagi

### 1. Panel jest wysoki, a nic nie mówi (odwrócona hierarchia)
Zwinięta sekcja to sama nazwa + ON/OFF — zero informacji. Wszystko, co ważne
(czy jest alarm? co robi mining? ile ekspedycji w powietrzu? czy FS zaplanowany?)
siedzi **w środku** zwiniętych sekcji albo w logu. Efekt: użytkownik widzi
350 px nawigacji, a stan bota musi wyczytywać z monospace'owego loga 10 px.
To jest odwrotnie niż powinno być: **stan zawsze widoczny, ustawienia schowane.**

### 2. Sekcje są przewymiarowane
`padding 8px` + `margin 8px` + pogrubiony tytuł = ~44 px na zwiniętą sekcję.
8 sekcji = ~350 px samego powietrza. Na ekranie 956 px wysokości panel
z rozwiniętym logiem nie mieści się w całości.

### 3. Log dominuje, choć jest narzędziem diagnostycznym
Przypięty log (60 px) + nagłówek + log 200 px + ukryta textarea. Log czyta się
przy debugowaniu — a zajmuje najlepsze miejsce i pcha wysokość. Do tego szum:
`Dispatch cooldown: 10min remaining` co pół minuty.

### 4. Brak hierarchii wizualnej i kontrastu
Wszystko 10–12 px, statusy szare `#999` na ciemnym tle (kontrast ~3:1 — poniżej
progu czytelności dla 10 px), ON/OFF wygląda tak samo jak Copy/Clear. Na
Retinie 10 px monospace to mrówki. Preferencja właściciela (zapisana):
„duże, wyraźne, przyjazne, miękkie" — panel jest dokładnie odwrotny.

### 5. Drobne, ale drażniące
- Języki wymieszane: tytuły EN (Asteroid Mining, Quick Actions), treść PL.
- Pole „Gemini API" wisi luzem między sekcjami a logiem — sierota bez sekcji.
- 34 tooltipy niosą całą dokumentację, ale nic nie sygnalizuje, że istnieją.
- Szerokość 260 px ściska pola (input 80 px obok długiej etykiety).

## Projekt docelowy — „stan na wierzchu, ustawienia w środku"

```
┌─ OGameX Assistant ─────────────── [ON] ─┐   ← nagłówek, przeciągalny
│ 🛡 Obrona    czysto · 12h: 1 alarm, 1 powrót │
│ ⛏ Mining    skan [3:459] · loty 2/6         │   STAN — zawsze widoczny,
│ 🚀 Ekspedycje 12/14 · następna ~75 s         │   5 linii × 22 px, 12 px,
│ 🌙 FS        wyłączony                       │   kolor = znaczenie
│ 🤖 Gemini    aktywny · dziś 3/40             │
├──────────────────────────────────────────┤
│ ▸ Ustawienia: Mining                     │   ← slim 26 px, PL tytuły,
│ ▸ Ustawienia: Ekspedycje                 │     zwinięte DOMYŚLNIE
│ ▸ Ustawienia: Obrona                     │
│ ▸ Ustawienia: Fleet Save                 │
│ ▸ Ustawienia: Farmienie · Bonus · LLM    │
├──────────────────────────────────────────┤
│ ⚠ [przypięty log — TYLKO gdy alarm]      │
│ ▸ Log · ostatnie: 20:22 Expedition sent  │   ← 1 linia; klik rozwija
└──────────────────────────────────────────┘     (Copy/Clear w środku)
```

Zasady:
1. **Pasek stanu** (nowy element) — 5 linii odpowiada na 5 pytań właściciela
   bez jednego kliknięcia. Kolor niesie znaczenie: zielony = spokój,
   pomarańczowy = praca, czerwony = alarm/błąd.
2. **Sekcje ustawień**: padding 4/6, margin 4, tytuły 11 px normal, po polsku.
   Zwinięte domyślnie (dziś: rozwinięte). Wysokość zwiniętej: ~26 px.
3. **Log**: domyślnie 1 linia z ostatnim wpisem; klik rozwija do 180 px.
   Przypięty czerwony log pokazuje się wyłącznie, gdy ma treść.
4. **Typografia**: minimum 11 px, statusy `#c9d6df` zamiast `#999`,
   liczby w stanie pogrubione.
5. **Szerokość 300 px** — zwrot z niższej wysokości z nawiązką to pokrywa.
6. Całość po polsku.

Szacunkowy efekt: wysokość w stanie spoczynku ~380 px → **~250 px**, przy
jednocześnie ~10× większej ilości informacji widocznej bez klikania.

## Sposób wdrożenia (ważne po doświadczeniach z tego tygodnia)

**Restyling chirurgiczny, nie przepisanie.** Panel ma 22 przyciski powiązane
po ID z logiką — pełne przepisanie HTML to ryzyko zerwania handlerów. Plan:
1. Pasek stanu = nowy, niezależny blok zasilany z istniejącego
   `updateStatusUI()` (dane już są liczone, tylko nie są pokazywane).
2. Sekcje: zmiana CSS + tytułów + domyślnego stanu zwinięcia. DOM i ID bez zmian.
3. Log: nowy wiersz-skrót + istniejący `.log-area` za przełącznikiem.
4. Gemini do sekcji „Farmienie · Bonus · LLM".
Każdy krok osobno testowalny; żaden nie dotyka logiki bota.
