#!/usr/bin/env python3
"""Convert a 32-bit BMP snapshot to a PNG on stdout, optionally downscaled by an integer factor.

The desktop writes BMP; dashboard captures, evidence documents and review tools want PNG. Standard
library only (zlib and struct), so no image dependency enters the project for this.
"""
import struct
import sys
import zlib


def chunk(kind, payload):
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff)


def main(argv):
    if not 2 <= len(argv) <= 3:
        raise SystemExit("usage: bmp_to_png.py FILE.bmp [DOWNSCALE] > out.png")
    step = int(argv[2]) if len(argv) == 3 else 1
    if step < 1:
        raise SystemExit("downscale must be 1 or more")
    with open(argv[1], "rb") as handle:
        data = handle.read()
    if data[:2] != b"BM":
        raise SystemExit("%s: not a BMP file" % argv[1])
    offset, = struct.unpack_from("<I", data, 10)
    width, height = struct.unpack_from("<ii", data, 18)
    depth, = struct.unpack_from("<H", data, 28)
    if depth != 32:
        raise SystemExit("%s: expected a 32-bit BMP, found %d-bit" % (argv[1], depth))
    rows_count = abs(height)
    stride = (width * 4 + 3) & ~3
    rows = [data[offset + y * stride: offset + y * stride + width * 4] for y in range(rows_count)]
    if height > 0:
        rows.reverse()
    out = []
    for y in range(0, rows_count, step):
        row = rows[y]
        out.append(bytes(channel for x in range(0, width, step)
                         for channel in (row[x * 4 + 2], row[x * 4 + 1], row[x * 4])))
    png_width, png_height = (width + step - 1) // step, len(out)
    raw = b"".join(b"\0" + row for row in out)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", png_width, png_height, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 6))
           + chunk(b"IEND", b""))
    sys.stdout.buffer.write(png)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
