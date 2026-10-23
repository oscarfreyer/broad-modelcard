import { useEffect, useRef, useState } from 'react';
import useClientQuery from '../../api/useClientQuery.js';
import HelpTip from '../../design/HelpTip.js';
import Icon from '../../design/Icon.jsx';
import { hasIntendedUseStatement } from '../../design/status.js';
import { displayUseCase } from '../../shared/format.js';
import ChangesStep from './ChangesStep.jsx';
import CheckStep from './CheckStep.jsx';
import { count, dateTime, plural, versionSummary } from './datasets.js';
import ProblemNotice from './ProblemNotice.jsx';
import { PreviewStep, PublishedCard, PublishStep, updateName } from './PublishSteps.jsx';
import StepCard from './StepCard.jsx';
import TargetPicker from './TargetPicker.jsx';
import TemplateStep from './TemplateStep.jsx';
import UploadStep from './UploadStep.jsx';
import useStagedUpload from './useStagedUpload.js';
import { hasNoChanges } from './changeSummary.js';
import { emptyStudy } from './studies.js';
import { emptyEffect } from './effects.js';
import { emptyIncident, emptyMetricRow, modeShort } from './records.js';
import { revealAndFocus } from './focus.js';
import LocalPopulationCard from './LocalPopulationCard.jsx';
import RecordFormSection from './RecordFormSection.jsx';
import useIncidentIds from './useIncidentIds.js';
import { isHelperEntry, recordsEntryWords, rememberHelperEntry } from './assist.js';
import StudyHelper from './StudyHelper.jsx';
import EvaluationImport from './EvaluationImport.jsx';
import useProposals from './useProposals.js';
import PopulationPicker from './PopulationPicker.jsx';
import { NEW_POPULATION, populationChoices, populationLabel, populationTarget, shownPopulationChoice, withoutRemoved } from './populations.js';
import { describeProblem } from './problems.js';

const WAITING_WORDS = { checking: 'being checked', invalid: 'needs a fix', valid: 'ready to publish' };

/** Step states from the staged upload: what is done, what is next, what waits. */
function stepStates(upload, isRestoring) {
  if (isRestoring) {
    return { template: 'waiting', upload: 'waiting', check: 'waiting', changes: 'waiting', preview: 'waiting', publish: 'waiting' };
  }
  if (!upload) {
    // "Next" goes with the one filled button (Choose a file); the spreadsheet step stays open beside it.
    return { template: 'ready', upload: 'current', check: 'waiting', changes: 'waiting', preview: 'waiting', publish: 'waiting' };
  }
  if (upload.status === 'checking') {
    return { template: 'done', upload: 'done', check: 'working', changes: 'waiting', preview: 'waiting', publish: 'waiting' };
  }
  if (upload.status === 'invalid') {
    // A form entry is fixed in the form, so step 2 opens again with it.
    return { template: 'done', upload: upload.origin === 'records' ? 'current' : 'done', check: 'fix', changes: 'waiting', preview: 'waiting', publish: 'waiting' };
  }
  // The next action is the preview until it has been seen, then the publish.
  return {
    template: 'done',
    upload: 'done',
    check: 'done',
    changes: 'ready',
    preview: upload.previewed ? 'done' : 'current',
    publish: upload.previewed ? 'current' : 'ready'
  };
}

