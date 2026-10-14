import importlib.util
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("compaction_report", ROOT / "scripts/compaction-report.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

# The 45eed97f incident, replayable: Pi commits at 03:05:58.729Z while ecb31167 is already in
# flight (its request started 03:05:37.752Z and it is re-parented under the compaction), so the
# first assistant the report reaches in file order is the one built from the *pre*-commit context.
COMPACTION_ID = "45eed97f"
COMMIT = "2026-10-02T03:05:58.729Z"
RACING_START_MS = 1790910337752  # ecb31167.message.timestamp: before the commit
LATER_START_MS = 1790910460706  # 8baaa76f.message.timestamp: after the commit
RACING_TOKENS = 2 + 424_854 + 4_477  # the pre-commit context: 429333
LATER_TOKENS = 2 + 66_169 + 77_084  # the post-commit context: 143255
COMMIT_MS = round(datetime.fromisoformat(COMMIT.replace("Z", "+00:00")).timestamp() * 1000)


def write_session(path, *, compaction_id=COMPACTION_ID, compaction_timestamp=COMMIT,
                  racing_message_timestamp=RACING_START_MS, later_message_timestamp=LATER_START_MS):
    """The incident's lineage: compaction -> 55c9ea2e -> 2d470016 -> ecb31167 -> ... -> 8baaa76f."""
    entries = [
        {"type": "session", "id": "s0", "timestamp": "2026-10-02T03:00:00.000Z"},
        {"type": "compaction", "id": compaction_id, "parentId": "64a2ba89", "timestamp": compaction_timestamp,
         "fromHook": True, "firstKeptEntryId": "d564075c", "summary": "y" * 400,
         "details": {"jev": {"version": 1, "model": "jev-1.13.0"}}},
        {"type": "custom", "id": "55c9ea2e", "parentId": compaction_id, "timestamp": "2026-10-02T03:05:58.759Z",
         "customType": "jev-compaction"},
        {"type": "custom", "id": "2d470016", "parentId": "55c9ea2e", "timestamp": "2026-10-02T03:07:33.780Z",
         "customType": "workflow-result"},
        {"type": "message", "id": "ecb31167", "parentId": "2d470016", "timestamp": "2026-10-02T03:07:33.784Z",
         "message": {"role": "assistant", "stopReason": "toolUse", "timestamp": racing_message_timestamp,
                     "usage": {"input": 2, "output": 678, "cacheRead": 424_854, "cacheWrite": 4_477,
                               "totalTokens": 442_430}}},
        {"type": "message", "id": "0ca09329", "parentId": "ecb31167", "timestamp": "2026-10-02T03:07:36.594Z",
         "message": {"role": "user", "content": "continue", "timestamp": 1790910358777}},
        {"type": "message", "id": "8baaa76f", "parentId": "0ca09329", "timestamp": "2026-10-02T03:07:49.823Z",
         "message": {"role": "assistant", "stopReason": "toolUse", "timestamp": later_message_timestamp,
                     "usage": {"input": 2, "output": 635, "cacheRead": 66_169, "cacheWrite": 77_084,
                               "totalTokens": 143_890}}},
    ]
    path.write_text("".join(json.dumps(entry, separators=(",", ":")) + "\n" for entry in entries))


def test_response_started_before_the_commit_does_not_measure_it(tmp_path):
    session = tmp_path / "record.jsonl"
    write_session(session)
    assert module.context_after(str(session), COMPACTION_ID, {}) == LATER_TOKENS


def test_unparsable_or_missing_timestamps_keep_the_first_descendant_measurement(tmp_path):
    """No ordering key on either side: the report keeps its pre-fix answer, just as the extension does."""
    unstamped_message = tmp_path / "unstamped-message.jsonl"
    write_session(unstamped_message, racing_message_timestamp=None, later_message_timestamp=None)
    assert module.context_after(str(unstamped_message), COMPACTION_ID, {}) == RACING_TOKENS

    unstamped_commit = tmp_path / "unstamped-commit.jsonl"
    write_session(unstamped_commit, compaction_timestamp=None)
    assert module.context_after(str(unstamped_commit), COMPACTION_ID, {}) == RACING_TOKENS

    unparsable_commit = tmp_path / "unparsable-commit.jsonl"
    write_session(unparsable_commit, compaction_timestamp="not-a-timestamp")
    assert module.context_after(str(unparsable_commit), COMPACTION_ID, {}) == RACING_TOKENS


def test_response_stamped_in_the_commits_own_millisecond_is_pre_commit(tmp_path):
    """Pi core compares `assistant.timestamp <= Date.parse(compactionEntry.timestamp)`: equality is pre-commit."""
    session = tmp_path / "boundary.jsonl"
    write_session(session, racing_message_timestamp=COMMIT_MS)
    assert module.context_after(str(session), COMPACTION_ID, {}) == LATER_TOKENS
    assert module.entry_timestamp_ms({"timestamp": COMMIT}) == COMMIT_MS


def test_a_missing_timestamp_is_reported_as_a_fallback_not_as_an_ordered_measurement(tmp_path):
    ordered_session = tmp_path / "ordered.jsonl"
    write_session(ordered_session)
    assert module.context_after_detail(str(ordered_session), COMPACTION_ID, {}) == (LATER_TOKENS, True)

    for name, kwargs in [
        ("unparsable-commit", {"compaction_timestamp": "not-a-timestamp"}),
        ("unstamped-message", {"racing_message_timestamp": None, "later_message_timestamp": None}),
    ]:
        path = tmp_path / f"{name}.jsonl"
        write_session(path, **kwargs)
        tokens, ordered = module.context_after_detail(str(path), COMPACTION_ID, {})
        assert tokens == RACING_TOKENS
        assert ordered is False, f"{name} must be admitted only on the pre-ordering-key rule"


def test_the_report_counts_the_fallbacks_separately_from_the_ordered_measurements(tmp_path, capsys):
    """The acceptance clause: a rescan reports fallbacks for want of a timestamp, not a clean count."""
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    write_session(sessions / "ordered.jsonl")
    write_session(sessions / "fallback.jsonl", compaction_id="9f267c0f",
                  racing_message_timestamp=None, later_message_timestamp=None)
    argv = sys.argv
    sys.argv = ["compaction-report.py", "--sessions", str(sessions), "--since", "2026-01-01T00:00:00Z"]
    try:
        assert module.main() == 0
    finally:
        sys.argv = argv
    out = capsys.readouterr().out
    assert "1 of 2 measured compactions" in out
    assert "1 fell back for lack of a timestamp" in out


def test_native_totals_report_recoverable_capped_and_unlinked_stubs(tmp_path, capsys):
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    # Missing legacy counters are unknown, not evidence of zero shortening.
    for i, stats in enumerate([{"stubbed": 3, "capped": 2, "unlinked": 1},
                               {"stubbed": 5, "capped": 4, "unlinked": 2}, {}]):
        path = sessions / f"session-{i}.jsonl"
        write_session(path, compaction_id=f"c{i}")
        entries = [json.loads(line) for line in path.read_text().splitlines()]
        entries[1]["details"]["jev"]["stats"] = stats
        path.write_text("".join(json.dumps(entry, separators=(",", ":")) + "\n" for entry in entries))
    argv = sys.argv
    sys.argv = ["compaction-report.py", "--sessions", str(sessions), "--since", "2026-01-01T00:00:00Z"]
    try:
        assert module.main() == 0
    finally:
        sys.argv = argv
    out = capsys.readouterr().out
    assert "stubs restorable 8, capped 6, unlinked 3" in out
    assert "recovery counters recorded for 2 of 3 compactions" in out


def test_native_legacy_totals_report_unknown_recovery_stats(tmp_path, capsys):
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    write_session(sessions / "legacy.jsonl")
    argv = sys.argv
    sys.argv = ["compaction-report.py", "--sessions", str(sessions), "--since", "2026-01-01T00:00:00Z", "--list"]
    try:
        assert module.main() == 0
    finally:
        sys.argv = argv
    out = capsys.readouterr().out
    assert "stubs restorable unknown, capped unknown, unlinked unknown" in out
    assert "recovery counters recorded for 0 of 1 compactions" in out
    assert "capped ? restorable ? unlinked ?" in out


def test_native_totals_report_zero_recovery_counters(tmp_path, capsys):
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    path = sessions / "zero-recovery.jsonl"
    write_session(path, compaction_id="c_zero")
    entries = [json.loads(line) for line in path.read_text().splitlines()]
    entries[1]["details"]["jev"]["stats"] = {"stubbed": 0, "capped": 0, "unlinked": 0}
    path.write_text("".join(json.dumps(entry, separators=(",", ":")) + "\n" for entry in entries))
    argv = sys.argv
    sys.argv = ["compaction-report.py", "--sessions", str(sessions), "--since", "2026-01-01T00:00:00Z", "--list"]
    try:
        assert module.main() == 0
    finally:
        sys.argv = argv
    out = capsys.readouterr().out
    assert "stubs restorable 0, capped 0, unlinked 0" in out
    assert "recovery counters recorded for 1 of 1 compactions" in out
    assert "capped 0 restorable 0 unlinked 0" in out

