/** White-label visible DSH product copy to SINGULANCE. Do not touch __DSH_* wires. */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = '/opt/deepseek-harness';
const replacements = [
  ['DSH Local Build', 'SINGULANCE'],
  ['DSH 本地构建', 'SINGULANCE'],
  ['DeepSeek Harness', 'SINGULANCE'],
  ['dsh web', 'SINGULANCE'],
  ['DSH plugin ecosystem', 'SINGULANCE'],
  ['Harness developers', 'SINGULANCE'],
  ['Configure the official DeepSeek provider to start building.', 'Add a model provider in Settings to start.'],
  ['配置 DeepSeek 官方模型，即可开始使用。', '在设置中添加模型提供方后即可开始。'],
];

function rewriteFile(file) {
  let text = fs.readFileSync(file, 'utf8');
  const before = text;
  for (const [from, to] of replacements) text = text.split(from).join(to);
  if (text !== before) fs.writeFileSync(file, text);
}

const distIndex = path.join(ROOT, 'apps/web/dist/index.html');
if (fs.existsSync(distIndex)) {
  let html = fs.readFileSync(distIndex, 'utf8');
  html = html.replace(/<title>[^<]*<\/title>/, '<title>SINGULANCE</title>');
  if (!html.includes('singulance.css')) {
    html = html.replace('</head>', '<link rel="stylesheet" href="/singulance.css" /></head>');
  }
  fs.writeFileSync(distIndex, html);
}

const listed = execSync(
  `grep -rl --include='*.js' --include='*.html' --include='*.json' -e 'DSH Local Build' -e 'DeepSeek Harness' -e 'dsh web' ${ROOT}/apps/web/dist ${ROOT}/packages/client || true`,
  { encoding: 'utf8' },
).trim().split('\n').filter(Boolean);
for (const file of listed) rewriteFile(file);
process.stdout.write(JSON.stringify({ event: 'singulance_brand_applied', files: listed.length }) + '\n');
