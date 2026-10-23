import React from 'react';
import ReactDOM from 'react-dom/client';
import { createAppDataClient } from './api/appDataClient.js';
import { DataClientProvider } from './api/DataClientProvider.jsx';
import { defaultDepth, withCompareDefaults } from './app/profileDefaults.js';
import CompareApp from './features/compare/CompareApp.jsx';
import { parseCompareState } from './features/compare/compareState.js';
import { profileStore } from './features/profile/profile.js';
import { DEFAULT_DEPTH } from './shared/depth.js';
import './styles/compare-index.css';

// compare.html: 2 to 4 cards side by side (contract v1.13 §25).
// The comparison reads the live data; the state lives in the URL. A URL that
// names only the cards takes the reader's defaults (lens, local population,
// classification), and one without a depth the reader's depth, as the atlas
// does for an entry link (profileDefaults.js).
const defaults = profileStore().get().defaults;
const parsed = withCompareDefaults(parseCompareState(window.location.search), window.location.search, defaults);
const readerDepth = defaultDepth(defaults);
const initialState = { ...parsed, depth: parsed.depth ?? readerDepth ?? DEFAULT_DEPTH, readerDepth };

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DataClientProvider client={createAppDataClient()}>
      <CompareApp initialState={initialState} />
    </DataClientProvider>
  </React.StrictMode>
);
