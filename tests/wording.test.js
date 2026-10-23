// UI vocabulary (CONTRACT.md "Vocabulary"): the
// interface says "Function", never "use case". This scans every user-facing
// string in frontend/src (string literals, template text, and JSX text, after
// esbuild strips the comments) and the page titles of frontend/*.html.
// Identifiers (`useCase`) and contract keys (`use_case`) are not copy and are
// left out; JSON export keys keep the contract's names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformWithEsbuild } from 'vite';

const FRONTEND = fileURLToPath(new URL('../frontend/', import.meta.url));
const SRC = path.join(FRONTEND, 'src');

// "use case", "Use-case", "use cases", "USE CASE", "usecase", with any spacing.
const OLD_TERM = /\buse[\s\u00a0-]*cases?\b/i;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// The live panel's attribute that names the card's function,
// spelled like the contract's `use_case`: markup, not copy.
const PANEL_ATTRIBUTE = /^use-case$/;

function listSources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return listSources(full);
    }
    return /\.(js|jsx)$/.test(name) ? [full] : [];
  });
}

// Tokens before which a "/" starts a regular expression rather than a division.
const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase|\bdo|\belse|\bin|\bof|\bnew|\bdelete|\bvoid|\bthrow|\byield|\bawait)\s*$/;

/**
 * The text of every string literal and template in comment-free JavaScript
 * (esbuild output). A template's text is kept without its `${…}` parts, whose
 * code is scanned like any other. Regular expression literals are skipped.
 *
 * @param {string} code
 * @returns {string[]}
 */
export function stringLiterals(code) {
  const strings = [];
  let i = 0;

  function readQuoted(quote) {
    let text = '';
    for (i += 1; i < code.length && code[i] !== quote; i += 1) {
      if (code[i] === '\\') {
        i += 1;
        text += code[i] === 'n' ? '\n' : code[i];
      } else {
        text += code[i];
      }
    }
    i += 1;
    return text;
  }

  function skipRegex() {
    let inClass = false;
    for (i += 1; i < code.length && (inClass || code[i] !== '/'); i += 1) {
      if (code[i] === '\\') i += 1;
      else if (code[i] === '[') inClass = true;
      else if (code[i] === ']') inClass = false;
    }
    i += 1;
  }

  function readTemplate() {
    let text = '';
    for (i += 1; i < code.length && code[i] !== '`'; ) {
      if (code[i] === '\\') {
        text += code[i + 1];
        i += 2;
      } else if (code[i] === '$' && code[i + 1] === '{') {
        i += 2;
        scan(true);
        text += ' … ';
      } else {
        text += code[i];
        i += 1;
      }
    }
    i += 1;
    return text;
  }

  // Scans code; inside a template expression it stops after the closing brace.
  function scan(inExpression) {
    let depth = 0;
    while (i < code.length) {
      const char = code[i];
      if (char === '"' || char === "'") {
        strings.push(readQuoted(char));
      } else if (char === '`') {
        strings.push(readTemplate());
      } else if (char === '/' && REGEX_AFTER.test(code.slice(Math.max(0, i - 12), i))) {
        skipRegex();
      } else {
        if (char === '{') depth += 1;
        if (char === '}') {
          if (inExpression && depth === 0) {
            i += 1;
            return;
          }
          depth -= 1;
        }
        i += 1;
      }
    }
  }

  scan(false);
  return strings;
}

async function userFacingStrings(file) {
  const source = readFileSync(file, 'utf8');
  const { code } = await transformWithEsbuild(source, file, { jsx: 'transform', legalComments: 'none', charset: 'utf8' });
  return stringLiterals(code).filter((text) => text.trim() && !IDENTIFIER.test(text.trim()) && !PANEL_ATTRIBUTE.test(text.trim()));
}

test('the scanner finds string, template, and JSX text but not comments or identifiers', async () => {
  const sample = [
    '// a use case in a comment',
    '/* another use case */',
    'const useCase = "Function";',
    'const pattern = /use case/;',
    'const label = `Pick a ${useCase} here`;',
    'const view = <p title="Hover text">JSX text</p>;'
  ].join('\n');
  const { code } = await transformWithEsbuild(sample, 'sample.jsx', { jsx: 'transform', legalComments: 'none', charset: 'utf8' });
  const found = stringLiterals(code);
  assert.ok(found.includes('Function'));
  assert.ok(found.some((text) => text.startsWith('Pick a')));
  assert.ok(found.includes('Hover text'));
  assert.ok(found.includes('JSX text'));
  assert.ok(!found.some((text) => /comment|another/.test(text)), 'comments are stripped');
  assert.ok(!found.some((text) => OLD_TERM.test(text)), 'regular expressions and identifiers are not copy');
  for (const spelling of ['use case', 'Use-case', 'use cases', 'USE CASE', 'usecase', 'Use\u00a0case']) {
    assert.match(spelling, OLD_TERM, spelling);
  }
  assert.doesNotMatch('Function', OLD_TERM);
});

