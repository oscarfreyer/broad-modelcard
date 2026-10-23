import { memo, useMemo, useRef } from 'react';
import { withHelp } from '../../design/HelpTip.js';
import Icon from '../../design/Icon.jsx';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import StatusLabel from '../../design/StatusLabel.jsx';
import StatusMark from '../../design/StatusMark.js';
import { DISPLAY, isRollupWithoutChildren, isSafetyView, isUnmapped, metricRowStatus, overviewStatus, viewLabel } from '../../design/status.js';
import { aboutResult, emptyRollupSentence, levelNoun } from './copy/aboutResult.js';
import { presentedSafeguards, presentedWarnings } from './copy/emptyRollup.js';
import { incidentsMark, incidentsMarkWord, openIncidentChip } from './copy/incidentCopy.js';
import { highWarningCount, splitRequirement } from './copy/warningCopy.js';
import { metricSections } from './metricSections.js';
import IncidentList from './IncidentList.js';
import { AboutResult, MetricSection, RequirementLine, SafeguardList, WarningList } from './ResultSections.jsx';
import { AssessmentDisclosure, StudyQuality } from './StudySections.js';
import { BuiltOn } from './BuiltOnSection.js';
import { AcrossGroups } from './AcrossGroups.js';
import { EffectsOnOutcomes } from './EffectSections.js';
import { LocalAndPublic } from './LocalResult.js';
import { AnySettingResult } from './AnySettingResult.js';
import { noSettingResult } from './copy/settingCopy.js';
import { isLocalRow } from './copy/localCopy.js';
import { OverviewExplainer } from './OverviewExplainer.js';
import { cardLayout, plainSummary } from '../profile/audience.js';
import { conceptCode, conceptName } from '../../shared/conceptName.js';
import { resultPopulationLabel } from '../../shared/resultPopulation.js';
import '../../styles/overview.css';
import '../../styles/effects.css';
import { mappingSentence } from '../../shared/ontology.js';
import { DEPTH_OPTIONS } from '../../shared/depth.js';
import { IS_STATIC_BUILD } from '../../shared/staticBuild.js';
import { SEVERITY_NOTE } from './copy/incidentCopy.js';

/** One empty list, so memoized sections see the same value when a read has none. */
const NO_ITEMS = Object.freeze([]);


/**
 * The Health-style card for one concept: name and status (with a jump to its
 * high-priority warnings), one section per metric with its range chart,
 * safety incidents, warnings, safeguards, About this result, and exports. A
 * function's policy (clinician review) is stated once under the title, not as
 * a warning. Open Serious or Caution incidents add a chip under the status,
 * like the high-priority warnings; on the Safety view the header status is the
 * worst incident mark, and on Overview an open incident's mark comes before
 * the result, as on the ring.
 *
 * @param {object} props
 * @param {{ concept: object, path: object[], metrics: object|null, incidents?: object[] }} props.details contract ConceptMetrics
 * @param {'plain'|'expert'} props.depth
 * @param {boolean} [props.hasIntendedUse] the card has an intended-use statement
 * @param {object|null} [props.evidenceSignalWeights] /meta evidence_signal_weights (contract v1.13)
 * @param {object|null} [props.studyAdjustments] /meta evidence_study_adjustments (contract v1.13)
 * @param {object|null} [props.lens] the lens the card was read for (named beside the result)
 * @param {string|null} [props.setting] a specific care setting the card was read for (contract v1.14, §29), else null
 * @param {{ key: string, fetch: Function }|null} [props.anySettingQuery] the concept's Any-setting read, offered on
 *   request when the setting has no result (never substituted)
 * @param {string|null} [props.audience] the reader's audience preset: which sections come first
 * @param {object|null} [props.acrossGroups] Across groups (contract v1.13, §24): `{ isOpen, onToggle, query,
 *   rule, onChooseGroup }`, or null where it is not offered (the static demo)
 * @param {(() => void)|null} [props.onOpenOverviewRule] opens "How the Overview works"
 * @param {object|null} [props.ageContext] evidence age (contract v1.14, §28.5): evidenceAgeContext() of the card
 * @param {object[]|null} [props.builtOn] Built on (v1.14): useBuiltOn()'s entries, or null
 * @param {object|null} [props.functionEntry] the card's UseCaseEntry (Built on names its function category)
 */
