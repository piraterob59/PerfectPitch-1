# Generates the three PWA icon PNGs (icon-192, icon-512, apple-touch-icon)
# from scratch, using only Python's standard library — no Pillow/image
# libraries. Draws a simple white eighth-note glyph on a purple rounded
# square. Placeholder icon; a nicer one can replace it later the same way
# TimeTracker-II's tools/icon-designer.html replaced its generated clock icon.

import struct
import zlib

BG = (124, 58, 237)     # accent purple (matches manifest.json theme_color)
GLYPH = (255, 255, 255)


def make_icon(size, corner_radius):
    pixels = [[BG for _ in range(size)] for _ in range(size)]

    def in_rounded_square(x, y):
        r = corner_radius
        if x < r and y < r:
            return (x - r) ** 2 + (y - r) ** 2 <= r * r
        if x >= size - r and y < r:
            return (x - (size - r)) ** 2 + (y - r) ** 2 <= r * r
        if x < r and y >= size - r:
            return (x - r) ** 2 + (y - (size - r)) ** 2 <= r * r
        if x >= size - r and y >= size - r:
            return (x - (size - r)) ** 2 + (y - (size - r)) ** 2 <= r * r
        return True

    for y in range(size):
        for x in range(size):
            if not in_rounded_square(x + 0.5, y + 0.5):
                pixels[y][x] = None

    def draw_line(x0, y0, x1, y1, thickness):
        steps = int(max(abs(x1 - x0), abs(y1 - y0)) * 2) + 1
        for i in range(steps + 1):
            t = i / steps
            px = x0 + (x1 - x0) * t
            py = y0 + (y1 - y0) * t
            r = thickness / 2
            for oy in range(-int(r) - 1, int(r) + 2):
                for ox in range(-int(r) - 1, int(r) + 2):
                    if ox * ox + oy * oy <= r * r:
                        xx, yy = int(px + ox), int(py + oy)
                        if 0 <= xx < size and 0 <= yy < size:
                            if pixels[yy][xx] is not None:
                                pixels[yy][xx] = GLYPH

    def fill_circle(cx, cy, r):
        for y in range(size):
            for x in range(size):
                dx = x + 0.5 - cx
                dy = y + 0.5 - cy
                if dx * dx + dy * dy <= r * r:
                    if pixels[y][x] is not None:
                        pixels[y][x] = GLYPH

    # Eighth-note glyph: notehead + stem + flag, roughly centered.
    notehead_r = size * 0.14
    notehead_x = size * 0.40
    notehead_y = size * 0.66
    stem_top_y = size * 0.22
    stem_x = notehead_x + notehead_r * 0.95
    stem_w = size * 0.055

    fill_circle(notehead_x, notehead_y, notehead_r)
    draw_line(stem_x, notehead_y, stem_x, stem_top_y, stem_w)
    draw_line(stem_x, stem_top_y, stem_x + size * 0.16, stem_top_y + size * 0.14, stem_w * 0.85)

    return pixels


def write_png(path, pixels, size):
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            p = pixels[y][x]
            if p is None:
                raw.extend((0, 0, 0, 0))
            else:
                raw.extend((p[0], p[1], p[2], 255))

    def chunk(tag, data):
        c = tag + data
        crc = zlib.crc32(c) & 0xffffffff
        return struct.pack('>I', len(data)) + c + struct.pack('>I', crc)

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    png = sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')

    with open(path, 'wb') as f:
        f.write(png)


for size, radius, name in [
    (192, 34, 'icon-192.png'),
    (512, 90, 'icon-512.png'),
    (180, 32, 'apple-touch-icon.png'),
]:
    px = make_icon(size, radius)
    write_png(f'icons/{name}', px, size)
    print(f'wrote icons/{name}')
