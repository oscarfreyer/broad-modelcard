// "Across groups" on the condition card (contract v1.13, CONTRACT.md §24). Plain JS (createElement, no JSX) so the node tests can
// render it; the words and the row layout come from copy/subgroupCopy.js. The
// row chart is the range chart's compact form (rangeModel, the same classes)
// with one addition, the all-patients line, so a group reads against it.
import { createElement as h, useMemo } from 'react';
import { withHelp } from '../../design/HelpTip.js';
import { DISPLAY } from '../../design/status.js';
import StatusMark from '../../design/StatusMark.js';
import {
  ACROSS_GROUPS_LEAD,
  ACROSS_GROUPS_TITLE,
  ACROSS_GROUPS_UNAVAILABLE,
  CHOOSE_GROUP_HINT,
  FALLBACK_WORDS,
  LAYER_NOTE,
  LAYER_WORDS,
  NOT_COMPARED_WORDS,
  acrossGroupsModel,
  ruleSentence
} from './copy/subgroupCopy.js';

function svgIcon(path, className) {
  return h(
    'svg',
    {
      className: `icon ${className}`,
      width: 14,
      height: 14,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '2',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false'
    },
    h('path', { d: path })
  );
}

const ARROWS = { higher: 'M12 19V5m-6 6 6-6 6 6', lower: 'M12 5v14m-6-6 6 6 6-6' };
const CHEVRON = 'm6.5 9.5 5.5 5.5 5.5-5.5';

/** The compact range track with the all-patients line. */
function GroupRange({ row }) {
  const { chart, referencePct } = row;
  if (!chart) {
    return h(
      'span',
      { className: 'group-range-absent' },
      h(StatusMark, { status: 'no_data', size: 12 }),
      h('span', null, DISPLAY.no_data.label)
    );
  }
  return h(
    'div',
    { className: 'range range-compact group-range', 'aria-hidden': 'true' },
    h(
      'div',
      { className: 'range-track' },
      chart.zones.map((zone) =>
        h('span', {
          key: zone.status,
          className: `range-zone tone-${zone.status}${zone.isActive ? ' is-active' : ''}`,
          style: { left: `${zone.startPct}%`, width: `${zone.endPct - zone.startPct}%` }
        })
      ),
      referencePct != null ? h('span', { className: 'group-range-reference', style: { left: `${referencePct}%` } }) : null,
      chart.ci ? h('span', { className: 'range-ci', style: { left: `${chart.ci.startPct}%`, width: `${Math.max(0, chart.ci.endPct - chart.ci.startPct)}%` } }) : null,
      chart.value
        ? h('span', { className: `range-dot${chart.value.clamped ? ` is-clamped-${chart.value.clamped}` : ''}`, style: { left: `${chart.value.pct}%` } })
        : null
    )
  );
}

function FlagChip({ flag }) {
  if (!flag) return null;
  return h('span', { className: `group-flag is-${flag.direction}`, title: flag.text }, svgIcon(ARROWS[flag.direction], 'group-flag-icon'), flag.word);
}

function spokenRow(row) {
  return [
    row.label,
    row.value ? `performance ${row.value}` : DISPLAY.no_data.label,
    row.flag ? row.flag.text : null,
    row.value && row.layer && row.axis !== 'all' ? LAYER_WORDS[row.layer] : null,
    row.value && row.details.includes(NOT_COMPARED_WORDS) ? NOT_COMPARED_WORDS : null,
    row.size ?? null,
    row.isFallback ? FALLBACK_WORDS : null,
    row.isCurrent ? 'shown on the atlas' : null
  ]
    .filter(Boolean)
    .join(', ');
}

