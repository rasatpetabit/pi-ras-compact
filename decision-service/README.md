# Local compaction decision service

This is the server behind pi-jev's local backend (`config/jev.backend.toml`): a gpu-host unit
`openjev-decision-service`, port 18360, reached from the client-host through `jev-local-relay.service`
(`../relay/ssh_exec_relay.py`). The files here were copied byte-identical from the running release
(`/var/lib/jev-models/release-candidates-v11/` on the gpu-host: server.py 45eb48d1,
candidates.py 5c7f25c3, clm_schema.py 52cec58a). They were copied on 2026-09-28 from the retired
pi-smart-compact prototype, which is deleted; nothing depends on it. The gpu-host launcher is
`deploy/serve_openjev27.sh` (copy of `overnight/serve_openjev27.sh` there). Since bba354b7 server.py
and candidates.py also take `--readout-perms N` (ojv27 only, 1..4): the frozen helper's own
`READOUT_PERMS`, averaging each question over N option letterings (2 = both orders of a yes/no).
The default, 1, behaves exactly as the release; `/health` reports the value as
`artifacts.ojv_readout_perms` (the helper's `helper_version` string is built at import and still
says `perms:1`).

This evaluation service generates scores, never summary prose. It binds to literal loopback. Run it in a separate inference environment; the Pi packages communicate over HTTP. No model/runtime packages are installed by the service.

Two contracts are deliberately separate:

- `POST /v1/systemone`: the strict-extractive evaluation contract, fixed retention question, exact candidate IDs, answers `{type:"noul", value: number}`. This is not the public System One wire format.
- `POST /v1/systemone-local`: typed questions for the existing `pi-jev` local client, supported by CLM, OpenJev and AnyJev. Questions use `instructions` and optional `criteria`; answers use `noul` or the expected level `score`, indexed probabilities and confidence. Complete inputs exceeding the backend token limit are rejected. Generic staleness questions are never reduced over source windows.
- `POST /tokenize`: `{text}` returns the tokenizer count. `--backend tokenizer` runs this separately on CPU so measurement does not wait behind inference.
- `GET /health`: exact checkpoint revision, implementation SHA256, pinned artifact identities, cache status, dtype, startup duration and allocated GPU memory.

The fixed retention path partitions an overlength source into complete, contiguous character windows under the real tokenizer limit, scores every window, and uses their maximum to rank the whole original block. It never truncates the retained block. Limits: 128 candidates/request, 64 windows/candidate, 256 windows/request, 2MB request body. Scores are ranking signals, not calibrated probabilities of safe deletion. The typed endpoint does not use this windowing policy.

The `X-Request-Timeout-Ms` header gives the remaining request budget, up to 180000ms; without it the budget is 20000ms. Source windowing probes at most 4096 characters at once and checks deadlines before tokenization and between forward passes. Oversized task and typed-state workloads are rejected before tokenization. A forward pass already running cannot be preempted. Clients must also enforce their own total deadline and cancel compaction on failure.

## Pinned inputs used in the V100 evaluation

| Input | Revision |
|---|---|
| `Qwen/Qwen3-8B` encoder | `b968826d9c46dd6066d109eabc6255188de91218` |
| `Contrastive-LM/CLM-v0.1-8B`, `CLM_v0.1-8B.pt` | `e939398d4556fcd9400c76fa8c5a513202f42b0a` |
| `AlexWortega/openjev`, `qwen3.5-4b-nli-v5` directory | `058a6c24911b46d908fbe23541390f8af3df3e4d` |
| AnyJev library | `45add301a7aa60ed3420c83d15c061e84e5bce61` |
| CLM schema reference | `bb42c6c5bf914fd449bed2f6ca65be80602cb1f7` |

