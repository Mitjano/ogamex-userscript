#!/usr/bin/env python3
"""Log bota OGameX 3 (Genesis) z IndexedDB Tampermonkeya — kopiuje blob, dekoduje snappy framing,
wyciąga wartość klucza genesis.ogamex.net:ogx3_log. Użycie: ogx_state.py [HH:MM] [klucz]"""
import cramjam, glob, re, json, sys, datetime, shutil, os

FILES_DIR = ("/Users/mch/Library/Application Support/Firefox/Profiles/mx8brg6q.default-release-1"
             "/storage/default/moz-extension+++a452e456-d680-4cd7-8c65-4e4f7807e478"
             "^userContextId=4294967295/idb/3647222921wleabcEoxlt-eengsairo.files")
SP = os.path.dirname(os.path.abspath(__file__))

def newest_blob():
    cands = [f for f in glob.glob(os.path.join(FILES_DIR, "[0-9]*"))
             if open(f, "rb").read(4) == b"\xff\x06\x00\x00"]
    if not cands:
        sys.exit("brak pliku snappy-framing w .files")
    src = max(cands, key=os.path.getmtime)
    dst = os.path.join(SP, "gm_blob")
    shutil.copy2(src, dst)
    return dst

def unframe(path):
    raw = open(path, "rb").read()
    out, i = bytearray(), 0
    while i + 4 <= len(raw):
        typ = raw[i]
        ln = int.from_bytes(raw[i+1:i+4], "little")
        chunk = raw[i+4:i+4+ln]
        if len(chunk) < ln:
            break  # ucięty ogon (plik pisany na żywo)
        if typ == 0x00:
            try:
                out += bytes(cramjam.snappy.decompress_raw(bytes(chunk[4:])))
            except Exception:
                pass
        elif typ == 0x01:
            out += chunk[4:]
        i += 4 + ln
    return bytes(out)

key = (sys.argv[2] if len(sys.argv) > 2 else "log")
buf = unframe(newest_blob())
kb = f"genesis.ogamex.net:ogx3_{key}".encode("latin1")
pos = buf.find(kb)
if pos < 0:
    sys.exit(f"klucz ogx3_{key} nie znaleziony w blobie")
window = buf[pos + len(kb): pos + len(kb) + 900_000]

texts = [window.decode("latin1")]
for par in (0, 1):
    texts.append(window[par:].decode("utf-16-le", "ignore"))

entries = []
seen = set()
pat = re.compile(r'\{\\?"time\\?":\\?"(\d\d:\d\d:\d\d)\\?",\\?"msg\\?":\\?"(.*?)\\?",\\?"type\\?":\\?"(\w+)\\?"\}')
for t in texts:
    for m in pat.finditer(t):
        tm, msg, typ = m.group(1), m.group(2), m.group(3)
        if (tm, msg[:60]) in seen:
            continue
        seen.add((tm, msg[:60]))
        msg = msg.replace('\\\\"', '"').replace('\\"', '"')
        entries.append((tm, typ, msg))

since = sys.argv[1] if len(sys.argv) > 1 and re.match(r"^\d\d:\d\d$", sys.argv[1]) else None
entries.sort(key=lambda e: e[0])
for tm, typ, msg in entries:
    if since and tm < since + ":00":
        continue
    print(f"{tm} [{typ.upper()}] {msg}")
