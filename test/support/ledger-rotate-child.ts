/**
 * Appends numbered rows to one ledger file with a tiny rotation limit, so two of these
 * processes can race a rename. The parent asserts every row lands in exactly one file.
 */
import { appendJsonLine, flushTelemetry } from '../../src/client/ledger.js';

const [path, id, countText, rotateText] = process.argv.slice(2);
const count = Number(countText);
const rotateAtBytes = Number(rotateText);
if (!path || !id || !Number.isInteger(count) || !Number.isInteger(rotateAtBytes)) {
  throw new Error('usage: ledger-rotate-child.ts <path> <id> <count> <rotateAtBytes>');
}

// Each row carries its own length, so two rows never share text and a collision
// between them cannot hide a lost row behind an identical one.
for (let n = 0; n < count; n++) appendJsonLine(path, { id, n, pad: 'x'.repeat(n) }, { rotateAtBytes });
await flushTelemetry();
