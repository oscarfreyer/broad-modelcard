// Code-review fixes in the Data Library: navigation from a URL without a
// page, History and restore of narrow model cards, focus reloads, numbers
// with thousands separators, narrow model card files, staging a card's
// performance metrics without overwriting a waiting update, a partly failed
// submission retried into the same submission, display names, and the parts
// list's controlled region. Components render through Vite's SSR loader, as
// in adminLibraryFixes.test.js.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { nextAdminRoute, parseAdminRoute } from '../frontend/src/features/admin/adminRoute.js';
import { FOCUS_RELOAD_GAP_MS, shouldReloadOnFocus } from '../frontend/src/features/admin/adminReload.js';
import { DATASET_ORDER, HISTORY_KINDS, datasetTitle } from '../frontend/src/features/admin/datasets.js';
import { effectProblems, emptyEffect, parsedNumber } from '../frontend/src/features/admin/effects.js';
import { focusNode } from '../frontend/src/features/admin/focus.js';
import { optionLabel } from '../frontend/src/features/admin/options.js';
import { EVERYTHING, restorePlan } from '../frontend/src/features/admin/restore.js';
import { MAX_CARD_BYTES, PART_WORDS, readModelCardFile, stageProposalBatches, systemName } from '../frontend/src/features/admin/submissions.js';
import { emptySubmitForm, problemSummary, runSubmission, submissionParts, submitProblems } from '../frontend/src/features/admin/submitForm.js';
import { WORKSPACES, publisherWords } from '../frontend/src/features/admin/workspace.js';

let vite;
const load = (path) => vite.ssrLoadModule(path);
const source = (name) => readFileSync(new URL(`../frontend/src/features/admin/${name}`, import.meta.url), 'utf8');

before(async () => {
  vite = await createServer({
    configFile: false,
    root: new URL('../frontend/', import.meta.url).pathname,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] }
  });
});
after(async () => {
  await vite?.close();
});

// ------------------------------------------------------------ navigation

