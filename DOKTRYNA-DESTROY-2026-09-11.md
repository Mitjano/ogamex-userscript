# DOKTRYNA DESTROY — co bot ma robić, gdy celem jest KSIĘŻYC (11.09.2026)

Powstało po pytaniu z `HANDOFF-2026-09-11.md` §5. **To nie jest propozycja — to decyzja
właściciela**, podjęta 11.09 po nalocie DESTROY na [2:224:7] (03:42–03:48) i po utracie
księżyca bazy [5:125:4] na Athenie (26.08). Kierunki, które wcześniej rozważałem
(rotacja refugiów, obrona przeciwlotnicza, lot bez lądowania zamiast stacjonuj)
— **odrzucone**; poniżej jest to, co ma być.

---

## 1. Słowa właściciela (zapis dosłowny)

> „Gdy ktoś leci na nas z misją destroy wysyłamy standardowo flotę na sąsiedniego moona
> w tym samym układzie albo najbliższego na stacjonuj i możliwie najmniejszy % prędkości,
> może być 3%. Gdy wyślemy flotę i ktoś zniszczy naszego moona to lecąca flota będzie
> widoczna na falandze (tak jakby wyleciała z planety a nie z moona). Zawracamy stacjonuj
> gdy będzie bezpiecznie — to bardzo ważne żeby zawrócić stacjonuj (zawrócona misja
> stacjonuj nie jest widoczna na falandze i agresor nie będzie wiedział dokładnie kiedy
> wróci na planetę). W międzyczasie bot musi postawić nowego moona w miejscu gdzie ktoś
> zniszczył mi wcześniejszego. Gdy flota wróci na planetę (po zniszczeniu moona
> i zawróconym stacjonuj) można spowrotem wysłać ją na moona już tego nowego i dalej
> wysyłać ekspedycje (jeśli jest już bezpiecznie) lub kolejnego FS gdy ktoś nas atakuje."

Na pytanie „czy bot ma reagować na utratę księżyca": **port `MoonRebuild` z 2.x —
bot sam stawia nowy księżyc**, nie czeka na decyzję.

## 2. Przełożenie na mechanikę — siedem kroków nocy

| # | zdarzenie | co robi bot |
|---|---|---|
| 1 | DESTROY leci na księżyc | ratunek **standardowy**: sąsiedni księżyc w układzie, inaczej najbliższy |
| 2 | wysyłka | misja **stacjonuj (Deploy)**, prędkość **możliwie najmniejsza** (3%, jeśli fork ją ma) |
| 3 | księżyc startowy zniszczony | lecąca flota staje się widoczna na falandze — **tak, jakby wyszła z planety** |
| 4 | uderzenie minęło | **ZAWRÓT stacjonuj** — kluczowe: zawrócona misja stacjonuj NIE jest widoczna na falandze, więc agresor nie zna godziny powrotu |
| 5 | równolegle | bot **stawia nowy księżyc** w miejscu zniszczonego |
| 6 | flota wróciła na planetę | **zwóz na nowy księżyc** |
| 7 | jest bezpiecznie | powrót do stałej pętli: ekspedycje albo kolejny FS, gdy znów ktoś atakuje |

**Dlaczego minimalna prędkość jest sednem, a nie detalem:** cała sztuczka polega na tym,
żeby flota **wisiała w locie** w chwili uderzenia. Przy 100% (albo przy prędkości, której
bot nie zdołał ustawić) flota **dolatuje i ląduje** na sąsiednim księżycu — wtedy nie ma
czego zawracać, krok 4 przestaje istnieć, a flota stoi w miejscu, które napastnik zna.

## 3. Co JUŻ jest w 3.x (sprawdzone w kodzie 11.09, nie przepisywać od nowa)

