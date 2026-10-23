import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useClientQuery from '../api/useClientQuery.js';
import { checkPopulation, populationForReads } from '../shared/localPopulation.js';
import { ICD11, ontologyList, otherOntology } from '../shared/ontology.js';
import { matchOption } from './cardMatch.js';
import { IS_STATIC_BUILD } from '../shared/staticBuild.js';
import { STATIC_OTHER_ONTOLOGY_LENS_NOTE, STATIC_SETTING_LENS_NOTE, STATIC_SETTING_ONTOLOGY_NOTE, fitLens, isLensSendable, staticLens, withDefaults, withOneGroup } from './lensSelection.js';
import { specificSetting, storedSettings } from '../shared/careSetting.js';

const NO_POPULATIONS = Object.freeze([]);
// The static demo holds one population group at a time.
const limitLens = IS_STATIC_BUILD ? withOneGroup : (lens) => lens;

/** The last valid filters, without the population /meta no longer lists. */
function withoutDroppedPopulation(filters, droppedId) {
  if (!droppedId || filters?.population !== droppedId) {
    return filters;
  }
  const { population: _dropped, ...rest } = filters;
  return rest;
}

/**
 * AI system (registry entry), function (`use_case`), demographic lens, and
 * local population selection, with the options the data client offers.
 * `filters` is the last valid combination, so metric reads never see an AI
 * system paired with a function it lacks, or a local population the data
 * does not hold. `filters.population` is set only for a local population
 * (contract v1.10), so default reads and their cache keys stay as they were.
 *
 * A local population is sent once `/meta.populations` lists it. When it is
 * not (or no longer) listed, for example after it was removed elsewhere and
 * the version watch re-read `/meta`, the selection falls back to the default
 * prevalence and `droppedPopulation` says which one went and why.
 *
 * The classification (contract v1.13, CONTRACT.md §23) is the ontology the
 * atlas is drawn in: ICD-11 by default, or one `/meta.ontologies` lists.
 * `filters.ontology` is set only for another ontology than ICD-11, so ICD-11
 * reads and their cache keys stay as they were. An ontology the data does
 * not list falls back to ICD-11 (`droppedOntology` says which).
 *
 * The care setting (contract v1.14, CONTRACT.md §29) is a lens axis: null for
 * Any setting, or a specific setting's axis value. `filters.setting` is set
 * only for a specific setting, so Any-setting reads and their cache keys stay
 * as they were. A setting the card stores no rows for can still be chosen
 * (its results read No data); `storedSettings` says which ones the card holds.
 * The static demo (release 0.5) records each card's stored settings
 * at all patients in ICD-11: there a setting applies only on a card that
 * stores it and in ICD-11, reads for all patients, and comes back with them
 * (as the chosen group comes back with ICD-11).
 *
 * @param {{ model?: string|null, useCase?: string|null, lens?: object, setting?: string|null, population?: string|null, ontology?: string|null }} [initial] e.g. from the URL; values the data does not offer fall back to the defaults
 */
