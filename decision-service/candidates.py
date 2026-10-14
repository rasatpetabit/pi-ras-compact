"""Additional local decision backends for the evaluation lane.

Each backend exposes the same surface server.py expects from a scorer:
  answer(state, questions) -> {qid: typed answer}  (noul / choice / score, TypeSafe-shaped)
  deadline attribute (set per request by the HTTP layer), artifacts dict for /health.
Each wraps the author's own inference code unmodified wherever possible; the only overrides
are the ones V100 (SM70) requires, and each is recorded in artifacts:

  zcjev  Zefan-Cai/Open-Jev (MIT code, Apache-2.0 packages): jev.serving.load_predictor over a
         LoRA + scalar-head checkpoint. Overrides: FP16 instead of hard-coded BF16 (SM70 has no BF16
         tensor cores); base model read from a pinned local snapshot via a shadow model.json.
  ojv27  openjev/openjev (CC-BY-NC-4.0 weights, Apache-2.0 helper): the frozen helper/shim.py
         (sha 81a22f1b...) loaded unmodified; only shim.client is replaced by an in-process 1Cat-vLLM
         AsyncLLM that answers the helper's single TARGETED call (logprob_token_ids), exactly as the
         author's own shim_mlx.py does for MLX. Calibration constants from serve/SERVE.md.
  laya   convaiinnovations/laya-typed-decisions via the laya package. Guard 'state' (default)
         rejects any request whose state would be truncated to fit the encoder window.
"""
from __future__ import annotations
import asyncio, hashlib, importlib.util, json, math, os, sys, threading, time, types
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BACKENDS = ("zcjev", "ojv27", "laya", "dgemma")

def _deadline_check(obj):
    if time.monotonic() > getattr(obj, "deadline", math.inf):
        raise TimeoutError("scoring work deadline exceeded")

def _tree_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    for file in sorted(p for p in path.rglob("*") if p.is_file()):
        digest.update(str(file.relative_to(path)).encode() + b"\0")
        with file.open("rb") as stream:
            for block in iter(lambda: stream.read(1 << 20), b""):
                digest.update(block)
    return digest.hexdigest()

