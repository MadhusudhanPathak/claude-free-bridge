// Runs one operation in a claude.ai tab's content script over a port, streaming chunks back.
import { BridgeFailure } from '../../shared/src/errors';
import type { ApiChats } from '../../shared/src/protocol';
import { JOB_PORT, type TabOp, type TabOpMap, type TabReply, type TabRun } from './messages';

interface RunOptions {
  apiChats?: ApiChats;
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
}

export function runInTab<K extends TabOp>(
  tabId: number,
  op: K,
  params: TabOpMap[K]['params'],
  orgId: string,
  opts: RunOptions = {}
): Promise<TabOpMap[K]['result']> {
  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: JOB_PORT });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      finish(() => reject(new BridgeFailure('CANCELLED', 'Request cancelled')));
      port.disconnect(); // the content script aborts its fetch when the port closes
    };

    port.onMessage.addListener((m: TabReply) => {
      if (m.type === 'chunk') {
        opts.onChunk?.(m.text);
      } else if (m.type === 'result') {
        finish(() => (m.ok ? resolve(m.data as TabOpMap[K]['result']) : reject(BridgeFailure.from(m.error))));
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() =>
      finish(() => reject(new BridgeFailure('UPSTREAM_ERROR', 'The claude.ai tab was closed or reloaded during the request')))
    );
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    port.postMessage({ type: 'run', op, params, orgId, apiChats: opts.apiChats ?? 'keep' } as TabRun);
  });
}
