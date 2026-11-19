import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, PublicState } from '../../shared/types';
import { act, roles } from './util';

export function Chat({ s, messages }: { s: PublicState; messages: ChatMessage[] }) {
  const r = roles(s);
  const teamsOn = s.settings.mode === 'teams' && !!r.myTeam;
  const bonusForMe = s.phase === 'bonus' && s.bonus?.teamId === r.myTeam;
  const [scope, setScope] = useState<'all' | 'team'>('all');
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => { if (bonusForMe && teamsOn) setScope('team'); }, [bonusForMe, teamsOn]);
  useEffect(() => { list.current?.scrollTo(0, list.current.scrollHeight); }, [messages.length]);

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    act('chat', text, teamsOn ? scope : 'all');
    setText('');
  };

  return (
    <div className="chat">
      <div className="messages" ref={list}>
        {messages.length === 0 && <p className="muted small">No messages yet.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.system ? 'system' : ''} ${m.scope === 'team' ? 'team' : ''}`}>
            {!m.system && <b>{m.playerName}{m.scope === 'team' ? ' (team)' : ''}: </b>}
            <span>{m.text}</span>
          </div>
        ))}
      </div>
      <form className="row gap" onSubmit={send}>
        {teamsOn && (
          <select value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'team')} aria-label="Send to">
            <option value="all">All</option>
            <option value="team">Team</option>
          </select>
        )}
        <input className="grow" value={text} maxLength={300} placeholder={scope === 'team' ? 'Message your team…' : 'Message everyone…'} onChange={(e) => setText(e.target.value)} />
        <button className="btn">Send</button>
      </form>
    </div>
  );
}
