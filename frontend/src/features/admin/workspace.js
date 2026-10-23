// Role workspaces of the Data Library (CONTRACT.md §26). There is
// no login: a workspace is a choice that decides which pages the sidebar
// shows, and every publish records its role and the name entered with it.
// The choice lives in this browser tab (sessionStorage, with a memory
// fallback), never on the server.

/** The four workspaces, in the order the chooser lists them. */
export const WORKSPACES = Object.freeze([
  {
    id: 'developer',
    title: 'Developer submission',
    icon: 'upload',
    detail: 'Submit an AI system with its narrow model card, studies, and performance metrics. A custodian reviews it; nothing is published until then.',
    pages: ['submit']
  },
  {
    id: 'custodian',
    title: 'Custodian review',
    icon: 'check',
    detail: 'Review developer submissions: check, preview, then accept or return them with a note.',
    pages: ['review', 'model_cards', 'history']
  },
  {
    id: 'hospital',
    title: 'Hospital administration',
    icon: 'population',
    detail: 'Local populations, local results, hospital studies and incidents, this instance, and public releases.',
    pages: ['population', 'local_metrics', 'studies', 'safety', 'instance', 'release', 'history']
  },
  {
    id: 'maintainer',
    title: 'Maintainer',
    icon: 'sheet',
    detail: 'Every data set and page.',
    pages: null // all
  }
]);

/** The pages that are not data sets, with their sidebar words. */
export const TOOL_PAGES = Object.freeze({
  submit: { title: 'Submit an AI system', icon: 'upload', detail: 'For review by a custodian' },
  review: { title: 'Submissions', icon: 'check', detail: 'Waiting for review' },
  model_cards: { title: 'Narrow model cards', icon: 'evidence', detail: 'The developers’ own cards' },
  instance: { title: 'Instance', icon: 'info', detail: 'Who runs this copy' },
  release: { title: 'Public release', icon: 'download', detail: 'Export or import' }
});

export const NO_LOGIN_NOTE = 'There is no login: the workspace is your choice. It decides which pages you see and is recorded with every publish, together with the name you enter.';

const STORAGE_KEY = 'bmc.admin.workspace.v1';
let memory = null;

export function workspaceById(id) {
  return WORKSPACES.find((entry) => entry.id === id) ?? null;
}

/** `{ id, name }` of this tab's workspace, or null before one is chosen. */
export function storedWorkspace() {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null');
    if (value && workspaceById(value.id)) {
      return { id: value.id, name: typeof value.name === 'string' ? value.name.slice(0, 80) : '' };
    }
  } catch {
    // Without storage the choice lives for this page only.
  }
  return memory;
}

export function rememberWorkspace(choice) {
  memory = choice;
  try {
    if (choice) {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Memory only.
  }
}

/** The role and name a publish records (no login; CONTRACT.md §26). A developer never publishes. */
export function publisherFields(choice = storedWorkspace()) {
  if (!choice || choice.id === 'developer') {
    return {};
  }
  const name = String(choice.name ?? '').trim();
  return { role: choice.id, ...(name ? { publisherName: name } : {}) };
}

/** Whether a page belongs to a workspace (Maintainer: every page). */
export function workspaceHasPage(workspace, page) {
  const entry = workspaceById(workspace?.id);
  return !entry || !entry.pages || entry.pages.includes(page);
}

/** "Published in Custodian review by C. Ustodian" for History, or '' for versions before roles. */
export function publisherWords(entry) {
  const role = workspaceById(entry?.publisher_role)?.title;
  if (!role) return entry?.publisher_name ? `Published by ${entry.publisher_name}` : '';
  return entry.publisher_name ? `Published in ${role} by ${entry.publisher_name}` : `Published in ${role}`;
}
