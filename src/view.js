'use strict';
// View model for JUnit XML Test Report Viewer: pagination, search/filter, suites, slowest tests and stack traces.

class JunitViewModel {
  constructor(parsed, name, fileSize) {
    this.parsed = parsed;
    this.name = name;
    this.fileSize = fileSize;
    this.filter = { text: '', status: '' };
    this.filtered = parsed.rows.slice();
  }

  summary() {
    const p = this.parsed;
    const s = p.stats;
    return {
      name: this.name,
      fileSize: this.fileSize,
      title: p.title,
      totalLines: p.totalLines,
      suiteCount: s.suiteCount,
      testCount: s.testCount,
      passedCount: s.passedCount,
      failedCount: s.failedCount,
      errorCount: s.errorCount,
      skippedCount: s.skippedCount,
      flakyCount: s.flakyCount,
      slowCount: s.slowCount,
      passRate: s.passRate,
      totalTimeSec: s.totalTimeSec,
      findingErrors: s.findingErrors,
      findingWarnings: s.findingWarnings,
      suites: p.suites,
      slowest: p.slowest,
      findings: p.findings,
    };
  }

  totalCount() {
    return this.parsed.rows.length;
  }

  count() {
    return this.filtered.length;
  }

  setFilter(f) {
    const text = f && typeof f.text === 'string' ? f.text.trim().toLowerCase() : '';
    const status = f && typeof f.status === 'string' ? f.status.trim() : '';
    this.filter = { text, status };
    this.filtered = this.parsed.rows.filter((r) => {
      if (status === 'failed' && r.status !== 'failed') return false;
      if (status === 'error' && r.status !== 'error') return false;
      if (status === 'flaky' && r.status !== 'flaky') return false;
      if (status === 'skipped' && r.status !== 'skipped') return false;
      if (status === 'passed' && r.status !== 'passed') return false;
      if (status === 'slow' && !r.isSlow) return false;
      if (text) {
        const hay = `${r.suite} ${r.classname} ${r.name} ${r.status} ${r.failureType} ${r.failureMessage}`.toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
    return this.filtered.length;
  }

  rows(from, limit) {
    const start = Math.max(0, Number(from) || 0);
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.filtered.slice(start, start + n).map((r) => ({
      index: r.index,
      line: r.line,
      suite: r.suite,
      classname: r.classname,
      name: r.name,
      timeSec: r.timeSec,
      status: r.status,
      isSlow: r.isSlow,
      rerunCount: r.rerunCount,
      failureMessage: r.failureMessage,
      errorCount: r.errorCount,
      warningCount: r.warningCount,
    }));
  }

  detail(index) {
    const r = this.parsed.rows.find((x) => x.index === index) || this.parsed.rows[0] || null;
    if (!r) return null;
    return {
      index: r.index,
      line: r.line,
      suite: r.suite,
      classname: r.classname,
      name: r.name,
      timeSec: r.timeSec,
      status: r.status,
      rerunCount: r.rerunCount,
      failureType: r.failureType,
      failureMessage: r.failureMessage,
      stackTrace: r.stackTrace,
      systemOut: r.systemOut,
      systemErr: r.systemErr,
      findings: r.findings,
      attrs: r.attrs,
    };
  }
}

module.exports = { JunitViewModel };
