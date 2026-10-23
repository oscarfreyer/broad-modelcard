// Per-condition card export (JSON and PDF), built from the contract's
// ConceptExport plus the frontend-owned warning and safeguard copy. The
// export operation carries no incidents (CONTRACT.md §14), so the card's
// safety incidents come from the concept read on screen (getConceptMetrics,
// same AI system, function, lens, and version) and are listed in both files.
// The same read supplies the effects on outcomes (contract v1.13, §27) and,
// under a local population, the public result beside a local one (§26.1);
// the study appraisal (§22) comes with the export's own row. The JSON keeps
// the contract's `model_card` key for the row; the files are named and
// titled "condition card", so they never read as the AI system's Model card.
import { exportIncidents } from './copy/incidentCopy.js';
import { presentedSafeguards, presentedWarnings } from './copy/emptyRollup.js';
import { describeSafeguards } from './copy/safeguardCopy.js';
import { rankWarnings, warningScope } from './copy/warningCopy.js';
import { summarizeMetricRow } from './modelCardSummary.js';
import { validationTypeLabel } from '../../shared/metricLabels.js';
import { downloadJson } from '../../shared/download.js';
import { displayUseCase, formatPopulation, slugify } from '../../shared/format.js';
import { localPrevalenceNotice, prevalenceExportText } from '../../shared/localPopulation.js';
import { resultPopulationLabel, resultPopulationSlug } from '../../shared/resultPopulation.js';
import { mappingSentence, mappingSourceAttribution, ontologyAttribution, ontologyNotice } from '../../shared/ontology.js';
import {
  APPLICABILITY_LABELS,
  CONDUCTOR_LABELS,
  DESIGN_LABELS,
  RISK_OF_BIAS_LABELS,
  SETTING_CATEGORY_LABELS,
  appraisalToolValue,
  guidelineValue,
  studySentence
} from './copy/studyCopy.js';
import { EFFECTS_NOT_GRADED, appraisalLine, effectNumbers, effectSentence, studyLine } from './copy/effectCopy.js';

/**
 * How a linked study entered the row's evidence grade (contract v1.13, §22),
 * or null when no study does: the study in words and codes, the change to the
 * evidence signal, and, for a stored row, the signal's terms.
 */
export function exportAppraisal(appraisal) {
  if (!appraisal) {
    return null;
  }
  const study = appraisal.study;
  return {
    study: study
      ? {
          study_id: study.study_id,
          title: study.title,
          summary: studySentence(study),
          design: DESIGN_LABELS[study.design] ?? study.design,
          setting: study.setting ?? null,
          sites: study.sites ?? null,
          patients: study.patients ?? null,
          peer_reviewed: study.peer_reviewed ?? null,
          conducted_by: CONDUCTOR_LABELS[study.conducted_by] ?? study.conducted_by,
          reporting_guideline: guidelineValue(study),
          risk_of_bias: RISK_OF_BIAS_LABELS[study.risk_of_bias] ?? study.risk_of_bias,
          risk_of_bias_notes: study.risk_of_bias_notes ?? null,
          population: study.population ?? null,
          evaluation_conditions: study.evaluation_conditions ?? null,
          model_version: study.model_version ?? null,
          publication_date: study.publication_date ?? null,
          scope: study.scope ?? 'public',
          // Contract v1.14 (§22): only when the study states them; never graded.
          ...(study.applicability ? { applicability_concerns: APPLICABILITY_LABELS[study.applicability] ?? study.applicability } : {}),
          ...(study.applicability_notes ? { applicability_notes: study.applicability_notes } : {}),
          ...(study.quality_tool ? { appraisal_tool: appraisalToolValue(study) } : {}),
          ...(study.setting_category ? { setting_category: SETTING_CATEGORY_LABELS[study.setting_category] ?? study.setting_category } : {}),
          ...(study.configuration_id ? { configuration_evaluated: study.configuration_id } : {})
        }
      : null,
    evidence_signal_adjustment: appraisal.study_adjustment,
    applied: appraisal.applied,
    terms: appraisal.terms ?? null
  };
}

