import { useEffect, useMemo, useRef, useState } from 'react';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import Icon from '../../design/Icon.jsx';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import { CODE_SYSTEMS, ICD10CM_EXAMPLE, INDICATOR_WORDS, cdsCodes, cdsRequest, detailParagraphs, requestPatientWords } from './cdsHooks.js';

function Detail({ detail }) {
  return detailParagraphs(detail).map((runs, index) => (
    <p key={index} className="cds-card-detail">
      {runs.map((run, position) =>
        run.strong ? <strong key={position}>{run.text}</strong> : run.em ? <em key={position}>{run.text}</em> : <span key={position}>{run.text}</span>
      )}
    </p>
  ));
}

/** One returned CDS card, drawn as a host application would: indicator, summary, detail, link. */
function CdsCard({ card }) {
  const indicator = card.indicator in INDICATOR_WORDS ? card.indicator : 'info';
  return (
    <li className={`cds-card is-${indicator}`}>
      <p className="cds-card-head">
        <span className={`cds-indicator is-${indicator}`}>
          <Icon name={indicator === 'info' ? 'info' : 'warning'} size={14} />
          {INDICATOR_WORDS[indicator]}
        </span>
        <span className="cds-card-summary">{card.summary}</span>
      </p>
      <Detail detail={card.detail} />
      <p className="cds-card-foot">
        <span className="cds-card-source">{card.source?.label}</span>
        {card.links?.map((link) => (
          <a key={link.url} className="button-plain cds-card-link" href={link.url}>
            {link.label}
            <Icon name="externalLink" size={14} />
          </a>
        ))}
      </p>
    </li>
  );
}

/**
 * The CDS Hooks mode of the live interaction page (contract v1.14, CONTRACT.md
 * §33): the case as a CDS Hooks patient-view request (a synthetic patient and
 * their conditions), sent to the local service on request, and the cards it
 * returns, one per condition. Nothing is sent until "Send" is pressed, and
 * only to this app's own API.
 */
export default function CdsHooksStage({ current, codesText, onCodesText }) {
  const client = useDataClient();
  const [codeSystem, setCodeSystem] = useState('icd11');
  const [response, setResponse] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const parsed = cdsCodes(codesText, codeSystem);
  const request = useMemo(
    () => cdsRequest({ ...current, codesText }, { codeSystem, hookInstance: 'demo-request-1' }),
    [codeSystem, codesText, current]
  );

  // A changed request makes the cards shown stale: they belong to the request that was sent.
  // Keyed on the request's content, so a field the request leaves out (depth) keeps them,
  // and an answer to an earlier request that arrives late is dropped.
  const requestKey = JSON.stringify(request);
  const sent = useRef(0);
  useEffect(() => {
    sent.current += 1;
    setResponse(null);
    setProblem(null);
    setBusy(false);
  }, [requestKey]);

  const send = async () => {
    const id = ++sent.current;
    setBusy(true);
    setProblem(null);
    try {
      const hookInstance = globalThis.crypto?.randomUUID?.() ?? `demo-${Date.now()}`;
      const answer = await client.callCdsService({ ...request, hookInstance });
      if (id === sent.current) setResponse(answer);
    } catch (error) {
      if (id === sent.current) setProblem(error);
    } finally {
      if (id === sent.current) setBusy(false);
    }
  };

  return (
    <section className="plg-host cds-stage" aria-labelledby="cds-stage-title">
      <p className="plg-host-bar">Host application (simulated): clinical software that calls a CDS Hooks service</p>
      <div className="cds-stage-body">
        <h2 id="cds-stage-title" className="plg-section-title">
          CDS Hooks request
        </h2>
        <p className="plg-embed-text">
          The case as a <code>patient-view</code> request to the local service <code>bmc-condition-status</code>: a synthetic patient ({requestPatientWords(current)}) and
          one condition per code. Ethnicity is not part of it. Broad Modelcard answers with one card per condition.
        </p>
        <div className="cds-controls">
          <SegmentedControl
            label="Codes are"
            size="small"
            options={CODE_SYSTEMS.map(({ value, label }) => ({ value, label }))}
            value={codeSystem}
            onChange={setCodeSystem}
          />
          {codeSystem === 'icd10cm' && codesText !== ICD10CM_EXAMPLE ? (
            <button type="button" className="button-plain" onClick={() => onCodesText(ICD10CM_EXAMPLE)}>
              Use three example ICD-10-CM codes
            </button>
          ) : null}
        </div>
        {parsed.ignored ? (
          <p className="plg-hint is-warning" role="status">
            {parsed.ignored} {parsed.ignored === 1 ? 'entry is' : 'entries are'} not sent: only {codeSystem === 'icd10cm' ? 'ICD-10-CM codes such as E11.9' : 'ICD-11 codes such as 5A11'}.
          </p>
        ) : null}
        <pre className="plg-snippet cds-request" tabIndex={0} aria-label="The CDS Hooks request">
          <code>{JSON.stringify(request, null, 2)}</code>
        </pre>
        <div className="plg-embed-actions">
          <button type="button" className="button-filled" disabled={busy || !parsed.codes.length} onClick={send}>
            <Icon name="upload" size={16} />
            {busy ? 'Sending…' : 'Send as CDS Hooks request'}
          </button>
          {!parsed.codes.length ? <span className="plg-hint">Add at least one code.</span> : null}
        </div>
        {problem ? (
          <p className="plg-error" role="alert">
            {problem.code === 'backend_unavailable' ? 'The local API is not reachable. Start the app with npm run dev.' : problem.message}
          </p>
        ) : null}
        <div aria-live="polite">
          {response ? (
            <>
              <h3 className="plg-group-title">Returned cards ({response.cards.length})</h3>
              <ul className="cds-cards">
                {response.cards.map((card) => (
                  <CdsCard key={card.uuid} card={card} />
                ))}
              </ul>
              <details className="cds-raw">
                <summary>The response as JSON</summary>
                <pre className="plg-snippet" tabIndex={0}>
                  <code>{JSON.stringify(response, null, 2)}</code>
                </pre>
              </details>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
