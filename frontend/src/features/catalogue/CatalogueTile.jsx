import { memo } from 'react';
import Icon from '../../design/Icon.jsx';
import StatusMark from '../../design/StatusMark.js';
import { DISPLAY, hasIntendedUseStatement } from '../../design/status.js';
import { kindLabel, systemName } from '../../shared/aiSystem.js';
import { displayUseCase } from '../../shared/format.js';
import CardSnapshot from '../label/CardSnapshot.js';
import { SNAPSHOT_MODES } from '../label/snapshot.js';
import TrackToggle from '../profile/TrackToggle.jsx';
import { NO_STATEMENT_NOTE, formatUpdated, overviewParts, relativeUpdated, safetyLead } from './catalogueModel.js';
import { TABS } from './catalogueState.js';
import { cardAtlasHref } from './pageLinks.js';

/**
 * Performance: one line of counts over the card's conditions, each with its
 * mark (the Overview words, one missing state). A card without an
 * intended-use statement says so in its tags, not in the counts.
 */
function OverviewLine({ tile, total }) {
  const hasIntendedUse = hasIntendedUseStatement(tile);
  const parts = overviewParts(tile.distribution?.overall, { hasIntendedUse });
  return (
    <p className="cat-tile-line" aria-label={`Overview of ${total.toLocaleString('en-US')} conditions`}>
      {parts.map(([status, count]) => (
        <span key={status} className="cat-tile-count">
          <StatusMark status={status} />
          <span className="cat-tile-figure">{count.toLocaleString('en-US')}</span>
          <span className="cat-tile-word">{DISPLAY[status].label.toLowerCase()}</span>
        </span>
      ))}
    </p>
  );
}

/**
 * Safety: the open incidents in one line, in their warning voice (Serious in
 * coral, Caution in amber, each with its mark), how many subchapters the
 * marks cover, then the mitigated and closed ones quietly, and why a
 * mitigated incident still marks Caution. A card without open incidents
 * reads in the neutral mark, never green and never "safe".
 */
function SafetyLine({ tile, quietWhenNone = true }) {
  const lead = safetyLead(tile);
  if (!lead.rows.length && !quietWhenNone) return null;
  return (
    <div className="cat-tile-safety">
      <p className="cat-tile-line is-safety" aria-label="Safety incidents">
        {lead.rows.length ? (
          lead.rows.map(({ status, count }) => (
            <span key={status} className={`cat-tile-count is-${status}`}>
              <StatusMark status={status} size={14} />
              <span className="cat-tile-figure">{count}</span>
              <span className="cat-tile-word">{DISPLAY[status].label.toLowerCase()}, open</span>
            </span>
          ))
        ) : (
          <span className="cat-tile-count">
            <StatusMark status="no_incidents" />
            <span className="cat-tile-word">{lead.quiet}</span>
          </span>
        )}
        {lead.span ? <span className="cat-tile-quiet">{lead.span}</span> : null}
        {lead.settled ? <span className="cat-tile-quiet">{lead.settled}</span> : null}
      </p>
      {lead.mitigated ? <p className="cat-tile-note">{lead.mitigated}</p> : null}
    </div>
  );
}

/**
 * One card (an AI system with one function): name and function, its tags,
 * the date of its last update, the snapshot (the card's atlas in miniature,
 * the tile's hero), one line of counts, then Track and Model card. The name
 * is the tile's one link; it covers the whole tile.
 *
 * @param {object} props
 * @param {object|null} props.geometry the page's snapshot geometry (useSnapshotGeometry), null while loading
 * @param {boolean} [props.showUpdated] false when every tile shares one update day (the footer says it)
 * @param {boolean} [props.isCompared] the card is chosen for a comparison (R4)
 * @param {boolean} [props.isCompareFull] four cards are chosen
 * @param {((cardId: string) => void)|null} [props.onToggleCompare] the Compare choice; null hides it
 * @param {string|null} [props.replaces] the AI system this one replaces (contract v1.14, §28.2), by name
 */