export default function useModelSelection(initial = {}) {
  const meta = useClientQuery('meta', (client, options) => client.getMeta({}, options));
  const registry = useClientQuery('models', (client, options) => client.listModels({}, options));
  const [modelVersion, setModelVersion] = useState(initial.model ?? '');
  const [useCase, setUseCase] = useState(initial.useCase ?? '');
  const [lens, setLens] = useState(() => limitLens(withDefaults(initial.lens)));
  const [population, setPopulationState] = useState(initial.population ?? null);
  // Contract v1.14 (§29): a specific care setting, or null for Any setting.
  const [setting, setSettingState] = useState(() => specificSetting(initial.setting));
  const [ontology, setOntologyState] = useState(otherOntology(initial.ontology) ?? ICD11);
  const [droppedOntology, setDroppedOntology] = useState(null);
  const [droppedPopulation, setDroppedPopulation] = useState(null);
  // A link (or a restored URL) named a card the data does not hold: what it
  // asked for, so the atlas can say what it shows instead (audit B5).
  const [substitution, setSubstitution] = useState(null);
  // What a link or a restored URL asked for; a pick in the toolbar is not a request.
  const requested = useRef({ model: initial.model ?? null, useCase: initial.useCase ?? null });
  const populations = meta.data ? meta.data.populations ?? NO_POPULATIONS : null;
  // Names of the populations seen so far, so a removed one is still named.
  const seenNames = useRef(new Map());
  (populations ?? []).forEach((entry) => seenNames.current.set(entry.id, entry.name));
  const populationCheck = checkPopulation(population, populations, seenNames.current);
  const activePopulation = populationCheck.entry;

  useEffect(() => {
    const check = checkPopulation(population, populations, seenNames.current);
    if (check.status === 'dropped') {
      setDroppedPopulation(check.dropped);
      setPopulationState(null);
    }
  }, [population, populations]);

  // The classification: ICD-11, or an ontology /meta lists (contract v1.13).
  const ontologies = useMemo(() => (meta.data ? ontologyList(meta.data) : null), [meta.data]);
  const activeOntology = ontologies?.find((entry) => entry.id === ontology) ?? null;
  const isOntologyKnown = ontology === ICD11 || Boolean(activeOntology);
  useEffect(() => {
    if (ontologies && !isOntologyKnown) {
      setDroppedOntology(ontology);
      setOntologyState(ICD11);
    }
  }, [isOntologyKnown, ontologies, ontology]);
  const setOntology = useCallback((next) => {
    setDroppedOntology(null);
    setOntologyState(otherOntology(next) ?? ICD11);
  }, []);
  // Another ontology is sent once /meta lists it; until then reads wait.
  const readOntology = otherOntology(ontology) && activeOntology ? ontology : null;
  const isOntologySendable = !otherOntology(ontology) || Boolean(activeOntology);

  const setSetting = useCallback((next) => setSettingState(specificSetting(next)), []);

  const setPopulation = useCallback((next) => {
    setDroppedPopulation(null);
    setPopulationState(next || null);
  }, []);
  /** A read answered `unknown_population` (removed meanwhile): back to the default prevalence. */
  const dropPopulation = useCallback(() => {
    setPopulationState((current) => {
      if (current) {
        setDroppedPopulation(checkPopulation(current, [], seenNames.current).dropped);
      }
      return null;
    });
  }, []);

  const models = useMemo(() => registry.data?.models || [], [registry.data]);
  const selectedModel = models.find((model) => model.model_version === modelVersion) || null;
  const useCaseOptions = useMemo(() => (selectedModel?.use_cases || []).map((entry) => entry.use_case), [selectedModel]);
  // The static demo (Q9) holds a setting for the cards that store it, in ICD-11 only: elsewhere Any setting.
  const selectedSettings = storedSettings(selectedModel?.use_cases?.find((entry) => entry.use_case === useCase));
  const shownSetting = IS_STATIC_BUILD && setting && (otherOntology(ontology) || !selectedSettings.includes(setting)) ? null : setting;
  const axes = meta.data?.axes || null;

  useEffect(() => {
    if (!models.length) {
      return;
    }
    const versions = models.map((model) => model.model_version);
    if (!modelVersion || !versions.includes(modelVersion)) {
      const matched = matchOption(modelVersion, versions);
      if (matched) {
        setModelVersion(matched);
        return;
      }
      if (modelVersion && requested.current.model === modelVersion) {
        setSubstitution({ model: modelVersion, useCase: requested.current.useCase });
      }
      requested.current = { model: null, useCase: null };
      setModelVersion(registry.data.default_model_version || versions[0] || '');
    }
  }, [modelVersion, models, registry.data]);

  useEffect(() => {
    if (!selectedModel) {
      return;
    }
    if (!useCase || !useCaseOptions.includes(useCase)) {
      const matched = matchOption(useCase, useCaseOptions);
      if (matched) {
        setUseCase(matched);
        return;
      }
      if (useCase && requested.current.useCase === useCase) {
        setSubstitution((current) => current ?? { model: selectedModel.model_version, useCase });
      }
      requested.current = { model: null, useCase: null };
      const preferred = selectedModel.default_use_case;
      setUseCase((preferred && useCaseOptions.includes(preferred) ? preferred : null) || useCaseOptions[0] || '');
    }
  }, [selectedModel, useCase, useCaseOptions]);

  useEffect(() => {
    if (!axes) {
      return;
    }
    setLens((current) => fitLens(current, axes));
  }, [axes]);

  // A lens from the URL is only sent once the axes have confirmed every value;
  // the effect above corrects it after the commit, so until then the last
  // valid filters (or none) stay in place. A population /meta no longer lists
  // is left out in this very render (populationForReads), never sent from the
  // last valid filters while the effect above resets the choice.
  // The static demo records other classifications at all patients only (R7):
  // there the lens reads as all patients, and the chosen group comes back with ICD-11.
  // So does a care setting (Q9): recorded for all patients only.
  const lensLockedNote = !IS_STATIC_BUILD ? null : otherOntology(ontology) ? STATIC_OTHER_ONTOLOGY_LENS_NOTE : shownSetting ? STATIC_SETTING_LENS_NOTE : null;
  const isLensLocked = Boolean(lensLockedNote);
  const shownLens = useMemo(() => (isLensLocked ? staticLens(lens, { isOtherOntology: true }) : lens), [isLensLocked, lens]);
  const { population: readPopulation, isSendable: isPopulationSendable } = populationForReads(population, populationCheck);
  const droppedId = populationCheck.status === 'dropped' ? population : null;
  const isValid = Boolean(
    selectedModel && useCaseOptions.includes(useCase) && isLensSendable(lens, axes) && isPopulationSendable && isOntologySendable
  );
  const lastValidFilters = useRef(null);
  const filters = useMemo(
    () =>
      isValid
        ? {
            model: modelVersion,
            useCase,
            ...shownLens,
            ...(shownSetting ? { setting: shownSetting } : {}),
            ...(readPopulation ? { population: readPopulation } : {}),
            ...(readOntology ? { ontology: readOntology } : {})
          }
        : withoutDroppedPopulation(lastValidFilters.current, droppedId),
    [droppedId, isValid, shownLens, modelVersion, readOntology, readPopulation, shownSetting, useCase]
  );
  lastValidFilters.current = filters;

  const activeUseCase = filters ? models.find((model) => model.model_version === filters.model)?.use_cases.find((entry) => entry.use_case === filters.useCase) : null;
  const hasMultimorbidityData = Boolean(activeUseCase?.has_multimorbidity);
  const cardSettings = useMemo(() => storedSettings(activeUseCase), [activeUseCase]);
  const multimorbidityVariants = useMemo(
    () =>
      models.flatMap((model) =>
        model.use_cases.filter((entry) => entry.has_multimorbidity).map((entry) => ({ model: model.model_version, useCase: entry.use_case }))
      ),
    [models]
  );
  const lensOptions = useMemo(() => ({ age: axes?.age || [], sex: axes?.sex || [], ethnicity: axes?.ethnicity || [] }), [axes]);
  // The specific care settings of the Context axis (v1.14); older data offers none.
  const settingOptions = useMemo(() => (axes?.context || []).filter((value) => specificSetting(value)), [axes]);

  // A pick in the toolbar is not a request (see `requested`).
  const pickModelVersion = useCallback((next) => {
    requested.current = { model: null, useCase: null };
    setModelVersion(next);
  }, []);
  const pickUseCase = useCallback((next) => {
    requested.current = { model: null, useCase: null };
    setUseCase(next);
  }, []);
  const selectVariant = useCallback(({ model, useCase: nextUseCase }) => {
    requested.current = { model: model ?? null, useCase: nextUseCase || null };
    setModelVersion(model);
    setUseCase(nextUseCase);
  }, []);
  const setLensValue = useCallback((axis, value) => setLens((current) => limitLens({ ...current, [axis]: value }, axis)), []);
  const replaceLens = useCallback((next) => setLens(limitLens(fitLens(withDefaults(next), axes))), [axes]);
  const clearDroppedOntology = useCallback(() => setDroppedOntology(null), []);
  const clearDroppedPopulation = useCallback(() => setDroppedPopulation(null), []);
  const clearSubstitution = useCallback(() => setSubstitution(null), []);
  const retryMeta = meta.retry;
  const retryRegistry = registry.retry;
  const retry = useCallback(() => {
    retryMeta();
    retryRegistry();
  }, [retryMeta, retryRegistry]);
  const metaData = meta.data;
  const isLoading = meta.isLoading || registry.isLoading;
  const error = meta.error || registry.error;

  // One object per change of what it holds, so the memoized toolbar and the
  // effects that read the selection run only when it changed.
  return useMemo(
    () => ({
      filters,
      modelVersion,
      setModelVersion: pickModelVersion,
      modelOptions: models.map((model) => model.model_version),
      /** Registry entries (ModelEntry), for names, Model/Product tags, and system details. */
      entries: models,
      useCase,
      setUseCase: pickUseCase,
      useCaseOptions,
      lens: shownLens,
      /** The static demo shows another classification, and a care setting, for all patients only (R7, Q9): the population choice is fixed. */
      isLensLocked,
      /** Why the population choice is fixed in the static demo (null: it is not). */
      lensLockedNote,
      setLensValue,
      /** Replace the whole lens (e.g. from the URL); open or unknown axes become their defaults. */
      setLens: replaceLens,
      lensOptions,
      /** The care setting chosen (v1.14): the axis value of a specific setting, or null for Any setting. In the static demo, the one shown. */
      setting: shownSetting,
      setSetting,
      /** The settings the card on screen stores rows for (listModels `settings`), Any setting first. */
      cardSettings,
      /** The specific settings the axes offer (none before /meta loads). */
      settingOptions,
      /** Why no setting can be chosen now in the static demo (another classification; Q9), else null. */
      settingLockedNote: IS_STATIC_BUILD && otherOntology(ontology) ? STATIC_SETTING_ONTOLOGY_NOTE : null,
      /** The local population id chosen (null: the default prevalence); reads use `filters.population`. */
      population,
      setPopulation,
      dropPopulation,
      /** `/meta.populations` of the version on screen (null until it loads). */
      populations,
      /** The entry of the chosen local population ({ id, name, codes, updated_version }), once /meta lists it. */
      activePopulation,
      /** The classification chosen: icd11 (the default) or the id of another ontology (contract v1.13). */
      ontology,
      setOntology,
      /** `/meta.ontologies` (ICD-11 alone for older data); null until /meta loads. */
      ontologies,
      /** The `/meta.ontologies` entry of the classification chosen, once /meta lists it. */
      activeOntology,
      /** The other ontology every atlas read names now (null: ICD-11). */
      readOntology,
      /** Whether the reads may go out: another ontology waits until /meta lists it. */
      isOntologyReady: isOntologySendable,
      /** An ontology a link asked for that the data does not hold, until it has been said. */
      droppedOntology,
      clearDroppedOntology,
      /** The local population the selection fell back from, and whether it had been available. */
      droppedPopulation,
      clearDroppedPopulation,
      /** The card a link asked for that the data does not hold ({ model, useCase }), until it has been said. */
      substitution,
      clearSubstitution,
      hasMultimorbidityData,
      /** Cards (AI system × function) with stored combination results, for the multimorbidity fallback. */
      multimorbidityVariants,
      selectVariant,
      statusBands: metaData?.status_bands ?? null,
      overallScoreWeights: metaData?.overall_score_weights ?? null,
      /** The score weights for a card without an intended-use statement (contract v1.11). */
      overallScoreWeightsWithoutIntendedUse: metaData?.overall_score_weights_without_intended_use ?? null,
      /** The evidence signal's term weights and a linked study's adjustments (contract v1.13, CONTRACT.md §22). */
      evidenceSignalWeights: metaData?.evidence_signal_weights ?? null,
      studyAdjustments: metaData?.evidence_study_adjustments ?? null,
      // Contract v1.13 (CONTRACT.md §24): the Across groups difference rule, a prototype heuristic.
      subgroupDifference: metaData?.subgroup_difference ?? null,
      isLoading,
      error,
      retry
    }),
    [
      activeOntology, activePopulation, clearDroppedOntology, clearDroppedPopulation, clearSubstitution, dropPopulation, droppedOntology,
      droppedPopulation, error, filters, hasMultimorbidityData, isLensLocked, isLoading, lensLockedNote, isOntologySendable, lensOptions, metaData, modelVersion,
      models, multimorbidityVariants, ontologies, ontology, pickModelVersion, pickUseCase, population, populations, readOntology, replaceLens,
      retry, selectVariant, setLensValue, setOntology, setPopulation, setSetting, shownSetting, settingOptions, cardSettings, shownLens, substitution,
      useCase, useCaseOptions
    ]
  );
}
