import { useEffect, useState } from 'react';
import HelpTip from '../../design/HelpTip.js';
import { useDataClient, useResetDataCache } from '../../api/DataClientProvider.jsx';
import Icon from '../../design/Icon.jsx';
import { instanceLine } from '../../shared/instance.js';
import { ChoiceField, TextAreaField, TextField } from './FormFields.jsx';
import ProblemNotice from './ProblemNotice.jsx';

const KINDS = [
  { value: 'public', label: 'Public service', hint: 'publishes data for everyone and exports public releases.' },
  { value: 'hospital', label: 'Hospital version', hint: 'imports public releases and keeps its own local data.' }
];

// The organisation's own data-protection note (contract v1.14, §26.2).
const NOTE_MAX = 500;

/**
 * The instance profile (CONTRACT.md §26): who runs this copy of
 * the tool. Shown in the header of every page and on the model card. Not a
 * data version, so it changes nothing in History. Since v1.14 it also holds
 * an optional data-protection note, beside the developers' declarations.
 */
export default function InstancePage() {
  const client = useDataClient();
  const resetCache = useResetDataCache();
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client.getMeta({}, { version: 'live' }).then(
      (meta) => {
        const instance = meta.instance ?? { kind: 'public', organisation: '', maintained_by: '', contact: null };
        setSaved(instance);
        setForm({
          kind: instance.kind,
          organisation: instance.organisation,
          maintainedBy: instance.maintained_by,
          contact: instance.contact ?? '',
          dataProtectionNote: instance.data_protection_note ?? ''
        });
      },
      setProblem
    );
  }, [client]);

  if (!form) {
    return (
      <div className="admin-page">
        <header className="admin-page-header">
          <h1 className="admin-title">Instance</h1>
        </header>
        {problem ? <ProblemNotice error={problem} /> : <p className="admin-card-text muted">Loading…</p>}
      </div>
    );
  }
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  const ready = form.organisation.trim() && form.maintainedBy.trim();
  const preview = instanceLine({ kind: form.kind, organisation: form.organisation.trim() || '…', maintained_by: form.maintainedBy.trim() || '…' });
  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const next = await client.updateInstance({
        ...form,
        organisation: form.organisation.trim(),
        maintainedBy: form.maintainedBy.trim(),
        contact: form.contact.trim(),
        dataProtectionNote: form.dataProtectionNote.trim()
      });
      setSaved(next);
      // The header line reads /meta: read it again.
      resetCache();
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  };
  const unchanged =
    saved &&
    saved.kind === form.kind &&
    saved.organisation === form.organisation.trim() &&
    saved.maintained_by === form.maintainedBy.trim() &&
    (saved.contact ?? '') === form.contact.trim() &&
    (saved.data_protection_note ?? '') === form.dataProtectionNote.trim();
  const tooLong = form.dataProtectionNote.trim().length > NOTE_MAX;

  return (
    <div className="admin-page">
      <header className="admin-page-header">
        <div className="page-title-row">
          <h1 className="admin-title">Instance</h1>
          <HelpTip label="About this page">
            <p>Who runs this copy of Broad Modelcard. Settings names it under About this copy, on every page.</p>
          </HelpTip>
        </div>
      </header>
      {problem ? <ProblemNotice error={problem} onDismiss={() => setProblem(null)} /> : null}
      <section className="admin-card" aria-label="Instance profile">
        <div className="record-form">
          <ChoiceField label="Kind" value={form.kind} options={KINDS} onChange={(kind) => set({ kind })} />
          <div className="form-row is-two">
            <TextField label="Organisation" required value={form.organisation} maxLength={120} placeholder="e.g. Northbridge General Hospital (fictional)" onChange={(organisation) => set({ organisation })} />
            <TextField label={form.kind === 'hospital' ? 'Administered by' : 'Maintained by'} required value={form.maintainedBy} maxLength={120} placeholder="e.g. the clinical AI office" onChange={(maintainedBy) => set({ maintainedBy })} />
          </div>
          <TextField label="Contact" optional value={form.contact} maxLength={200} placeholder="e.g. ai-office@northbridge.example" onChange={(contact) => set({ contact })} />
          <TextAreaField
            label="Data-protection note (optional)"
            value={form.dataProtectionNote}
            max={NOTE_MAX}
            rows={3}
            placeholder="e.g. Patient data stays on hospital servers. Questions: the data protection office (fictional)."
            hint="Your organisation's own note on how patient data is handled where these AI systems are used. Shown beside the developers' declarations."
            problem={tooLong ? `At most ${NOTE_MAX} characters.` : null}
            onChange={(dataProtectionNote) => set({ dataProtectionNote })}
          />
        </div>
        <p className="instance-preview">
          <Icon name="info" size={16} className="inline-icon" /> Header: <strong>{preview}</strong>
        </p>
        <div className="form-actions button-row">
          <button type="button" className="button-filled" disabled={!ready || busy || unchanged || tooLong} onClick={save}>
            {busy ? 'Saving…' : unchanged ? 'Saved' : 'Save'}
          </button>
          <span className="field-hint">Not a data version: History does not change.</span>
        </div>
      </section>
    </div>
  );
}
