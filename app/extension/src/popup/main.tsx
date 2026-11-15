import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { errorMessage, ja } from '../i18n/ja';
import '../styles/page.css';
import { pageThemeCss } from '../styles/tokens';
import { call, type Status, themeStyle } from './api';

themeStyle(pageThemeCss);

type Item = { id: string; title: string; username: string; matched: boolean };

function useStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const refresh = useCallback(async () => {
    const r = await call<Status>({ type: 'status' });
    if (r.ok) setStatus(r.data);
    return r;
  }, []);
  useEffect(() => {
    void refresh();
    void call({ type: 'sync' }).then(() => refresh()); // 7.8: sync when the popup opens
  }, [refresh]);
  return { status, refresh };
}

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span>{ja.popup.remaining(Math.max(0, Math.ceil((until - now) / 1000)))}</span>;
}

function Locked({ status, refresh }: { status: Status; refresh: () => Promise<unknown> }) {
  const [msg, setMsg] = useState<string | null>(null);
  const pending = status.pending?.kind === 'unlock' ? status.pending : null;
  const hasPending = pending !== null;

  // 12.4: the screen polls every 2 s; the worker does a short GET each time.
  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(async () => {
      const r = await call<{ state: string; reason?: string }>({ type: 'unlock-poll' });
      if (!r.ok) {
        setMsg(errorMessage(r.error));
        return;
      }
      if (r.data.state === 'denied') setMsg(ja.popup.denied);
      else if (r.data.state === 'expired') setMsg(ja.popup.expired);
      else if (r.data.state === 'failed')
        setMsg(r.data.reason === 'bad_vk' ? ja.popup.failedBadVk : ja.popup.failedOther);
      await refresh();
    }, 2000);
    return () => clearInterval(t);
  }, [hasPending, refresh]);

  const start = async () => {
    setMsg(null);
    const r = await call({ type: 'unlock-start' });
    if (!r.ok) setMsg(errorMessage(r.error));
    await refresh();
  };
  const cancel = async () => {
    await call({ type: 'unlock-cancel' });
    await refresh();
  };

  if (!status.paired) {
    return (
      <div className="lv-stack">
        <p>{ja.popup.notPaired}</p>
        <button
          type="button"
          className="lv-btn primary"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          {ja.popup.openOptions}
        </button>
      </div>
    );
  }
  if (pending !== null) {
    return (
      <div className="lv-stack" aria-live="polite">
        <h2 style={{ fontSize: 15 }}>{ja.popup.waitingTitle}</h2>
        <p className="lv-muted lv-small">{ja.popup.waitingHelp}</p>
        <div className="lv-code" role="status">
          <span className="lv-sr">{ja.popup.codeLabel}</span>
          {pending.code}
        </div>
        <p className="lv-muted lv-small" style={{ textAlign: 'center' }}>
          <Countdown until={pending.expiresAt} />
        </p>
        <button type="button" className="lv-btn" onClick={cancel}>
          {ja.popup.cancelRequest}
        </button>
        {msg && <p role="alert">{msg}</p>}
      </div>
    );
  }
  return (
    <div className="lv-stack">
      {msg && (
        <p role="alert" className="lv-banner danger">
          {msg}
        </p>
      )}
      <button type="button" className="lv-btn primary" onClick={start}>
        {ja.popup.unlockButton}
      </button>
    </div>
  );
}

