// npm run ontologies:fetch (contract v1.13, CONTRACT.md §23): the pinned
// manifest, the check that keeps a file only when its size and SHA-256 match,
// and that nothing is downloaded with --check. No network: files are written here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkFile, fetchSources, loadManifest, sourcesDir } from '../scripts/ontologies/fetch.mjs';

test('the manifest pins three https sources with sizes and checksums', () => {
  const sources = loadManifest();
  assert.deepEqual(sources.map((source) => source.id), ['mondo', 'icd10cm', 'who-mapping']);
  for (const source of sources) {
    assert.match(source.url, /^https:\/\//);
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(source.bytes > 0 && source.licence && source.attribution);
  }
  assert.match(sourcesDir({}), /backend[/\\]data[/\\]ontology-sources$/);
  assert.equal(sourcesDir({ BMC_ONTOLOGY_SOURCES: '/tmp/x' }), path.resolve('/tmp/x'));
});

test('a file is kept only with its pinned size and SHA-256; --check downloads nothing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bmc-fetch-'));
  try {
    const file = path.join(dir, 'a.txt');
    const body = 'pinned content\n';
    const pin = { bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') };
    assert.equal(await checkFile(file, pin), 'missing');
    writeFileSync(file, body);
    assert.equal(await checkFile(file, pin), 'valid');
    writeFileSync(file, 'pinned CONTENT\n'); // same size, other bytes
    assert.match(await checkFile(file, pin), /SHA-256 does not match/);
    writeFileSync(file, 'short');
    assert.match(await checkFile(file, pin), /bytes, the manifest pins/);

    // With --check, missing files are reported and nothing is fetched.
    const lines = [];
    const failures = await fetchSources({ dir: path.join(dir, 'empty'), checkOnly: true, log: (line) => lines.push(line) });
    assert.equal(failures, 3);
    assert.ok(lines.every((line) => /missing/.test(line)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