function CatalogueTile({ tile, total, tab, version, geometry, siblingCount, onShowSiblings, onOpenLabel, onTrackChange = null, showUpdated = true, isCompared = false, isCompareFull = false, onToggleCompare = null, replaces = null }) {
  const system = tile.system ?? {};
  const name = systemName({ ...system, model_version: tile.model_version });
  const functionName = displayUseCase(tile.use_case);
  const updatedAt = tile.last_updated?.at ?? null;
  const updated = showUpdated ? relativeUpdated(updatedAt) : null;
  const isSafety = tab === TABS.safety;
  const hasIntendedUse = hasIntendedUseStatement(tile);
  return (
    <article className={`cat-tile${tile.staged_change ? ' is-staged' : ''}`} data-card-id={tile.card_id}>
      <header className="cat-tile-head">
        <h2 className="cat-tile-name">
          <a className="cat-tile-link" href={cardAtlasHref(tile, { version })}>
            {name}
            {/* Several cards share a system: the link names the card (system and function). */}
            <span className="visually-hidden">, {functionName}</span>
          </a>
        </h2>
        <p className="cat-tile-function">{functionName}</p>
        {/* The tags sit under the function, so the name has the tile's full width. */}
        <p className="cat-tile-tags">
          <span className="kind-tag">{kindLabel(system)}</span>
          {system.status === 'EXPERIMENTAL' ? <span className="kind-tag is-experimental">Experimental</span> : null}
          {hasIntendedUse ? null : <span className="kind-tag is-neutral">{NO_STATEMENT_NOTE}</span>}
          {/* Version lineage, one quiet phrase in the tag row (§28.2). */}
          {replaces ? <span className="cat-tile-replaces">Replaces {replaces}</span> : null}
        </p>
        {/* Every tile keeps this slot, so a tile with the link keeps the row's rhythm. */}
        <div className="cat-tile-siblings-slot">
          {siblingCount > 1 ? (
            <button type="button" className="cat-tile-siblings" onClick={() => onShowSiblings(tile.model_version)}>
              Other functions of this system<span className="visually-hidden">, {name}</span> ({siblingCount - 1})
            </button>
          ) : null}
        </div>
        {tile.staged_change ? (
          <p className="cat-tile-updated">Changed in this preview</p>
        ) : updated ? (
          <p className="cat-tile-updated">
            <time dateTime={updatedAt} title={formatUpdated(updatedAt, { long: true }) ?? undefined}>
              {updated}
            </time>
          </p>
        ) : null}
      </header>

      <div className="cat-tile-snapshot">
        <CardSnapshot
          geometry={geometry}
          blocks={tile.snapshot?.blocks}
          mode={isSafety ? SNAPSHOT_MODES.safety : SNAPSHOT_MODES.overview}
          hasIntendedUse={hasIntendedUse}
          size={224}
          decorative
        />
      </div>

      <div className="cat-tile-lead">
        {isSafety ? <SafetyLine tile={tile} /> : <OverviewLine tile={tile} total={total} />}
        {/* My systems: a deployer watches both, so open incidents follow when there are any. */}
        {tab === TABS.mine ? <SafetyLine tile={tile} quietWhenNone={false} /> : null}
      </div>

      <footer className="cat-tile-foot">
        <TrackToggle
          modelVersion={tile.model_version}
          useCase={tile.use_case}
          name={`${name}, ${functionName}`}
          onChange={onTrackChange ? (tracked) => onTrackChange(tile.card_id, `${name}, ${functionName}`, tracked) : null}
        />
        {onOpenLabel ? (
          <button
            type="button"
            className="button-plain cat-tile-action"
            onClick={() => onOpenLabel(tile.card_id)}
            aria-label={`Model card for ${name}, ${functionName}`}
          >
            Model card
          </button>
        ) : null}
        {/* Choose the card for a side-by-side comparison: at most four. */}
        {onToggleCompare ? (
          <button
            type="button"
            className={`button-plain cat-tile-action cat-tile-compare${isCompared ? ' is-on' : ''}`}
            aria-pressed={isCompared}
            disabled={!isCompared && isCompareFull}
            title={!isCompared && isCompareFull ? 'Four cards are chosen. Remove one to add this card.' : undefined}
            onClick={() => onToggleCompare(tile.card_id)}
            aria-label={`Compare ${name}, ${functionName}`}
          >
            {isCompared ? <Icon name="check" size={15} /> : <Icon name="compare" size={15} />}
            Compare
          </button>
        ) : null}
      </footer>
    </article>
  );
}

export default memo(CatalogueTile);
