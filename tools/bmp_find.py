#!/usr/bin/env python3
"""Count pixels of an exact colour inside a region of a BMP snapshot.

Probing a single pixel proves a solid fill; proving that a *glyph* was drawn in a colour needs a
region, because only the fully covered pixels of a stem carry the colour exactly. The design spec
uses this to assert that syntax colours reach the screen.

    bmp_find.py FILE --logical-width 1280 --region 10,120,280,200 --colour #c1a9ee

--differs-from FILE counts the pixels of the region that differ from the same region of another
snapshot, which is how "the image changed" is asked — of a drag that moved a camera, say.

--distinct counts the distinct colours in the region instead, which is the question a RENDERED
region answers: a scene cannot be asserted colour by colour, but "this is an image and not a flat
fill" is exactly a count. Used by the scene tab's spec (F136).

    bmp_find.py FILE --logical-width 1280 --region 299,65,981,713 --distinct 1
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
    if not path or "region" not in args or not ({"colour", "distinct", "differs-from"} & set(args)):
        raise SystemExit("usage: bmp_find.py FILE --logical-width N --region x,y,w,h "
                         "(--colour #rrggbb | --distinct 1 | --differs-from FILE)")
    width, rows_count, rows = load(path)
    logical = int(args.get("logical-width", width))
    density = max(1, round(width / logical)) if logical else 1
    x, y, w, h = (int(value) * density for value in args["region"].split(","))
    if "differs-from" in args:
        other_width, other_rows_count, other_rows = load(args["differs-from"])
        if (other_width, other_rows_count) != (width, rows_count):
            raise SystemExit("the two snapshots are different sizes")
        differing = 0
        for row_index in range(max(0, y), min(rows_count, y + h)):
            row, other = rows[row_index], other_rows[row_index]
            for column in range(max(0, x), min(width, x + w)):
                at = column * 4
                if row[at:at + 3] != other[at:at + 3]:
                    differing += 1
        print(json.dumps({"differing": differing, "region": [x, y, w, h]}))
        return 0
    if "distinct" in args:
        seen = set()
        for row_index in range(max(0, y), min(rows_count, y + h)):
            row = rows[row_index]
            for column in range(max(0, x), min(width, x + w)):
                seen.add(row[column * 4: column * 4 + 3])
        print(json.dumps({"distinct": len(seen), "region": [x, y, w, h]}))
        return 0
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
