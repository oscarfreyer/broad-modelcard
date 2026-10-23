import { useEffect } from 'react';

/**
 * Close an open overlay on a pointer press outside `refs` or on Esc. Esc is
 * stopped here so it does not also step the atlas back. When Esc closes an
 * overlay that holds the focus, the focus goes back to its trigger, the first
 * of `refs`, instead of falling to the page as the overlay unmounts.
 *
 * @param {boolean} isOpen
 * @param {Array<{ current: HTMLElement|null }>} refs elements that count as inside; the first is the trigger
 * @param {() => void} onDismiss
 */
export default function useDismiss(isOpen, refs, onDismiss) {
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const isInside = (target) => refs.some((ref) => ref.current?.contains(target));
    const onPointerDown = (event) => {
      if (!isInside(event.target)) {
        onDismiss();
      }
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        const trigger = refs[0]?.current;
        const hadFocus = isInside(document.activeElement);
        onDismiss();
        if (hadFocus && trigger && trigger !== document.activeElement) {
          trigger.focus();
        }
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isOpen, onDismiss, refs]);
}
