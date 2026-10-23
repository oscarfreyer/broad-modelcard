import EffectForm from './EffectForm.jsx';
import { emptyEffect, storedEffectForm } from './effects.js';
import { revealAndFocus } from './focus.js';
import IncidentForm from './IncidentForm.jsx';
import IncidentList from './IncidentList.jsx';
import MetricRowForm from './MetricRowForm.jsx';
import { emptyIncident, emptyMetricRow, storedIncidentForm } from './records.js';
import StoredRecordList from './StoredRecordList.jsx';
import StudyForm from './StudyForm.jsx';
import { emptyStudy, storedStudyForm } from './studies.js';

/** Edit in a stored list fills the form; the focus moves to the form's "Editing …" line. */
const focusEditingNotice = () => revealAndFocus('.editing-notice .admin-notice-title');

const cardOf = (form, fallback = null) => (form.model ? { model: form.model, useCase: form.useCase } : fallback);

/**
 * The data set's one-record entry in step 2 (Enter the update): for safety
 * incidents, studies, and effects the stored records with Edit, then the
 * form; for performance metrics and local results the one-row form of the
 * page's card. The form state lives with the page (DatasetPage), so it stays
 * filled while the maintainer fixes what the check finds. Null where the data
 * set has no form, or before what it needs has loaded.
 *
 * @param {object} props
 * @param {object} props.dataset DATASETS entry
 * @param {object[]|null} props.models live registry
 * @param {object|null} props.meta getMeta()
 * @param {object|null} props.target the page's card (metrics rows)
 * @param {object|null} props.pickedTarget the card in the URL
 * @param {object|null} props.card the card the page's preview uses
 * @param {object} props.forms { incident, study, effect, metricRow } and their setters
 * @param {{ data: object[]|null, error: Error|null, retry: () => void }} props.studies the stored studies, read once by the page
 * @param {{ data: object[]|null, error: Error|null, retry: () => void }} props.effects the stored effects, read once by the page
 * @param {string[]|null} props.storedIncidentIds every stored incident's ID
 * @param {string|number} props.refreshKey the version the lists read
 */
export default function RecordFormSection({
  dataset,
  models,
  meta,
  target,
  pickedTarget,
  card,
  forms,
  studies,
  effects,
  storedIncidentIds,
  refreshKey,
  hasWaitingUpdate,
  hasIntendedUse,
  isSending,
  onSubmit
}) {
  const { incident, setIncident, study, setStudy, effect, setEffect, metricRow, setMetricRow } = forms;
  if (dataset.recordForm === 'incident' && models?.length) {
    return (
      <>
        <IncidentList
          card={cardOf(incident, pickedTarget)}
          models={models}
          meta={meta}
          refreshKey={refreshKey}
          editingId={incident.editing?.id === incident.incidentId ? incident.editing.id : null}
          hasWaitingUpdate={hasWaitingUpdate}
          onEdit={(stored) => {
            setIncident(storedIncidentForm(stored));
            focusEditingNotice();
          }}
        />
        <IncidentForm
          form={incident}
          onChange={setIncident}
          models={models}
          meta={meta}
          onSubmit={onSubmit}
          isBusy={isSending}
          storedIds={storedIncidentIds}
          onReset={() => setIncident(emptyIncident({ card: cardOf(incident, card) }))}
        />
      </>
    );
  }
  if (dataset.recordForm === 'study' && models) {
    return (
      <>
        <StoredRecordList
          kind="studies"
          records={studies.data}
          error={studies.error}
          onRetry={studies.retry}
          editingId={study.editing?.id === study.studyId ? study.editing.id : null}
          hasWaitingUpdate={hasWaitingUpdate}
          onEdit={(stored) => {
            setStudy(storedStudyForm(stored));
            focusEditingNotice();
          }}
        />
        <StudyForm
          form={study}
          onChange={setStudy}
          models={models}
          meta={meta}
          onSubmit={onSubmit}
          isBusy={isSending}
          storedIds={studies.data ? studies.data.map((entry) => entry.study_id) : null}
          onReset={() => setStudy(emptyStudy())}
        />
      </>
    );
  }
  if (dataset.recordForm === 'effect' && models) {
    return (
      <>
        <StoredRecordList
          kind="effects"
          records={effects.data}
          error={effects.error}
          onRetry={effects.retry}
          editingId={effect.editing?.id === effect.effectId ? effect.editing.id : null}
          hasWaitingUpdate={hasWaitingUpdate}
          onEdit={(stored) => {
            setEffect(storedEffectForm(stored, meta?.chapters ?? []));
            focusEditingNotice();
          }}
        />
        <EffectForm
          form={effect}
          onChange={setEffect}
          models={models}
          meta={meta}
          studies={studies.data}
          onSubmit={onSubmit}
          isBusy={isSending}
          storedIds={effects.data ? effects.data.map((entry) => entry.effect_id) : null}
          onReset={() => setEffect(emptyEffect({ card: cardOf(effect) }))}
        />
      </>
    );
  }
  if (dataset.recordForm === 'metricRow' && target) {
    return (
      <MetricRowForm
        form={metricRow}
        onChange={setMetricRow}
        target={target}
        meta={meta}
        hasIntendedUse={hasIntendedUse}
        onSubmit={onSubmit}
        isBusy={isSending}
        onReset={() => setMetricRow(emptyMetricRow())}
      />
    );
  }
  return null;
}
