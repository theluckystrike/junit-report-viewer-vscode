'use strict';
// Pro tools for JUnit XML Test Report Viewer:
//   1. auditTestSuite: Offline Markdown failure, flaky and slow-test triage report.
//   2. diffReports: Compare two JUnit XML runs for regressions and fixed tests.
//   3. exportSummaryCsv: Non-destructive CSV test duration & status inventory + Markdown summary.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const {
  parseJunitXml,
  buildAuditMarkdown,
  buildDiffMarkdown,
  buildSummaryCsv,
  buildSummaryMarkdown,
} = require('./junit');

const REPORT_RE = /^(junit\.xml|.*\.junit\.xml|test-results\.xml|TEST-.*\.xml|surefire-.*\.xml)$/i;

function uniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let i = 1; i < 10000; i += 1) {
    const cand = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

async function resolveTargetUri(uri, provider, openLabel = 'Select JUnit XML report') {
  if (uri && uri.scheme) return uri;
  if (provider && provider.active && provider.active.uri) return provider.active.uri;
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document && REPORT_RE.test(path.basename(ed.document.uri.fsPath || ed.document.uri.path))) {
    return ed.document.uri;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel,
  });
  return picked && picked[0] ? picked[0] : null;
}

function listJunitFilesInDir(dirPath, maxDepth = 4) {
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isFile() && REPORT_RE.test(e.name)) out.push(full);
      else if (e.isDirectory() && depth < maxDepth) walk(full, depth + 1);
    }
  }
  walk(dirPath, 0);
  return out.sort();
}

function createTools({ provider, pro, reach }) {
  async function auditTestSuite(uri, opts = {}) {
    if (!(await pro.allowed('auditTestSuite', opts))) return undefined;
    const target = await resolveTargetUri(uri, provider);
    if (!target) return undefined;

    const targetPath = target.fsPath;
    const isDir = target.scheme === 'file' && fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
    const files = isDir ? listJunitFilesInDir(targetPath) : [targetPath];
    if (!files.length) {
      vscode.window.showInformationMessage('No JUnit XML reports were found in this folder.');
      return undefined;
    }

    const entries = [];
    for (const f of files) {
      const buf = f === targetPath && target.scheme !== 'file'
        ? Buffer.from(await vscode.workspace.fs.readFile(target))
        : fs.readFileSync(f);
      const label = isDir ? path.relative(targetPath, f) : path.basename(f);
      entries.push({ fileName: label, parsed: parseJunitXml(buf, label) });
    }
    const md = buildAuditMarkdown(entries);
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('auditTestSuite');
    if (reach) reach.refresh();
    return { files: files.length, markdown: md };
  }

  async function diffReports(uri, opts = {}) {
    if (!(await pro.allowed('diffReports', opts))) return undefined;
    const left = await resolveTargetUri(uri, provider, 'Select baseline JUnit XML report');
    if (!left) return undefined;

    let right = opts.compareUri || null;
    if (!right) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select second JUnit XML report to compare',
      });
      right = picked && picked[0] ? picked[0] : null;
    }
    if (!right) return undefined;

    const leftBuf = Buffer.from(await vscode.workspace.fs.readFile(left));
    const rightBuf = Buffer.from(await vscode.workspace.fs.readFile(right));
    const leftName = path.basename(left.fsPath || left.path);
    const rightName = path.basename(right.fsPath || right.path);
    const md = buildDiffMarkdown(
      leftName,
      parseJunitXml(leftBuf, leftName),
      rightName,
      parseJunitXml(rightBuf, rightName),
    );
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('diffReports');
    if (reach) reach.refresh();
    return { markdown: md };
  }

  async function exportSummaryCsv(uri, opts = {}) {
    if (!(await pro.allowed('exportSummaryCsv', opts))) return undefined;
    const target = await resolveTargetUri(uri, provider);
    if (!target) return undefined;

    const targetPath = target.fsPath;
    const bytes = await vscode.workspace.fs.readFile(target);
    const baseName = path.basename(targetPath);
    const parsed = parseJunitXml(Buffer.from(bytes), baseName);
    const stemRaw = baseName.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'junit';
    const defaultOut = uniquePath(path.join(path.dirname(targetPath), `${stemRaw}.summary.csv`));
    const saveUri = opts.outPath
      ? vscode.Uri.file(uniquePath(opts.outPath))
      : await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultOut),
        filters: { 'CSV Test Summary': ['csv'] },
        saveLabel: 'Save test summary CSV and report',
      });
    if (!saveUri) return undefined;

    const csvPath = uniquePath(saveUri.fsPath);
    const dir = path.dirname(csvPath);
    const stem = path.basename(csvPath, '.csv').replace(/\.summary$/i, '');
    const mdPath = uniquePath(path.join(dir, `${stem}.summary.md`));

    fs.writeFileSync(csvPath, buildSummaryCsv(parsed), 'utf8');
    fs.writeFileSync(mdPath, buildSummaryMarkdown(parsed, baseName), 'utf8');

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('exportSummaryCsv');
    if (reach) reach.refresh();
    return { files: [csvPath, mdPath], rows: parsed.stats.testCount };
  }

  return { auditTestSuite, diffReports, exportSummaryCsv };
}

module.exports = { createTools, uniquePath, listJunitFilesInDir };
