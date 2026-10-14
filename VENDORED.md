# Vendored code

**Source:** `@alexlikevibe/pi-jev` 0.2.1 (MIT, Copyright Fan Fei), from the npm tarball
`https://registry.npmjs.org/@alexlikevibe/pi-jev/-/pi-jev-0.2.1.tgz` with integrity
`sha512-juku5Lb9J7tDhtBCDaqH5I9XNtTpkep4yeHLf7fvVCy68yAJDStHpb0MPPG1p9TF9rnJLybOJBvgtICa7bdLmw==`
(checked against the tarball on 2026-09-23).

**Taken** into `src/vendor/pi-jev/`, keeping upstream's relative paths so its imports resolve
unchanged:
- `compaction/convert.ts` and `compaction/decision.ts`;
- `vendor/fast-jev-compaction/` (every file, with its own LICENSE);
- `LICENSE` (the package's).

**Not taken:** `compaction/jev.ts`, `compaction/extension.ts` and `compaction/summarize.ts` are
replaced by `src/core/` and `src/pi/`. Also not taken: `shared/`, `commands/`, `routing/` and
`cli/`. So the package has no `/jev` command and no `jev.json` config.

Tree sha256: `8f6d3bf06e57b71d7dd4c34ddde0098a6b16d7235f03a100ce0af8cd97a9fa2d`

`test/vendored.test.ts` recomputes the tree hash, so no vendored change lands unrecorded. After
any change, run `node --import tsx scripts/tree-hash.ts`, update the line above and list the
change below.

## Local changes

1. `vendor/fast-jev-compaction/types.ts`: `Message.source?: 'custom'`.
2. `compaction/convert.ts`: `custom` messages get `source: 'custom'`. The engine does not pin them
   as user text, and renders them as context.
