// The audience summary at the top of the atlas Summary (release 0.5; CONTRACT.md §30.2): a short block for the reader's preset, built by
// audienceModel.js from figures other reads serve, with "More" opening the
// details behind it. Plain JS (createElement) so the node tests can render it.
import { createElement as h, useId, useState } from 'react';
import StatusMark from '../../design/StatusMark.js';
import { DISPLAY } from '../../design/status.js';

const MARK_TONES = new Set(['weak', 'serious', 'caution', 'no_incidents', 'out_of_scope', 'no_data']);

/** A slim bar of shares or counts, drawn as design/StatusStrip.jsx draws its bands. */
function strip({ counts, total, keys, label = null }) {
  if (!total) return null;
  const parts = keys.filter((key) => (counts[key] ?? 0) > 0);
  const words = label ?? parts.map((key) => `${counts[key].toLocaleString('en-US')} ${DISPLAY[key].label.toLowerCase()}`).join(', ');
  return h(
    'span',
    { className: 'status-strip', role: 'img', 'aria-label': words },
    parts.map((key) =>
      h('span', {
        key,
        'data-status': key,
        className: `status-strip-part strip-${DISPLAY[key].form} tone-${DISPLAY[key].tone}`,
        style: { flexGrow: counts[key] }
      })
    )
  );
}

function line(entry, onOpen) {
  const mark = MARK_TONES.has(entry.tone) ? h(StatusMark, { status: entry.tone, size: 12 }) : h('span', { className: 'audience-dot', 'aria-hidden': 'true' });
  const body = [
    h('span', { key: 'mark', className: 'audience-mark' }, mark),
    h(
      'span',
      { key: 'copy', className: 'audience-copy' },
      h('span', { className: 'audience-label' }, entry.label),
      h(
        'span',
        { className: 'audience-text' },
        entry.text,
        entry.href
          ? [' ', h('a', { key: 'link', href: entry.href, target: '_blank', rel: 'noopener noreferrer' }, entry.hrefText ?? 'Documentation')]
          : null
      ),
      entry.strip ? strip(entry.strip) : null
    )
  ];
  if (entry.targetId && onOpen) {
    return h(
      'li',
      { key: entry.id, className: 'audience-line' },
      h(
        'button',
        { type: 'button', className: 'audience-line-body is-link', onClick: () => onOpen(entry.targetId), title: 'Open it on the ring' },
        body
      )
    );
  }
  return h('li', { key: entry.id, className: 'audience-line' }, h('div', { className: 'audience-line-body' }, body));
}

/**
 * @param {object} props
 * @param {ReturnType<typeof import('./audienceModel.js').audienceSummary>} props.summary
 * @param {((targetId: string) => void)|null} [props.onOpen] opens a chapter a line names
 * @param {(() => void)|null} [props.onChange] opens "Your defaults" to change the preset
 * @param {(() => void)|null} [props.onOpenGuide] opens "How to read a card"
 * @param {boolean} [props.defaultOpen] "More" open on first render (tests)
 */
export default function AudienceSummary({ summary, onOpen = null, onChange = null, onOpenGuide = null, defaultOpen = false }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const id = useId();
  if (!summary) return null;
  const titleId = `${id}-title`;
  const moreId = `${id}-more`;
  return h(
    'section',
    { className: 'audience-summary', 'aria-labelledby': titleId, 'data-audience': summary.audience },
    h(
      'header',
      { className: 'audience-head' },
      h('p', { className: 'audience-eyebrow' }, `Reading as ${summary.audienceLabel}`),
      h('h3', { id: titleId, className: 'audience-title' }, summary.title)
    ),
    h('ul', { className: 'audience-lines' }, summary.lines.map((entry) => line(entry, onOpen))),
    summary.more.length
      ? h(
          'div',
          { className: 'audience-more' },
          h(
            'button',
            { type: 'button', className: 'button-plain audience-more-toggle', 'aria-expanded': isOpen, 'aria-controls': moreId, onClick: () => setIsOpen((open) => !open) },
            isOpen ? 'Less' : 'More'
          ),
          h(
            'div',
            { id: moreId, className: 'audience-more-body', hidden: !isOpen },
            summary.more.map((group) =>
              h(
                'div',
                { key: group.id, className: 'audience-more-group' },
                h('p', { className: 'audience-more-title' }, group.title),
                h('ul', null, group.items.map((item, index) => h('li', { key: `${group.id}-${index}` }, item)))
              )
            )
          )
        )
      : null,
    h(
      'footer',
      { className: 'audience-foot' },
      // The synthetic-data notice is the header badge's; the two ways on sit apart by space, not a dot (U-D).
      h(
        'p',
        { className: 'audience-actions' },
        onOpenGuide ? h('button', { type: 'button', className: 'link-button', onClick: onOpenGuide, 'aria-haspopup': 'dialog' }, 'How to read a card') : null,
        onChange ? h('button', { type: 'button', className: 'link-button', onClick: onChange, 'aria-haspopup': 'dialog' }, 'Change role in Settings') : null
      )
    )
  );
}
