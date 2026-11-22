import { useState } from 'react';
import type { BotSkill, PublicState } from '../../shared/types';
import { BOT_SKILLS } from '../../shared/types';
import { InviteQR, inviteUrl, shareInvite } from './Invite';
import { act, roles, toast } from './util';
import { Verified } from './Account';
import { partyOn } from './SettingsPanel';
import { Icon } from './Icon';

interface Props {
  s: PublicState; fresh: boolean;
  onRename: (name: string) => Promise<void>; onSettings: () => void; onBigInvite: () => void; onBigScreen: () => void;
}

export function Lobby({ s, fresh, onRename, onSettings, onBigInvite, onBigScreen }: Props) {
  const r = roles(s);
  const reader = s.players.find((p) => p.id === s.readerId);
  const sourceLabel = { qbreader: 'QBReader', sample: 'Built-in questions', upload: `Uploaded packet (${s.uploadedCount?.tossups ?? 0} tossups)`, lightning: 'Lightning round' }[s.settings.source];
  const f = s.settings.filters;
  const party = partyOn(s.settings);

  return (
    <div className="card lobby">
      <h2>Lobby</h2>
      <NameBox s={s} fresh={fresh} onRename={onRename} />

      <div className="invite-box">
        <InviteQR code={s.code} size={132} />
        <div className="invite-box-text">
          <h3>Invite players</h3>
          <p className="muted small">Scan the code, or open the link. Anyone who opens it joins this room right away.</p>
          <code className="invite-link">{inviteUrl(s.code).replace(/^https?:\/\//, '')}</code>
          <div className="row gap wrap">
            <button className="btn primary" onClick={() => shareInvite(s.code)}>Copy link</button>
            <button className="btn" onClick={onBigInvite}>Show QR full screen</button>
            <button className="btn" onClick={onBigScreen} title="Opens a scoreboard and question view for a projector or TV"><Icon name="screen" /> Big-screen view</button>
          </div>
        </div>
      </div>
      <p className="muted">{s.settings.mode === 'teams' ? 'Pick a team below.' : 'Everyone plays for themselves.'}</p>

      <div className="lobby-grid">
        <div>
          <h3>Format</h3>
          <ul className="facts">
            <li>{s.settings.mode === 'teams' ? 'Teams (up to 4 each)' : party ? 'Party (free-for-all)' : 'Free-for-all'}</li>
            {s.settings.topicVote && <li>Players vote on topics</li>}
            <li>{s.settings.powers ? `Powers ${s.settings.powerValue}` : 'No powers'} · {s.settings.tenValue} · {s.settings.negs ? `negs ${s.settings.negValue}` : 'no negs'}{s.settings.bounty ? ' · bounty tossups' : ''}</li>
            <li>{s.settings.bonuses ? `Bonuses on (${s.settings.bonusSeconds}s per part)` : 'Tossups only'}</li>
            <li>{s.settings.gameLength ? `${s.settings.gameLength} tossups` : 'No set length'} · {s.settings.wpm} wpm · {s.settings.answerSeconds}s to answer</li>
            <li>{sourceLabel}{f.categories.length ? ` · ${f.categories.join(', ')}` : ' · all categories'}</li>
          </ul>
          {r.isController && (
            <div className="row gap wrap">
              <button className="btn" onClick={onSettings}>Change settings</button>
              <button className={`btn ${party ? 'ghost' : ''}`} onClick={() => act('settings:update', party ? { topicVote: false } : { mode: 'ffa', topicVote: true })}
                title="Free-for-all, and players vote on the next topic">
                {party ? 'Turn off party mode' : 'Party mode'}
              </button>
            </div>
          )}
        </div>

        <div>
          <h3>Reader</h3>
          {reader ? (
            <p><b>{reader.name}</b> will read the questions aloud and run the game{r.isReader ? ' (that’s you!)' : ''}.{r.isReader && <span className="muted small"> You can change settings and questions at any time, set up teams and captains, rule on answers and protests, and pause or end the match.</span>}</p>
          ) : (
            <p className="muted">No reader: the app shows each tossup word by word at {s.settings.wpm} wpm. A reader sees every question ahead of time, reads it out loud (in person or on a call), controls the pace, rules on answers, and decides when to move on.</p>
          )}
          {reader && s.settings.topicVote && <p className="muted small">While someone holds the reader seat, there’s no topic vote.</p>}
          {!s.readerId && <button className="btn" onClick={() => act('reader:set', r.me)}>Be the reader</button>}
          {r.isReader && <button className="btn ghost" onClick={() => act('reader:set', null)}>Leave reader seat</button>}
          {r.isHost && reader && !r.isReader && <button className="btn ghost" onClick={() => act('reader:set', null)}>Remove reader</button>}
        </div>
      </div>

      {s.settings.mode === 'teams' && (
        <>
          <h3>Teams</h3>
          <div className="teams-pick">
            {s.teams.map((t) => (
              <div key={t.id} className={`team-pick ${r.myTeam === t.id ? 'mine' : ''}`}>
                <div className="row between">
                  <TeamName s={s} teamId={t.id} name={t.name} />
                  <span className="muted small">{t.playerIds.length}/4</span>
                </div>
                <ul>
                  {t.playerIds.map((id) => {
                    const p = s.players.find((x) => x.id === id);
                    return (
                      <li key={id} className={`${p?.online ? '' : 'offline'} ${r.isController ? 'gm-row' : ''}`}>
                        <span className="gm-name">{p?.name}<Verified username={p?.username} admin={p?.admin} />{t.captainId === id && <span className="badge">captain</span>}</span>
                        {r.isController && <PlayerControls s={s} playerId={id} teamId={t.id} captain={t.captainId === id} />}
                      </li>
                    );
                  })}
                </ul>
                <div className="row gap">
                  {r.myTeam !== t.id && !r.isReader && <button className="btn small" disabled={t.playerIds.length >= 4} onClick={() => act('team:join', t.id)}>Join</button>}
                  {r.myTeam === t.id && t.captainId !== r.me && <button className="btn small ghost" onClick={() => act('team:captain')}>Be captain</button>}
                  {r.isController && s.teams.length > 2 && <button className="btn small ghost" onClick={() => act('team:remove', t.id)}>Remove</button>}
                </div>
              </div>
            ))}
            {r.isController && s.teams.length < 8 && <button className="btn ghost add-team" onClick={() => act('team:create', '')}>+ Add team</button>}
          </div>
          <Unassigned s={s} />
        </>
      )}

      <BotsPanel s={s} />

      <div className="row gap start-row">
        {r.isController ? (
          <button className="btn primary big" onClick={() => act('game:start')}>Start game</button>
        ) : (
          <p className="muted">Waiting for {s.readerId ? 'the reader' : 'the host'} to start…</p>
        )}
      </div>
    </div>
  );
}

/** Host/reader: move a player to another team, or make them captain. */
function PlayerControls({ s, playerId, teamId, captain }: { s: PublicState; playerId: string; teamId: string | null; captain?: boolean }) {
  const name = s.players.find((p) => p.id === playerId)?.name ?? 'player';
  return (
    <span className="gm-controls">
      {teamId && !captain && <button className="btn ghost small" title={`Make ${name} captain`} onClick={() => act('team:captain', playerId)}>Captain</button>}
      <select className="gm-move" aria-label={`Move ${name} to a team`} value={teamId ?? ''} onChange={(e) => act('team:move', playerId, e.target.value || null)}>
        {s.teams.map((t) => <option key={t.id} value={t.id} disabled={t.id !== teamId && t.playerIds.length >= 4}>{t.name}</option>)}
        <option value="">No team</option>
      </select>
    </span>
  );
}

/** Players in a teams game who are not on any team (and are not the reader). */
function Unassigned({ s }: { s: PublicState }) {
  const r = roles(s);
  const loose = s.players.filter((p) => !p.teamId && p.id !== s.readerId);
  if (!loose.length) return null;
  return (
    <div className="unassigned">
      <h4>Not on a team</h4>
      <ul>
        {loose.map((p) => (
          <li key={p.id} className={`${p.online ? '' : 'offline'} ${r.isController ? 'gm-row' : ''}`}>
            <span className="gm-name">{p.name}<Verified username={p.username} admin={p.admin} /></span>
            {r.isController && <PlayerControls s={s} playerId={p.id} teamId={null} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NameBox({ s, fresh, onRename }: { s: PublicState; fresh: boolean; onRename: (name: string) => Promise<void> }) {
  const current = s.players.find((p) => p.id === s.you)?.name ?? '';
  const [editing, setEditing] = useState(fresh);
  const [name, setName] = useState(current);
  const save = async () => {
    const clean = name.trim();
    if (!clean || clean === current) return setEditing(false);
    try { await onRename(clean); setEditing(false); } catch (e: any) { toast(e.message); }
  };
  if (!editing) {
    return (
      <p className="name-line">You’re playing as <b>{current}</b> <button className="btn ghost small" onClick={() => { setName(current); setEditing(true); }}>Change name</button></p>
    );
  }
  return (
    <form className="name-box" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <label htmlFor="my-name">{fresh ? 'You joined as a random name. Want to use your own?' : 'Your name'}</label>
      <div className="row gap">
        <input id="my-name" className="grow" autoFocus value={name} maxLength={24} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
        <button className="btn primary">Save</button>
        <button type="button" className="btn ghost" onClick={() => setEditing(false)}>{fresh ? 'Keep it' : 'Cancel'}</button>
      </div>
    </form>
  );
}

const SKILLS = Object.keys(BOT_SKILLS) as BotSkill[];

/** Computer players: the host adds them and picks how strong each one is. */
function BotsPanel({ s }: { s: PublicState }) {
  const r = roles(s);
  const [skill, setSkill] = useState<BotSkill>('medium');
  const bots = s.players.filter((p) => p.bot);
  if (!r.isController && !bots.length) return null;
  const teamName = (id: string | null) => s.teams.find((t) => t.id === id)?.name;
  return (
    <div className="bots">
      <h3>Bots</h3>
      {bots.length === 0 && <p className="muted small">Practice against computer players. Each bot buzzes and answers on its own, and joins a team in teams mode.</p>}
      {bots.length > 0 && (
        <ul className="bot-list">
          {bots.map((b) => (
            <li key={b.id}>
              <span className="bot-name">{b.name}</span>
              {s.settings.mode === 'teams' && teamName(b.teamId) && <span className="muted small">{teamName(b.teamId)}</span>}
              <span className="grow" />
              {r.isController ? (
                <>
                  <select aria-label={`${b.name} skill`} value={b.bot} onChange={(e) => act('bot:skill', b.id, e.target.value)}>
                    {SKILLS.map((k) => <option key={k} value={k}>{BOT_SKILLS[k].label}</option>)}
                  </select>
                  <button className="btn ghost small" aria-label={`Remove ${b.name}`} title="Remove bot" onClick={() => act('bot:remove', b.id)}><Icon name="close" /></button>
                </>
              ) : <span className="badge">{BOT_SKILLS[b.bot!].label}</span>}
            </li>
          ))}
        </ul>
      )}
      {r.isController && (
        <div className="row gap bot-add">
          <select aria-label="New bot skill" value={skill} onChange={(e) => setSkill(e.target.value as BotSkill)}>
            {SKILLS.map((k) => <option key={k} value={k}>{BOT_SKILLS[k].label} · {BOT_SKILLS[k].blurb}</option>)}
          </select>
          <button className="btn" disabled={bots.length >= 8} onClick={() => act('bot:add', skill)}>+ Add bot</button>
        </div>
      )}
    </div>
  );
}

function TeamName({ s, teamId, name }: { s: PublicState; teamId: string; name: string }) {
  const r = roles(s);
  const canEdit = r.isController || r.myTeam === teamId;
  if (!canEdit) return <b>{name}</b>;
  return (
    <input className="team-name" defaultValue={name} maxLength={24} aria-label="Team name"
      onBlur={(e) => e.target.value.trim() && e.target.value !== name && act('team:rename', teamId, e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
  );
}
