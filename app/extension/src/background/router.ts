import { ApiError } from '@localvault/protocol';
import { z } from 'zod';
import { type AlarmsApi, scheduleClipboardClear } from '../core/clipboard';
import { PcError } from '../core/errors';
import type { PcClient } from '../core/pc-client';
import type { Env } from '../core/types';
import { contentMessageSchema, type ErrorInfo, pageMessageSchema, type Response } from './messages';
import type { SenderInfo } from './sender';

export type RouterDeps = { env: Env; client: PcClient; alarms: AlarmsApi };

const RETRYABLE = new Set(['E_NETWORK', 'E_INTERNAL', 'E_RATE_LIMITED']);

/** Never leaks plaintext: only codes and fixed messages cross the boundary. */
export function toErrorInfo(e: unknown): ErrorInfo {
  if (e instanceof ApiError) {
    const info: ErrorInfo = {
      code: e.code,
      message: e.code,
      retryable: RETRYABLE.has(e.code),
    };
    if (e.code === 'E_CLOCK_SKEW' && typeof e.details?.serverTime === 'string') {
      info.details = { serverTime: e.details.serverTime };
    }
    if (e.code === 'E_RATE_LIMITED' && typeof e.details?.retryAfterSec === 'number') {
      info.details = { retryAfterSec: e.details.retryAfterSec };
    }
    return info;
  }
  if (e instanceof PcError)
    return { code: e.code, message: e.code, retryable: RETRYABLE.has(e.code) };
  if (e instanceof z.ZodError)
    return { code: 'E_BAD_MESSAGE', message: 'E_BAD_MESSAGE', retryable: false };
  return { code: 'E_INTERNAL', message: 'E_INTERNAL', retryable: true };
}

export function createRouter(deps: RouterDeps) {
  const { client, alarms, env } = deps;

  async function handleContent(raw: unknown, s: Extract<SenderInfo, { kind: 'content' }>) {
    const m = contentMessageSchema.parse(raw);
    const sender = { origin: s.origin, frameId: s.frameId };
    switch (m.type) {
      case 'hello':
        // Registers the TOP frame's browser-reported origin for the popup's "current tab" ordering.
        if (s.frameId === 0 && s.tabId !== undefined) await client.recordTab(s.tabId, s.origin);
        return {};
      case 'status': {
        const st = await client.status();
        // Content scripts only learn what the panel needs.
        return {
          paired: st.paired,
          locked: st.locked,
          pending: st.pending,
          warning: st.warning !== null,
        };
      }
      case 'candidates':
        return client.candidates(sender);
      case 'fill':
        return client.fill(sender, {
          id: m.id,
          fields: m.fields,
          insecureConfirmed: m.insecureConfirmed,
        });
      case 'unlock-start':
        return client.startUnlock();
      case 'unlock-poll':
        return client.pollUnlock();
      case 'unlock-cancel':
        await client.cancelUnlock();
        return {};
      case 'search-insecure':
        return client.searchForInsecurePage(sender, m.query);
    }
  }

  async function handlePage(raw: unknown) {
    const m = pageMessageSchema.parse(raw);
    switch (m.type) {
      case 'status':
        return client.status();
      case 'unlock-start':
        return client.startUnlock();
      case 'unlock-poll':
        return client.pollUnlock();
      case 'unlock-cancel':
        await client.cancelUnlock();
        return {};
      case 'lock':
        await client.lock('manual');
        return {};
      case 'list':
        return client.listForPopup(m.query, m.tabId);
      case 'copy':
        return { value: await client.copyValue(m.id, m.field) };
      case 'schedule-clipboard-clear':
        return { clearAt: await scheduleClipboardClear(env, alarms) };
      case 'sync':
        return client.sync();
      case 'accept-server-state':
        return client.acceptServerState();
      case 'check-server-url':
        return { origin: client.checkServerUrl(m.url) };
      case 'pair-start':
        return client.startPairing(m.url);
      case 'pair-poll':
        return client.pollPairing();
      case 'pair-cancel':
        await client.cancelPairing();
        return {};
      case 'unpair':
        await client.unpair();
        return {};
      case 'set-clipboard-clear':
        await client.setClipboardClear(m.sec);
        return {};
    }
  }

  return {
    async handle(raw: unknown, sender: SenderInfo): Promise<Response> {
      try {
        if (sender.kind === 'unknown') throw new PcError('E_BAD_SENDER');
        // Each class of sender has its OWN schema: a page can never ask for `fill`, a content
        // script can never ask for `copy` (the plaintext password only goes to extension pages
        // on explicit user action, or to a verified frame via `fill`).
        const data =
          sender.kind === 'content' ? await handleContent(raw, sender) : await handlePage(raw);
        return { ok: true, data };
      } catch (e) {
        return { ok: false, error: toErrorInfo(e) };
      }
    },
  };
}

export type Router = ReturnType<typeof createRouter>;
