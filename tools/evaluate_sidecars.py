#!/usr/bin/env python3
"""Measure context size and lookup latency; does not measure model accuracy."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
CASES = [
    ('orchestrator/native/terminal.c', 'real-vt-screen'),
    ('orchestrator/server/store.mjs', 'save-and-draft-order'),
    ('orchestrator/runtime/supervisor.mjs', 'prepare-switch-recover'),
]


def run(command):
    start = time.perf_counter()
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=120)
    return result, time.perf_counter() - start


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--revision', default='ca44dd5')
    parser.add_argument('--tool', type=Path, default=ROOT / '.claude/skills/llm-sidecar/scripts/sidecar_tool.py')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = {'revision': args.revision, 'units': 'UTF-8 bytes and wall seconds, not model tokens', 'cases': []}
    with tempfile.TemporaryDirectory(prefix='rengine-sidecar-eval-') as temp:
        corpus = Path(temp)
        for filename, entry_id in CASES:
            source = subprocess.check_output(['git', 'show', f'{args.revision}:{filename}'], cwd=ROOT)
            notes = subprocess.check_output(['git', 'show', f'{args.revision}:{filename}._llm.json'], cwd=ROOT)
            destination = corpus / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(source)
            destination.with_name(destination.name + '._llm.json').write_bytes(notes)
        cli = [sys.executable, str(args.tool.resolve()), '--root', str(corpus), '--index', str(corpus / '.cache/index.sqlite')]
        for filename, entry_id in CASES:
            source = (corpus / filename).read_bytes()
            sidecar = json.loads((corpus / (filename + '._llm.json')).read_text())
            entry = next(x for x in sidecar['entries'] if x['id'] == entry_id)
            line = entry['anchor']['start']
            excerpt = '\n'.join(source.decode().splitlines()[max(0, line - 9):line + 8])
            command = cli + ['query', '--path', filename, '--line', str(line), '--radius', '8', '--json']
            durations = []
            for _ in range(3):
                query, elapsed = run(command)
                payload = json.loads(query.stdout)
                if query.returncode not in (0, 1) or not payload.get('results'):
                    raise RuntimeError(query.stdout + query.stderr)
                durations.append(elapsed)
            result['cases'].append({'source': filename, 'entry': entry_id,
                'source_sha256': hashlib.sha256(source).hexdigest(), 'full_source_bytes': len(source),
                'raw_sidecar_bytes': (corpus / (filename + '._llm.json')).stat().st_size,
                'source_excerpt_bytes': len(excerpt.encode()), 'selected_note_bytes': len(entry['note'].encode()),
                'tool_json_bytes': len(query.stdout.encode()), 'lookup_seconds': durations,
                'median_seconds': statistics.median(durations),
                'diagnostics': sorted({x['code'] for x in payload['diagnostics']})})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