function Unlocked({ status, refresh }: { status: Status; refresh: () => Promise<unknown> }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [tabId, setTabId] = useState<number | undefined>(undefined);

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then((t) => setTabId(t[0]?.id));
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch the list after each sync
  useEffect(() => {
    void call<Item[]>({ type: 'list', query, ...(tabId !== undefined ? { tabId } : {}) }).then(
      (r) => {
        if (r.ok) setItems(r.data);
        else void refresh();
      },
    );
  }, [query, tabId, status.itemCount, status.lastSyncedAt, refresh]);

  const copy = async (it: Item, field: 'username' | 'password') => {
    const r = await call<{ value: string }>({ type: 'copy', id: it.id, field });
    if (!r.ok) {
      setToast(errorMessage(r.error));
      await refresh();
      return;
    }
    try {
      await navigator.clipboard.writeText(r.data.value);
    } catch {
      setToast(ja.warnings.generic);
      return;
    }
    const s = await call({ type: 'schedule-clipboard-clear' });
    void s;
    setToast(
      status.clipboardClearSec === null
        ? ja.popup.clipboardKeeps
        : ja.popup.clipboardClears(status.clipboardClearSec),
    );
    if (status.singleUse) await refresh();
  };

  const matched = items.filter((i) => i.matched);
  const rest = items.filter((i) => !i.matched);
  const row = (i: Item) => (
    <li key={i.id} className="row-item">
      <div className="who">
        <div className="t">{i.title}</div>
        <div className="u lv-muted lv-small">{i.username}</div>
      </div>
      <button
        type="button"
        className="lv-btn small"
        aria-label={ja.popup.copyUsernameFor(i.title)}
        onClick={() => copy(i, 'username')}
      >
        {ja.popup.copyUsername}
      </button>
      <button
        type="button"
        className="lv-btn small"
        aria-label={ja.popup.copyPasswordFor(i.title)}
        onClick={() => copy(i, 'password')}
      >
        {ja.popup.copyPassword}
      </button>
    </li>
  );

  return (
    <div className="lv-stack">
      <input
        className="lv-input"
        type="search"
        placeholder={ja.popup.searchPlaceholder}
        aria-label={ja.popup.searchLabel}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {items.length === 0 && (
        <p className="lv-muted">{query ? ja.popup.noMatches : ja.popup.noItems}</p>
      )}
      {matched.length > 0 && (
        <section aria-label={ja.popup.thisSite}>
          <h2 className="lv-small lv-muted">{ja.popup.thisSite}</h2>
          <ul className="list">{matched.map(row)}</ul>
        </section>
      )}
      {rest.length > 0 && (
        <section aria-label={ja.popup.allItems}>
          {matched.length > 0 && <h2 className="lv-small lv-muted">{ja.popup.allItems}</h2>}
          <ul className="list">{rest.map(row)}</ul>
        </section>
      )}
      <div aria-live="polite" className="lv-small lv-muted" style={{ minHeight: 18 }}>
        {toast}
      </div>
      {status.skipped > 0 && (
        <p className="lv-small lv-muted">{ja.popup.skipped(status.skipped)}</p>
      )}
      <div className="lv-row">
        <button
          type="button"
          className="lv-btn small"
          onClick={async () => {
            await call({ type: 'lock' });
            await refresh();
          }}
        >
          {ja.popup.lockButton}
        </button>
        <span className="lv-small lv-muted" style={{ marginLeft: 'auto' }}>
          {status.singleUse ? ja.popup.sessionSingle : null}
        </span>
      </div>
    </div>
  );
}

function Warning({ status, refresh }: { status: Status; refresh: () => Promise<unknown> }) {
  const [err, setErr] = useState<string | null>(null);
  const notice =
    status.notice?.kind === 'revoked'
      ? ja.warnings.revoked
      : status.notice?.kind === 'account_deleted'
        ? ja.warnings.accountDeleted
        : status.notice?.kind === 'unpaired'
          ? ja.warnings.unpaired
          : null;
  return (
    <>
      {status.warning && (
        <div className="lv-banner danger" role="alert">
          <strong>{ja.warnings.rollbackTitle}</strong>
          <p className="lv-small">{ja.warnings.rollbackBody}</p>
          <button
            type="button"
            className="lv-btn small"
            onClick={async () => {
              if (!window.confirm(ja.warnings.acceptConfirm)) return;
              const r = await call({ type: 'accept-server-state' });
              if (!r.ok) setErr(errorMessage(r.error));
              await refresh();
            }}
          >
            {ja.warnings.acceptServer}
          </button>
          {err && <p role="alert">{err}</p>}
        </div>
      )}
      {notice && !status.paired && (
        <div className="lv-banner" role="status">
          {notice}
        </div>
      )}
    </>
  );
}

function App() {
  const { status, refresh } = useStatus();
  useEffect(() => {
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);
  if (status === null) return <p className="lv-muted">{ja.common.loading}</p>;
  return (
    <main className="lv-stack">
      <header className="lv-row">
        <h1 style={{ fontSize: 16 }}>{ja.appName}</h1>
        <span
          className="lv-small"
          style={{
            marginLeft: 'auto',
            color: status.locked ? 'var(--lv-color-text-secondary)' : 'var(--lv-color-success)',
          }}
        >
          {status.locked ? ja.popup.lockedTitle : ja.popup.unlockedTitle}
        </span>
        <button
          type="button"
          className="lv-btn small"
          aria-label={ja.popup.openOptions}
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          ⚙
        </button>
      </header>
      <Warning status={status} refresh={refresh} />
      {status.locked ? (
        <Locked status={status} refresh={refresh} />
      ) : (
        <Unlocked status={status} refresh={refresh} />
      )}
      {status.paired && (
        <footer className="lv-small lv-muted">
          {status.lastSyncedAt !== null && (
            <span>
              {ja.popup.syncedAt(new Date(status.lastSyncedAt).toLocaleTimeString('ja-JP'))}
            </span>
          )}
        </footer>
      )}
    </main>
  );
}

const style = document.createElement('style');
style.textContent = `body{width:360px;min-height:200px;padding:16px}
.list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.row-item{display:flex;align-items:center;gap:6px;padding:8px;border:1px solid var(--lv-color-border);border-radius:10px;background:var(--lv-color-surface)}
.row-item .who{flex:1;min-width:0}.row-item .t{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row-item .u{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;
document.head.append(style);
createRoot(document.getElementById('root') as HTMLElement).render(<App />);
