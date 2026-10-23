// The embeddable panel's script: load it as a module and use the element.
//   <script type="module" src="…/bmc-live-panel.js"></script>
import { defineLivePanel } from './BmcLivePanel.js';

defineLivePanel();

export { BmcLivePanel, PANEL_TAG } from './BmcLivePanel.js';
