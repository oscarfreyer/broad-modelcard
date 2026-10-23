import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '../../design/AppHeader.jsx';
import Icon from '../../design/Icon.jsx';
import { adminRouteSearch, nextAdminRoute, parseAdminRoute } from './adminRoute.js';
import { HELPER_NAME, helperDetail } from './assist.js';
import HelperSettingsSheet from './HelperSettingsSheet.jsx';
import useAssist from './useAssist.js';
import DatasetPage from './DatasetPage.jsx';
import { DATASET_ORDER, DATASETS, sidebarChange } from './datasets.js';
import HistoryPage from './HistoryPage.jsx';
import { focusPageTitle } from './focus.js';
import { describeProblem } from './problems.js';
import useAdminData from './useAdminData.js';
import WorkspaceChooser from './WorkspaceChooser.jsx';
import SubmitPage from './SubmitPage.jsx';
import ReviewPage from './ReviewPage.jsx';
import InstancePage from './InstancePage.jsx';
import ReleasePage from './ReleasePage.jsx';
import ModelCardsPage from './ModelCardsPage.jsx';
import { TOOL_PAGES, rememberWorkspace, storedWorkspace, workspaceById, workspaceHasPage } from './workspace.js';

/** The study helper's row: its state in one line; it opens the settings sheet. */
function HelperRow({ assist }) {
  return (
    <ul className="sidebar-group is-pair">
      <li>
        <button
          type="button"
          className="sidebar-row sidebar-button"
          onClick={assist.open}
          aria-haspopup="dialog"
          aria-label={HELPER_NAME}
          aria-describedby="sidebar-detail-helper"
        >
          <Icon name="evidence" size={22} className="sidebar-icon" />
          <span className="sidebar-text">
            <span className="sidebar-title-line">
              <span className="sidebar-title">{HELPER_NAME}</span>
            </span>
            <span className="sidebar-detail" id="sidebar-detail-helper">
              {assist.error && !assist.status ? 'Status could not be read' : helperDetail(assist.status)}
            </span>
          </span>
        </button>
      </li>
    </ul>
  );
}

/** The chosen workspace in the sidebar: its name, the name entered, and the way to change it (no login). */
function WorkspaceRow({ workspace, onNavigate }) {
  const entry = workspaceById(workspace?.id);
  return (
    <div className="sidebar-workspace">
      <span className="sidebar-workspace-text">
        <span className="sidebar-workspace-title">{entry ? entry.title : 'No workspace chosen'}</span>
        <span className="sidebar-detail">{workspace?.name ? workspace.name : 'No name entered'}, no login</span>
      </span>
      <a
        className="button-plain sidebar-workspace-change"
        href={adminRouteSearch({ page: 'workspaces' })}
        onClick={(event) => {
          event.preventDefault();
          onNavigate({ page: 'workspaces' });
        }}
      >
        Change
      </a>
    </div>
  );
}

export function Sidebar({ page, datasets, onNavigate, assist = null, workspace = null }) {
  const shows = (target) => workspaceHasPage(workspace, target);
  const byKind = new Map((datasets ?? []).map((entry) => [entry.kind, entry]));
  const link = (target, icon, title, detail, waiting = 0) => {
    const href = adminRouteSearch({ page: target });
    // Named by the title (and what waits); the change line describes it.
    const detailId = `sidebar-detail-${target}`;
    return (
      <li key={target}>
        <a
          className={`sidebar-row${page === target ? ' is-current' : ''}`}
          href={href}
          aria-current={page === target ? 'page' : undefined}
          aria-label={waiting ? `${title}, ${waiting} waiting` : title}
          aria-describedby={detail ? detailId : undefined}
          onClick={(event) => {
            event.preventDefault();
            onNavigate({ page: target });
          }}
        >
          <Icon name={icon} size={22} className="sidebar-icon" />
          <span className="sidebar-text">
            <span className="sidebar-title-line">
              <span className="sidebar-title">{title}</span>
              {waiting ? <span className="sidebar-badge">{waiting} waiting</span> : null}
            </span>
            {detail ? (
              <span className="sidebar-detail" id={detailId}>
                {typeof detail === 'string' ? (
                  detail
                ) : (
                  <>
                    <span aria-hidden="true">{detail.short}</span>
                    <span className="visually-hidden">{detail.spoken}</span>
                  </>
                )}
              </span>
            ) : null}
          </span>
        </a>
      </li>
    );
  };
  return (
    <nav className="admin-sidebar" aria-label="Data Library">
      {/* A label, not a heading: the page's h1 comes first in the outline. */}
      <WorkspaceRow workspace={workspace} onNavigate={onNavigate} />
      {['submit', 'review'].some(shows) ? (
        <ul className="sidebar-group">
          {['submit', 'review'].filter(shows).map((target) => link(target, TOOL_PAGES[target].icon, TOOL_PAGES[target].title, TOOL_PAGES[target].detail))}
        </ul>
      ) : null}
      {DATASET_ORDER.some(shows) ? (
        <>
          <p className="sidebar-heading">Data sets</p>
          <ul className="sidebar-group is-datasets">
            {DATASET_ORDER.filter(shows).map((kind) => {
              const info = byKind.get(kind);
              const waiting = info ? (info.staged_upload_ids ?? (info.staged_upload_id ? [info.staged_upload_id] : [])).length : 0;
              return link(kind, DATASETS[kind].icon, DATASETS[kind].title, info ? sidebarChange(info) : null, waiting);
            })}
          </ul>
        </>
      ) : null}
      {['model_cards', 'instance', 'release'].some(shows) ? (
        <ul className="sidebar-group">
          {['model_cards', 'instance', 'release'].filter(shows).map((target) => link(target, TOOL_PAGES[target].icon, TOOL_PAGES[target].title, TOOL_PAGES[target].detail))}
        </ul>
      ) : null}
      {shows('history') ? <ul className="sidebar-group is-pair">{link('history', 'history', 'History', 'Every version, and restore')}</ul> : null}
      {assist && shows('metrics') ? <HelperRow assist={assist} /> : null}
    </nav>
  );
}

