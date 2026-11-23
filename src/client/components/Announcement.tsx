import { useEffect, useState } from 'react';
import { socket } from '../socket';

/** A big message the admin sent to everyone in the room. Fades after a few seconds, or on tap. */
export function Announcement() {
  const [msg, setMsg] = useState<{ text: string; at: number } | null>(null);
  useEffect(() => {
    let h: ReturnType<typeof setTimeout> | undefined;
    const on = (m: { text: string; at: number }) => {
      setMsg(m);
      clearTimeout(h);
      h = setTimeout(() => setMsg(null), 6000);
    };
    // An admin's "shake": the whole page wobbles for a moment.
    let sh: ReturnType<typeof setTimeout> | undefined;
    const shake = () => {
      const el = document.documentElement;
      el.classList.remove('troll-shake');
      void el.offsetWidth; // restart the animation if it's already running
      el.classList.add('troll-shake');
      clearTimeout(sh);
      sh = setTimeout(() => el.classList.remove('troll-shake'), 900);
    };
    socket.on('announce', on);
    socket.on('shake', shake);
    return () => { socket.off('announce', on); socket.off('shake', shake); clearTimeout(h); clearTimeout(sh); };
  }, []);
  if (!msg) return null;
  return (
    <div className="announce" role="alert" onClick={() => setMsg(null)}>
      <div key={msg.at} className="announce-text">{msg.text}</div>
    </div>
  );
}
