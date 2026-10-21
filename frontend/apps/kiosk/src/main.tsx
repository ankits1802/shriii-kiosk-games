import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { readConfig } from './config.ts';

const container = document.getElementById('root');
if (!container) {
  throw new Error('kiosk: #root element missing from index.html');
}

// import.meta.env.DEV is statically replaced, so dev-only code (dev panel, strict validator) is
// dropped from production bundles by dead-code elimination.
const config = readConfig(import.meta.env, import.meta.env.DEV);

createRoot(container).render(
  <StrictMode>
    <App config={config} />
  </StrictMode>,
);
