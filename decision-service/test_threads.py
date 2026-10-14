import math
import threading
import unittest
from types import SimpleNamespace
from server import DeadlineBoard, http_threads_allowed

class DeadlineBoardTest(unittest.TestCase):
    def test_single_request_sets_and_keeps_its_deadline(self):
        s = SimpleNamespace(); b = DeadlineBoard(s)
        t = b.enter(10.0); self.assertEqual(s.deadline, 10.0)
        b.exit(t); self.assertEqual(s.deadline, 10.0)  # unchanged after the request, as before

    def test_concurrent_requests_share_the_latest_deadline(self):
        s = SimpleNamespace(); b = DeadlineBoard(s)
        a = b.enter(20.0); c = b.enter(5.0)
        self.assertEqual(s.deadline, 20.0)          # the short one never cuts the long one short
        b.exit(a); self.assertEqual(s.deadline, 5.0)  # once the long one leaves, the remaining one rules
        b.exit(c)

    def test_threads_need_a_concurrency_safe_backend(self):
        self.assertTrue(http_threads_allowed(SimpleNamespace(), 1))
        self.assertFalse(http_threads_allowed(SimpleNamespace(), 4))
        self.assertFalse(http_threads_allowed(SimpleNamespace(concurrent_safe="yes"), 4))
        self.assertTrue(http_threads_allowed(SimpleNamespace(concurrent_safe=True), 4))

    def test_board_is_consistent_under_contention(self):
        s = SimpleNamespace(); b = DeadlineBoard(s)
        def work(i):
            for _ in range(200):
                t = b.enter(float(i)); b.exit(t)
        ts = [threading.Thread(target=work, args=(i,)) for i in range(8)]
        [t.start() for t in ts]; [t.join() for t in ts]
        self.assertEqual(b.active, {})

if __name__ == "__main__":
    unittest.main()
