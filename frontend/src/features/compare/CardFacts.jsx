import { useState } from 'react';
import Icon from '../../design/Icon.jsx';
import { kindLabel } from '../../shared/aiSystem.js';
import { displayUseCase } from '../../shared/format.js';
import { validationTypeLabel } from '../../shared/metricLabels.js';
import {
  DESIGN_GROUP_WORDS,
  conductorLabel,
  conductorWords,
  designLabel,
  functionCategoryWords,
  lensesWords,
  narrowCardWords,
  requestedLensWords,
  settingsWords
} from './compareCopy.js';
import { concerns } from './compareModel.js';

function Studies({ studies }) {
  if (!studies.length) {
    return <span className="cmp-fact-quiet">No linked study record</span>;
  }
  return (
    <ul className="cmp-fact-list">
      {studies.map((study) => (
        <li key={study.study_id}>
          <span className="cmp-fact-strong">{designLabel(study.design)}</span>
          <span className="cmp-fact-quiet">
            {study.setting}; by {conductorLabel(study.conducted_by)}; {study.sites.toLocaleString('en-US')}{' '}
            {study.sites === 1 ? 'site' : 'sites'}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What a card's figures measure and against what (v1.14, §28.1), or "Not stated". */
function Measure({ card }) {
  if (!card.performance_measure) {
    return <span className="cmp-fact-quiet">Not stated</span>;
  }
  return (
    <>
      <span>{card.performance_measure}</span>
      {card.reference_standard ? <span className="cmp-fact-quiet">Against: {card.reference_standard}</span> : null}
    </>
  );
}

/** The card's configuration id and date (v1.14, §28.1), or "Not stated". */
function Configuration({ configuration }) {
  if (!configuration?.configuration_id && !configuration?.configuration_date) {
    return <span className="cmp-fact-quiet">Not stated</span>;
  }
  return (
    <>
      <span className="cmp-fact-code">{configuration.configuration_id ?? 'No id'}</span>
      {configuration.configuration_date ? <span className="cmp-fact-quiet">Since {configuration.configuration_date}</span> : null}
    </>
  );
}

/**
 * "About these cards": the facts that decide whether results compare, one
 * column per card: the task (function and category), the AI system, the
 * populations it stores, what its figures measure, its configuration, the
 * studies, who conducted them, and the kinds of evidence behind it, and the
 * developer's narrow model card. A fact a card-level reason concerns is outlined.
 *
 * @param {{ cards: object[], cardReasons: object[], lens: object, setting?: string|null }} props `setting`: a specific
 *   care setting (contract v1.14), else null
 */
export default function CardFacts({ cards, cardReasons, lens, setting = null }) {
  // The facts that carry the reasons show at once; studies and evidence kinds on demand, so the results stay near the top.
  const [showAll, setShowAll] = useState(false);
  const concerned = (code, card) => concerns(cardReasons.filter((reason) => reason.code === code), card.card_id);
  const facts = [
    {
      label: 'Function',
      render: (card) => (
        <>
          <span className="cmp-fact-strong">{displayUseCase(card.use_case)}</span>
          <span className="cmp-fact-quiet">{functionCategoryWords(card.function_category)}</span>
        </>
      ),
      flag: (card) => concerned('function_category_differs', card) || concerned('function_category_unknown', card)
    },
    {
      label: 'AI system',
      render: (card) => (
        <>
          <span className="cmp-fact-strong">
            {card.display_name} <span className="kind-tag">{kindLabel(card)}</span>
          </span>
          <span className="cmp-fact-quiet">
            Version {card.model_version}
            {card.developer ? `, ${card.developer}` : ''}
          </span>
        </>
      )
    },
    {
      label: 'Intended use',
      render: (card) => <span>{card.intended_use_defined ? 'Stated' : 'No statement'}</span>
    },
    {
      label: 'Populations with data',
      render: (card) => {
        const requested = requestedLensWords(card.lenses, lens, setting);
        return (
          <>
            <span>{lensesWords(card.lenses)}</span>
            <span className="cmp-fact-quiet">{settingsWords(card.lenses)}</span>
            {requested ? <span className="cmp-fact-quiet">{requested}</span> : null}
          </>
        );
      },
      flag: (card) => concerned('population_differs', card)
    },
    {
      label: 'What the figures measure',
      render: (card) => <Measure card={card} />,
      flag: (card) => concerned('measure_differs', card) || concerned('measure_unknown', card)
    },
    {
      label: 'Configuration',
      render: (card) => <Configuration configuration={card.configuration} />
    },
    {
      label: 'Studies',
      more: true,
      render: (card) => <Studies studies={card.studies} />
    },
    {
      label: 'Who conducted them',
      more: true,
      render: (card) => {
        const words = conductorWords(card.conductors);
        return words ? <span>{words}</span> : <span className="cmp-fact-quiet">No linked study record</span>;
      }
    },
    {
      label: 'Kinds of evidence',
      more: true,
      render: (card) =>
        card.design_groups.length ? (
          <>
            <span>{card.design_groups.map((group) => DESIGN_GROUP_WORDS[group] ?? group).join(', ')}</span>
            <span className="cmp-fact-quiet">{card.validation_types.map((type) => validationTypeLabel(type, type)).join(', ')}</span>
          </>
        ) : (
          <span className="cmp-fact-quiet">None for this group</span>
        )
    },
    {
      label: 'Narrow model card',
      more: true,
      render: (card) => (
        <>
          <span>{narrowCardWords(card.narrow_model_card)}</span>
          {card.narrow_model_card?.present ? <span className="cmp-fact-quiet">The developer’s own; not checked</span> : null}
        </>
      )
    }
  ];

  return (
    <>
      <div className="cmp-scroll" tabIndex={0} role="region" aria-label="About these cards, one column per card">
        <table className="cmp-table cmp-facts">
          <thead>
            <tr>
              <th scope="col" className="cmp-col-label">
                <span className="visually-hidden">Fact</span>
              </th>
              {cards.map((card) => (
                <th key={card.card_id} scope="col" className="cmp-col-card">
                  <span className="cmp-card-name">{card.display_name}</span>
                  <span className="cmp-card-function">{displayUseCase(card.use_case)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {facts.filter((fact) => showAll || !fact.more).map((fact) => (
              <tr key={fact.label}>
                <th scope="row" className="cmp-col-label">
                  {fact.label}
                </th>
                {cards.map((card) => (
                  <td key={card.card_id} className={`cmp-fact${fact.flag?.(card) ? ' is-concerned' : ''}`}>
                    {fact.render(card)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="button-plain cmp-facts-more" aria-expanded={showAll} onClick={() => setShowAll((open) => !open)}>
        <Icon name={showAll ? 'chevronUp' : 'chevronDown'} size={16} />
        {showAll ? 'Fewer facts' : 'Studies, evidence, and model card'}
      </button>
    </>
  );
}
