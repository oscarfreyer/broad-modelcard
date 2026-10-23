// Concept search for the static build: the backend's search
// (CONTRACT.md §9, backend/app/services/search.py) over the snapshot's chapter
// files, because a free-text query cannot be recorded in advance.
// scripts/static/record.mjs compares it with the API for a fixed query list
// whenever it records, so a drift from §9 fails the recording.
//
// Contract v1.14 (§31): given `synonyms` (concept id → its synonyms), concepts
// found by a synonym only follow every other match, as in search.py, and
// `conditions` reads a phrase as the plain-language interpreter does
// (api/staticInterpret.js). The static build records the ICD-11 synonyms
// (synonyms.json, release 0.5 phase Q9), so its search marks them "also known
// as" and its interpreter finds conditions by them, as the API does.

export const DEFAULT_SEARCH_LIMIT = 80;
export const MAX_SEARCH_LIMIT = 200;

const RANK_CODE = 0;
const RANK_CODE_PREFIX = 1;
const RANK_TERM = 2;
const RANK_WORD = 3;
const RANK_WORD_PREFIX = 4;
const RANK_SUBSTRING = 5;
// A code no concept has: synonyms rank as preferred terms do, never by code.
const NO_CODE = '\0';

const collator = new Intl.Collator('en');
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The word patterns of a lowercase query: built once per search, not once per matching entry. */
export function wordPatterns(query) {
  const escaped = escapeRegExp(query);
  return { word: new RegExp(`(?<![0-9a-z])${escaped}(?![0-9a-z])`), wordPrefix: new RegExp(`(?<![0-9a-z])${escaped}`) };
}

/** The rank of a match (lowercase query, code, and preferred term), as in search.py. */
export function matchRank(query, code, term, patterns = wordPatterns(query)) {
  if (code === query) return RANK_CODE;
  if (code.startsWith(query)) return RANK_CODE_PREFIX;
  if (term === query) return RANK_TERM;
  if (term.startsWith(query) || patterns.word.test(term)) return RANK_WORD;
  if (patterns.wordPrefix.test(term)) return RANK_WORD_PREFIX;
  return RANK_SUBSTRING;
}

/** The words of a lowercase text: runs of letters and digits, as the ranks count them (search.py `words_of`). */
export function wordsOf(text) {
  return text.match(/[0-9a-z]+/g) ?? [];
}

/** Spacing collapsed, lower case (search.py `_lower`). */
export function lowerText(text) {
  return String(text ?? '').split(/\s+/).filter(Boolean).join(' ').toLowerCase();
}

function compareTuples(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index];
    const y = b[index];
    const order = typeof x === 'string' ? (x < y ? -1 : x > y ? 1 : 0) : x - y;
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * The code a concept is searched by: its ICD-11 code; in another ontology
 * (CONTRACT.md §23) its own `code`, a chapter without one by its number
 * (backend/app/services/ontology.py `search_atlas`); else its concept id.
 */
export function searchCode(concept, isOtherOntology = false) {
  const code = isOtherOntology ? concept.code || (concept.level === 0 ? concept.chapter_no : null) : concept.icd11_code;
  return code || concept.concept_id;
}

/** The order within a term rank: shorter term, lower level, preferred term. */
function termOrder(a, b) {
  return a.term.length - b.term.length || a.concept.level - b.concept.level || collator.compare(a.concept.pt, b.concept.pt);
}

/** Level, then preferred term: the tail of a term order (synonym matches sort by it after their own keys). */
function levelOrder(a, b) {
  return a.concept.level - b.concept.level || collator.compare(a.concept.pt, b.concept.pt);
}

/**
 * A search index over concept rows (chapters, blocks, and categories), in the
 * backend's base order: level, then preferred term.
 *
 * @param {object[]} concepts
 * @param {{ isOtherOntology?: boolean, ontology?: { id: string, name: string }|null,
 *   synonyms?: Record<string, Array<string|[string, string]>>|null }} [options] whether the concepts are
 *   of another ontology than ICD-11, and its `ontology` as the answers name it (CONTRACT.md §23);
 *   `synonyms` by concept id, each a text or `[text, source]` (v1.14, §31)
 */
