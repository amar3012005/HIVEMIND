import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile, readdir } from 'node:fs/promises';
const mark = await readFile('assets/singulance-mark.svg', 'utf8');
// Render the checked-in vector mark onto an opaque brand background for store assets.
const render = (width) => new Resvg(mark, { fitTo: { mode: 'width', value: width }, background: '#faf9f4' }).render().asPng();
await writeFile('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', render(1024));
for (const [density, size] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) await writeFile(`android/app/src/main/res/mipmap-${density}/${name}`, render(size));
  await writeFile(`android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`, render(Math.round(size * 2.25)));
}
const inner = mark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const splash = async (path) => {
  const existing = await readFile(path);
  const width = existing.readUInt32BE(16), height = existing.readUInt32BE(20);
  const size = Math.round(Math.min(width, height) * 0.24);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#faf9f4"/><svg x="${(width-size)/2}" y="${(height-size)/2}" width="${size}" height="${size}" viewBox="-6 -6 112 112">${inner}</svg></svg>`;
  await writeFile(path, new Resvg(svg).render().asPng());
};
for (const entry of await readdir('android/app/src/main/res', { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.startsWith('drawable')) {
    const path = `android/app/src/main/res/${entry.name}/splash.png`;
    try { await splash(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) await splash(`ios/App/App/Assets.xcassets/Splash.imageset/${name}`);
console.log('Native launcher and splash assets rendered from the existing SINGULANCE vector mark.');
