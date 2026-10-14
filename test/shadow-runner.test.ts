import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEquivalenceStudy } from '../src/shadow/runner.js';
import { sha256File } from '../src/shadow/predeclaration.js';

const dir = () => mkdtempSync(join(tmpdir(), 'jev-shadow-run-'));
const q = { call_t1: { type: 'noul' as const, instructions: 'x' }, pick: { type: 'choice' as const, instructions: 'x', criteria: { a: 'A', b: 'B' } } };

const miniReceipt = (d: string) => {
  const request = { state: { id: 1 }, questions: q };
  const record = (dataset: string, sha: string, fixture: string) => ({
    dataset, fixture, metadata: [{ decision_model: 'h2o-lightning-4b', received_sha256: sha, request }],
  });
  writeFileSync(join(d, 'receipt.json'), JSON.stringify({ records: [
    record('base', 'a'.repeat(64), 'route-checkpoint'), record('base', 'a'.repeat(64), 'route-checkpoint'),
    record('panel', 'b'.repeat(64), 'other'),
  ] }));
  return join(d, 'receipt.json');
};

const declaration = (d: string, receiptPath: string, requests: number, questions: number, labels: number) => {
  const path = join(d, 'decl.json');
  writeFileSync(path, JSON.stringify({
    schema: 'jev-shadow-equivalence-predeclaration', version: 1,
    corpus: { receipt_path: receiptPath, receipt_sha256: sha256File(receiptPath), requests,
      questions, record_label_logprobs: labels, transport_label_values: labels, datasets: { base: 1, panel: 1 } },
    tolerances: { max_abs_probability_delta: 0.01, max_abs_logprob_delta: 0.05, boundary_band: 0.01,
      nonborderline_margin: 0.05, min_global_agreement: 0.995, max_flips_non_active_evidence: 0, active_evidence_flips: 0 },
    active_evidence: [{ dataset: 'base', fixture: 'route-checkpoint', received_sha256: 'a'.repeat(64), questions: ['call_t1'] }],
    declared_by: 'test', declared_at: '2026-10-11T00:00:00Z', source_citation: 'test',
  }, null, 2) + '\n');
  return { path, sha256: sha256File(path) };
};