export function createSearchIndex(concepts, { isOtherOntology = false, ontology = null, synonyms = null } = {}) {
  const entries = [...concepts]
    .sort((a, b) => a.level - b.level || collator.compare(a.pt, b.pt))
    .map((concept, position) => {
      // Some preferred terms carry a leading "- " (ICD-11 residual categories).
      const term = concept.pt.replace(/^[- ]+/, '').trim().toLowerCase();
      const code = searchCode(concept, isOtherOntology).toLowerCase();
      const texts = (synonyms?.[concept.concept_id] ?? []).map((item) => (Array.isArray(item) ? item[0] : item));
      return {
        concept,
        code,
        term,
        haystack: `${concept.pt} ${concept.fsn || ''} ${concept.concept_id}`.toLowerCase(),
        position,
        synonyms: texts.length ? { texts, lowered: texts.map(lowerText) } : null
      };
    });
  const withSynonyms = entries.filter((entry) => entry.synonyms);
  const byCode = new Map();
  entries.forEach((entry, position) => {
    if (!byCode.has(entry.code)) byCode.set(entry.code, position);
  });
  let postings = null;

  /** The best synonym of an entry holding `needle`: { order: [rank, length], text } or null. */
  function bestSynonym(needle, entry, patterns) {
    let best = null;
    entry.synonyms.lowered.forEach((lower, index) => {
      if (!lower.includes(needle)) return;
      const order = [matchRank(needle, NO_CODE, lower, patterns), lower.length];
      if (!best || compareTuples(order, best.order) < 0) best = { order, text: entry.synonyms.texts[index] };
    });
    return best;
  }

  function words() {
    if (!postings) {
      postings = new Map();
      const add = (word, key) => {
        if (!postings.has(word)) postings.set(word, new Set());
        postings.get(word).add(key);
      };
      entries.forEach((entry, position) => {
        new Set(wordsOf(entry.term)).forEach((word) => add(word, `${position}:-1`));
        entry.synonyms?.lowered.forEach((lower, index) => new Set(wordsOf(lower)).forEach((word) => add(word, `${position}:${index}`)));
      });
    }
    return postings;
  }

  return {
    /** Whether the index holds synonyms (v1.14, §31). */
    hasSynonyms: withSynonyms.length > 0,

    /**
     * The SearchResults answer for a query; null for a query that is empty
     * after trimming (the API answers 422 invalid_query).
     */
    search(q, limit = DEFAULT_SEARCH_LIMIT) {
      const query = String(q ?? '').trim();
      if (!query) {
        return null;
      }
      const needle = query.toLowerCase();
      const patterns = wordPatterns(needle);
      const matched = new Set();
      const matches = entries
        .filter((entry) => {
          const hit = entry.code.includes(needle) || entry.haystack.includes(needle);
          if (hit) matched.add(entry.position);
          return hit;
        })
        .map((entry) => {
          const rank = matchRank(needle, entry.code, entry.term, patterns);
          return { entry, rank };
        });
      matches.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        const order =
          a.rank <= RANK_CODE_PREFIX
            ? compareTuples([a.entry.code.length, a.entry.code], [b.entry.code.length, b.entry.code])
            : termOrder(a.entry, b.entry);
        return order || a.entry.position - b.entry.position;
      });
      const results = matches.slice(0, limit).map(({ entry }) => entry.concept);
      let total = matches.length;
      if (withSynonyms.length) {
        // Contract v1.14 (§31): concepts found by a synonym only, after every other match.
        const found = [];
        withSynonyms.forEach((entry) => {
          if (matched.has(entry.position)) return;
          const best = bestSynonym(needle, entry, patterns);
          if (best) found.push({ entry, ...best });
        });
        found.sort((a, b) => compareTuples(a.order, b.order) || levelOrder(a.entry, b.entry) || a.entry.position - b.entry.position);
        total += found.length;
        found.slice(0, Math.max(0, limit - results.length)).forEach(({ entry, text }) => {
          results.push({ ...entry.concept, match: 'synonym', matched_term: text });
        });
      }
      return { query, total, results, ...(ontology ? { ontology } : {}) };
    },

    /** The concept record of an id, or null. */
    conceptById(conceptId) {
      return entries.find((entry) => entry.concept.concept_id === conceptId)?.concept ?? null;
    },

    /** The concept whose code (ICD-11 code, else concept id) is `code`, ignoring case; null otherwise. */
    codeMatch(code) {
      const position = byCode.get(String(code ?? '').trim().toLowerCase());
      return position === undefined ? null : entries[position].concept;
    },

    /**
     * The concepts a phrase names, best first, as search.py `conditions`:
     * the code; preferred terms that are the phrase; synonyms that are the
     * phrase; preferred terms holding it as whole words. With `exactOnly`,
     * the last only for a chapter or block named "<phrase> or …".
     *
     * @returns {Array<{ concept: object, match: 'code'|'term'|'synonym', matchedTerm: string|null }>}
     */
    conditions(phrase, { limit = 3, exactOnly = false } = {}) {
      const needle = lowerText(phrase);
      const phraseWords = wordsOf(needle);
      if (!phraseWords.length) return [];
      const found = [];
      const seen = new Set();
      const add = (entry, match, matchedTerm) => {
        if (seen.has(entry.concept.concept_id)) return;
        seen.add(entry.concept.concept_id);
        found.push({ concept: entry.concept, match, matchedTerm });
      };
      const code = this.codeMatch(needle);
      if (code) {
        seen.add(code.concept_id);
        found.push({ concept: code, match: 'code', matchedTerm: null });
      }
      const index = words();
      const lists = [...new Set(phraseWords)].map((word) => index.get(word) ?? new Set()).sort((a, b) => a.size - b.size);
      let candidates = new Set(lists[0]);
      for (const other of lists.slice(1)) {
        if (!candidates.size) break;
        candidates = new Set([...candidates].filter((key) => other.has(key)));
      }
      const pattern = new RegExp(`(?<![0-9a-z])${escapeRegExp(needle)}(?![0-9a-z])`);
      const terms = [];
      const synonymMatches = [];
      [...candidates]
        .map((key) => key.split(':').map(Number))
        .sort((a, b) => a[0] - b[0] || a[1] - b[1])
        .forEach(([position, synonymIndex]) => {
          const entry = entries[position];
          if (synonymIndex < 0) {
            if (pattern.test(entry.term)) terms.push(entry);
            return;
          }
          const lower = entry.synonyms.lowered[synonymIndex];
          if (lower.replace(/^[- ]+/, '') === needle) synonymMatches.push({ entry, length: lower.length, text: entry.synonyms.texts[synonymIndex] });
        });
      const patterns = wordPatterns(needle);
      terms.sort((a, b) => {
        const rankA = matchRank(needle, a.code, a.term, patterns);
        const rankB = matchRank(needle, b.code, b.term, patterns);
        if (rankA !== rankB) return rankA - rankB;
        const order = rankA <= RANK_CODE_PREFIX ? compareTuples([a.code.length, a.code], [b.code.length, b.code]) : termOrder(a, b);
        return order || a.position - b.position;
      });
      terms.filter((entry) => entry.term === needle).forEach((entry) => add(entry, 'term', entry.concept.pt));
      synonymMatches
        .sort((a, b) => a.length - b.length || levelOrder(a.entry, b.entry) || a.entry.position - b.entry.position)
        .forEach(({ entry, text }) => add(entry, 'synonym', text));
      terms.forEach((entry) => {
        if (!exactOnly || (entry.concept.level <= 1 && entry.term.startsWith(`${needle} or `))) add(entry, 'term', entry.concept.pt);
      });
      return found.slice(0, limit);
    }
  };
}
