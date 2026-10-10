import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Fonts are bundled (offline, no external requests): only the weights we use. Each weight file declares
// unicode-range per subset, so the browser downloads just the subsets a page needs (Arabic + Latin in practice).
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/noto-naskh-arabic/400.css';
import '@fontsource/noto-naskh-arabic/600.css';
import './design/tokens.css';
import './design/base.css';
import './design/components.css';
import './app/shell.css';
import { applyAppearance, appearanceStore } from './design';
import { App } from './app/App';
import { installErrorReporter } from './lib/errorReporter';
import { lastKnownAuthenticated } from './lib/auth';

// Apply the stored appearance before the first render (no flash of the wrong theme / text size).
applyAppearance(appearanceStore.get());
// §56 client error tracking (redacted, batched, owner session only — lib/errorReporter.ts)
installErrorReporter(window, { canSend: lastKnownAuthenticated });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