/** The effects on outcomes of the card at this concept (contract v1.13, §27), never graded. */
export function exportEffects(effects = []) {
  return (effects ?? []).map((effect) => ({
    effect_id: effect.effect_id,
    outcome: effect.outcome,
    outcome_type: effect.outcome_type,
    summary: effectSentence(effect),
    estimate: effectNumbers(effect),
    values: { measure: effect.effect_measure, estimate: effect.estimate, ci_low: effect.ci_low, ci_high: effect.ci_high, unit: effect.unit ?? null, direction: effect.direction },
    comparator: effect.comparator,
    population: effect.population,
    follow_up: effect.follow_up ?? null,
    risk_of_bias: appraisalLine(effect),
    study_id: effect.study_id,
    study: studyLine(effect)
  }));
}

export const LOCAL_RESULT_NOTE = 'The hospital’s own evaluation for this local population, in place of the public result. Synthetic demonstration data.';

/** A row's values for the export: the figures the card shows, with the row's source. */
function rowValues(row) {
  return {
    performance_value: Number.isFinite(row?.perf) ? row.perf : null,
    confidence_interval: Number.isFinite(row?.ci_low) && Number.isFinite(row?.ci_high) ? { low: row.ci_low, high: row.ci_high } : null,
    validation_type: validationTypeLabel(row?.validation_type),
    studies: Number.isFinite(row?.n_studies) ? row.n_studies : null,
    peer_reviewed_studies: Number.isFinite(row?.peer_reviewed_studies) ? row.peer_reviewed_studies : null,
    samples: Number.isFinite(row?.n_samples) ? row.n_samples : null,
    sites: Number.isFinite(row?.n_sites) ? row.n_sites : null,
    intended_use_coverage: Number.isFinite(row?.intended_use_coverage) ? row.intended_use_coverage : null,
    // Where the stored row comes from (v1.7); null for aggregated rows.
    data_source: row?.provenance?.data_source ?? null
  };
}

/**
 * A local result and the public one it replaces (contract v1.13, §26.1), or
 * null when the row is public.
 */
export function exportLocalResult(row, publicMetrics, { hasIntendedUse = true } = {}) {
  if (row?.provenance?.layer !== 'local') {
    return null;
  }
  const publicSummary = publicMetrics ? summarizeMetricRow(publicMetrics, { hasIntendedUse }) : null;
  return {
    note: LOCAL_RESULT_NOTE,
    public_result: publicSummary
      ? {
          overall: publicSummary.overallGrade,
          performance: publicSummary.performanceGrade,
          evidence: publicSummary.evidenceGrade,
          statuses: publicSummary.statuses,
          details: rowValues(publicMetrics)
        }
      : null
  };
}

/**
 * The downloadable condition card for a ConceptExport.
 *
 * @param {object} conceptExport contract ConceptExport
 * @param {object} [extra] from the condition card's own read (getConceptMetrics, same filters):
 * @param {object[]} [extra.incidents] contract SafetyIncident[] of the concept at this lens
 * @param {object[]} [extra.effects] contract Effect[]
 * @param {{ id: string, name: string }|null} [extra.population] the local population of the read (contract v1.10; default: the export's own)
 * @param {boolean} [extra.hasIntendedUse] the card states an intended use (contract v1.11; default true)
 * @param {object|null} [extra.publicMetrics] the public row beside a local one (`public_metrics`, §26.1)
 * @param {object|null} [extra.ontologyEntry] the `/meta.ontologies` entry of another classification, for its attribution
 */
