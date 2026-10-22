const test = require('node:test');
const assert = require('node:assert/strict');
const { frontendChanged } = require('../src/desktop-update-status');
test('only a different published build offers a desktop update', () => {
 const local = { assets: { 'app:/static/js/main.abc.js': {} } };
 assert.equal(frontendChanged(local, {files:{'main.js':'/static/js/main.abc.js'}}), false);
 assert.equal(frontendChanged(local, {files:{'main.js':'/static/js/main.def.js'}}), true);
 assert.equal(frontendChanged(local, {}), false);
});
