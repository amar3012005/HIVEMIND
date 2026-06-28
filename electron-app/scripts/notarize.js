/**
 * electron-builder afterSign hook — notarize the macOS app with Apple.
 *
 * Robust by design: a NO-OP unless the Apple credentials are present, so local
 * and unsigned CI builds still succeed. When CI provides APPLE_ID +
 * APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID (and the app was Developer-ID
 * signed via CSC_LINK/CSC_KEY_PASSWORD), this notarizes + staples the ticket so
 * Gatekeeper opens the app cleanly AND Squirrel.Mac accepts auto-updates.
 */
const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('• notarize: skipped (no APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID) — unsigned build');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  console.log(`• notarize: submitting ${appName}.app to Apple…`);

  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log('• notarize: done (ticket stapled)');
};
