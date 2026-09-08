#!/usr/bin/env python3
"""Wyciąga wartość dowolnego klucza GM bota 3.x ze structured clone (snappy framing).
Użycie: ogx_get.py <klucz-bez-prefiksu> [ścieżka.jq.w.jsonie]"""
import sys, json, re, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util
spec = importlib.util.spec_from_file_location(
    "ogx_state", os.path.join(os.path.dirname(os.path.abspath(__file__)), "ogx_state.py"))

# nie odpalamy ogx_state jako modułu (ma kod na poziomie pliku) — bierzemy tylko funkcje
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ogx_state.py")).read()
ns = {"__file__": os.path.join(os.path.dirname(os.path.abspath(__file__)), "ogx_state.py")}
exec(src.split("key = (")[0], ns)
buf = ns["unframe"](ns["newest_blob"]())

key = sys.argv[1]
kb = f"genesis.ogamex.net:ogx3_{key}".encode("latin1")
# klucz jest zapisany jako UTF-16 albo latin1 — spróbuj obu
pos = buf.find(kb)
enc16 = False
if pos < 0:
    kb16 = f"genesis.ogamex.net:ogx3_{key}".encode("utf-16-le")
    pos = buf.find(kb16)
    if pos < 0:
        sys.exit("klucz nie znaleziony")
    pos += len(kb16)
    enc16 = True
else:
    pos += len(kb)

# nagłówek wartości: szukaj tagu stringa (04 00 FF FF) tuż za kluczem
p = None
for cand in range(pos, pos + 32):
    if buf[cand+4:cand+8] == b"\x04\x00\xff\xff":
        p = cand
        break
if p is None:
    sys.exit(f"brak tagu stringa za kluczem (okolica: {buf[pos:pos+32].hex()})")
data = int.from_bytes(buf[p:p+4], "little")
length = data & 0x7FFFFFFF
latin1 = bool(data & 0x80000000)
start = p + 8
if latin1:
    s = buf[start:start+length].decode("latin1")
else:
    s = buf[start:start+2*length].decode("utf-16-le")

if s[:1] == "s":  # prefiks typu Tampermonkeya
    s = s[1:]
val = json.loads(s)
for step in sys.argv[2:]:
    val = val[int(step)] if isinstance(val, list) else val.get(step)
print(json.dumps(val, ensure_ascii=False, indent=1)[:6000])
