import { useState } from 'react';
import { useAccount } from '../account';
import { AccountDialog } from './Account';
import { Icon, type IconName } from './Icon';

export type PhoneTab = 'play' | 'boards' | 'friends' | 'profile' | null;

/**
 * Bottom navigation on phones (hidden on wider screens): Play · Leaderboards · Friends · Profile.
 * Shown on the home screen, profiles, leaderboards and the help and privacy pages, never inside a room.
 * (Today's challenge is already a card in the middle of the home screen.)
 */
export function PhoneTabs({ active }: { active: PhoneTab }) {
  const { me } = useAccount();
  const [login, setLogin] = useState(false);
  const onHome = location.pathname === '/' || location.pathname === '/daily' || location.pathname === '/survival';

  const friends = () => window.dispatchEvent(new Event('qb-open-friends'));
  const profile = () => { if (me) location.href = `/u/${me.username}`; else setLogin(true); };

  const item = (id: Exclude<PhoneTab, null>, icon: IconName, label: string, onClick: () => void) => (
    <button key={id} className={active === id ? 'on' : ''} aria-current={active === id ? 'page' : undefined} onClick={onClick}>
      <Icon name={icon} /><span>{label}</span>
    </button>
  );

  return (
    <>
      <nav className="phone-tabs" aria-label="Main">
        {item('play', 'home', 'Play', () => { if (onHome) window.dispatchEvent(new CustomEvent('qb-home-open', { detail: null })); else location.href = '/'; })}
        {item('boards', 'trophy', 'Leaderboards', () => { if (location.pathname !== '/leaderboards') location.href = '/leaderboards'; })}
        {item('friends', 'users', 'Friends', friends)}
        {item('profile', 'user', me ? 'Profile' : 'Sign in', profile)}
      </nav>
      {login && <AccountDialog initial="login" onClose={() => setLogin(false)} />}
    </>
  );
}
