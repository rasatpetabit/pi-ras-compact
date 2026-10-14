import math
import unittest
import server
from types import SimpleNamespace
from unittest.mock import patch
from server import checked_inputs, exact_label_logprob, render, RUBRIC

class Tokenizer:
    def decode(self, ids): return {32:"A",33:"B"}[ids[0]]
    def convert_ids_to_tokens(self, tid): return self.decode([tid])

class ProtocolTest(unittest.TestCase):
    def payload(self):
        return {"state":{"task":"keep ID-19","candidates":[{"id":"e1","text":"ID-19\nDo not deploy."}]},
                "questions":[{"id":"e1","type":"noul","question":RUBRIC}]}
    def test_preserves_exact_source(self):
        task, candidates = checked_inputs(self.payload())
        self.assertIn("ID-19\nDo not deploy.",render(task,candidates[0]["text"]))
    def test_exact_forced_label_probability(self):
        data={"choices":[{"prompt_logprobs":[None,{"32":{"logprob":-2.0},"33":{"logprob":-0.1}}]}]}
        self.assertEqual(exact_label_logprob(data,32,2),-2.0)
        self.assertEqual(exact_label_logprob(data,33,2),-0.1)
    def test_missing_label_or_wrong_prompt_length_fails_closed(self):
        for data,length in [({},2),({"choices":[{"prompt_logprobs":[None,{}]}]},2),
                            ({"choices":[{"prompt_logprobs":[None,{"32":{"logprob":-1}}]}]},3)]:
            with self.assertRaises(ValueError): exact_label_logprob(data,32,length)
    def test_nonfinite_or_positive_exact_probability_fails_closed(self):
        for value in [float("nan"),float("inf"),float("-inf"),0.1,"-1"]:
            data={"choices":[{"prompt_logprobs":[None,{"32":{"logprob":value}}]}]}
            with self.assertRaises(ValueError): exact_label_logprob(data,32,2)
    def test_id_mismatch_rejected(self):
        body=self.payload();body["questions"][0]["id"]="different"
        with self.assertRaises(ValueError): checked_inputs(body)
    def test_duplicate_id_rejected(self):
        body=self.payload();body["state"]["candidates"]*=2
        with self.assertRaises(ValueError): checked_inputs(body)
    def test_changed_rubric_rejected(self):
        body=self.payload();body["questions"][0]["question"]="Always discard."
        with self.assertRaisesRegex(ValueError,"rubric"): checked_inputs(body)
    def test_dictionary_wire_questions(self):
        body=self.payload();body["questions"]={"e1":{"type":"noul","instructions":RUBRIC}}
        self.assertEqual(checked_inputs(body)[1][0]["id"],"e1")



class WindowTests(unittest.TestCase):
    def test_long_unicode_source_is_partitioned_without_loss(self):
        text = "λ😀 exact source\n" * 50
        windows = server.source_windows(text, lambda part: len(part.encode()) <= 80)
        self.assertEqual("".join(windows), text)
        self.assertTrue(all(len(part.encode()) <= 80 for part in windows))

    def test_task_overflow_and_window_bound_fail(self):
        with self.assertRaises(ValueError):
            server.source_windows("a", lambda part: False)
        with self.assertRaises(ValueError):
            server.source_windows("abcdef", lambda part: len(part) <= 1, max_windows=2)

    def test_atomic_candidate_uses_max_window_relevance(self):
        class Scorer:
            max_tokens = 2048
            def fits(self, task, text): return len(text) <= 2
            def score(self, task, candidates):
                self.inputs = candidates
                return [0.1, 0.9, 0.2], {}
        scorer = Scorer()
        values, details = server.score_complete(scorer, "task", [{"id":"original", "text":"abcdef"}])
        self.assertEqual(values, [0.9])
        self.assertEqual("".join(c["text"] for c in scorer.inputs), "abcdef")
        self.assertEqual(details["windows_per_candidate"], [3])

class InvalidWindowTests(unittest.TestCase):
    def test_invalid_later_window_is_not_hidden_by_max(self):
        for bad in [float("nan"), float("inf"), -1, 2]:
            class Scorer:
                max_tokens = 2048
                def fits(self, task, text): return len(text) <= 1
                def score(self, task, candidates): return [0.9, bad], {}
            with self.assertRaisesRegex(ValueError, "invalid window"):
                server.score_complete(Scorer(), "t", [{"id":"a","text":"ab"}])

