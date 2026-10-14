import assert from "node:assert/strict";
import { test } from "node:test";
import { pathsInArgs, touchedPaths, renderTouched } from "../src/core/touched.ts";
import type { BranchMessage } from "../src/core/charter.ts";

const call = (entryId: string, name: string, args: unknown): BranchMessage => ({ entryId, role: "assistant", text: "", toolCalls: [{ id: entryId, name, args }] });

test("paths come from path-like keys and from shell commands, not from prose or urls", () => {
  assert.deepEqual(pathsInArgs({ path: "src/a.ts" }), ["src/a.ts"]);
  assert.deepEqual(pathsInArgs({ paths: ["/srv/x", "./b/c"] }), ["/srv/x", "./b/c"]);
  assert.deepEqual(pathsInArgs({ command: "ls -la /workspace/project/pi-jev && cat relay/ssh_exec_relay.py | grep x" }), ["/workspace/project/pi-jev", "relay/ssh_exec_relay.py"]);
  assert.deepEqual(pathsInArgs({ command: "curl https://example.com/a/b > /dev/null" }), []);
  assert.deepEqual(pathsInArgs({ question: "which of src/a.ts or src/b.ts?" }), []);
});

test("touched paths are distinct, newest first, capped, and skip the file lists", () => {
  const msgs = [call("1", "ls", { path: "/srv/old" }), call("2", "read", { path: "src/a.ts" }), call("3", "bash", { command: "ls /srv/new; cat ./src/a.ts" }), call("4", "grep", { path: "/srv/newest/" })];
  const t = touchedPaths(msgs, ["src/a.ts"], 2);
  assert.deepEqual(t.paths, ["/srv/newest", "/srv/new"]);
  assert.equal(t.omitted, 1);
  assert.equal(renderTouched(t), "\n\n<touched-paths>\n(1 earlier paths not listed)\n/srv/newest\n/srv/new\n</touched-paths>");
  assert.equal(renderTouched({ paths: [], omitted: 0 }), "");
});