/** Scripted local decision service: one answer document for every request. */
async function service(model: string, noul: number, pickA: number) {
  const hits: any[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      hits.push(JSON.parse(body));
      const response: Record<string, unknown> = { model, revision: '0'.repeat(40), answers: {
        call_t1: { type: 'noul', noul }, pick: { type: 'choice', choice: pickA > 0.5 ? 'a' : 'b', confidence: 0.9, probabilities: { a: pickA, b: 1 - pickA } },
      }, latency_ms: 5 };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    hits,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone-local`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); },
  };
}

const options = (receipt: string, decl: { path: string; sha256: string }, baseline: string, candidate: string, output: string) => ({
  receipt, predeclaration: decl.path, predeclaration_sha256: decl.sha256,
  baseline: { endpoint: baseline, model: 'openjev', revision: '0'.repeat(40) },
  candidate: { endpoint: candidate, model: 'openjev', revision: '0'.repeat(40) },
  output,
});

test('the study replays both endpoints, writes the report and passes an identical candidate', async () => {
  const d = dir();
  const receipt = miniReceipt(d);
  const decl = declaration(d, receipt, 2, 4, 6);
  const output = join(d, 'report.json');
  const baseline = await service('openjev', 0.7, 0.9);
  const candidate = await service('openjev', 0.7, 0.9);
  try {
    const { report } = await runEquivalenceStudy(options(receipt, decl, baseline.endpoint, candidate.endpoint, output));
    assert.equal(report.corpus.requests, 2);
    assert.equal(report.verdict, 'pass');
    assert.equal(report.decisions.total, 4);
    assert.equal(baseline.hits.length, 2);
    assert.equal(candidate.hits.length, 2);
    assert.equal(candidate.hits[0]!.state.id, 1);          // identical prompt payload replayed
    assert.deepEqual(Object.keys(candidate.hits[0]!.questions).sort(), ['call_t1', 'pick']);
    const written = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(written.verdict, 'pass');
    assert.equal(written.identity.candidate.model, 'openjev');
  } finally {
    await baseline.close(); await candidate.close(); rmSync(d, { recursive: true, force: true });
  }
});

test('a candidate that flips an active-evidence question fails the verdict', async () => {
  const d = dir();
  const receipt = miniReceipt(d);
  const decl = declaration(d, receipt, 2, 4, 6);
  const baseline = await service('openjev', 0.7, 0.9);
  const candidate = await service('openjev', 0.4, 0.9);
  try {
    const { report } = await runEquivalenceStudy(options(receipt, decl, baseline.endpoint, candidate.endpoint, join(d, 'r.json')));
    assert.equal(report.verdict, 'fail');
    assert.equal(report.criteria.find((c: any) => c.name === 'active_evidence_flips')!.observed, 1);
    assert.equal(report.decisions.flips.length, 1);
  } finally {
    await baseline.close(); await candidate.close(); rmSync(d, { recursive: true, force: true });
  }
});

test('the study refuses to start without a predeclaration and never contacts an endpoint', async () => {
  const d = dir();
  const receipt = miniReceipt(d);
  const output = join(d, 'report.json');
  const fetches: unknown[] = [];
  const fetcher = (async (...args: unknown[]) => { fetches.push(args); throw new Error('no live calls'); }) as typeof fetch;
  const baseline = await service('openjev', 0.7, 0.9);
  const candidate = await service('openjev', 0.7, 0.9);
  try {
    await assert.rejects(runEquivalenceStudy({
      ...options(receipt, { path: join(d, 'absent.json'), sha256: '0'.repeat(64) }, baseline.endpoint, candidate.endpoint, output),
      fetcher,
    }), /absent/);
    // A pinned hash that no longer matches the file is stale, still before any transport.
    const decl = declaration(d, receipt, 2, 4, 6);
    writeFileSync(decl.path, JSON.stringify({Stubby: true}) + '\n');
    await assert.rejects(runEquivalenceStudy({
      ...options(receipt, { path: decl.path, sha256: decl.sha256 }, baseline.endpoint, candidate.endpoint, output),
      fetcher,
    }), /stale/);
    assert.equal(fetches.length, 0);
    assert.equal(baseline.hits.length + candidate.hits.length, 0);
  } finally {
    await baseline.close(); await candidate.close(); rmSync(d, { recursive: true, force: true });
  }
});

test('a corpus that disagrees with the predeclaration is refused before replay', async () => {
  const d = dir();
  const receipt = miniReceipt(d);
  const wrongCounts = declaration(d, receipt, 3, 9, 12);   // the receipt holds 2 requests, 4 questions
  const baseline = await service('openjev', 0.7, 0.9);
  const candidate = await service('openjev', 0.7, 0.9);
  try {
    await assert.rejects(runEquivalenceStudy(options(receipt, wrongCounts, baseline.endpoint, candidate.endpoint, join(d, 'r.json'))),
      /corpus/);
    assert.equal(baseline.hits.length + candidate.hits.length, 0);
  } finally {
    await baseline.close(); await candidate.close(); rmSync(d, { recursive: true, force: true });
  }
});

test('the study aborts hanging endpoint calls within mandatory bounded timeout', { timeout: 2000 }, async () => {
  const d = dir();
  const receipt = miniReceipt(d);
  const decl = declaration(d, receipt, 2, 4, 6);
  const output = join(d, 'report.json');
  const baseline = await service('openjev', 0.7, 0.9);
  const hangingServer = createServer((_req, _res) => {
    // Deliberately accept and never respond
  });
  await new Promise<void>(resolve => hangingServer.listen(0, '127.0.0.1', resolve));
  const candidateUrl = `http://127.0.0.1:${(hangingServer.address() as AddressInfo).port}/v1/systemone-local`;

  try {
    const studyPromise = runEquivalenceStudy({
      ...options(receipt, decl, baseline.endpoint, candidateUrl, output),
      timeoutMs: 50,
    } as any);

    await assert.rejects(studyPromise, /timeout|aborted/i);
  } finally {
    hangingServer.closeAllConnections();
    await new Promise<void>(r => hangingServer.close(() => r()));
    await baseline.close();
    rmSync(d, { recursive: true, force: true });
  }
});
