# Strategia: zniszczenie i odbudowa księżyca (26.08.2026)

## Co się stało
18:04 — 3 misje **Destroy** z [5:126:4] (po 500 mld Gwiazd Śmierci każda) na księżyc bazy [5:125:4], dolot 18:26.
Bot wykrył atak w 25 s i przerzucił całą flotę + surowce (poza rezerwą 100 mld deuteru) na planetę (Deploy 81 s). Flota bezpieczna.

## Mechanika OGameX (ze źródła lanedirt/OGameX)
- **Destroy = najpierw bitwa na księżycu** (flota+obrona księżyca vs napastnik), potem rzut na zniszczenie.
  Szansa = `(100 − √średnica) · √liczbaGŚ` → przy ≥ ~4 GŚ na duży księżyc = **100 %**. 500 mld GŚ = pewne zniszczenie, jeśli wygrają bitwę.
- **Utrata GŚ napastnika**: jeden rzut na całą flotę, szansa `√średnica / 2` (≈ 47 % dla księżyca 8 944 km). Nawet przegrany rzut nie ratuje księżyca.
- **Nie można zniszczyć własnego księżyca** ani **atakować własnej planety** (`checkOwnPlanet`) → **bot sam księżyca nie zrobi**.
- **Powstanie księżyca**: tylko po bitwie **na planecie** (misja Attack, cel = planeta bez księżyca). Każde 100 k złomu z bitwy = 1 % szansy, **maks. 20 %** (`maximum_moon_chance`, ustawienie serwera — athena może mieć inne). Średnica: `√(x + 3·złom/100000)·1000`, cap 8 944 km przy 2 M złomu.
- Złom z bitwy NA KSIĘŻYCU ląduje na koordach planety, ale księżyc z tego **nie** powstaje (tylko gdy obrońca = planeta bez księżyca).

## Decyzje obronne (co robi bot)
1. **Destroy/Attack na księżyc, flota na księżycu** → skok na planetę (jak dziś). Poprawnie: nie wystawiamy floty pod 1,5 bln GŚ.
2. **Attack na planetę, para BEZ księżyca** → od v2.104.7 **ucieczka w powietrze** (wolny Deploy do innej kolonii + zawrócenie), bo nie ma dokąd skakać. Wcześniej bot próbowałby 3× wysłać „na księżyc" i kręcił się w backoffie.
3. **Po alarmie, dom = księżyc, a księżyca nie ma** → od v2.104.7 powrót odwołany, straż zdjęta, wpis ATAK (push) „KSIĘŻYC ZNISZCZONY", flota zostaje na planecie. Ekspedycje/FS/mining startują z planety automatycznie (v2.82: „układ bez księżyca = start z planety").
4. **Koszt braku księżyca**: falanga widzi loty z planety → FS z zawróceniem jest snajperowalny. Do odbudowy: FS przez **stacjonowanie na innej kolonii** (bez zawracania) albo krótkie FS z losowym czasem powrotu.

## Odbudowa księżyca — jedyna droga: moonshot
Potrzebny **drugi gracz** (sojusznik albo drugie konto — na prywatnym serwerze sprawdź regulamin athena):
1. Na planecie [5:125:4] stawiasz obronę zdolną zestrzelić flotę „strzelca" (albo strzelec wysyła flotę, którą Twoja flota na planecie zniszczy — flota musi wtedy stać na planecie, straż OFF na czas moonshota).
2. Strzelec atakuje Twoją planetę flotą wartą **≥ 2 M złomu** w dowolnym (metal+kryształ) — przy domyślnym 30 % złomu to ok. **6,7 M wartości statków** (np. ~1 700 lekkich myśliwców). Wynik: 20 % szansy na księżyc na próbę (jeśli serwer ma cap 20 %).
3. Powtarzać co bitwę; mediana ≈ 3–4 próby. Złom potem zbierasz recyklerami (wraca do Ciebie).
4. Po powstaniu księżyca: „START EKSPEDYCJI: księżyc", RATUJ FLOTĘ → księżyc, i bot wraca do trybu księżycowego.

**Bot może pomóc** (do zrobienia po Twojej decyzji, kto jest strzelcem): tryb `MOONSHOT` — straż OFF na oknie, flota trzymana na planecie, po bitwie odczyt raportu (`moon_created`), auto-recykling złomu z [5:125], a po sukcesie automatyczny przeskok bazy na nowy księżyc.

## Zapobieganie (żeby nie tracić księżyca)
- Przed Destroy zawsze jest bitwa: **obrona na księżycu nie ma sensu** przeciw 500 mld GŚ — nie inwestować.
- Jedyna realna ochrona: **więcej księżyców** (kolonie z księżycami = alternatywne bazy) + trzymać flotę tam, gdzie napastnik nie spodziewa się (bot ma `launchFrom` per moduł).
- Napastnik [5:126:4] jest sąsiadem (1 układ) — jego GŚ lecą 22 min. Bot ma 25 s potwierdzenia + 81 s skoku: margines ~20 min, OK.
