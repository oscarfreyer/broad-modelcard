// <bmc-live-panel>: the embeddable live interaction panel. A dependency-free custom element with a shadow root and
// its own styles. A host application places it next to its AI system's
// output and sets the case as attributes:
//
//   <bmc-live-panel model="SynGPT-2.0" use-case="Clinician Facing CDSS"
//     codes="5A11, GB61" age-group="65+" sex="female"></bmc-live-panel>
//
// Attributes: model, use-case (the card); codes (comma-separated ICD-11
// codes); age-group (0-17 | 18-39 | 40-64 | 65+), sex (female | male),
// ethnicity (white | black | hispanic | asian | other); optional setting
// (emergency_department | intensive_care | inpatient_ward | outpatient_clinic |
// primary_care; contract v1.14, absent: any setting), population, version
// (staged:<upload_id>), depth (plain | expert), api-base (default /api/v1, same
// origin). Values outside these are ignored and never shown back. Behaviour is
// in panelController.js, content in panelView.js.
import { materialize } from './dom.js';
import { createPanelClient } from './panelClient.js';
import { createPanelController } from './panelController.js';
import { PANEL_ATTRIBUTES, readPanelInputs } from './panelInputs.js';
import { PANEL_CSS } from './panelStyles.js';
import { panelSummary, renderPanel } from './panelView.js';

const HTMLElementBase = globalThis.HTMLElement ?? class {};

export class BmcLivePanel extends HTMLElementBase {
  static get observedAttributes() {
    return PANEL_ATTRIBUTES;
  }

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    this._mount = document.createElement('div');
    // A status region that stays in place across renders: it announces a new
    // answer once (the rendered tree is replaced on every state change).
    this._status = document.createElement('p');
    this._status.className = 'p-sr';
    this._status.setAttribute('role', 'status');
    this._summary = null;
    root.append(style, this._status, this._mount);
    this._controller = createPanelController({
      createClient: createPanelClient,
      onState: (state) => this._render(state)
    });
  }

  connectedCallback() {
    this._controller.setInputs(readPanelInputs((name) => this.getAttribute(name)));
    this._controller.connect();
  }

  disconnectedCallback() {
    this._controller.disconnect();
  }

  attributeChangedCallback(_name, previous, next) {
    if (previous !== next) {
      this._controller.setInputs(readPanelInputs((name) => this.getAttribute(name)));
    }
  }

  /** Replace the data client (tests and demos); `null` goes back to `api-base`. */
  set client(client) {
    this._controller.setClient(client);
  }

  /** The panel's current state (phase, view model, error), for hosts and tests. */
  get state() {
    return this._controller.state;
  }

  /** Look the case up again now. */
  refresh() {
    this._controller.refresh();
  }

  _render(state) {
    // Every render replaces the tree; a focused link keeps the focus (the
    // version check re-renders on window focus, exactly when a keyboard user
    // comes back).
    const focused = this.shadowRoot?.activeElement?.getAttribute?.('data-focus-key') ?? null;
    this._mount.replaceChildren(materialize(renderPanel(state), document));
    if (focused) {
      const target = [...this._mount.querySelectorAll('[data-focus-key]')].find((node) => node.getAttribute('data-focus-key') === focused);
      target?.focus({ preventScroll: true });
    }
    const summary = panelSummary(state);
    if (summary !== null && summary !== this._summary) {
      this._summary = summary;
      this._status.textContent = summary;
    }
  }
}

export const PANEL_TAG = 'bmc-live-panel';

/** Defines <bmc-live-panel> once (a page may load the script twice). */
export function defineLivePanel(registry = globalThis.customElements) {
  if (registry && !registry.get(PANEL_TAG)) {
    registry.define(PANEL_TAG, BmcLivePanel);
  }
}
