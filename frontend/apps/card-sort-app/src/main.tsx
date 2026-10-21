import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { openStore } from './data/open.ts';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

openStore()
  .then((store) => {
    createRoot(root).render(
      <StrictMode>
        <App store={store} />
      </StrictMode>,
    );
  })
  .catch((e: unknown) => {
    root.textContent = `Storage failed to open: ${e instanceof Error ? e.message : String(e)}`;
  });
