import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('root container not found');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