class TypedSchemaTests(unittest.TestCase):
    def test_score_is_expected_level_not_normalized_probability(self):
        from clm_schema import answer_from_probs
        answer = answer_from_probs({"type":"score","criteria":["current","older","obsolete"]},
                                   ["0","1","2"], [0.1,0.2,0.7])
        self.assertAlmostEqual(answer["score"], 1.6)
        self.assertEqual(answer["probabilities"], {"0":0.1,"1":0.2,"2":0.7})

    def test_noul_criteria_are_preserved(self):
        from clm_schema import build_pairs
        pair = build_pairs("original state", {"q":{"type":"noul","instructions":"Needed?",
                           "criteria":{"true":"critical evidence","false":"obsolete"}}})["q"]
        self.assertEqual(pair, ("original state\n\nNeeded?", ["false","true"],
                               ["false: obsolete", "true: critical evidence"]))

class PreprocessingTests(unittest.TestCase):
    def test_never_probes_the_unbounded_source_suffix(self):
        sizes=[]
        def fits(text):
            sizes.append(len(text))
            return len(text)<=1000
        text="x"*12000
        windows=server.source_windows(text,fits)
        self.assertEqual("".join(windows),text)
        self.assertLessEqual(max(sizes),4096)

    def test_prompt_guard_precedes_tokenization(self):
        for prompt,deadline,error in [("x"*32769,float("inf"),ValueError),("x",0,TimeoutError)]:
            tokenizer=unittest.mock.Mock()
            with self.assertRaises(error):
                server.check_prompt_workload(prompt,2048,deadline)
                tokenizer.encode(prompt)
            tokenizer.encode.assert_not_called()

class TypedAdapterTests(unittest.TestCase):
    def anyjev(self,question,probabilities,p_true=.7):
        seen=[]
        class Question:
            @staticmethod
            def noul(text,name=None): return ("noul",text,None)
            @staticmethod
            def choice(text,options,name=None): return ("choice",text,options)
            @staticmethod
            def score(text,levels,name=None): return ("score",text,levels)
        scorer=server.AnyJev.__new__(server.AnyJev)
        scorer.backend=SimpleNamespace();scorer.max_tokens=2048
        def decide(state,questions):
            seen.extend(questions)
            return [SimpleNamespace(p_true=p_true,probs=SimpleNamespace(tolist=lambda:probabilities))]
        scorer.decider=SimpleNamespace(decide=decide)
        with patch.dict("sys.modules",{"anyjev":SimpleNamespace(Question=Question)}):
            answer=scorer.answer("state",{"q":question})["q"]
        return answer,seen

    def test_direct_noul_and_custom_false_true_mapping(self):
        answer,_=self.anyjev({"type":"noul","instructions":"needed"},[.7,.3])
        self.assertAlmostEqual(answer["noul"],.7)
        answer,seen=self.anyjev({"type":"noul","instructions":"needed","criteria":{"true":"retain","false":"omit"}},[.1,.9])
        self.assertAlmostEqual(answer["noul"],.9)
        self.assertEqual(seen[0][2],["false: omit","true: retain"])

    def test_choice_insertion_order_and_expected_ordinal_level(self):
        answer,_=self.anyjev({"type":"choice","instructions":"pick","criteria":{"z":"Zulu","a":"Alpha"}},[.9,.1])
        self.assertEqual(answer["choice"],"z")
        answer,_=self.anyjev({"type":"score","instructions":"stale","criteria":["current","older","obsolete"]},[.1,.2,.7])
        self.assertAlmostEqual(answer["score"],1.6)

    def test_malformed_distribution_rejected(self):
        with self.assertRaises(ValueError):
            self.anyjev({"type":"choice","instructions":"pick","criteria":{"z":"Zulu","a":"Alpha"}},[.1,.1])

    def test_nli_entailment_and_relative_option_odds(self):
        self.assertGreater(server.nli_option_probs([[0,10,0]],True)[1],.99)
        self.assertLess(server.nli_option_probs([[0,0,10]],True)[1],.01)
        self.assertEqual(server.nli_option_probs([[0,1,0],[0,1,0]]),[.5,.5])
        probs=server.nli_option_probs([[0,10,0],[10,0,0]])
        self.assertGreater(probs[0],.99)
        with self.assertRaises(ValueError):server.nli_option_probs([[0,float("nan"),0]])

