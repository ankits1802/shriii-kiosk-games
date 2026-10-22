import { registerAllModules } from '@shriii/kiosk-game';
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
const config = readConfig(import.meta.env, import.meta.env.DEV, location.search);

// Every bespoke episode and micro-game (the package has no import side effects).
registerAllModules();

const moduleParam = config.bridge ? new URLSearchParams(location.search).get('module') : null;
if (moduleParam !== null) {
  // Module dev harness: `?module=<id>&level=L2&lang=en-IN&seed=123` runs one module standalone.
  void import('./harness.ts').then(({ startHarness }) => startHarness(container, location.search));
} else {
  createRoot(container).render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  );
}
