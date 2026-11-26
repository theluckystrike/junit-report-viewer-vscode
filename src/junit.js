'use strict';
// Offline JUnit XML parser, static test-suite analyzer and Pro report builders.
// Zero external dependencies, zero CI server or cloud calls.

const SLOW_TEST_WARN_SEC = 1.0;
const SLOW_TEST_ERROR_SEC = 5.0;

function decodeEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function lineAtOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function parseAttrs(raw) {
  const attrs = {};
  if (!raw) return attrs;
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

function parseXmlNodes(xmlText) {
  const root = { tag: '#root', attrs: {}, children: [], text: '', line: 1 };
  const stack = [root];
  const tokenRe = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;
  let lastIndex = 0;
  let m;
  while ((m = tokenRe.exec(xmlText)) !== null) {
    if (m.index > lastIndex) {
      const chunk = xmlText.slice(lastIndex, m.index);
      stack[stack.length - 1].text += chunk;
    }
    lastIndex = tokenRe.lastIndex;
    const raw = m[0];
    if (raw.startsWith('<![CDATA[')) {
      stack[stack.length - 1].text += raw.slice(9, -3);
      continue;
    }
    if (raw.startsWith('<!--') || raw.startsWith('<?') || raw.startsWith('<!DOCTYPE')) {
      continue;
    }
    if (m[1]) {
      const closeTag = m[1];
      for (let i = stack.length - 1; i >= 1; i -= 1) {
        if (stack[i].tag === closeTag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const tag = m[2];
    const attrStr = m[3] || '';
    const selfClosing = m[4] === '/';
    const node = {
      tag,
      attrs: parseAttrs(attrStr),
      children: [],
      text: '',
      line: lineAtOffset(xmlText, m.index),
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (lastIndex < xmlText.length) {
    stack[stack.length - 1].text += xmlText.slice(lastIndex);
  }
  return root;
}

function num(v, fallback = 0) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function collectSuites(node, out) {
  if (!node) return;
  if (node.tag === 'testsuite') {
    out.push(node);
    for (const ch of node.children) {
      if (ch.tag === 'testsuite') collectSuites(ch, out);
    }
    return;
  }
  for (const ch of node.children) collectSuites(ch, out);
}

function parseJunitXml(input, fileName = 'junit.xml') {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
  const trimmed = text.trim();
  if (!trimmed) throw new Error('File is empty.');
  if (!trimmed.startsWith('<')) {
    throw new Error(`File "${fileName}" does not appear to be valid XML.`);
  }

  const root = parseXmlNodes(text);
  const topTags = root.children.map((c) => c.tag);
  if (!topTags.includes('testsuites') && !topTags.includes('testsuite')) {
    throw new Error(`Expected <testsuites> or <testsuite> root element in "${fileName}", found <${topTags[0] || 'none'}>.`);
  }

  const suitesRoot = root.children.find((c) => c.tag === 'testsuites');
  const suiteNodes = [];
  collectSuites(root, suiteNodes);

  const suites = [];
  const rows = [];
  const findings = [];
  let rowIndex = 0;

  let passedCount = 0;
  let failedCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  let flakyCount = 0;
  let slowCount = 0;
  let totalTimeSec = 0;

  for (const sNode of suiteNodes) {
    const sa = sNode.attrs;
    const suiteName = sa.name || sa.id || '(unnamed suite)';
    const suiteCases = sNode.children.filter((c) => c.tag === 'testcase');
    let sPass = 0;
    let sFail = 0;
    let sErr = 0;
    let sSkip = 0;
    let sFlaky = 0;
    let sTime = 0;

    const propsNode = sNode.children.find((c) => c.tag === 'properties');
    const properties = propsNode
      ? propsNode.children.filter((p) => p.tag === 'property').map((p) => ({
        name: p.attrs.name || '',
        value: p.attrs.value !== undefined ? p.attrs.value : decodeEntities(p.text).trim(),
      }))
      : [];

    if (suiteCases.length === 0 && num(sa.tests, 0) === 0) {
      findings.push({
        severity: 'warning',
        category: 'Coverage',
        rule: 'empty-suite',
        line: sNode.line,
        section: suiteName,
        message: `Test suite "${suiteName}" contains 0 test cases.`,
      });
    }

    for (const tc of suiteCases) {
      rowIndex += 1;
      const ta = tc.attrs;
      const name = ta.name || `(testcase #${rowIndex})`;
      const classname = ta.classname || suiteName;
      const hasTime = ta.time !== undefined && ta.time !== '';
      const timeSec = Math.max(0, num(ta.time, 0));
      sTime += timeSec;

      const failureNode = tc.children.find((c) => c.tag === 'failure');
      const errorNode = tc.children.find((c) => c.tag === 'error');
      const skippedNode = tc.children.find((c) => c.tag === 'skipped');
      const flakyNodes = tc.children.filter((c) => c.tag === 'flakyFailure' || c.tag === 'flakyError' || c.tag === 'rerunFailure' || c.tag === 'rerunError');
      const sysOutNode = tc.children.find((c) => c.tag === 'system-out');
      const sysErrNode = tc.children.find((c) => c.tag === 'system-err');

      let status = 'passed';
      let failureType = '';
      let failureMessage = '';
      let stackTrace = '';

      if (errorNode) {
        status = 'error';
        errorCount += 1;
        sErr += 1;
        failureType = errorNode.attrs.type || 'Error';
        failureMessage = errorNode.attrs.message || '';
        stackTrace = decodeEntities(errorNode.text).trim();
      } else if (failureNode) {
        status = 'failed';
        failedCount += 1;
        sFail += 1;
        failureType = failureNode.attrs.type || 'AssertionError';
        failureMessage = failureNode.attrs.message || '';
        stackTrace = decodeEntities(failureNode.text).trim();
      } else if (skippedNode) {
        status = 'skipped';
        skippedCount += 1;
        sSkip += 1;
        failureType = skippedNode.attrs.type || 'Skipped';
        failureMessage = skippedNode.attrs.message || decodeEntities(skippedNode.text).trim();
      } else if (flakyNodes.length > 0) {
        status = 'flaky';
        flakyCount += 1;
        sFlaky += 1;
        const first = flakyNodes[0];
        failureType = first.attrs.type || first.tag;
        failureMessage = first.attrs.message || `Passed after ${flakyNodes.length} rerun(s)`;
        stackTrace = decodeEntities(first.text).trim();
      } else {
        passedCount += 1;
        sPass += 1;
      }

      const rowFindings = [];
      if (status === 'failed') {
        rowFindings.push({
          severity: 'error',
          category: 'Failure',
          rule: 'failed-testcase',
          line: tc.line,
          section: `${classname}.${name}`,
          message: failureMessage || `Test "${name}" failed (${failureType}).`,
        });
      } else if (status === 'error') {
        rowFindings.push({
          severity: 'error',
          category: 'Error',
          rule: 'error-testcase',
          line: tc.line,
          section: `${classname}.${name}`,
          message: failureMessage || `Test "${name}" threw an unhandled error (${failureType}).`,
        });
      } else if (status === 'flaky') {
        rowFindings.push({
          severity: 'warning',
          category: 'Stability',
          rule: 'flaky-testcase',
          line: tc.line,
          section: `${classname}.${name}`,
          message: `Test "${name}" required ${flakyNodes.length} rerun(s) before passing.`,
        });
      } else if (status === 'skipped') {
        rowFindings.push({
          severity: 'warning',
          category: 'Coverage',
          rule: 'skipped-testcase',
          line: tc.line,
          section: `${classname}.${name}`,
          message: failureMessage ? `Skipped: ${failureMessage}` : `Test "${name}" was skipped.`,
        });
      }

      if (timeSec >= SLOW_TEST_ERROR_SEC) {
        slowCount += 1;
        rowFindings.push({
          severity: 'warning',
          category: 'Performance',
          rule: 'slow-testcase',
          line: tc.line,
          section: `${classname}.${name}`,
          message: `Slow test took ${timeSec.toFixed(3)}s (threshold ${SLOW_TEST_ERROR_SEC}s).`,
        });
      } else if (timeSec >= SLOW_TEST_WARN_SEC) {
        slowCount += 1;
      }

      if (!hasTime && status !== 'skipped') {
        rowFindings.push({
          severity: 'warning',
          category: 'Metadata',
          rule: 'missing-duration',
          line: tc.line,
          section: `${classname}.${name}`,
          message: `Test "${name}" has no time attribute.`,
        });
      }

      for (const f of rowFindings) findings.push(f);

      const sysOut = sysOutNode ? decodeEntities(sysOutNode.text).trim() : '';
      const sysErr = sysErrNode ? decodeEntities(sysErrNode.text).trim() : '';

      const attrs = [
        { key: 'Suite', value: suiteName },
        { key: 'Class', value: classname },
        { key: 'Duration', value: `${timeSec.toFixed(3)}s` },
        { key: 'Status', value: status.toUpperCase() },
      ];
      if (ta.file) attrs.push({ key: 'File', value: ta.file });
      if (ta.line) attrs.push({ key: 'Source Line', value: ta.line });
      if (failureType) attrs.push({ key: 'Failure Type', value: failureType });
      if (failureMessage) attrs.push({ key: 'Message', value: failureMessage });
      if (flakyNodes.length) attrs.push({ key: 'Reruns', value: String(flakyNodes.length) });

      rows.push({
        index: rowIndex,
        line: tc.line,
        suite: suiteName,
        classname,
        name,
        timeSec,
        status,
        isSlow: timeSec >= SLOW_TEST_WARN_SEC,
        rerunCount: flakyNodes.length,
        failureType,
        failureMessage,
        stackTrace,
        systemOut: sysOut,
        systemErr: sysErr,
        detailText: failureMessage || `${timeSec.toFixed(3)}s`,
        errorCount: rowFindings.filter((f) => f.severity === 'error').length,
        warningCount: rowFindings.filter((f) => f.severity === 'warning').length,
        findings: rowFindings,
        attrs,
      });
    }

    const declaredTime = sa.time !== undefined && sa.time !== '' ? Math.max(0, num(sa.time, sTime)) : sTime;
    totalTimeSec += declaredTime;
    suites.push({
      line: sNode.line,
      name: suiteName,
      tests: suiteCases.length || num(sa.tests, 0),
      passed: sPass,
      failed: sFail,
      errors: sErr,
      skipped: sSkip,
      flaky: sFlaky,
      timeSec: declaredTime,
      timestamp: sa.timestamp || '',
      hostname: sa.hostname || '',
      properties,
      status: sFail > 0 || sErr > 0 ? 'failed' : (sFlaky > 0 || sSkip > 0 ? 'warning' : 'passed'),
    });
  }

  const slowest = rows
    .slice()
    .sort((a, b) => b.timeSec - a.timeSec)
    .slice(0, 25)
    .map((r) => ({
      index: r.index,
      line: r.line,
      suite: r.suite,
      classname: r.classname,
      name: r.name,
      timeSec: r.timeSec,
      status: r.status,
    }));

  const rootTitle = (suitesRoot && suitesRoot.attrs.name) || (suites.length === 1 ? suites[0].name : fileName);
  const totalLines = text.split(/\r?\n/).length;
  const totalTests = rows.length;
  const passRate = totalTests > 0 ? Number((((passedCount + flakyCount) / totalTests) * 100).toFixed(1)) : 100;

  return {
    fileName,
    title: rootTitle,
    totalLines,
    suites,
    rows,
    slowest,
    findings,
    stats: {
      suiteCount: suites.length,
      testCount: totalTests,
      passedCount,
      failedCount,
      errorCount,
      skippedCount,
      flakyCount,
      slowCount,
      passRate,
      totalTimeSec: Number(totalTimeSec.toFixed(3)),
      findingErrors: findings.filter((f) => f.severity === 'error').length,
      findingWarnings: findings.filter((f) => f.severity === 'warning').length,
    },
  };
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildAuditMarkdown(entries) {
  const lines = [
    '# JUnit XML Failure & Slow-Test Triage Audit',
    '',
    `Generated offline for ${entries.length} report(s). Zero CI or cloud calls.`,
    '',
  ];
  for (const { fileName, parsed } of entries) {
    const s = parsed.stats;
    lines.push(`## ${fileName}`);
    lines.push('');
    lines.push(`- **Suites:** ${s.suiteCount} | **Tests:** ${s.testCount} | **Pass rate:** ${s.passRate}% | **Total time:** ${s.totalTimeSec.toFixed(3)}s`);
    lines.push(`- **Passed:** ${s.passedCount} | **Failed:** ${s.failedCount} | **Errors:** ${s.errorCount} | **Flaky:** ${s.flakyCount} | **Skipped:** ${s.skippedCount}`);
    lines.push('');

    const broken = parsed.rows.filter((r) => r.status === 'failed' || r.status === 'error');
    lines.push(`### Failing & Errored Tests (${broken.length})`);
    lines.push('');
    if (!broken.length) {
      lines.push('No failing or errored tests.');
      lines.push('');
    } else {
      for (const r of broken) {
        lines.push(`#### [${r.status.toUpperCase()}] \`${r.classname}.${r.name}\` (${r.timeSec.toFixed(3)}s, line ${r.line})`);
        if (r.failureType || r.failureMessage) {
          lines.push(`- **${r.failureType || 'Failure'}:** ${r.failureMessage || '(no message)'}`);
        }
        if (r.stackTrace) {
          lines.push('```text');
          lines.push(r.stackTrace.slice(0, 2000));
          lines.push('```');
        }
        lines.push('');
      }
    }

    const flaky = parsed.rows.filter((r) => r.status === 'flaky');
    if (flaky.length) {
      lines.push(`### Flaky Tests (${flaky.length})`);
      lines.push('');
      lines.push('| Class | Test | Reruns | Duration (s) | Message |');
      lines.push('| --- | --- | ---: | ---: | --- |');
      for (const r of flaky) {
        lines.push(`| \`${r.classname}\` | \`${r.name}\` | ${r.rerunCount} | ${r.timeSec.toFixed(3)} | ${r.failureMessage.replace(/\|/g, '\\|')} |`);
      }
      lines.push('');
    }

    lines.push('### Slowest Tests Leaderboard (Top 10)');
    lines.push('');
    lines.push('| Rank | Suite | Test | Duration (s) | Status |');
    lines.push('| ---: | --- | --- | ---: | --- |');
    parsed.slowest.slice(0, 10).forEach((r, idx) => {
      lines.push(`| ${idx + 1} | \`${r.suite}\` | \`${r.name}\` | ${r.timeSec.toFixed(3)} | ${r.status.toUpperCase()} |`);
    });
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function buildDiffMarkdown(leftName, left, rightName, right) {
  const keyOf = (r) => `${r.classname}::${r.name}`;
  const lMap = new Map(left.rows.map((r) => [keyOf(r), r]));
  const rMap = new Map(right.rows.map((r) => [keyOf(r), r]));

  const newFailures = [];
  const fixed = [];
  const added = [];
  const removed = [];
  const slower = [];

  for (const [k, r] of rMap.entries()) {
    const l = lMap.get(k);
    if (!l) {
      added.push(r);
      if (r.status === 'failed' || r.status === 'error') newFailures.push({ prev: 'NEW', cur: r });
      continue;
    }
    const wasBad = l.status === 'failed' || l.status === 'error';
    const isBad = r.status === 'failed' || r.status === 'error';
    if (!wasBad && isBad) newFailures.push({ prev: l.status.toUpperCase(), cur: r });
    else if (wasBad && !isBad) fixed.push({ prev: l.status.toUpperCase(), cur: r });

    const delta = r.timeSec - l.timeSec;
    if (delta >= 0.5 && (l.timeSec === 0 || delta / l.timeSec >= 0.2)) {
      slower.push({ key: k, leftSec: l.timeSec, rightSec: r.timeSec, delta });
    }
  }
  for (const [k, l] of lMap.entries()) {
    if (!rMap.has(k)) removed.push(l);
  }
  slower.sort((a, b) => b.delta - a.delta);

  const ls = left.stats;
  const rs = right.stats;
  const lines = [
    '# JUnit XML Test Report Comparison',
    '',
    `- **Baseline:** \`${leftName}\` (${ls.testCount} tests, ${ls.failedCount} failed, ${ls.errorCount} errors, ${ls.totalTimeSec.toFixed(3)}s)`,
    `- **Current:** \`${rightName}\` (${rs.testCount} tests, ${rs.failedCount} failed, ${rs.errorCount} errors, ${rs.totalTimeSec.toFixed(3)}s)`,
    '',
    `## New Failures & Regressions (${newFailures.length})`,
    '',
  ];
  if (!newFailures.length) {
    lines.push('No new test failures or errors.');
  } else {
    for (const item of newFailures) {
      lines.push(`- **REGRESSION** \`${item.cur.classname}.${item.cur.name}\`: ${item.prev} -> ${item.cur.status.toUpperCase()} (${item.cur.failureMessage || item.cur.failureType || 'failed'})`);
    }
  }
  lines.push('', `## Fixed Tests (${fixed.length})`, '');
  if (!fixed.length) lines.push('No previously failing tests were fixed.');
  else for (const item of fixed) lines.push(`- **FIXED** \`${item.cur.classname}.${item.cur.name}\`: ${item.prev} -> ${item.cur.status.toUpperCase()}`);

  lines.push('', `## Slowdown Regressions >= +0.5s & +20% (${slower.length})`, '');
  if (!slower.length) {
    lines.push('No significant duration regressions.');
  } else {
    lines.push('| Test | Baseline (s) | Current (s) | Delta (s) |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const s of slower.slice(0, 25)) {
      lines.push(`| \`${s.key}\` | ${s.leftSec.toFixed(3)} | ${s.rightSec.toFixed(3)} | +${s.delta.toFixed(3)} |`);
    }
  }

  lines.push('', `## Added (${added.length}) & Removed (${removed.length}) Tests`, '');
  for (const a of added.slice(0, 25)) lines.push(`- Added \`${a.classname}.${a.name}\` (${a.status.toUpperCase()}, ${a.timeSec.toFixed(3)}s)`);
  for (const r of removed.slice(0, 25)) lines.push(`- Removed \`${r.classname}.${r.name}\` (was ${r.status.toUpperCase()})`);
  if (!added.length && !removed.length) lines.push('Test case inventory is unchanged.');
  return `${lines.join('\n')}\n`;
}

function buildSummaryCsv(parsed) {
  const header = 'line,suite,classname,name,status,time_sec,reruns,failure_type,message';
  const rows = parsed.rows.map((r) => [
    r.line,
    r.suite,
    r.classname,
    r.name,
    r.status,
    r.timeSec.toFixed(3),
    r.rerunCount,
    r.failureType,
    r.failureMessage,
  ].map(csvCell).join(','));
  return `${[header, ...rows].join('\n')}\n`;
}

function buildSummaryMarkdown(parsed, fileName) {
  const s = parsed.stats;
  const lines = [
    `# JUnit XML Test Summary: ${fileName}`,
    '',
    `- **Suites:** ${s.suiteCount} | **Total tests:** ${s.testCount} | **Pass rate:** ${s.passRate}% | **Total duration:** ${s.totalTimeSec.toFixed(3)}s`,
    `- **Passed:** ${s.passedCount} | **Failed:** ${s.failedCount} | **Errors:** ${s.errorCount} | **Flaky:** ${s.flakyCount} | **Skipped:** ${s.skippedCount}`,
    '',
    '## Test Suites',
    '',
    '| Suite | Tests | Passed | Failed | Errors | Flaky | Skipped | Time (s) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const su of parsed.suites) {
    lines.push(`| \`${su.name}\` | ${su.tests} | ${su.passed} | ${su.failed} | ${su.errors} | ${su.flaky} | ${su.skipped} | ${su.timeSec.toFixed(3)} |`);
  }
  lines.push('', '## Slowest Tests', '', '| Rank | Class | Test | Time (s) | Status |', '| ---: | --- | --- | ---: | --- |');
  parsed.slowest.slice(0, 15).forEach((r, idx) => {
    lines.push(`| ${idx + 1} | \`${r.classname}\` | \`${r.name}\` | ${r.timeSec.toFixed(3)} | ${r.status.toUpperCase()} |`);
  });
  return `${lines.join('\n')}\n`;
}

module.exports = {
  parseJunitXml,
  buildAuditMarkdown,
  buildDiffMarkdown,
  buildSummaryCsv,
  buildSummaryMarkdown,
  SLOW_TEST_WARN_SEC,
  SLOW_TEST_ERROR_SEC,
};
