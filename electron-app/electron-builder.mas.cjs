const base = require('./package.json').build;

module.exports = {
  ...base,
  forceCodeSigning: true,
  buildVersion: process.env.SINGULANCE_MAS_BUILD_NUMBER,
  afterSign: 'scripts/verify-mas-signature.cjs',
  publish: null,
  files: [...base.files,
    '!src/agent-browser-mcp.mjs', '!src/managed-agent-browser.js', '!src/notch*', '!src/local-preview-main.js',
    '!node_modules/electron-updater/**/*', '!node_modules/playwright/**/*', '!node_modules/playwright-core/**/*',
    '!node_modules/@modelcontextprotocol/**/*'],
  mac: { ...base.mac, target: [{ target: 'mas', arch: ['universal'] }], hardenedRuntime: false, notarize: false },
  mas: {
    type: 'distribution',
    identity: process.env.SINGULANCE_APPLE_TEAM_ID,
    provisioningProfile: process.env.SINGULANCE_MAS_PROVISIONING_PROFILE,
    entitlements: 'entitlements.mas.plist',
    entitlementsInherit: 'entitlements.mas.inherit.plist',
    hardenedRuntime: false,
    strictVerify: true,
    gatekeeperAssess: false,
    extendInfo: {
      ElectronTeamID: process.env.SINGULANCE_APPLE_TEAM_ID,
      NSMicrophoneUsageDescription: 'SINGULANCE uses the microphone only when you choose voice input in your workspace.',
    },
  },
};
