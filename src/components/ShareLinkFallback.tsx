import { useEffect, useState } from 'react';

export function ShareLinkFallback({ pathname, label = 'Tone' }: {
  pathname: string;
  label?: string;
}) {
  const url = new URL(pathname, window.location.origin).toString();
  const [qr, setQr] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    void import('qrcode').then(({ default: QRCode }) => (
      QRCode.toDataURL(url, { margin: 1, width: 176 })
    )).then((value) => {
      if (active) setQr(value);
    }).catch(() => {
      if (active) setQr('');
    });
    return () => { active = false; };
  }, [url]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setMessage(`${label} link copied`);
    } catch {
      setMessage(`Copy failed — copy it manually: ${url}`);
    }
  };

  return (
    <div className="marketplace-link-fallback">
      <button type="button" className="mk-btn mk-btn--ghost" onClick={() => void copy()}>Copy {label} Link</button>
      {qr && <img src={qr} alt={`${label} link QR code`} width="176" height="176" />}
      {message && <small role="status">{message}</small>}
      <small>The link opens the same public revision only — it does not transfer your local Rig or audio state across devices.</small>
    </div>
  );
}
