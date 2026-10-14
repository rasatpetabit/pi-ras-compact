import { fileURLToPath } from 'node:url';
import { treeHash } from '../test/support/tree-hash.js';

console.log(treeHash(fileURLToPath(new URL('../src/vendor/pi-jev/', import.meta.url))));
