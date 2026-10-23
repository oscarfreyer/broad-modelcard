import { useEffect, useRef } from 'react';
import useClientQuery from '../../api/useClientQuery.js';
import HelpTip from '../../design/HelpTip.js';
import Icon from '../../design/Icon.jsx';
import useInstanceLine from '../../design/useInstanceLine.js';
import { GUIDE_OPEN_CATALOGUE } from '../guide/guideCopy.js';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import { DEFAULT_PREVALENCE, LOCAL_SYNTHETIC_NOTE, findPopulation } from '../../shared/localPopulation.js';
import { ICD11, ontologyList } from '../../shared/ontology.js';
import { lensOptions } from '../../shared/format.js';
import '../../styles/profile.css';
import { lockPageScroll, rememberOpener } from '../label/dialogFocus.js';
import {
  DEFAULTS_INTRO,
  DEFAULTS_TITLE,
  DEPTH_CHOICES,
  DEPTH_HELP,
  LIVE_META_KEY,
  AUDIENCE_CHOICES,
  audienceHelp,
  depthChoice,
  depthToStore,
  LIVE_MODELS_KEY,
  cardForSystem,
  defaultsFromView,
  defaultsPhrases,
  functionChoices,
  readLiveMeta,
  readLiveModels,
  systemChoices
} from './defaultsModel.js';
import { hasDefaults } from './profile.js';
import useProfile from './useProfile.js';

const LENS_AXES = [
  { key: 'age', label: 'Age', all: 'All ages' },
  { key: 'sex', label: 'Sex', all: 'All sexes' },
  { key: 'ethnicity', label: 'Ethnicity', all: 'All ethnicities' }
];

function Select({ label, value, options, onChange, disabled = false }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="select-wrap">
        <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={14} className="select-chevron" />
      </span>
    </label>
  );
}

/**
 * Settings ("Your defaults" before): the role
 * first (Reading as), then the card, demographic lens,
 * explanation depth, and local prevalence a card opens with when its link
 * does not say otherwise. Like iOS Settings, every change is saved at once,
 * in this browser; the profile export carries them.
 *
 * @param {object} props
 * @param {() => void} props.onClose
 * @param {{ filters: object|null, depth: 'plain'|'expert'|null }|null} [props.view] the atlas on screen, for "Use what is on screen"
 * @param {(() => void)|null} [props.onOpenGuide] "How to read a card", where the page has the guide
 */
