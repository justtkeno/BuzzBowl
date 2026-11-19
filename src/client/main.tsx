import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerApp } from './install';
import './styles.css';

registerApp();
createRoot(document.getElementById('root')!).render(<App />);
