const { isLocalTest } = require('./release-channel');
if (!isLocalTest) throw new Error('The local test entry point is not enabled in this release');
const index = process.argv.indexOf('--singulance-local-smoke');
if (index !== -1) {
  const fs = require('node:fs');
  const path = require('node:path');
  const directory = process.argv[index + 1];
  if (!directory || !path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) throw new Error('Pass the existing absolute local QA evidence directory');
  process.env.SINGULANCE_QA_EVIDENCE_DIR = directory;
  require('../test/in-app-browser.electron.cjs');
} else if (process.argv.includes('--singulance-frontend-smoke')) {
  require('../test/bundled-frontends.electron.cjs');
} else {
  require('./main');
}