class UpstreamOpenJevTests(unittest.TestCase):
    def test_normalizes_entailment_probabilities_not_odds(self):
        import math
        rows=[[math.log(.05),math.log(.9),math.log(.05)],
              [math.log(.2),math.log(.6),math.log(.2)]]
        probabilities=server.nli_option_probs(rows,readout="upstream-entailment")
        self.assertAlmostEqual(probabilities[0],.6)
        self.assertAlmostEqual(probabilities[1],.4)
        self.assertGreater(server.nli_option_probs(rows)[0],.8)

    def test_upstream_ratio_survives_underflow(self):
        probabilities=server.nli_option_probs([[0,-10000,0],[0,-10000,0]],readout="upstream-entailment")
        self.assertEqual(probabilities,[.5,.5])

    def test_canonical_boolean_hypotheses_and_answer_order(self):
        keys,hypotheses=server.openjev_upstream_hypotheses({"type":"noul","instructions":"Succeeded?"})
        self.assertEqual(keys,["false","true"])
        self.assertEqual(hypotheses,['The answer to "Succeeded?" is no: no',
                                     'The answer to "Succeeded?" is yes: yes'])

    def test_criteria_and_non_alphabetic_choice_order(self):
        keys,hypotheses=server.openjev_upstream_hypotheses({"type":"choice","instructions":"Where?",
                            "criteria":{"west":"west facility","east":"east facility"}})
        self.assertEqual(keys,["west","east"])
        self.assertEqual(hypotheses,['The answer to "Where?" is west: west facility',
                                     'The answer to "Where?" is east: east facility'])
        keys,hypotheses=server.openjev_upstream_hypotheses({"type":"noul","instructions":"Safe?",
                            "criteria":{"true":"all guards pass","false":"guard failed"}})
        self.assertEqual(hypotheses,['The answer to "Safe?" is no: guard failed',
                                     'The answer to "Safe?" is yes: all guards pass'])

