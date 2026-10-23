import React from 'react';
import ReactDOM from 'react-dom/client';
import { createAppDataClient } from './api/appDataClient.js';
import { DataClientProvider } from './api/DataClientProvider.jsx';
import AtlasApp from './app/AtlasApp.jsx';
import { withProfileDefaults } from './app/profileDefaults.js';
import { parseStartupParams } from './app/startupParams.js';
import { profileStore } from './features/profile/profile.js';
import './styles/index.css';

// ?version=staged:<upload_id> opens the atlas on an unpublished update (Preview on atlas).
// "Your defaults" fill what the URL leaves open; the URL wins (profileDefaults.js).
const startup = withProfileDefaults(parseStartupParams(window.location.search), profileStore().get().defaults);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DataClientProvider client={createAppDataClient({ version: startup.version })}>
      <AtlasApp startup={startup} />
    </DataClientProvider>
  </React.StrictMode>
);
