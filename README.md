# pi-ras-compact — Jev verbatim compaction for Pi

Replaces Pi's LLM compaction summary with the conversation itself, kept word for word, with Jev
(TypeSafe System One) deciding which tool calls, results and messages still matter. Paths below are
relative to this package's root unless stated otherwise.

## Installation

Install from GitHub or npm:

```sh
pi install git:github.com/rasatpetabit/pi-ras-compact
# or from npm:
pi install npm:pi-ras-compact
```

or reference the package in the `packages` array of your Pi settings file:

```json
{ "packages": ["git:github.com/rasatpetabit/pi-ras-compact"] }
```

A local checkout works the same way (`"packages": ["/absolute/path/to/pi-ras-compact"]`). Pi takes the
last non-undefined `session_before_compact` result, so keep this package last in `packages[]`.

- **API key:** the hosted backend reads `TYPESAFE_API_KEY` from the environment at call time.
  Export it in the shell that starts Pi (a profile or an equivalent secrets file sourced there).
  The endpoint is fixed in `src/client/jev-client.ts`.
- **Config:** the bundled `config/jev.toml` is the base compaction config; a non-empty
  `JEV_CONFIG_PATH` points the extension at any config file instead, and inside the source
  monorepo checkout the repository's own `config/jev.toml` is used. Edits apply at the next
  compaction. `compaction.enabled = false` is the explicit opt-out: Pi's built-in summary runs,
  with no restart.
- **No automatic fallback:** a Jev failure never hands the compaction to Pi's built-in summary on
  its own. In a TUI session the hook asks: *Retry Jev*, *Use Pi's summary* or *Cancel compaction*;
  only the explicit second choice returns to Pi. In RPC mode it asks the same, but only when the
  optional `compaction.prompt_timeout_ms` is present, which bounds the prompt so an unattended
  client cannot hang; without it, RPC does not prompt and cancels like a headless run. There is no
  built-in default. Escape, a missing chooser, a throwing prompt, the timeout and the compaction
  abort all cancel. Headless (print, json, subagents) cancels and writes the cause to stderr; under
  the Pi CLI in print/json mode it also sets `process.exitCode = 1`, because the run's last
  assistant message can still be a successful stop. RPC never touches the process exit code (and
  `isPiCliProcess()` cannot tell an in-process SDK session inside the Pi CLI process from the CLI,
  though no active host does that). User aborts and the `enabled = false` opt-out are not failures.
  Failure notices use code-authored explanations, never raw exception or provider text. Diagnostic
  causes remain in attempt telemetry; notifications name the actual attempted backend.
- **Telemetry:** `~/.local/state/jev/calls.jsonl` has one line per Jev request (counts only), and
  `compactions.jsonl` beside it has one line per compaction attempt, with `policy`
  (`"no-fallback"`, a marker only the new code writes), `engine`, `reason`, `resolution`,
  `backend`, `backend_descriptor` and hosted-retry provenance. Failure notices are deduplicated by
  `(backend ID or unknown sentinel, reason)` in the process-wide set. A
  telemetry write is asynchronous and never awaited on the call path; a non-regular-file sink (a
  FIFO, a device, a directory) is refused with a one-time stderr note, so it can never fail or
  block a Jev call or a compaction.
