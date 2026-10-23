// The panel's styles, inlined into its shadow root at build time: the app's
// own tokens (with :root scoped to the panel's :host) and marks, then the
// panel's layout. One token set and one mark stylesheet for the atlas and the
// panel, and nothing from the host page leaks in or out.
import tokens from '../styles/tokens.css?inline';
import marks from '../styles/marks.css?inline';
import panel from './panel.css?inline';

export const PANEL_CSS = `${tokens.replace(/:root\b/g, ':host')}\n${marks}\n${panel}`;
