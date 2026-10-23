// Admin request failures (DataClientError codes from CONTRACT.md §11) in
// plain words, with what to do next.

const MESSAGES = {
  backend_unavailable: {
    title: 'The backend is not running',
    text: 'This page saves and checks data through the Broad Modelcard backend on this computer, and it did not answer. Start the app with npm run dev in the project folder, then try again.'
  },
  unsupported_file_type: {
    title: 'This is not a CSV or Excel file',
    text: 'Save the spreadsheet as Excel (.xlsx) or CSV and upload it again.'
  },
  upload_too_large: {
    title: 'The file is too large',
    text: 'Files up to 128 MB can be uploaded. A complete metrics file is about 45 MB as CSV; check that the file holds only one AI system and function.'
  },
  invalid_parameter: {
    title: 'Choose the AI system and function first',
    text: 'Performance and multimorbidity files belong to one AI system and function. Choose them above, then upload the file.'
  },
  publish_in_progress: {
    title: 'Another publish is running',
    text: 'A publish or restore is being saved right now. Wait a few seconds and try again.'
  },
  upload_outdated: {
    title: 'The live data changed since this file was checked',
    text: 'Upload the file again so it is checked against the current data.'
  },
  upload_not_valid: {
    title: 'This update can no longer be published',
    text: 'It was published, replaced, or discarded meanwhile, perhaps in another tab. The page now shows the current state.'
  },
  upload_not_staged: {
    title: 'This update is no longer waiting',
    text: 'It was published, replaced, or discarded meanwhile. The page now shows the current state.'
  },
  rollback_conflict: {
    title: 'This restore would leave functions without results',
    text: 'Some functions in AI systems & functions would be left without performance metrics. Restore AI systems & functions first, or choose a later version.'
  },
  rollback_no_change: {
    title: 'Nothing to restore',
    text: 'The live data already matches this version for the chosen data set, so no version was added. Choose Everything, another data set, or another version.'
  },
  unknown_version: {
    title: 'This version does not exist',
    text: 'Reload the history and choose again.'
  },
  unknown_population: {
    title: 'This local population is not in the live data',
    text: 'It was removed meanwhile, perhaps in another tab. The page now shows the current populations.'
  }
};

// Words that depend on the data set (contract v1.10): a population upload's
// form fields are its id and name, not an AI system and function.
const BY_KIND = {
  population: {
    invalid_parameter: {
      title: 'Check the population’s id and name',
      text: 'A new local population needs an id (lowercase letters, digits, and hyphens, at most 40 characters) and a name of at most 80 characters.'
    }
  }
};

/**
 * @param {Error & { code?: string, detail?: string|null }} error
 * @param {{ kind?: string }} [context] the data set of the page, for words that depend on it
 * @returns {{ title: string, text: string, detail: string|null, code: string }}
 */
export function describeProblem(error, { kind } = {}) {
  const code = error?.code ?? 'unknown';
  const known = BY_KIND[kind]?.[code] ?? MESSAGES[code];
  if (known) {
    // The backend's own detail adds the specifics (which function, which version).
    const detail = error?.detail && !/npm run dev/.test(error.detail) ? error.detail : null;
    return { ...known, detail: code === 'rollback_conflict' || code === 'upload_outdated' || (kind === 'population' && code === 'invalid_parameter') ? detail : null, code };
  }
  return { title: 'Something went wrong', text: error?.message || 'The request failed.', detail: null, code };
}