test('no user-facing string in frontend/src says "use case" (the UI word is Function)', async () => {
  const offenders = [];
  for (const file of listSources(SRC)) {
    for (const text of await userFacingStrings(file)) {
      if (OLD_TERM.test(text)) {
        offenders.push(`${path.relative(FRONTEND, file)}: ${text.slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('page titles and static page text use the UI vocabulary', () => {
  for (const name of readdirSync(FRONTEND).filter((entry) => entry.endsWith('.html'))) {
    const text = readFileSync(path.join(FRONTEND, name), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/\buse-case="/g, '"');
    assert.doesNotMatch(text, OLD_TERM, name);
    assert.match(text, /<title>[^<]*Broad Modelcard<\/title>/, `${name} names the product in its title`);
  }
});

test('the admin page is named "Data Library" in every user-facing string and page', async () => {
  const offenders = [];
  for (const file of listSources(SRC)) {
    for (const text of await userFacingStrings(file)) {
      if (/\bdata library\b/i.test(text) && !/\bData Library\b/.test(text)) {
        offenders.push(`${path.relative(FRONTEND, file)}: ${text.slice(0, 120)}`);
      }
    }
  }
  for (const name of readdirSync(FRONTEND).filter((entry) => entry.endsWith('.html'))) {
    if (/Data library/i.test(readFileSync(path.join(FRONTEND, name), 'utf8').replace(/Data Library/g, ''))) {
      offenders.push(name);
    }
  }
  assert.deepEqual(offenders, []);
  assert.match(readFileSync(path.join(FRONTEND, 'admin.html'), 'utf8'), /<title>Data Library – Broad Modelcard<\/title>/);
});

// The atlas's
// views read Overview (the URL value stays `overall`), there is one
// missing-data state, No data, and no Detailed mode. The catalogue, the model
// card (once "Label"), and the live panel follow in the next test.
const ATLAS_SURFACES = ['app', 'design', 'shared', 'features/atlas', 'features/summary', 'features/details', 'features/multimorbidity', 'features/preview', 'features/toolbar', 'features/profile', 'features/navigation', 'features/search'];
const RETIRED_WORDS = [/\bOverall\b/, /\bnot validated\b/i, /\bDetailed\b/];

test('the atlas says Overview and No data, never "Overall", "Not validated", or "Detailed"', async () => {
  const offenders = [];
  for (const surface of ATLAS_SURFACES) {
    for (const file of listSources(path.join(SRC, surface))) {
      for (const text of await userFacingStrings(file)) {
        if (RETIRED_WORDS.some((word) => word.test(text))) {
          offenders.push(`${path.relative(FRONTEND, file)}: ${text.slice(0, 120)}`);
        }
      }
    }
  }
  const page = readFileSync(path.join(FRONTEND, 'atlas.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  if (RETIRED_WORDS.some((word) => word.test(page))) {
    offenders.push('atlas.html');
  }
  assert.deepEqual(offenders, []);
});

// Phase T4: the catalogue, the model card
// (never "Label"), the live interaction page, and the embeddable panel say
// Overview and No data too. "label" as a word in copy is retired with it;
// class names ("label-row") and attribute keys ("aria-label") are not copy.
const CARD_SURFACES = ['features/catalogue', 'features/label', 'features/plugin', 'embed'];
const CARD_FILES = ['catalogueMain.jsx', 'pluginMain.jsx'];
const CARD_PAGES = ['index.html', 'plugin.html', 'embed-test.html'];
const LABEL_WORD = /(?:^|[\s(“"'])labels?(?=$|[\s.,:;)”"'])/i;
const SINGLE_RETIRED = /^(?:Labels?|Overall|Detailed)$/;

test('the catalogue, the model card, and the live panel never say "Label", "Overall", "Not validated", or "Detailed"', async () => {
  const offenders = [];
  const files = [...CARD_SURFACES.flatMap((surface) => listSources(path.join(SRC, surface))), ...CARD_FILES.map((name) => path.join(SRC, name))];
  for (const file of files) {
    for (const text of await userFacingStrings(file)) {
      if ([...RETIRED_WORDS, LABEL_WORD].some((word) => word.test(text))) {
        offenders.push(`${path.relative(FRONTEND, file)}: ${text.slice(0, 120)}`);
      }
    }
    // A one-word string is skipped above as a likely identifier; a capitalised
    // retired word on its own is copy all the same ("Overall" as a row label).
    const { code } = await transformWithEsbuild(readFileSync(file, 'utf8'), file, { jsx: 'transform', legalComments: 'none', charset: 'utf8' });
    for (const text of stringLiterals(code)) {
      if (SINGLE_RETIRED.test(text.trim())) {
        offenders.push(`${path.relative(FRONTEND, file)}: ${text}`);
      }
    }
  }
  for (const name of CARD_PAGES) {
    const page = readFileSync(path.join(FRONTEND, name), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
    if ([...RETIRED_WORDS, LABEL_WORD].some((word) => word.test(page))) {
      offenders.push(name);
    }
  }
  assert.deepEqual(offenders, []);
  // The scanner would catch the old words.
  for (const sample of ['Card label', 'Label', 'Overall result', 'the label shows', 'Not validated']) {
    assert.ok([...RETIRED_WORDS, LABEL_WORD].some((word) => word.test(sample)), sample);
  }
  for (const sample of ['label-row', 'aria-label', 'Model card', 'Overview']) {
    assert.ok(![...RETIRED_WORDS, LABEL_WORD].some((word) => word.test(sample)), sample);
  }
});
