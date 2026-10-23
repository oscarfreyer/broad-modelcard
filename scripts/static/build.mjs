// The static, read-only build for GitHub Pages (release 0.4 R7):
//
//   node scripts/static/build.mjs [--skip-record] [record args]   npm run build:static
//   npm run build:static -- --ontologies icd11,mondo,icd10cm
//
// Records the snapshot from the demo store (scripts/static/record.mjs; skip
// with --skip-record to reuse frontend/static-data/; the classifications come
// from --ontologies or BMC_STATIC_ONTOLOGIES, default icd11,mondo,icd10cm), then
// builds the catalogue, the atlas, and the comparison with
// `vite build --mode static` into frontend/dist-static/, which any static
// file server can serve, at any subpath. Prints the site's size, raw and
// gzipped, and fails above GitHub Pages' 1 GB limit. Needs the backend's
// Python environment and the demo store (`npm run demo:build`) unless
// --skip-record is given.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { REPO_ROOT } from '../backendServer.mjs';
import { STATIC_DATA_DIR, record } from './record.mjs';

export const STATIC_OUT_DIR = path.join(REPO_ROOT, 'frontend', 'dist-static');
/** GitHub Pages: a published site may be no larger than 1 GB. */
export const PAGES_LIMIT_BYTES = 1e9;
const gzipAsync = promisify(gzip);

/** The site's size: files, raw bytes, and the bytes each file takes gzipped (as Pages serves them). */
export async function siteSize(dir) {
  const totals = { files: 0, bytes: 0, gzipBytes: 0 };
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    const files = entries.filter((entry) => !entry.isDirectory());
    for (let start = 0; start < files.length; start += 64) {
      await Promise.all(
        files.slice(start, start + 64).map(async (entry) => {
          const content = await readFile(path.join(current, entry.name));
          const zipped = await gzipAsync(content, { level: 6 });
          // Added after both awaits, so concurrent files never overwrite each other's sums.
          totals.files += 1;
          totals.bytes += content.length;
          totals.gzipBytes += zipped.length;
        })
      );
    }
    for (const entry of entries.filter((item) => item.isDirectory())) {
      await walk(path.join(current, entry.name));
    }
  };
  await walk(dir);
  return totals;
}

async function build(argv) {
  const skipRecord = argv.includes('--skip-record');
  const recordArgs = argv.filter((arg) => arg !== '--skip-record');
  if (skipRecord) {
    if (!existsSync(path.join(STATIC_DATA_DIR, 'manifest.json'))) {
      throw new Error('No snapshot to reuse in frontend/static-data/. Run without --skip-record.');
    }
  } else {
    await record(recordArgs);
  }
  const vite = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const result = spawnSync(process.execPath, [vite, 'build', '--config', 'frontend/vite.config.js', '--mode', 'static'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`vite build --mode static failed (exit code ${result.status ?? result.signal}).`);
  }
  const size = await siteSize(STATIC_OUT_DIR);
  const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
  console.log(
    `[static] Built ${path.relative(REPO_ROOT, STATIC_OUT_DIR)}: ${size.files} files, ${mb(size.bytes)} (${mb(size.gzipBytes)} gzipped). Serve it with any static file server, at any path.`
  );
  if (size.bytes > PAGES_LIMIT_BYTES) {
    throw new Error(`The site is ${mb(size.bytes)}, above GitHub Pages' 1 GB limit. Record fewer classifications or lenses (--ontologies, --lenses default).`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  build(process.argv.slice(2)).catch((error) => {
    console.error(`[static] ${error.message}`);
    process.exit(1);
  });
}
