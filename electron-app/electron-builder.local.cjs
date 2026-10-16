const base = require('./package.json').build;

module.exports = {
  ...base,
  appId: 'com.singulancelabs.desktop.localtest',
  productName: 'SINGULANCE Local Test',
  extraMetadata: { main: 'src/local-preview-main.js', singulanceReleaseChannel: 'local-test', name: 'singulance-local-test' },
  protocols: [{ name: 'SINGULANCE Local Test', schemes: ['singulance-local-test'] }],
  directories: { ...base.directories, output: 'dist-local' },
  afterSign: null,
  forceCodeSigning: false,
  publish: null,
  npmRebuild: false,
  mac: { ...base.mac, target: [{ target: 'dir', arch: ['arm64'] }], identity: '-', notarize: false },
  files: [...base.files, 'test/in-app-browser.electron.cjs',
    '!src/agent-browser-mcp.mjs', '!src/managed-agent-browser.js', '!src/notch*',
    '!node_modules/electron-updater/**/*', '!node_modules/playwright/**/*', '!node_modules/playwright-core/**/*',
    '!node_modules/@modelcontextprotocol/**/*'],
};
