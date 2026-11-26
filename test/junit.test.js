'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  parseJunitXml,
  buildAuditMarkdown,
  buildDiffMarkdown,
  buildSummaryCsv,
  buildSummaryMarkdown,
} = require('../src/junit');
const { JunitViewModel } = require('../src/view');
const { editorHtml, csp } = require('../src/html');

test('parses sample junit.xml with pass, fail, error, flaky, skipped and slow tests', () => {
  const buf = fs.readFileSync(path.join(__dirname, '..', 'samples', 'junit.xml'));
  const parsed = parseJunitXml(buf, 'junit.xml');
  assert.equal(parsed.stats.suiteCount, 2);
  assert.equal(parsed.stats.testCount, 7);
  assert.equal(parsed.stats.passedCount, 3);
  assert.equal(parsed.stats.failedCount, 1);
  assert.equal(parsed.stats.errorCount, 1);
  assert.equal(parsed.stats.flakyCount, 1);
  assert.equal(parsed.stats.skippedCount, 1);
  assert.equal(parsed.slowest[0].name, 'rejectsExpiredCardToken');
  const rules = new Set(parsed.findings.map((f) => f.rule));
  assert.ok(rules.has('failed-testcase'));
  assert.ok(rules.has('error-testcase'));
  assert.ok(rules.has('flaky-testcase'));
  assert.ok(rules.has('skipped-testcase'));
  assert.ok(rules.has('slow-testcase'));
});

test('passes clean JUnit XML report with zero findings', () => {
  const buf = fs.readFileSync(path.join(__dirname, '..', 'samples', 'clean.junit.xml'));
  const parsed = parseJunitXml(buf, 'clean.junit.xml');
  assert.equal(parsed.stats.testCount, 3);
  assert.equal(parsed.stats.passedCount, 3);
  assert.equal(parsed.stats.failedCount, 0);
  assert.equal(parsed.findings.length, 0);
});

test('supports single <testsuite> root and decodes CDATA and XML entities', () => {
  const xml = `<testsuite name="SingleSuite" tests="1" failures="1" time="0.25">
    <testcase classname="AppTest" name="checksHtml" time="0.25">
      <failure type="AssertionError" message="Expected &lt;ok&gt; &amp; got &quot;bad&quot;"><![CDATA[Stack line 1 <raw>]]></failure>
    </testcase>
  </testsuite>`;
  const parsed = parseJunitXml(xml, 'TEST-app.xml');
  assert.equal(parsed.stats.suiteCount, 1);
  assert.equal(parsed.rows[0].failureMessage, 'Expected <ok> & got "bad"');
  assert.match(parsed.rows[0].stackTrace, /Stack line 1 <raw>/);
});

test('JunitViewModel filters by status, slow threshold and search text', () => {
  const buf = fs.readFileSync(path.join(__dirname, '..', 'samples', 'junit.xml'));
  const parsed = parseJunitXml(buf, 'junit.xml');
  const vm = new JunitViewModel(parsed, 'junit.xml', buf.length);
  assert.equal(vm.setFilter({ text: '', status: 'failed' }), 1);
  assert.equal(vm.setFilter({ text: '', status: 'flaky' }), 1);
  assert.equal(vm.setFilter({ text: '', status: 'skipped' }), 1);
  assert.equal(vm.setFilter({ text: '', status: 'slow' }), 2);
  assert.equal(vm.setFilter({ text: 'jwks', status: '' }), 1);
  const det = vm.detail(2);
  assert.ok(det && det.stackTrace.includes('CheckoutController.charge'));
});

test('Pro report builders produce triage audit, diff, CSV and Markdown summary', () => {
  const baseline = parseJunitXml(fs.readFileSync(path.join(__dirname, '..', 'samples', 'clean.junit.xml')), 'clean.junit.xml');
  const current = parseJunitXml(fs.readFileSync(path.join(__dirname, '..', 'samples', 'junit.xml')), 'junit.xml');
  const audit = buildAuditMarkdown([{ fileName: 'junit.xml', parsed: current }]);
  assert.match(audit, /JUnit XML Failure & Slow-Test Triage Audit/);
  assert.match(audit, /rejectsExpiredCardToken/);
  const diff = buildDiffMarkdown('clean.junit.xml', baseline, 'junit.xml', current);
  assert.match(diff, /REGRESSION/);
  assert.match(diff, /Slowdown Regressions/);
  const csv = buildSummaryCsv(current);
  assert.match(csv, /^line,suite,classname,name,status,time_sec,reruns,failure_type,message/);
  const md = buildSummaryMarkdown(current, 'junit.xml');
  assert.match(md, /## Test Suites/);
});

test('editorHtml enforces strict CSP with nonce and no unsafe-inline', () => {
  const html = editorHtml({ cspSource: 'vscode-webview://test', script: 'v.js', styleUri: 'v.css', title: 'junit.xml', nonce: 'junit123' });
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-junit123'/);
  assert.doesNotMatch(csp('vscode-webview://test', 'junit123'), /unsafe-inline/);
});
