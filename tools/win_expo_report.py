#!/usr/bin/env python3
"""Zbieracz i raport EKSPEDYCJI bota 3.x na Windows + Chrome (Tampermonkey, LevelDB).

Log bota (`ogx3_log`) trzyma 400 wpisow, czyli ~90 min — za malo, zeby porownac dwie wersje.
`snap` dopisuje nowe wpisy do pliku JSONL POZA repo (repo jest publiczne, log ma koordynaty),
`report` liczy z calosci metryki per wersja: rownosc fal, zajetosc slotow, flote stojaca w hangarze.

Uzycie:
  win_expo_report.py snap   [--import-log plik.json --at "2026-09-21 10:54"]
  win_expo_report.py report [--since "2026-09-21 09:00"]
Dane: %USERPROFILE%\\ogamex-expo-logs\\ (log.jsonl, samples.jsonl).
"""
import sys, os, re, json, glob, shutil, tempfile, datetime, statistics

LDB = os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\User Data\Default\Local Extension Settings\dhdgffkkebhmkfjojejmpbldmpobfkfo")
OUT = os.path.join(os.path.expanduser("~"), "ogamex-expo-logs")
LOG, SAMPLES = os.path.join(OUT, "log.jsonl"), os.path.join(OUT, "samples.jsonl")
HOST = "genesis.ogamex.net"


def leveldb_text():
    """Tekst najnowszego pliku .log LevelDB po wycieciu 7-bajtowych naglowkow rekordow
    na granicach blokow 32 768 B (bez tego dlugie wartosci nie parsuja sie jako JSON)."""
    tmp = tempfile.mkdtemp(prefix="ogx_ldb_")
    try:
        srcs = glob.glob(os.path.join(LDB, "*.log"))
        if not srcs:
            sys.exit("brak pliku .log w LevelDB Tampermonkeya: " + LDB)
        src = max(srcs, key=os.path.getmtime)
        dst = os.path.join(tmp, "db.log")
        shutil.copy2(src, dst)                      # Chrome trzyma LOCK, kopia jest bezpieczna
        raw = open(dst, "rb").read()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    out = bytearray()
    for i in range(0, len(raw), 32768):
        out += raw[i + 7:i + 32768]
    return out.decode("utf-8", "replace")


def values(txt, key):
    """Wszystkie poprawnie parsujace sie zapisy klucza, od najstarszego do najnowszego."""
    res = []
    for m in re.finditer(re.escape(HOST) + ":" + key + r'":', txt):
        try:
            v, _ = json.JSONDecoder().raw_decode(txt[m.end():])
            if isinstance(v, str) and v[:1] == "s":
                v = v[1:]
            res.append(json.loads(v) if isinstance(v, str) else v)
        except Exception:
            pass
    return res


def load_jsonl(path):
    if not os.path.exists(path):
        return []
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]


def dated(entries, at):
    """Log ma sama godzine. Wpisy sa od najnowszego; data = dzien odczytu, a kazde cofniecie
    zegara „pod prad" (23:59 po 00:01) to przejscie na poprzedni dzien."""
    day, prev, res = at.date(), at.time(), []
    for e in entries:
        try:
            t = datetime.time.fromisoformat(e["time"])
        except Exception:
            continue
        if t > prev and (datetime.datetime.combine(day, t) - datetime.datetime.combine(day, prev)).seconds > 3600:
            day -= datetime.timedelta(days=1)
        prev = t
        res.append({"ts": datetime.datetime.combine(day, t).isoformat(), "type": e.get("type", ""), "msg": e.get("msg", "")})
    return res


def snap(argv):
    os.makedirs(OUT, exist_ok=True)
    have = {(e["ts"], e["msg"]) for e in load_jsonl(LOG)}
    new = []
    if "--import-log" in argv:
        entries = json.load(open(argv[argv.index("--import-log") + 1], encoding="utf-8"))
        at = datetime.datetime.fromisoformat(argv[argv.index("--at") + 1])
        batches, sit = [(entries, at)], None
    else:
        txt, at = leveldb_text(), datetime.datetime.now()
        batches = [(v, at) for v in values(txt, "ogx3_log") if isinstance(v, list)]
        sits = [v for v in values(txt, "ogx3_situation") if isinstance(v, dict)]
        cfgs = [v for v in values(txt, "ogx3_cfg") if isinstance(v, dict)]
        sit = sits[-1] if sits else None
        excl = [str(t).upper() for t in ((cfgs[-1].get("expo") or {}).get("excludeTypes") or [])] if cfgs else []
    for entries, when in batches:
        for e in dated(entries, when):
            k = (e["ts"], e["msg"])
            if k not in have:
                have.add(k)
                new.append(e)
    with open(LOG, "a", encoding="utf-8") as f:
        for e in sorted(new, key=lambda e: e["ts"]):
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    if sit:
        # probka „co stoi w domu": statki ekspedycyjne w hangarach przy aktualnych slotach
        idle = 0
        for h in (sit.get("hangars") or {}).values():
            idle += sum(x.get("qty", 0) for x in (h.get("ships") or []) if str(x.get("type", "")).upper() not in excl)
        nowMs = at.timestamp() * 1000   # rejestr trzyma tez loty po terminie - licza sie tylko te w powietrzu
        air = sum(x.get("total", 0) for x in (sit.get("expected") or []) if x.get("kind") == "expedition" and (x.get("returnAt") or 0) > nowMs)
        ver = next((m.group(1) for e in (batches[-1][0] if batches else []) for m in [re.search(r"Assistant 3 v([\d.]+)", e.get("msg", ""))] if m), None)
        with open(SAMPLES, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": at.isoformat(timespec="seconds"), "ver": ver, "expo": (sit.get("slots") or {}).get("expo"),
                                "idleExpoShips": idle, "inAirRegister": air}, ensure_ascii=False) + "\n")
    print(f"snap: +{len(new)} wpisow (razem {len(have)}) -> {LOG}")