test('a move from a URL without a page names the page shown, so sidebar links work in every workspace', () => {
  const opened = parseAdminRoute('');
  assert.equal(opened.explicit, false);
  // Hospital administration opened on its first page (Local populations) without ?set=.
  const toResults = nextAdminRoute(opened, 'population', { page: 'local_metrics' });
  assert.equal(toResults.page, 'local_metrics');
  assert.equal(toResults.explicit, true, 'the chosen page wins over the workspace’s first page from now on');
  // A move that names no page (the population in the URL) stays on the page shown.
  const population = nextAdminRoute(opened, 'population', { population: 'north' });
  assert.equal(population.page, 'population');
  assert.equal(population.population, 'north');
  assert.equal(nextAdminRoute({ ...opened, published: 9 }, 'metrics', { model: 'M' }).published, null, 'a publish result belongs to its own page');
  // The side effect (history entry) is no longer inside a state updater.
  const app = source('AdminApp.jsx');
  assert.doesNotMatch(app, /setRoute\(\(current\) =>/);
  assert.match(app, /window\.history\[replace \? 'replaceState' : 'pushState'\]\(null, '', adminRouteSearch\(merged\)\);\n    setRoute\(merged\);/);
});

test('the sidebar: no empty data-set list, no atlas link, “no login”, and role words from the workspaces', () => {
  const app = source('AdminApp.jsx');
  assert.doesNotMatch(app, /Open the atlas/);
  assert.doesNotMatch(app, /sign-in/);
  // The synthetic-data notice is the shared header's badge; "no login" is the workspace page's help.
  assert.match(app, /<AppHeader current="admin" \/>/);
  assert.match(app, /DATASET_ORDER\.some\(shows\) \? \(\n\s+<>\n\s+<p className="sidebar-heading">Data sets<\/p>\n\s+<ul className="sidebar-group is-datasets">/);
  assert.equal(publisherWords({ publisher_role: 'custodian', publisher_name: 'C. Ustodian' }), `Published in ${WORKSPACES[1].title} by C. Ustodian`);
  assert.equal(WORKSPACES.find((entry) => entry.id === 'maintainer').detail, 'Every data set and page.');
  assert.match(WORKSPACES[0].detail, /nothing is published until then\.$/);
});

test('a window focus reads the library again at most once every 10 seconds', () => {
  assert.equal(FOCUS_RELOAD_GAP_MS, 10_000);
  assert.equal(shouldReloadOnFocus(0, 5_000), true, 'nothing read yet');
  assert.equal(shouldReloadOnFocus(100_000, 104_000), false);
  assert.equal(shouldReloadOnFocus(100_000, 110_000), true);
  assert.doesNotMatch(source('useAdminData.js'), /isLoading/, 'a background reload renders once, when its data arrives');
});

// ------------------------------------------------------------ History

const CARD_VERSIONS = [
  { version_id: 3, kind: 'model_cards', rollback_of: null, summary: 'Narrow model cards: 1 card added.' },
  { version_id: 2, kind: 'safety', rollback_of: null, summary: 'Safety incidents: 1 incident added.' },
  { version_id: 1, kind: null, rollback_of: null, summary: 'Initial import.' }
];

test('narrow model cards are a History kind: filtered, restored alone, and part of Everything', async () => {
  assert.deepEqual(HISTORY_KINDS, [...DATASET_ORDER, 'model_cards']);
  assert.equal(datasetTitle('model_cards'), 'Narrow model cards');
  assert.deepEqual(restorePlan(CARD_VERSIONS, 1, 'model_cards').kinds, ['model_cards']);
  assert.deepEqual(restorePlan(CARD_VERSIONS, 1, EVERYTHING).kinds, ['safety', 'model_cards']);

  const { default: HistoryPage, HistoryRestoreSheet } = await load('/src/features/admin/HistoryPage.jsx');
  const { DataClientProvider } = await load('/src/api/DataClientProvider.jsx');
  const page = renderToStaticMarkup(h(DataClientProvider, { client: {} }, h(HistoryPage, { versions: CARD_VERSIONS, onLibraryChange() {} })));
  assert.match(page, /<select[^>]*>/, 'eleven choices: a select, not a segmented row');
  assert.match(page, /<span class="select-wrap">/);
  assert.match(page, /<option value="model_cards">Narrow model cards<\/option>/);
  const sheet = renderToStaticMarkup(
    h(DataClientProvider, { client: {} }, h(HistoryRestoreSheet, { entry: CARD_VERSIONS[2], nextVersion: 4, versions: CARD_VERSIONS, onClose() {}, onRestored() {} }))
  );
  assert.match(sheet, /value="model_cards"/);
  assert.match(sheet, /Narrow model cards/);
});

// ------------------------------------------------------------ forms

test('a number with a thousands separator is refused, a decimal comma is read', () => {
  assert.equal(parsedNumber('1,200'), null);
  assert.equal(parsedNumber('12,000'), null);
  assert.equal(parsedNumber('0,85'), 0.85);
  assert.equal(parsedNumber('12,5'), 12.5);
  assert.equal(parsedNumber('0,125'), 0.125);
  assert.equal(parsedNumber('−3'), -3);
  const problems = effectProblems({ ...emptyEffect(), estimate: '1,200', ciLow: '0,5', ciHigh: 'x' });
  assert.equal(problems.estimate, 'Without a thousands separator, e.g. 1200.');
  assert.equal(problems.ciHigh, 'A number, e.g. -12 or 0.85.');
  assert.equal(problems.ciLow, undefined);
});

test('one option-label helper, one form group, one editing notice', () => {
  assert.equal(optionLabel([{ value: 'a', label: 'A' }], 'a'), 'A');
  assert.equal(optionLabel([{ value: 'a', label: 'A' }], 'b'), 'b');
  for (const name of ['StudyForm.jsx', 'EffectForm.jsx', 'IncidentForm.jsx', 'MetricRowForm.jsx']) {
    assert.doesNotMatch(source(name), /function (Group|EditingNotice)\(/, name);
  }
  for (const name of ['studies.js', 'effects.js', 'IncidentList.jsx']) {
    assert.doesNotMatch(source(name), /const label = \(options, value\)/, name);
    assert.match(source(name), /import \{ optionLabel \} from '\.\/options\.js';/, name);
  }
  assert.doesNotMatch(source('StudyForm.jsx'), /Model version evaluated/);
  assert.match(source('StudyForm.jsx'), /label="AI system evaluated"/);
});

test('the effect form names a chosen study plainly while the studies load', async () => {
  const { default: EffectForm } = await load('/src/features/admin/EffectForm.jsx');
  const { DataClientProvider } = await load('/src/api/DataClientProvider.jsx');
  const render = (studies) =>
    renderToStaticMarkup(
      h(DataClientProvider, { client: {} }, h(EffectForm, { form: { ...emptyEffect(), studyId: 'RCT-1' }, onChange() {}, models: [], meta: null, studies, onSubmit() {}, isBusy: false, onReset() {} }))
    );
  assert.doesNotMatch(render(null), /not a trial or prospective study/);
  assert.match(render(null), /<option value="RCT-1"[^>]*>RCT-1<\/option>/);
  assert.match(render([]), /RCT-1 \(not a trial or prospective study\)/);
});

test('a narrow model card file over 1 MB is refused whole, and an unreadable one says so', async () => {
  const file = (name, content, size = content.length) => ({ name, size, text: async () => content });
  assert.deepEqual((await readModelCardFile(file('card.md', '# Card'))).card, { format: 'markdown', content: '# Card', filename: 'card.md' });
  assert.equal((await readModelCardFile(file('card.json', '{}'))).card.format, 'json');
  const large = await readModelCardFile(file('big.json', '', MAX_CARD_BYTES + 1));
  assert.equal(large.card, undefined, 'never cut short');
  assert.match(large.problem, /“big\.json” is larger than 1 MB/);
  const broken = await readModelCardFile({ name: 'x.json', size: 10, text: async () => Promise.reject(new Error('gone')) });
  assert.match(broken.problem, /could not be read/);
  assert.doesNotMatch(source('ModelCardInput.jsx'), /slice\(0, MAX_CARD\)/);
});

// ------------------------------------------------------------ narrow model cards

const BATCHES = [
  { model_version: 'A-1', use_case: 'CDSS', records: [{ code: '1A00' }] },
  { model_version: 'A-1', use_case: 'Triage', records: [{ code: '1A01' }] }
];

test('staging a card’s performance metrics never overwrites a waiting update without asking', async () => {
  const calls = [];
  const client = {
    async createRecordsUpload(request) {
      calls.push(request);
      if (request.useCase === 'Triage' && !request.replaceStaged) throw Object.assign(new Error('waiting'), { code: 'staged_upload_exists' });
      return { upload_id: `u-${calls.length}` };
    }
  };
  const first = await stageProposalBatches(client, BATCHES);
  assert.equal(first.created.length, 1);
  assert.deepEqual(first.conflicts, [BATCHES[1]], 'the card with a waiting update is asked about');
  assert.equal(first.error, null);
  assert.equal('replaceStaged' in calls[0], false, 'sent without replace_staged');
  const replaced = await stageProposalBatches(client, first.conflicts, { replaceStaged: true });
  assert.equal(replaced.created.length, 1);
  assert.equal(calls.at(-1).replaceStaged, true);
  const failing = await stageProposalBatches({ createRecordsUpload: async () => Promise.reject(Object.assign(new Error('down'), { code: 'backend_unavailable' })) }, BATCHES);
  assert.equal(failing.error.code, 'backend_unavailable');
  assert.equal(failing.created.length, 0);
  assert.doesNotMatch(source('ModelCardsPage.jsx'), /createRecordsUpload\([^)]*replaceStaged: true/);
});

test('the narrow model card page drops replies for an AI system no longer chosen', () => {
  const page = source('ModelCardsPage.jsx');
  assert.match(page, /getNarrowModelCard\(\{ modelVersion \}, \{ version: 'live', signal: controller\.signal \}\)/);
  assert.match(page, /return \(\) => controller\.abort\(\);/);
  assert.match(page, /if \(cancelled\) return;\n\s+setUpload\(next\);/);
  assert.match(page, /const chooseSystem = \(next\) => \{\n\s+setSystem\(next\);\n\s+setCard\(EMPTY_CARD\);\n\s+setUpload\(null\);\n\s+setProposals\(null\);\n\s+setStaged\(null\);/);
});

// ------------------------------------------------------------ developer submission

const FILE = (name) => ({ name, size: 10, lastModified: 1 });

function submissionClient({ failOnce = [] } = {}) {
  const calls = [];
  const failing = new Set(failOnce);
  const step = (kind) => async (request) => {
    calls.push({ kind, ...request });
    if (failing.has(kind)) {
      failing.delete(kind);
      throw Object.assign(new Error('down'), { code: 'backend_unavailable' });
    }
    return { upload_id: `u-${calls.length}` };
  };
  return {
    calls,
    async createSubmission(request) {
      calls.push({ kind: 'submission', ...request });
      return { submission_id: `s-${calls.filter((call) => call.kind === 'submission').length}` };
    },
    createRecordsUpload: step('models'),
    createModelCardUpload: step('model_cards'),
    createUpload: async (request) => step(request.kind)(request)
  };
}

const NEW_SYSTEM = {
  ...emptySubmitForm('Tidewell Analytics (fictional)'),
  modelVersion: 'Tidewell-Sepsis-1.0',
  displayName: 'Tidewell Sepsis 1.0',
  useCase: 'Sepsis early warning',
  studiesFile: FILE('studies.xlsx'),
  resultsFile: FILE('metrics.xlsx')
};

test('a partly failed submission stays open, and Submit sends only the rest into the same one', async () => {
  const client = submissionClient({ failOnce: ['metrics'] });
  assert.deepEqual(submissionParts(NEW_SYSTEM), ['models', 'studies', 'metrics']);
  const first = await runSubmission(client, NEW_SYSTEM);
  assert.equal(first.error.code, 'backend_unavailable');
  assert.equal(first.failedPart, 'metrics');
  assert.equal(first.opened.submissionId, 's-1');
  assert.deepEqual(Object.keys(first.opened.sent), ['models', 'studies']);

  const sentBefore = client.calls.length;
  const second = await runSubmission(client, NEW_SYSTEM, { opened: first.opened });
  assert.equal(second.error, null);
  assert.equal(client.calls.filter((call) => call.kind === 'submission').length, 1, 'no second submission');
  const retried = client.calls.slice(sentBefore);
  assert.deepEqual(retried.map((call) => [call.kind, call.submissionId, call.replaceStaged ?? false]), [['metrics', 's-1', false]]);

  // A part changed since it was sent replaces its earlier one within the submission.
  const changed = await runSubmission(client, { ...NEW_SYSTEM, studiesFile: FILE('studies-v2.xlsx') }, { opened: second.opened });
  assert.deepEqual(client.calls.at(-1), { kind: 'studies', file: FILE('studies-v2.xlsx'), mode: 'merge', submissionId: 's-1', replaceStaged: true });
  assert.equal(changed.error, null);

  // Another AI system opens its own submission.
  const other = await runSubmission(client, { ...NEW_SYSTEM, modelVersion: 'Other-1.0' }, { opened: changed.opened });
  assert.equal(other.opened.submissionId, 's-2');
});

test('Submit is always there: it names every missing answer at once and sends nothing', () => {
  const empty = emptySubmitForm('');
  const problems = submitProblems(empty);
  assert.deepEqual(Object.keys(problems).sort(), ['developerName', 'displayName', 'modelVersion', 'useCase']);
  const existing = submitProblems({ ...empty, developerName: 'A', system: 'existing' });
  assert.deepEqual(Object.keys(existing).sort(), ['existing', 'parts']);
  assert.equal(problemSummary(existing), 'One field still needs an answer. Add at least one part: a narrow model card, studies, performance metrics, or evaluation results. Nothing was sent.');
  assert.equal(problemSummary(problems), '4 fields still need an answer. Nothing was sent.');
  const page = source('SubmitPage.jsx');
  assert.match(page, /className="button-filled" disabled=\{busy\} onClick=\{submit\}/);
  assert.match(page, /label="Your name or organisation"/);
  assert.match(page, /problem=\{shown\.displayName \?\? null\}/);
  assert.match(page, /problem=\{shown\.useCase \?\? null\}/);
  assert.match(page, /problem=\{shown\.existing \?\? null\}/);
  // The check poll drops a reply that arrives after "New submission".
  assert.match(page, /if \(!cancelled\) setSubmission\(next\);/);
});

test('submissions name the AI system by its display name and the metrics part as Performance metrics', () => {
  const models = [{ model_version: 'Corvessa-Skin-Review-1.2', display_name: 'Corvessa Skin Review 1.2' }];
  assert.equal(systemName('Corvessa-Skin-Review-1.2', models), 'Corvessa Skin Review 1.2');
  assert.equal(systemName('Tidewell-Sepsis-1.0', models, 'Tidewell Sepsis 1.0'), 'Tidewell Sepsis 1.0', 'a new AI system: its staged entry');
  assert.equal(systemName('Tidewell-Sepsis-1.0', models), 'Tidewell-Sepsis-1.0');
  assert.equal(PART_WORDS.metrics, 'Performance metrics');
  assert.equal(PART_WORDS.models, 'AI system entry');
  assert.match(source('ReleasePage.jsx'), /\['metrics', 'Performance metrics'\]/);
  assert.match(source('ReviewPage.jsx'), /'Stage as performance metrics'/);
  assert.match(source('ReviewPage.jsx'), /systemName\(entry\.model_version, models\)/);
});

// ------------------------------------------------------------ Custodian review

test('Custodian review acts only on the submission chosen, confirms Return, and keeps errors visible', () => {
  const page = source('ReviewPage.jsx');
  assert.match(page, /const shown = open\?\.submission_id === openId \? open : null;/);
  assert.match(page, /submissionId: shown\.submission_id/);
  assert.doesNotMatch(page, /open\.submission_id, note/);
  assert.match(page, /useEffect\(\(\) => \{\n\s+setNote\(''\);\n\s+setShownChanges\(null\);/);
  assert.match(page, /title="Return this submission\?"/);
  assert.match(page, /onClick=\{\(\) => setIsConfirmingReturn\(true\)\}/);
  assert.match(page, /Returned to the developer with your note\./);
  assert.match(page, /Could not read the changes/);
  assert.match(page, /if \(error\?\.name === 'AbortError' \|\| controller\.signal\.aborted\) return;/);
  assert.match(page, /Decided \(\{decidedAll\.length\}\)/);
  assert.match(page, /The \{DECIDED_SHOWN\} most recent\./);
});

test('a part’s change summary region exists before it opens, so aria-controls names it', async () => {
  const { default: SubmissionParts } = await load('/src/features/admin/SubmissionParts.jsx');
  const uploads = [{ upload_id: 'u1', kind: 'metrics', status: 'valid', origin: 'file', filename: 'm.xlsx', target: { model_version: 'C-1', use_case: 'CDSS' } }];
  const html = renderToStaticMarkup(
    h(SubmissionParts, {
      uploads,
      systemName: () => 'Corvessa 1',
      actions: () => h('button', { 'aria-controls': 'changes-u1' }, 'Show'),
      below: () => ({ id: 'changes-u1', shown: false, content: h('p', null, 'Rows') })
    })
  );
  assert.match(html, /<div class="submission-part-below" id="changes-u1" hidden="">/);
  assert.doesNotMatch(html, /Rows/);
  assert.match(html, /<div class="submission-part-actions"><button/, 'a block container for the part’s actions');
  assert.match(html, /Performance metrics<span class="submission-part-target">, Corvessa 1, /);
});

// ------------------------------------------------------------ files and focus

test('file fields are real buttons with their own names; the input is out of the tab order', async () => {
  const { FileButton } = await load('/src/features/admin/FormFields.jsx');
  const html = renderToStaticMarkup(h(FileButton, { label: 'Choose the studies file…', accept: '.csv', onFile() {} }));
  assert.match(html, /<button type="button" class="button-tinted file-button">.*Choose the studies file…<\/button>/);
  assert.match(html, /<input class="visually-hidden" type="file" accept="\.csv" tabindex="-1" aria-hidden="true"\/>/);
  assert.match(source('SubmitPage.jsx'), /`Choose the \$\{chooseLabel\} file…`/);
  assert.match(source('ReleasePage.jsx'), /'Choose the release file…'/);
  assert.match(source('ModelCardInput.jsx'), /label="Open a card file…"/);
  for (const name of ['SubmitPage.jsx', 'ReleasePage.jsx', 'ModelCardInput.jsx']) {
    assert.doesNotMatch(source(name), /<label className="[^"]*file-button/, name);
  }
});

test('after a main action the focus moves to what says what happened', () => {
  const calls = [];
  const node = {
    tagName: 'P',
    attributes: {},
    hasAttribute(name) {
      return name in this.attributes;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    focus(options) {
      calls.push(['focus', options]);
    },
    scrollIntoView(options) {
      calls.push(['scroll', options]);
    }
  };
  const win = { matchMedia: () => ({ matches: true }) };
  assert.equal(focusNode(null, { win }), false);
  assert.equal(focusNode(node, { win }), true);
  assert.equal(node.attributes.tabindex, '-1', 'a status line is made focusable from script');
  assert.deepEqual(calls, [['focus', { preventScroll: false }]]);
  calls.length = 0;
  focusNode(node, { scroll: true, win });
  assert.deepEqual(calls, [['scroll', { block: 'center', behavior: 'auto' }], ['focus', { preventScroll: true }]], 'no motion when it is reduced');
  assert.match(source('ReviewPage.jsx'), /focusNode\(resultRef\.current\)/);
  assert.match(source('ModelCardsPage.jsx'), /focusNode\(publishedRef\.current\)/);
  assert.match(source('ReleasePage.jsx'), /focusNode\(publishedRef\.current\)/);
  assert.match(source('SubmitPage.jsx'), /focusPageTitle\(\);/);
  assert.match(source('AdminApp.jsx'), /focusPageTitle\(\);/);
});

// ------------------------------------------------------------ requests

test('the data set page reads each stored list once and its /meta per live version', () => {
  const page = source('DatasetPage.jsx');
  assert.equal((page.match(/client\.listStudies\(/g) ?? []).length, 1);
  assert.equal((page.match(/client\.listEffects\(/g) ?? []).length, 1);
  assert.doesNotMatch(page, /admin\|effect-studies/);
  assert.match(page, /`admin\|meta\|local\|\$\{liveVersionId\}`/);
  assert.match(page, /`admin\|meta\|\$\{liveVersionId\}`/);
  assert.match(source('RecordFormSection.jsx'), /records=\{studies\.data\}/);
  assert.doesNotMatch(source('StoredRecordList.jsx'), /useClientQuery/, 'the list draws what the page read');
});
