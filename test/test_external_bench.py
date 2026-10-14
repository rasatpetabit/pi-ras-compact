import importlib.util
import sys
from pathlib import Path

from compactbench.contracts import Transcript, Turn, TurnRole
from compactbench.providers.mock import MockProvider
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("external_bench", ROOT / "scripts/external-bench.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_longmem_labels_and_semantic_answer_ids_do_not_cross_boundary():
    case = {"question": "future probe", "answer": "GOLD", "answer_session_ids": ["answer_secret"],
            "haystack_dates": ["2020/01/01"], "haystack_session_ids": ["answer_secret"],
            "haystack_sessions": [[{"role": "user", "content": "raw fact", "has_answer": True}]]}
    turns = module.stripped_history(case)
    assert turns == [{"id": 0, "role": "user", "content": "[Session 1; date 2020/01/01]\nraw fact"}]
    assert module.labelled_evidence(case) == {0}


@pytest.mark.asyncio
async def test_drift_receives_only_retained_carry_and_new_turns(monkeypatch):
    requests = []
    def fake_bridge(request):
        requests.append(request)
        return {"summary": "retained only", "carry": {"segments": [], "generation": len(requests)},
                "stats": {"jevRequests": 1}, "retainedOrigins": [], "selectedTurnIds": [], "configHash": "config", "overBudget": False, "elapsedMs": 1, "sourceSha256": "source"}
    monkeypatch.setattr(module, "bridge", fake_bridge)
    monkeypatch.setenv("PI_JEV_CLM_ENDPOINT", "http://127.0.0.1:1/v1/systemone-local")
    method = module.CLMCompactor(MockProvider(), "reader")
    first = Turn(id=0, role=TurnRole.USER, content="dropped original")
    await method.compact(Transcript(turns=[first]))
    await method.compact(Transcript(turns=[first, Turn(id=1, role=TurnRole.USER, content="continue")]))
    assert requests[1]["turns"] == [{"id": 1, "role": "user", "content": "continue"}]
    assert requests[1]["previous"]["segments"] == []


@pytest.mark.asyncio
async def test_compactbench_tag_leak_and_oversize_output_fail_closed(monkeypatch):
    monkeypatch.setenv("PI_JEV_CLM_ENDPOINT", "http://127.0.0.1:1/v1/systemone-local")
    method = module.CLMCompactor(MockProvider(), "reader")
    with pytest.raises(ValueError, match="tags"):
        await method.compact(Transcript(turns=[Turn(id=0, role=TurnRole.USER, content="fact", tags=["critical"])]))
    monkeypatch.setattr(module, "bridge", lambda _: {"summary": "x" * 8001})
    with pytest.raises(ValueError, match="cap"):
        await method.compact(Transcript(turns=[Turn(id=0, role=TurnRole.USER, content="fact")]))


def test_manifest_rejects_changed_source_config_service_and_reader(tmp_path):
    from external_identity import write_manifest
    output = tmp_path / "run.jsonl"
    output.write_text('{"event":"run_end"}\n')
    start = {"sourceSha256": "source", "configHash": "config", "effectivePolicy": {},
             "service": {"revision": "weights"}, "reader": {"id": "reader", "root": "weights"}}
    for key, value in [("sourceSha256", "changed"), ("configHash", "changed"),
                       ("service", {"revision": "different"}), ("reader", {"id": "reader", "root": "different"}), ("transportRuntime", {"commandSha256": "changed"})]:
        end = dict(start, **{key: value})
        result = write_manifest(output, start, end, completed=True)
        assert result["qualifications"]["provenancePassed"] is False
    result = write_manifest(output, start, start, completed=False)
    assert result["qualifications"]["provenancePassed"] is False
    result = write_manifest(output, start, start, completed=True)
    assert result["qualifications"]["provenancePassed"] is True
    assert result["artifactSha256"][str(output)] == module.sha(output.read_bytes())


def test_identity_rejects_shared_anyjev_and_cache_enabled(monkeypatch, tmp_path):
    import external_identity
    probe = lambda: {"configHash": "config", "effectivePolicy": {}}
    monkeypatch.setattr(external_identity, "read_json", lambda _: {"backend": "anyjev", "cache_enabled": False,
                                                                "artifacts": {"anyjev_backend": "vllm-shared"}})
    with pytest.raises(ValueError, match="isolated"):
        external_identity.capture(tmp_path, probe, "http://127.0.0.1:1/v1/systemone-local", "anyjev")
    monkeypatch.setattr(external_identity, "read_json", lambda _: {"backend": "clm", "cache_enabled": True,
                                                                "artifacts": {"revision": "weights"}})
    with pytest.raises(ValueError, match="identity/cache"):
        external_identity.capture(tmp_path, probe, "http://127.0.0.1:1/v1/systemone-local", "clm")
