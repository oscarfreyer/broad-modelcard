// "Show the Any-setting result" on the condition card (contract v1.14,
// CONTRACT.md §29): at a specific setting without a result, the reader may
// ask for the Any-setting result. It is read on demand through the data
// client, labelled "Any setting, not specific to <setting>", and shown below
// the No data message, never in the setting's place. Plain JS (createElement,
// no JSX) so the node tests can render it.
import { createElement as h, useState } from 'react';
import useClientQuery from '../../api/useClientQuery.js';
import StatusMark from '../../design/StatusMark.js';
import { anySettingResult } from './copy/settingCopy.js';

function Result({ query, setting, depth, hasIntendedUse }) {
  const read = useClientQuery(query.key, (client, options) => query.fetch(client, options));
  const isCurrent = read.dataKey === query.key;
  if (read.error && !isCurrent) {
    return h(
      'p',
      { className: 'any-setting-note', role: 'status' },
      'The Any-setting result could not be loaded. ',
      h('button', { type: 'button', className: 'button-plain', onClick: read.retry }, 'Try again')
    );
  }
  if (!isCurrent) {
    return h('p', { className: 'any-setting-note', role: 'status' }, 'Loading the Any-setting result…');
  }
  const content = anySettingResult(read.data?.metrics ?? null, setting, depth, { hasIntendedUse });
  return h(
    'div',
    { className: 'inset-list any-setting-card' },
    h('h4', { className: 'any-setting-title' }, content.label),
    content.rows.length
      ? h(
          'dl',
          { className: 'any-setting-rows' },
          content.rows.map((row) =>
            h(
              'div',
              { key: row.view, className: 'any-setting-row' },
              h('dt', null, row.title),
              h('dd', null, h(StatusMark, { status: row.status, size: 12 }), h('span', null, row.word), row.figure ? h('span', { className: 'any-setting-figure' }, row.figure) : null)
            )
          )
        )
      : null,
    h('p', { className: 'any-setting-note' }, content.text)
  );
}

/**
 * @param {object} props
 * @param {{ key: string, fetch: Function }} props.query the concept read for Any setting (queryKeys.conceptMetricsQuery)
 * @param {string} props.setting the specific setting on screen
 * @param {'plain'|'expert'} props.depth
 * @param {boolean} [props.hasIntendedUse]
 */
export function AnySettingResult({ query, setting, depth, hasIntendedUse = true }) {
  const [isShown, setIsShown] = useState(false);
  if (!isShown) {
    return h(
      'button',
      { type: 'button', className: 'button-tinted any-setting-button', onClick: () => setIsShown(true) },
      'Show the Any-setting result'
    );
  }
  return h(Result, { query, setting, depth, hasIntendedUse });
}
