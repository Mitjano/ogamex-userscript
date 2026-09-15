#!/usr/bin/env python3
"""Stan i log bota 3.x z Tampermonkeya w CHROME na Macu (od 09.09 gra chodzi w Chrome).

Tampermonkey trzyma GM storage skryptu w LevelDB Chrome:
  ~/Library/Application Support/Google/Chrome/<profil>/Local Extension Settings/dhdgffkkebhmkfjojejmpbldmpobfkfo
pod kluczem '!extdb.@st#<uuid-skryptu>'. Wartość to JSON opakowany trzy razy
({value:{data:{...}}}, a każda wartość GM ma jednoliterowy prefiks typu: "s" = string JSON).
Baza jest otwarta przez Chrome, więc czytamy KOPIĘ (cp -R), przez classic-level (Node).

Użycie:  python3 tools/mac_chrome_state.py [katalog-wyjściowy] [profil]
         (domyślnie: /tmp/ogx3-chrome-dump, profil Default)
Wynik:   gm_<klucz>.json dla każdego klucza GM, log_chrono.txt (log chronologicznie,
         ostatnie 400 wpisów — tyle trzyma bot), journal_chrono.txt (dziennik z datami, 600 wpisów).
Wymaga:  node + pakiet classic-level (skrypt sam robi `npm i classic-level` w katalogu roboczym).
UWAGA:   zrzuty zawierają dane z gry — NIGDY nie commitować (08.09: gm_blob poleciał na publiczny GitHub).
"""
import datetime, json, os, shutil, subprocess, sys, tempfile

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ogx3-chrome-dump"
PROFILE = sys.argv[2] if len(sys.argv) > 2 else "Default"
SRC = os.path.expanduser(f"~/Library/Application Support/Google/Chrome/{PROFILE}/Local Extension Settings/dhdgffkkebhmkfjojejmpbldmpobfkfo")
if not os.path.isdir(SRC):
    sys.exit(f"brak LevelDB Tampermonkeya: {SRC}")
os.makedirs(OUT, exist_ok=True)
work = os.path.join(tempfile.gettempdir(), "ogx3-ldb-work")
os.makedirs(work, exist_ok=True)
dbcopy = os.path.join(work, "db")
shutil.rmtree(dbcopy, ignore_errors=True)
shutil.copytree(SRC, dbcopy)

if not os.path.isdir(os.path.join(work, "node_modules", "classic-level")):
    subprocess.run(["npm", "init", "-y"], cwd=work, capture_output=True)
    subprocess.run(["npm", "install", "--no-audit", "--no-fund", "classic-level"], cwd=work, check=True, capture_output=True)
JS = r'''
const { ClassicLevel } = require("classic-level");
(async () => {
  const db = new ClassicLevel(process.argv[2], { createIfMissing: false, keyEncoding: "utf8", valueEncoding: "utf8" });
  await db.open();
  for await (const [k, v] of db.iterator()) if (k.startsWith("!extdb.@st#")) process.stdout.write(v);
  await db.close();
})().catch(e => { console.error(e.message); process.exit(1); });
'''
open(os.path.join(work, "read.js"), "w").write(JS)
raw = subprocess.check_output(["node", os.path.join(work, "read.js"), dbcopy], cwd=work).decode("utf8")

def unwrap(x):
    for _ in range(8):
        if isinstance(x, str):
            try:
                x = json.loads(x)
            except Exception:
                return x
        elif isinstance(x, dict) and any("ogx3_" in k for k in x):
            return x
        elif isinstance(x, dict) and "data" in x:
            x = x["data"]
        elif isinstance(x, dict) and "value" in x:
            x = x["value"]
        else:
            return x
    return x

st = unwrap(raw)
if not isinstance(st, dict):
    sys.exit("nie znalazłem kluczy ogx3_ w GM storage")

def untag(v):
    if isinstance(v, str) and v[:1] in "sbno" and len(v) > 1:
        try:
            return json.loads(v[1:])
        except Exception:
            return v[1:]
    return v

out = {}
for k, rawv in st.items():
    val = untag(rawv)
    if isinstance(val, str):
        try:
            val = json.loads(val)
        except Exception:
            pass
    name = k.split("ogx3_")[-1] if "ogx3_" in k else k.replace(":", "_").replace("/", "_")
    out[name] = val
    with open(os.path.join(OUT, f"gm_{name}.json"), "w") as f:
        json.dump(val, f, ensure_ascii=False, indent=1)

lg = out.get("log") or []
if isinstance(lg, list) and lg:
    with open(os.path.join(OUT, "log_chrono.txt"), "w") as f:
        for e in reversed(lg):
            f.write(f'[{e.get("time")}] [{str(e.get("type")).upper()}] {e.get("msg")}\n')
    print(f"log: {len(lg)} wpisów, {lg[-1].get('time')} → {lg[0].get('time')}")
jr = out.get("journal") or []
if isinstance(jr, list) and jr:
    with open(os.path.join(OUT, "journal_chrono.txt"), "w") as f:
        for e in reversed(jr):
            ts = datetime.datetime.fromtimestamp(e.get("at", 0) / 1000).strftime("%m-%d %H:%M:%S")
            f.write(f'{ts} [{e.get("kind")}] {e.get("msg")}\n')
    print(f"dziennik: {len(jr)} wpisów, {datetime.datetime.fromtimestamp(jr[-1]['at']/1000):%m-%d %H:%M} → {datetime.datetime.fromtimestamp(jr[0]['at']/1000):%m-%d %H:%M}")
sit = out.get("situation") or {}
if isinstance(sit, dict):
    print("situation: pary", len(sit.get("pairs", {})), "| zagrożenia", len(sit.get("threats", [])), "| loty", len(sit.get("flights", [])),
          "| updatedAt", datetime.datetime.fromtimestamp(sit.get("updatedAt", 0) / 1000).strftime("%m-%d %H:%M:%S"))
print("ver:", out.get("ver"), "| klucze:", len(out), "| katalog:", OUT)
