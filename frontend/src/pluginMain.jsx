import React from 'react';
import ReactDOM from 'react-dom/client';
import { createAppDataClient } from './api/appDataClient.js';
import { DataClientProvider } from './api/DataClientProvider.jsx';
import { defineLivePanel } from './embed/BmcLivePanel.js';
import PluginApp from './features/plugin/PluginApp.jsx';
import './styles/plugin-index.css';

// plugin.html: the live interaction demo. The
// page's own reads (the registry) use the app client; the panel brings its own.
defineLivePanel();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DataClientProvider client={createAppDataClient()}>
      <PluginApp />
    </DataClientProvider>
  </React.StrictMode>
);