class OpenJevBatchTests(unittest.TestCase):
    def scorer(self, batch_size=4):
        try:
            import torch
        except ImportError:
            self.skipTest("PyTorch is required for pooling tests; run in the serving runtime on CPU")
        calls = []
        class Tokenizer:
            padding_side = "right"
            def __call__(self, texts, **kwargs):
                texts = [texts] if isinstance(texts, str) else texts
                rows = [[int(v) for v in text.split()] for text in texts]
                length = max(map(len, rows))
                return {"input_ids": torch.tensor([r+[0]*(length-len(r)) for r in rows]),
                        "attention_mask": torch.tensor([[1]*len(r)+[0]*(length-len(r)) for r in rows])}
        def backbone(**kwargs):
            calls.append(kwargs["input_ids"].shape[0])
            return SimpleNamespace(last_hidden_state=kwargs["input_ids"].float().unsqueeze(-1))
        scorer = server.OpenJev.__new__(server.OpenJev)
        scorer.torch = torch; scorer.tok = Tokenizer(); scorer.max_tokens = 8
        scorer.batch_size = batch_size; scorer.backbone = backbone
        scorer.model = SimpleNamespace(device=torch.device("cpu"), score=lambda h: torch.cat([h,-h,torch.zeros_like(h)], dim=-1))
        scorer.encode_input = lambda text: scorer.tok(text)
        return scorer, calls

    def test_mixed_lengths_pool_last_real_token_and_preserve_order(self):
        scorer,calls = self.scorer(2)
        logits = scorer.logits_for(["1 2 3", "4", "5 6", "7", "8"])
        self.assertEqual(logits, [[3.,-3.,0.],[4.,-4.,0.],[6.,-6.,0.],[7.,-7.,0.],[8.,-8.,0.]])
        self.assertEqual(calls,[2,2,1])

    def test_single_default_has_same_logits_without_batching(self):
        scorer,calls = self.scorer(1)
        self.assertEqual(scorer.logits_for(["1 2", "3"]), [[2.,-2.,0.],[3.,-3.,0.]])
        self.assertEqual(calls,[1,1])

    def test_overflow_wrong_padding_and_deadline_fail_before_forward(self):
        scorer,calls = self.scorer(4)
        with self.assertRaisesRegex(ValueError,"context limit"):
            scorer.logits_for(["1 2 3 4 5 6 7 8 9"])
        self.assertEqual(calls,[])
        scorer.tok.padding_side = "left"
        with self.assertRaisesRegex(ValueError,"right padding"):
            scorer.logits_for(["1"])
        scorer.tok.padding_side = "right"; scorer.deadline = 0
        with self.assertRaises(TimeoutError): scorer.logits_for(["1"])
        self.assertEqual(calls,[])

    def test_oversize_state_rejected_before_hypothesis_expansion(self):
        scorer = server.OpenJev.__new__(server.OpenJev)
        scorer.max_tokens = 8; scorer.typed_readout = "upstream-entailment"
        scorer.logits_for = unittest.mock.Mock()
        with patch.object(server,"openjev_upstream_hypotheses") as expand:
            with self.assertRaisesRegex(ValueError,"workload"):
                scorer.answer("x"*129, {"q":{"type":"noul","instructions":"needed?"}})
            expand.assert_not_called(); scorer.logits_for.assert_not_called()

    def test_prompt_stream_stops_before_expanding_later_questions(self):
        scorer = server.OpenJev.__new__(server.OpenJev)
        scorer.max_tokens = 8; scorer.template = "{premise}|{hypothesis}"; scorer.typed_readout = "upstream-entailment"
        def stop_after_first(prompts):
            iterator = iter(prompts)
            next(iterator)
            raise TimeoutError("bounded consumer stopped")
        scorer.logits_for = stop_after_first
        original = server.openjev_upstream_hypotheses
        with patch.object(server,"openjev_upstream_hypotheses",wraps=original) as expand:
            with self.assertRaises(TimeoutError):
                scorer.answer("s",{str(i):{"type":"noul","instructions":"q"} for i in range(128)})
            self.assertEqual(expand.call_count,1)

    def test_question_groups_keep_different_option_counts_and_order(self):
        scorer = server.OpenJev.__new__(server.OpenJev)
        scorer.template = "{premise}|{hypothesis}"; scorer.typed_readout = "upstream-entailment"; scorer.max_tokens = 2048
        texts = []
        def logits(prompts):
            texts.extend(prompts)
            return [[0,5,0],[0,0,0], [0,0,0],[0,0,0],[0,5,0]]
        scorer.logits_for = logits
        answers = scorer.answer("source", {"choice":{"type":"choice","instructions":"where?","criteria":{"west":"W","east":"E"}},
                              "level":{"type":"score","instructions":"stage?","criteria":["new","old","done"]}})
        self.assertEqual(answers["choice"]["choice"],"west")
        self.assertGreater(answers["level"]["score"],1)
        self.assertEqual(len(texts),5)
        self.assertIn("west: W",texts[0]); self.assertIn("done",texts[-1])



