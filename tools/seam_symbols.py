#!/usr/bin/env python3
"""Fail the build if a seam copy exported a symbol the rename missed.

`tools/seam_prefix.py` derives the rename list from the pack's headers, which is the half that can
go stale: a symbol added to a header the derivation does not read, or defined in a source without
being declared anywhere, is renamed by nothing. That failure is silent and nasty — the linker takes
the first definition it sees, so two renderers quietly share one backend's function and the only
symptom is a frame that came from the wrong API.

So the archives are asked directly, after they are built. Every global symbol in a copy that belongs
to one of the seam's families must carry that copy's prefix. Nothing is trusted about how it got
there.

  seam_symbols.py <prefix> <archive> [archive...]
"""
import re
import subprocess
import sys
from pathlib import Path

# Everything a copy exports whose name is rEngine's, as it appears in a symbol table. The leading
# underscore is Mach-O's; ELF has none, so it is optional here and the same check serves both.
#
# This asks about `re_` rather than about the five families the rename covers, on purpose. A family
# list here would have exactly the blind spot it is meant to catch — the first version of this file
# matched `re_seam_` and friends, which a correctly renamed `re_metal_seam_open` does not start
# with, so it examined ZERO symbols and reported success on both copies. The invariant that actually
# holds is narrower and needs no list: a copy exports nothing of rEngine's that is not its own.
OWNED = re.compile(r"^_?re_")


def globals_in(archive):
    """Defined, external symbols only: `nm -g` with the undefined and common entries dropped."""
    output = subprocess.run(["nm", "-g", str(archive)], capture_output=True, text=True)
    if output.returncode != 0:
        raise SystemExit("seam symbols: nm failed on %s: %s" % (archive, output.stderr.strip()))
    names = []
    for line in output.stdout.splitlines():
        parts = line.split()
        # "<address> <type> <name>"; an undefined symbol has no address and type U.
        if len(parts) < 2 or parts[-2].upper() in ("U", "W"):
            continue
        names.append(parts[-1])
    return names


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__.strip().splitlines()[-1].strip())
    prefix, archives = argv[1], [Path(a) for a in argv[2:]]
    escaped = []
    checked = 0
    for archive in archives:
        if not archive.exists():
            raise SystemExit("seam symbols: %s does not exist" % archive)
        for name in globals_in(archive):
            if not OWNED.match(name):
                continue
            checked += 1
            if not name.lstrip("_").startswith(prefix):
                escaped.append("%s: %s" % (archive.name, name))
    # A check that examined nothing passes for the wrong reason, which is how the first version of
    # this file reported two clean copies while looking at no symbols at all.
    if checked == 0:
        print("ERROR: no re_* symbols found in %s -- the check examined nothing, which is not the "
              "same as finding nothing wrong." % ", ".join(a.name for a in archives), file=sys.stderr)
        return 1
    if escaped:
        print("ERROR: %d symbol(s) escaped the '%s' rename, so two copies of the seam would collide "
              "and the linker would silently pick one:" % (len(escaped), prefix), file=sys.stderr)
        for item in sorted(escaped):
            print("  %s" % item, file=sys.stderr)
        print("Add the declaring header to tools/seam_prefix.py's HEADERS, regenerate, and rebuild.",
              file=sys.stderr)
        return 1
    print("seam symbols: %d exported symbols in %d archive(s), all carrying '%s'."
          % (checked, len(archives), prefix))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