def _file_sha256(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class ZCJev:
    def __init__(self, source, checkpoint, base_path, dtype, max_tokens, batch_size, prefix_cache, shadow_root):
        sys.path.insert(0, str(source))
        import torch
        import jev.model as jm
        from jev.serving import load_predictor
        want = getattr(torch, dtype)
        real = jm.AutoModelForImageTextToText

        class _Loader:
            @staticmethod
            def from_pretrained(*args, **kwargs):
                if "quantization_config" in kwargs:
                    raise ValueError("quantized loading is not part of this profile")
                kwargs.pop("torch_dtype", None)
                kwargs["dtype"] = want
                return real.from_pretrained(*args, **kwargs)
        jm.AutoModelForImageTextToText = _Loader

        checkpoint = Path(checkpoint); base_path = Path(base_path)
        cfg = json.loads((checkpoint / "model.json").read_text())
        shadow = Path(shadow_root) / f"{checkpoint.parent.parent.name}-{_file_sha256(checkpoint / 'model.json')[:12]}"
        shadow.mkdir(parents=True, exist_ok=True)
        for name in ("adapter", "head.pt", "temperature.json"):
            link = shadow / name
            if not link.exists():
                link.symlink_to(checkpoint / name)
        (shadow / "model.json").write_text(json.dumps({**cfg, "model_id": str(base_path)}, indent=2) + "\n")
        self.predictor = load_predictor(checkpoint=str(shadow), max_length=max_tokens, batch_size=batch_size, prefix_cache=prefix_cache)
        self.max_tokens = max_tokens
        self.artifacts = {
            "typed_readout": "zefan-openjev-lora-scalar-head",
            "zc_package": checkpoint.parent.parent.name,
            "zc_checkpoint_sha256": self.predictor.provenance.get("checkpoint_sha256"),
            "zc_code_commit": self.predictor.provenance.get("code_commit"),
            "zc_base_model": cfg["model_id"], "zc_base_revision": cfg["revision"],
            "zc_temperature": self.predictor.temperature, "zc_max_length": max_tokens,
            "zc_batch_size": batch_size, "zc_prefix_cache": bool(prefix_cache),
            "dtype_override": dtype, "reference_dtype": "bfloat16",
        }

    def answer(self, state, questions):
        _deadline_check(self)
        out = self.predictor.predict({"state": state, "questions": questions})
        _deadline_check(self)
        return out["answers"]


class _Obj(types.SimpleNamespace):
    pass


class OJV27:
    # Concurrent answer() calls are safe: each question is its own engine request, the helper's
    # fan-out pool is shared, and the engine batches across requests.
    concurrent_safe = True
    SERVE_ENV = {"READOUT_T": "0.85", "READOUT_NOUL_T": "1.829074", "READOUT_NOUL_BIAS": "0", "READOUT_TARGETED": "1",
                 "READOUT_INSTR_STYLE": "pyrepr", "SHIM_STAGGER": "1", "SHIM_POOL": "16"}
    HELPER_PREFIX = "81a22f1b"

    def __init__(self, helper, model_path, tp, max_model_len, gpu_util, max_tokens, enforce_eager=False, engine_extra=None,
                 perms=1):
        # perms > 1: the helper's own READOUT_PERMS, averaging each question over that many option letterings
        # (yes/no read both ways round at 2). Costs one extra question pass per lettering; the state stays cached.
        if not (isinstance(perms, int) and 1 <= perms <= 4):
            raise ValueError("perms must be 1..4")
        for key, value in self.SERVE_ENV.items():
            os.environ.setdefault(key, value)
        os.environ["TOKENIZER"] = str(model_path); os.environ["SHIM_MODEL"] = str(model_path)
        helper_sha = _file_sha256(helper)
        if not helper_sha.startswith(self.HELPER_PREFIX):
            raise RuntimeError(f"helper is {helper_sha[:16]}, not the frozen {self.HELPER_PREFIX}")
        from transformers import AutoTokenizer
        from vllm import SamplingParams
        from vllm.engine.arg_utils import AsyncEngineArgs
        from vllm.v1.engine.async_llm import AsyncLLM
        self.tok = AutoTokenizer.from_pretrained(str(model_path))
        self.SamplingParams = SamplingParams
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True, name="ojv27-engine").start()
        engine_args = AsyncEngineArgs(model=str(model_path), tokenizer=str(model_path), tensor_parallel_size=tp, dtype="half",
                                      max_model_len=max_model_len, gpu_memory_utilization=gpu_util, enable_prefix_caching=True,
                                      max_logprobs=64, max_num_seqs=64, trust_remote_code=False, language_model_only=True,
                                      enforce_eager=enforce_eager, disable_log_stats=True, **(engine_extra or {}))
        self.engine = asyncio.run_coroutine_threadsafe(self._make(AsyncLLM, engine_args), self.loop).result()
        self.max_tokens, self.stats, self._n = max_tokens, {"calls": 0, "prompt_tokens": 0}, 0
        self._lock = threading.Lock()
        spec = importlib.util.spec_from_file_location("openjev_shim", str(helper))
        shim = importlib.util.module_from_spec(spec); spec.loader.exec_module(shim)
        shim.client = _Obj(chat=_Obj(completions=_Obj(create=self._create)), base_url=f"vllm-inproc://{Path(model_path).name}")
        shim.PERMS = perms
        if not (shim.TARGETED and shim.PERMS == perms):
            raise RuntimeError(f"helper must run TARGETED with PERMS={perms}")
        shim.letter_ids()
        self.shim = shim
        self.pool = ThreadPoolExecutor(max_workers=int(os.environ["SHIM_POOL"]))
        self.artifacts = {"typed_readout": "openjev-letter-targeted", "helper_sha256": helper_sha, "helper_version": shim.MODEL_STRING,
                          "ojv_model_directory": Path(model_path).name, "ojv_tp": tp, "ojv_max_model_len": max_model_len,
                          "ojv_prefix_caching": True, "ojv_serve_env": {k: os.environ[k] for k in self.SERVE_ENV}, "dtype": "half",
                          "ojv_enforce_eager": bool(enforce_eager), "ojv_engine_extra": engine_extra or {},
                          "ojv_readout_perms": perms}

    @staticmethod
    async def _make(cls, engine_args):
        return cls.from_engine_args(engine_args)

    async def _generate(self, prompt_ids, want):
        with self._lock:
            self._n += 1; rid = f"ojv-{self._n}"
        params = self.SamplingParams(max_tokens=1, temperature=0, allowed_token_ids=list(want), logprob_token_ids=list(want))
        final = None
        async for out in self.engine.generate({"prompt_token_ids": prompt_ids}, params, rid):
            final = out
        return final

    def _create(self, model=None, max_tokens=1, temperature=0, logprobs=False, messages=None, extra_body=None, **kw):
        """The helper's TARGETED call. Returns log-softmax values (full vocabulary, before the allowed-token
        mask) for exactly the candidate ids, as `token_id:<id>` entries, like the author's MLX stand-in."""
        _deadline_check(self)
        eb = extra_body or {}; want = eb.get("logprob_token_ids")
        if not want or not messages or not isinstance(messages[0]["content"], str):
            raise ValueError("in-process stand-in serves text-only TARGETED prompts")
        if (eb.get("chat_template_kwargs") or {}).get("enable_thinking") is not False:
            raise ValueError("thinking must be disabled")
        ids = self.tok.apply_chat_template(messages, tokenize=True, add_generation_prompt=True, enable_thinking=False)
        if hasattr(ids, "input_ids") or isinstance(ids, dict):
            ids = ids["input_ids"]
        if len(ids) > self.max_tokens:
            raise ValueError(f"input has {len(ids)} tokens, limit {self.max_tokens}; no truncation performed")
        out = asyncio.run_coroutine_threadsafe(self._generate(list(ids), want), self.loop).result()
        step = out.outputs[0].logprobs[0]
        vals = []
        for token_id in want:
            entry = step.get(token_id)
            vals.append(None if entry is None else float(entry.logprob))
        with self._lock:
            self.stats["calls"] += 1; self.stats["prompt_tokens"] += len(ids)
        top = [_Obj(token=f"token_id:{i}", logprob=v) for i, v in zip(want, vals) if v is not None]
        return _Obj(choices=[_Obj(logprobs=_Obj(content=[_Obj(top_logprobs=top)]))], usage=_Obj(prompt_tokens=len(ids)))

    def answer(self, state, questions):
        """The helper's /v1/systemone handler body, minus HTTP: same stagger rule, same thread-pool fan-out."""
        _deadline_check(self)
        shim = self.shim
        if state is None or not isinstance(questions, dict) or not questions:
            raise ValueError("state and a non-empty questions map are required")
        for qid, q in questions.items():
            if not isinstance(q, dict) or q.get("type") not in shim.ANSWER:
                raise ValueError(f"questions.{qid}.type must be one of choice, score, noul")
        state_text = shim.with_image(state)
        if getattr(state_text, "image", None):
            raise ValueError("image states are not part of this profile")
        items = list(questions.items())
        f = lambda it: (it[0], shim.ANSWER[it[1]["type"]](state_text, it[1]))
        stagger = shim.H.STAGGER and len(state_text) >= shim.H.STAGGER_MIN_CHARS
        try:
            results = ([f(items[0])] + list(self.pool.map(f, items[1:]))) if stagger else list(self.pool.map(f, items))
        except shim.BadQuestion as error:
            raise ValueError(str(error))
        _deadline_check(self)
        return {qid: answer for qid, (answer, _) in results}


