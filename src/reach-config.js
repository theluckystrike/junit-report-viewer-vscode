'use strict';
module.exports = {
  prefix: 'zovoJunit',
  triesKey: 'zovoJunit.proTrial',
  slot: '#protools',
  tools: [
    { id: 'auditTestSuite', title: 'Audit test failures and slow tests', command: 'zovoJunit.auditTestSuite' },
    { id: 'diffReports', title: 'Compare two JUnit XML reports', command: 'zovoJunit.diffReports' },
    { id: 'exportSummaryCsv', title: 'Export test summary CSV and report', command: 'zovoJunit.exportSummaryCsv' },
  ],
};
