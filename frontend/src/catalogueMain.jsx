import React from 'react';
import ReactDOM from 'react-dom/client';
import { createAppDataClient } from './api/appDataClient.js';
import { DataClientProvider } from './api/DataClientProvider.jsx';
import CatalogueApp from './features/catalogue/CatalogueApp.jsx';
import { parseCatalogueState } from './features/catalogue/catalogueState.js';
import { atlasForwardHref } from './features/catalogue/pageLinks.js';
import './styles/catalogue-index.css';

// index.html is the catalogue. A URL with atlas parameters is an
// atlas link from before the catalogue existed: forward it, query and all.
const forward = atlasForwardHref(window.location);

if (forward) {
  window.location.replace(forward);
} else {
  const initialState = parseCatalogueState(window.location.search);
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <DataClientProvider client={createAppDataClient({ version: initialState.version })}>
        <CatalogueApp initialState={initialState} />
      </DataClientProvider>
    </React.StrictMode>
  );
}
