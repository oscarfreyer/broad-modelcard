import { useEffect, useRef } from 'react';
import Icon from '../../design/Icon.jsx';
import StatusMark from '../../design/StatusMark.js';
import { DISPLAY } from '../../design/status.js';
import { lockPageScroll, rememberOpener } from '../label/dialogFocus.js';
import { OVERVIEW_RULE, OVERVIEW_SHEET_LEAD, OVERVIEW_SHEET_NOTE, OVERVIEW_SHEET_TITLE } from './copy/overviewRule.js';
import '../../styles/overview.css';

/**
 * "How the Overview works": the Overview rule's four steps,
 * each with the marks it can give. Opened from the legend on the Overview view
 * and from the catalogue; the same words (copy/overviewRule.js) as the
 * condition card's "What is behind this mark?".
 *
 * @param {object} props
 * @param {() => void} props.onClose
 * @param {'plain'|'expert'} [props.depth]
 */
export default function OverviewSheet({ onClose, depth = 'plain' }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const returnFocus = rememberOpener(document);
    // The page behind the sheet stays still, as behind the model card.
    const unlockScroll = lockPageScroll(document);
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    return () => {
      if (dialog?.open) {
        dialog.close();
      }
      unlockScroll();
      returnFocus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="overview-sheet"
      aria-labelledby="overview-sheet-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className="overview-sheet-body">
        <header className="overview-sheet-head">
          <div>
            <h2 id="overview-sheet-title" className="overview-sheet-title">{OVERVIEW_SHEET_TITLE}</h2>
            <p className="overview-sheet-lead">{OVERVIEW_SHEET_LEAD}</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </header>
        <ol className="overview-steps is-rule">
          {OVERVIEW_RULE.map((step, index) => (
            <li key={step.id} className="overview-step">
              <span className="overview-step-index" aria-hidden="true">{index + 1}</span>
              <span className="overview-step-main">
                <span className="overview-step-title">{step.title}</span>
                <span className="overview-step-result">{depth === 'expert' ? step.expert : step.plain}</span>
                <span className="overview-step-marks">
                  {step.marks.map((mark) => (
                    <span key={mark} className="overview-step-mark">
                      <StatusMark status={mark} size={12} />
                      {DISPLAY[mark].label}
                    </span>
                  ))}
                </span>
              </span>
            </li>
          ))}
        </ol>
        <p className="overview-sheet-note">{OVERVIEW_SHEET_NOTE} Select a condition and open “What is behind this mark?” to see the steps for it.</p>
        <footer className="overview-sheet-actions">
          <button type="button" className="button-filled" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </dialog>
  );
}
