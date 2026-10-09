import { readFile, readdir, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const entries = [];
const notices = ['Third-party package notices. This is a superset of the bundled runtime, including build-time dependencies.'];
for (const name of (await readdir('provenance/licenses')).sort()) {
  notices.push(`\nPreserved upstream/reference notice: ${name}\n${await readFile(path.join('provenance/licenses', name), 'utf8')}`);
}
notices.push(`\nSites starter build plugin notice\n${await readFile('scripts/build/sites-vite-plugin.LICENSE', 'utf8')}`);
for (const [location, locked] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!location || !location.startsWith('node_modules/')) continue;
  let metadata;
  try { metadata = JSON.parse(await readFile(path.join(location, 'package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const licenses = [];
  for (const name of (await readdir(location)).sort()) {
    if (!/^(?:licen[sc]e|copying)(?:[.-].*)?$/i.test(name)) continue;
    try { licenses.push({ file: name, text: await readFile(path.join(location, name), 'utf8') }); }
    catch (error) { if (error.code !== 'EISDIR') throw error; }
  }
  entries.push({ name: metadata.name, version: metadata.version, location, license: metadata.license ?? locked.license ?? 'NOASSERTION', developmentOnly: !!locked.dev, noticeFiles: licenses.map(x => x.file) });
  notices.push(`\n${metadata.name}@${metadata.version}\nSPDX/package declaration: ${JSON.stringify(metadata.license ?? locked.license ?? 'NOASSERTION')}\n${licenses.map(x => `${x.file}\n${x.text}`).join('\n') || 'No top-level license text found in the installed package; declaration retained in inventory.'}`);
}
await mkdir('provenance', { recursive: true });
await writeFile('provenance/dependencies.json', JSON.stringify({ source: 'package-lock.json and installed package metadata/license files', packages: entries }, null, 2) + '\n');
await writeFile('provenance/THIRD_PARTY_NOTICES.txt', notices.join('\n'));
await copyFile('provenance/THIRD_PARTY_NOTICES.txt', 'public/THIRD_PARTY_NOTICES.txt');
console.log(JSON.stringify({ packages: entries.length, inventory: 'provenance/dependencies.json', notices: 'provenance/THIRD_PARTY_NOTICES.txt' }));