class OpenJevSharedPrefixTests(unittest.TestCase):
    def scorer(self, group=8):
        try:
            import torch
        except ImportError:
            self.skipTest("PyTorch is required for shared-prefix tests; run in the serving runtime on CPU")
        calls = []
        class Cache:
            def __init__(self): self.reorders = []
            def reorder_cache(self, beam_idx): self.reorders.append(beam_idx.tolist())
        class Tokenizer:
            padding_side = "right"; pad_token_id = 0
            def __call__(self, texts, **kwargs):
                single = isinstance(texts, str)
                rows = [[int(v) for v in text.split()] for text in ([texts] if single else texts)]
                if single:
                    return {"input_ids": rows[0]}
                length = max(map(len, rows))
                return {"input_ids": torch.tensor([r+[0]*(length-len(r)) for r in rows]),
                        "attention_mask": torch.tensor([[1]*len(r)+[0]*(length-len(r)) for r in rows])}
        prefix_cache = Cache()
        def backbone(**kwargs):
            calls.append(kwargs)
            if "past_key_values" not in kwargs:
                return SimpleNamespace(past_key_values=prefix_cache, last_hidden_state=None)
            return SimpleNamespace(last_hidden_state=kwargs["input_ids"].float().unsqueeze(-1))
        scorer = server.OpenJev.__new__(server.OpenJev)
        scorer.torch = torch; scorer.tok = Tokenizer(); scorer.max_tokens = 8
        scorer.batch_size = 4; scorer.backbone = backbone; scorer.shared_prefix = True; scorer.prefix_group = group
        scorer.model = SimpleNamespace(device=torch.device("cpu"), score=lambda h: torch.cat([h,-h,torch.zeros_like(h)], dim=-1))
        scorer.encode_input = lambda text: scorer.tok(text)
        return scorer, calls, prefix_cache

    def test_prefills_common_prefix_once_and_pools_each_suffix_end(self):
        scorer, calls, cache = self.scorer(group=2)
        logits = scorer.logits_shared(iter(["1 2 3 4", "1 2 5", "1 2 3 6 7"]))
        self.assertEqual(logits, [[4.,-4.,0.],[5.,-5.,0.],[7.,-7.,0.]])
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0]["input_ids"].tolist(), [[1, 2]])
        self.assertEqual(calls[0]["position_ids"].tolist(), [[0, 1]])
        self.assertTrue(calls[0]["use_cache"])
        first, second = calls[1], calls[2]
        self.assertEqual(first["input_ids"].tolist(), [[3, 4], [5, 0]])
        self.assertEqual(first["attention_mask"].tolist(), [[1, 1, 1, 1], [1, 1, 1, 0]])
        self.assertEqual(first["position_ids"].tolist(), [[2, 3], [2, 3]])
        self.assertEqual(second["input_ids"].tolist(), [[3, 6, 7]])
        self.assertEqual(second["position_ids"].tolist(), [[2, 3, 4]])
        # Each group branches a private copy of the prefix cache; the original is never mutated.
        self.assertEqual(cache.reorders, [])
        self.assertEqual([c["past_key_values"].reorders for c in calls[1:]], [[[0, 0]], [[0]]])

    def test_single_token_suffixes_are_padded_to_the_multi_token_path(self):
        scorer, calls, _ = self.scorer()
        logits = scorer.logits_shared(["1 2 3", "1 2 4"])
        self.assertEqual(logits, [[3.,-3.,0.],[4.,-4.,0.]])
        self.assertEqual(calls[1]["input_ids"].tolist(), [[3, 0], [4, 0]])
        self.assertEqual(calls[1]["attention_mask"].tolist(), [[1, 1, 1, 0], [1, 1, 1, 0]])
        self.assertEqual(calls[1]["position_ids"].tolist(), [[2, 3], [2, 3]])

    def test_groups_respect_the_padded_token_budget(self):
        scorer, calls, _ = self.scorer(group=8)
        scorer.batch_size = 1  # budget = 1 * max_tokens(8) padded tokens per group
        logits = scorer.logits_shared(["1 2 3 4 5", "1 2 6 7 8", "1 2 9"])
        self.assertEqual(logits, [[5.,-5.,0.],[8.,-8.,0.],[9.,-9.,0.]])
        self.assertEqual([c["input_ids"].tolist() for c in calls[1:]], [[[3, 4, 5]], [[6, 7, 8]], [[9, 0]]])
        scorer, calls, _ = self.scorer(group=8)
        scorer.batch_size = 4  # budget 32: all three rows fit one group of width 3
        scorer.logits_shared(["1 2 3 4 5", "1 2 6 7 8", "1 2 9"])
        self.assertEqual([c["input_ids"].tolist() for c in calls[1:]], [[[3, 4, 5], [6, 7, 8], [9, 0, 0]]])

    def test_full_common_prefix_keeps_one_suffix_token(self):
        scorer, calls, _ = self.scorer()
        logits = scorer.logits_shared(["1 2 3", "1 2 3 4"])
        self.assertEqual(logits, [[3.,-3.,0.],[4.,-4.,0.]])
        self.assertEqual(calls[0]["input_ids"].tolist(), [[1, 2]])
        self.assertEqual(calls[1]["input_ids"].tolist(), [[3, 0], [3, 4]])

    def test_falls_back_to_plain_batches_without_a_shared_prefix(self):
        for texts in [["1 2", "3 4"], ["1 2 3"]]:
            scorer, calls, _ = self.scorer()
            scorer.logits_for = lambda prompts: [[len(p),0.,0.] for p in prompts]
            self.assertEqual(scorer.logits_shared(iter(texts)), [[len(p),0.,0.] for p in texts])
            self.assertEqual(calls, [])

    def test_guards_run_before_any_forward(self):
        scorer, calls, _ = self.scorer()
        with self.assertRaisesRegex(ValueError, "no truncation"):
            scorer.logits_shared(["1 2 3 4 5 6 7 8 9", "1 2"])
        scorer.deadline = 0
        with self.assertRaises(TimeoutError):
            scorer.logits_shared(["1 2", "1 3"])
        scorer.deadline = math.inf
        for bad in [0, 33, 8.0]:
            scorer.prefix_group = bad
            with self.assertRaises(ValueError):
                scorer.logits_shared(["1 2", "1 3"])
        self.assertEqual(calls, [])

    def test_answer_uses_shared_path_only_when_enabled(self):
        for enabled in [False, True]:
            scorer = server.OpenJev.__new__(server.OpenJev)
            scorer.template = "{premise}|{hypothesis}"; scorer.typed_readout = "upstream-entailment"; scorer.max_tokens = 2048
            if enabled: scorer.shared_prefix = True
            seen = {}
            scorer.logits_for = lambda prompts: seen.setdefault("plain", list(prompts)) and [[0,1,0],[0,0,0]]
            scorer.logits_shared = lambda prompts: seen.setdefault("shared", list(prompts)) and [[0,1,0],[0,0,0]]
            scorer.answer("s", {"q": {"type": "noul", "instructions": "needed?"}})
            self.assertEqual(list(seen), ["shared" if enabled else "plain"])
            self.assertTrue(all(p.startswith("s|") for p in next(iter(seen.values()))))


