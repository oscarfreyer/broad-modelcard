import { useEffect, useId, useRef } from 'react';

/**
 * A confirmation sheet: a modal <dialog>, so focus stays inside it and Esc
 * cancels. Used only where an action changes live data (publish, restore).
 *
 * @param {object} props
 * @param {string} props.title
 * @param {() => void} props.onClose
 * @param {React.ReactNode} props.actions buttons, primary last
 * @param {string} [props.fallbackFocus] selector focused on close when the
 *   control that opened the sheet is gone (the sheet's action replaced it)
 */
export default function Sheet({ title, onClose, actions, children, isBusy = false, fallbackFocus = null }) {
  const ref = useRef(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const fallbackRef = useRef(fallbackFocus);
  fallbackRef.current = fallbackFocus;

  useEffect(() => {
    const dialog = ref.current;
    // Focus returns to the control that opened the sheet.
    const opener = document.activeElement;
    if (dialog && !dialog.open) {
      dialog.showModal();
      // Open on the title, not on the first control (an inline link, an
      // unchosen radio, or a note field that scrolls the title away), so the
      // sheet is read from the top; Tab then reaches its controls (S8).
      dialog.querySelector('.sheet-title')?.focus();
    }
    const onCancel = (event) => {
      event.preventDefault();
      if (!dialog.dataset.busy) {
        closeRef.current();
      }
    };
    dialog?.addEventListener('cancel', onCancel);
    return () => {
      dialog?.removeEventListener('cancel', onCancel);
      if (dialog?.open) {
        dialog.close();
      }
      if (opener && typeof opener.focus === 'function' && opener.isConnected && opener !== document.body) {
        opener.focus();
      } else if (fallbackRef.current) {
        // Runs after the commit that removed the opener, so the fallback exists.
        window.setTimeout(() => document.querySelector(fallbackRef.current)?.focus(), 0);
      }
    };
  }, []);

  return (
    <dialog ref={ref} className="sheet" aria-labelledby={titleId} data-busy={isBusy ? 'true' : undefined}>
      <h2 id={titleId} className="sheet-title" tabIndex={-1}>
        {title}
      </h2>
      <div className="sheet-body">{children}</div>
      <div className="sheet-actions">{actions}</div>
    </dialog>
  );
}
