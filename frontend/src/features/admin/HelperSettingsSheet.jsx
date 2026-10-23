import { useId, useRef, useState } from 'react';
import Icon from '../../design/Icon.jsx';
import {
  DEFAULT_HOSTED_MODEL,
  HELPER_NAME,
  LOCAL_URL_EXAMPLE,
  PROVIDER_WORDS,
  describeAssistProblem,
  keyLeftBehind,
  keyStaysWith,
  settingsForm,
  settingsProblems
} from './assist.js';
import { TextField } from './FormFields.jsx';
import ProblemNotice from './ProblemNotice.jsx';
import Sheet from './Sheet.jsx';

/**
 * The API key as a write-only field. React never holds the key: the input is
 * uncontrolled, the sheet reads it once on Save through `inputRef`, sends it,
 * and empties the input. A stored key is never shown back; the field turns
 * into "A key is set" with Replace and Remove.
 */
export function KeyField({ inputRef, keyKept, isReplacing, onReplace, onKeep, onRemove, optional = false, problem = null, isBusy = false }) {
  const id = useId();
  const hintId = useId();
  const problemId = useId();
  const [isRemoving, setIsRemoving] = useState(false);
  if (keyKept && !isReplacing) {
    return (
      <div className="field key-field">
        <span className="field-label">API key</span>
        <div className="key-set-row">
          <Icon name="shield" size={18} className="key-set-icon" />
          <span className="key-set-text">A key is set</span>
          {isRemoving ? (
            <span className="discard-confirm" role="group" aria-label="Remove the key?">
              <span>Remove the key? The helper turns off.</span>
              <button type="button" className="button-plain is-destructive" disabled={isBusy} onClick={onRemove}>
                Remove
              </button>
              <button type="button" className="button-plain" onClick={() => setIsRemoving(false)}>
                Keep
              </button>
            </span>
          ) : (
            <span className="key-set-actions">
              <button type="button" className="button-plain" onClick={onReplace}>
                Replace
              </button>
              <button type="button" className="button-plain" onClick={() => setIsRemoving(true)}>
                Remove
              </button>
            </span>
          )}
        </div>
        <p className="field-hint">It stays in a file on this computer, readable only by you, and is never shown again.</p>
      </div>
    );
  }
  return (
    <div className="field key-field">
      <label className="field-label" htmlFor={id}>
        {keyKept ? 'New API key' : 'API key'}
        {optional ? <span className="field-optional"> (optional)</span> : null}
      </label>
      <input
        ref={inputRef}
        id={id}
        className="text-input"
        type="password"
        name="assist-api-key"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        aria-invalid={problem ? true : undefined}
        aria-describedby={[hintId, problem ? problemId : null].filter(Boolean).join(' ')}
      />
      <p className="field-hint" id={hintId}>
        Sent once when you save, then kept in a file on this computer and never shown again. The field empties after saving.
      </p>
      {problem ? (
        <p className="field-problem" id={problemId}>
          {problem}
        </p>
      ) : null}
      {keyKept ? (
        <div className="button-row">
          <button type="button" className="button-plain" onClick={onKeep}>
            Keep the current key
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The study helper's settings: provider, model, address, and key. Saving
 * calls configureAssist; Remove and "Turn the helper off" call clearAssist.
 *
 * @param {object} props
 * @param {ReturnType<import('./useAssist.js').default>} props.assist
 */
export default function HelperSettingsSheet({ assist }) {
  const { status } = assist;
  const formId = useId();
  const providerName = useId();
  const keyRef = useRef(null);
  const [form, setForm] = useState(() => settingsForm(status));
  const [isReplacing, setIsReplacing] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [isTurningOff, setIsTurningOff] = useState(false);
  // A stored key stays only with the provider and address it was saved for.
  const keyKept = keyStaysWith(status, form);
  const addressChanged = keyLeftBehind(status, form);
  const problems = settingsProblems(form, { keyTyped: true, keyKept });
  const shown = showProblems ? problems : {};
  const [keyProblem, setKeyProblem] = useState(null);
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  const isBusy = Boolean(assist.busy);

  const submit = async (event) => {
    event.preventDefault();
    // Read the key once, then empty the field: it is never kept in state.
    const input = keyRef.current;
    const apiKey = input ? input.value.trim() : '';
    if (input) input.value = '';
    const missing = settingsProblems(form, { keyTyped: Boolean(apiKey), keyKept, addressChanged });
    setKeyProblem(missing.apiKey ?? null);
    if (Object.keys(missing).length) {
      setShowProblems(true);
      return;
    }
    const saved = await assist.save(form, apiKey);
    if (saved) {
      assist.close();
    } else if (apiKey && input) {
      setKeyProblem('For safety the field was emptied. Type the key again to save it.');
    }
  };

  const turnOff = async () => {
    if (await assist.turnOff()) {
      setForm((current) => ({ ...settingsForm(null), provider: current.provider }));
      setIsReplacing(false);
      setIsTurningOff(false);
      // Off is done: the sheet closes and the sidebar row says "Off" (S8: focus was left on the page).
      assist.close();
    }
  };

  return (
    <Sheet
      title={HELPER_NAME}
      onClose={assist.close}
      isBusy={isBusy}
      fallbackFocus=".sidebar-button"
      actions={
        <>
          <button type="button" className="button-plain" onClick={assist.close} disabled={isBusy}>
            Cancel
          </button>
          <button type="submit" form={formId} className="button-filled" disabled={isBusy}>
            {assist.busy === 'saving' ? 'Saving…' : status?.enabled ? 'Save' : 'Turn on'}
          </button>
        </>
      }
    >
      <form id={formId} className="helper-settings" noValidate onSubmit={submit} aria-label="Study helper settings">
        <p className="step-text">
          The helper reads one study and proposes rows or incidents with their sources. You check every value; it never stages
          or publishes anything by itself. {status?.enabled ? `It is on, using the ${PROVIDER_WORDS[status.provider]?.short} ${status.model}.` : 'It is off.'}
        </p>
        <fieldset className="mode-choice" disabled={isBusy}>
          <legend className="step-subtitle">Which model reads the studies?</legend>
          {['hosted', 'local'].map((provider) => (
            <label key={provider} className={`mode-option${form.provider === provider ? ' is-chosen' : ''}`}>
              <input
                type="radio"
                name={providerName}
                value={provider}
                checked={form.provider === provider}
                onChange={() => {
                  setIsReplacing(false);
                  setKeyProblem(null);
                  set({ provider, ...(status?.enabled && status.provider === provider ? settingsForm(status) : { model: '', baseUrl: '' }) });
                }}
              />
              <span className="mode-option-text">
                <span className="mode-option-title">{PROVIDER_WORDS[provider].title}</span>
                <span className="mode-option-help">{PROVIDER_WORDS[provider].help}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {form.provider === 'local' ? (
          <>
            <TextField
              label="Base URL"
              value={form.baseUrl}
              placeholder={LOCAL_URL_EXAMPLE}
              hint="The address of its OpenAI-compatible API on this computer."
              problem={shown.baseUrl ?? null}
              onChange={(baseUrl) => set({ baseUrl })}
            />
            <TextField label="Model" value={form.model} placeholder="e.g. llama3.1:8b" problem={shown.model ?? null} onChange={(model) => set({ model })} />
          </>
        ) : (
          <>
            <TextField
              label="Model"
              value={form.model}
              placeholder={DEFAULT_HOSTED_MODEL}
              optional
              hint={`Leave empty for ${DEFAULT_HOSTED_MODEL}.`}
              onChange={(model) => set({ model })}
            />
            <TextField
              label="Gateway URL"
              value={form.baseUrl}
              placeholder="https://…"
              optional
              hint="Only when your organisation routes the API through its own gateway."
              onChange={(baseUrl) => set({ baseUrl })}
            />
          </>
        )}
        {status?.enabled && status.provider !== form.provider ? (
          <p className="field-hint">
            Saving switches the helper to this model{status.key_set ? ' and deletes the key stored for the other one' : ''}.
          </p>
        ) : null}
        {addressChanged ? (
          <p className="field-hint key-address-hint" role="status">
            {form.provider === 'hosted'
              ? 'The address changed, so enter the API key again. A stored key is only sent to the address it was saved for.'
              : 'The address changed, so the stored key is not sent there. Enter it again if this server needs one; otherwise it is deleted when you save.'}
          </p>
        ) : null}
        <KeyField
          inputRef={keyRef}
          keyKept={keyKept}
          isReplacing={isReplacing}
          onReplace={() => setIsReplacing(true)}
          onKeep={() => {
            setIsReplacing(false);
            setKeyProblem(null);
          }}
          onRemove={turnOff}
          optional={form.provider === 'local'}
          problem={keyProblem}
          isBusy={isBusy}
        />

        {status?.privacy ? (
          <div className="helper-privacy">
            <h3 className="step-subtitle">What leaves this computer</h3>
            <p className="step-text">{status.privacy}</p>
          </div>
        ) : null}

        {assist.problem ? <ProblemNotice error={assist.problem} describe={describeAssistProblem} onDismiss={assist.clearProblem} /> : null}

        {status?.enabled ? (
          <div className="button-row helper-off-row">
            {isTurningOff ? (
              <span className="discard-confirm" role="group" aria-label="Turn the helper off?">
                <span>Turn the helper off and delete its settings{status.key_set ? ' and key' : ''}?</span>
                <button type="button" className="button-plain is-destructive" disabled={isBusy} onClick={turnOff}>
                  Turn off
                </button>
                <button type="button" className="button-plain keep-on" onClick={() => setIsTurningOff(false)}>
                  Keep it on
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="button-plain"
                onClick={() => {
                  setIsTurningOff(true);
                  // The confirm replaces this button: the focus goes to its safe choice (S8).
                  window.setTimeout(() => document.querySelector('.helper-off-row .keep-on')?.focus(), 0);
                }}
              >
                Turn the helper off
              </button>
            )}
          </div>
        ) : null}
      </form>
    </Sheet>
  );
}
