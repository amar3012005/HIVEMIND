const metadata = require('../package.json');
module.exports = { isLocalTest: metadata.singulanceReleaseChannel === 'local-test' };