def num(s):
    return int(re.sub(r"[^\d]", "", s) or 0)


def report(argv):
    since = argv[argv.index("--since") + 1] if "--since" in argv else ""
    log = sorted((e for e in load_jsonl(LOG) if e["ts"] >= since), key=lambda e: e["ts"])
    ver, waves, per = "?", [], {}
    plan = None
    for e in log:
        m = re.search(r"Assistant 3 v([\d.]+)", e["msg"])
        if m:
            ver = m.group(1)
        if e["msg"].startswith("[LOT] ekspedycja ("):
            s = re.search(r"sloty ekspedycji (\d+)/(\d+)", e["msg"])
            h = re.search(r"w hangarze ([\d\s  ]+)", e["msg"])
            plan = {"all": "cały hangar" in e["msg"], "used": int(s.group(1)) if s else None, "total": int(s.group(2)) if s else None,
                    "hangar": num(h.group(1)) if h else None}
        elif e["msg"].startswith("[EXPO] fala wysłana:"):
            n = sum(num(x) for x in re.findall(r"×([\d\s  ]+)", e["msg"]))
            per.setdefault(ver, []).append({"ts": e["ts"], "n": n, **(plan or {})})
            plan = None
    if not per:
        return print("brak fal w zebranym logu")
    for v, ws in per.items():
        ns = [w["n"] for w in ws]
        med = statistics.median(ns)
        t0, t1 = datetime.datetime.fromisoformat(ws[0]["ts"]), datetime.datetime.fromisoformat(ws[-1]["ts"])
        hrs = max((t1 - t0).total_seconds() / 3600, 1e-9)
        print(f"\n== v{v}: {len(ws)} fal, {ws[0]['ts'][5:16]} -> {ws[-1]['ts'][5:16]} ({len(ws) / hrs:.1f} fal/h)")
        print(f"   rozmiar fali: min {min(ns):,} | mediana {int(med):,} | max {max(ns):,} | rozrzut max/min {max(ns) / max(1, min(ns)):.2f}x".replace(",", " "))
        print(f"   fale poza ±15% mediany: {sum(1 for n in ns if abs(n - med) > 0.15 * med)} | fale „cały hangar”: {sum(1 for w in ws if w.get('all'))}")
        left = [w["hangar"] - w["n"] for w in ws if w.get("hangar") and w.get("used") is not None and w["used"] >= w["total"] - 1]
        if left:
            print(f"   reszta w domu po zajęciu OSTATNIEGO slotu: śr. {int(statistics.mean(left)):,} szt. ({100 * statistics.mean(left) / med:.0f}% fali), n={len(left)}".replace(",", " "))
    sm = [s for s in load_jsonl(SAMPLES) if s["ts"] >= since]
    by = {}
    for s in sm:
        by.setdefault(s.get("ver") or "?", []).append(s)
    for v, ss in by.items():
        full = [s for s in ss if s.get("expo") and s["expo"].get("used", 0) >= s["expo"].get("total", 99)]
        occ = [s["expo"]["used"] / s["expo"]["total"] for s in ss if s.get("expo") and s["expo"].get("total")]
        line = f"\n== próbki godzinowe v{v}: {len(ss)}"
        if occ:
            line += f" | zajętość slotów śr. {100 * statistics.mean(occ):.0f}%"
        if full:
            fr = [s["idleExpoShips"] / max(1, s["idleExpoShips"] + s["inAirRegister"]) for s in full]
            line += f" | flota ekspedycyjna stojąca przy pełnych slotach: śr. {100 * statistics.mean(fr):.2f}% (n={len(full)})"
        print(line)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    {"snap": snap, "report": report}.get(cmd, lambda a: print(__doc__))(sys.argv[2:])