class Laya:
    def __init__(self, source_path, model_path, guard):
        if guard not in ("state", "none"):
            raise ValueError("laya guard must be state or none")
        sys.path.insert(0, str(source_path))
        import laya, laya.agent as agent
        original = agent.build_sequence

        def guarded(tok, state, q, max_len=512, head_max_len=192, **kwargs):
            if guard == "state":
                full, _ = original(tok, state, q, 10 ** 9, head_max_len, **kwargs)
                if len(full) > max_len:
                    raise ValueError(f"input needs {len(full)} tokens, Laya window {max_len}; no truncation performed")
            return original(tok, state, q, max_len, head_max_len, **kwargs)
        agent.build_sequence = guarded
        self.agent = laya.load(str(model_path), device="cuda:0")
        self.guard = guard
        self.artifacts = {"typed_readout": f"laya-typed-decisions-guard-{guard}", "laya_version": getattr(laya, "__version__", None),
                          "laya_model_sha256": _file_sha256(Path(model_path) / "model.safetensors"),
                          "laya_max_len": self.agent.cfg.get("max_len"), "laya_head_max_len": self.agent.cfg.get("head_max_len"),
                          "laya_dtype": str(getattr(self.agent, "dtype", None)), "laya_option_cap_tokens": 48}

    def answer(self, state, questions):
        _deadline_check(self)
        out = self.agent.predict(state, questions)
        _deadline_check(self)
        answers = out.get("answers", out)
        for qid, q in questions.items():
            a = answers[qid]
            if q["type"] in ("choice", "score"):
                probs = a.get("probabilities") or {}
                total = sum(probs.values())
                if probs and total > 0:
                    a["probabilities"] = {k: v / total for k, v in probs.items()}
        return answers


