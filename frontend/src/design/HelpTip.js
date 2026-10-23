import { createElement as h, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

// React-free of JSX and CSS imports, so the condition card's sections (plain
// .js, rendered by the node tests) can use it; help.css loads with the
// shared header (AppHeader.jsx), on every page. The glyph is Icon.jsx's `help`.
const QUESTION_GLYPH = h(
  'svg',
  { className: 'icon', width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
  h('circle', { cx: 12, cy: 12, r: 8.25 }),
  h('path', { d: 'M9.75 9.6a2.3 2.3 0 0 1 4.45.8c0 1.55-2.2 2-2.2 3.35' }),
  h('path', { d: 'M12 16.6v.05' })
);

const GAP = 6;
const MARGIN = 8;
const CLOSE_DELAY = 160;

/**
 * Where the bubble goes: under the button, centred on it, kept inside the
 * viewport; above the button when there is no room below.
 */
export function helpTipPosition(button, bubble, viewport) {
  const left = Math.min(Math.max(button.left + button.width / 2 - bubble.width / 2, MARGIN), Math.max(MARGIN, viewport.width - bubble.width - MARGIN));
  const below = button.bottom + GAP;
  const top = below + bubble.height > viewport.height - MARGIN && button.top - GAP - bubble.height >= MARGIN ? button.top - GAP - bubble.height : below;
  return { left: Math.round(left), top: Math.round(top) };
}

/**
 * A question mark that explains: the
 * sentences that say what something means live here instead of in the page.
 * Hover or keyboard focus shows the explanation; a click or tap keeps it
 * open; Esc or a press outside closes it. The text is the button's
 * description for assistive tech, so it is read without opening.
 *
 * The bubble is a manual popover (top layer), so no overflow, dialog, or
 * sticky bar clips it; where the Popover API is missing it is a fixed box.
 *
 * @param {object} props
 * @param {string} [props.label] the button's name, e.g. "About the legend"
 * @param {import('react').ReactNode} props.children the explanation
 * @param {string} [props.className]
 * @param {string} [props.bubbleId] the explanation's id, where a field names it as its description
 */
export default function HelpTip({ label = 'What this means', children, className = '', bubbleId: givenId = null }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [position, setPosition] = useState(null);
  const buttonRef = useRef(null);
  const bubbleRef = useRef(null);
  const closeTimer = useRef(null);
  const id = useId();
  const bubbleId = givenId ?? `help-${id}`;

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const close = useCallback(() => {
    cancelClose();
    setIsOpen(false);
    setIsPinned(false);
  }, []);
  const open = () => {
    cancelClose();
    setIsOpen(true);
  };
  const closeSoon = () => {
    if (isPinned) return;
    cancelClose();
    closeTimer.current = setTimeout(() => setIsOpen(false), CLOSE_DELAY);
  };

  useEffect(() => cancelClose, []);

  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!bubble) return undefined;
    const canPop = typeof bubble.showPopover === 'function';
    if (!isOpen) {
      if (canPop && bubble.matches(':popover-open')) bubble.hidePopover();
      setPosition(null);
      return undefined;
    }
    if (canPop && !bubble.matches(':popover-open')) bubble.showPopover();
    const place = () => {
      const button = buttonRef.current?.getBoundingClientRect();
      if (!button) return;
      const rect = bubble.getBoundingClientRect();
      setPosition(helpTipPosition(button, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        // Only the tip closes: not the sheet or dialog it sits in, nor an atlas step back.
        event.preventDefault();
        event.stopPropagation();
        const hadFocus = bubbleRef.current?.contains(document.activeElement);
        close();
        if (hadFocus) buttonRef.current?.focus();
      }
    };
    const onPointerDown = (event) => {
      if (!buttonRef.current?.contains(event.target) && !bubbleRef.current?.contains(event.target)) close();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [close, isOpen]);

  return h(
    'span',
    { className: `help-tip${className ? ` ${className}` : ''}` },
    h(
      'button',
      {
        ref: buttonRef,
        type: 'button',
        className: 'help-tip-button',
        'aria-label': label,
        'aria-describedby': bubbleId,
        'aria-expanded': isOpen,
        onMouseEnter: open,
        onMouseLeave: closeSoon,
        // Keyboard focus only: a dialog that focuses its first button on
        // opening, or a click, does not pop the explanation open.
        onFocus: (event) => {
          if (event.currentTarget.matches?.(':focus-visible')) open();
        },
        onBlur: (event) => {
          if (!bubbleRef.current?.contains(event.relatedTarget)) closeSoon();
        },
        onClick: (event) => {
          event.stopPropagation();
          if (isPinned) {
            close();
          } else {
            setIsPinned(true);
            open();
          }
        }
      },
      QUESTION_GLYPH
    ),
    h(
      'span',
      {
        ref: bubbleRef,
        id: bubbleId,
        className: `help-tip-bubble${isOpen ? ' is-open' : ''}`,
        popover: 'manual',
        hidden: isOpen ? undefined : true,
        style: position ? { left: `${position.left}px`, top: `${position.top}px` } : undefined,
        onMouseEnter: cancelClose,
        onMouseLeave: closeSoon,
        onBlur: (event) => {
          if (!bubbleRef.current?.contains(event.relatedTarget) && event.relatedTarget !== buttonRef.current) closeSoon();
        }
      },
      children
    )
  );
}

/**
 * A heading with its help beside it, outside the heading, so the heading's
 * name stays its words. `texts` are the help's paragraphs; with
 * none, the heading stands alone.
 *
 * @param {import('react').ReactElement} heading
 * @param {Array<string|null|undefined|false>} texts
 * @param {string} label the help button's name, e.g. "About Study quality"
 */
export function withHelp(heading, texts, label) {
  const shown = (texts ?? []).filter(Boolean);
  if (!shown.length) return heading;
  return h(
    'div',
    { className: 'page-title-row' },
    heading,
    h(HelpTip, { label }, ...shown.map((text, index) => h('p', { key: index }, text)))
  );
}