function GroupRow({ row, onChoose }) {
  const content = [
    h(
      'span',
      { key: 'head', className: 'group-row-head' },
      h('span', { className: 'group-row-name' }, row.label),
      h(FlagChip, { flag: row.flag }),
      row.isCurrent ? h('span', { className: 'group-row-current' }, 'Shown') : null,
      h('span', { className: 'group-row-value' }, row.value ?? '')
    ),
    h(GroupRange, { key: 'range', row }),
    row.details.length || row.isFallback
      ? h('span', { key: 'meta', className: 'group-row-meta' }, [...row.details, row.isFallback ? FALLBACK_WORDS : null].filter(Boolean).join(', '))
      : null
  ];
  if (!onChoose || row.axis === 'all') {
    return h('li', { className: `group-row${row.axis === 'all' ? ' is-reference' : ''}` }, h('div', { className: 'group-row-body', 'aria-label': spokenRow(row) }, ...content));
  }
  return h(
    'li',
    { className: 'group-row' },
    h(
      'button',
      {
        type: 'button',
        className: 'group-row-body',
        'aria-label': spokenRow(row),
        'aria-current': row.isCurrent ? 'true' : undefined,
        onClick: () => onChoose(row.lens)
      },
      ...content
    )
  );
}

/**
 * The section. It loads only once opened (`isOpen`), so a card that is not
 * compared costs no request; an audience preset can open it at once.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onToggle
 * @param {{ data: object|null, isLoading: boolean, error: object|null }} props.query the getConceptSubgroups read
 * @param {'plain'|'expert'} props.depth
 * @param {object|null} [props.rule] /meta subgroup_difference
 * @param {object} [props.statusBands]
 * @param {object|null} [props.currentLens] the lens on screen
 * @param {((lens: object) => void)|null} [props.onChooseGroup] switches the atlas lens
 */
export function AcrossGroups({ isOpen, onToggle, query, depth, rule = null, statusBands, currentLens = null, onChooseGroup = null }) {
  const data = query?.data ?? null;
  const model = useMemo(() => (data ? acrossGroupsModel(data, { depth, statusBands, currentLens }) : null), [currentLens, data, depth, statusBands]);
  let body = null;
  if (isOpen) {
    if (model) {
      body = h(
        'div',
        { id: 'detail-across-groups-body', className: 'across-groups-body' },
        h('ul', { className: 'group-list', 'aria-label': 'All patients' }, model.references.map((row) => h(GroupRow, { key: row.key, row }))),
        model.groups.map((group) =>
          h(
            'div',
            { key: group.axis, className: 'group-axis' },
            h('h4', { className: 'group-axis-label' }, group.label),
            h('ul', { className: 'group-list', 'aria-label': group.label }, group.rows.map((row) => h(GroupRow, { key: row.key, row, onChoose: onChooseGroup })))
          )
        )
      );
    } else if (query?.error) {
      // The static demo says in words what it did not record (R7); anything else is a failed read.
      const words = query.error.code === 'static_unavailable' && query.error.detail ? query.error.detail : ACROSS_GROUPS_UNAVAILABLE;
      body = h('p', { id: 'detail-across-groups-body', className: 'across-groups-lead' }, words);
    } else {
      body = h('p', { id: 'detail-across-groups-body', className: 'across-groups-lead', role: 'status' }, 'Loading the groups…');
    }
  }
  return h(
    'section',
    { className: 'across-groups', 'aria-labelledby': 'detail-across-groups' },
    // How to read the groups is the heading's help; the rows are the content.
    withHelp(
      h('h3', { id: 'detail-across-groups', className: 'group-heading' }, ACROSS_GROUPS_TITLE),
      [ACROSS_GROUPS_LEAD, model?.isLayered ? LAYER_NOTE : null, ruleSentence(rule, depth), onChooseGroup && model?.hasAnyGroupResult ? CHOOSE_GROUP_HINT : null],
      'About Across groups'
    ),
    h(
      'div',
      { className: 'inset-list' },
      h(
        'div',
        { className: 'inset-row' },
        h(
          'button',
          {
            type: 'button',
            className: 'inset-row-button assessment-toggle',
            'aria-expanded': isOpen,
            'aria-controls': 'detail-across-groups-body',
            onClick: onToggle
          },
          h(
            'span',
            { className: 'inset-row-main' },
            h('span', { className: 'inset-row-title' }, 'Compare patient groups'),
            model ? h('span', { className: 'inset-row-text' }, model.summary) : null
          ),
          svgIcon(CHEVRON, `disclosure${isOpen ? ' is-open' : ''}`)
        ),
        body
      )
    )
  );
}
