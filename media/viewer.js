/* global acquireVsCodeApi */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  let state = {
    name: '',
    summary: null,
    pageSize: 100,
    page: 0,
    total: 0,
    rows: [],
    selected: null,
    tab: 'cases',
    req: 0,
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function post(msg) {
    state.req += 1;
    vscode.postMessage({ ...msg, req: state.req });
  }

  function fmtSize(n) {
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
  }

  function fmtSec(sec) {
    const v = Number(sec) || 0;
    if (v >= 1) return `${v.toFixed(2)}s`;
    return `${Math.round(v * 1000)}ms`;
  }

  function statusClass(status) {
    if (status === 'failed' || status === 'error') return 'bad';
    if (status === 'passed') return 'ok';
    return 'warn-text';
  }

  function renderShell() {
    const s = state.summary;
    const failChip = s.failedCount > 0 ? `<span class="chip bad"><b>Failed:</b> ${s.failedCount}</span>` : '<span class="chip"><b>Failed:</b> 0</span>';
    const errChip = s.errorCount > 0 ? `<span class="chip bad"><b>Errors:</b> ${s.errorCount}</span>` : '';
    const flakyChip = s.flakyCount > 0 ? `<span class="chip warn"><b>Flaky:</b> ${s.flakyCount}</span>` : '';
    const skipChip = s.skippedCount > 0 ? `<span class="chip warn"><b>Skipped:</b> ${s.skippedCount}</span>` : '';

    app.innerHTML = `
      <div class="top">
        <div class="title">
          <span class="name">${esc(s.title || state.name)}</span>
          <span class="kind">JUNIT XML · ${s.suiteCount} suites · ${s.totalTimeSec.toFixed(2)}s · ${s.totalLines} lines · ${fmtSize(s.fileSize)} · 100% offline (no CI or cloud calls)</span>
        </div>
        <div class="summary">
          <span class="chip"><b>Tests:</b> ${s.testCount}</span>
          <span class="chip"><b>Passed:</b> ${s.passedCount} (${s.passRate}%)</span>
          ${failChip}${errChip}${flakyChip}${skipChip}
        </div>
        <div class="toolbar">
          <input id="q" type="search" placeholder="Filter by testcase, class, suite or failure..." />
          <select id="statusFilter">
            <option value="">All test cases</option>
            <option value="failed">Failed</option>
            <option value="error">Errors</option>
            <option value="flaky">Flaky</option>
            <option value="skipped">Skipped</option>
            <option value="slow">Slow (&gt;= 1.0s)</option>
            <option value="passed">Passed</option>
          </select>
          <button id="filterBtn" type="button">Filter</button>
          <span class="sep"></span>
          <div id="protools"></div>
        </div>
        <div class="tabs">
          <button class="tab on" data-tab="cases" type="button">Test Cases (${s.testCount})</button>
          <button class="tab" data-tab="slowest" type="button">Slowest Tests (${(s.slowest || []).length})</button>
          <button class="tab" data-tab="suites" type="button">Test Suites (${s.suiteCount})</button>
          <button class="tab" data-tab="findings" type="button">Findings (${(s.findings || []).length})</button>
        </div>
        <div id="hint" class="hint"></div>
      </div>
      <div class="main">
        <div id="leftPane" class="tablewrap"></div>
        <div id="detail" class="detail"><p class="muted">Select a test case to inspect its stack trace, failure message, stdout and suite metadata.</p></div>
      </div>
      <div class="pager">
        <button id="prev" type="button">Prev</button>
        <span id="pageInfo"></span>
        <button id="next" type="button">Next</button>
      </div>
    `;

    const q = document.getElementById('q');
    const stSel = document.getElementById('statusFilter');
    const runFilter = () => {
      state.page = 0;
      post({ type: 'filter', filter: { text: q.value, status: stSel.value } });
    };
    document.getElementById('filterBtn').addEventListener('click', runFilter);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') runFilter(); });
    stSel.addEventListener('change', runFilter);

    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((b) => b.classList.remove('on'));
        btn.classList.add('on');
        state.tab = btn.dataset.tab;
        renderPane();
      });
    });

    document.getElementById('prev').addEventListener('click', () => {
      if (state.page > 0) { state.page -= 1; loadPage(); }
    });
    document.getElementById('next').addEventListener('click', () => {
      if ((state.page + 1) * state.pageSize < state.total) { state.page += 1; loadPage(); }
    });
  }

  function loadPage() {
    post({ type: 'page', from: state.page * state.pageSize, n: state.pageSize });
  }

  function bindRowClicks(left) {
    left.querySelectorAll('tbody tr[data-idx]').forEach((tr) => {
      tr.addEventListener('click', () => {
        const idx = Number(tr.dataset.idx);
        state.selected = idx;
        left.querySelectorAll('tbody tr').forEach((row) => row.classList.toggle('sel', Number(row.dataset.idx) === idx));
        post({ type: 'detail', index: idx });
      });
    });
  }

  function renderPane() {
    const left = document.getElementById('leftPane');
    const pager = document.querySelector('.pager');
    const s = state.summary;

    if (state.tab === 'slowest') {
      pager.style.display = 'none';
      const rows = (s.slowest || []).map((r, i) => `<tr data-idx="${r.index}"${state.selected === r.index ? ' class="sel"' : ''}>
        <td class="num">#${i + 1}</td>
        <td class="num"><strong>${esc(fmtSec(r.timeSec))}</strong></td>
        <td><code>${esc(r.suite)}</code></td>
        <td><code>${esc(r.classname)}</code></td>
        <td><strong><code>${esc(r.name)}</code></strong></td>
        <td class="${statusClass(r.status)}">${esc(r.status.toUpperCase())}</td>
      </tr>`).join('');
      left.innerHTML = `<table id="grid">
        <thead><tr><th class="num">Rank</th><th class="num">Duration</th><th>Suite</th><th>Class</th><th>Test Case</th><th>Status</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">No test cases recorded.</td></tr>'}</tbody>
      </table>`;
      bindRowClicks(left);
      return;
    }

    if (state.tab === 'suites') {
      pager.style.display = 'none';
      const rows = (s.suites || []).map((su) => `<tr>
        <td class="num">${su.line}</td>
        <td><strong><code>${esc(su.name)}</code></strong></td>
        <td class="num">${su.tests}</td>
        <td class="num ok">${su.passed}</td>
        <td class="num ${su.failed + su.errors > 0 ? 'bad' : ''}">${su.failed + su.errors}</td>
        <td class="num">${su.skipped}</td>
        <td class="num">${esc(fmtSec(su.timeSec))}</td>
      </tr>`).join('');
      left.innerHTML = `<table id="grid">
        <thead><tr><th class="num">Line</th><th>Suite</th><th class="num">Tests</th><th class="num">Pass</th><th class="num">Fail/Err</th><th class="num">Skip</th><th class="num">Time</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="muted">No test suites found.</td></tr>'}</tbody>
      </table>`;
      return;
    }

    if (state.tab === 'findings') {
      pager.style.display = 'none';
      const fRows = (s.findings || []).map((f) => `<tr>
        <td class="${f.severity === 'error' ? 'bad' : ''}">${esc(f.severity.toUpperCase())}</td>
        <td>${esc(f.category)}</td>
        <td><code>${esc(f.rule)}</code></td>
        <td class="num">${f.line}</td>
        <td><code>${esc(f.section)}</code></td>
        <td>${esc(f.message)}</td>
      </tr>`).join('');
      left.innerHTML = fRows
        ? `<table id="grid"><thead><tr><th>Severity</th><th>Category</th><th>Rule</th><th class="num">Line</th><th>Scope</th><th>Finding</th></tr></thead><tbody>${fRows}</tbody></table>`
        : '<p class="muted" style="padding:12px;">All test cases passed with no warnings.</p>';
      return;
    }

    pager.style.display = 'flex';
    const body = state.rows.map((r) => {
      const sel = state.selected === r.index ? ' class="sel"' : '';
      const slowBadge = r.isSlow ? '<span class="badge-muted">SLOW</span>' : '';
      const rerunBadge = r.rerunCount ? `<span class="badge-muted">RERUN ${r.rerunCount}x</span>` : '';
      return `<tr data-idx="${r.index}"${sel}>
        <td class="num">${r.line}</td>
        <td class="${statusClass(r.status)}"><strong>${esc(r.status.toUpperCase())}</strong></td>
        <td><strong><code>${esc(r.name)}</code></strong>${slowBadge}${rerunBadge}</td>
        <td><code>${esc(r.classname)}</code></td>
        <td class="num"><code>${esc(fmtSec(r.timeSec))}</code></td>
        <td><code>${esc(r.failureMessage || r.suite)}</code></td>
      </tr>`;
    }).join('');
    left.innerHTML = `<table id="grid">
      <thead><tr><th class="num">Line</th><th>Status</th><th>Test Case</th><th>Class</th><th class="num">Time</th><th>Failure / Suite</th></tr></thead>
      <tbody>${body || '<tr><td colspan="6" class="muted">No matching test cases.</td></tr>'}</tbody>
    </table>`;
    bindRowClicks(left);

    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    document.getElementById('pageInfo').textContent = `Page ${state.page + 1} of ${pages} (${state.total} test cases)`;
    document.getElementById('prev').disabled = state.page <= 0;
    document.getElementById('next').disabled = (state.page + 1) * state.pageSize >= state.total;
  }

  function renderDetail(d) {
    const el = document.getElementById('detail');
    if (!d) {
      el.innerHTML = '<p class="muted">No test case selected.</p>';
      return;
    }
    const attrRows = (d.attrs || []).map((a) => `<tr><td><strong>${esc(a.key)}</strong></td><td><code>${esc(a.value)}</code></td></tr>`).join('');
    const traceHtml = d.stackTrace
      ? `<div class="attr-head"><strong>Stack Trace</strong></div><pre class="trace">${esc(d.stackTrace)}</pre>`
      : '';
    const outHtml = d.systemOut
      ? `<div class="attr-head"><strong>System Out</strong></div><pre class="trace">${esc(d.systemOut)}</pre>`
      : '';
    const errHtml = d.systemErr
      ? `<div class="attr-head"><strong>System Err</strong></div><pre class="trace">${esc(d.systemErr)}</pre>`
      : '';

    el.innerHTML = `
      <div class="dhead"><strong>Line ${d.line}: ${esc(d.name)}</strong><span class="${statusClass(d.status)}">${esc(d.status.toUpperCase())}</span></div>
      <table class="splits"><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>${attrRows}</tbody></table>
      ${traceHtml}${outHtml}${errHtml}
    `;
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'init':
        if (m.error) {
          app.innerHTML = `<div class="error"><strong>Could not open ${esc(m.name)}</strong><p>${esc(m.error)}</p></div>`;
          return;
        }
        state.name = m.name;
        state.summary = m.summary;
        state.pageSize = m.pageSize || 100;
        state.page = 0;
        renderShell();
        loadPage();
        return;
      case 'pageResult':
        state.total = m.total;
        state.rows = m.rows || [];
        renderPane();
        if (state.rows.length && state.selected == null) {
          state.selected = state.rows[0].index;
          post({ type: 'detail', index: state.selected });
        }
        return;
      case 'filterResult':
        state.total = m.count;
        document.getElementById('hint').textContent = m.count < m.total ? `Showing ${m.count} of ${m.total} test cases.` : '';
        loadPage();
        return;
      case 'detailResult':
        renderDetail(m.detail);
        return;
      case 'zovoAlso': {
        const anchor = m.anchor && document.getElementById(m.anchor);
        if (anchor && m.html) {
          const old = document.querySelector('.zovo-also');
          if (old) old.remove();
          anchor.insertAdjacentHTML('afterend', m.html);
        }
        return;
      }
      case 'hint':
        if (document.getElementById('hint')) document.getElementById('hint').textContent = m.text || '';
        return;
      default:
    }
  });

  post({ type: 'ready' });
})();