- **Ucieczka na sąsiedni księżyc z zawrotem** — `decide()`: akcja `fly` z `air: true`,
  `recall: true`, `recallAt = ostatni dolot + cfg.recallBufferSec (90 s)`, cel z
  `neighbourMoon(k)`, z pominięciem ciał aktualnie atakowanych. Typ misji domyślny =
  Deploy („stacjonuj"), czyli dokładnie to, o co prosi właściciel.
- **Wykrycie utraty księżyca** — `Situation.refresh` zapala `s.moonLost[key]`
  (+ wpis „KSIĘŻYC ZNISZCZONY" i push), gasi je, gdy para znów ma księżyc.
- **Ewakuacja z gołej planety** — para bez księżyca z `moonLost` i flotą na planecie
  dostaje lot na najbliższe refugium (`evac: true`, sufit 3 prób/h).
- **Odbudowa księżyca** — moduł `Moon` (`/home/moonformation`, `cfg.moon.enabled`
  domyślnie `true`, `maxMetalShare 0.25`) sam bierze na cel każdą parę bez księżyca.
  **v3.90.0 (decyzja właściciela 12.09, przy zakładaniu trzech nowych kolonii):** przycisk
  „Księżyce OFF" w panelu zatrzymuje stawianie księżyców na koloniach, które nigdy go nie
  miały, ale **NIE zatrzymuje odbudowy księżyca zniszczonego przez atak** — to krok 5 tej
  doktryny, czyli obrona, a obrona nie chowa się za włącznikiem ekonomii. Rozróżnia je
  `s.moonLost[key]`, zapalane wyłącznie przy przejściu „miała księżyc → nie ma".
  Panel mówi wprost, co zostaje włączone; scenariusz E2E 43b pilnuje obu stron.
- **Zwóz na nowy księżyc** — po potwierdzeniu odbudowy `Moon.tick` sam startuje lot
  `kind:"home"` planeta → nowy księżyc (v3.67.0, prośba właściciela z 04.09).

Innymi słowy kroki **1, 3, 5, 6, 7** są zaimplementowane, a krok **4** ma silnik
(zawrót lotów `air`).

## 4. Czego BRAKUJE — praca do zrobienia

1. **P0 — prędkość ucieczki.** `cfg.airSpeedPct` = **10**, właściciel chce
   „możliwie najmniejszej" (3%). Gorsze: jeśli żądanej wartości NIE MA na liście forka,
   `Fly` klika w nic i leci **z domyślną, czyli 100%** — wpis „NIE USTAWIONA" w logu
   i flota **ląduje** zamiast wisieć. Trzeba: czytać rzeczywistą listę opcji, wybierać
   najniższą dostępną ≤ żądanej (nigdy po cichu 100%) i **zrzucać listę do logu**,
   żeby raz na zawsze wiedzieć, czy fork daje 3%, czy tylko dziesiątki.
2. **DESTROY nie jest osobną klasą zagrożenia** — wpada do jednego wora z ATTACK
   (`Rows.ATTACK`, ~linia 623). Trasa ratunku ma zostać ta sama (decyzja właściciela),
   ale komunikat i push powinny mówić wprost „celem jest KSIĘŻYC", bo to zmienia
   to, czego właściciel ma się spodziewać po powrocie.
3. **Brak scenariusza E2E na CAŁĄ noc** — dziś każdy klocek jest testowany osobno.
   Potrzebny jeden przebieg: DESTROY → ucieczka stacjonuj na minimalnej prędkości →
   księżyc znika w trakcie lotu → zawrót → lądowanie na planecie → odbudowa księżyca →
   zwóz na nowy → wznowienie ekspedycji. Dopiero to jest dowód, że łańcuch się nie rwie
   na żadnym styku (por. `HANDOFF-2026-09-11.md` §4 pkt 3 — harness nie umie dziś
   prowadzić wielu akcji tej samej pary przez kolejne przebiegi).

## 4b. REZERWA SPOWALNIAJĄCA — Gwiazda Śmierci (uzupełnienie właściciela, 11.09)

> „Mam jeszcze Gwiazdę Śmierci — GS, ale w małej ilości. Jak uciekamy przed obcą flotą, to
> zawsze bot może brać jedną sztukę GS, wtedy flota wolno leci. Czyli zakładamy, mam 30 GS
> na moonie, to jak bot będzie uciekał falami floty, która wraca z ekspedycji co kilka minut,
> to bot musi brać zawsze 1 sztukę na slot floty."

GS jest najwolniejszym statkiem, więc **jedna sztuka spowalnia cały lot** — a wolny lot to
ten, który zdąży się zawrócić (krok 4 doktryny). To jest drugi, niezależny hamulec obok
minimalnej prędkości z pkt 4.1.

**Wdrożone w v3.79.0:**
- `CAP_RATUNKU = { DEATH_STAR: 1 }` w `decide()` — **sufit, nie wykluczenie**: ucieczka dalej
  zabiera cały hangar, tylko GS jest racjonowana po jednej na lot. Sufit jest własnością
  KODU (nie ma pola w panelu) — to reguła fizyki gry, nie preferencja.
- Dostają go **wyłącznie loty ucieczki** (sąsiedni księżyc, drugie ciało pary, refugium,
  ślepy alarm). **Nie** dostaje go ewakuacja z gołej planety po utracie księżyca (leci 100%,
  ma być krótka) ani Fleet Save (decyzja z 07.09: „na FS musi być cała flota").
- `Fly` wpisuje `min(ile mam, sufit)`, a zerowanie hangaru źródła zostawia **resztę** typu —
  stan nie może twierdzić, że poleciało wszystkie 30, bo wtedy bot „nie widziałby" floty,
  która tam stoi.

**Defekt złapany przez E2E (sc. 63) i decyzja właściciela:** po pierwszej ucieczce na
atakowanym księżycu zostaje sama rezerwa. `decide()` widziała ją jako „flota pod
uderzeniem" i wystawiała kolejny ratunek — bot wysłał **osiem lotów po jednej Gwieździe
Śmierci**, paląc slot floty na każdą z nich. Właściciel wybrał: **rezerwa zostaje na
księżycu**, żeby kolejne fale miały czym zwolnić ucieczkę. Więc `decide()` nie wystawia
ratunku, gdy w domu stoi już TYLKO rezerwa (alert co 30 min mówi o tym wprost), a `Fly`
ma na to siatkę bezpieczeństwa na wypadek nieznanego składu hangaru. Świadomy koszt:
GS są na księżycu w chwili uderzenia.

## 5. ROZSTRZYGNIĘTE 11.09 zrzutem z gry: Genesis MA 3%

Formularz lotu (zrzut właściciela, [2:224:7] → księżyc, dystans 5) pokazuje pełną listę:

```
3  5  10  20  30  40  50  60  70  80  90  100
```

Czyli „możliwie najmniejsza prędkość" znaczy **naprawdę 3%**, a nie „najbliżej jak się da".
Skala problemu: ten sam lot przy **100% trwa 2 min 15 s** (czyli ląduje, zanim ktokolwiek
zdąży go zawrócić), przy 3% — około **75 minut w powietrzu**. Dlatego defekt z pkt 4.1
(brak trafienia w opcję → lot z prędkością domyślną) był groźny: zabierał całą dźwignię.

Atrapa E2E dostała tę samą listę (`Game.speeds`), więc testy prędkości sprawdzają świat,
który istnieje. Scenariusz 61 pilnuje trafienia w 3%, a 61b — zachowania, gdyby fork
kiedyś tę opcję zabrał (najniższa dostępna, nigdy domyślne 100%).