def canonical(questions, answers):
    """Present every candidate answer in the exact TypeSafe shape the pi-jev local client validates:
    float64 renormalization of the backend's own distribution (fails closed beyond 2e-2), confidence as
    top - mean(rest), score as the expected level, choice as the argmax. Never changes a decision."""
    if set(answers) != set(questions):
        raise ValueError("backend answers do not match the requested questions")
    out = {}
    for qid, q in questions.items():
        a = answers[qid]; kind = q.get("type")
        if not isinstance(a, dict) or a.get("type") != kind:
            raise ValueError(f"backend answer type mismatch for {qid}")
        if kind == "noul":
            p = float(a["noul"])
            if not math.isfinite(p) or not 0 <= p <= 1:
                raise ValueError(f"invalid noul probability for {qid}")
            out[qid] = {"type": "noul", "noul": p}
            continue
        labels = [str(i) for i in range(len(q["criteria"]))] if kind == "score" else list(q["criteria"])
        probs = a.get("probabilities") or {}
        if set(map(str, probs)) != set(labels):
            raise ValueError(f"backend probabilities do not cover the labels of {qid}")
        values = [float(probs[label]) for label in labels]
        total = sum(values)
        if any(not math.isfinite(v) or v < 0 for v in values) or not math.isfinite(total) or abs(total - 1) > 2e-2:
            raise ValueError(f"backend distribution for {qid} is not normalized (sum {total})")
        values = [v / total for v in values]
        top = max(values)
        confidence = top - (sum(values) - top) / (len(values) - 1)
        dist = dict(zip(labels, values))
        if kind == "score":
            legend = a.get("legend") or {str(i): level for i, level in enumerate(q["criteria"])}
            out[qid] = {"type": "score", "score": sum(i * v for i, v in enumerate(values)), "legend": legend,
                        "probabilities": dist, "confidence": confidence}
        else:
            choice = labels[max(range(len(values)), key=values.__getitem__)]
            out[qid] = {"type": "choice", "choice": choice, "probabilities": dist, "confidence": confidence}
    return out

def build(args):
    if args.backend == "zcjev":
        return ZCJev(args.source_path, args.checkpoint, args.model_path, args.dtype, args.max_tokens,
                     args.candidate_batch_size, args.prefix_cache == "on", args.shadow_root)
    if args.backend == "ojv27":
        return OJV27(args.helper_path, args.model_path, args.tp, args.max_model_len, args.gpu_util, args.max_tokens,
                     enforce_eager=args.enforce_eager, engine_extra=json.loads(args.engine_args) if args.engine_args else None,
                     perms=getattr(args, "readout_perms", 1))
    if args.backend == "laya":
        return Laya(args.source_path, args.model_path, args.laya_guard)
    if args.backend == "dgemma":
        return DGemma(args.source_path, args.model_path, args.dtype, args.max_tokens, args.device_map, args.max_memory)
    raise ValueError(f"unknown candidate backend {args.backend}")