export function buildConceptCardFile(
  conceptExport,
  { incidents = [], effects = [], population = conceptExport.population ?? null, hasIntendedUse = true, publicMetrics = null, ontologyEntry = null } = {}
) {
  const row = conceptExport.model_card ?? null;
  const summary = summarizeMetricRow(row, { hasIntendedUse });
  const localResult = exportLocalResult(row, publicMetrics, { hasIntendedUse });
  const appraisal = exportAppraisal(row?.appraisal);
  const effectRecords = exportEffects(effects);
  const { concept, context } = conceptExport;
  return {
    exported_at: conceptExport.exported_at,
    audience_view: conceptExport.audience_view,
    concept: {
      code: concept.code || 'Not available',
      block: concept.block || 'Not assigned',
      name: concept.name,
      hierarchy: concept.hierarchy?.length ? concept.hierarchy : [concept.name],
      // Another classification (contract v1.13): which one, and the ICD-11 result the concept shows.
      ...(conceptExport.ontology
        ? {
            classification: {
              id: conceptExport.ontology.id,
              name: conceptExport.ontology.name,
              note: ontologyNotice(conceptExport.ontology),
              mapping: mappingSentence(concept.mapping, conceptExport.ontology.name),
              crosswalk: concept.mapping ?? null,
              // Who to credit: the classification and the WHO mapping tables (used unmodified).
              attribution: [ontologyAttribution(ontologyEntry), mappingSourceAttribution(ontologyEntry)].filter(Boolean).join(' ') || null
            }
          }
        : {})
    },
    context: {
      model: context.model || 'Not available',
      use_case: context.use_case ? displayUseCase(context.use_case) : 'Not available',
      population: formatPopulation(context.population),
      // Who the result is for, as the card names it: lens and prevalence.
      shown_for: resultPopulationLabel(context.population, population, { ontology: conceptExport.ontology ?? null, setting: context.setting ?? null }),
      // A specific care setting (contract v1.14, §29), only when one was read.
      ...(context.setting ? { setting: context.setting } : {}),
      // Only under a local population (contract v1.10): which one, and that it is synthetic.
      ...(population?.id
        ? { local_population: { id: population.id, name: population.name, prevalence: prevalenceExportText(population), note: localPrevalenceNotice(population) } }
        : {})
    },
    model_card: {
      overall: summary.overallGrade,
      performance: summary.performanceGrade,
      evidence: summary.evidenceGrade,
      intended_use: summary.intendedUse,
      details: rowValues(row),
      // The status words the interface shows, beside the raw grades.
      statuses: summary.statuses
    },
    // Only when a study enters the grade, and only when the card has effects here: other files are unchanged.
    ...(localResult ? { local_result: localResult } : {}),
    ...(appraisal ? { study_appraisal: appraisal } : {}),
    ...(effectRecords.length ? { effects_on_outcomes: { note: EFFECTS_NOT_GRADED, effects: effectRecords } } : {}),
    warnings: rankWarnings(presentedWarnings(row, conceptExport.warnings)).map((warning) => ({
      relevance: warning.relevance,
      title: warning.title,
      applies_to: warningScope(warning, row?.provenance?.source),
      summary: warning.patientSummary,
      technical_summary: warning.expertSummary,
      details: warning.detail
    })),
    safety_incidents: exportIncidents(incidents),
    recommended_safeguards: describeSafeguards(presentedSafeguards(row, conceptExport.safeguards)).map((safeguard) => ({
      priority: safeguard.priority,
      title: safeguard.title,
      summary: safeguard.patientSummary,
      technical_summary: safeguard.expertSummary,
      actions: safeguard.actions
    })),
    synthetic_data_notice: conceptExport.synthetic_data_notice
  };
}

/** e.g. "5a11-condition-card", "5a11-condition-card-age-65-female-northbridge-region" (lens and local population). */
export function cardFileStem(card, conceptExport = null, population = null) {
  const scope = conceptExport ? resultPopulationSlug(conceptExport.context?.population, population, conceptExport.context?.setting ?? null) : '';
  return `${slugify(card.concept.code)}-condition-card${scope ? `-${scope}` : ''}`;
}

export function downloadConceptCardJson(conceptExport, extra = {}) {
  const card = buildConceptCardFile(conceptExport, extra);
  downloadJson(`${cardFileStem(card, conceptExport, extra.population ?? conceptExport.population ?? null)}.json`, card);
}