function DetailCard({
  details,
  depth,
  onDepthChange,
  viewId,
  statusBands,
  overallScoreWeights,
  evidenceSignalWeights = null,
  studyAdjustments = null,
  hasIntendedUse = true,
  lens = null,
  setting = null,
  anySettingQuery = null,
  audience = null,
  acrossGroups = null,
  onOpenOverviewRule = null,
  ageContext = null,
  builtOn = null,
  functionEntry = null,
  onClose,
  onExport,
  isRefreshing
}) {
  const { concept, path, metrics } = details;
  const incidents = details.incidents ?? NO_ITEMS;
  // A rollup without children for the lens is No data, not out of scope (V1):
  // no sections of its own, and no scope warning or scope-stop safeguard.
  const isEmptyRollup = isRollupWithoutChildren(metrics);
  // The reader's audience decides which sections come first (audience.js); never what they say.
  const layout = cardLayout(audience, depth);
  const sections = useMemo(() => {
    const built = metrics && !isEmptyRollup ? metricSections(metrics, { depth, statusBands, overallScoreWeights, hasIntendedUse }) : [];
    return layout.hideExpertFacts ? built.map((section) => ({ ...section, facts: [] })) : built;
  }, [depth, hasIntendedUse, isEmptyRollup, layout.hideExpertFacts, metrics, statusBands, overallScoreWeights]);
  // A read under a local population names it (contract v1.10); About says so.
  const population = details.population ?? null;
  // Another classification (contract v1.13): the condition shows the ICD-11 result it maps to.
  const ontology = details.ontology ?? null;
  const mapping = details.mapping ?? null;
  const isUnmappedCondition = isUnmapped(details);
  const unmappedSubject =
    concept.level === 2 ? 'This condition has no counterpart' : `No condition in this ${levelNoun(concept.level)} has a counterpart`;
  const otherParents = details.other_parents ?? NO_ITEMS;
  const about = useMemo(
    () => aboutResult({ concept, row: metrics, depth, population, ontology, mapping }),
    [concept, depth, mapping, metrics, ontology, population]
  );
  // Who the result is for, beside it: the lens of the row shown, the prevalence, and another
  // classification when one is on screen (contract v1.13, §23).
  // A specific care setting (contract v1.14, §29) is named after the group: the row's own, else the one asked for.
  const shownSetting = metrics?.context ?? setting;
  const shownFor = resultPopulationLabel(metrics?.lens ?? lens, population, { ontology, setting: shownSetting });
  const trail = (path || [])
    .filter((entry) => entry.concept_id !== concept.concept_id)
    .map(conceptName);
  const code = conceptCode(concept, { isExpert: depth === 'expert' });
  const rollupCount = metrics?.provenance?.rollup?.child_count;
  const warningsRef = useRef(null);
  const incidentsRef = useRef(null);
  const incidentChip = openIncidentChip(incidents);
  const chapterName = (chapterId) => {
    const chapter = (path || []).find((entry) => entry.concept_id === chapterId);
    return chapter ? conceptName(chapter) : null;
  };
  let headerStatus = 'no_data';
  if (isUnmappedCondition) {
    headerStatus = 'no_mapping';
  } else if (isSafetyView(viewId)) {
    headerStatus = incidentsMark(incidents);
  } else if (viewId === 'overall') {
    headerStatus = overviewStatus(metrics, incidentsMark(incidents), { hasIntendedUse });
  } else if (metrics) {
    headerStatus = metricRowStatus(metrics, viewId, { hasIntendedUse });
  }
  // Closed incidents only: the neutral mark, but "No open incidents" while they are listed below.
  const headerWord = isSafetyView(viewId) ? incidentsMarkWord(incidents) : null;
  const { requirement, findings } = splitRequirement(presentedWarnings(metrics, metrics?.warnings));
  const highCount = highWarningCount(findings);

  const jumpTo = (ref) => {
    const heading = ref.current;
    if (!heading) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    heading.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    heading.focus({ preventScroll: true });
  };

  const hasResult = Boolean(metrics) && !isEmptyRollup;
  // No result at a specific setting (contract v1.14, §29): say so, and offer the Any-setting result on request.
  const settingEmpty = !hasResult && !isUnmappedCondition ? noSettingResult(setting, levelNoun(concept.level)) : null;
  // Sections an audience may move under the header (audience.js `cardLayout`).
  const lead = {
    assessment: hasResult ? (
      <AssessmentDisclosure
        key={`assessment-${concept.concept_id}`}
        row={metrics}
        depth={depth}
        weights={evidenceSignalWeights}
        adjustments={studyAdjustments}
        defaultOpen={layout.openAssessment}
      />
    ) : null,
    studyQuality: hasResult ? <StudyQuality row={metrics} depth={depth} hideFacts={layout.hideExpertFacts} ageContext={ageContext} /> : null,
    acrossGroups: acrossGroups ? (
      <AcrossGroups
        isOpen={acrossGroups.isOpen}
        onToggle={acrossGroups.onToggle}
        query={acrossGroups.query}
        depth={depth}
        rule={acrossGroups.rule}
        statusBands={statusBands}
        currentLens={lens}
        onChooseGroup={acrossGroups.onChooseGroup}
      />
    ) : null
  };
  // The patient preset's one-line lead, from the Overview mark the ring shows.
  const plainLead = layout.plainSummary
    ? plainSummary(overviewStatus(metrics, incidentsMark(incidents), { hasIntendedUse }), {
        performance: metricRowStatus(metrics, 'performance'),
        evidence: metricRowStatus(metrics, 'evidence')
      })
    : null;

  // On the Safety view the incidents are the card's subject, so they come
  // first, as the active view's section does on the other views (S8).
  const incidentsSection = (
    <section aria-labelledby="detail-incidents">
      {/* What Serious and Caution mean is the heading's help. */}
      {withHelp(
        <h3 id="detail-incidents" className="group-heading" ref={incidentsRef} tabIndex={-1}>Safety incidents</h3>,
        [incidents?.length ? (depth === 'expert' ? SEVERITY_NOTE.expert : SEVERITY_NOTE.plain) : null],
        'About Safety incidents'
      )}
      <IncidentList key={concept.concept_id} incidents={incidents} depth={depth} chapterName={chapterName} />
    </section>
  );
  // Effects on outcomes (contract v1.13, §27): only when the card has any here; never part of a grade.
  const effectsSection = <EffectsOnOutcomes key={`effects-${concept.concept_id}`} effects={details.effects ?? NO_ITEMS} depth={depth} />;
  // The Regulator preset leads with the incidents; on the Safety view they lead anyway.
  lead.incidents = isSafetyView(viewId) ? null : incidentsSection;
  // The Payer preset leads with the effects, where the card has any here.
  lead.effects = details.effects?.length ? effectsSection : null;

  return (
    <article className="side-card detail-card" aria-busy={isRefreshing} aria-labelledby="detail-title">
      <header className="detail-head">
        <div className="detail-head-row">
          {trail.length ? <p className="detail-trail">{trail.join(' › ')}</p> : <span />}
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close and show the summary">
            <Icon name="close" size={18} />
          </button>
        </div>
        <h2 id="detail-title" className="detail-title">{conceptName(concept)}</h2>
        <p className="detail-meta">
          {code ? <span className="code">{code}</span> : null}
          <span>{levelNoun(concept.level).replace(/^./, (letter) => letter.toUpperCase())}</span>
          {rollupCount > 0 ? (
            <span>
              Summary of {rollupCount} {ontology ? 'ICD-11 ' : ''}
              {rollupCount === 1 ? 'condition' : 'conditions'}
            </span>
          ) : null}
        </p>
        <p className="detail-population" title="Patients and prevalence this result is for">
          <Icon name="population" size={16} />
          <span>For {shownFor}</span>
        </p>
        {isLocalRow(metrics) ? (
          <p className="detail-local">
            <span className="local-dot" aria-hidden="true" />
            Local result: the hospital’s own evaluation
          </p>
        ) : null}
        {ontology && mapping ? <p className="detail-mapping">{mappingSentence(mapping, ontology.name)}</p> : null}
        {ontology && !mapping && concept.level < 2 ? (
          <p className="detail-mapping">{ontology.name} {levelNoun(concept.level)}: results mapped from ICD-11.</p>
        ) : null}
        {depth === 'expert' && otherParents.length ? (
          <p className="detail-parents">Also under {otherParents.map((parent) => conceptName(parent)).join(', ')}.</p>
        ) : null}
        <div className="detail-head-row">
          <p className="detail-status">
            <StatusLabel status={headerStatus} size="large" toned>
              {headerWord}
            </StatusLabel>
            <span className="detail-status-view">{viewLabel(viewId)}</span>
          </p>
          <SegmentedControl size="small" label="Explanation depth" options={DEPTH_OPTIONS} value={depth} onChange={onDepthChange} />
        </div>
        {incidentChip ? (
          <button type="button" className={`warning-jump incident-jump tone-${incidentChip.tone}`} onClick={() => jumpTo(incidentsRef)}>
            <StatusMark status={incidentChip.tone} size={14} />
            {incidentChip.text}
            <Icon name="chevronDown" size={14} />
          </button>
        ) : null}
        {highCount ? (
          <button type="button" className="warning-jump" onClick={() => jumpTo(warningsRef)}>
            <Icon name="warning" size={16} />
            {highCount} high-priority {highCount === 1 ? 'warning' : 'warnings'}
            <Icon name="chevronDown" size={14} />
          </button>
        ) : null}
        <RequirementLine requirement={requirement} depth={depth} />
      </header>

      {layout.plainSummary ? <p className="detail-plain-summary">{plainLead}</p> : null}

      {layout.lead.map((id) => (lead[id] ? <div key={`lead-${id}`} className="detail-lead">{lead[id]}</div> : null))}

      {isSafetyView(viewId) ? incidentsSection : null}

      {metrics && !isEmptyRollup ? (
        <div className="metric-stack">
          {sections.map((section) => (
            <MetricSection key={section.viewId} section={section} isActiveView={section.viewId === viewId} depth={depth} />
          ))}
        </div>
      ) : settingEmpty ? (
        <section className="metric-section is-empty" aria-labelledby="detail-setting-empty">
          <p id="detail-setting-empty" className="metric-figure-word">{settingEmpty.title}</p>
          <p className="metric-meaning">{settingEmpty.text} On the ring it is drawn as the No data mark.</p>
          {anySettingQuery ? (
            <AnySettingResult key={anySettingQuery.key} query={anySettingQuery} setting={setting} depth={depth} hasIntendedUse={hasIntendedUse} />
          ) : null}
        </section>
      ) : (
        <section className="metric-section is-empty">
          <p className="metric-figure-word">{DISPLAY[isUnmappedCondition ? 'no_mapping' : 'no_data'].label}</p>
          <p className="metric-meaning">
            {isUnmappedCondition
              ? `${unmappedSubject} in ICD-11, where every result is stored, so no result is shown. On the ring it is drawn as the grey No data disc struck through by a diagonal, the No mapping mark.`
              : (
                  <>
                    {isEmptyRollup
                      ? emptyRollupSentence(concept)
                      : `There is no stored or derived result for this ${levelNoun(concept.level)} with the current AI system, function, and population.`}{' '}
                    On the ring it is drawn as a light grey disc with a dark grey outline, the No data mark.
                  </>
                )}
          </p>
        </section>
      )}

      {/* A local result (contract v1.13, §26) beside the public one, right under the result it replaces. */}
      {hasResult ? <LocalAndPublic key={`local-${concept.concept_id}`} details={details} depth={depth} hasIntendedUse={hasIntendedUse} /> : null}

      {/* The Overview rule for this condition: only on Overview, whose mark it explains; not for a condition without a mapping (No mapping is not an Overview step). */}
      {viewId === 'overall' && !isUnmappedCondition ? (
        <OverviewExplainer
          key={`overview-${concept.concept_id}`}
          row={metrics}
          incidents={incidents}
          hasIntendedUse={hasIntendedUse}
          depth={depth}
          weights={overallScoreWeights}
          onOpenRule={onOpenOverviewRule}
        />
      ) : null}

      {/* The evidence behind the grade (contract v1.13): the
          appraisal on demand, then the underlying study's quality; then the
          result across patient groups (§24), a separate section about
          populations, never about the study. */}
      {layout.lead.includes('assessment') ? null : lead.assessment}
      {layout.lead.includes('studyQuality') ? null : lead.studyQuality}
      {layout.lead.includes('effects') ? null : effectsSection}
      {/* Built on (contract v1.14): the base model's result at the same condition; information only. */}
      {builtOn?.length && !isUnmappedCondition ? (
        <BuiltOn bases={builtOn} functionEntry={functionEntry} details={details} depth={depth} hasIntendedUse={hasIntendedUse} />
      ) : null}
      {layout.lead.includes('acrossGroups') ? null : lead.acrossGroups}

      {isSafetyView(viewId) || layout.lead.includes('incidents') ? null : incidentsSection}

      {metrics ? (
        <>
          <section aria-labelledby="detail-warnings">
            <h3 id="detail-warnings" className="group-heading" ref={warningsRef} tabIndex={-1}>Warnings</h3>
            <WarningList key={concept.concept_id} warnings={findings} depth={depth} source={metrics.provenance?.source} />
          </section>
          <section aria-labelledby="detail-safeguards">
            <h3 id="detail-safeguards" className="group-heading">Recommended safeguards</h3>
            <SafeguardList safeguards={presentedSafeguards(metrics, metrics.safeguards)} depth={depth} />
          </section>
        </>
      ) : null}

      <AboutResult sentences={about} />

      {/* The static demo has no exports: it says so instead of offering buttons that cannot work. */}
      {metrics && IS_STATIC_BUILD ? (
        <footer className="detail-actions">
          <p className="detail-actions-note">Exports (PDF, JSON) are part of the local app, not of this static demo.</p>
        </footer>
      ) : null}
      {metrics && !IS_STATIC_BUILD ? (
        <>
          <footer className="detail-actions">
            <button type="button" className="button-tinted" disabled={isRefreshing} onClick={() => onExport('pdf')}>
              <Icon name="export" size={18} />
              Export PDF
            </button>
            <button type="button" className="button-tinted" disabled={isRefreshing} onClick={() => onExport('json')}>
              <Icon name="export" size={18} />
              Export JSON
            </button>
            {isRefreshing ? <p className="detail-actions-note">Exports wait for the card to update.</p> : null}
          </footer>
        </>
      ) : null}
    </article>
  );
}

export default memo(DetailCard);
