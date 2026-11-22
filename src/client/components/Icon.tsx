/**
 * Thin line icons, drawn on a 24px grid in the text color. One consistent set instead of emoji,
 * which look different on every phone. Decorative: give the button itself a label.
 */
const PATHS = {
  dice: <><rect x="3.5" y="3.5" width="17" height="17" rx="4" /><g className="ic-fill"><circle cx="8.5" cy="8.5" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="15.5" cy="15.5" r="1.3" /></g></>,
  screen: <><rect x="2.5" y="4" width="19" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2c2.1.7 3.5 2.7 3.5 5.8" /></>,
  shield: <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z" />,
  volume: <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18.2 6.3a7.8 7.8 0 0 1 0 11.4" />,
  mute: <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5" />,
  qr: <><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1" /><rect x="14" y="3.5" width="6.5" height="6.5" rx="1" /><rect x="3.5" y="14" width="6.5" height="6.5" rx="1" /><path d="M14 14h3v3h-3zM20.5 17v3.5M17 20.5h3.5" /></>,
  list: <><path d="M8.5 6h12M8.5 12h12M8.5 18h12" /><g className="ic-fill"><circle cx="4.5" cy="6" r="1.2" /><circle cx="4.5" cy="12" r="1.2" /><circle cx="4.5" cy="18" r="1.2" /></g></>,
  sliders: <><path d="M4 7h9.5M18.5 7H20M4 17h3.5M12.5 17H20" /><circle cx="16" cy="7" r="2.3" /><circle cx="10" cy="17" r="2.3" /></>,
  contrast: <><circle cx="12" cy="12" r="8.5" /><path className="ic-fill" d="M12 3.5a8.5 8.5 0 0 1 0 17z" /></>,
  text: <path d="M3 18.5 7.5 6.5l4.5 12M4.7 14.5h5.6M13.8 18.5l3.2-8 3.2 8M14.9 15.8h4.2" />,
  flag: <path d="M5.5 21V4M5.5 4.5h11l-2.2 4 2.2 4h-11" />,
  leave: <path d="M14 4h3.5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H14M10 16l-4-4 4-4M6 12h9.5" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></>,
  pause: <path d="M9 5.5v13M15 5.5v13" />,
  play: <path className="ic-fill" d="M7.5 5.5v13l11-6.5z" />,
  bolt: <path d="M13.5 2.5 5.5 13.5h6l-1 8 8-11h-6z" />,
  eye: <><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  lock: <><rect x="5" y="11" width="14" height="9.5" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  crown: <path d="M4 19h16M4.5 15.5 3.5 7.5l5 3.8L12 5.5l3.5 5.8 5-3.8-1 8z" />,
  pin: <path d="M12 16.5V21M8.5 3.5h7M9.7 3.5v5.2L6.5 13h11l-3.2-4.3V3.5" />,
  share: <path d="M12 3.5v11M8 7.5l4-4 4 4M6.5 11v8.5h11V11" />,
  next: <path d="M9 6l6 6-6 6" />,
  back: <path d="M15 6l-6 6 6 6" />,
  user: <><circle cx="12" cy="8" r="3.8" /><path d="M4.5 20.5c0-4 3.4-6.8 7.5-6.8s7.5 2.8 7.5 6.8" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5" /><circle cx="12" cy="12" r="6.3" /></>,
  help: <><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.6a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2-2.4 3.5" /><circle className="ic-fill" cx="12" cy="16.8" r="1" /></>,
  chat: <path d="M4 5.5h16v10.5h-9l-4.5 3.5V16H4z" />,
  skip: <path d="M6 5.5 15 12l-9 6.5zM18.5 5.5v13" />,
} satisfies Record<string, JSX.Element>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg className={`ic ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
