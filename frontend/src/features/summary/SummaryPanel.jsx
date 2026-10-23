import { memo, useEffect, useRef, useState } from 'react';
import HelpTip, { withHelp } from '../../design/HelpTip.js';
import Icon from '../../design/Icon.jsx';
import { SEARCH_SHORTCUT } from '../../design/shortcut.js';
import StatusMark from '../../design/StatusMark.js';
import StatusStrip from '../../design/StatusStrip.jsx';
import SystemAbout from './SystemAbout.js';
import GroupSummary from './GroupSummary.js';
import AudienceSummary from './AudienceSummary.js';
import { CARD_RECORD_COPY } from './cardRecord.js';
import { LOCAL_SYNTHETIC_NOTE, localPrevalenceTitle, populationCoverage } from '../../shared/localPopulation.js';

/** The local population the ring uses, named under the title. */
export function PopulationNote({ population }) {
  if (!population) {
    return null;
  }
  return (
    <p className="population-note">
      <Icon name="prevalence" size={18} className="population-note-icon" />
      <span className="population-note-copy">
        <strong className="population-note-title">{localPrevalenceTitle(population)}</strong>
        <span className="population-note-text">
          {[populationCoverage(population), LOCAL_SYNTHETIC_NOTE].filter(Boolean).join(' ')}
        </span>
      </span>
    </p>
  );
}

/**
 * The full synthetic dataset as JSON, about 1.3 GB (audit A16): one click
 * no longer starts it. The button opens a short confirmation that states the
 * size and points to the light export first (one condition's card, from
 * Export on its card); the download starts only from there.
 */
function DatasetExport({ datasetExport, population }) {
  const [isConfirming, setIsConfirming] = useState(false);
  // The focus moves into the confirmation and back to the button that opened it.
  const triggerRef = useRef(null);
  const confirmRef = useRef(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (isConfirming) {
      confirmRef.current?.focus();
    } else if (wasConfirming.current) {
      triggerRef.current?.focus();
    }
    wasConfirming.current = isConfirming;
  }, [isConfirming]);
  const scope = `this AI system and function${population ? `, with the local prevalence ${population.name}` : ''}`;
  // The static demo has no dataset export, only the recorded card record (release 0.5, Q9).
  if (!datasetExport.onClick) {
    return datasetExport.onCardRecord ? (
      <div className="side-footer">
        <CardRecordExport datasetExport={datasetExport} />
      </div>
    ) : null;
  }
  if (datasetExport.isBusy) {
    return (
      <div className="side-footer">
        <p className="side-footnote" role="status">Preparing the full dataset (about 1.3 GB)…</p>
      </div>
    );
  }
  return (
    <div className="side-footer">
      {isConfirming ? (
        <div className="export-confirm" role="group" aria-labelledby="export-confirm-title">
          <p id="export-confirm-title" className="export-confirm-title">Download about 1.3 GB?</p>
          <p className="side-footnote">
            The full synthetic dataset for {scope}: every condition at every population group, as one JSON file. It can take
            several minutes. For one condition, select it on the ring and use Export on its card.
          </p>
          <div className="button-row">
            <button
              ref={confirmRef}
              type="button"
              className="button-tinted"
              onClick={() => {
                setIsConfirming(false);
                datasetExport.onClick();
              }}
            >
              <Icon name="export" size={16} />
              Download the full dataset
            </button>
            <button type="button" className="button-plain" onClick={() => setIsConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="page-title-row">
            <button ref={triggerRef} type="button" className="button-plain" onClick={() => setIsConfirming(true)}>
              <Icon name="export" size={16} />
              Export the full dataset…
            </button>
            <HelpTip label="About the full dataset">
              <p>One JSON file for {scope}, about 1.3 GB. A condition's own export is on its card.</p>
            </HelpTip>
          </div>
        </>
      )}
      {datasetExport.onCardRecord ? <CardRecordExport datasetExport={datasetExport} /> : null}
    </div>
  );
}

