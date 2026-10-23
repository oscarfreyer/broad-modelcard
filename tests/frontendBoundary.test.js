// The frontend reaches data only through the data client (§8.2 B3).
// Components and feature modules must not fetch or import data files; only
// the API adapter talks to the backend, and only entry points create the client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../frontend/src/', import.meta.url));

// Modules UI code may import from api/.
const PUBLIC_API_MODULES = new Set(['api/DataClientProvider.jsx', 'api/useClientQuery.js', 'api/queryKeys.js', 'api/dataClient.js']);
// Only entry points create the client.
const ADAPTER_CHOICE = 'api/appDataClient.js';
const ENTRY_POINTS = new Set(['main.jsx', 'adminMain.jsx', 'catalogueMain.jsx', 'compareMain.jsx', 'pluginMain.jsx']);
// The modules that call fetch: the API adapter, and the static adapter of the
// read-only GitHub Pages build, which reads the recorded snapshot.
const API_ADAPTER = 'api/apiAdapter.js';
const STATIC_ADAPTER = 'api/staticAdapter.js';
// The embeddable live panel's entry into the data layer: it
// builds the app's own adapter and client for its `api-base` attribute.
const PANEL_CLIENT = 'embed/panelClient.js';

function listSourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return listSourceFiles(full);
    }
    return /\.(js|jsx)$/.test(name) ? [full] : [];
  });
}

function importsOf(source) {
  const specifiers = [];
  for (const match of source.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) specifiers.push(match[1]);
  for (const match of source.matchAll(/import\s*['"]([^'"]+)['"]/g)) specifiers.push(match[1]);
  for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]);
  return specifiers;
}

const files = listSourceFiles(SRC).map((file) => {
  const relative = path.relative(SRC, file).split(path.sep).join('/');
  const source = readFileSync(file, 'utf8');
  const imports = importsOf(source).map((specifier) =>
    specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)) : specifier
  );
  return { relative, source, imports };
});
const uiFiles = files.filter(({ relative }) => !relative.startsWith('api/'));

test('the boundary scan sees the feature modules', () => {
  assert.ok(uiFiles.some(({ relative }) => relative.startsWith('features/atlas/')));
  assert.ok(uiFiles.some(({ relative }) => relative.startsWith('features/details/')));
  assert.ok(uiFiles.length >= 30, `only ${uiFiles.length} UI modules found`);
});

test('UI code never calls fetch or XMLHttpRequest', () => {
  const offenders = uiFiles
    .filter(({ source }) => /(?<![.\w])fetch\s*\(|XMLHttpRequest|navigator\.sendBeacon/.test(source))
    .map(({ relative }) => relative);
  assert.deepEqual(offenders, []);
});

test('UI code imports no data files and only the public data-client modules', () => {
  const offenders = [];
  uiFiles.forEach(({ relative, imports }) => {
    imports.forEach((specifier) => {
      if (/\.json$/.test(specifier) || /data\/tables|tableDataset|api\/static\//.test(specifier)) {
        offenders.push(`${relative} → ${specifier}`);
      } else if (specifier === ADAPTER_CHOICE && !ENTRY_POINTS.has(relative)) {
        offenders.push(`${relative} → ${specifier}`);
      } else if (relative === PANEL_CLIENT && specifier === API_ADAPTER) {
        // The panel's client entry may build the adapter (checked below).
      } else if (specifier.startsWith('api/') && specifier !== ADAPTER_CHOICE && !PUBLIC_API_MODULES.has(specifier)) {
        offenders.push(`${relative} → ${specifier}`);
      }
    });
  });
  assert.deepEqual(offenders, []);
});

test('no frontend module reads the static tables', () => {
  const offenders = files.filter(({ source }) => /data\/tables|\.metrics\.json|atlas-base\.json/.test(source)).map(({ relative }) => relative);
  assert.deepEqual(offenders, []);
});

test('only the two adapters call fetch, and only appDataClient and the panel client create them', () => {
  const fetching = files.filter(({ source }) => /(?<![.\w])fetch\s*\(|fetchImpl\s*\(/.test(source)).map(({ relative }) => relative).sort();
  assert.deepEqual(fetching, [API_ADAPTER, STATIC_ADAPTER].sort());
  const creating = files.filter(({ imports }) => imports.includes(API_ADAPTER)).map(({ relative }) => relative).sort();
  assert.deepEqual(creating, [ADAPTER_CHOICE, PANEL_CLIENT].sort());
  // The static build has no live panel, so only appDataClient picks the static adapter.
  const creatingStatic = files.filter(({ imports }) => imports.includes(STATIC_ADAPTER)).map(({ relative }) => relative);
  assert.deepEqual(creatingStatic, [ADAPTER_CHOICE]);
  // The panel client wraps the adapter in the contract-checked data client.
  const panelClient = files.find(({ relative }) => relative === PANEL_CLIENT);
  assert.ok(panelClient.imports.includes('api/dataClient.js'));
  assert.match(panelClient.source, /createDataClient\(createApiAdapter\(/);
  // Only the panel element uses the panel client.
  const panelUsers = files.filter(({ imports }) => imports.includes(PANEL_CLIENT)).map(({ relative }) => relative);
  assert.deepEqual(panelUsers, ['embed/BmcLivePanel.js']);
});
