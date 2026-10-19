# Meeting companion — 2.3.0

Connect through your normal HIVEMIND account at api.singulancelabs.com. The extension uses core.singulancelabs.com and opens notes at next.singulancelabs.com/hivemind/app/meeting-notes.

Google Meet, Microsoft Teams, Zoom web meetings, Webex, and Jitsi show a companion prompt automatically. It works when the HIVEMIND website is closed. Other browser meeting sites can be recorded from **Open meeting companion** in the extension.

1. Open the companion and connect HIVEMIND.
2. Confirm that participants are informed and recording is permitted.
3. Start recording, choose the meeting tab, and enable **Share tab audio**. Include the microphone to capture your own voice.
4. Keep the companion window open (minimizing is fine). Private suggestions are available after transcript segments arrive; the extension never speaks to attendees or sends meeting chat messages.
5. Stop and save. The existing meeting service transcribes audio, finalizes notes, and makes them available in Meeting Notes. Processing can continue after the companion is closed once audio has uploaded.

Audio is saved in the extension's local IndexedDB until the authenticated server acknowledges each segment. After a browser interruption, reopen the companion with the same account/workspace and choose **Recover & finish**. Recovery cannot reconstruct audio that had not reached a completed recording segment before a crash (up to one minute). Closing Chrome stops recording; it is not a cloud meeting bot.

Recording works for supported browser tabs. Native desktop meeting apps and operating-system audio availability depend on Chrome's sharing picker and OS support. No CAPTCHA, login, microphone, or screen-sharing permission is bypassed.

The companion checks for a newer downloadable version every six hours. Chrome Web Store automatic distribution requires publishing through the existing store account; a ZIP does not silently update unpacked installations. For an unpacked installation, extract the ZIP, open chrome://extensions, enable Developer mode, choose Load unpacked, and select the extracted folder. Reload an existing unpacked extension after replacing its files. Finish active recording before updating.