class OpenJevAttentionTests(unittest.TestCase):
    def test_default_and_opt_in_modes_reach_the_loader(self):
        import sys
        from unittest.mock import Mock
        model = Mock()
        model.to.return_value = model
        model.eval.return_value = model
        model.base_model_prefix = "backbone"
        model.config.get_text_config.return_value = SimpleNamespace(pad_token_id=0)
        model.config.nli_template = "Premise: {premise} Hypothesis: {hypothesis}"
        loader = Mock(return_value=model)
        module = SimpleNamespace(AutoModelForSequenceClassification=SimpleNamespace(from_pretrained=loader))
        def encoder_init(instance, path, dtype, max_tokens):
            instance.dtype = dtype
            instance.tok = SimpleNamespace(pad_token_id=0)
        with patch.object(server.Encoder, "__init__", encoder_init), patch.dict(sys.modules, {"transformers": module}):
            for attention in [None, "eager", "sdpa"]:
                scorer = server.OpenJev("pinned-local-model", "float16", 4096, *([] if attention is None else [attention]))
                self.assertEqual(loader.call_args.kwargs["attn_implementation"], attention or "eager")
                self.assertEqual(scorer.attention_implementation, attention or "eager")
                self.assertTrue(loader.call_args.kwargs["local_files_only"])
            with self.assertRaises(ValueError):
                server.OpenJev("pinned-local-model", "float16", 4096, "unsupported")

class AnyJevAttentionTests(unittest.TestCase):
    def test_isolated_default_and_opt_in_reach_library_loader(self):
        import sys
        from unittest.mock import Mock
        calls = []
        class Backend:
            def __init__(self, *args, **kwargs):
                calls.append((args, kwargs))
                self.model = SimpleNamespace(config=SimpleNamespace(use_cache=True))
                self.tokenizer = object()
        decider = Mock()
        question = Mock()
        modules = {"numpy": SimpleNamespace(), "anyjev": SimpleNamespace(Decider=decider, Question=question),
                   "anyjev.backends.hf": SimpleNamespace(HFBackend=Backend),
                   "anyjev.backends.vllm": SimpleNamespace(VLLMBackend=Backend)}
        with patch.dict(sys.modules, modules):
            for attention in [None, "eager", "sdpa"]:
                scorer = server.AnyJev(None, None, None, 4096, "library-revision", "pinned-model", "float16",
                                      *([] if attention is None else [attention]))
                self.assertEqual(calls[-1][1]["attn_implementation"], attention or "eager")
                self.assertEqual(scorer.attention_implementation, attention or "eager")
                self.assertTrue(calls[-1][1]["local_files_only"])
                self.assertEqual(calls[-1][1]["batch_size"], 1)
                self.assertFalse(scorer.backend.model.config.use_cache)
                self.assertEqual(decider.call_args.kwargs["prior"], "none")
                self.assertFalse(decider.call_args.kwargs["shared_prefix"])
            before = len(calls)
            with self.assertRaises(ValueError):
                server.AnyJev(None, None, None, 4096, "r", "p", "float16", "unsupported")
            with self.assertRaisesRegex(ValueError, "isolated"):
                server.AnyJev("http://localhost", "m", "t", 4096, "r", None, "float16", "sdpa")
            self.assertEqual(len(calls), before)

if __name__=="__main__": unittest.main()
