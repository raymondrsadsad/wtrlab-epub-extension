#!/usr/bin/env python3
"""Generate the extension icons (download-into-tray glyph on the slate accent).
Run: python3 scripts/make-icons.py  → writes icons/icon{16,32,48,128}.png
No third-party deps (hand-rolled PNG encoder)."""
import zlib, struct, os, math

BG = (95, 112, 152)      # #5f7098 slate accent
GLYPH = (245, 247, 250)  # near-white

def write_png(path, w, h, rgba):
    def chunk(typ, data):
        return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgba[y * w * 4:(y + 1) * w * 4]
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))

def rrect_inside(x, y, m, rr):
    bx = by = 0.5 - m
    px, py = abs(x - 0.5), abs(y - 0.5)
    qx, qy = px - (bx - rr), py - (by - rr)
    d = math.hypot(max(qx, 0), max(qy, 0)) - rr
    return d < 0

def in_tri(x, y, a, b, c):
    def s(p, q, r): return (p[0]-r[0])*(q[1]-r[1]) - (q[0]-r[0])*(p[1]-r[1])
    d1, d2, d3 = s((x,y),a,b), s((x,y),b,c), s((x,y),c,a)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)

def glyph(x, y):
    if 0.45 <= x <= 0.55 and 0.24 <= y <= 0.52: return True          # stem
    if in_tri(x, y, (0.36, 0.48), (0.64, 0.48), (0.50, 0.70)): return True  # arrowhead
    if 0.32 <= x <= 0.68 and 0.74 <= y <= 0.80: return True          # tray
    return False

def render(N, ss=4):
    buf = bytearray(N * N * 4)
    for py in range(N):
        for px in range(N):
            r = g = b = a = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / N
                    y = (py + (sy + 0.5) / ss) / N
                    if rrect_inside(x, y, 0.06, 0.22):
                        col = GLYPH if glyph(x, y) else BG
                        r += col[0]; g += col[1]; b += col[2]; a += 255
            n = ss * ss
            i = (py * N + px) * 4
            if a > 0:
                buf[i] = round(r / (a / 255)); buf[i+1] = round(g / (a / 255)); buf[i+2] = round(b / (a / 255))
            buf[i+3] = round(a / n)
    return buf

if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "icons")
    os.makedirs(out, exist_ok=True)
    for N in (16, 32, 48, 128):
        write_png(os.path.join(out, f"icon{N}.png"), N, N, render(N))
        print("wrote icons/icon%d.png" % N)
