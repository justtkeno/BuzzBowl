import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerApp } from './install';
import './styles.css';

registerApp();
// iPhone/iPad home-screen app: a little extra room under the status bar (see --safe-top).
if ((navigator as Navigator & { standalone?: boolean }).standalone === true) document.documentElement.classList.add('ios-app');
createRoot(document.getElementById('root')!).render(<App />);
