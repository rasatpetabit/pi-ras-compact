import math
import unittest
from candidates import BACKENDS, OJV27, canonical

class CanonicalTest(unittest.TestCase):
    def test_noul_passes_through(self):
        out = canonical({"q": {"type": "noul"}}, {"q": {"type": "noul", "noul": 0.25}})
        self.assertEqual(out, {"q": {"type": "noul", "noul": 0.25}})

    def test_choice_renormalizes_and_keeps_argmax(self):
        q = {"q": {"type": "choice", "criteria": {"keep": "k", "drop": "d", "defer": "f"}}}
        out = canonical(q, {"q": {"type": "choice", "probabilities": {"keep": 0.2, "drop": 0.71, "defer": 0.1}}})["q"]
        self.assertEqual(out["choice"], "drop")
        self.assertTrue(math.isclose(sum(out["probabilities"].values()), 1.0, abs_tol=1e-12))
        p = sorted(out["probabilities"].values(), reverse=True)
        self.assertTrue(math.isclose(out["confidence"], p[0] - (p[1] + p[2]) / 2, abs_tol=1e-12))

    def test_choice_tie_picks_first_label_in_request_order(self):
        q = {"q": {"type": "choice", "criteria": {"b": "", "a": ""}}}
        out = canonical(q, {"q": {"type": "choice", "probabilities": {"a": 0.5, "b": 0.5}}})["q"]
        self.assertEqual(out["choice"], "b")

    def test_score_is_expected_level_with_default_legend(self):
        q = {"q": {"type": "score", "criteria": ["low", "mid", "high"]}}
        out = canonical(q, {"q": {"type": "score", "probabilities": {"0": 0.2, "1": 0.3, "2": 0.5}}})["q"]
        self.assertTrue(math.isclose(out["score"], 1.3, abs_tol=1e-12))
        self.assertEqual(out["legend"], {"0": "low", "1": "mid", "2": "high"})

    def test_fails_closed(self):
        choice = {"q": {"type": "choice", "criteria": {"x": "", "y": ""}}}
        bad = [
            ({"q": {"type": "noul"}}, {}),                                                    # missing answer
            ({"q": {"type": "noul"}}, {"q": {"type": "choice", "probabilities": {}}}),        # type mismatch
            ({"q": {"type": "noul"}}, {"q": {"type": "noul", "noul": 1.5}}),                  # out of range
            ({"q": {"type": "noul"}}, {"q": {"type": "noul", "noul": float("nan")}}),         # non-finite
            (choice, {"q": {"type": "choice", "probabilities": {"x": 1.0}}}),                 # missing label
            (choice, {"q": {"type": "choice", "probabilities": {"x": 0.6, "y": 0.6}}}),       # sum 1.2
            (choice, {"q": {"type": "choice", "probabilities": {"x": 1.1, "y": -0.1}}}),      # negative
        ]
        for questions, answers in bad:
            with self.subTest(answers=answers), self.assertRaises(ValueError):
                canonical(questions, answers)

    def test_readout_perms_is_bounded_before_anything_loads(self):
        for bad in (0, 5, 1.5, "2"):
            with self.subTest(perms=bad), self.assertRaises(ValueError):
                OJV27("/nonexistent/helper.py", "/nonexistent/model", 1, 1, 0.1, 1, perms=bad)

    def test_backend_names(self):
        self.assertEqual(BACKENDS, ("zcjev", "ojv27", "laya", "dgemma"))

if __name__ == "__main__":
    unittest.main()
