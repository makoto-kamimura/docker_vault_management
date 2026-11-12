import qrcode from 'qrcode-generator';
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { errorMessage, ja } from '../i18n/ja';
import { call, type Status, themeStyle } from '../popup/api';
import '../styles/page.css';
import { pageThemeCss } from '../styles/tokens';

themeStyle(pageThemeCss);

function Qr({ text }: { text: string }) {
  // Generated locally; drawn as SVG rects (no network, no innerHTML).
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const cells: React.ReactElement[] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c))
        cells.push(<rect key={`${r}-${c}`} x={c + 4} y={r + 4} width="1" height="1" />);
  return (
    <svg
      role="img"
      aria-label={ja.options.pairingQrLabel}
      viewBox={`0 0 ${n + 8} ${n + 8}`}
      width="260"
      height="260"
      shapeRendering="crispEdges"
      style={{ background: '#fff', borderRadius: 8 }}
    >
      <g fill="#000">{cells}</g>
    </svg>
  );
}

function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [url, setUrl] = useState('');
  const [qr, setQr] = useState<{ text: string; expiresAt: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    const r = await call<Status>({ type: 'status' });
    if (r.ok) {
      setStatus(r.data);
      setUrl((u) => (u === '' ? (r.data.serverUrl ?? '') : u));
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 12.4: the screen polls every 2 s while a pairing is open
  useEffect(() => {
    if (qr === null) return;
    const t = setInterval(async () => {
      const r = await call<{ state: string }>({ type: 'pair-poll' });
      if (!r.ok) return setMsg(errorMessage(r.error));
      if (r.data.state === 'paired') {
        setQr(null);
        setMsg(ja.options.pairingDone);
        await refresh();
      } else if (r.data.state === 'expired') {
        setQr(null);
        setMsg(ja.options.pairingExpired);
      } else if (r.data.state === 'failed') {
        setQr(null);
        setMsg(ja.options.pairingFailed);
      }
    }, 2000);
    return () => clearInterval(t);
  }, [qr, refresh]);

  const start = async () => {
    setMsg(null);
    const check = await call<{ origin: string }>({ type: 'check-server-url', url });
    if (!check.ok) return setMsg(ja.options.serverInvalid);
    // Request access to the server origin ONLY (user gesture: this click).
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [`${check.data.origin}/*`] });
    } catch {
      granted = false;
    }
    if (!granted) return setMsg(ja.options.permissionDenied);
    const r = await call<{ qr: string; expiresAt: number }>({
      type: 'pair-start',
      url: check.data.origin,
    });
    if (!r.ok) return setMsg(errorMessage(r.error));
    setQr({ text: r.data.qr, expiresAt: r.data.expiresAt });
    await refresh();
  };

  if (status === null) return <p>{ja.common.loading}</p>;
  const choices: [string, 30 | 60 | 120 | null][] = [
    ['30', 30],
    ['60', 60],
    ['120', 120],
    ['never', null],
  ];
  return (
    <main className="wrap lv-stack" style={{ gap: 24 }}>
      <h1 style={{ fontSize: 22 }}>{ja.options.title}</h1>
      {msg && (
        <div className="lv-banner" role="status">
          {msg}
        </div>
      )}

      <section className="lv-card lv-stack" aria-labelledby="h-server">
        <h2 id="h-server" style={{ fontSize: 16 }}>
          {ja.options.serverSection}
        </h2>
        <label htmlFor="server">{ja.options.serverLabel}</label>
        <input
          id="server"
          className="lv-input"
          type="url"
          inputMode="url"
          value={url}
          disabled={status.paired}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://vault.example.com"
          aria-describedby="server-help"
        />
        <p id="server-help" className="lv-muted lv-small">
          {ja.options.serverHelp}
        </p>
      </section>

      <section className="lv-card lv-stack" aria-labelledby="h-pair">
        <h2 id="h-pair" style={{ fontSize: 16 }}>
          {ja.options.pairingSection}
        </h2>
        {status.paired ? (
          <>
            <p>{ja.options.pairedAs(status.deviceName ?? '')}</p>
            <button
              type="button"
              className="lv-btn danger"
              onClick={async () => {
                if (!window.confirm(ja.options.unpairConfirm)) return;
                await call({ type: 'unpair' });
                setQr(null);
                await refresh();
              }}
            >
              {ja.options.unpair}
            </button>
          </>
        ) : qr === null ? (
          <>
            <p className="lv-muted">{ja.options.pairingHelp}</p>
            <button type="button" className="lv-btn primary" onClick={start}>
              {ja.options.pairingStart}
            </button>
          </>
        ) : (
          <div className="lv-stack" style={{ alignItems: 'center' }} aria-live="polite">
            <Qr text={qr.text} />
            <p className="lv-muted lv-small">
              {ja.options.pairingExpires(Math.max(0, Math.ceil((qr.expiresAt - now) / 1000)))}
            </p>
            <button
              type="button"
              className="lv-btn"
              onClick={async () => {
                await call({ type: 'pair-cancel' });
                setQr(null);
                await refresh();
              }}
            >
              {ja.common.cancel}
            </button>
          </div>
        )}
        {status.notice?.kind === 'revoked' && (
          <p className="lv-banner danger" role="alert">
            {ja.warnings.revoked}
          </p>
        )}
      </section>

      <section className="lv-card lv-stack" aria-labelledby="h-clip">
        <h2 id="h-clip" style={{ fontSize: 16 }}>
          {ja.options.clipboardSection}
        </h2>
        <label htmlFor="clip">{ja.options.clipboardLabel}</label>
        <select
          id="clip"
          className="lv-input"
          value={status.clipboardClearSec === null ? 'never' : String(status.clipboardClearSec)}
          onChange={async (e) => {
            const c = choices.find(([k]) => k === e.target.value);
            await call({ type: 'set-clipboard-clear', sec: c ? c[1] : 60 });
            await refresh();
          }}
        >
          {choices.map(([k]) => (
            <option key={k} value={k}>
              {ja.options.clipboardChoices[k as keyof typeof ja.options.clipboardChoices]}
            </option>
          ))}
        </select>
        <p className="lv-muted lv-small">{ja.options.clipboardNote}</p>
      </section>

      <section className="lv-stack" aria-labelledby="h-about">
        <h2 id="h-about" style={{ fontSize: 16 }}>
          {ja.options.aboutSection}
        </h2>
        <p className="lv-muted lv-small">{ja.options.aboutBody}</p>
      </section>
    </main>
  );
}

const style = document.createElement('style');
style.textContent = '.wrap{max-width:560px;margin:0 auto;padding:32px 16px}';
document.head.append(style);
createRoot(document.getElementById('root') as HTMLElement).render(<App />);
