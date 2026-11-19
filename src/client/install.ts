import { useEffect, useState } from 'react';

// "Install BuzzBowl" support: Android/desktop Chrome fire `beforeinstallprompt`; iPhone Safari needs
// Share → Add to Home Screen, so we show a short hint there instead.

interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function registerApp() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as BeforeInstallPromptEvent; notify(); });
  window.addEventListener('appinstalled', () => { deferred = null; notify(); });
  // Skipped on localhost (so development always loads fresh code) unless ?sw is in the address.
  if ('serviceWorker' in navigator && (location.hostname !== 'localhost' || new URLSearchParams(location.search).has('sw'))) {
    window.addEventListener('load', () => { navigator.serviceWorker?.register('/sw.js').catch(() => { /* still works as a website */ }); });
  }
}

/** What the Install button should do on this device: a real prompt, an iPhone hint, or nothing. */
export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  if (isStandalone()) return { mode: 'installed' as const };
  if (deferred) {
    return {
      mode: 'prompt' as const,
      install: async () => {
        const e = deferred;
        if (!e) return;
        await e.prompt();
        await e.userChoice.catch(() => null);
        deferred = null;
        notify();
      },
    };
  }
  if (isIos()) return { mode: 'ios' as const };
  return { mode: 'none' as const };
}
