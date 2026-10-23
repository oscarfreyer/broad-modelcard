import { memo } from 'react';
import { CHAPTER_ICONS } from '../../design/chapterIcons.js';
import Icon from '../../design/Icon.jsx';
import RangeChart from '../../design/RangeChart.jsx';
import StatusMark from '../../design/StatusMark.js';
import { rangeModel } from '../../design/rangeScale.js';
import { DISPLAY, hasIntendedUseStatement } from '../../design/status.js';
import CardSnapshot from '../label/CardSnapshot.js';
import { SNAPSHOT_MODES } from '../label/snapshot.js';
import { ONTOLOGY_CHAPTER_ICONS } from '../atlas/layout/ontologyChapters.js';
import { conceptName } from '../../shared/conceptName.js';
import { displayUseCase } from '../../shared/format.js';
import { evidenceWords, localWords, rowOnlyReasons, settingCategoryLabel } from './compareCopy.js';
import ComparisonFlag from './ComparisonFlag.js';
import { cardAtlasHref, cellAtlasHref, cellMark, cellValue, shownCode, singledOut } from './compareModel.js';

/** A chapter's Healthicons glyph (ICD-11 by number, other classifications by their assignment). */
function ChapterGlyph({ row }) {
  const key = row.concept_id.startsWith('CH-') ? row.chapter_no : ONTOLOGY_CHAPTER_ICONS[row.concept_id];
  const glyph = key ? CHAPTER_ICONS[key] : null;
  if (!glyph) return <span className="cmp-glyph is-empty" aria-hidden="true" />;
  return (
    <svg className="cmp-glyph" width="20" height="20" viewBox={glyph.viewBox} aria-hidden="true" focusable="false">
      <g fill="currentColor">
        {glyph.paths.map((path, index) => (
          <path key={index} d={path.d} fillRule={path.evenOdd ? 'evenodd' : undefined} clipRule={path.evenOdd ? 'evenodd' : undefined} />
        ))}
      </g>
    </svg>
  );
}

const LEVEL_WORDS = { 0: 'Chapter', 1: 'Subchapter', 2: 'Condition' };

/** What each incident mark means (CONTRACT.md §18): only an open incident is Serious. */
const SAFETY_TITLES = Object.freeze({
  serious: 'an open incident with harm or possible harm, or a recall',
  caution: 'another open or mitigated incident'
});

function ConceptCell({ entry, cards, cardReasons, names, cardCount, scope, sortedByDifference, onDrill }) {
  const { row, depth, isContext } = entry;
  const name = conceptName(row);
  const canDrill = scope === 'atlas' && row.level === 0;
  return (
    <th scope="row" className={`cmp-concept is-level-${row.level}${depth ? ' is-nested' : ''}${isContext ? ' is-context' : ''}`}>
      <div className="cmp-concept-line">
        {row.level === 0 ? <ChapterGlyph row={row} /> : null}
        <span className="cmp-concept-text">
          {sortedByDifference && scope === 'chapter' ? <span className="cmp-concept-level">{LEVEL_WORDS[row.level]}</span> : null}
          {canDrill ? (
            <button type="button" className="cmp-drill" onClick={() => onDrill(row.concept_id)}>
              {name}
              <Icon name="chevronRight" size={14} />
              <span className="visually-hidden">: show its subchapters and conditions</span>
            </button>
          ) : (
            <span className="cmp-concept-name">{name}</span>
          )}
          {shownCode(row) ? <span className="cmp-concept-code">{shownCode(row)}</span> : null}
        </span>
      </div>
      {sortedByDifference && row.perf_spread != null ? (
        <p className="cmp-spread">Difference {row.perf_spread.toFixed(3)}</p>
      ) : null}
      <ComparisonFlag row={row} cardReasons={cardReasons} names={names} cardCount={cardCount} cards={cards} />
    </th>
  );
}

