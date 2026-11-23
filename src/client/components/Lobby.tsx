import { useState } from 'react';
import type { BotSkill, PublicState } from '../../shared/types';
import { BOT_SKILLS } from '../../shared/types';
import { InviteQR, inviteUrl, shareInvite } from './Invite';
import { act, roles, toast } from './util';
import { TitleTag, Verified } from './Account';
import { partyOn } from './SettingsPanel';
import { Icon } from './Icon';
import { Info } from './Info';
import { PresetPicker } from './Presets';

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
  const set = s.settings;

  return (
    <div className="card lobby">
      <div className="row between lobby-top">
        <h2>Lobby</h2>
        <RoleChip s={s} />
      </div>
      <NameBox s={s} fresh={fresh} onRename={onRename} />

      <section className="lobby-step">
        <h3><span className="step-num">1</span> Invite people</h3>
        <div className="invite-box">
          <InviteQR code={s.code} size={120} />
          <div className="invite-box-text">
            <p className="muted small">Anyone who scans the code or opens the link joins this room. The room code is <b className="mono">{s.code}</b>.</p>
            <code className="invite-link">{inviteUrl(s.code).replace(/^https?:\/\//, '')}</code>
            <div className="row gap wrap">
              <button className="btn" onClick={() => shareInvite(s.code)}>Copy link</button>
              <button className="btn ghost" onClick={onBigInvite}>Show QR full screen</button>
              <button className="btn ghost" onClick={onBigScreen} title="Opens a scoreboard and question view for a projector or TV"><Icon name="screen" /> Big-screen view</button>
            </div>
          </div>
        </div>
      </section>

      <section className="lobby-step">
        <h3><span className="step-num">2</span> Choose how to play</h3>
        {r.isController && !r.fixed && (
          <>
            <p className="muted small">Pick a preset, or set every rule yourself in Room settings.</p>
            <PresetPicker settings={s.settings} canApply />
          </>
        )}
        <h4>{r.isController ? 'Rules right now' : 'Rules for this game'}</h4>
        <ul className="facts">
          <li>{set.mode === 'teams' ? <span className="nw">Teams of up to 4<Info term="teams" /></span> : party ? <>Party: everyone for themselves, <span className="nw">voting on topics<Info term="party" /></span></> : <span className="nw">Free-for-all<Info term="ffa" /></span>}</li>
          <li>
            {set.powers ? <span className="nw">Powers {set.powerValue}<Info term="power" /></span> : 'No powers'} · <span className="nw">{set.tenValue} per tossup<Info term="tossup" /></span> · {set.negs ? <span className="nw">negs {set.negValue}<Info term="neg" /></span> : 'no negs'}
            {set.bounty && <> · <span className="nw">bounty tossups<Info term="bounty" /></span></>}
          </li>
          <li>{set.bonuses ? <>Bonuses on <span className="nw">({set.bonusSeconds}s per part)<Info term="bonus" /></span></> : 'Tossups only, no bonuses'}</li>
          <li>{set.gameLength ? `${set.gameLength} tossups` : 'No set length: plays until the host ends it'} · {set.wpm} wpm · {set.answerSeconds}s to answer</li>
          <li>{sourceLabel}{f.categories.length || f.topics?.length ? ` · ${[...(f.topics ?? []), ...f.categories].join(', ')}` : ' · all categories'}</li>
        </ul>
        {r.isController && !r.fixed && <div className="row gap"><button className="btn" onClick={onSettings}>Room settings…</button></div>}

        {set.mode === 'teams' && (
          <>
            <h4>Teams</h4>
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
                          <span className="gm-name">{p?.name}<Verified username={p?.username} admin={p?.admin} /><TitleTag title={p?.title} />{t.captainId === id && <span className="badge">captain<Info term="captain" /></span>}</span>
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

        <details className="lobby-more" open={!!reader}>
          <summary>Reader <span className="muted small">(optional){reader ? ` · ${reader.name}` : ''}</span></summary>
          {reader ? (
            <p><b>{reader.name}</b> will read the questions aloud and run the game{r.isReader ? ' (that’s you!)' : ''}.{r.isReader && <span className="muted small"> You can change settings and questions at any time, set up teams and captains, rule on answers and protests, and pause or end the match.</span>}</p>
          ) : (
            <p className="muted small">With no reader, the app shows each question word by word. A reader sees every question early, reads it out loud (in person or on a call), sets the pace and rules on answers.<Info term="reader" /></p>
          )}
          {reader && s.settings.topicVote && <p className="muted small">While someone holds the reader seat, there’s no topic vote.</p>}
          <div className="row gap">
            {!s.readerId && <button className="btn small" onClick={() => act('reader:set', r.me)}>Be the reader</button>}
            {r.isReader && <button className="btn small ghost" onClick={() => act('reader:set', null)}>Leave reader seat</button>}
            {r.isHost && reader && !r.isReader && <button className="btn small ghost" onClick={() => act('reader:set', null)}>Remove reader</button>}
          </div>
        </details>

        <BotsPanel s={s} />
      </section>

      <section className="lobby-step">
        <h3><span className="step-num">3</span> Start</h3>
        <div className="row gap start-row">
          {r.isController ? (
            <button className="btn primary big" onClick={() => act('game:start')}>Start game</button>
          ) : (
            <p className="muted">Waiting for {s.readerId ? 'the reader' : 'the host'} to start…</p>
          )}
        </div>
      </section>
    </div>
  );
}

/** Who you are in this room, and what that lets you do. */
function RoleChip({ s }: { s: PublicState }) {
  const r = roles(s);
  const host = s.players.find((p) => p.id === s.hostId)?.name;
  const [label, term, tip] = r.isReader
    ? ['You’re the reader', 'reader' as const, 'You read the questions aloud and rule on answers.']
    : r.isHost
      ? ['You’re the host', 'host' as const, 'You choose the rules and start the game.']
      : [`You’re playing${host ? ` · ${host} is the host` : ''}`, null, ''];
  return (
    <span className="role-chip" title={tip || undefined}>
      {label}{term && <Info term={term} />}
    </span>
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
            <span className="gm-name">{p.name}<Verified username={p.username} admin={p.admin} /><TitleTag title={p.title} /></span>
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
    <details className="lobby-more bots" open={bots.length > 0}>
      <summary>Computer opponents <span className="muted small">(optional){bots.length ? ` · ${bots.length}` : ''}</span></summary>
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
    </details>
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
