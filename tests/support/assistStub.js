// A stub "local model" for the study helper's end-to-end test and browser
// checks: an OpenAI-compatible endpoint on 127.0.0.1 (POST /v1/chat/completions)
// that answers every request with one canned extraction in the helper's answer
// format (backend/app/assist/prompting.py). No real model, no network beyond
// this machine. Each request is recorded (path, headers, body).
import { createServer } from 'node:http';

const field = (value, quote, location, extra = {}) => ({ value, quote, location, confidence: 0.95, uncertain: false, reason: null, ...extra });

/**
 * The canned answer: two records for one card (one with an approximate,
 * uncertain value) and one record with a code the atlas does not have, which
 * the backend must drop, never replace. Synthetic, fictional study.
 */
export function cannedMetricsAnswer({ model, useCase, code = '5A11', otherCode = 'CA40' }) {
  const card = { model_version: field(model, `${model}, used as ${useCase}`, 'Methods'), use_case: field(useCase, `${model}, used as ${useCase}`, 'Methods') };
  const source = {
    source: field('Synthetic stub study of the helper (fictional)', 'Synthetic stub study of the helper (fictional)', 'title'),
    study: field('STUB-2026-01', 'Study ID: STUB-2026-01', 'title'),
    source_date: field('2026-10-01', 'Published 2026-10-01', 'title')
  };
  return {
    records: [
      { ...card, code: field(code, 'the first condition', 'Results, page 2'), perf: field(0.83, 'accuracy was 0.83', 'Results, page 2'), ci_low: field(0.8, '95% CI 0.80 to 0.86', 'Results, page 2'), ci_high: field(0.86, '95% CI 0.80 to 0.86', 'Results, page 2'), n_samples: field(1240, '1,240 cases', 'Results, page 2'), ...source },
      {
        ...card,
        code: field(otherCode, 'the second condition', 'Results, page 3'),
        perf: field(0.7, 'around 0.7', 'Results, page 3', { confidence: 0.5, uncertain: true, reason: 'Approximate value (around 0.7).' }),
        ...source
      },
      { ...card, code: field('ZZ99', 'Grevell syndrome', 'Results, page 4'), condition: field('Grevell syndrome', 'Grevell syndrome', 'Results, page 4'), perf: field(0.66, 'reached 0.66', 'Results, page 4'), ...source }
    ],
    notes: ['Synthetic stub answer for the tests.']
  };
}

/**
 * Starts the stub. `answer()` returns the extraction object sent as the
 * model's message content.
 *
 * @returns {Promise<{ url: string, requests: object[], stop: () => Promise<void> }>}
 */
export function startAssistStub(answer) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      requests.push({ method: request.method, path: request.url, headers: request.headers, body });
      const payload = JSON.stringify({
        id: 'stub',
        object: 'chat.completion',
        model: body.model ?? 'stub',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer(body)) } }]
      });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      response.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        stop: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}
