import { useEffect, useRef, useState } from 'react';
import Icon from '../../design/Icon.jsx';
import StatusMark from '../../design/StatusMark.js';
import { lockPageScroll, rememberOpener } from '../label/dialogFocus.js';
import { GUIDE_INTRO, GUIDE_STEPS, GUIDE_TITLE, SAME_FIGURES, SYNTHETIC_NOT_CLINICAL, guideMark } from './guideCopy.js';
import '../../styles/overview.css';
import '../../styles/guide.css';

/**
 * "How to read a card" (release 0.5; CONTRACT.md §30.3): four
 * steps, one at a time. It opens by itself once per browser on the first
 * atlas visit, and from the legend ("How to read this") and the catalogue.
 * Closing it at any step, or finishing it, is remembered by the caller.
 *
 * @param {object} props
 * @param {() => void} props.onClose
 */
export default function GuideSheet({ onClose }) {
  const dialogRef = useRef(null);
  const stepRef = useRef(null);
  const [index, setIndex] = useState(0);
  const isLast = index === GUIDE_STEPS.length - 1;

  useEffect(() => {
    const dialog = dialogRef.current;
    const returnFocus = rememberOpener(document);
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

  const go = (next) => {
    setIndex(next);
    // The new step's title takes the focus, so a screen reader reads it.
    requestAnimationFrame(() => stepRef.current?.focus({ preventScroll: true }));
  };

  return (
    <dialog
      ref={dialogRef}
      className="overview-sheet guide-sheet"
      aria-labelledby="guide-title"
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
            <h2 id="guide-title" className="overview-sheet-title">{GUIDE_TITLE}</h2>
            <p className="overview-sheet-lead">{GUIDE_INTRO}</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close the guide" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </header>

        {/* Every step sits in the same cell, the others hidden, so the sheet keeps one height from step to step. */}
        <div className="guide-steps">
          {GUIDE_STEPS.map((entry, position) => {
            const isCurrent = position === index;
            return (
              <section
                key={entry.id}
                className={`guide-step${isCurrent ? '' : ' is-hidden'}`}
                aria-hidden={isCurrent ? undefined : 'true'}
              >
                <p className="guide-step-count">Step {position + 1} of {GUIDE_STEPS.length}</p>
                <h3 ref={isCurrent ? stepRef : null} tabIndex={-1} className="guide-step-title">{entry.title}</h3>
                <p className="guide-step-text">{entry.text}</p>
                {entry.marks.length ? (
                  <ul className="guide-marks" aria-label="Marks and their words">
                    {entry.marks.map((key) => {
                      const mark = guideMark(key);
                      return (
                        <li key={key} className="guide-mark">
                          <StatusMark status={key} size={14} />
                          <span className="guide-mark-label">{mark.label}</span>
                          {mark.meaning ? <span className="guide-mark-meaning">{mark.meaning}</span> : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>

        <p className="overview-sheet-note">
          {SAME_FIGURES} {SYNTHETIC_NOT_CLINICAL}
        </p>

        <footer className="guide-actions">
          <ol className="guide-dots" aria-label="Steps">
            {GUIDE_STEPS.map((entry, position) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={`guide-dot${position === index ? ' is-current' : ''}`}
                  aria-label={`Step ${position + 1}: ${entry.title}`}
                  aria-current={position === index ? 'step' : undefined}
                  onClick={() => go(position)}
                />
              </li>
            ))}
          </ol>
          <span className="guide-buttons">
            {index > 0 ? (
              <button type="button" className="button-plain" onClick={() => go(index - 1)}>
                Back
              </button>
            ) : null}
            {isLast ? (
              <button type="button" className="button-filled" onClick={onClose}>
                Done
              </button>
            ) : (
              <button type="button" className="button-filled" onClick={() => go(index + 1)}>
                Next
              </button>
            )}
          </span>
        </footer>
      </div>
    </dialog>
  );
}
