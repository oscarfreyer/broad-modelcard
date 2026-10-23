// Interface icons: 24-unit grid, 1.75 stroke, round caps. One family for the
// toolbar, cards, and lists. Chapter glyphs are Healthicons (design/chapterIcons.js, features/atlas/ChapterIcon.jsx).

const PATHS = {
  overall: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.5v4.5l3 2" />
    </>
  ),
  performance: <path d="M3.5 12.5h3.6l2.2-5.5 4.2 10 2.4-5.4h4.6" />,
  evidence: (
    <>
      <path d="M7 3.75h7.25L18.5 8v12.25H7z" />
      <path d="M14 3.75V8.2h4.5M9.75 14.25l1.75 1.75 3.25-3.5" />
    </>
  ),
  intended_use: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <circle cx="12" cy="12" r="4.25" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" />
    </>
  ),
  population: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.75 19c.6-3.2 2.6-5 5.25-5s4.65 1.8 5.25 5" />
      <path d="M15.5 6a3 3 0 0 1 0 5.5M17.25 14.3c1.6.6 2.6 2.2 3 4.7" />
    </>
  ),
  search: (
    <>
      <circle cx="10.75" cy="10.75" r="6.25" />
      <path d="m15.4 15.4 4.85 4.85" />
    </>
  ),
  chevronDown: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  chevronUp: <path d="m6.5 14.5 5.5-5.5 5.5 5.5" />,
  menu: <path d="M5 7.5h14M5 12h14M5 16.5h14" />,
  chevronRight: <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />,
  chevronLeft: <path d="m14.5 6.5-5.5 5.5 5.5 5.5" />,
  close: <path d="m6.75 6.75 10.5 10.5M17.25 6.75 6.75 17.25" />,
  export: (
    <>
      <path d="M12 3.75v11M7.75 8 12 3.75 16.25 8" />
      <path d="M5.75 12.75v6.5h12.5v-6.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 11v5.25M12 7.75v.5" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4.25 20.5 19H3.5z" />
      <path d="M12 10v4M12 16.5v.5" />
    </>
  ),
  shield: <path d="M12 3.75 18.75 6v5.5c0 4-2.5 7-6.75 8.75C7.75 18.5 5.25 15.5 5.25 11.5V6z" />,
  retry: (
    <>
      <path d="M19 12a7 7 0 1 1-2.05-4.95" />
      <path d="M19.25 4.75V9h-4.25" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  preview: (
    <>
      <path d="M2.75 12S6.25 5.75 12 5.75 21.25 12 21.25 12 17.75 18.25 12 18.25 2.75 12 2.75 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  check: <path d="m5.5 12.5 4.25 4.25L18.5 7.5" />,
  download: (
    <>
      <path d="M12 3.75v11M7.75 10.5 12 14.75l4.25-4.25" />
      <path d="M5.75 15.75v3.5h12.5v-3.5" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15.25v-11M7.75 8.5 12 4.25l4.25 4.25" />
      <path d="M5.75 15.75v3.5h12.5v-3.5" />
    </>
  ),
  sheet: (
    <>
      <rect x="4.25" y="4.25" width="15.5" height="15.5" rx="2.5" />
      <path d="M4.25 9.5h15.5M4.25 14.5h15.5M9.75 9.5v10.25" />
    </>
  ),
  history: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.25 4.75V8.5H8M12 8v4.25l2.75 1.75" />
    </>
  ),
  models: (
    <>
      <rect x="4.25" y="4.25" width="6.5" height="6.5" rx="1.75" />
      <rect x="13.25" y="4.25" width="6.5" height="6.5" rx="1.75" />
      <rect x="4.25" y="13.25" width="6.5" height="6.5" rx="1.75" />
      <rect x="13.25" y="13.25" width="6.5" height="6.5" rx="1.75" />
    </>
  ),
  combination: (
    <>
      <circle cx="9.25" cy="12" r="5.25" />
      <circle cx="14.75" cy="12" r="5.25" />
    </>
  ),
  prevalence: <path d="M4.5 19.5h15M7 19.5v-5M12 19.5V8.5M17 19.5v-9" />,
  // A care setting (contract v1.14): a building with a cross.
  setting: (
    <>
      <path d="M5.75 19.75V8.25L12 4.5l6.25 3.75v11.5" />
      <path d="M3.75 19.75h16.5M12 9.5v5M9.5 12h5" />
    </>
  ),
  undo: (
    <>
      <path d="M9 7.25 4.75 11.5 9 15.75" />
      <path d="M4.75 11.5h9.5a5 5 0 0 1 0 10h-2" />
    </>
  ),
  externalLink: (
    <>
      <path d="M13.75 4.75h5.5v5.5M19.25 4.75l-8 8" />
      <path d="M17.25 13.75v5.5H4.75V6.75h5.5" />
    </>
  ),
  ring: <circle cx="12" cy="12" r="7.25" />,
  // A hierarchy (chapter, its groups): the Classification choice (contract v1.13).
  classification: <path d="M5.25 5.75h6.5M8.5 5.75v12.5M8.5 12h7.25M8.5 18.25h10.25" />,
  // Compare (R4): two cards side by side.
  compare: (
    <>
      <rect x="3.75" y="4.75" width="7" height="14.5" rx="2" />
      <rect x="13.25" y="4.75" width="7" height="14.5" rx="2" />
      <path d="M6.5 9h1.5M16 9h1.5M6.5 12.5h1.5M16 14h1.5" />
    </>
  ),
  copy: (
    <>
      <rect x="8.75" y="8.75" width="10.5" height="10.5" rx="2" />
      <path d="M15.25 8.75v-2a2 2 0 0 0-2-2h-6.5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 2 2h2" />
    </>
  ),
  sliders: (
    <>
      <path d="M4.5 7.5h8.25M16.75 7.5h2.75M4.5 16.5h2.75M11.25 16.5h8.25" />
      <circle cx="14.75" cy="7.5" r="2" />
      <circle cx="9.25" cy="16.5" r="2" />
    </>
  ),
  // Settings (AppHeader.jsx): a gear.
  settings: (
    <>
      <circle cx="12" cy="12" r="2.75" />
      <path d="M12 3.75v2.1M12 18.15v2.1M3.75 12h2.1M18.15 12h2.1M6.17 6.17l1.48 1.48M16.35 16.35l1.48 1.48M6.17 17.83l1.48-1.48M16.35 7.65l1.48-1.48" />
      <circle cx="12" cy="12" r="5.75" />
    </>
  ),
  // Effects on outcomes (R6): estimates with their intervals around the no-effect line.
  effect: (
    <>
      <path d="M12 4.25v15.5" />
      <path d="M4.75 9h7M10.5 15h8.75" />
      <circle cx="7.75" cy="9" r="1.75" />
      <circle cx="15" cy="15" r="1.75" />
    </>
  )
};

/**
 * @param {object} props
 * @param {keyof typeof PATHS} props.name
 * @param {number} [props.size]
 * @param {string} [props.label] accessible name; decorative when omitted
 */
export default function Icon({ name, size = 20, label, className = '' }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      focusable="false"
    >
      {PATHS[name] ?? null}
    </svg>
  );
}