function ResultCell({ row, cell, card, context, statusBands, isExpert, isConcerned, showEvidence, showSetting }) {
  const mark = cellMark(row, cell);
  const value = cellValue(cell);
  const display = DISPLAY[mark] ?? DISPLAY.no_data;
  // The kind of evidence shows where it matters: a row flagged for different designs, or a result from a linked study (§22, §25).
  // A chapter or subchapter is a rollup: its type is the one nearest its conditions' mean (§6).
  const kind = showEvidence || cell.study_design ? evidenceWords(cell) : '';
  const evidence = kind && row.level < 2 ? `Typical: ${kind.toLowerCase()}` : kind;
  // The linked study's care setting, where the row is flagged for it (v1.14, §25).
  const setting = showSetting && cell.setting_category ? settingCategoryLabel(cell.setting_category) : '';
  // A local result (§26.1, v1.14): the hospital's own evaluation, marked as on the atlas.
  const local = localWords(cell);
  const href = cellAtlasHref(card.card_id, row, context);
  const name = conceptName(row);
  // The A–F evidence grade is expert detail, as on the atlas's condition card.
  const grade = isExpert ? cell.evidence_grade : null;
  const label = `${card.display_name}, ${displayUseCase(card.use_case)}: ${name}, ${display.label}${value ? `, performance ${value}` : ''}${local ? `, ${local.toLowerCase()} result` : ''}${grade ? `, evidence grade ${grade}` : ''}${cell.safety ? `, ${DISPLAY[cell.safety].label} safety incident` : ''}. Open in its atlas.`;
  return (
    <td className={`cmp-cell${isConcerned && !['no_data', 'no_mapping', 'out_of_scope'].includes(mark) ? ' is-concerned' : ''}`} data-status={mark}>
      <a className="cmp-cell-link" href={href} aria-label={label}>
        <span className="cmp-cell-head">
          <StatusMark status={mark} size={14} />
          {value ? <span className="cmp-cell-value">{value}</span> : <span className="cmp-cell-word">{display.label}</span>}
          {local ? (
            <span className="cmp-cell-local" title={local === 'Local' ? 'The hospital’s own evaluation for this population' : 'Includes the hospital’s own evaluation'}>
              <span className={`local-dot${local === 'Local' ? '' : ' is-within'}`} aria-hidden="true" />
              {local}
            </span>
          ) : null}
          {grade ? (
            <span className="grade-chip" title={`Evidence grade ${grade}`}>
              {grade}
            </span>
          ) : null}
          {cell.safety ? (
            <span className="cmp-cell-safety" title={`${DISPLAY[cell.safety].label}: ${SAFETY_TITLES[cell.safety] ?? 'a safety incident'}`}>
              <StatusMark status={cell.safety} size={14} />
            </span>
          ) : null}
        </span>
        {value ? (
          <RangeChart
            model={rangeModel({
              view: 'performance',
              value: cell.perf,
              ciLow: cell.ci_low,
              ciHigh: cell.ci_high,
              statusBands,
              status: cell.performance_status
            })}
            size="compact"
            valueLabel={`Performance ${value}`}
          />
        ) : null}
        {value && mark === 'out_of_scope' ? <span className="cmp-cell-note">Out of scope</span> : null}
        {evidence ? <span className="cmp-cell-note">{evidence}{cell.lens_fallback ? ', combined groups' : ''}</span> : null}
        {setting ? <span className="cmp-cell-note">{setting}</span> : null}
      </a>
    </td>
  );
}

/** A column's snapshot: its catalogue tile's, in the Overview mark (decorative; the cells below say the results). */
function ColumnSnapshot({ tile, geometry }) {
  return (
    <span className="cmp-card-snapshot">
      <CardSnapshot
        geometry={tile ? geometry : null}
        blocks={tile?.snapshot?.blocks}
        mode={SNAPSHOT_MODES.overview}
        hasIntendedUse={tile ? hasIntendedUseStatement(tile) : true}
        size={136}
        decorative
      />
    </span>
  );
}

/**
 * The results: one row per chapter (or, in a chapter, its subchapters and
 * conditions), one column per card. Each cell is the Overview mark, the
 * performance value with its CI, the evidence grade, the open-incident mark,
 * and the kind of evidence; it links to the card's atlas at that concept. A
 * row that is not directly comparable says why under its name; the cells it
 * concerns are outlined. Each column heading shows the card's atlas in
 * miniature, the same snapshot as its catalogue tile.
 *
 * @param {{ geometry: object|null, tilesById: Map<string, object> }|null} [props.snapshots] the catalogue's tiles and the snapshot geometry
 */
function ComparisonTable({ comparison, entries, names, scope, sortedByDifference, context, statusBands, isExpert = false, onDrill, caption, snapshots = null }) {
  const { cards, card_reasons: cardReasons } = comparison;
  return (
    <div className="cmp-scroll" tabIndex={0} role="region" aria-label={`${caption}, one column per card`}>
      <table className="cmp-table cmp-results">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="cmp-col-label">
              {scope === 'atlas' ? 'Chapter' : 'Subchapter and condition'}
            </th>
            {cards.map((card) => (
              <th key={card.card_id} scope="col" className="cmp-col-card">
                {/* The card's own atlas, at the chapter and population on screen. */}
                <a className="cmp-card-link" href={cardAtlasHref(card.card_id, context)}>
                  {snapshots ? <ColumnSnapshot tile={snapshots.tilesById.get(card.card_id) ?? null} geometry={snapshots.geometry} /> : null}
                  <span className="cmp-card-name">{card.display_name}</span>
                  <span className="cmp-card-function">{displayUseCase(card.use_case)}</span>
                </a>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const reasons = rowOnlyReasons(entry.row, cardReasons);
            return (
              <tr
                key={entry.row.concept_id}
                className={`cmp-row is-level-${entry.row.level}${entry.isContext ? ' is-context' : ''}`}
              >
                <ConceptCell
                  entry={entry}
                  cards={cards}
                  cardReasons={cardReasons}
                  names={names}
                  cardCount={cards.length}
                  scope={scope}
                  sortedByDifference={sortedByDifference}
                  onDrill={onDrill}
                />
                {cards.map((card, index) => (
                  <ResultCell
                    key={card.card_id}
                    row={entry.row}
                    cell={entry.row.cells[index]}
                    card={card}
                    context={context}
                    statusBands={statusBands}
                    isExpert={isExpert}
                    isConcerned={singledOut(reasons, card.card_id, cards.length)}
                    showEvidence={reasons.some((reason) => reason.code === 'design_differs')}
                    showSetting={reasons.some((reason) => reason.code === 'setting_differs')}
                  />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default memo(ComparisonTable);
