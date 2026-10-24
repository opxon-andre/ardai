import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeQualitySummary, readQualitySummary, safeUrl } from '../lib/quality.mjs';
import { buildReportHtml } from '../lib/report.mjs';

const raw = () => ({
  schema: 1, generated_at: '2026-10-24T18:00:00Z', revision: 'abc1234', overall_gate: 'failed', report_url: 'file:///C:/x/report.html',
  components: [
    { name: 'gateway', coverage: { lines_percent: 94.9, branches_percent: 80, baseline_lines_percent: 95.2 }, findings: { total: 5, new: 2, error: 1, warning: 4, info: 0 }, gate: 'failed', detail_url: 'http://127.0.0.1:9100/dashboard?id=gw' },
    { name: 'spa', coverage: { lines_percent: 91.4 }, findings: { total: 0 }, gate: 'passed', detail_url: 'javascript:alert(1)' },
  ],
});

test('summary is normalized, unknown or unsafe values are dropped', () => {
  const q = normalizeQualitySummary(raw());
  assert.equal(q.gate, 'failed');
  assert.equal(q.components[0].coverage.baseline, 95.2);
  assert.equal(q.components[1].coverage.branches, null);
  assert.equal(q.components[1].url, '', 'javascript: links are rejected');
  assert.equal(safeUrl('https://example.org/a'), 'https://example.org/a');
  assert.equal(safeUrl('data:text/html,x'), '');
  assert.equal(normalizeQualitySummary({ schema: 2, components: [] }), null);
  assert.equal(normalizeQualitySummary({ schema: 1, components: [] }), null);
});

test('reader returns null without a file and an error object for broken files', () => {
  assert.equal(readQualitySummary(null), null);
  assert.equal(readQualitySummary('does-not-exist.json'), null);
  const file = new URL('.quality-broken.json', import.meta.url);
  fs.writeFileSync(file, '{ nope');
  try { assert.deepEqual(readQualitySummary(file.pathname.replace(/^\/([A-Za-z]:)/, '$1')), { error: 'unlesbar oder falsches Schema' }); } finally { fs.rmSync(file, { force: true }); }
});

test('status page shows coverage, findings, gate and detail links; hidden without a summary', () => {
  const quality = normalizeQualitySummary(raw());
  const html = buildReportHtml({ agents: {} }, { quality, fragmentOnly: true });
  assert.match(html, /quality-card/);
  assert.match(html, /94,9 %/);
  assert.match(html, /2 neu/);
  assert.match(html, /nicht bestanden/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:9100\/dashboard\?id=gw"/);
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(buildReportHtml({ agents: {} }, { quality: null, fragmentOnly: true }), /quality-card/);
});