- **Backend provenance:** both clients own a `backend_descriptor` (`id`, `label`, effective
  `model`, sanitized endpoint-origin `where`, optional configured `revision`, optional response-validated `verified_revision`). It is
  recorded on the attempt, `compactions.jsonl`, `details.jev`, and the persisted `jev-compaction` marker.
  Local `where` identifies the relay endpoint, not the inference machine. Pins are configured
  revisions (`pinned`); `verified_revision` is recorded only after the local client validates a
  successful response (`verified`). This is a service launch label, not cryptographic attestation.
  Hosted retries additionally record `fallback_from`,
  `fallback_reason`, and `fallback_descriptor` (the failed source's descriptor captured then).
  Both local and hosted `calls.jsonl` rows include explicit `backend` IDs. Additive
  `backend_requests` maps backend IDs to actual fetch counts during this attempt, including charter,
  pruning, failed requests and HTTP retries; a hosted retry carries the failed source's counts.
  Separate additive `backend_responses` counts responses accepted by each client's response
  validation, not HTTP status alone. Both maps use per-attempt deltas (also for reused clients),
  persist in telemetry/details/markers, and carry source evidence through hosted fallback.
  Counters live in clients, not model-name inference or pruning-only statistics. No constructed
  client means **absent evidence**, not a fabricated zero. Unknown injected clients omit whichever
  counter they do not expose. On the result's backend: positive accepted responses say `served`;
  recorded zero fetches say `no requests`; positive attempts without accepted-response evidence say
  `service unconfirmed`; missing activity says `activity unknown`. Historical positive attempt
  counts are never reinterpreted as successful responses. These states precede optional model text.
- **Chat presentation:** both extension renderers share three route-first rows: backend/model,
  destination or fallback provenance, full-context evidence and successful-pass timing. Old entries
  say `backend not recorded`; identity is never inferred from a model. Context precedence is measured,
  predicted full context, message-only estimate, before-only, then unknown. Summary tokens and
  reclaimed percentages are not substituted. At inner widths ≥80, whole revision/count segments
  appear only if they fit. Expansion retains full route, pin, fallback, context, pruning, timing,
  charter, budget and identifier metadata; Pi's saved summary body is still available beneath it.
- **Release prerequisite (not met):** the installed Pi renderer API is additive: the host still adds
  title/header/spacer/padding, so its collapsed box is **eight rows**, not three (nine with the chat's
  preceding spacer). The extension now implements host-api-spec-r3: per-invocation
  `supportsCollapsedReplacement: true`, collapsed, plus a nonempty `expandHint` returns
  `{kind: "replace-collapsed", component}`. That component owns all three collapsed rows, with the
  supplied current-keybinding hint in row three; the host owns keyboard/mouse expansion and the saved
  summary. Explicit `false`, missing capability/hint, or expanded calls return additive components.
  Spec-faithful host-double tests cover complete geometry at 60/100, first-success arbitration,
  failure isolation and expansion. Actual replacement integration awaits a separately authorized
  host implementation/release; no Pi source or install was edited here.
- **Single-row messages:** installed Pi provides no terminal width to `notify`/`select`. Production
  messages therefore use a conservative **49-cell** budget at every width: 60 minus the worst-case
  `Warning: ` prefix (9) and Text padding (2). It also reserves enough room for the chooser's maximum
  configured ` (600s)` countdown plus padding. Tests render actual emitted notify/status/title strings
  through installed components at 60/100, without a supplied test width. Longer detail stays in the
  card, expanded metadata or telemetry. No guessed terminal width or host monkey-patching is used.
- **Generated samples:** `docs/backend-label-samples.txt` contains literal output from both
  extension renderers, collapsed/expanded, at 100 and 60 columns, plus one-line outcomes using
  the production message budget and complete replacement snapshots under the revised host spec.
  Regenerate with `node --import tsx scripts/backend-label-samples.mts` from the package root.
  Tests require byte-identical regeneration. Samples explicitly distinguish box-child output from
  complete host-box output.
- **Layout:**
  - `src/vendor/` holds upstream code (see `VENDORED.md`);
  - `src/client/` holds the config, HTTP and telemetry;
  - `src/core/` is harness-neutral;
  - `src/pi/extension.ts` is the Pi hook.
- **Tests:** `env -u JEV_TELEMETRY_SOURCE -u JEV_TELEMETRY_EVAL_DIR npm test` from the package
  root, plus the
  cache-controller acceptance outside the `test/*.test.ts` glob:
  `env -u JEV_TELEMETRY_SOURCE -u JEV_TELEMETRY_EVAL_DIR node --import tsx --test eval/cache/controller-acceptance.mts`
  (see `eval/cache/README.md`). Telemetry eval overrides belong only to dedicated eval harnesses.
  A change that must leave production behaviour unchanged also runs the production-config
  byte-identity check, `env -u JEV_TELEMETRY_SOURCE -u JEV_TELEMETRY_EVAL_DIR node --import tsx --test
  eval/production-identity/identity.test.mts`, which drives the real hook and clients with the
  committed config and compares request bytes, summaries and logs with a recorded golden.

## Analysing compaction decisions

**Pruning cuts are not storage caps.** A pruning cut keeps a bounded head of a tool result;
`capped` counts retained segments with storage/render caps. `stubbed` counts retained segments
containing recovery links (including shortened arguments and write/edit bodies); `unlinked`
counts segments with omitted content but no recovery target. These counts overlap: one segment
can be both capped and recoverable, and several markers in one segment count once. Dropped
segments are separate. The collapsed box reports recovery even when pruning cuts are zero.
An emergency step-6 compaction can have zero pruning cuts while still capping pinned content.

Use the `jev_expand` target printed beside omitted content to retrieve its historical snapshot,
rather than rerunning the tool. Rendering adds links to old stored cap markers without changing
the carry format. Older entries without recovery counters remain unchanged in the UI; the report
marks their counters unknown and gives recorded-entry coverage instead of treating absence as zero.

Every compaction decision leaves content-free rows in `~/.local/state/jev/` (the directory of
the configured `telemetry.path`). Rows carry ids, hashes, counts and enums only. They never
carry transcript text, file content, command text, paths or secrets. To see what a row is about, trace its
hash into the Pi session file (one `<ts>_<session_id>.jsonl` per session under Pi's sessions directory).

| File | One row per | Key fields | Joins |
|---|---|---|---|
| `compactions.jsonl` | compaction attempt | `trigger_reason`, `origin`/`requestId` (detector-requested), `backend`/`backend_descriptor`, `tokens_before`, `predicted_after`, `kept`/`truncated`/`dropped`/`pinned`, `capped`/`stubbed`/`unlinked`, `charter_*`, `jev_requests`, `latency_ms`, `resolution`/`reason` | `attempt_id`, `session_id`, `requestId` |
| `decisions.jsonl` | `compactSpan` that returned | `generation`, `final_step`, thresholds, `segments`: `[idx, kind, tool, pin, gen, chars, hash, asked, p_keep, p_call, p_result, rule, step, outcome]` (`src/core/prune.ts` `DecisionTuple`) | `attempt_id`; `hash` = segment `srcHash` |
| `calls.jsonl` | Jev/local service request | `caller`, `backend`, `model`, `input_tokens`, `latency_ms`, `outcome`, `retry`, `http_status` | `attempt_id` (compaction or detector assessment) |
| `measurements.jsonl` | committed compaction | provider-measured `measured_after` vs `predicted_after` | `attempt_id`, `session_id`, `compaction_id` |
| `detector.jsonl` | settled point / assessment / request end | `mode`, `outcome`, `reasons`, `score`, `action`, `actionTaken`; `kind: "request"` rows give the request's terminal outcome | `requestId` (= the compaction row's `requestId`), `sessionId`; `attemptId` joins `calls.jsonl` |
| `expansions.jsonl` | `jev_expand` call | `id_kind` (`tool_result`/`call_input`/`user_entry`/`answer`/`hash`/`invalid`), `part`, `tool`, `chars_returned`, `total_chars`, `offset`, `limit`, `ok` | `seg_hash` (= decision `hash`), `attempt_id` + `compaction_entry_id` of the compaction that stubbed it, `session_id` |

**Live vs eval.** Every row carries `source`: `"live"` by default, `"eval"` when the process has
`JEV_TELEMETRY_SOURCE=eval`. Every eval harness under `eval/` and every eval-driving script
under `scripts/` sets it unless the caller already did. An eval process never writes the
live directory: a row aimed there lands in `$JEV_TELEMETRY_EVAL_DIR`, or `~/.local/state/jev/eval/`
when that variable is unset. `jev-ledger.py --source eval|all` therefore reads both `--dir` and
`--dir/eval/`, and `--source live` reads only `--dir`. Both are environment variables, not config keys, because older
live sessions validate config keys strictly. Historical rows (before `source`) are never
rewritten. `jev-ledger.py` classifies them:
compaction/decision rows with no `attempt_id` key are `legacy-unknown` (written before
2026-09-26T05:55Z). Rows whose `session_id` is empty are `eval`, because only a harness runs
the hook without a Pi session. Calls with `caller: "warrant-eval"` or `config_hash: "replay-local"` are
`eval`, and other calls take their compaction's class. Calls with no `attempt_id` are `legacy-unknown`.

**Retention.** Every ledger rotates at 64 MiB (`<name>.<UTC stamp>.<pid>.<n>.jsonl`). Rotated
siblings are gzip-compressed once they are an hour old and pruned oldest-first to 2 GiB per
ledger, which is years of data at the current rate. The live file and any sibling modified in
the last hour are never deleted or compressed. These are code defaults in `src/client/ledger.ts`.
Telemetry is asynchronous and never awaited on the call path. It never throws and never changes
a compaction or a detector decision.

**Joined view.** `scripts/jev-ledger.py` (python3 stdlib) reads every ledger, `.gz` siblings
included. It is read-only. `table` has one row per attempt. Rows that share an `attempt_id` (a
failed pass and its retry) collapse to the terminal one, and `ledger_rows` counts them. `reason`
is printed only if it is a known code-authored value and is `other` otherwise. The free-text
`cause` field is never read. `trigger` is `detector` only when the row's `requestId` joins a
`detector.jsonl` row. An extension-origin row without that join is `extension-unjoined`.

```sh
python3 scripts/jev-ledger.py summary                 # live rows; counts, error, detector, regret
python3 scripts/jev-ledger.py table --format csv      # one row per compaction attempt
python3 scripts/jev-ledger.py decisions --since 2026-10-01 > decisions.jsonl   # one row per segment
# --source live|eval|legacy-unknown|unknown|all  --until  --session <id>  --dir <ledger dir>
# --sessions <Pi session root> ('' disables the regret scan)
```

The regret scan walks each live compaction's session after the compaction entry, up to the
next compaction. It counts dropped or cut segments that come back in three ways: a
`jev_expand` restore (`expand`), a later read of the same path or bash run of the same
command (`rerun`), or an identical result of 64 or more characters (`content`). Kept segments
are scored the same way as a baseline. Paths and commands are compared in memory and are
never printed.

## Warrant detector: record-only collection

The independent sibling `config/jev.detector.toml` is optional: absent, malformed or
`mode = "off"` leaves the detector off. Malformed input emits one sanitized stderr
note per path per process and does not invalidate compaction config. `active` uses the optional native one-shot request capability, with fresh warrant/snapshot gates.
The existing detector config is shipped; new controller activation is separate.

For future authorized collection, the entire required configuration is:

```toml
mode = "record"
```

Record mode captures **every real `agent_settled` event**, including repeated leaves,
unknown usage, busy state and pending messages, without assessment, native preparation,
asker construction or service requests. It never compacts or notifies. `shadow`
still requires all calibrated parameters and runs its existing background assessment;
record mode needs no numeric defaults or calibration file. Any extra supplied keys
are still strictly validated.

`detector.jsonl` is written asynchronously beside the configured `telemetry.path`
(with home expansion and the existing invalid-compaction-config fallback). A row
contains exactly:

```json
{"ts":"2026-10-01T00:00:00.000Z","kind":"settled","mode":"record","sessionId":"session-id","leafEntryId":"leaf-id","idle":true,"pendingMessages":false,"stopReason":"stop","contextTokens":6000,"contextWindow":10000,"model":{"provider":"provider-id","id":"model-id"}}
```

Unknown metadata is `null`; the stop reason belongs to the exact leaf, not a prior
assistant. Context window falls back to the model window if usage is unavailable.
Rows contain counts and identifiers only, never transcript text or tool output.
Event-time metadata is captured before dispatch and survives subsequent input or
session reset. Writes use the same private, non-blocking sink as shadow. Set mode
back to `off` or remove the sibling file to stop collection at the next settle.

Historical sources contain no real settled events, so collection makes future
calibration possible but does not qualify thresholds or authorize active compaction.
See the detector contract (Amendment 3) for the full collection rules.

## Additive backend fields and examples

| Record | Fields |
| --- | --- |
| Client / `Attempt` | `backend` effective ID, `backend_descriptor`, direct client `requestCount`/`responseCount`; persisted `backend_requests`/`backend_responses` |
| `compactions.jsonl` | same fields; hosted retry only: `fallback_from`, `fallback_reason`, `fallback_descriptor` |
| `details.jev` | same fields plus existing effective `model`, `stats`, `budget`, `latencyMs`, `config_hash`, correlation IDs and carry |
| `MarkerData` / custom marker | same display provenance; native association also records `resolution`; charter source counts in `charterStats` |
| `calls.jsonl` | explicit `backend: "local"` or `backend: "typesafe"` on both clients |

Absent optional descriptor/provenance keys are omitted, never set to `undefined`. The existing
`handleCompact` JSON-round-trip validation covers the whole successful result.

```json
{"backend":"local","backend_descriptor":{"id":"local","label":"Local","model":"openjev","where":"http://127.0.0.1:18390","revision":"configured pin"},"model":"openjev"}
```

```json
{"backend":"typesafe","backend_descriptor":{"id":"typesafe","label":"TypeSafe hosted","model":"jev-1.13.0","where":"https://api.typesafe.ai"},"model":"jev-1.13.0","fallback_from":"local","fallback_reason":"timeout","fallback_descriptor":{"id":"local","label":"Local","model":"openjev","where":"http://127.0.0.1:18390"}}
```

Examples omit unrelated saved fields. A future client supplies the same descriptor; the renderer
contains no backend switch. `fallback_descriptor` is finalized as an **additive, JSON-safe optional
source-route descriptor on a hosted retry**, captured from the triggering failed attempt. It has
exactly the same shape and sanitization as `backend_descriptor`; absent keys are omitted. It is
never reconstructed from a model name and never populated for ordinary passes. Older saved entries
may lack it. No routing policy, config key or session migration is introduced.

## Opt-in local decision service

The default backend remains TypeSafe. The Pi hook can instead use a local typed decision
service through the same `CoreAsker` interface. This changes the scorer only: existing pruning,
pin lifetimes, rendering, state fitting and explicit failure choices still apply. A successful
HTTP exchange is not evidence that a model retains the right information; qualify its decisions
with the actual compaction questions before selecting it for live sessions.

For an isolated test, copy the base config and its existing overlay to a scratch directory, then
merge these settings into that scratch overlay. Do not replace the deployed overlay or add these
keys to a base config still read by older Pi sessions:

```toml
[api]
backend = "local"
local_endpoint = "http://127.0.0.1:18341/v1/systemone-local"
local_model = "clm"
timeout_ms = 120000
retry_budget_ms = 120000

[compaction]
max_state_tokens = 1000
max_request_tokens = 2000
```

`local_model` accepts `clm`, `openjev` or `anyjev`; the selected service must actually support that
model. The example port is the local CLM qualification service. Only literal `127.0.0.1` or
`[::1]`, an explicit port and the exact HTTP path above are accepted. The local client neither
reads nor sends `TYPESAFE_API_KEY`, sends no credentials, refuses redirects, caps response bytes
and validates the complete set of typed answers before pruning. Relay admission saturation
(`503 {"error":"decision relay busy"}`) retries within the existing `max_retries` and
`retry_budget_ms`, using the configured capped exponential backoff and jitter. Each HTTP attempt
records its own `calls.jsonl` row, zero-based `retry`, `http_status`, and content-free
`retryable` flag (true only for distinguished admission saturation). No response body is logged. Other HTTP errors (including relay
transport 503 and yield 429) remain one-shot failures. Exhausted retries use the existing
cancel/retry/explicit-native-summary hook policy, unless `fallback =
"typesafe"` is set: then a local service failure (network, timeout or HTTP error, never a bad
answer) first retries the same compaction once on TypeSafe. Local requests from one client run up
to `local_max_inflight` at a time (default 1), in FIFO order, through response validation.
An explicit `local_timeout_ms` remains authoritative for the first dispatch, including queue
waiting. Without it, the deadline is `min(timeout_ms, retry_budget_ms, 180000)`. Retries and
backoff are additionally bounded by `retry_budget_ms` from enqueue time, without shortening
the first dispatch. Requests send the remaining deadline capped at the service's 180000ms,
and reject locally if less than the protocol minimum remains. The first failure drains its queued
burst without further requests after retry exhaustion; a later explicit attempt can use the client again. Queued inputs
are snapshotted, and unsent siblings produce no request telemetry. This bounds each local client;
other clients can still overlap, and fetch cancellation does not prove remote inference stopped.

The local service accepts `{model, state, questions}` with the existing Jev question shape.
It returns `{model, answers}`; every answer includes its matching `type`. `noul` is in `[0,1]`.
For a `score`, indexed probabilities sum to one, the score is their index-weighted expectation,
and confidence is the largest probability minus the mean of the others. `choice` uses named
probabilities and selects a maximum-probability option. Incomplete or inconsistent answers fail.

The generic CLM service checks the complete encoded state and question against its configured
ceiling (2048 by default; separately probed at 4096 in the isolated evaluation) and rejects oversize inputs. The example budgets are estimates used by the existing
state fitter, not a guarantee of tokenizer fit. No extra client truncation or per-question
windowing is used to force acceptance. Oversize rejection cancels unattended compaction; a
usable configuration must fit both the scorer context and Pi's final-context budget. Fixed-rubric
extraction benchmark scores do not qualify this different set of questions.

When the current protected-message floor alone exceeds Pi's budget, the core returns the same
pin-only packet as its prior successful step-6 path without consulting the scorer. Expiry,
instruction duplicates and per-class caps are resolved first. The result honestly records budget
drops, no model answers and zero requests; it can still exceed the guidance budget. Equality and
ordinary under-floor paths continue through normal judgment. An unavailable scorer cannot change
this deterministic result, while failures on paths requiring scores still cancel.

## Live local backend

Live since 2026-09-27: `/compact` asks openjev 27B on a gpu-host (FP16 from the BF16 checkpoint,
TP4 compiled on GPUs 4–7, 40K context, `--http-threads 8`, its own port 18360 outside the evaluation
relays' 18340–18352), with TypeSafe as the automatic fallback. `local_revision` pins the checkpoint:
an answer from any other revision behind the same endpoint and name is refused as a bad answer.

- **Config:** `config/jev.backend.toml`, merged over `jev.toml` and `jev.overlay.toml` by this code
  only. A Pi session that started before the change never reads it and keeps TypeSafe until it
  restarts; that is intended, because older code rejects the new keys. `rm config/jev.backend.toml`
  returns every session to TypeSafe at its next compaction.
- **Transport:** `jev-local-relay.service` (user unit on the client host, `systemd/`) serves
  `http://127.0.0.1:18390` and runs each request as `curl` on the gpu-host over its own persistent ssh
  master (`relay/ssh_exec_relay.py`). The gpu-host refuses ssh TCP forwarding and the service
  listens on loopback only; neither is changed. At most 8 requests in flight across all sessions: one
  more gets a fast 503, so an overlapping compaction falls back to TypeSafe at once.
- **Cost:** a real compaction is not like the benchmarks. Production compactions (hosted Jev,
  2026-09-24..27) cover a median 438K-token session in 9–17 requests of ~28K tokens and ~42
  questions each; TypeSafe answers in ~1.1 s. Six real sessions' first compactions replayed on today's
  code: three resolve with no model request at all (the pinned floor exceeds the budget, ~0.07 s); the
  other three take 45.6 s (440K tokens, 12 requests), 55.9 s (428K, 3) and 80.4 s (436K, 16). In the
  436K case prefix caching already serves 98.5% of the 14.3M prompt tokens, and the
  remaining ~212K tokens (each question's own ~290) are compute-bound on 4×V100. Measured and rejected:
  16K-token scheduler steps, single-flight prefill of shared states, block padding of large states
  (33/737 decisions flipped). Kept: a 64-thread helper pool (`SHIM_POOL=64`: 0–11% faster, same decisions).
  Since 2026-09-27 22:27 UTC the service keeps its recurrent-state cache in fp16. That shrinks the cache
  blocks from 784 to 400 tokens, so each question recomputes about half as much of the shared state
  past the last block boundary. It also runs 1Cat's fast paged-prefill attention kernel, rebuilt to accept
  400-token pages (gpu-host `/var/lib/jev-models/kernel-page400/`, loaded by this service only). Live
  replays: 428K first compaction 55.7 → 40.5 s; 440K first/second/third 46.0/136.3/149.3 →
  46.1/88.1/125.6 s. The gain depends on where each session's state length falls against the block size:
  −36% to +4% across five real compactions, −18% in total. Decisions are unchanged within noise.
- **Decisions vs hosted Jev:** on identical requests from three real sessions (1,836 yes/no questions,
  2026-09-27), the local model agrees with hosted Jev on 90% of tool-output and 95% of message
  questions. On tool-call records it agrees on 46%: hosted keeps the call record for 68% of calls,
  local for 15%, so local compactions drop many calls entirely where hosted keeps a call stub. Sizes
  end up close because the budget binds either way. Hosted answers a whole compaction in 0.5–1 s.
- **Rollback:** `git rm config/jev.backend.toml` (every session on this code returns to TypeSafe at its
  next compaction; remove the file, never edit it in place, since an invalid backend file cancels or
  prompts like an invalid `jev.toml`). Then `systemctl --user disable --now jev-local-relay.service` and
  `ssh -O exit -o ControlPath=~/.ssh/sockets/jev-relay-%C <gpu-host>`. The decision service on the
  gpu-host can stay up; nothing else uses its port.
- **Measure:** `scripts/replay-local.mts <transcript.jsonl> <contextWindow> --endpoint
  http://127.0.0.1:18390/v1/systemone-local [--inflight N] [--dump out.jsonl]` replays a session's real
  compactions through `handleCompact` against the local service only (the hosted fallback is forced off).

## Public evaluation adapters

Run `scripts/external-bench.py` against cleaned LongMemEval-S for blind evidence retention,
or `scripts/compactbench-eval.py` with a pinned CompactBench checkout for its native scoring.
Both invoke this package's actual `compactSpan` through `external-compact.mts`. Future questions,
gold answers, evidence labels and semantic answer-session IDs never enter the compactor.
LongMemEval evidence recall is a diagnostic; it is **not** the official QA score.

Create a separate Python environment with the pinned CompactBench package, `tiktoken`, `openai`,
`pytest` and `pytest-asyncio`; it does not alter the serving environment. The September evaluation
pins CompactBench to `b2bb0e2254010e7842801b9101e56fd9a6542615` and cleaned LongMemEval to
`98d7416c24c778c2fee6e6f3006e7a073259d48f`. Commands run from the package root:

```sh
python scripts/external-bench.py \
  --dataset "$DATASET" --dataset-revision "$DATASET_REVISION" \
  --model openjev --endpoint http://127.0.0.1:18346/v1/systemone-local \
  --budget 16000 --per-type 2 --timeout-ms 120000 \
  --state-tokens 2000 --request-tokens 3500 --output "$NEW_OUTPUT"

python scripts/compactbench-eval.py \
  --method "$PWD/scripts/external-bench.py:OpenJevCompactor" \
  --suite elite_practice --benchmarks "$COMPACTBENCH/benchmarks/public" \
  --endpoint openjev=http://127.0.0.1:18346/v1/systemone-local \
  --reader-url "$READER_URL" --reader-model "$READER_MODEL" \
  --reader-host "$READER_HOST" --reader-unit "$READER_UNIT" \
  --budget 500 --output "$NEW_OUTPUT"
```

Use `CLMCompactor` or `AnyJevCompactor` with their matching endpoint to compare the other
backends. Run `built-in:null`, `built-in:oracle` and `built-in:truncate-last-n` with the same
reader, suite and seed as controls. These are public practice runs, not a ranked submission.
The local reader uses ordinary chat completions, disabled thinking, one concurrent request,
no prompt log-probabilities, no automatic retry and no generative compaction.

Later CompactBench cycles receive only newly arrived turns and the actual retained carry;
previously dropped content cannot be recovered from upstream's original transcript. Source IDs
are tracked by position, so duplicate text in different roles cannot inflate evidence recall.
Output is not clipped to the benchmark cap: an oversized artifact invalidates the run.
Pi's requested budget remains its existing chars/4 guidance policy; overruns are reported.
Protected-message floors are measured separately from model quality.

For an SSH-relay evaluation, explicitly set `PI_JEV_EXTERNAL_TRANSPORT_UNIT` to its running user
unit (for example, an isolated evaluation relay unit). This binds its process, command hash
and Python source hashes before/after. Without this variable, transport provenance is absent;
a `transportRuntimeUnchanged` gate alone does not establish it.

Each output has an `.identity.json` receipt with source/configuration/package identities,
backend health/readout/precision/context limit, complete pinned upstream source hashes,
reader process identity, and output/trace hashes. Matching start/end identities and completion
gate qualification. This does not prove every intervening request had that identity, model
repeatability or budget compliance. The operator must supply the actual reader host/unit that
serves the URL. Evaluation telemetry goes beside the results, never to the normal Jev ledger.

The isolated test services were separately probed at a 4,096-token ceiling before using the
larger scorer budgets above. A client estimate is not proof of tokenizer fit or quality at that
length; service-side oversize rejection remains fail closed. Keep transient evaluation services
separate from Pi's live configuration until native continuation quality is qualified.

## Recorded local comparison

The corrected public-practice runs completed 20 CompactBench cases × 3 carry-forward cycles:
CLM-8B scored 0.68139, OpenJev-4B FP16/eager 0.70000, AnyJev/Qwen3-8B 0.70306,
and the separately capped AnyJev/Qwen3-14B SDPA/2K profile 0.69306.
Every arm passed all recorded identities and had zero guidance-budget overruns.
OpenJev SDPA/batch4 also scored 0.70000, with total core time 184.7s versus 211.8s for eager/batch1.
The profiles produced matching packets in 57/60 cycles; the remaining three belonged to one
entity-confusion case with the same native score. The throughput probe is not bitwise equivalence.

The loaded Qwen3-14B AnyJev profile is separately capped at 2048 tokens: complete 2047-token
cyclic prompts passed on one V100 at 29.20 GiB peak allocation, whereas 4095-token eager and
SDPA typed prompts exhausted memory. Choose its endpoint explicitly; its backend ID is still
`anyjev`, so the ID alone does not establish checkpoint or capacity. Match the configured
endpoint to its recorded checkpoint, capacity and numerical execution profile.

Six synthetic scenarios × five uncached repeats preserved all 50 required facts for both new
profiles. OpenJev SDPA/batch4 reduced source text by 80.17%; AnyJev-14B SDPA/2K by 89.48%.
Both passed installed Pi apply/reopen and failed-endpoint journal-preservation checks. These are
bounded regressions. All twelve-history LongMem arms remain unqualified: nine packets followed
the deterministic over-floor rule and three exceeded the 120-second deadline. No default is changed.

The referenced [pi-system-one](https://github.com/iamaamir/system-one/tree/921d86dc45a22e4939888532344f8e25e466262a/pi-system-one)
registers a decision tool rather than a compaction hook. Its unmodified upstream core provider,
using its supported `path: '/v1/systemone-local'` override, validated boolean, choice and ordinal
responses from all three local backends. This checks the string-instruction subset, not every
upstream JSON-instruction variant or the plugin's default endpoint configuration. Its 55 core
and 161 extension tests passed in the isolated reference environment; Node required the existing
Pi TypeScript loader and the mocked-stall tests required an explicit test-process liveness timer.

Evaluated as an alternative on 2026-09-29: pi-system-one has no compaction hook, and its
tested local server, Reflex (Qwen3.5-4B), fits only ~8K-token states on a V100. Capped to 6K it found 71
of 102 later-used references against 73 for the live local model and 79 for hosted Jev, with 12% fewer
references per token kept. Not adopted.

Installed on 2026-09-29 as a judge tool next to pi-jev (not for compaction): `npm:pi-system-one@1.2.3`
in the Pi settings file, with `SYSTEM_ONE_BASE_URL=http://127.0.0.1:18392`,
`SYSTEM_ONE_MODEL=openjev` and `SYSTEM_ONE_TIMEOUT_MS=30000` exported into the Pi environment
(for example from a profile or a secrets file sourced by the shell that starts Pi). The plugin posts to
`/v1/systemone` and does not pass the core's `path` option, so it goes through a second relay unit,
`jev-local-relay-systemone.service` (`--systemone-path`, 2 in flight, `systemd/`), which forwards
that path to the service's `/v1/systemone-local`; `jev-local-relay` (18390) is unchanged. To remove:
`systemctl --user disable --now jev-local-relay-systemone.service`, drop the settings entry and the
`system-one.env` file.

## Rollout

This is a two-commit rollout, because the previous code is strict: its validator rejects any
unknown key inside `[compaction]` and *requires* the `[budget]` table, and either problem makes it
treat the config as invalid and run Pi's built-in summary automatically. `compaction.prompt_timeout_ms`
is therefore optional in the new schema, and the committed config omits it while keeping `[budget]`,
so the old code and the new code both load the same file.

1. **Land the code with the compatible config** (this commit): new schema, optional
   `prompt_timeout_ms` absent, `[budget]` present and ignored by the new code.
2. **`/reload` (or restart) every running Pi session.** A session keeps the extension it loaded;
   until it reloads, the old code is still live.
3. **Verify.** Every new `compactions.jsonl` row must carry `"policy":"no-fallback"`, a marker only
   the new code writes; a row without it came from a session still on the old code. Also verify one
   compaction per session shape: TUI prompts on a failure, headless cancels, RPC cancels without a
   prompt until `prompt_timeout_ms` is added.
4. **Follow-up commit:** add `prompt_timeout_ms` to `config/jev.toml` and remove the `[budget]`
   table. The new code ignores `[budget]`, so removing it is safe once no old session is left.

## Rollback

Rollback is **not clean, and roll-forward is preferred**: reverting to the old code restores the
daily Jev cap and the automatic native fallback this change removes, which the operator rejected.
If a revert is unavoidable:

1. Remove `prompt_timeout_ms` from `config/jev.toml` **first**; the old validator rejects it.
2. Keep the lifted cap values in `[budget]` (`daily_requests`, `daily_input_tokens`); re-add the
   table if step 4 above removed it.
3. `git -C <the repository that ships this package> revert -m 1 <the jev-native merge commit>`
4. `cd pi-jev && npm ci --prefer-offline`, which restores the wrapper's
   `@alexlikevibe/pi-jev` dependency.
5. `/reload` (or restart) each running Pi session. Sessions keep the extension they loaded until
   then.

Sessions compacted natively keep `details.jev`. The wrapper reads only their file lists and treats
the summary as text, so nothing is lost beyond the pin chain.


## Cache-aware controller and persisted tiers (development, not activated)

The independent optional `config/jev.controller.toml` is **shadow** with layout enabled in this
branch. Old sessions ignore it, so base/overlay/detector schema and values are unchanged.
Off/absent/malformed disables only new layout/controller; the existing detector still behaves
according to its own mode. Both controller and detector must be active to request automatically
under the new policy. Shadow evaluates and logs nullable cost intervals but never arms requests.
The normal explicit `/compact` and native emergency retain their budgets/failure behavior.

After normal pruning/charter retirement, currently retained atoms acquire persistent occurrence
IDs and byte history. Maximal contiguous stable/semi prefixes preserve chronology and tool pairs;
they never pin or resurrect removed content. Promotion needs consecutive committed appearances
and exact rendering/semantic identity. Added metadata is bounded, hashes/offsets only; older carry
and v1 charter records remain readable. Invalid history is discarded independently of content.
Layout overflow or incompatible optional provenance uses correct legacy rendering. Format 3 uses
an invariant preamble and per-atom separators: stable/semi/volatile classes remain in metadata,
not moving model-visible headings. Promotion alone changes no summary bytes. Wrapper budgeting
includes separators for charter/directive/chain/file atoms as well as the engine's carry separators.
Old offsets validate only against their own saved summary; charter reconstruction/restoration stay
summary-owned. The format-2→3 render-key transition resets aging for one cold cycle. First layout
transition/rebuild is accounted cold, not asserted to preserve a real provider cache.

The provisional working ceiling is 0.35 of the model window; opportunity/reset are 0.60/0.50
of that ceiling, with separate native reserve and 0.02 safety share. Invalid reserve intersection
fails closed for the new automatic policy. Pricing comes from nullable runtime ModelCost or
validated **exact provider/id/api** profiles, never auth/subscription/vendor heuristics. Unknown
prices/cache capability/expiry/decision overhead remain unknown. Monetary-only compaction needs
worst-case savings; quality/headroom may override economics but never the complete-boundary
warrant, pairing, fresh owned reduction/headroom gate or failure/no-op suppression. Excursions
expire at configured request/time bounds, never renew while above-band. Protected-floor target
failures are recorded and anchored to fresh provider usage before growth rearm.

Configuration and the unselected 272K/2x/372K operator example are recorded with the initial
policy in `config/jev.controller.toml` and its `evidence` reference. Offline raw fixtures,
results and caveats live in the cache-controller evaluation notes kept beside that provenance
record.

### Future activation / rollback (parent-owned gates)

1. Resolve the OPEN economic-arming and progressing-carry layout architecture blockers recorded
   with the cache-controller evaluation notes; the recovery acceptance
   probe currently exits 1. Then obtain artifact-bound cross-vendor source review and a fresh
   independent prover receipt. Green ordinary regressions alone do not authorize acceptance.
2. Separately authorize integration/publication/deployment of compatible code; this work does none.
3. Select only exact-route profiles with verified prices/cache evidence; inspect sibling validation.
4. Separately authorize controller shadow→active with existing detector active, then reload the
   affected consumers using the owning deployment procedure. Verify an owned request/end and
   measured-after attribution before claiming live activation. Layout enablement is also a live
   config/deployment change, not implied by source tests.
5. Rollback new behavior by sibling `mode="off"` or removing it. To stop **all** additional
   automatic requests, also turn the existing detector off. Reload expires pending host requests;
   never clear them in an input hook. Next compaction uses legacy rendering; carry/charter stay
   readable, no sessions are deleted/migrated, and the transition may be cold. Code revert follows
   disablement and separate authority, never a historical summary rewrite.
