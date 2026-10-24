import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { apiProxy } from './apiProxy.js';

const frontendRoot = fileURLToPath(new URL('.', import.meta.url));
const page = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));

// The static, read-only build for GitHub Pages:
// `vite build --mode static` (npm run build:static) builds the catalogue, the
// atlas, and the comparison only, reading the snapshot that
// scripts/static/record.mjs wrote to frontend/static-data/, and copies it into
// frontend/dist-static/. The band names the release from package.json.
const STATIC_DATA = page('static-data');
const STATIC_OUT = page('dist-static');
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));

function staticSnapshot() {
  const manifestPath = path.join(STATIC_DATA, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('No static snapshot in frontend/static-data/. Record one first: npm run static:record');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const { version } = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  const names = manifest.ontology_names ?? {};
  return {
    release_version: version,
    dataset_version: manifest.dataset_version,
    recorded_at: manifest.recorded_at,
    lens_count: manifest.lenses.length,
    card_count: manifest.cards.length,
    // Release 0.5 (Q9): whether the snapshot holds care settings (contract v1.14, §29).
    has_settings: manifest.cards.some((card) => Array.isArray(card.settings) && card.settings.length > 0),
    ontologies: (manifest.ontologies ?? ['icd11']).map((id) => names[id] ?? (id === 'icd11' ? 'ICD-11' : id))
  };
}

/** Copies the snapshot next to the pages and marks the site as plain files for GitHub Pages. */
function copyStaticSnapshot() {
  return {
    name: 'bmc-static-snapshot',
    apply: 'build',
    closeBundle() {
      cpSync(STATIC_DATA, path.join(STATIC_OUT, 'static-data'), { recursive: true });
      writeFileSync(path.join(STATIC_OUT, '.nojekyll'), '');
    }
  };
}

// The Vite app lives in frontend/: the catalogue (index.html), the atlas
// (atlas.html), the comparison (compare.html), the Data Library (admin.html), and the live interaction demo
// (plugin.html) with its plain embed test page (embed-test.html). The
// embeddable panel is also built as a script with a stable name,
// embed/bmc-live-panel.js, for host pages. All data comes
// from the backend API, which the dev and preview servers proxy under /api
// (same origin, so no CORS). `npm run dev` and `npm run preview` start the
// backend as well (scripts/dev.mjs). CORS is off on both servers: no other
// page, not even one on another localhost port, may read the app or its API
// (the backend's local-only guard refuses foreign Origins, CONTRACT.md §16).
export default defineConfig(({ mode }) => {
  const isStatic = mode === 'static';
  return {
    root: frontendRoot,
    base: './',
    publicDir: false,
    plugins: isStatic ? [react(), copyStaticSnapshot()] : [react()],
    define: {
      __BMC_STATIC__: JSON.stringify(isStatic),
      __BMC_STATIC_SNAPSHOT__: JSON.stringify(isStatic ? staticSnapshot() : null)
    },
    // Pre-bundle the dependencies the pages import lazily or only from some
    // entries, so the first `npm run dev` on a fresh clone does not find them
    // mid-load, re-bundle, and reload the page with mismatched React copies.
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-dev-runtime', 'jspdf']
    },
    server: {
      cors: false,
      proxy: apiProxy()
    },
    preview: {
      cors: false,
      proxy: apiProxy()
    },
    build: {
      target: 'es2020',
      outDir: isStatic ? STATIC_OUT : fileURLToPath(new URL('./dist', import.meta.url)),
      emptyOutDir: true,
      cssCodeSplit: true,
      rolldownOptions: {
        // Vite drops entry exports in app builds; keep them, so a host can
        // import { BmcLivePanel, PANEL_TAG } from embed/bmc-live-panel.js as
        // embed/index.js promises. The HTML entries export nothing either way.
        preserveEntrySignatures: 'exports-only',
        // The static build has no Data Library and no live panel;
        // it records the comparison.
        input: isStatic
          ? { main: page('index.html'), atlas: page('atlas.html'), compare: page('compare.html') }
          : {
              main: page('index.html'),
              atlas: page('atlas.html'),
              compare: page('compare.html'),
              admin: page('admin.html'),
              plugin: page('plugin.html'),
              'embed-test': page('embed-test.html'),
              'bmc-live-panel': page('src/embed/index.js')
            },
        output: {
          entryFileNames: (chunk) => (chunk.name === 'bmc-live-panel' ? 'embed/bmc-live-panel.js' : 'assets/[name]-[hash].js'),
          // React and React DOM in one shared chunk, as every page uses them.
          codeSplitting: {
            groups: [{ name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ }]
          }
        }
      }
    }
  };
});