class DGemma:
    """razorback16/openjev (Apache-2.0) over google/diffusiongemma-26B-A4B-it BF16 weights through the native
    Transformers 5.17 DiffusionGemmaForBlockDiffusion. The author's backend-agnostic Engine (prompt, canvas,
    slots, labels, re-read policy, seeds, answer shapes) runs unmodified; only the runtime's read() is new and
    mirrors mlx_backend.MlxRuntime.read: prefill (cached by prompt), one decoder pass with no self-conditioning,
    temperature-1 log-softmax per slot, top-k plus every label id. Overrides: FP16 (SM70); steps>1, think and
    images are rejected rather than approximated; non-finite logits fail closed."""

    PROMPT_CACHE_TOKENS = 16384

    def __init__(self, source, model_path, dtype, max_tokens, device_map, max_memory):
        from collections import OrderedDict
        sys.path.insert(0, str(source))
        import torch
        from transformers import AutoTokenizer
        from transformers.models.diffusion_gemma.modeling_diffusion_gemma import DiffusionGemmaForBlockDiffusion
        from openjev import engine as oe
        from openjev.config import Settings
        self.torch, self.oe, self.max_tokens = torch, oe, max_tokens
        self.prefills = OrderedDict()
        tok = AutoTokenizer.from_pretrained(str(model_path))
        kwargs = {"dtype": getattr(torch, dtype), "device_map": device_map or "cuda:0"}
        if max_memory:
            kwargs["max_memory"] = {(int(k) if k.strip().isdigit() else k.strip()): v.strip()
                                    for k, v in (part.split("=", 1) for part in max_memory.split(","))}
        self.model = DiffusionGemmaForBlockDiffusion.from_pretrained(str(model_path), **kwargs).eval()
        placement = {str(v) for v in (getattr(self.model, "hf_device_map", {}) or {}).values()}
        if placement & {"cpu", "disk", "meta"}:
            raise RuntimeError(f"refusing to serve an offloaded model: {sorted(placement)}")
        self.device = next(self.model.parameters()).device
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="dgemma")
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True, name="dgemma-engine").start()
        runtime = self

        class HfEngine(oe.Engine):
            async def think(eng, sys_text, state_text, budget):
                raise oe.SchemaError("think is not part of this profile")

            async def one_read(eng, template, slots, sys_text, content, seed, steps=1, prefix=None):
                if isinstance(content, list):
                    raise oe.SchemaError("images are not part of this profile")
                prompt = prefix if prefix is not None else eng.chat_prompt_ids(sys_text, content)
                if len(prompt) > runtime.max_tokens:
                    raise oe.SchemaError(f"the request is {len(prompt)} tokens; the limit is {runtime.max_tokens}")
                canvas = eng.build_canvas(template, slots, seed)
                async with eng.slots:
                    tops, billed = await asyncio.get_running_loop().run_in_executor(runtime.pool, runtime.read, prompt, canvas, slots, steps)
                return [oe.slot_distribution(top, s["label_ids"]) for top, s in zip(tops, slots)], billed

        self.settings = Settings()
        self.engine = HfEngine(self.settings, tok)
        self.artifacts = {"typed_readout": "diffusiongemma-slot-read", "dgemma_source_commit": _git_head(source),
                          "dgemma_model_directory": Path(model_path).name, "dgemma_canvas": self.settings.canvas,
                          "dgemma_auto_threshold": self.settings.auto_threshold, "dgemma_auto_max": self.settings.auto_max,
                          "dgemma_device_map": sorted(placement) or [str(self.device)], "dtype_override": dtype, "reference_dtype": "bfloat16/nvfp4"}

    def read(self, prompt, canvas, slots, steps=1):
        torch, oe = self.torch, self.oe
        if steps != 1:
            raise oe.SchemaError("only single-step reads are part of this profile")
        _deadline_check(self)
        with torch.inference_mode():
            canvas_t = torch.tensor([canvas], device=self.device)
            key = tuple(prompt); hit = self.prefills.get(key)
            if hit is None:
                out = self.model(input_ids=torch.tensor([prompt], device=self.device), decoder_input_ids=canvas_t)
                self.prefills[key] = (out.past_key_values, len(prompt))
                while len(self.prefills) > 1 and sum(t for _, t in self.prefills.values()) > self.PROMPT_CACHE_TOKENS:
                    self.prefills.popitem(last=False)
            else:
                self.prefills.move_to_end(key)
                out = self.model(past_key_values=hit[0], decoder_input_ids=canvas_t)
            logits = out.logits[0].float()
            rows = torch.stack([logits[s["pos"]] for s in slots])
            if not bool(torch.isfinite(rows).all()):
                raise RuntimeError("non-finite slot logits (FP16 overflow)")
            lp = torch.log_softmax(rows, dim=-1)
            result = []
            for i, s in enumerate(slots):
                keep = sorted(set(torch.topk(lp[i], oe.TOPK).indices.tolist()) | set(s["label_ids"]))
                result.append(dict(zip(keep, lp[i, torch.tensor(keep, device=lp.device)].tolist())))
        return result, len(prompt)

    def answer(self, state, questions):
        _deadline_check(self)
        norm = {qid: {"type": q.get("type"), "instructions": q.get("instructions"), "criteria": q.get("criteria")}
                for qid, q in questions.items()}
        seed = int.from_bytes(hashlib.sha256(json.dumps([state, norm], sort_keys=True).encode()).digest()[:4], "big")
        answers, _, _ = asyncio.run_coroutine_threadsafe(self.engine.decide(norm, state, seed), self.loop).result()
        _deadline_check(self)
        return answers


def _git_head(path):
    try:
        import subprocess
        return subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return None