export async function downloadConceptCardPdf(conceptExport, extra = {}) {
  const card = buildConceptCardFile(conceptExport, extra);
  const summary = summarizeMetricRow(conceptExport.model_card ?? null, { hasIntendedUse: extra.hasIntendedUse ?? true });
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 46;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const ensureSpace = (heightNeeded = 16) => {
    if (y + heightNeeded > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };
  const writeParagraph = (text, { fontSize = 11, fontStyle = 'normal', spacing = 5 } = {}) => {
    doc.setFont('helvetica', fontStyle);
    doc.setFontSize(fontSize);
    const lines = doc.splitTextToSize(String(text || ''), contentWidth);
    const lineHeight = fontSize * 1.34;
    ensureSpace(lines.length * lineHeight + spacing);
    doc.text(lines, margin, y);
    y += lines.length * lineHeight + spacing;
  };
  const writeSectionTitle = (text) => {
    y += 4;
    writeParagraph(text, { fontSize: 14, fontStyle: 'bold', spacing: 7 });
    doc.setDrawColor(210, 222, 233);
    doc.line(margin, y - 2, pageWidth - margin, y - 2);
    y += 6;
  };
  const writeBullet = (text, indent = 0) => {
    writeParagraph(`- ${text}`, { fontSize: 10.5, spacing: 4 });
    y += indent;
  };

  writeParagraph(`Condition card - ${card.concept.name}`, { fontSize: 18, fontStyle: 'bold', spacing: 10 });
  writeParagraph(`Code: ${card.concept.code}`, { fontSize: 11, fontStyle: 'bold', spacing: 3 });
  writeParagraph(`Block: ${card.concept.block}`, { fontSize: 11, fontStyle: 'bold', spacing: 3 });
  const classification = card.concept.classification;
  if (classification) {
    writeParagraph(`Classification: ${classification.name}. ${classification.note}`, { fontSize: 10.5, spacing: 2 });
    if (classification.mapping) {
      writeParagraph(classification.mapping, { fontSize: 10.5, spacing: 3 });
    }
    if (classification.attribution) {
      writeParagraph(classification.attribution, { fontSize: 9.5, spacing: 3 });
    }
  }
  if (card.audience_view === 'expert') {
    writeParagraph(`Chapter hierarchy: ${card.concept.hierarchy.join(' > ')}`, { fontSize: 10.5, spacing: 3 });
  }
  writeParagraph(`AI system: ${card.context.model}`, { fontSize: 10.5, spacing: 2 });
  writeParagraph(`Function: ${card.context.use_case}`, { fontSize: 10.5, spacing: 2 });
  const local = card.context.local_population;
  writeParagraph(`For: ${card.context.shown_for}`, { fontSize: 10.5, fontStyle: 'bold', spacing: 2 });
  writeParagraph(`Population: ${card.context.population}`, { fontSize: 10.5, spacing: local ? 2 : 8 });
  if (local) {
    writeParagraph(`Prevalence: ${local.prevalence}`, { fontSize: 10.5, fontStyle: 'bold', spacing: 2 });
    writeParagraph(local.note, { fontSize: 9.5, spacing: 8 });
  }

  writeSectionTitle(card.local_result ? 'Result (local)' : 'Result');
  writeParagraph(`Overview: ${summary.statuses.overall} (grade ${summary.overallGrade})`, { fontSize: 11, spacing: 2 });
  writeParagraph(`Performance: ${summary.statuses.performance} (grade ${summary.performanceGrade})`, { fontSize: 11, spacing: 2 });
  writeParagraph(`Evidence: ${summary.statuses.evidence} (grade ${summary.evidenceGrade})`, { fontSize: 11, spacing: 2 });
  writeParagraph(`Intended use: ${summary.intendedUse}`, { fontSize: 11, spacing: 7 });
  writeParagraph(`Performance detail: ${summary.perfLabel} (CI ${summary.ciLabel})`, { fontSize: 10.5, spacing: 2 });
  writeParagraph(`Validation type: ${summary.validationType}`, { fontSize: 10.5, spacing: 2 });
  writeParagraph(`Studies: ${summary.studiesLabel} (${summary.peerReviewedLabel} peer reviewed)`, { fontSize: 10.5, spacing: 2 });
  writeParagraph(`Samples / sites: ${summary.samplesLabel} / ${summary.sitesLabel}`, { fontSize: 10.5, spacing: 4 });
  if (card.model_card.details.data_source) {
    const source = card.model_card.details.data_source;
    writeParagraph(`Row source: ${[source.source, source.study, source.date].filter(Boolean).join(', ')}`, { fontSize: 10.5, spacing: 4 });
  }
  writeParagraph('Strong, Moderate, and Weak are prototype heuristic bands. All values are synthetic demonstration data, not clinical evidence.', { fontSize: 9.5, spacing: 8 });

  if (card.local_result) {
    writeSectionTitle('Local and public');
    writeParagraph(card.local_result.note, { fontSize: 10.5, spacing: 4 });
    const publicResult = card.local_result.public_result;
    if (publicResult) {
      writeParagraph(`Public Overview: ${publicResult.statuses.overall} (grade ${publicResult.overall})`, { fontSize: 11, spacing: 2 });
      writeParagraph(`Public Performance: ${publicResult.statuses.performance} (grade ${publicResult.performance})`, { fontSize: 11, spacing: 2 });
      writeParagraph(`Public Evidence: ${publicResult.statuses.evidence} (grade ${publicResult.evidence})`, { fontSize: 11, spacing: 8 });
    } else {
      writeParagraph('No public result is stored for this condition and population.', { fontSize: 10.5, spacing: 8 });
    }
  }

  if (card.study_appraisal) {
    const { study, evidence_signal_adjustment: adjustment } = card.study_appraisal;
    writeSectionTitle('Study appraisal');
    if (study) {
      writeParagraph(`${study.title} (${study.study_id})`, { fontSize: 11, fontStyle: 'bold', spacing: 3 });
      writeBullet(study.summary);
      writeBullet(`Risk of bias: ${study.risk_of_bias}; reporting guideline: ${study.reporting_guideline}; conducted by: ${study.conducted_by}`);
      const stated = [
        study.applicability_concerns ? `applicability concerns: ${study.applicability_concerns}` : null,
        study.appraisal_tool ? `appraisal tool: ${study.appraisal_tool}` : null,
        study.setting_category ? `setting: ${study.setting_category}` : null,
        study.configuration_evaluated ? `configuration evaluated: ${study.configuration_evaluated}` : null
      ].filter(Boolean);
      if (stated.length) writeBullet(`${stated.join('; ').replace(/^./, (first) => first.toUpperCase())} (not graded)`);
    }
    if (Number.isFinite(adjustment)) {
      const signed = `${adjustment > 0 ? '+' : adjustment < 0 ? '-' : ''}${Math.abs(adjustment).toFixed(2)}`;
      writeBullet(`Change to the evidence signal from the study: ${signed}${study ? '' : ' (mean over the rows behind this result)'}`, 2);
    }
    writeParagraph('Study quality is about how the study was run, not about differences between patient groups. All studies are synthetic.', { fontSize: 9.5, spacing: 8 });
  }

  if (card.effects_on_outcomes) {
    writeSectionTitle('Effects on outcomes');
    card.effects_on_outcomes.effects.forEach((effect) => {
      writeParagraph(effect.outcome, { fontSize: 11, fontStyle: 'bold', spacing: 3 });
      writeBullet(effect.summary);
      writeBullet(effect.estimate);
      writeBullet(`${effect.risk_of_bias}; ${effect.study}`, 2);
    });
    writeParagraph(`${card.effects_on_outcomes.note} All effects are synthetic.`, { fontSize: 9.5, spacing: 8 });
  }

  writeSectionTitle('Safety incidents');
  if (!card.safety_incidents.length) {
    writeParagraph('No reported incidents for this condition and population. This does not mean safe: nothing has been reported in this synthetic dataset.', { fontSize: 10.5, spacing: 6 });
  } else {
    card.safety_incidents.forEach((incident) => {
      writeParagraph(`${incident.severity_word} - ${incident.incident_type} (${incident.status})`, { fontSize: 11, fontStyle: 'bold', spacing: 3 });
      writeBullet(incident.summary);
      const where = incident.applies_to.chapter_id ? `chapter ${incident.applies_to.chapter_id}` : incident.applies_to.codes.join(', ');
      writeBullet(`Applies to ${where}, ${incident.applies_to.population}; ${incident.harm}`);
      writeBullet(`${incident.source}; reported ${incident.reported_date ?? 'not given'}${incident.updated_date ? `, updated ${incident.updated_date}` : ''}`, 2);
    });
    writeParagraph('Serious: an open incident in which harm occurred or could have, or a recall or safety notice. Caution: any other open incident, or a mitigated one. Closed incidents carry no mark. All incidents are synthetic.', { fontSize: 9.5, spacing: 8 });
  }

  writeSectionTitle('Warnings');
  if (!card.warnings.length) {
    writeParagraph('No active warnings.', { fontSize: 10.5, spacing: 6 });
  } else {
    card.warnings.forEach((warning) => {
      writeParagraph(`${warning.relevance} - ${warning.title}`, { fontSize: 11, fontStyle: 'bold', spacing: 3 });
      if (warning.applies_to) writeBullet(warning.applies_to);
      writeBullet(warning.technical_summary);
      writeBullet(warning.details, 2);
    });
    y += 3;
  }

  writeSectionTitle('Recommended safeguards');
  card.recommended_safeguards.forEach((safeguard) => {
    // No priority word: the warnings carry the one severity scale, as on the condition card (audit A28).
    writeParagraph(safeguard.title, { fontSize: 11, fontStyle: 'bold', spacing: 3 });
    writeBullet(safeguard.technical_summary);
    safeguard.actions.forEach((action) => writeBullet(action));
    y += 3;
  });

  doc.save(`${cardFileStem(card, conceptExport, extra.population ?? conceptExport.population ?? null)}.pdf`);
}
