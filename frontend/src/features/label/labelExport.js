// Model card downloads: the SVG is the rendered label component with
// its computed styles written onto each element, so it looks the same outside
// the app; the PDF (jsPDF, loaded on demand like the condition card export)
// embeds that SVG as a 3× JPEG on a page the size of the label (a few hundred
// KB; a PNG at that size is ~20 MB), with the card link as real, clickable
// text under it and the label's words as an invisible text layer, so the PDF
// can be searched, copied, and read aloud. No new dependency.
import { downloadBlob } from '../../shared/download.js';
import { labelText } from './labelModel.js';
import { breakWord } from './textWrap.js';

const STYLE_PROPERTIES = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'opacity',
  'vector-effect',
  'font-family',
  'font-size',
  'font-weight',
  'letter-spacing',
  'font-variant-numeric'
];

// SVG defaults; a property at its default is left out to keep the file small.
const DEFAULTS = {
  'fill-opacity': '1',
  'stroke-linecap': 'butt',
  opacity: '1',
  'stroke-dasharray': 'none'
};

/**
 * The label as a standalone SVG document: a deep clone of the rendered
 * <svg> with each element's computed presentation written inline.
 *
 * @param {SVGSVGElement} svg the label as rendered on the page
 * @returns {string}
 */
export function serializeLabelSvg(svg) {
  const clone = svg.cloneNode(true);
  const originals = [svg, ...svg.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  originals.forEach((element, index) => {
    const copy = copies[index];
    const computed = window.getComputedStyle(element);
    // 'none' is kept for fill and stroke (an unfilled or unstroked shape) and
    // dropped elsewhere, like 'normal', to keep the file small.
    const style = STYLE_PROPERTIES.map((name) => [name, computed.getPropertyValue(name)])
      .filter(([name, value]) => value && value !== 'normal' && DEFAULTS[name] !== value && (value !== 'none' || name === 'fill' || name === 'stroke'))
      // Font settings only matter on text.
      .filter(([name]) => ['text', 'tspan'].includes(element.tagName) || element === svg || (!name.startsWith('font') && name !== 'letter-spacing'))
      .map(([name, value]) => `${name}:${value}`);
    if (style.length) copy.setAttribute('style', style.join(';'));
    copy.removeAttribute('class');
  });
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`;
}

export function downloadLabelSvg(svg, stem) {
  downloadBlob(`${stem}.svg`, new Blob([serializeLabelSvg(svg)], { type: 'image/svg+xml;charset=utf-8' }));
}

/** The --card token (the label's own ground), read from the page; white if the page has none. */
function cardColour() {
  const value = globalThis.getComputedStyle?.(document.documentElement).getPropertyValue('--card').trim();
  return value || 'white';
}

function svgToJpeg(svgText, width, height, scale) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const context = canvas.getContext('2d');
      // JPEG has no transparency: the page around the label's corners takes the card colour.
      context.fillStyle = cardColour();
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.scale(scale, scale);
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    image.onerror = () => reject(new Error('The model card could not be drawn for the PDF.'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  });
}

/**
 * @param {SVGSVGElement} svg the rendered label
 * @param {ReturnType<import('./labelModel.js').buildLabelModel>} model
 * @param {string} stem file name without extension
 */
export async function downloadLabelPdf(svg, model, stem) {
  const box = svg.viewBox.baseVal;
  const [jpeg, { jsPDF }] = await Promise.all([svgToJpeg(serializeLabelSvg(svg), box.width, box.height, 3), import('jspdf')]);
  // One label-sized page: the label at 1 pt per label pixel, the link under it.
  const margin = 24;
  const width = box.width;
  const height = box.height;
  const probe = new jsPDF({ unit: 'pt', format: 'a4' });
  probe.setFont('helvetica', 'normal');
  probe.setFontSize(9);
  const fits = (value) => probe.getTextWidth(value) <= width;
  const linkLines = breakWord(model.cardUrl, fits);
  const footHeight = 22 + linkLines.length * 11 + 8;
  const doc = new jsPDF({ unit: 'pt', format: [width + margin * 2, height + margin * 2 + footHeight] });
  doc.setProperties({
    title: `Model card: ${model.systemName}, ${model.functionName} (dataset version ${model.datasetVersion})`,
    subject: model.notice,
    creator: 'Broad Modelcard'
  });
  doc.addImage(jpeg, 'JPEG', margin, margin, width, height);
  // The label's words as text over the picture: invisible, but searchable and selectable.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(doc.splitTextToSize(labelText(model).join(' '), width - 24), margin + 12, margin + 24, { renderingMode: 'invisible', lineHeightFactor: 1.2 });
  // The card link, captioned and broken after "/", "?", or "&".
  const linkTop = margin + height + 18;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(72, 72, 79);
  doc.text(model.cardUrlIsLocal ? 'Card link (opens on the computer that runs this demonstration)' : 'Card link', margin, linkTop);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(10, 102, 214);
  doc.text(linkLines, margin, linkTop + 13);
  doc.link(margin, linkTop + 4, width, linkLines.length * 11 + 2, { url: model.cardUrl });
  doc.save(`${stem}.pdf`);
}
