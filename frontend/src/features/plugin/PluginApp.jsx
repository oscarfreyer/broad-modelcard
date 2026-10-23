import { useEffect, useId, useMemo, useRef, useState } from 'react';
import useClientQuery from '../../api/useClientQuery.js';
import AppHeader from '../../design/AppHeader.jsx';
import HelpTip from '../../design/HelpTip.js';
import Icon from '../../design/Icon.jsx';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import { systemName, systemOptionGroups } from '../../shared/aiSystem.js';
import { displayUseCase } from '../../shared/format.js';
import { scrollBehavior } from '../../shared/motion.js';
import { LENS_CHOICES, MAX_CODES, parseCodes } from '../../embed/panelInputs.js';
import { DEFAULT_CASE, PRESETS, caseFromPreset, codesSettleNow, embedSnippet, lensOptions, matchingPreset, panelAttributes, settingOptions } from './pluginCase.js';
import { settingOfCode } from '../../shared/careSetting.js';
import CdsHooksStage from './CdsHooksStage.jsx';
import { DEFAULT_PREVALENCE } from '../../shared/localPopulation.js';

const EMBED_TEST_PAGE = './embed-test.html';

// Contract v1.14 (§33): the page shows the live panel, or the case as a CDS Hooks request.
const MODE_OPTIONS = [
  { value: 'panel', label: 'Live panel' },
  { value: 'cds', label: 'CDS Hooks request' }
];

const DEPTH_OPTIONS = [
  { value: 'plain', label: 'Plain', title: 'Plain-language explanations' },
  { value: 'expert', label: 'Expert', title: 'Technical detail and safeguard actions' }
];

const LENS_FIELDS = [
  { field: 'age_group', label: 'Age group' },
  { field: 'sex', label: 'Sex' },
  { field: 'ethnicity', label: 'Ethnicity' }
];

const modelsQuery = (client, options) => client.listModels({}, options);

// The codes field passes its text on after a short pause, on a separator, or
// on leaving the field, so a code being typed ("CA40.") is neither flagged
// nor looked up half-way (it would show another condition for a moment).
const CODES_SETTLE_MS = 450;

// Under the dev server the panel script is the source module; `npm run build`
// writes the bundled script that a built app serves (vite.config.js).
const PANEL_SCRIPT = import.meta.env?.DEV ? 'src/embed/index.js' : 'embed/bmc-live-panel.js';

/** Copies the markup and says so for a moment; the markup stays selectable when copying is not allowed. */
function CopyButton({ text }) {
  const [state, setState] = useState('idle');
  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  return (
    <span className="plg-copy">
      <button type="button" className="button-tinted" onClick={copy}>
        <Icon name={state === 'copied' ? 'check' : 'copy'} size={16} />
        {state === 'copied' ? 'Copied' : 'Copy the markup'}
      </button>
      <span className="plg-copy-status" role="status">
        {state === 'failed' ? 'This browser did not allow copying. Select the markup and copy it.' : ''}
      </span>
    </span>
  );
}

function SelectField({ label, value, onChange, children, disabled = false }) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <span className="select-wrap">
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
          {children}
        </select>
        <Icon name="chevronDown" size={14} className="select-chevron" />
      </span>
    </div>
  );
}

function functionsOf(entry) {
  return (entry?.use_cases || []).map((useCase) => (typeof useCase === 'string' ? useCase : useCase.use_case));
}

/** The case words the simulated host shows: codes, population, and care setting, nothing else. */
function caseLine(codes, lens, setting = null) {
  const groups = LENS_FIELDS.map(({ field }) => LENS_CHOICES[field][lens[field]]).filter(Boolean);
  return [codes.join(' + ') || 'No condition codes', groups.length ? groups.join(', ') : 'All patients', settingOfCode(setting)].filter(Boolean).join('; ');
}

/**
 * The in-app demo of the live interaction plugin: pick a
 * card and a synthetic case and watch <bmc-live-panel> beside a simulated AI
 * output, exactly as a host application would place it.
 */
