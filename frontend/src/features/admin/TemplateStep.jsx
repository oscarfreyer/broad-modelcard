import { useState } from 'react';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import HelpTip from '../../design/HelpTip.js';
import Icon from '../../design/Icon.jsx';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import { populationTemplateParams } from './populations.js';

const FORMATS = [
  { value: 'xlsx', label: 'Excel (.xlsx)' },
  { value: 'csv', label: 'CSV' }
];

/**
 * Template downloads: the live data in template form ("start from the current
 * data") or an empty template, as Excel or CSV. The Excel file explains every
 * column and offers the allowed values as dropdowns.
 */
export default function TemplateStep({ dataset, target }) {
  const client = useDataClient();
  const [format, setFormat] = useState('xlsx');
  const targetParams = dataset.needsTarget && target
    ? { modelVersion: target.model, useCase: target.useCase, populationId: target.localPopulationId }
    : dataset.needsPopulation
      ? populationTemplateParams(target)
      : {};
  // A new local population starts from the default tiers (CONTRACT.md §21).
  const isNewPopulation = dataset.needsPopulation && !target?.isLive;
  const filledUrl = client.getTemplateUrl({ kind: dataset.kind, format, filled: true, ...targetParams });
  const emptyUrl = client.getTemplateUrl({ kind: dataset.kind, format });
  const slowNote = dataset.kind === 'metrics' && format === 'xlsx';
  return (
    <>

      {dataset.templateNotes ? (
        <div className="template-notes">
          <h3 className="step-subtitle">{dataset.templateNotes.title}</h3>
          <ul className="template-note-list">
            {dataset.templateNotes.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="page-title-row">
        <SegmentedControl size="small" label="File format" options={FORMATS} value={format} onChange={setFormat} />
        {/* How the template works is its help. */}
        <HelpTip label="About the template">
          <p>Download the data as a spreadsheet, edit it in Excel or a similar program, and upload it in the next step.</p>
          <p>{dataset.rows}</p>
        </HelpTip>
      </div>
      <ul className="admin-list">
        <li className="admin-row">
          <Icon name="sheet" size={22} className="admin-row-icon" />
          <span className="admin-row-main">
            <span className="admin-row-title">{isNewPopulation ? 'Default tiers to start from' : 'Current data'}</span>
            <span className="admin-row-text">
              {isNewPopulation
                ? 'Recommended: the default prevalence of every code. Keep the codes whose commonness differs locally, change their tier, and delete the other rows.'
                : dataset.needsPopulation
                  ? 'Recommended: this population’s list as it is live now. Change only what you need.'
                  : 'Recommended: start from what the atlas shows now and change only what you need.'}
              {slowNote ? ' Preparing the Excel file takes about 15 seconds.' : ''}
            </span>
          </span>
          <a className="button-tinted" href={filledUrl} download>
            <Icon name="download" size={18} />
            Download
          </a>
        </li>
        <li className="admin-row">
          <Icon name="sheet" size={22} className="admin-row-icon is-quiet" />
          <span className="admin-row-main">
            <span className="admin-row-title">Empty template</span>
            <span className="admin-row-text">Only the column headings, for entering new data from scratch.</span>
          </span>
          <a className="button-plain" href={emptyUrl} download>
            <Icon name="download" size={18} />
            Download
          </a>
        </li>
      </ul>
    </>
  );
}