/** The card record (contract v1.14, CONTRACT.md §32.1): this card as a small JSON for other systems. */
function CardRecordExport({ datasetExport }) {
  return (
    <div className="side-footer-item">
      <div className="page-title-row">
        <button type="button" className="button-plain" onClick={datasetExport.onCardRecord} disabled={datasetExport.isCardRecordBusy}>
          <Icon name="export" size={16} />
          {CARD_RECORD_COPY.button}
        </button>
        <HelpTip label="About the card record">
          <p>{CARD_RECORD_COPY.hint}</p>
        </HelpTip>
      </div>
      {datasetExport.isCardRecordBusy ? (
        <p className="side-footnote" role="status">
          {CARD_RECORD_COPY.busy}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The right column with nothing selected: plain-language highlights, each
 * opening its region on the ring, then what the AI system is ("About this AI
 * system") and, as a block of its own, what its developer declares.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {ReturnType<typeof import('./summaryHighlights.js').deriveHighlights>|null} props.highlights null while loading
 * @param {boolean} [props.isUnavailable] the data could not be loaded: no loading skeleton
 * @param {(targetId: string) => void} props.onOpen
 * @param {((targetId: string|null) => void)|null} [props.onPreview] in a chapter: the subchapter a hovered or focused card names (null on leave)
 * @param {{ onClick: (() => void)|null, isBusy: boolean, onCardRecord?: () => void, isCardRecordBusy?: boolean }|null} [props.datasetExport]
 *   the full synthetic dataset as JSON (none in the static demo) and the card record
 * @param {ReturnType<typeof import('./systemDetails.js').systemDetails>} [props.system] the AI system and function on screen
 * @param {(modelVersion: string) => void} [props.onOpenSystem] opens a "built on" model
 * @param {(modelVersion: string, useCase: string) => void} [props.onOpenCard] opens another version's card (contract v1.14)
 * @param {string|null} [props.previousCompareHref] "Compare with previous version" (contract v1.14, §28.2)
 * @param {boolean} [props.isExpert] expert depth: every configuration field
 * @param {object|null} [props.narrowCard] the developer's narrow model card (contract v1.13, §26)
 * @param {{ id: string, name: string, codes?: number }|null} [props.population] the local population in use
 * @param {(() => void)|null} [props.onOpenDefaults] opens "Your defaults"
 * @param {string|null} [props.resultFor] who the results are for: lens and prevalence
 * @param {object|null} [props.groupSummary] Across groups (contract v1.14, §24): GroupSummary's props
 * @param {object|null} [props.audienceSummary] the reader's audience summary (contract v1.14, §30.2): audienceModel.js's model
 * @param {(() => void)|null} [props.onOpenGuide] opens "How to read a card"
 */
function SummaryPanel({ title, highlights, onOpen, onPreview = null, datasetExport = null, isUnavailable = false, system = null, onOpenSystem = null, onOpenCard = null, previousCompareHref = null, isExpert = false, narrowCard = null, population = null, onOpenDefaults = null, resultFor = null, groupSummary = null, audienceSummary = null, onOpenGuide = null }) {
  return (
    <section className="side-card summary-panel" aria-labelledby="summary-title">
      {/* How to use and read the Summary is its title's help. */}
      {withHelp(
        <h2 id="summary-title" className="side-title">{title}</h2>,
        [`Click a bubble or press ${SEARCH_SHORTCUT} to search.`, 'Grades cover predictive performance only, not effects on patient outcomes.'],
        'About the Summary'
      )}
      {resultFor ? (
        <p className="detail-population summary-for">
          <Icon name="population" size={16} />
          <span>For {resultFor}</span>
        </p>
      ) : null}
      <PopulationNote population={population} />
      {/* The reader's preset heads the Summary: same figures, its own first questions. */}
      {audienceSummary && !isUnavailable ? (
        <AudienceSummary summary={audienceSummary} onOpen={onOpen} onChange={onOpenDefaults} onOpenGuide={onOpenGuide} />
      ) : null}

      {isUnavailable ? (
        <p className="side-intro muted">The summary appears once the atlas data has loaded.</p>
      ) : highlights ? (
        <ul className="highlight-list">
          {highlights.map((highlight) => {
            const content = (
              <>
                {/* Evidence age (v1.14, §28.5) and Not appraised (§22) are information, not a status: a neutral glyph. */}
                {highlight.tone === 'info' || highlight.tone === 'not_appraised' ? (
                  <Icon name="info" size={14} className="highlight-info" />
                ) : (
                  <StatusMark status={highlight.tone} size={14} />
                )}
                <span className="highlight-copy">
                  <span className="highlight-title">{highlight.title}</span>
                  <span className="highlight-text">{highlight.text}</span>
                  {highlight.strip ? <StatusStrip {...highlight.strip} /> : null}
                </span>
                {highlight.targetId ? <Icon name="chevronRight" size={18} className="highlight-chevron" /> : null}
              </>
            );
            return (
              <li key={highlight.id} className="highlight">
                {highlight.targetId ? (
                  <button
                    type="button"
                    className="highlight-body is-link"
                    onClick={() => onOpen(highlight.targetId)}
                    onPointerEnter={onPreview ? () => onPreview(highlight.targetId) : undefined}
                    onPointerLeave={onPreview ? () => onPreview(null) : undefined}
                    onFocus={onPreview ? () => onPreview(highlight.targetId) : undefined}
                    onBlur={onPreview ? () => onPreview(null) : undefined}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="highlight-body">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="highlight-list is-loading" aria-label="Loading the summary">
          {[0, 1, 2].map((index) => (
            <li key={index} className="highlight">
              <div className="highlight-body">
                <span className="skeleton-dot" />
                <span className="highlight-copy">
                  <span className="skeleton-line is-wide" />
                  <span className="skeleton-line" />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}


      {groupSummary ? <GroupSummary {...groupSummary} /> : null}

      <SystemAbout
        details={system}
        onOpenSystem={onOpenSystem}
        onOpenCard={onOpenCard}
        previousCompareHref={previousCompareHref}
        isExpert={isExpert}
        narrowCard={narrowCard}
      />


      {datasetExport ? <DatasetExport datasetExport={datasetExport} population={population} /> : null}
    </section>
  );
}

export default memo(SummaryPanel);
