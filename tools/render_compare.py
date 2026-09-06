#!/usr/bin/env python3
"""Compare two native snapshots (BMP files written by the desktop) under a recorded tolerance.

  render_compare.py REFERENCE.bmp CANDIDATE.bmp [--max-fraction F] [--max-delta D] [--edge-band N] [--json]

Reports the fraction of pixels whose RGB differs, the largest per-channel difference, and, with
--edge-band N, how many differing pixels lie farther than N pixels from an edge of the reference
(an edge is a pixel whose RGB differs from its right or lower neighbour). Exit status is 1 when a
limit is exceeded. Alpha is ignored. Standard library only; see docs/specs/068-opengl-adapter.md.
"""
import json
import struct
import sys


def read_bmp(path):
    data = open(path, "rb").read()
    if data[:2] != b"BM":
        raise SystemExit("ERROR: %s is not a BMP file" % path)
    offset = struct.unpack_from("<I", data, 10)[0]
    header = struct.unpack_from("<I", data, 14)[0]
    width, height = struct.unpack_from("<ii", data, 18)
    bpp, compression = struct.unpack_from("<HI", data, 28)
    if bpp not in (24, 32):
        raise SystemExit("ERROR: %s uses %d bits per pixel; only 24 and 32 are supported" % (path, bpp))
    masks = (0x00ff0000, 0x0000ff00, 0x000000ff)
    if compression == 3 and header >= 52:
        masks = struct.unpack_from("<III", data, 54)
    elif compression not in (0, 3):
        raise SystemExit("ERROR: %s uses unsupported BMP compression %d" % (path, compression))
    shifts = [(mask & -mask).bit_length() - 1 for mask in masks]
    flip = height > 0
    height = abs(height)
    stride = (width * bpp // 8 + 3) & ~3
    rows = []
    for y in range(height):
        row = data[offset + y * stride: offset + y * stride + width * bpp // 8]
        pixels = []
        for x in range(width):
            if bpp == 32:
                value = struct.unpack_from("<I", row, x * 4)[0]
                pixels.append(tuple((value >> shift) & 0xff for shift in shifts))
            else:
                b, g, r = row[x * 3: x * 3 + 3]
                pixels.append((r, g, b))
        rows.append(pixels)
    if flip:
        rows.reverse()
    return width, height, rows


def edge_mask(width, height, rows, band):
    edges = set()
    for y in range(height):
        for x in range(width):
            p = rows[y][x]
            if (x + 1 < width and rows[y][x + 1] != p) or (y + 1 < height and rows[y + 1][x] != p):
                edges.add((x, y))
    if band <= 0:
        return edges
    dilated = set()
    for x, y in edges:
        for dy in range(-band, band + 1):
            for dx in range(-band, band + 1):
                dilated.add((x + dx, y + dy))
    return dilated


def compare(reference, candidate, band):
    width, height, a = read_bmp(reference)
    cw, ch, b = read_bmp(candidate)
    if (width, height) != (cw, ch):
        raise SystemExit("ERROR: size mismatch %dx%d vs %dx%d" % (width, height, cw, ch))
    differing, max_delta, outside = 0, 0, 0
    band_mask = edge_mask(width, height, a, band) if band is not None else None
    for y in range(height):
        ra, rb = a[y], b[y]
        for x in range(width):
            pa, pb = ra[x], rb[x]
            if pa != pb:
                differing += 1
                delta = max(abs(pa[0] - pb[0]), abs(pa[1] - pb[1]), abs(pa[2] - pb[2]))
                if delta > max_delta:
                    max_delta = delta
                if band_mask is not None and (x, y) not in band_mask:
                    outside += 1
    total = width * height
    return {"width": width, "height": height, "pixels": total, "differing": differing,
            "fraction": differing / total if total else 0.0, "max_delta": max_delta,
            "outside_edge_band": outside if band is not None else None, "edge_band": band}


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    options = {"--max-fraction": None, "--max-delta": None, "--edge-band": None}
    as_json = "--json" in argv
    for key in options:
        if key in argv:
            options[key] = argv[argv.index(key) + 1]
            args = [a for a in args if a != options[key]]
    if len(args) != 2:
        print(__doc__.strip())
        return 2
    band = int(options["--edge-band"]) if options["--edge-band"] is not None else None
    result = compare(args[0], args[1], band)
    failures = []
    if options["--max-fraction"] is not None and result["fraction"] > float(options["--max-fraction"]):
        failures.append("differing fraction %.5f exceeds %s" % (result["fraction"], options["--max-fraction"]))
    if options["--max-delta"] is not None and result["max_delta"] > int(options["--max-delta"]):
        failures.append("max channel delta %d exceeds %s" % (result["max_delta"], options["--max-delta"]))
    if band is not None and result["outside_edge_band"]:
        failures.append("%d differing pixels lie outside the %dpx edge band" % (result["outside_edge_band"], band))
    result["failures"] = failures
    print(json.dumps(result) if as_json else
          "%dx%d: %d of %d pixels differ (%.5f), max channel delta %d%s%s" % (
              result["width"], result["height"], result["differing"], result["pixels"], result["fraction"], result["max_delta"],
              "" if band is None else ", %d outside the %dpx edge band" % (result["outside_edge_band"], band),
              "" if not failures else "\nFAIL: " + "; ".join(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
