// "Across groups" in the Summary (contract v1.14, CONTRACT.md §24):
// the groups whose results differ most often from all patients and the groups
// without data, from one getSubgroupSummary read. Plain JS (createElement) so the
// node tests can render it; the words come from groupSummaryCopy.js. About patient
// groups, kept apart from Study quality; a heuristic, never a grade.
import { createElement as h, useMemo } from 'react';
import { withHelp } from '../../design/HelpTip.js';
import { GROUP_SUMMARY_TITLE, GROUP_SUMMARY_UNAVAILABLE, groupSummaryModel } from './groupSummaryCopy.js';

/**
 * @param {object} props
 * @param {{ data: object|null, error: object|null }} props.query the getSubgroupSummary read
 * @param {'plain'|'expert'} [props.depth]
 * @param {string|null} [props.classification] another classification than ICD-11 on screen
 * @param {((condition: { conceptId: string, chapterId: string }) => void)|null} [props.onOpenCondition]
 */
export default function GroupSummary({ query, depth = 'plain', classification = null, onOpenCondition = null }) {
  const data = query?.data ?? null;
  const model = useMemo(() => (data ? groupSummaryModel(data, { depth, classification }) : null), [classification, data, depth]);
  let body;
  if (model) {
    const canOpen = Boolean(onOpenCondition) && model.canOpen;
    body = [
      h('p', { key: 'lead', className: 'group-summary-lead' }, model.lead),
      model.groups.length
        ? h(
            'dl',
            { key: 'groups', className: 'fact-list group-summary-groups', 'aria-label': 'Groups that differ from all patients' },
            model.groups.map((group) => h('div', { key: group.key, className: 'fact-row' }, h('dt', null, group.label), h('dd', null, group.text)))
          )
        : null,
      model.conditions.length
        ? h(
            'div',
            { key: 'conditions', className: 'group-summary-conditions' },
            h('p', { className: 'group-summary-subtitle' }, model.conditionsTitle),
            h(
              'ul',
              null,
              model.conditions.map((condition) =>
                h(
                  'li',
                  { key: condition.conceptId },
                  canOpen
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'link-button',
                          onClick: () => onOpenCondition({ conceptId: condition.conceptId, chapterId: condition.chapterId }),
                          title: `Open ${condition.label} and compare its groups`
                        },
                        condition.label
                      )
                    : h('span', { className: 'group-summary-name' }, condition.label),
                  h('span', { className: 'group-summary-delta' }, condition.text)
                )
              )
            )
          )
        : null,
    ];
  } else if (query?.error) {
    // The static demo says in words what it did not record; anything else is a failed read.
    const words = query.error.code === 'static_unavailable' && query.error.detail ? query.error.detail : GROUP_SUMMARY_UNAVAILABLE;
    body = h('p', { className: 'group-summary-lead' }, words);
  } else {
    body = h('p', { className: 'group-summary-lead muted', role: 'status' }, 'Loading the groups…');
  }
  return h(
    'section',
    { className: 'group-summary', 'aria-labelledby': 'summary-groups-title' },
    // What the check is (and is not) is the heading's help.
    withHelp(h('h3', { id: 'summary-groups-title', className: 'group-heading' }, GROUP_SUMMARY_TITLE), [model?.note], 'About Across groups'),
    h('div', { className: 'system-block' }, body)
  );
}
