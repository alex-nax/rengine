#!/usr/bin/env python3
"""Read named pixels out of a BMP snapshot in logical coordinates.

The native design spec asserts card geometry and colours against real snapshots; it needs a few
pixels, not a whole image decoder in the test. Probes are given in logical pixels and scaled by the
snapshot's density (its width divided by --logical-width), which is how the desktop maps them.

    bmp_probe.py FILE --logical-width 1280 toolbar=40,18 status=40,-11

A negative coordinate counts back from the right or bottom edge, so a probe can name the status bar
without knowing the window height. Output is JSON: {"name": "#rrggbb", ...}.
"""
import json
import struct
import sys


def load(path):
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:2] != b"BM":
        raise SystemExit("%s: not a BMP file" % path)
    offset, = struct.unpack_from("<I", data, 10)
    width, height = struct.unpack_from("<ii", data, 18)
    depth, = struct.unpack_from("<H", data, 28)
    if depth != 32:
        raise SystemExit("%s: expected a 32-bit BMP, found %d-bit" % (path, depth))
    rows_count = abs(height)
    stride = (width * 4 + 3) & ~3
    rows = [data[offset + y * stride: offset + y * stride + width * 4] for y in range(rows_count)]
    if height > 0:
        rows.reverse()
    return width, rows_count, rows


def main(argv):
    if len(argv) < 4 or argv[2] != "--logical-width":
        raise SystemExit("usage: bmp_probe.py FILE --logical-width N name=x,y [name=x,y ...]")
    width, rows_count, rows = load(argv[1])
    logical = int(argv[3])
    density = max(1, round(width / logical)) if logical else 1
    out = {}
    for probe in argv[4:]:
        name, _, position = probe.partition("=")
        x_text, _, y_text = position.partition(",")
        x, y = int(x_text) * density, int(y_text) * density
        if x < 0:
            x += width
        if y < 0:
            y += rows_count
        if not (0 <= x < width and 0 <= y < rows_count):
            raise SystemExit("probe %s is outside the %dx%d snapshot" % (name, width, rows_count))
        row = rows[y]
        out[name] = "#%02x%02x%02x" % (row[x * 4 + 2], row[x * 4 + 1], row[x * 4])
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
