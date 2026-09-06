// Fixture capture producer: `png` writes one PNG to stdout, `text` writes text, `fail` exits 2, `sleep` stalls.
import { setTimeout as delay } from 'node:timers/promises';
import { redImage } from './image-fixtures.mjs';
const verb = process.argv[2];
if (verb === 'png') process.stdout.write(redImage);
else if (verb === 'text') process.stdout.write('not a png\n');
else if (verb === 'fail') { process.stderr.write('capture: device offline\n'); process.exit(2); }
else if (verb === 'sleep') await delay(Number(process.argv[3] ?? 5000));
else { process.stderr.write(`capture: unknown verb ${verb}\n`); process.exit(2); }
