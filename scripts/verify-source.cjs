'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { builtinModules } = require('node:module');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs/SOURCE_MANIFEST.json'), 'utf8'));
const failures = [];
const uiManifestPath=path.join(root,'docs/UI_SOURCE.json');
const uiCopies=fs.existsSync(uiManifestPath)?JSON.parse(fs.readFileSync(uiManifestPath,'utf8')).files.filter(file=>file.mode==='verbatim'):[];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

for (const record of manifest.files) {
  const target = path.resolve(root, record.destination);
  if (!target.startsWith(root + path.sep)) { failures.push('Invalid manifest destination'); continue; }
  if (!fs.existsSync(target) || digest(fs.readFileSync(target)) !== record.copiedSha256) failures.push('Changed or missing: ' + record.destination);
}
for(const record of uiCopies){const target=path.resolve(root,record.destination);if(!target.startsWith(root+path.sep)||!fs.existsSync(target)||digest(fs.readFileSync(target))!==record.sha256)failures.push('Changed or missing UI source: '+record.destination);}

function walk(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const files = walk(path.join(root, 'src'));
for (const file of files) {
  if (!/\.(?:cjs|js)$/.test(file)) failures.push('Unexpected runtime asset: ' + file);
  const text = fs.readFileSync(file, 'utf8');
  if (/\b(?:(?:document|window|localStorage)\s*\.[A-Za-z_$]|requestAnimationFrame\s*\()/.test(text)) failures.push('UI reference: ' + file);
  for (const match of text.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) {
      if (!builtinModules.includes(specifier) && !specifier.startsWith('node:')) failures.push('External dependency: ' + specifier);
      continue;
    }
    const target = path.resolve(path.dirname(file), specifier);
    if (!target.startsWith(path.join(root, 'src') + path.sep) || !fs.existsSync(target)) failures.push('Missing or external runtime import: ' + file + ' -> ' + specifier);
  }
}
if (failures.length) {
  process.stderr.write(failures.join('\n') + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ copiedFilesVerified: manifest.files.length, copiedUiFilesVerified:uiCopies.length, runtimeFilesChecked: files.length, upstreamCommit: manifest.commit, thirdPartyRuntimeDependencies: 0, uiDependencies: 0 }, null, 2) + '\n');
}
