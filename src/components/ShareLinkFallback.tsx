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
      setMessage(`复制失败，请手动复制：${url}`);
    }
  };

  return (
    <div className="marketplace-link-fallback">
      <button type="button" onClick={() => void copy()}>Copy {label} Link</button>
      {qr && <img src={qr} alt={`${label} link QR code`} width="176" height="176" />}
      {message && <small role="status">{message}</small>}
      <small>链接只打开同一公开修订，不会跨设备传递本机 Rig 或音频状态。</small>
    </div>
  );
}
