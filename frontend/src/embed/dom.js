// Turns the panel's DOM model (panelView.js) into elements. Text goes in as
// text nodes and attributes as attributes, never as HTML, so names, codes, and
// incident summaries from the API cannot inject markup into the host page.

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'circle', 'rect', 'path', 'g']);

/**
 * @param {object|string|number} node a DOM model node or text
 * @param {Document} doc
 * @returns {Node}
 */
export function materialize(node, doc) {
  if (typeof node !== 'object' || node === null) {
    return doc.createTextNode(String(node));
  }
  const element = SVG_TAGS.has(node.tag) ? doc.createElementNS(SVG_NS, node.tag) : doc.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    if (value !== null && value !== undefined && value !== false) {
      element.setAttribute(name, String(value));
    }
  }
  for (const child of node.children) {
    element.appendChild(materialize(child, doc));
  }
  return element;
}
