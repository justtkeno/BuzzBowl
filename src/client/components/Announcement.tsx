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
    socket.on('announce', on);
    return () => { socket.off('announce', on); clearTimeout(h); };
  }, []);
  if (!msg) return null;
  return (
    <div className="announce" role="alert" onClick={() => setMsg(null)}>
      <div key={msg.at} className="announce-text">{msg.text}</div>
    </div>
  );
}
