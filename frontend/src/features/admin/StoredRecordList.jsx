import { useState } from 'react';
import { count } from './datasets.js';
import { effectRowWords } from './effects.js';
import ProblemNotice from './ProblemNotice.jsx';
import { studyRowWords } from './studies.js';

const SHOWN = 6;

/**
 * The stored studies and effects as one list design (contract v1.13): each
 * kind's words, its ID field, and how a row reads.
 */
export const STORED_LISTS = Object.freeze({
  studies: {
    id: 'study_id',
    one: 'study',
    many: 'studies',
    title: 'Stored studies',
    words: (study) => {
      const words = studyRowWords(study);
      return { title: words.title, text: words.text, summary: words.risk, meta: words.meta };
    }
  },
  effects: {
    id: 'effect_id',
    one: 'effect',
    many: 'effects',
    title: 'Stored effects',
    words: (effect) => {
      const words = effectRowWords(effect);
      return { title: words.title, text: words.text, summary: words.appraisal, meta: words.meta };
    }
  }
});

function StoredRow({ list, record, isEditing, onEdit }) {
  const words = list.words(record);
  const id = record[list.id];
  return (
    <li className={`admin-row incident-row${isEditing ? ' is-editing' : ''}`}>
      <span className="admin-row-main">
        <span className="admin-row-title">{words.title}</span>
        <span className="admin-row-text">{words.text}</span>
        <span className="incident-row-summary">{words.summary}</span>
        <span className="incident-row-meta">
          {words.meta ? `${words.meta}, ` : ''}
          <span className="tabular">{id}</span>
        </span>
      </span>
      {isEditing ? (
        <span className="incident-row-editing">Editing</span>
      ) : (
        <button type="button" className="button-plain incident-row-edit" aria-label={`Edit ${list.one} ${id}`} onClick={() => onEdit(record)}>
          Edit
        </button>
      )}
    </li>
  );
}

/**
 * The stored studies or effects (listStudies, listEffects; read once by the
 * data set page, which passes them in), each with Edit, which fills the form
 * below with every stored value: loading, failed, empty, or the rows.
 *
 * @param {object} props
 * @param {'studies'|'effects'} props.kind
 * @param {object[]|null} props.records contract Study or Effect objects; null while loading
 */
export default function StoredRecordList({ kind, records, error = null, onRetry = null, editingId = null, hasWaitingUpdate = false, onEdit }) {
  const list = STORED_LISTS[kind];
  const [showAll, setShowAll] = useState(false);
  const shown = records && !showAll ? records.slice(0, SHOWN) : records;
  // The record being edited stays in view even when it is further down the list.
  const editing = records && !showAll && editingId ? records.find((entry) => entry[list.id] === editingId && !shown.includes(entry)) : null;
  const rows = editing ? [...shown, editing] : shown;
  const titleId = `${list.one}-list-title`;
  return (
    <section className="incident-list" aria-labelledby={titleId}>
      <div className="incident-list-head">
        <h3 id={titleId} className="step-subtitle">
          {list.title}
        </h3>
        {records?.length ? <span className="incident-list-count tabular">{count(records.length)}</span> : null}
      </div>
      {error && !records ? (
        <ProblemNotice error={error} onRetry={onRetry} />
      ) : !records ? (
        <div className="skeleton-block" aria-busy="true" aria-label={`Loading the ${list.title.toLowerCase()}`}>
          <span className="skeleton-line is-wide" />
          <span className="skeleton-line" />
        </div>
      ) : !records.length ? (
        <p className="incident-list-empty">No {list.many} stored yet.</p>
      ) : (
        <>
          <p className="step-text">
            Edit fills the form below with every stored value; publishing replaces that {list.one}.
            {hasWaitingUpdate ? ` An update is waiting: the list shows the live ${list.many}.` : ''}
          </p>
          <ul className="admin-list incident-rows" aria-label={list.title}>
            {rows.map((record) => (
              <StoredRow key={record[list.id]} list={list} record={record} isEditing={record[list.id] === editingId} onEdit={onEdit} />
            ))}
          </ul>
          {records.length > SHOWN ? (
            <button type="button" className="button-plain incident-list-more" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show fewer' : `Show all ${count(records.length)} ${list.many}`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
