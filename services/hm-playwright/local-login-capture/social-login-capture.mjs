#!/usr/bin/env node
// Run this on YOUR OWN machine — it needs a real display. It opens a real,
// visible browser window, YOU log in manually (type your own password, solve
// your own 2FA/CAPTCHA), and once you confirm, it saves the resulting session
// (cookies + localStorage) to a file. That file is then copied to the server
// so hm-playwright can reuse it for read-only crawl/screenshot calls — it
// never sees, stores, or handles your actual credentials.
//
// This is deliberately screenshot/crawl-only in intent: nothing here scripts
// clicks, posts, follows, or messages. It only resumes a session you already
// created, to look at pages that would otherwise show a login wall.
//
// Setup (once): npm init -y && npm install playwright && npx playwright install chromium
// Usage:        node social-login-capture.mjs <x|instagram|linkedin>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

const PLATFORMS = {
  x: 'https://x.com/login',
  instagram: 'https://www.instagram.com/accounts/login/',
  linkedin: 'https://www.linkedin.com/login',
};

const platform = process.argv[2];
if (!PLATFORMS[platform]) {
  console.error(`Usage: node social-login-capture.mjs <${Object.keys(PLATFORMS).join('|')}>`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${platform}.json`);

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(PLATFORMS[platform]);

console.log(`\nA real browser window opened to ${platform}'s login page.`);
console.log('Log in exactly as you normally would — this script never sees your password.');
console.log('Once you are fully logged in and see your feed/profile, come back here and press Enter.\n');

await new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin });
  rl.question('Press Enter once logged in... ', () => { rl.close(); resolve(); });
});

await context.storageState({ path: outFile });
await browser.close();

console.log(`\nSaved session -> ${outFile}`);
console.log('This file grants access to your account — treat it exactly like a password:');
console.log('  - never commit it to git, never paste it anywhere, never send it over plain HTTP.');
console.log('Copy it to the server over SSH, then delete your local copy once confirmed:');
console.log(`  scp ${outFile} <ssh-alias>:/root/hivemind/services/hm-playwright/sessions/${platform}.json\n`);
console.log('Sessions expire. Re-run this script for the same platform whenever crawls start');
console.log('coming back as a login page instead of real content.');
