#!/usr/bin/env python3
"""Odczyt DZIENNIKA OBRONY (ogx3_journal) bota 3.x z Tampermonkeya na Windows Firefox.
Journal trzyma tylko zdarzenia obrony (RATUNEK/FS/ATAK/POWROT/BLAD) - bez spamu
ekspedycji/nawigacji, wiec siega duzo dalej wstecz niz zwykly log.
Uzycie: win_read_journal.py <FILES_DIR> [HH:MM filtr]"""
import cramjam, glob, re, sys, os, time, shutil, tempfile, datetime

def newest_blob(files_dir, tries=40, pause=0.15):
    last_err = None
    for _ in range(tries):
        try:
            cands = [f for f in glob.glob(os.path.join(files_dir, "[0-9]*"))
                     if open(f, "rb").read(4) == b"\xff\x06\x00\x00"]
            if cands:
                src = max(cands, key=os.path.getmtime)
                dst = os.path.join(tempfile.gettempdir(), "ogx_gm_blob_win")
                shutil.copy2(src, dst)
                return dst
        except Exception as e:
            last_err = e
        time.sleep(pause)
    sys.exit(f"brak pliku snappy-framing po {tries} probach ({last_err})")

def unframe(path):
    raw = open(path, "rb").read()
    out, i = bytearray(), 0
    while i + 4 <= len(raw):
        typ = raw[i]
        ln = int.from_bytes(raw[i+1:i+4], "little")
        chunk = raw[i+4:i+4+ln]
        if len(chunk) < ln:
            break
        if typ == 0x00:
            try:
                out += bytes(cramjam.snappy.decompress_raw(bytes(chunk[4:])))
            except Exception:
                pass
        elif typ == 0x01:
            out += chunk[4:]
        i += 4 + ln
    return bytes(out)

files_dir = sys.argv[1]
hhmm_filter = sys.argv[2] if len(sys.argv) > 2 else None

blob = newest_blob(files_dir)
buf = unframe(blob)
print(f"[diag] dlugosc bufora: {len(buf)}", file=sys.stderr)

kb = "genesis.ogamex.net:ogx3_journal".encode("latin1")
pos = buf.find(kb)
if pos < 0:
    sys.exit("klucz ogx3_journal nie znaleziony w blobie")
window = buf[pos + len(kb): pos + len(kb) + 3_000_000]

texts = [window.decode("latin1")]
for par in (0, 1):
    texts.append(window[par:].decode("utf-16-le", "ignore"))

entries = []
seen = set()
pat = re.compile(r'\{\\?"at\\?":(\d+),\\?"kind\\?":\\?"(\w+)\\?",\\?"msg\\?":\\?"(.*?)\\?"\}')
for t in texts:
    for m in pat.finditer(t):
        at, kind, msg = int(m.group(1)), m.group(2), m.group(3)
        key = (at, kind, msg[:60])
        if key in seen:
            continue
        seen.add(key)
        entries.append((at, kind, msg))

entries.sort(key=lambda e: e[0])
print(f"[diag] wpisow journal: {len(entries)}", file=sys.stderr)
if entries:
    t0 = datetime.datetime.fromtimestamp(entries[0][0]/1000).strftime("%Y-%m-%d %H:%M:%S")
    t1 = datetime.datetime.fromtimestamp(entries[-1][0]/1000).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[diag] zakres: {t0} .. {t1}", file=sys.stderr)

for at, kind, msg in entries:
    tm = datetime.datetime.fromtimestamp(at/1000).strftime("%Y-%m-%d %H:%M:%S")
    if hhmm_filter and hhmm_filter not in tm:
        continue
    msg = msg.encode("latin1", "ignore").decode("unicode_escape", "ignore")
    print(f"[{tm}] [{kind}] {msg}")