export default function PluginApp() {
  const [current, setCurrent] = useState(() => ({ ...DEFAULT_CASE, lens: { ...DEFAULT_CASE.lens } }));
  const [mode, setMode] = useState('panel');
  // What the codes field shows; `current.codesText` follows it once it settles.
  const [codesDraft, setCodesDraft] = useState(current.codesText);
  const settleRef = useRef(null);
  const panelRef = useRef(null);
  useEffect(() => () => clearTimeout(settleRef.current), []);
  const codesId = useId();
  const codesHintId = useId();
  const codesHelpId = useId();
  const { data: registry, error: registryError, retry } = useClientQuery('plugin|models', modelsQuery);
  // The local populations a case can be looked up for (the atlas's Prevalence choice).
  const populations = useClientQuery('meta', (client, options) => client.getMeta({}, options)).data?.populations ?? [];

  const entries = registry?.models ?? [];
  const entry = entries.find((model) => model.model_version === current.model) ?? null;
  const functions = functionsOf(entry);
  const parsed = useMemo(() => parseCodes(current.codesText), [current.codesText]);
  const preset = matchingPreset(current);
  const attributes = panelAttributes(current);
  const snippet = embedSnippet(current, new URL(PANEL_SCRIPT, window.location.href).href);

  const update = (patch) => setCurrent((previous) => ({ ...previous, ...patch }));
  const commitCodes = (text) => {
    clearTimeout(settleRef.current);
    update({ codesText: text });
  };
  const typeCodes = (text) => {
    setCodesDraft(text);
    clearTimeout(settleRef.current);
    if (codesSettleNow(text)) {
      update({ codesText: text });
    } else {
      settleRef.current = setTimeout(() => update({ codesText: text }), CODES_SETTLE_MS);
    }
  };
  const choosePreset = (item) => {
    const next = caseFromPreset(item, current.depth, current.population);
    clearTimeout(settleRef.current);
    setCodesDraft(next.codesText);
    setCurrent(next);
    // On a narrow screen the panel sits far below the presets: bring it into view (under the sticky header).
    if (window.matchMedia?.('(max-width: 900px)').matches) {
      panelRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    }
  };
  const setLens = (field, value) => setCurrent((previous) => ({ ...previous, lens: { ...previous.lens, [field]: value || null } }));
  const chooseSystem = (modelVersion) => {
    const next = entries.find((model) => model.model_version === modelVersion);
    const nextFunctions = functionsOf(next);
    update({ model: modelVersion, useCase: nextFunctions.includes(next?.default_use_case) ? next.default_use_case : nextFunctions[0] ?? '' });
  };

  return (
    <div className="plg-shell">
      <AppHeader current="plugin" />

      <main className="plg-main">
        <div className="plg-intro">
          <div className="page-title-row">
            <h1 className="plg-title">Live interaction</h1>
            <HelpTip label="About this page">
              <p>
                While someone works with an AI system on a case, a small panel beside the AI system’s output shows where that case sits on its card:
                the result for the case’s conditions and population, the top warnings and safeguards, and open safety incidents, from the current data.
              </p>
            </HelpTip>
          </div>
          <div className="plg-band" role="note">
            <Icon name="warning" size={20} />
            <div>
              <p className="plg-band-title">Demonstration on synthetic data, not for clinical use</p>
              <p className="plg-band-text">
                Do not enter real patient data. This page takes ICD-11 codes and coarse population groups only, and nothing you choose here is
                stored.
              </p>
            </div>
          </div>
        </div>

        <div className="plg-workspace">
          <section className="plg-setup" aria-labelledby="plg-setup-title">
            <h2 id="plg-setup-title" className="plg-section-title">
              Case
            </h2>

            <div className="plg-group">
              <h3 className="plg-group-title">Synthetic cases</h3>
              <ul className="plg-presets">
                {PRESETS.map((item) => {
                  const isActive = preset?.id === item.id;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`plg-preset${isActive ? ' is-active' : ''}`}
                        aria-pressed={isActive}
                        onClick={() => choosePreset(item)}
                      >
                        <span className="plg-preset-title">{item.title}</span>
                        <span className="plg-preset-note">{item.note}</span>
                        <span className="plg-preset-note is-system">{systemName(entries.find((model) => model.model_version === item.model) ?? {}, item.model)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="plg-group">
              <h3 className="plg-group-title">Card</h3>
              {registryError ? (
                <p className="plg-error" role="alert">
                  The AI systems could not be loaded. {registryError.code === 'backend_unavailable' ? 'Start the app with npm run dev.' : ''}{' '}
                  <button type="button" className="button-plain" onClick={retry}>
                    Try again
                  </button>
                </p>
              ) : null}
              <SelectField label="AI system" value={current.model} onChange={chooseSystem} disabled={!entries.length}>
                {entries.length ? null : <option value={current.model}>{current.model}</option>}
                {systemOptionGroups(entries).map((group) =>
                  group.label ? (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : (
                    group.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))
                  )
                )}
              </SelectField>
              <SelectField label="Function" value={current.useCase} onChange={(value) => update({ useCase: value })} disabled={!functions.length}>
                {(functions.length ? functions : [current.useCase]).map((name) => (
                  <option key={name} value={name}>
                    {displayUseCase(name)}
                  </option>
                ))}
              </SelectField>
            </div>

            <div className="plg-group">
              <h3 className="plg-group-title">Conditions</h3>
              <div className="field">
                <span className="field-label-row">
                  <label className="field-label" htmlFor={codesId}>
                    {mode === 'cds' ? 'Condition codes' : 'ICD-11 codes'}
                  </label>
                  <HelpTip label="About the codes" bubbleId={codesHelpId}>
                    <p>
                      {mode === 'cds'
                        ? 'ICD-11 or ICD-10-CM codes, separated by commas; choose which beside the request.'
                        : `Up to ${MAX_CODES} codes, separated by commas. Two or more show a stored combination when the card has one.`}
                    </p>
                  </HelpTip>
                </span>
                <input
                  id={codesId}
                  className="plg-input"
                  value={codesDraft}
                  onChange={(event) => typeCodes(event.target.value.slice(0, 120))}
                  onBlur={() => commitCodes(codesDraft)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitCodes(codesDraft);
                  }}
                  placeholder="5A11, GB61"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={[codesHelpId, mode === 'panel' && parsed.ignored ? codesHintId : null].filter(Boolean).join(' ')}
                  aria-invalid={mode === 'panel' && parsed.ignored > 0}
                />
                {/* Entries left out are state, so they stay in view; how to type codes is the label's help. */}
                <p id={codesHintId} className="plg-hint is-warning" aria-live="polite">
                  {mode === 'panel' && parsed.ignored
                    ? `${parsed.ignored} ${parsed.ignored === 1 ? 'entry is' : 'entries are'} not used: only ICD-11 codes such as 5A11 or CA40.0, at most ${MAX_CODES}.`
                    : null}
                </p>
              </div>
            </div>

            <div className="plg-group">
              <h3 className="plg-group-title">Population</h3>
              <div className="plg-lens">
                {LENS_FIELDS.map(({ field, label }) => (
                  <SelectField key={field} label={label} value={current.lens[field] ?? ''} onChange={(value) => setLens(field, value)}>
                    {lensOptions(field).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </SelectField>
                ))}
              </div>
              {/* The care setting (contract v1.14, §29): a result measured in that setting only; any setting by default. */}
              <SelectField label="Setting" value={current.setting ?? ''} onChange={(value) => update({ setting: value || null })}>
                {settingOptions().map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </SelectField>
              {populations.length ? (
                <SelectField label="Prevalence" value={current.population ?? ''} onChange={(value) => update({ population: value || null })}>
                  <option value="">{DEFAULT_PREVALENCE}</option>
                  {populations.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </SelectField>
              ) : null}
            </div>

            <div className="plg-group">
              <h3 className="plg-group-title">Explanation</h3>
              <SegmentedControl label="Explanation depth" options={DEPTH_OPTIONS} value={current.depth} onChange={(depth) => update({ depth })} />
            </div>
          </section>

          <div className="plg-stage">
            <SegmentedControl label="Show" options={MODE_OPTIONS} value={mode} onChange={setMode} className="plg-mode" />
            {mode === 'cds' ? (
              <CdsHooksStage
                current={current}
                codesText={current.codesText}
                onCodesText={(text) => {
                  setCodesDraft(text);
                  commitCodes(text);
                }}
              />
            ) : (
              <>
                <section className="plg-host" aria-label="Simulated host application">
                  <div className="plg-host-bar page-title-row">
                    <p>Host application (simulated)</p>
                    <HelpTip label="About the simulated host">
                      <p>
                        This is where the host application would show its AI system’s answer for the case. It is simulated here: Broad Modelcard does
                        not produce or check that answer.
                      </p>
                      <p>
                        The panel beside it is the real component. It reads the case’s codes and population, looks them up on this AI system’s card, and
                        updates when the case changes or a new dataset version is published.
                      </p>
                    </HelpTip>
                  </div>
                  <div className="plg-host-body">
                    <article className="plg-output" aria-labelledby="plg-output-title">
                      <h2 id="plg-output-title" className="plg-output-title">
                        {entry ? systemName(entry) : current.model}
                      </h2>
                      <p className="plg-output-function">{displayUseCase(current.useCase)}</p>
                      <p className="plg-output-case">
                        <span className="plg-output-label">Case</span>
                        {caseLine(parsed.codes, current.lens, current.setting)}
                      </p>
                    </article>
                    <div className="plg-panel-slot" ref={panelRef}>
                      <bmc-live-panel
                        model={attributes.model}
                        use-case={attributes['use-case']}
                        codes={attributes.codes}
                        age-group={attributes['age-group']}
                        sex={attributes.sex}
                        ethnicity={attributes.ethnicity}
                        setting={attributes.setting}
                        population={attributes.population}
                        depth={attributes.depth}
                      />
                    </div>
                  </div>
                </section>
    
                <section className="plg-embed" aria-labelledby="plg-embed-title">
                  <div className="page-title-row">
                    <h2 id="plg-embed-title" className="plg-section-title">
                      Embed it
                    </h2>
                    <HelpTip label="About embedding">
                      <p>
                        A host page loads one script and places the element next to its AI output. The panel brings its own styles, accepts codes and
                        coarse population groups only, and always says it is a demonstration.
                      </p>
                      <p>
                        It works only in pages this app serves on this machine: the Broad Modelcard API answers local, same-origin requests only. Under{' '}
                        <code>npm run dev</code> the script is the source module, as below; a built app (<code>npm run build</code>) serves the bundled
                        script at <code>embed/bmc-live-panel.js</code>.
                      </p>
                    </HelpTip>
                  </div>
                  <pre className="plg-snippet" tabIndex={0} aria-label="Markup for the panel">
                    <code>{snippet}</code>
                  </pre>
                  <div className="plg-embed-actions">
                    <CopyButton text={snippet} />
                    <a className="button-plain plg-embed-link" href={EMBED_TEST_PAGE}>
                      Open the plain test page
                      <Icon name="externalLink" size={16} />
                    </a>
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
