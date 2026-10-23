import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../../design/Icon.jsx';
import '../../styles/label.css';
import DeveloperLabel from './DeveloperLabel.js';
import { lockPageScroll, rememberOpener } from './dialogFocus.js';
import { downloadLabelPdf, downloadLabelSvg } from './labelExport.js';
import { buildLabelModel, labelFileStem } from './labelModel.js';
import useClientQuery from '../../api/useClientQuery.js';
import { IS_STATIC_BUILD } from '../../shared/staticBuild.js';

/**
 * The model card of one card in a modal sheet, with its
 * downloads. It is drawn from the catalogue tile at the catalogue's dataset
 * version, so it matches the card at that version.
 *
 * @param {object} props
 * @param {object|null} props.tile catalogue tile (null while loading)
 * @param {object|null} props.catalogue the catalogue response the tile came from
 * @param {object|null} [props.geometry] the snapshot geometry (useSnapshotGeometry)
 * @param {string|null} [props.error] why the model card cannot be shown
 * @param {() => void} props.onClose
 */
export default function LabelDialog({ tile, catalogue, geometry = null, error = null, onClose }) {
  const dialogRef = useRef(null);
  const svgRef = useRef(null);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);
  // Who runs this copy and the developer's narrow model card (contract v1.13, §26); the static demo has neither read.
  const meta = useClientQuery(IS_STATIC_BUILD ? null : 'meta', (client, options) => client.getMeta({}, options)).data;
  const cardModel = IS_STATIC_BUILD ? null : tile?.model_version ?? null;
  const narrowCard = useClientQuery(cardModel ? `narrow-card|${cardModel}` : null, (client, options) =>
    client.getNarrowModelCard({ modelVersion: cardModel }, options)
  ).data?.narrow_model_card ?? null;
  const model = useMemo(
    () => (tile && catalogue ? buildLabelModel(tile, catalogue, { pageUrl: window.location.href, instance: meta?.instance ?? null, narrowCard }) : null),
    [tile, catalogue, meta, narrowCard]
  );

  // Close, Esc, and a click on the backdrop ask the parent to close; it
  // unmounts the dialog, which closes the native dialog and gives focus back
  // to the button that opened the label (also when the parent unmounts it for
  // another reason). Closing does not wait for the native `close` event:
  // Chromium fires it on the next frame, and a tab that draws no frames would
  // keep the closed dialog mounted.
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

  const download = async (kind) => {
    if (!model || !svgRef.current) return;
    setBusy(kind);
    setFailure(null);
    try {
      const stem = labelFileStem(model);
      if (kind === 'svg') {
        downloadLabelSvg(svgRef.current, stem);
      } else {
        await downloadLabelPdf(svgRef.current, model, stem);
      }
    } catch (reason) {
      setFailure(reason?.message || 'The download did not work. Try again.');
    } finally {
      setBusy(null);
    }
  };

  // The download waits for the snapshot, so a file never holds its placeholder.
  const canDownload = model && !model.isPreview && Boolean(geometry);
  return (
    <dialog
      ref={dialogRef}
      className="label-dialog"
      aria-labelledby="label-dialog-title"
      onKeyDown={(event) => {
        // Esc closes the label only: the page's own Esc (step back in the
        // atlas) skips handled keys.
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className="label-dialog-body">
        <header className="label-dialog-head">
          <div>
            <h2 id="label-dialog-title" className="label-dialog-title">Model card</h2>
            <p className="label-dialog-intro">
              A one-page summary of this card that the maintainer can give its developer to attach. It shows the card at one dataset
              version and links back to it. It is not a certification or an approval.
            </p>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </header>

        {model?.population ? (
          <p className="label-dialog-note">
            The figures and the card link use the local prevalence {model.population.name}, a synthetic set.
          </p>
        ) : null}
        {model?.isPreview ? (
          <p className="label-dialog-note is-caution">This is an unpublished preview. Model cards can be downloaded for published data only.</p>
        ) : null}

        <div className="label-dialog-preview">
          {model ? (
            <DeveloperLabel model={model} geometry={geometry} svgRef={svgRef} />
          ) : (
            <p className="label-dialog-status" role="status">
              {error ?? 'Loading the model card…'}
            </p>
          )}
        </div>

        {failure ? (
          <p className="label-dialog-note is-error" role="alert">
            {failure}
          </p>
        ) : null}

        <footer className="label-dialog-actions">
          <button type="button" className="button-plain" onClick={onClose}>
            Close
          </button>
          <button type="button" className="button-tinted" disabled={!canDownload || Boolean(busy)} onClick={() => download('svg')}>
            <Icon name="download" size={16} />
            Download SVG
          </button>
          <button type="button" className="button-filled" disabled={!canDownload || Boolean(busy)} onClick={() => download('pdf')}>
            <Icon name="download" size={16} />
            {busy === 'pdf' ? 'Preparing PDF…' : 'Download PDF'}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
