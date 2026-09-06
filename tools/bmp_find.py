#!/usr/bin/env python3
"""Count pixels of an exact colour inside a region of a BMP snapshot.

Probing a single pixel proves a solid fill; proving that a *glyph* was drawn in a colour needs a
region, because only the fully covered pixels of a stem carry the colour exactly. The design spec
uses this to assert that syntax colours reach the screen.

    bmp_find.py FILE --logical-width 1280 --region 10,120,280,200 --colour #c1a9ee
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
    args = {}
    path = argv[1] if len(argv) > 1 else None
    index = 2
    while index + 1 < len(argv):
        args[argv[index].lstrip("-")] = argv[index + 1]
        index += 2
    if not path or "region" not in args or "colour" not in args:
        raise SystemExit("usage: bmp_find.py FILE --logical-width N --region x,y,w,h --colour #rrggbb")
    width, rows_count, rows = load(path)
    logical = int(args.get("logical-width", width))
    density = max(1, round(width / logical)) if logical else 1
    x, y, w, h = (int(value) * density for value in args["region"].split(","))
    wanted = args["colour"].lstrip("#")
    red, green, blue = (int(wanted[i:i + 2], 16) for i in (0, 2, 4))
    count = 0
    for row_index in range(max(0, y), min(rows_count, y + h)):
        row = rows[row_index]
        for column in range(max(0, x), min(width, x + w)):
            if row[column * 4 + 2] == red and row[column * 4 + 1] == green and row[column * 4] == blue:
                count += 1
    print(json.dumps({"count": count, "region": [x, y, w, h], "colour": "#%02x%02x%02x" % (red, green, blue)}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
