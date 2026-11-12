# Jev checks

Run commands from the package root (`pi-jev/` in this repository). `npm test` unsets `JEV_TELEMETRY_SOURCE` and
`JEV_TELEMETRY_EVAL_DIR` before the Node suites. Those variables belong to eval harnesses;
leaving them set would write the suite into the eval ledger.

Node's test runner is the runner. `--test-concurrency=4` is the measured bound that finishes
this suite without `ERR_WORKER_INIT_FAILED`. There is no separate CI workflow and no time
limit encoded here: re-time a run with `time` when a change is suspected of being slow.
The runs measured for this bound are in `docs/test-process-sensitivity.txt`.
Do not add a skip, a retry, or a weaker assertion because a prerequisite is missing.

## Development-checkout commands

The public snapshot carries only the standalone test tree: its bounded `npm test`,
`test:unit`, and `test:contract` remain available, together with `release:verify`. It does not
advertise `test:identity`, `test:controller`, or `test:archive`, because their private eval
subjects are not exported. The table below describes the development checkout.

| Command | What it runs | What a failure means |
|---|---|---|
| `npm run test:contract` | Charter integration, the loopback two-compaction boundary, restorable expand, and local-client/hook routing | A failed or empty question disappeared, a recovery id does not restore the historical bytes, or a local failure took the wrong fallback |
| `npm run test:unit` | `test/*.test.ts`, concurrency 4 | A unit or the contract files above regressed. Does not hash the production golden |
| `npm run test:identity` | `eval/production-identity/identity.test.mts` | Production config, request bytes, or the named summary facts moved |
| `npm run test:controller` | `eval/cache/controller-acceptance.mts` | The offline controller/layout acceptance moved |
| `npm test` | unit + identity + controller at concurrency 4, then `bash eval/rtx4000/test_archive.sh` | The normal full check. The archive step packs `HEAD` and replays a synthetic session offline |
| `npm run test:archive` | The archive step alone | The committed tree's offline replay fixture broke |

`npm run release:verify` checks the public package shape. It is not a behavior suite.

## What the contract tests catch

`test/charter-integration.test.ts` checks one rendered generation: an errored or empty
`ask_user_question` round stays in the summary and is not stored as an answer.
`test/compact-boundary.test.ts` is the next step. It calls `handleCompact` with a real
`LocalDecisionClient` against a loopback HTTP server, writes the compaction to a temp file,
reloads that file, compacts again from the reloaded carry, then calls the registered
`jev_expand` tool. The preparation object is the hook's `readInput` seam (`piEvent`). It is
not an installed Pi SDK session. The server's answers are fixed constants.

That test fails if a failed question becomes an approval, if the operator instruction or the
answered round disappears on the second compaction, if a dropped read returns in the summary
or the carry, or if `jev_expand` does not return the historical write body and tool result.
The session record still holds dropped bytes; "does not resurrect" means the next summary and
carry do not.

`test/local-live.test.ts` covers the wire-to-hook path the fake askers do not. A local HTTP
failure is followed by exactly one hosted pass. Only `https://api.typesafe.ai/v1/systemone`
is mocked; loopback traffic uses the real client. A wrong `local_revision` is an `http`
service failure and the same one hosted pass, never a successful local compaction. A
malformed HTTP 200 cancels with `parse`, makes no hosted request, and does not change
`process.exitCode` in this non-CLI process. `undefined` is not a successful cancel: that is
the result Pi would treat as permission to summarize itself.

## Identity diffs

A golden digest match is not model quality. `identity.test.mts` also asserts the visible
failure line, the applied edit, which backend served, and that a charter correction keeps
the old rule visible. When a digest fails:

1. Re-run `JEV_IDENTITY_DUMP=/path/to/empty-dir npm run test:identity`.
2. Diff `*.json` in that directory against a dump from the parent commit. `*.digests.json`
   names the part that moved (`requests`, `result`, `telemetry`, `logs`, `notes`).
3. Read the named part. Do not copy a new `golden.json` over the old one to make the test
   pass. Replace the golden only when the behavior change was authorized, and name that
   decision in the commit that replaces it.

## Not this suite

These commands do not start a GPU, a provider, or a headless Pi session. They do not prove
live H2O or OpenJev quality. Live and eval entry points, with their own prerequisites, are
the harnesses under `eval/` and `scripts/` named by `README.md` (replay-local, the H2O
cutover probe, charter-referent, external-bench, compactbench). `eval/cache/README.md` is
the cache measurement harness; `npm run test:controller` is only its offline acceptance.

The public snapshot omits private configuration and evaluation receipts. Existing conditional
assertions that require those artifacts report skips there; inspect the skipped cases rather
than treating a standalone pass as production-policy coverage. The development suite covers
those artifacts.

`test/extension.test.ts` still contains two cases that load the installed Pi package when it
is present and skip when `loadPiRelease` cannot find it. A skip there means the host package
was absent, not that the offline contract passed. The contract commands above do not use
that package.

`eval/rtx4000/test_archive.sh` needs `npm ci --offline` to succeed from the local npm cache,
`git`, and `python3`. It archives `HEAD`, so it does not see uncommitted files.
Scratch uses Node's temporary-directory lookup, including `TMPDIR`, just like the replay
privacy guard, which intentionally refuses output outside that temporary root. To exercise
this environment contract explicitly, including cleanup:

```bash
(
  scratch=$(mktemp -d)
  trap 'rm -rf -- "$scratch"' EXIT
  TMPDIR="$scratch" npm run test:archive
)
```