function AboutCard({ dataset, info }) {
  return (
    <section className="admin-card about-card" aria-labelledby="about-title">
      <div className="page-title-row">
        <h2 id="about-title" className="admin-card-title">About this data</h2>
        <HelpTip label="About this data set">
          <p>{dataset.about}</p>
        </HelpTip>
      </div>
      {info ? (
        <dl className="figure-row">
          {dataset.counts.map(({ key, label }) => (
            <div key={key} className="figure-cell">
              <dt className="figure-unit">{label}</dt>
              <dd className="figure">{count(info.counts?.[key])}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {dataset.caution ? (
        <p className="admin-card-text muted">
          <Icon name="info" size={18} className="inline-icon" /> {dataset.caution}
        </p>
      ) : null}
    </section>
  );
}

// Safety incidents (and effects, contract v1.13) name their cards row by row;
// the page keeps one card for the form, the preview, and "View on atlas". For a
// form entry that is the form's card, kept per upload for this browser tab.
const CARD_KEY = 'bmc.admin.formCard.';

function rememberCard(upload, card) {
  try {
    window.sessionStorage.setItem(CARD_KEY + upload.upload_id, JSON.stringify(card));
  } catch {
    // Without storage the page falls back to the card in its URL.
  }
}

function rememberedCard(upload) {
  if (!upload || upload.origin !== 'records') return null;
  try {
    const card = JSON.parse(window.sessionStorage.getItem(CARD_KEY + upload.upload_id) ?? 'null');
    return card?.model && card?.useCase ? card : null;
  } catch {
    return null;
  }
}

// What a form entry held when it was sent, per upload for this browser tab,
// so "Start the form again" can refill the form after a reload.
const ENTRY_KEY = 'bmc.admin.formEntry.';

function rememberEntry(upload, form) {
  try {
    window.sessionStorage.setItem(ENTRY_KEY + upload.upload_id, JSON.stringify(form));
  } catch {
    // Without storage the form starts again empty.
  }
}

function rememberedEntry(upload) {
  if (!upload || upload.origin !== 'records') return null;
  try {
    const form = JSON.parse(window.sessionStorage.getItem(ENTRY_KEY + upload.upload_id) ?? 'null');
    return form && typeof form === 'object' ? form : null;
  } catch {
    return null;
  }
}

/**
 * One data set: what it holds, then the update flow as steps on one page
 * (template, upload, check, changes, preview, publish), restored from the
 * server whenever the maintainer comes back.
 */
export default function DatasetPage({
  dataset,
  info,
  models,
  versions,
  target: pickedTarget,
  onTargetChange,
  population: routePopulation = null,
  onPopulationChange = null,
  publishedVersion,
  onPublished,
  onLibraryChange,
  assist = null
}) {
  // The live version of the whole library. A /meta read keyed on it is read
  // again after any publish, e.g. a local population published on its own page.
  const liveVersionId = versions?.[0]?.version_id ?? null;
  // Local populations (contract v1.10) are listed by the live /meta; its key
  // follows the data set's version, so a publish or removal reads it again.
  const populationMeta = useClientQuery(dataset.needsPopulation ? `admin|meta|population|${info?.version ?? ''}` : null, (client, options) =>
    client.getMeta({}, { ...options, version: 'live' })
  );
  // A population removed here stops being a choice at once, until /meta is read again.
  const [removedPopulation, setRemovedPopulation] = useState(null);
  const livePopulations = withoutRemoved(
    populationMeta.data?.populations ?? null,
    removedPopulation?.meta === populationMeta.data ? removedPopulation?.id : null
  );
  // The staged uploads seen last render: a new population waiting to be published is a choice too.
  const [stagedSeen, setStagedSeen] = useState([]);
  const choices = dataset.needsPopulation ? populationChoices(livePopulations, stagedSeen) : [];
  const [populationState, setPopulationState] = useState({ choice: routePopulation ?? null, draft: { id: '', name: '' } });
  // The population of the page's staged upload last render (a new one is not in the staged list yet).
  const stagedPopulationRef = useRef(null);
  // The page opens on the population in its URL, else the first live one; a choice that is
  // not (or no longer) one, e.g. a stale ?population= link, falls back the same way.
  const populationChoice = shownPopulationChoice(populationState.choice, choices, {
    isLoaded: Boolean(livePopulations),
    stagedId: stagedPopulationRef.current
  });
  const shownPopulationState = { ...populationState, choice: populationChoice ?? NEW_POPULATION };
  const popTarget = dataset.needsPopulation && populationChoice != null ? populationTarget(shownPopulationState, choices) : null;
  const choosePopulation = (next) => {
    setPopulationState(next);
    if (next.choice !== populationState.choice && onPopulationChange) {
      onPopulationChange(next.choice === NEW_POPULATION ? null : next.choice);
    }
  };
  const [removed, setRemoved] = useState(null);
  // Local results (contract v1.13, §26) belong to a card and a published local population.
  const localMeta = useClientQuery(dataset.needsLocalPopulation && liveVersionId ? `admin|meta|local|${liveVersionId}` : null, (client, options) =>
    client.getMeta({}, { ...options, version: 'live' })
  );
  const localChoices = localMeta.data?.populations ?? null;
  const localPopulationId = dataset.needsLocalPopulation
    ? (localChoices ?? []).find((entry) => entry.id === routePopulation)?.id ?? localChoices?.[0]?.id ?? null
    : null;
  // Performance metrics and multimorbidity belong to one AI system and function (a card); a local population update to one population.
  const target = dataset.needsTarget
    ? dataset.needsLocalPopulation
      ? pickedTarget && localPopulationId
        ? { ...pickedTarget, localPopulationId }
        : null
      : pickedTarget
    : popTarget;
  // The record forms' /meta (axes, chapters, and the live local populations the study form offers).
  const meta = useClientQuery(dataset.recordForm && liveVersionId ? `admin|meta|${liveVersionId}` : null, (client, options) => client.getMeta({}, options)).data;
  // A card without an intended-use statement (contract v1.11) is not asked for intended use in the one-row form.
  const cardEntry = (models ?? []).find((entry) => entry.model_version === target?.model)?.use_cases?.find((entry) => entry.use_case === target?.useCase);
  const cardHasIntendedUse = cardEntry ? hasIntendedUseStatement(cardEntry) : true;
  const [mode, setMode] = useState(dataset.defaultMode ?? 'replace');
  const [entry, setEntry] = useState(['incident', 'study', 'effect'].includes(dataset.recordForm) ? 'record' : 'file');
  const [incident, setIncident] = useState(() => emptyIncident({ card: pickedTarget }));
  const [metricRow, setMetricRow] = useState(() => emptyMetricRow());
  // The one-study form (contract v1.13).
  const [study, setStudy] = useState(() => emptyStudy());
  // The one-effect form (contract v1.13, §27).
  const [effect, setEffect] = useState(() => emptyEffect({ card: pickedTarget }));
  // Form entries whose form state this page holds: sent from here, or
  // refilled with "Start the form again" ('kept'), or started again empty
  // because nothing was remembered ('empty'). Any other form entry was sent
  // before a reload, and the form no longer holds it.
  const [formEntries, setFormEntries] = useState({});
  useEffect(() => {
    // The incident form starts on the page's card once the registry has loaded.
    setIncident((form) => (form.model || !pickedTarget ? form : { ...form, model: pickedTarget.model, useCase: pickedTarget.useCase }));
  }, [pickedTarget]);
  const session = useStagedUpload({
    kind: dataset.kind,
    target,
    stagedIds: info?.staged_upload_ids ?? (info?.staged_upload_id ? [info.staged_upload_id] : []),
    onLibraryChange
  });
  const { upload, changes, isRestoring } = session;
  const stagedKey = session.stagedUploads.map((entry) => `${entry.upload_id}:${entry.status}`).join(',');
  useEffect(() => {
    if (dataset.needsPopulation) {
      setStagedSeen(session.stagedUploads);
    }
    // stagedKey stands for the list, a new array on every restore.
  }, [dataset.needsPopulation, stagedKey]);
  // A new population's first upload makes it a choice of its own (staged, not published).
  const stagedPopulationId = dataset.needsPopulation ? upload?.target?.population_id ?? null : null;
  stagedPopulationRef.current = stagedPopulationId;
  useEffect(() => {
    if (stagedPopulationId && populationState.choice === NEW_POPULATION) {
      setPopulationState((current) => ({ ...current, choice: stagedPopulationId }));
      onPopulationChange?.(stagedPopulationId);
    }
  }, [onPopulationChange, populationState.choice, stagedPopulationId]);
  // The study helper's proposals for this data set (and, for metrics, this card).
  const helper = useProposals({ kind: dataset.kind, card: dataset.needsTarget ? target : null });
  const states = stepStates(upload, isRestoring);
  // A form entry remembers its card, so its preview and "View on atlas" open
  // that card after a round trip to the atlas (the URL may name another).
  const formCard = dataset.kind === 'safety' || dataset.kind === 'effects' ? rememberedCard(upload) : null;
  const card = dataset.needsTarget || dataset.needsPopulation ? target : dataset.kind === 'safety' ? formCard ?? pickedTarget : formCard;

  // When the update moves on (uploaded, checked, published), bring its step into view.
  const listRef = useRef(null);
  const progressKey = `${upload?.upload_id ?? ''}:${upload?.status ?? ''}:${session.published?.version_id ?? ''}`;
  const lastProgressKey = useRef(null);
  useEffect(() => {
    if (isRestoring) {
      return;
    }
    const previous = lastProgressKey.current;
    lastProgressKey.current = progressKey;
    if (previous === null || previous === progressKey) {
      return;
    }
    // After a discard, step 2 (with the discard notice above it) is where the next update starts.
    const index = session.published ? -1 : !upload ? (session.discarded ? 1 : 0) : upload.status === 'valid' ? 3 : 2;
    const node = index < 0 ? document.querySelector('.result-card') : listRef.current?.children[index];
    node?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [isRestoring, progressKey, session.discarded, session.published, upload]);
  // After a discard the button that led there is gone: the focus moves to
  // step 2, where the next update starts, and the status line above it says
  // that the live data did not change (M1).
  const focusStep = (index) =>
    window.setTimeout(() => listRef.current?.children[index]?.querySelector('.step-header')?.focus({ preventScroll: true }), 0);
  const discardToken = session.discarded?.token ?? null;
  useEffect(() => {
    if (discardToken) {
      listRef.current?.children[1]?.querySelector('.step-header')?.focus({ preventScroll: true });
    }
  }, [discardToken]);
  const liveVersion = versions?.[0]?.version_id ?? info?.version ?? 1;
  const nextVersion = liveVersion + 1;
  // The version the stored lists read: a publish here reads them again at once.
  const listVersion = session.published?.version_id ?? liveVersion;
  const storedIncidentIds = useIncidentIds({
    enabled: dataset.recordForm === 'incident',
    refreshKey: listVersion,
    upload,
    stagedUploads: session.stagedUploads,
    isRestoring,
    freshId: incident.freshId,
    setIncident
  });
  // The stored studies, read once: the study list and form, and the effect form's study choice (contract v1.13, §27).
  const storedStudies = useClientQuery(['study', 'effect'].includes(dataset.recordForm) ? `admin|studies|${listVersion}` : null, (client, options) =>
    client.listStudies({}, { ...options, version: 'live' })
  );
  // The stored effects, read once: the effect list, and the form's warning before an ID replaces a stored effect.
  const storedEffects = useClientQuery(dataset.recordForm === 'effect' ? `admin|effects|${listVersion}` : null, (client, options) =>
    client.listEffects({}, { ...options, version: 'live' })
  );
  const waiting = dataset.needsTarget
    ? session.stagedUploads
        .filter((entry) => entry.target && (entry.target.model_version !== target?.model || entry.target.use_case !== target?.useCase))
        .map((entry) => ({ model: entry.target.model_version, useCase: entry.target.use_case, label: WAITING_WORDS[entry.status] ?? entry.status }))
    : [];
  const noChanges = changes && hasNoChanges(changes);
  // The publish of this visit, also after a round trip to the atlas (the URL keeps its version).
  const published =
    session.published ?? (publishedVersion ? versions?.find((entry) => entry.version_id === publishedVersion && entry.kind === dataset.kind) ?? null : null);
  const rolledBack =
    session.rolledBack ??
    (published
      ? versions?.find((entry) => entry.version_id > published.version_id && entry.rollback_of === published.version_id - 1 && entry.kind === dataset.kind) ?? null
      : null);
  const targetText = dataset.needsTarget && target
    ? ` for ${target.model}, ${displayUseCase(target.useCase)}${target.localPopulationId ? `, ${target.localPopulationId}` : ''}`
    : dataset.needsPopulation && target
      ? ` for ${populationLabel(target)}`
      : '';

  // After a publish the forms start fresh (a new incident ID, today's reported date).
  const publishedId = session.published?.version_id ?? null;
  useEffect(() => {
    if (publishedId) {
      setIncident((form) => emptyIncident({ card: form.model ? { model: form.model, useCase: form.useCase } : null }));
      setMetricRow(emptyMetricRow());
      setStudy(emptyStudy());
      setEffect((form) => emptyEffect({ card: form.model ? { model: form.model, useCase: form.useCase } : null }));
      helper.clear();
    }
    // helper.clear is stable; the proposals are consumed by the publish.
  }, [publishedId]);

  /**
   * Stages the one-record form. A form entry that failed its check is being
   * fixed, so it is replaced without asking; any other waiting update gets
   * the replace prompt.
   */
  const submitRecords = async (records) => {
    if (dataset.kind === 'safety' && (incident.model !== pickedTarget?.model || incident.useCase !== pickedTarget?.useCase)) {
      onTargetChange({ model: incident.model, useCase: incident.useCase }, { replace: true });
    }
    if (dataset.kind === 'safety') {
      // The form on screen now names a staged incident: it keeps its ID (records.js withNextIncidentId).
      setIncident((form) => (form.staged ? form : { ...form, staged: true }));
    }
    // Also runs after the replace prompt, which sends the same payload later (S8).
    const onCreated = (created) => {
      // The button that staged it gives way to the check: the focus follows.
      focusStep(2);
      setFormEntries((entries) => ({ ...entries, [created.upload_id]: 'kept' }));
      rememberEntry(created, { safety: incident, studies: study, effects: effect }[dataset.kind] ?? metricRow);
      if (dataset.kind === 'safety') {
        rememberCard(created, { model: incident.model, useCase: incident.useCase });
      } else if (dataset.kind === 'effects') {
        rememberCard(created, { model: effect.model, useCase: effect.useCase });
      }
    };
    await session.send({ records, onCreated }, upload?.origin === 'records' && upload.status === 'invalid');
  };

  /**
   * Stages the records the maintainer kept from the helper's proposals: a
   * records upload (a merge), then the ordinary check. A helper entry that
   * failed its check is being fixed, so it is replaced without asking.
   */
  const stageProposals = async (request) => {
    const first = request.records[0];
    if (dataset.kind === 'safety' && first && (first.model_version !== pickedTarget?.model || first.use_case !== pickedTarget?.useCase)) {
      onTargetChange({ model: first.model_version, useCase: first.use_case }, { replace: true });
    }
    const onCreated = (created) => {
      focusStep(2);
      rememberHelperEntry(created);
      helper.markStaged(created.upload_id);
      if (dataset.kind === 'safety' && first) {
        rememberCard(created, { model: first.model_version, useCase: first.use_case });
      }
    };
    await session.send({ records: request.records, fromHelper: true, onCreated }, upload?.origin === 'records' && upload.status === 'invalid');
  };

  /**
   * After a reload a form entry that needs a fix is no longer in the form:
   * open the form again, refilled with what was sent when this tab remembers
   * it, otherwise empty, and bring its first field into view.
   */
  const restartForm = () => {
    if (!upload) return;
    const saved = rememberedEntry(upload);
    if (dataset.kind === 'safety') {
      setIncident(saved ?? emptyIncident({ card }));
    } else if (dataset.kind === 'studies') {
      setStudy(saved ?? emptyStudy());
    } else if (dataset.kind === 'effects') {
      setEffect(saved ?? emptyEffect());
    } else {
      setMetricRow(saved ?? emptyMetricRow());
    }
    setFormEntries((entries) => ({ ...entries, [upload.upload_id]: saved ? 'kept' : 'empty' }));
    setEntry('record');
    revealAndFocus('.record-form input, .record-form select');
  };
  const openHelper = () => setEntry('study');
  const fromHelper = upload?.origin === 'records' && (helper.stagedIds.includes(upload.upload_id) || isHelperEntry(upload));
  const formEntry =
    upload?.origin !== 'records'
      ? null
      : fromHelper
        ? { state: helper.proposals && helper.stagedIds.includes(upload.upload_id) ? 'helper' : 'helperLost', onRestart: openHelper }
        : { state: formEntries[upload.upload_id] ?? (rememberedEntry(upload) ? 'lostSaved' : 'lost'), onRestart: restartForm };
  const isSending = session.busy === 'uploading';
  // The form shows once what it needs has loaded: the registry, or for a metrics row the card.
  const formReady = { incident: Boolean(models?.length), study: Boolean(models), effect: Boolean(models), metricRow: Boolean(target) }[dataset.recordForm] ?? false;
  const recordForm = formReady ? (
    <RecordFormSection
      dataset={dataset}
      models={models}
      meta={meta}
      target={target}
      pickedTarget={pickedTarget}
      card={card}
      forms={{ incident, setIncident, study, setStudy, effect, setEffect, metricRow, setMetricRow }}
      studies={{ data: storedStudies.data?.studies ?? null, error: storedStudies.error, retry: storedStudies.retry }}
      effects={{ data: storedEffects.data?.effects ?? null, error: storedEffects.error, retry: storedEffects.retry }}
      storedIncidentIds={storedIncidentIds}
      refreshKey={listVersion}
      hasWaitingUpdate={Boolean(upload)}
      hasIntendedUse={cardHasIntendedUse}
      isSending={isSending}
      onSubmit={submitRecords}
    />
  ) : null;
  // The study helper proposes metrics rows and incidents only (CONTRACT.md §20), not study or effect records.
  const studyHelper =
    dataset.recordForm && dataset.kind !== 'local_metrics' && dataset.kind !== 'studies' && dataset.kind !== 'effects' && assist && (dataset.kind !== 'metrics' || target) ? (
      <StudyHelper
        assist={assist}
        kind={dataset.kind}
        card={target}
        helper={helper}
        models={models}
        meta={meta}
        onStage={stageProposals}
        isStaging={isSending}
      />
    ) : null;
  const entryTitle = dataset.recordForm ? 'Enter the update' : 'Upload your file';
  const uploadSummary = upload
    ? `${upload.origin === 'records' ? recordsEntryWords(upload).replace(/^./, (letter) => letter.toUpperCase()) : `“${upload.filename}”, uploaded`} ${dateTime(upload.created_at)}${
        dataset.modes?.length > 1 ? `; ${modeShort(upload.mode, dataset.kind)}` : ''
      }.`
    : null;

  return (
    <div className="admin-page">
      <header className="admin-page-header">
        <h1 className="admin-title">{dataset.title}</h1>
        <p className="admin-subtitle">
          {info
            ? String(info.version) === String(liveVersion)
              ? `Live version ${liveVersion}, changed ${dateTime(info.updated_at)}`
              : `Live version ${liveVersion}, changed in version ${info.version}, ${dateTime(info.updated_at)}`
            : 'Loading…'}
        </p>
      </header>

      <AboutCard dataset={dataset} info={info} />

      {dataset.needsTarget && models?.length && pickedTarget ? (
        <TargetPicker models={models} target={pickedTarget} onChange={onTargetChange} waiting={waiting} />
      ) : null}

      {/* Contract v1.14 (§32.2): a benchmark or harness run's results, staged as a study and performance rows on request. */}
      {dataset.kind === 'metrics' && models?.length ? (
        <EvaluationImport
          target={target}
          models={models}
          onStaged={(created) => {
            onLibraryChange();
            const metrics = created.find((item) => item.part === 'metrics')?.upload?.target;
            if (metrics && (metrics.model_version !== target?.model || metrics.use_case !== target?.useCase)) {
              onTargetChange({ model: metrics.model_version, useCase: metrics.use_case });
            }
          }}
        />
      ) : null}

      {dataset.needsLocalPopulation && localChoices ? (
        <LocalPopulationCard populations={localChoices} value={localPopulationId} onChange={(next) => onPopulationChange?.(next)} />
      ) : null}

      {dataset.needsPopulation && livePopulations ? (
        <PopulationPicker
          choices={choices}
          state={shownPopulationState}
          onChange={choosePopulation}
          nextVersion={nextVersion}
          onRemoved={(entry) => {
            setRemoved(entry);
            setRemovedPopulation({ id: populationChoice, meta: populationMeta.data });
            setPopulationState({ choice: null, draft: { id: '', name: '' } });
            onPopulationChange?.(null);
            onLibraryChange();
          }}
        />
      ) : null}

      {removed ? (
        <section className="admin-card result-card" aria-live="polite">
          <p className="result-glyph" aria-hidden="true">
            <Icon name="check" size={22} />
          </p>
          <h2 className="admin-card-title">Removed: version {removed.version_id} is live</h2>
          <p className="admin-card-text">{versionSummary(removed.summary)} Views that used it show the default prevalence now.</p>
          {removed.note ? <p className="version-note"><span className="version-note-label">Note:</span> {removed.note}</p> : null}
          <p className="admin-card-text muted">To bring it back, restore the version before it on the History page.</p>
        </section>
      ) : null}

      {session.problem && !session.pendingReplace ? (
        <ProblemNotice
          error={session.problem}
          onDismiss={session.clearProblem}
          describe={(error) => describeProblem(error, { kind: dataset.kind })}
        />
      ) : null}

      {published ? (
        <PublishedCard
          dataset={dataset}
          target={card}
          published={published}
          rolledBack={rolledBack}
          session={session}
        />
      ) : null}

      <ol ref={listRef} className="step-list" aria-label={`Update ${dataset.title}${targetText}`}>
        <li>
          <StepCard number={1} state={states.template} title="Get the spreadsheet" summary="Download the current data or an empty template, as Excel or CSV.">
            <TemplateStep dataset={dataset} target={target} />
          </StepCard>
        </li>
        <li>
          {/* Always present, so a discard is announced; it shows right above step 2, where the focus lands. */}
          <div className="discard-status" role="status">
            {session.discarded ? (
              <p className="admin-notice is-info">
                <Icon name="check" size={20} className="admin-notice-icon" />
                <span>
                  <strong>Discarded {updateName(session.discarded.upload)}.</strong> The live data did not change
                  {info ? `; it is still version ${liveVersion}` : ''}.
                </span>
              </p>
            ) : null}
          </div>
          <StepCard number={2} state={session.pendingReplace ? 'current' : states.upload} title={entryTitle} summary={uploadSummary}>
            <UploadStep
              dataset={dataset}
              session={session}
              disabledReason={
                dataset.needsLocalPopulation && !localPopulationId
                  ? 'Publish a local population first.'
                  : dataset.needsTarget && !target
                  ? 'Choose the AI system and function first.'
                  : dataset.needsPopulation && !target
                    ? 'Choose a local population above, or give the new one a name and an id.'
                    : null
              }
              mode={mode}
              onModeChange={setMode}
              entry={entry}
              onEntryChange={setEntry}
              recordForm={recordForm}
              studyHelper={studyHelper}
            />
          </StepCard>
        </li>
        <li>
          <StepCard
            number={3}
            state={states.check}
            title={upload?.status === 'invalid' ? 'Fix the problems' : 'Check'}
            summary={
              upload?.status === 'valid'
                ? `No problems in ${upload.origin === 'records' ? 'what you entered' : plural(upload.report?.row_count ?? 0, 'row')}${upload.report?.notes?.length ? `; ${plural(upload.report.notes.length, 'note')}` : ''}.`
                : !upload
                  ? 'Every row is checked against the rules of the atlas before anything can be published.'
                  : null
            }
          >
            {upload ? <CheckStep session={session} formEntry={formEntry} /> : null}
          </StepCard>
        </li>
        <li>
          <StepCard
            number={4}
            state={states.changes}
            title="Review the changes"
            summary={
              !upload || upload.status !== 'valid'
                ? dataset.kind === 'safety'
                  ? 'Which incidents publishing adds, changes, or removes.'
                  : 'What publishing would change, in Strong, Moderate, and Weak.'
                : null
            }
          >
            {upload?.status === 'valid' ? <ChangesStep dataset={dataset} target={target} upload={upload} changes={changes} /> : null}
          </StepCard>
        </li>
        <li>
          <StepCard
            number={5}
            state={noChanges ? 'waiting' : states.preview}
            word={!noChanges && states.preview === 'current' ? 'Next, recommended' : undefined}
            title="Preview on atlas"
            summary={upload?.previewed ? 'Previewed on the atlas.' : !upload || upload.status !== 'valid' ? 'Recommended: see the update in place before publishing.' : null}
            defaultOpen={upload?.status === 'valid' && !noChanges}
          >
            {upload?.status === 'valid' && !noChanges ? (
              <PreviewStep
                dataset={dataset}
                target={card}
                upload={upload}
                changes={changes}
                models={models ?? []}
                onTargetChange={(next) => onTargetChange(next, { replace: true })}
              />
            ) : null}
          </StepCard>
        </li>
        <li>
          <StepCard
            number={6}
            state={noChanges && states.publish !== 'waiting' ? 'current' : states.publish}
            title="Publish"
            summary={!upload || upload.status !== 'valid' ? 'Make it the live data. Every version stays in the history.' : null}
          >
            {upload?.status === 'valid' ? (
              <PublishStep
                dataset={dataset}
                target={card}
                upload={upload}
                changes={changes}
                nextVersion={nextVersion}
                session={session}
                onPublished={onPublished}
              />
            ) : null}
          </StepCard>
        </li>
      </ol>
    </div>
  );
}
