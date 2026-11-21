import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { toast } from './util';

export const inviteUrl = (code: string) => `${location.origin}/r/${code}`;

/** Copy the invite link, or open the share sheet on phones. */
export async function shareInvite(code: string) {
  const url = inviteUrl(code);
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.share) {
    try { await navigator.share({ title: 'Join my Trivio room', url }); return; }
    catch (e) { if ((e as Error).name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Invite link copied.'); }
  catch { toast(url); }
}

/** QR code for the invite link, always dark-on-white so phone cameras can read it in dark mode too. */
export function InviteQR({ code, size }: { code: string; size: number }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    QRCode.toString(inviteUrl(code), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
      .then(setSvg, () => setSvg(''));
  }, [code]);
  return <div className="qr" style={{ width: size, height: size }} role="img" aria-label={`QR code for ${inviteUrl(code)}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Full-screen invite for a projector or shared screen. */
export function InviteScreen({ code, onClose }: { code: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const host = location.host;
  return (
    <div className="invite-screen" role="dialog" aria-label="Invite players" onClick={onClose}>
      <button className="btn ghost icon invite-close" onClick={onClose} aria-label="Close">✕</button>
      <div className="invite-inner" onClick={(e) => e.stopPropagation()}>
        <h1>Join the game</h1>
        <p className="invite-sub">Point your phone camera at the code</p>
        <InviteQR code={code} size={Math.min(420, Math.floor(Math.min(innerWidth - 48, innerHeight * 0.5)))} />
        <p className="invite-or">or go to <b>{host}</b> and enter code</p>
        <div className="invite-code">{code}</div>
        <button className="btn" onClick={() => shareInvite(code)}>Copy link</button>
      </div>
    </div>
  );
}
