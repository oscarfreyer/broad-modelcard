import { CHAPTER_ICONS } from '../../design/chapterIcons.js';

/** A plain disc outline for a chapter without an icon of its own. */
const FALLBACK = Object.freeze({
  viewBox: '0 0 24 24',
  paths: [{ d: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm-6 8a6 6 0 1 1 12 0 6 6 0 0 1-12 0Z', evenOdd: true }]
});

/**
 * The Healthicons glyph of an ICD-11 chapter (design/chapterIcons.js), as a
 * nested SVG centred on (cx, cy), filled with currentColor.
 *
 * @param {object} props
 * @param {string} props.icon the chapter number key ("01" … "22")
 * @param {number} props.cx
 * @param {number} props.cy
 * @param {number} props.size width and height in the parent's units
 * @param {string} [props.className]
 */
export default function ChapterIcon({ icon, cx, cy, size, className = 'ring-badge-icon' }) {
  const glyph = CHAPTER_ICONS[icon] ?? FALLBACK;
  return (
    <svg x={cx - size / 2} y={cy - size / 2} width={size} height={size} viewBox={glyph.viewBox} className={className} aria-hidden="true" focusable="false">
      <g fill="currentColor">
        {glyph.paths.map((path, index) => (
          <path key={index} d={path.d} fillRule={path.evenOdd ? 'evenodd' : undefined} clipRule={path.evenOdd ? 'evenodd' : undefined} />
        ))}
      </g>
    </svg>
  );
}
