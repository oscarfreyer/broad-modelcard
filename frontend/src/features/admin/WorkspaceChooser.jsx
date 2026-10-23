import { useState } from 'react';
import HelpTip from '../../design/HelpTip.js';
import Icon from '../../design/Icon.jsx';
import { TextField } from './FormFields.jsx';
import { NO_LOGIN_NOTE, WORKSPACES } from './workspace.js';

/**
 * The Data Library's first page (CONTRACT.md §26): choose a
 * workspace. One grouped list, like iOS Settings, not a grid of cards: the
 * four roles read top to bottom, each with one line on what it does. The
 * name is optional here and asked again where a publish needs it.
 *
 * @param {object} props
 * @param {{ id: string, name: string }|null} props.current
 * @param {(choice: { id: string, name: string }) => void} props.onChoose
 */
export default function WorkspaceChooser({ current, onChoose }) {
  const [name, setName] = useState(current?.name ?? '');
  return (
    <div className="admin-page workspace-page">
      <header className="admin-page-header">
        <div className="page-title-row">
          <h1 className="admin-title">Choose a workspace</h1>
          <HelpTip label="About this page">
            <p>{NO_LOGIN_NOTE}</p>
          </HelpTip>
        </div>
      </header>

      <section className="admin-card workspace-name" aria-label="Your name">
        <TextField
          label="Your name"
          optional
          value={name}
          maxLength={80}
          placeholder="e.g. A. Custodian"
          hint="Shown with what you publish in History. Not checked: anyone can type any name."
          onChange={setName}
        />
      </section>

      <ul className="admin-card workspace-list" aria-label="Workspaces">
        {WORKSPACES.map((workspace) => (
          <li key={workspace.id}>
            <button
              type="button"
              className={`workspace-row${current?.id === workspace.id ? ' is-current' : ''}`}
              aria-current={current?.id === workspace.id ? 'true' : undefined}
              onClick={() => onChoose({ id: workspace.id, name: name.trim() })}
            >
              <span className="workspace-icon" aria-hidden="true">
                <Icon name={workspace.icon} size={22} />
              </span>
              <span className="workspace-text">
                <span className="workspace-title">{workspace.title}</span>
                <span className="workspace-detail">{workspace.detail}</span>
              </span>
              {current?.id === workspace.id ? <span className="live-chip">Current</span> : null}
              <Icon name="chevronRight" size={18} className="workspace-chevron" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
