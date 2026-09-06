#!/usr/bin/env python3
"""Summarise a 32-bit BMP snapshot: geometry, alpha and the colours that dominate it.

The desktop writes evidence and comparison snapshots as BMP (`--snapshot`, the automation
`snapshot` op). Reading one in an editor is useless; this preview answers the questions that
actually come up: what size and density was it captured at, and which theme colours cover it.
Standard library only, as the project's Python tooling requires.
"""
import struct
import sys
from collections import Counter

LOGICAL = (1280, 800)  # the desktop's default window, so density can be reported when it matches


def read(path):
    with open(path, "rb") as handle:
        header = handle.read(54)
        if len(header) < 54 or header[:2] != b"BM":
            raise SystemExit("%s: not a BMP file" % path)
        offset, = struct.unpack_from("<I", header, 10)
        width, height = struct.unpack_from("<ii", header, 18)
        planes, depth = struct.unpack_from("<HH", header, 26)
        compression, = struct.unpack_from("<I", header, 30)
        handle.seek(offset)
        rows = abs(height)
        stride = (width * depth // 8 + 3) & ~3
        pixels = handle.read(stride * rows)
    return {"width": width, "height": height, "depth": depth, "planes": planes,
            "compression": compression, "stride": stride, "pixels": pixels, "bottom_up": height > 0}


def main(argv):
    if len(argv) != 2:
        raise SystemExit("usage: bmp_info.py FILE.bmp")
    info = read(argv[1])
    width, rows, depth = info["width"], abs(info["height"]), info["depth"]
    print("%s" % argv[1])
    print("  %d x %d pixels, %d-bit, %s, %s compression" % (
        width, rows, depth, "bottom-up" if info["bottom_up"] else "top-down",
        "no" if info["compression"] == 0 else str(info["compression"])))
    if width and rows and width % LOGICAL[0] == 0 and rows % LOGICAL[1] == 0 and width // LOGICAL[0] == rows // LOGICAL[1]:
        print("  density %dx against the %dx%d window" % (width // LOGICAL[0], *LOGICAL))
    if depth != 32:
        print("  (colour summary needs a 32-bit snapshot)")
        return 0
    pixels, stride = info["pixels"], info["stride"]
    counts, opaque, translucent = Counter(), 0, 0
    for y in range(rows):
        row = pixels[y * stride:y * stride + width * 4]
        for x in range(0, len(row), 4):
            blue, green, red, alpha = row[x], row[x + 1], row[x + 2], row[x + 3]
            counts[(red, green, blue)] += 1
            if alpha == 255:
                opaque += 1
            elif alpha:
                translucent += 1
    total = sum(counts.values()) or 1
    print("  %d distinct colours; %.1f%% fully opaque, %.1f%% translucent" % (
        len(counts), 100.0 * opaque / total, 100.0 * translucent / total))
    print("  dominant colours:")
    for (red, green, blue), count in counts.most_common(8):
        print("    #%02x%02x%02x  rgb(%3d %3d %3d)  %6.2f%%" % (red, green, blue, red, green, blue, 100.0 * count / total))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
