// npm run ontologies:fetch — download the pinned ontology releases
// (scripts/ontologies/sources.json: MONDO, ICD-10-CM, the WHO ICD-10 → ICD-11
// mapping tables) into backend/data/ontology-sources/<id>/<file> (gitignored,
// never committed; BMC_ONTOLOGY_SOURCES names another folder).
//
// A file that is already present with the pinned size and SHA-256 is kept. A
// download goes to a temporary file next to its target and replaces it only
// once its size and SHA-256 match the manifest; anything else is deleted and
// reported. Node's own fetch, no dependencies. The files are data: nothing in
// them is run (the importer parses them with the Python standard library).
//
//   node scripts/ontologies/fetch.mjs [--only <id>] [--check]
//   --check  verify the files that are there, download nothing
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
export const MANIFEST = path.join(HERE, 'sources.json');
export const DEFAULT_DIR = path.join(REPO_ROOT, 'backend', 'data', 'ontology-sources');
const ALLOWED_HOSTS = new Set(['github.com', 'ftp.cdc.gov', 'icdcdn.who.int']);

export function sourcesDir(env = process.env) {
  return env.BMC_ONTOLOGY_SOURCES ? path.resolve(env.BMC_ONTOLOGY_SOURCES) : DEFAULT_DIR;
}

export function loadManifest(file = MANIFEST) {
  const { sources } = JSON.parse(readFileSync(file, 'utf8'));
  for (const source of sources) {
    if (!/^[a-z0-9-]+$/.test(source.id) || !/^[A-Za-z0-9._-]+$/.test(source.file) || source.file.startsWith('.')) {
      throw new Error(`Unexpected manifest entry ${source.id}/${source.file}`);
    }
  }
  return sources;
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** 'valid', 'missing', or a reason the file does not match. */
export async function checkFile(file, source) {
  if (!existsSync(file)) return 'missing';
  const size = statSync(file).size;
  if (size !== source.bytes) return `${size} bytes, the manifest pins ${source.bytes}`;
  return (await sha256File(file)) === source.sha256 ? 'valid' : 'SHA-256 does not match the manifest';
}

async function download(source, target) {
  const url = new URL(source.url);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`refusing ${source.url}: only https from ${[...ALLOWED_HOSTS].join(', ')}`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.download`;
  rmSync(partial, { force: true });
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`${source.url} answered ${response.status} ${response.statusText}`);
  }
  let received = 0;
  const limit = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      done(received > source.bytes ? new Error(`more than the pinned ${source.bytes} bytes`) : null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(partial));
    const state = await checkFile(partial, source);
    if (state !== 'valid') throw new Error(state);
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

export async function fetchSources({ dir = sourcesDir(), only = null, checkOnly = false, log = console.log } = {}) {
  let failures = 0;
  for (const source of loadManifest()) {
    if (only && !only.includes(source.id)) continue;
    const target = path.join(dir, source.id, source.file);
    const label = `${source.id}/${source.file} (${source.release})`;
    const state = await checkFile(target, source);
    if (state === 'valid') {
      log(`  ok        ${label}`);
      continue;
    }
    if (checkOnly) {
      log(`  ${state === 'missing' ? 'missing ' : 'invalid '}  ${label}${state === 'missing' ? '' : `: ${state}`}`);
      failures += 1;
      continue;
    }
    log(`  download  ${label}, ${(source.bytes / 1e6).toFixed(1)} MB from ${new URL(source.url).hostname}`);
    try {
      await download(source, target);
      log(`  ok        ${label}`);
    } catch (error) {
      log(`  failed    ${label}: ${error.message}`);
      failures += 1;
    }
  }
  return failures;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? [args[args.indexOf('--only') + 1]] : null;
  const dir = sourcesDir();
  console.log(`Ontology sources in ${path.relative(REPO_ROOT, dir) || dir}:`);
  const failures = await fetchSources({ dir, only, checkOnly: args.includes('--check') });
  if (failures) {
    console.error(`${failures} file(s) not ready.${args.includes('--check') ? ' Run: npm run ontologies:fetch' : ''}`);
    process.exit(1);
  }
  console.log('All pinned files are present and verified. Import them with: npm run ontologies:import');
}
