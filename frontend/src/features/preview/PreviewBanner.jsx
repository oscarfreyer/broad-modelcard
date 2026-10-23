import Icon from '../../design/Icon.jsx';
import { displayUseCase } from '../../shared/format.js';
import { DATASET_TITLES, adminHref, previewEndedReason } from './previewModel.js';

/** The changed-from-live mark as the key and the band draw it: a plain bubble inside an ink ring with a white gap. */
export function ChangedGlyph({ size = 20 }) {
  return (
    <svg className="changed-glyph" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle className="changed-glyph-bubble" cx="10" cy="10" r="4.5" />
      <circle className="bubble-change-gap" cx="10" cy="10" r="8" />
      <circle className="bubble-change" cx="10" cy="10" r="8" />
    </svg>
  );
}

function describeUpload(upload) {
  if (!upload) {
    return 'A staged update';
  }
  const title = DATASET_TITLES[upload.kind] ?? 'Data';
  const target = upload.target?.population_id
    ? ` ${upload.target.population_name ?? upload.target.population_id}`
    : upload.target
      ? ` for ${upload.target.model_version}, ${displayUseCase(upload.target.use_case)}`
      : '';
  return `${title}${target}, from “${upload.filename}”`;
}

/** What the band says per page: the atlas (default) or the catalogue (`?preview=staged:<id>`). */
const SURFACES = {
  atlas: {
    notLive: 'Not live: the published atlas still shows the current data.',
    liveHref: './atlas.html',
    liveLabel: 'Open the live atlas'
  },
  catalogue: {
    notLive: 'Not live: the published catalogue still shows the current data. Model cards are off.',
    liveHref: './index.html',
    liveLabel: 'Open the live catalogue'
  }
};

/**
 * The band over an atlas that shows a staged, unpublished update. It stays as
 * long as the page does, says what is staged, counts the changed bubbles on
 * screen, and leads back to the update. When the update was published,
 * replaced, or discarded meanwhile, it says so and offers the live atlas.
 *
 * @param {object} props
 * @param {ReturnType<import('./usePreview.js').default>} props.preview
 * @param {number|null} props.changedCount conditions in view whose data differs from live, or null while unknown
 * @param {'atlas'|'catalogue'} [props.surface] the page the band sits on
 */
export default function PreviewBanner({ preview, changedCount = null, surface = 'atlas' }) {
  const { upload, phase } = preview;
  const words = SURFACES[surface] ?? SURFACES.atlas;
  const isActive = phase === 'active' || phase === 'loading' || phase === 'unreachable';
  return (
    <section className={`preview-banner${isActive ? '' : ' is-ended'}`} aria-label="Unpublished preview" role="region">
      <Icon name="preview" size={22} className="preview-banner-icon" />
      <div className="preview-banner-text">
        <h2 className="preview-banner-title">{isActive ? 'Unpublished preview' : 'This preview has ended'}</h2>
        <p className="preview-banner-detail">
          {isActive
            ? `${describeUpload(upload)}. ${words.notLive}`
            : `${describeUpload(upload)}. ${phase === 'missing' ? previewEndedReason(null) : previewEndedReason(upload)}`}
        </p>
      </div>
      {isActive && changedCount != null ? (
        <p className="preview-banner-count" role="status">
          <ChangedGlyph />
          {changedCount === 0
            ? 'No changed conditions here'
            : `${changedCount.toLocaleString('en-US')} ${changedCount === 1 ? 'condition differs' : 'conditions differ'} from live here`}
        </p>
      ) : null}
      <div className="preview-banner-actions">
        {isActive ? null : (
          <a className="button-tinted" href={words.liveHref}>
            {words.liveLabel}
          </a>
        )}
        <a className="button-filled" href={adminHref(upload)}>
          <Icon name="chevronLeft" size={18} />
          Back to the update
        </a>
      </div>
    </section>
  );
}
