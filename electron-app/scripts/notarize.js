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
const { execFileSync } = require('child_process');
const path = require('path');

/**
 * Ad-hoc sign the bundle when there is no Developer ID.
 *
 * WHY THIS IS NOT OPTIONAL. Without it the packaged app keeps stock Electron's
 * LINKER-ONLY signature and Electron's own identifier:
 *   Identifier=Electron   flags=0x20002(adhoc,linker-signed)
 * and `spctl -a` reports "notarization indicates this code has been REVOKED".
 * macOS then treats the app as known malware rather than merely unknown: Sequoia
 * shows "SINGULANCE.app was not opened because it contains malware" and XProtect
 * MOVES IT TO THE TRASH. Clearing the quarantine attribute cannot help, because
 * this is a revoked-ticket match, not an unidentified-developer warning.
 *
 * Re-signing ad-hoc under our own identifier gives the bundle a fresh CDHash, so
 * it no longer matches that revoked ticket. `spctl` then downgrades from
 * "revoked" to a plain "rejected" — the ordinary un-notarized state a user can
 * accept via right-click → Open. Measured on 2.1.0.
 *
 * A floor, not a substitute for notarization: when the Apple secrets are present
 * the real Developer ID signature runs first and this is skipped entirely.
 */
function adhocSign(appPath) {
  try {
    execFileSync('codesign', [
      '--force', '--deep', '--sign', '-',
      '--identifier', 'com.singulancelabs.desktop',
      '--options', 'runtime',
      '--entitlements', path.join(__dirname, '..', 'entitlements.mac.plist'),
      appPath,
    ], { stdio: 'pipe' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
    console.log('• adhoc-sign: signed + verified (identifier com.singulancelabs.desktop)');
  } catch (err) {
    // Loud, never fatal — a failed ad-hoc signature must not break the build; it
    // only leaves the app in the state it would have been in without this hook.
    console.warn('• adhoc-sign: FAILED —', String(err.stderr || err.message).slice(0, 300));
  }
}

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('• notarize: skipped (no APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID) — unsigned build');
    adhocSign(appPath); // stop macOS deleting it as revoked-Electron malware
    return;
  }

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