function UnavailableState({ error, onRetry }) {
  const problem = describeProblem(error);
  return (
    <div className="admin-page admin-state" role="alert">
      <Icon name="warning" size={30} className="admin-state-icon" />
      <h1 className="admin-title">{problem.title}</h1>
      <p className="admin-card-text">{problem.text}</p>
      {error?.code === 'backend_unavailable' ? <code className="ring-state-command">npm run dev</code> : null}
      <button type="button" className="button-filled" onClick={onRetry}>
        <Icon name="retry" size={18} />
        Try again
      </button>
    </div>
  );
}

function defaultTarget(models, route) {
  const list = models?.models ?? [];
  const model = list.find((entry) => entry.model_version === route.model) ?? list.find((entry) => entry.model_version === models?.default_model_version) ?? list[0];
  if (!model) {
    return null;
  }
  const useCases = model.use_cases.map((entry) => entry.use_case);
  const useCase = useCases.includes(route.useCase) ? route.useCase : model.default_use_case ?? useCases[0];
  return { model: model.model_version, useCase };
}

/**
 * The Data Library: a workspace choice (no login), then a sidebar of that
 * workspace's pages (submissions, the data sets, narrow model cards, instance,
 * public release, History). Each data set page walks through template, upload
 * (or the one-record form), check, changes, preview, and publish.
 */
export default function AdminApp() {
  const library = useAdminData();
  const assist = useAssist();
  const [route, setRoute] = useState(() => parseAdminRoute(window.location.search));
  // The route as last set and the page shown, so navigate() works out the next route outside a state updater.
  const routeRef = useRef(route);
  routeRef.current = route;
  const pageRef = useRef(null);
  // The workspace (contract v1.13, §26): a choice per browser tab, without login.
  const [workspace, setWorkspace] = useState(() => storedWorkspace());

  /** Moves to another page or target; `replace` keeps the browser history entry. */
  const navigate = useCallback((next, { replace = false } = {}) => {
    const merged = nextAdminRoute(routeRef.current, pageRef.current, next);
    routeRef.current = merged;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', adminRouteSearch(merged));
    setRoute(merged);
    if (!replace) {
      window.scrollTo({ top: 0 });
    }
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(parseAdminRoute(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const target = useMemo(() => defaultTarget(library.models, route), [library.models, route]);
  const onPopulationChange = useCallback((population) => navigate({ population }, { replace: true }), [navigate]);
  // Without a page in the URL, or without a workspace yet, the Data Library opens on the workspace choice.
  const firstPage = (choice) => workspaceById(choice?.id)?.pages?.[0] ?? route.page;
  const page = route.page === 'workspaces' || !workspace ? 'workspaces' : route.explicit ? route.page : firstPage(workspace);
  pageRef.current = page;
  const dataset = DATASETS[page] ?? null;
  const info = library.datasets?.find((entry) => entry.kind === page) ?? null;

  const toolTitle = page === 'workspaces' ? 'Workspace' : TOOL_PAGES[page]?.title;
  useEffect(() => {
    document.title = `${toolTitle ?? (dataset ? dataset.title : 'History')} – Data Library – Broad Modelcard`;
  }, [dataset, toolTitle]);
  const choose = (choice) => {
    rememberWorkspace(choice);
    setWorkspace(choice);
    navigate({ page: workspaceById(choice.id)?.pages?.[0] ?? 'models' });
    // The chooser is gone: the focus moves to the title of the workspace's first page.
    focusPageTitle();
  };

  let content;
  if (page === 'workspaces') {
    content = <WorkspaceChooser current={workspace} onChoose={choose} />;
  } else if (library.error && !library.datasets) {
    content = <UnavailableState error={library.error} onRetry={library.reload} />;
  } else if (page === 'submit') {
    content = <SubmitPage models={library.models?.models ?? null} workspace={workspace} />;
  } else if (page === 'review') {
    content = <ReviewPage models={library.models?.models ?? null} workspace={workspace} onLibraryChange={library.reload} />;
  } else if (page === 'instance') {
    content = <InstancePage />;
  } else if (page === 'release') {
    content = <ReleasePage onLibraryChange={library.reload} />;
  } else if (page === 'model_cards') {
    content = <ModelCardsPage models={library.models?.models ?? null} onLibraryChange={library.reload} />;
  } else if (page === 'history') {
    content = <HistoryPage versions={library.versions} onLibraryChange={library.reload} />;
  } else {
    content = (
      <DatasetPage
        key={page}
        dataset={dataset}
        info={info}
        models={library.models?.models ?? null}
        versions={library.versions}
        target={target}
        onTargetChange={(next, options) => navigate({ model: next.model, useCase: next.useCase }, options)}
        population={route.population}
        onPopulationChange={onPopulationChange}
        publishedVersion={route.published}
        onPublished={(entry) => navigate({ published: entry.version_id }, { replace: true })}
        onLibraryChange={library.reload}
        assist={assist}
      />
    );
  }

  return (
    <div className="admin-frame">
      <AppHeader current="admin" />
      <div className="admin-shell">
        <Sidebar page={page} datasets={library.datasets} onNavigate={navigate} assist={assist} workspace={workspace} />
        <main className="admin-main">{content}</main>
      </div>
      {assist.isOpen ? <HelperSettingsSheet assist={assist} /> : null}
    </div>
  );
}
