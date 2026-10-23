import { useCallback, useId, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import useDismiss from './useDismiss.js';
import { SITE_PAGES, siteNavItems } from './siteNav.js';

export { SITE_PAGES, siteNavItems };

function PageLink({ page, className }) {
  if (page.isCurrent) {
    return (
      <span className={`${className} is-current`} aria-current="page">
        {page.label}
      </span>
    );
  }
  return (
    <a className={className} href={page.href}>
      {page.label}
    </a>
  );
}

/**
 * The page links of the shared header (AppHeader.jsx): the same
 * items in the same order on every page, the current one named, not linked.
 * On a phone they fold into one menu, with Settings as its last item.
 *
 * @param {object} props
 * @param {'catalogue'|'compare'|'atlas'|'admin'|'plugin'} props.current
 * @param {Record<string, string>|null} [props.hrefs] links that carry the page's state, by page id (the comparison's way back to its catalogue choice)
 * @param {(() => void)|null} [props.onOpenSettings] Settings, the phone menu's last item
 */
export default function SiteNav({ current, hrefs = null, onOpenSettings = null, className = '' }) {
  const items = useMemo(() => siteNavItems(current, { hrefs }), [current, hrefs]);
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const refs = useMemo(() => [buttonRef, menuRef], []);
  const close = useCallback(() => setIsOpen(false), []);
  useDismiss(isOpen, refs, close);
  const menuId = useId();

  return (
    <nav className={`site-nav${className ? ` ${className}` : ''}`} aria-label="Pages">
      <ul className="site-nav-list">
        {items.map((page) => (
          <li key={page.id}>
            <PageLink page={page} className="button-plain site-nav-link" />
          </li>
        ))}
      </ul>
      <div className="site-nav-compact">
        <button
          ref={buttonRef}
          type="button"
          className="button-plain site-nav-menu-button"
          aria-expanded={isOpen}
          aria-controls={menuId}
          onClick={() => setIsOpen((open) => !open)}
        >
          <Icon name="menu" size={18} />
          <span className="site-nav-menu-text">Menu</span>
        </button>
        {isOpen ? (
          <div ref={menuRef} id={menuId} className="site-nav-popover">
            <ul className="site-nav-menu-list">
              {items.map((page) => (
                <li key={page.id}>
                  <PageLink page={page} className="site-nav-menu-link" />
                </li>
              ))}
              {onOpenSettings ? (
                <li className="site-nav-menu-settings">
                  <button
                    type="button"
                    className="site-nav-menu-link"
                    aria-haspopup="dialog"
                    onClick={() => {
                      // The menu goes away with its item: focus returns to the menu button when the sheet closes.
                      buttonRef.current?.focus();
                      setIsOpen(false);
                      onOpenSettings();
                    }}
                  >
                    <Icon name="settings" size={18} />
                    Settings
                  </button>
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </div>
    </nav>
  );
}
