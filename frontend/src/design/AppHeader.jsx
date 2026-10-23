import { useState } from 'react';
import BrandMark from './BrandMark.jsx';
import HelpTip from './HelpTip.js';
import Icon from './Icon.jsx';
import SiteNav from './SiteNav.jsx';
import { SITE_PAGES } from './siteNav.js';
import DefaultsSheet from '../features/profile/DefaultsSheet.jsx';
import { SETTINGS_TITLE, SYNTHETIC_HELP } from '../features/profile/defaultsModel.js';
import '../styles/header.css';
import '../styles/help.css';

/**
 * The one page frame: the same header row on
 * every page, its parts always in the same places. The brand, top left, goes
 * back to the catalogue; then the synthetic-data badge; the page links; and
 * Settings, always last. Page controls sit below it, never in it.
 *
 * Settings opens the page's own sheet when the page passes `onOpenSettings`
 * (the catalogue and the atlas open it from elsewhere too); otherwise the
 * header keeps the sheet itself.
 *
 * @param {object} props
 * @param {'catalogue'|'compare'|'atlas'|'admin'|'plugin'} props.current
 * @param {Record<string, string>|null} [props.hrefs] page links that carry the page's state (SiteNav)
 * @param {(() => void)|null} [props.onOpenSettings]
 */
export default function AppHeader({ current, hrefs = null, onOpenSettings = null }) {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const openSettings = onOpenSettings ?? (() => setIsSettingsOpen(true));
  return (
    <>
      <header className="app-header">
        <a className="app-brand" href={SITE_PAGES[0].href}>
          <BrandMark className="app-brand-mark" />
          <span className="app-brand-name">Broad Modelcard</span>
        </a>
        <span className="app-header-badge">
          <span className="synthetic-badge">
            Synthetic<span className="synthetic-badge-more"> data</span>
          </span>
          <HelpTip label="About the data">
            <p>{SYNTHETIC_HELP}</p>
          </HelpTip>
        </span>
        <SiteNav current={current} hrefs={hrefs} onOpenSettings={openSettings} className="app-header-nav" />
        <button type="button" className="button-plain app-header-settings" aria-haspopup="dialog" onClick={openSettings}>
          <Icon name="settings" size={18} />
          <span className="app-header-settings-text">{SETTINGS_TITLE}</span>
        </button>
      </header>
      {!onOpenSettings && isSettingsOpen ? <DefaultsSheet onClose={() => setIsSettingsOpen(false)} /> : null}
    </>
  );
}
