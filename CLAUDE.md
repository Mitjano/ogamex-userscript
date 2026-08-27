# OGameX Assistant — instrukcje dla Claude Code

Jeden plik: `ogamex-bot.user.js` (Tampermonkey, ~16k linii). **Push na `main` = auto-deploy** (Tampermonkey aktualizuje z repo; bot krzyczy `[UPDATE]`, gdy wersja w repo jest nowsza). Bump `// @version` przy KAŻDEJ zmianie.

- Serwer: athena.ogamex.net — fork **.NET**, nie Laravel `lanedirt/OGameX`. Nie budować na endpointach niepotwierdzonych na żywo; nowy markup najpierw zrzuć do logu (`[... DOM]`), potem parser.
- Testy offline: `node test-all.js` (wycinają funkcje z bota po DOKŁADNEJ sygnaturze — zmiana sygnatury = poprawka testu). Zielone przed pushem. Pipe zjada kod wyjścia — sprawdzaj `tail -1`.
- Język: polski (logi, commity, dokumenty). Użytkownik = obrońca; obrona floty ma bezwzględny priorytet nad ekonomią.
- Gdzie jesteśmy: `STAN-I-PLAN.md` (ostatnia sekcja AKTUALIZACJA) → audyty `AUDYT-HUBY-2026-08-27.md`, `AUDYT-HUBY-2-OBRONA-2026-08-27.md`, `MOON-STRATEGY-2026-08-26.md`.
- Konwencje w kodzie: komentarz `// vX.Y.Z: incydent (data, godzina) — przyczyna — rozwiązanie`; stan w `GM_setValue` z prefiksem `ogamex_`, klucze per para z sufiksem `g:s:p`; misje wielostronicowe przez `pending_mission` (typ + step) obsługiwane w `handlePendingMission()`.
- Przy fałszywym alarmie prosić o ZRZUT EKRANU paska misji, nie o log.
