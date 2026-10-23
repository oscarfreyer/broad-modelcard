import { useState } from 'react';
import useClientQuery from '../../api/useClientQuery.js';
import Icon from '../../design/Icon.jsx';
import { cardId } from '../profile/profile.js';
import LabelDialog from './LabelDialog.jsx';
import useSnapshotGeometry from './useSnapshotGeometry.js';

// The catalogue at the page's own dataset version (the client's default:
// live, or the staged preview the atlas shows) and, when the atlas uses one,
// its local population (contract v1.10). Read only when the label opens.
function pageCatalogue(population) {
  return {
    key: `catalogue|page-version${population ? `|population:${population}` : ''}`,
    fetch: (client, options) => client.getCatalogue(population ? { population } : {}, options)
  };
}

function CardLabel({ modelVersion, useCase, population, onClose }) {
  const catalogue = pageCatalogue(population?.id ?? null);
  const query = useClientQuery(catalogue.key, catalogue.fetch);
  const id = cardId(modelVersion, useCase);
  const tile = query.data?.tiles?.find((candidate) => candidate.card_id === id) ?? null;
  // The atlas has read this structure already: the snapshot places its bubbles as the atlas on screen does.
  const geometry = useSnapshotGeometry({ population: population?.id ?? null });
  let error = null;
  if (query.error) {
    error = 'The model card could not be loaded. Check that the backend is running, then try again.';
  } else if (query.data && !tile) {
    error = 'This card is not in the catalogue.';
  }
  return <LabelDialog tile={tile} catalogue={tile ? query.data : null} geometry={geometry} error={error} onClose={onClose} />;
}

/**
 * The atlas toolbar's way to the current card's model card.
 *
 * @param {{ modelVersion: string, useCase: string, population?: { id: string, name: string }|null }} props
 *   population: the local population the atlas uses; the model card is made for it and names it
 */
export default function CardLabelButton({ modelVersion, useCase, population = null }) {
  const [open, setOpen] = useState(false);
  if (!modelVersion || !useCase) {
    return null;
  }
  return (
    <>
      <button
        type="button"
        className="toolbar-button card-label-button"
        aria-label="Model card"
        title="A one-page summary of this card to download (SVG or PDF)"
        onClick={() => setOpen(true)}
      >
        <Icon name="export" size={15} />
        <span className="toolbar-button-text">Model card</span>
      </button>
      {open ? <CardLabel modelVersion={modelVersion} useCase={useCase} population={population} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