`clm_schema.py` is an unchanged copy of `src/clm/schema.py` from [Contrastive-LM/CLM](https://github.com/Contrastive-LM/CLM/tree/bb42c6c5bf914fd449bed2f6ca65be80602cb1f7), licensed Apache-2.0; see `CLM-LICENSE`. The adapter follows its trained heads, normalization and readout. The reference runtime measured here was PyTorch 2.10.0+cu128 and Transformers 5.17.0 on V100-SXM2-32GB. Those versions are observations, not a dependency resolver or a guarantee for other installations.

Example with already downloaded, pinned checkpoints:

```sh
CUDA_VISIBLE_DEVICES=0 python server.py --backend clm --port 18341 \
  --model-path /models/Qwen3-8B \
  --head-path /models/CLM-v0.1-8B/CLM_v0.1-8B.pt \
  --dtype float16 --max-tokens 2048 \
  --revision e939398d4556fcd9400c76fa8c5a513202f42b0a \
  --encoder-revision b968826d9c46dd6066d109eabc6255188de91218 --no-cache
```

Use `--no-cache` for independent GPU-repeat measurements. Otherwise CLM caches bounded CPU embeddings; a repeated warm request does not measure a fresh forward pass. For OpenJev use `--backend openjev` and its model directory; FP32 and FP16 runs must be recorded separately. CLM typed questions follow the upstream trained schema. OpenJev defaults to `--openjev-readout upstream-entailment`: canonical option hypotheses and normalized entailment probabilities from the pinned author adapter. Two deliberate differences preserve the local contract: very small probabilities are normalized in log space, and oversized typed states are rejected instead of windowed. `--openjev-readout experimental-odds` retains the separately measured direct-boolean/log-odds variant. The effective mode is recorded in `/health` artifacts; its probability thresholds are not interchangeable with the upstream mode.

OpenJev accepts `--openjev-batch-size 1..4` (default `1`). Larger batches right-pad complete prompts and read each row at its last non-padding position; prompts are never shortened. The batch size is recorded in `/health`. A bounded iterator avoids materializing an entire expanded question workload. Keep batch size `1` as the reference profile; qualify another size separately for the target checkpoint, dtype and hardware.

On one isolated V100-SXM2-32GB, the pinned FP16 checkpoint completed a 20-prompt, mixed-length probe (43–3220 tokens) in 10.410 seconds at batch 1 and 6.140 seconds at batch 4, a 1.695x speedup. Batch 4 peaked at 15,265,720,832 allocated bytes. Its maximum entailment-probability difference from batch 1 was 0.000159, with no boolean changes at the predeclared 0.4, 0.5, 0.6, 0.65 and 0.8 thresholds. These are numerical/throughput measurements, not a compaction quality score or bitwise equivalence. The public-history application probe still failed through the overlapping SSH transport and does not qualify batch 4 for deployment. Receipt: `/var/lib/jev-models/results/openjev-v4-batch-probe.json` on the gpu-host.

OpenJev also accepts `--openjev-attention eager|sdpa` (default `eager`). The selected path is recorded in `/health`; the adapter installs no CUDA packages. The same 20-prompt V100 probe measured SDPA at batch 4 in 3.681 seconds versus 10.411 seconds for eager batch 1 (2.828x), with 12,515,352,576 peak allocated bytes, a maximum probability delta of 0.000159 and no flips at the five declared thresholds. This is a numerical execution profile, not a public compaction quality result. Receipt: `/var/lib/jev-models/results/openjev-v4-sdpa-probe.json`. The constructor uses the documented [Transformers attention interface](https://huggingface.co/docs/transformers/en/attention_interface).

`--openjev-shared-prefix on` (default `off`) prefills the token-level common prefix of a typed request's complete hypothesis prompts once and scores the suffixes as branched cached continuations in groups of `--openjev-prefix-group` (1..32, default 8), following the author's merged `_pooled_hypotheses` recipe. Prompts are still tokenized whole and bounded before any forward; a request without two prompts sharing a token falls back to the batched path, and health records both settings. On the frozen 12-request pi-jev capture (237 hypotheses) the FP16 SDPA/batch4 V100 profile took 29.36 s and shared-prefix g8 12.54 s (2.34x), with a maximum probability delta of 0.0034 against batch4 and 0.0027 against unpadded batch 1, no label flips and byte-identical repeats. This is a numerical/throughput measurement; qualify it through the consumer harness before changing a deployed profile. Receipt: `/var/lib/jev-models/optimization-v10-openjev-prefix/comparison.json` on the gpu-host.

AnyJev uses the actual pinned library (`PYTHONPATH` to its checkout), L0 cyclic permutations, no prior, no adaptation and no shared-prefix caching. The preferred isolated path is `--backend anyjev --model-path /models/Qwen3-8B --dtype float16`. It uses the library's Transformers backend with batch size one and final-position vocabulary logits only; there is no text generation or production inference dependency. Complete prompts are checked before inference and never truncated. Typed boolean, choice and ordinal questions use AnyJev's corresponding constructors; ordinal answers preserve the expected level.

For isolated AnyJev, `--anyjev-attention eager|sdpa` selects the Transformers attention implementation, with `eager` unchanged as the default. Health metadata records the selection. The option does not change cyclic permutations, prior correction, final-position readout or caching. Selecting SDPA with the remote vLLM path is rejected, since the adapter cannot control that server. Qualify complete typed prompts as well as windowed fixed-rubric inputs: Qwen3-14B loaded on one V100, but a 4095-token typed request exhausted memory under eager attention. A short or windowed request is not proof of full-context capacity. The same 4095-token typed request also exhausted memory with SDPA. At a separately declared 2048-token cap, SDPA completed both 2047-token cyclic prompts in 3.391 seconds, peaking at 31,350,392,832 allocated bytes (29.20 GiB); This qualifies the measured 2K capacity probe only, not a 4K profile. Through the companion pi-jev consumer, this profile completed 20 public-practice cases × three cycles at score 0.69306 versus 0.70306 for AnyJev-8B; all six synthetic scenarios × five repeats retained required facts. More parameters did not improve this bounded public score.

The optional `--source-url` path reads exact teacher-forced `prompt_logprobs` from a dedicated OpenAI-compatible server, with serial requests. Do not point this evaluation path at a production replica: prompt-logprob prefill can allocate much more memory than ordinary completion traffic. In the V100 evaluation, two 646-token requests exhausted the production Qwen replica's available memory and triggered its automatic restart. The subsequent test allocation uses an isolated Qwen3-8B model instead.

The transport from the client-host is `../relay/ssh_exec_relay.py` (SSH command execution to fixed loopback
ports; no TCP forwarding). It is not an authenticated network deployment and stays loopback-only.

```sh
python3 -m unittest -v test_server
```

Model quality must be measured through the consumer's actual question and selection policy. A fixed-rubric benchmark pass does not qualify the existing `pi-jev` typed-question policy or establish real-session fact recall. Keep backend activation opt-in until that separate evaluation passes.

For concurrent evaluation, use separate loaded instances or serialize clients against each instance. Keep the service source snapshot fixed for a matrix, capture `/health` before and after, and invalidate runs spanning an implementation or checkpoint change. Manage long-running evaluation processes with the host service manager; do not install dependencies into an existing production inference environment.

## Candidate backends (`candidates.py`)

`--backend zcjev|ojv27|laya|dgemma` loads an additional decision model for evaluation. Each backend wraps
the author's own inference code, with only the overrides V100 (SM70) needs recorded in `/health` artifacts,
and every answer passes through `candidates.canonical`, which presents it in the exact shape the pi-jev
local client validates and fails closed on malformed distributions. `--wire-model` sets the model name
clients must send and the name reported as the health `backend`.

- `zcjev`: Zefan-Cai/Open-Jev LoRA + scalar-head checkpoints via `jev.serving.load_predictor`, FP16 instead
  of BF16. The upstream 4096-token `max_length` is kept, and longer inputs are rejected, not truncated.
- `ojv27`: openjev/openjev with the frozen `helper/shim.py` unmodified; only its client is replaced by an
  in-process 1Cat-vLLM AsyncLLM (`--tp`, `--max-model-len`, `--gpu-util`, `--enforce-eager`, `--engine-args`).
- `laya`: convaiinnovations/laya-typed-decisions. `--laya-guard state` (default) rejects any request whose
  state would be truncated to fit the encoder window.
- `dgemma`: google/diffusiongemma-26B-A4B-it through Transformers `DiffusionGemmaForBlockDiffusion`, driving
  the razorback-openjev engine unmodified (`--device-map`, `--max-memory`).

For openjev 27B FP8 on 4×V100, TP4 with compiled graphs
(`VLLM_SM70_SYNC_BEFORE_COMPILE_GRAPH_FORWARD=1`, dedicated GPUs) was the fastest qualified configuration.
Sharing a GPU with another process stalled compiled mode at TP2.
