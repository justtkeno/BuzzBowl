import { useState } from 'react';
import { useInstall } from '../install';

/** "Install app" on Android/desktop; a short Add to Home Screen hint on iPhone; nothing once installed. */
export function InstallButton() {
  const inst = useInstall();
  const [hint, setHint] = useState(false);
  if (inst.mode === 'installed' || inst.mode === 'none') return null;
  if (inst.mode === 'prompt') {
    return <button className="btn ghost install-btn" onClick={() => inst.install()}><span aria-hidden="true">＋</span> Install app</button>;
  }
  return (
    <div className="install-ios">
      <button className="btn ghost install-btn" onClick={() => setHint(!hint)} aria-expanded={hint}><span aria-hidden="true">＋</span> Add to Home Screen</button>
      {hint && (
        <p className="muted small">In Safari, tap <b>Share</b> <span aria-label="share icon">⬆︎</span>, then <b>Add to Home Screen</b>. Trivio opens full-screen like an app.</p>
      )}
    </div>
  );
}
