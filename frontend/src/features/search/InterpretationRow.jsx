import Icon from '../../design/Icon.jsx';
import { CHIP_KIND_WORDS, chipLabel } from './interpretation.js';

/**
 * How a plain-language query was read (contract v1.14, CONTRACT.md §31): the
 * chips, each removable, and Apply. Nothing is applied until the reader
 * presses Apply (or, after Apply, removes a chip, which applies the rest).
 *
 * @param {object} props
 * @param {ReturnType<import('./useInterpretation.js').default>} props.interpretation
 * @param {object[]} props.entries the registry (listModels), for system names
 * @param {(options: { combine: boolean }) => void} props.onApply
 * @param {boolean} [props.canCombine] offer "Open as a combination" (two or three conditions on a card with combinations)
 * @param {boolean} [props.isApplied] the chips on screen are what the atlas shows
 * @param {string} [props.applyLabel] "Apply", or e.g. "Open in the atlas" on the catalogue
 * @param {boolean} [props.offerHelper] whether Ask with the helper may show (also needs the helper on)
 */
export default function InterpretationRow({ interpretation, entries, onApply, canCombine = false, isApplied = false, applyLabel = 'Apply', offerHelper = true }) {
  const { chips, unrecognized, origin, helper } = interpretation;
  const fromHelper = origin === 'helper';
  const dropped = fromHelper ? helper?.dropped?.length ?? 0 : 0;
  return (
    <section className="interpret" aria-label="How your words were read">
      <div className="interpret-head">
        <p className="interpret-lead">{fromHelper ? 'The helper read this as' : 'Read as'}</p>
        {isApplied ? (
          <p className="interpret-state" role="status">
            <Icon name="check" size={14} /> Applied
          </p>
        ) : null}
      </div>
      {chips.length ? (
        <ul className="interpret-chips">
          {chips.map((chip) => {
            const label = chipLabel(chip, entries);
            return (
              <li key={`${chip.kind}|${chip.value}`} className={`interpret-chip is-${chip.kind}`}>
                <span className="interpret-chip-kind">{CHIP_KIND_WORDS[chip.kind]}</span>
                <span className="interpret-chip-label">{label}</span>
                {chip.kind === 'condition' && chip.match === 'synonym' && chip.matched_term ? (
                  <span className="interpret-chip-note">as “{chip.matched_term}”</span>
                ) : null}
                <button type="button" className="interpret-chip-remove" aria-label={`Remove ${CHIP_KIND_WORDS[chip.kind]} ${label}`} onClick={() => interpretation.remove(chip)}>
                  <Icon name="close" size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="interpret-note">Nothing left to apply. Type again to start over.</p>
      )}
      {unrecognized.length || dropped ? (
        <p className="interpret-note">
          {unrecognized.length ? `Not used: ${unrecognized.join(', ')}.` : ''}
          {dropped ? ` ${dropped} ${dropped === 1 ? 'suggestion' : 'suggestions'} from the helper did not match the atlas.` : ''}
        </p>
      ) : null}
      <div className="interpret-actions">
        {chips.length ? (
          <button type="button" className="button-filled interpret-apply" onClick={() => onApply({ combine: false })}>
            {applyLabel}
          </button>
        ) : null}
        {canCombine ? (
          <button type="button" className="button-tinted" onClick={() => onApply({ combine: true })}>
            <Icon name="combination" size={16} /> Open as a combination
          </button>
        ) : null}
        {offerHelper && interpretation.helperAvailable && !fromHelper ? (
          <button type="button" className="button-plain" onClick={interpretation.askHelper} disabled={interpretation.isAskingHelper}>
            {interpretation.isAskingHelper ? 'Asking the helper…' : 'Ask with the helper'}
          </button>
        ) : null}
      </div>
      {interpretation.helperError ? (
        <p className="interpret-note is-error" role="alert">
          The helper could not answer: {interpretation.helperError.detail ?? interpretation.helperError.message}
        </p>
      ) : null}
      {offerHelper && interpretation.helperAvailable && !fromHelper ? (
        <p className="interpret-fine">Ask with the helper sends only these words and the lists of AI systems, functions, and groups to your configured model.</p>
      ) : null}
    </section>
  );
}
