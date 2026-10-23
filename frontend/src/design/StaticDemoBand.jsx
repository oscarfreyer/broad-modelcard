import Icon from './Icon.jsx';
import { STATIC_SNAPSHOT } from '../shared/staticBuild.js';
import { staticNoticeText } from '../shared/staticNotice.js';

/** The band on every page of the static build: what this site is and what it leaves out. */
export default function StaticDemoBand() {
  const { title, detail } = staticNoticeText(STATIC_SNAPSHOT);
  return (
    <section className="static-band" aria-label={title} role="region">
      <Icon name="info" size={16} className="static-band-icon" />
      <p className="static-band-text">
        <strong>{title}.</strong> {detail}
      </p>
    </section>
  );
}