export default function DefaultsSheet({ onClose, view = null, onOpenGuide = null }) {
  const instance = useInstanceLine();
  const dialogRef = useRef(null);
  const { profile, store } = useProfile();
  // Live, also in a staged preview: a default is never an unpublished population or AI system.
  const meta = useClientQuery(LIVE_META_KEY, readLiveMeta);
  const registry = useClientQuery(LIVE_MODELS_KEY, readLiveModels);
  const models = registry.data?.models ?? null;
  const populations = meta.data ? meta.data.populations ?? [] : null;
  // Classifications (contract v1.13): offered only when the data holds more than ICD-11.
  const ontologies = meta.data ? ontologyList(meta.data) : null;
  const axes = meta.data?.axes ?? null;
  const defaults = profile.defaults ?? {};
  const card = defaults.card ?? null;
  const missingPopulation = defaults.population && populations && !findPopulation(populations, defaults.population);

  useEffect(() => {
    const dialog = dialogRef.current;
    const returnFocus = rememberOpener(document);
    // The page behind the sheet stays still, as behind the model card.
    const unlockScroll = lockPageScroll(document);
    if (dialog && !dialog.open) {
      // Focus starts on Close, not on the first help button (HelpTip.js).
      dialog.querySelector('.defaults-close')?.setAttribute('autofocus', '');
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

  const systemOptions = [{ value: '', label: 'No default' }, ...systemChoices(models)];
  const lensValue = (axis) => defaults.lens?.[axis.key] ?? axis.all;
  const setLensAxis = (axis, value) => {
    const lens = { ...(defaults.lens ?? {}), [axis.key]: value };
    store.setDefaults({ lens: Object.values(lens).some((entry) => entry && !/^All /.test(entry)) ? lens : null });
  };
  const prevalenceOptions = [
    { value: '', label: DEFAULT_PREVALENCE },
    ...(populations ?? []).map((entry) => ({ value: entry.id, label: entry.name })),
    ...(missingPopulation ? [{ value: defaults.population, label: `${defaults.population} (no longer in the data)` }] : [])
  ];
  const ontologyOptions = (ontologies ?? []).map((entry) => ({ value: entry.id === ICD11 ? '' : entry.id, label: entry.name }));
  const fromView = view?.filters ? defaultsFromView(view.filters, view.depth, populations) : null;
  const persisted = store.isPersistent();

  return (
    <dialog
      ref={dialogRef}
      className="defaults-sheet"
      aria-labelledby="defaults-title"
      onKeyDown={(event) => {
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
      <div className="defaults-body">
        <header className="defaults-head">
          <div className="page-title-row">
            <h2 id="defaults-title" className="defaults-title">{DEFAULTS_TITLE}</h2>
            <HelpTip label="About Settings">
              <p>{DEFAULTS_INTRO}</p>
            </HelpTip>
          </div>
          <button type="button" className="icon-button defaults-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </header>

        <section className="defaults-group" aria-labelledby="defaults-audience">
          <div className="page-title-row">
            <h3 id="defaults-audience" className="defaults-heading">Reading as</h3>
            <HelpTip label="About Reading as">
              <p>{audienceHelp(defaults.audience)} The figures are the same for everyone.</p>
            </HelpTip>
          </div>
          <div className="defaults-fields">
            <Select
              label="Audience"
              value={defaults.audience ?? ''}
              options={AUDIENCE_CHOICES}
              onChange={(audience) => store.setDefaults({ audience: audience || null })}
            />
          </div>
        </section>

        <section className="defaults-group" aria-labelledby="defaults-card">
          <div className="page-title-row">
            <h3 id="defaults-card" className="defaults-heading">Card</h3>
            <HelpTip label="About Card">
              <p>The AI system and function the atlas opens on when a link names none.</p>
            </HelpTip>
          </div>
          <div className="defaults-fields is-two">
            <Select
              label="AI system"
              value={card?.model ?? ''}
              options={systemOptions}
              disabled={!models}
              onChange={(model) => store.setDefaults({ card: cardForSystem(models, model) })}
            />
            <Select
              label="Function"
              value={card?.useCase ?? ''}
              options={card ? functionChoices(models, card.model) : [{ value: '', label: 'Choose an AI system first' }]}
              disabled={!card}
              onChange={(useCase) => store.setDefaults({ card: { model: card.model, useCase } })}
            />
          </div>
        </section>

        <section className="defaults-group" aria-labelledby="defaults-lens">
          <div className="page-title-row">
            <h3 id="defaults-lens" className="defaults-heading">Population</h3>
            <HelpTip label="About Population">
              <p>The group of patients a card's results are shown for.</p>
            </HelpTip>
          </div>
          <div className="defaults-fields is-three">
            {LENS_AXES.map((axis) => {
              const offered = axes?.[axis.key] ?? [];
              const values = offered.includes(lensValue(axis)) ? offered : [lensValue(axis), ...offered];
              return (
                <Select
                  key={axis.key}
                  label={axis.label}
                  value={lensValue(axis)}
                  options={lensOptions(values.length ? values : [axis.all])}
                  disabled={!axes}
                  onChange={(value) => setLensAxis(axis, value)}
                />
              );
            })}
          </div>
        </section>

        <section className="defaults-group" aria-labelledby="defaults-depth">
          <div className="page-title-row">
            <h3 id="defaults-depth" className="defaults-heading">Explanation depth</h3>
            <HelpTip label="About Explanation depth">
              <p>{DEPTH_HELP}</p>
              {defaults.audience && !defaults.depth ? <p>Set by Reading as. Choose the other to override it.</p> : null}
            </HelpTip>
          </div>
          <SegmentedControl
            size="small"
            label="Explanation depth"
            options={DEPTH_CHOICES}
            value={depthChoice(defaults.depth, defaults.audience)}
            onChange={(depth) => store.setDefaults({ depth: depthToStore(depth, defaults.audience) })}
          />
        </section>

        {populations?.length || defaults.population ? (
          <section className="defaults-group" aria-labelledby="defaults-prevalence">
            <div className="page-title-row">
              <h3 id="defaults-prevalence" className="defaults-heading">Prevalence</h3>
              <HelpTip label="About Prevalence">
                <p>How common each condition is: the default, or a local population. {LOCAL_SYNTHETIC_NOTE}</p>
              </HelpTip>
            </div>
            <div className="defaults-fields">
              <Select
                label="Prevalence set"
                value={defaults.population ?? ''}
                options={prevalenceOptions}
                disabled={!populations}
                onChange={(population) => store.setDefaults({ population: population || null })}
              />
            </div>
          </section>
        ) : null}

        {(ontologies?.length ?? 0) > 1 || defaults.ontology ? (
          <section className="defaults-group" aria-labelledby="defaults-classification">
            <div className="page-title-row">
              <h3 id="defaults-classification" className="defaults-heading">Classification</h3>
              <HelpTip label="About Classification">
                <p>The disease hierarchy the atlas is drawn in. Results are stored in ICD-11; the others show them through a mapping.</p>
              </HelpTip>
            </div>
            <div className="defaults-fields">
              <Select
                label="Classification"
                value={defaults.ontology ?? ''}
                options={ontologyOptions}
                disabled={!ontologies}
                onChange={(ontology) => store.setDefaults({ ontology: ontology || null })}
              />
            </div>
          </section>
        ) : null}

        <section className="defaults-group" aria-labelledby="defaults-about">
          <h3 id="defaults-about" className="defaults-heading">About this copy</h3>
          {instance ? <p className="defaults-about-line">{instance}</p> : null}
          {onOpenGuide ? (
            <button
              type="button"
              className="button-link defaults-guide"
              aria-haspopup="dialog"
              onClick={() => {
                onClose();
                onOpenGuide();
              }}
            >
              {GUIDE_OPEN_CATALOGUE}
            </button>
          ) : null}
        </section>

        <p className="defaults-status" role="status">
          {hasDefaults(defaults)
            ? `${persisted ? 'Saved in this browser' : 'Kept until you close the page (this browser does not allow saving)'}: ${defaultsPhrases(defaults, { models, populations, ontologies }).join('; ')}.`
            : 'No defaults: cards open with all patients, the default prevalence, and plain words.'}
        </p>

        <footer className="defaults-actions">
          {fromView ? (
            <button type="button" className="button-tinted defaults-from-view" onClick={() => store.setDefaults({ card: null, lens: null, depth: null, population: null, ontology: null, ...fromView })}>
              Use what is on screen
            </button>
          ) : null}
          <button type="button" className="button-plain" disabled={!hasDefaults(defaults)} onClick={() => store.clearDefaults()}>
            Clear all
          </button>
          <button type="button" className="button-filled" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </dialog>
  );
}
