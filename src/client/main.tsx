import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerApp } from './install';
// Self-hosted fonts (bundled, so they work offline in the installed app): Plex Sans Condensed for the interface,
// Plex Mono for labels and numbers, Source Serif 4 for headings and question text.
import '@fontsource/ibm-plex-sans-condensed/latin-400.css';
import '@fontsource/ibm-plex-sans-condensed/latin-500.css';
import '@fontsource/ibm-plex-sans-condensed/latin-600.css';
import '@fontsource/ibm-plex-sans-condensed/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource-variable/source-serif-4';
import './styles.css';

registerApp();
// iPhone/iPad home-screen app: a little extra room under the status bar (see --safe-top).
if ((navigator as Navigator & { standalone?: boolean }).standalone === true) document.documentElement.classList.add('ios-app');
createRoot(document.getElementById('root')!).render(<App />);
