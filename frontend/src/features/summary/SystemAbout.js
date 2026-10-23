// "About this AI system" and, as its own block, "Declared by the developer",
// under the Summary. Written with createElement (like design/StatusMark.js)
// so the presentation tests can render it without a JSX build.
import { Fragment, createElement as h } from 'react';
import { narrowCardItems } from './narrowCard.js';

function BuiltOn({ builtOn, onOpenSystem }) {
  return builtOn.map((base, index) =>
    h(
      Fragment,
      { key: base.version },
      index ? ', ' : null,
      base.canOpen && onOpenSystem
        ? h('button', { type: 'button', className: 'link-button', onClick: () => onOpenSystem(base.version), title: `Open ${base.label} on the atlas` }, base.label)
        : base.label
    )
  );
}

function FactRow({ label, children }) {
  return h('div', { className: 'fact-row' }, h('dt', null, label), h('dd', null, children));
}

/** Other versions of the AI system (contract v1.14, §28.2), each opening its card on the atlas. */
function Versions({ links, onOpenCard }) {
  return links.map((link, index) =>
    h(
      Fragment,
      { key: link.version },
      index ? ', ' : null,
      link.canOpen && onOpenCard
        ? h('button', { type: 'button', className: 'link-button', onClick: () => onOpenCard(link.card.modelVersion, link.card.useCase), title: `Open ${link.label} on the atlas` }, link.label)
        : link.label
    )
  );
}

/**
 * The card's configuration (contract v1.14, §28.1): at plain depth its label,
 * date, and a one-line summary; at expert depth every field. Stated by the
 * developer, like the declarations.
 */
function Configuration({ configuration, isExpert }) {
  if (!configuration?.hasRecord) {
    return null;
  }
  const { label, date, summary, items } = configuration;
  return h(
    'div',
    { className: 'system-config' },
    h(
      'p',
      { className: 'system-config-head' },
      h('span', { className: 'system-config-title' }, 'Configuration'),
      h('span', { className: 'system-config-id' }, label ?? 'Not labelled', date ? `, since ${date}` : null)
    ),
    isExpert
      ? items.length
        ? h(
            'dl',
            { className: 'declared-list system-config-list' },
            items.map((item) =>
              h('div', { key: item.id, className: 'declared-item' }, h('dt', null, item.label), h('dd', { title: item.title ?? undefined }, item.value))
            )
          )
        : null
      : summary
        ? h('p', { className: 'system-config-summary', title: summary }, summary)
        : null
  );
}

/**
 * @param {object} props
 * @param {ReturnType<typeof import('./systemDetails.js').systemDetails>} props.details
 * @param {(modelVersion: string) => void} [props.onOpenSystem] opens a "built on" model on the atlas
 * @param {(modelVersion: string, useCase: string) => void} [props.onOpenCard] opens another version's card on the atlas
 * @param {string|null} [props.previousCompareHref] "Compare with previous version": this card beside the one it replaces
 * @param {boolean} [props.isExpert] expert depth: every configuration field
 * @param {object|null} [props.narrowCard] the developer's narrow model card (contract v1.13, §26), or null
 */
export default function SystemAbout({ details, onOpenSystem = null, onOpenCard = null, previousCompareHref = null, isExpert = false, narrowCard = null }) {
  const card = narrowCardItems(narrowCard);
  if (!details || (!details.hasDetails && !details.declarations && !card)) {
    return null;
  }
  const lineage = details.lineage ?? null;
  const about = details.hasDetails
    ? h(
        'section',
        { className: 'system-about', 'aria-labelledby': 'system-about-title' },
        h('h3', { id: 'system-about-title', className: 'group-heading' }, 'About this AI system'),
        h(
          'div',
          { className: 'system-block' },
          h(
            'p',
            { className: 'system-meta' },
            h('span', { className: 'kind-tag' }, details.kind.label),
            details.aiType ? h('span', null, details.aiType) : null
          ),
          details.description ? h('p', { className: 'system-description' }, details.description) : null,
          h(
            'dl',
            { className: 'fact-list' },
            details.facts.map((fact) => h(FactRow, { key: fact.id, label: fact.label }, fact.value)),
            details.builtOn.length ? h(FactRow, { label: 'Built on' }, h(BuiltOn, { builtOn: details.builtOn, onOpenSystem })) : null,
            // What the card's figures measure (contract v1.14, §28.1), at both depths.
            (details.configuration?.measure ?? []).map((item) => h(FactRow, { key: item.id, label: item.label }, item.value)),
            lineage?.replaces ? h(FactRow, { label: 'Replaces' }, h(Versions, { links: [lineage.replaces], onOpenCard })) : null,
            lineage?.replacedBy.length ? h(FactRow, { label: 'Replaced by' }, h(Versions, { links: lineage.replacedBy, onOpenCard })) : null
          ),
          h(Configuration, { configuration: details.configuration, isExpert }),
          previousCompareHref
            ? h('a', { className: 'system-compare-link', href: previousCompareHref }, 'Compare with previous version')
            : null
        )
      )
    : null;
  const declared = details.declarations
    ? h(
        'section',
        { className: 'system-declared', 'aria-labelledby': 'system-declared-title' },
        h('h3', { id: 'system-declared-title', className: 'group-heading' }, 'Declared by the developer'),
        h(
          'div',
          { className: 'system-block is-declared' },
          h('p', { className: 'declared-note' }, details.declarations.note),
          h(
            'dl',
            { className: 'declared-list' },
            details.declarations.items.map((item) =>
              h(
                'div',
                { key: item.id, className: 'declared-item' },
                h('dt', null, item.label),
                h('dd', null, item.href ? h('a', { href: item.href, target: '_blank', rel: 'noopener noreferrer' }, item.value) : item.value)
              )
            )
          )
        )
      )
    : null;
  // The developer's own model card: a block of its own, like the declarations, never mixed with results.
  const narrow = card
    ? h(
        'section',
        { className: 'system-declared system-narrow-card', 'aria-labelledby': 'system-card-title' },
        h('h3', { id: 'system-card-title', className: 'group-heading' }, 'Developer’s model card'),
        h(
          'div',
          { className: 'system-block is-declared' },
          h('p', { className: 'declared-note' }, h('strong', { className: 'narrow-card-title' }, card.title), `, ${card.format}. `, card.note),
          card.items.length
            ? h(
                'dl',
                { className: 'declared-list' },
                card.items.map((item) => h('div', { key: item.id, className: 'declared-item' }, h('dt', null, item.label), h('dd', null, item.value)))
              )
            : null,
          card.results ? h('p', { className: 'narrow-card-results' }, card.results) : null
        )
      )
    : null;
  return h(Fragment, null, about, declared, narrow);
}
