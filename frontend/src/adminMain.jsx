import React from 'react';
import ReactDOM from 'react-dom/client';
import { createAppDataClient } from './api/appDataClient.js';
import { DataClientProvider } from './api/DataClientProvider.jsx';
import AdminApp from './features/admin/AdminApp.jsx';
import './styles/admin-index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DataClientProvider client={createAppDataClient()}>
      <AdminApp />
    </DataClientProvider>
  </React.StrictMode>
);
