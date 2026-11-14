// main.ts — entrypoint and trial lifecycle:
//  1. bind an ephemeral port (never 8080),
//  2. register it with POST $MAKEFUN_ENV_URL/register,
//  3. poll GET $MAKEFUN_ENV_URL/done until it answers {"done":true},
//  4. exit 0.
// Without MAKEFUN_ENV_URL the process exits 1 at once. Failed register and
// poll attempts are retried with a short exponential backoff.
import { Store } from './store.ts';
import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (!envUrl) {
  console.error('MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

const token = process.env.MAKEFUN_SHOP_TOKEN ?? null;
const store = new Store();
const server = createApp(store, token);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function register(port: number): Promise<void> {
  const base = envUrl.replace(/\/$/, '');
  let delay = 100;
  for (;;) {
    try {
      const res = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 200 || res.status === 409) return; // 409: the first register already won; the base URL is set, so proceed to polling.
    } catch {
      // fall through to retry
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function pollDone(): Promise<void> {
  const base = envUrl.replace(/\/$/, '');
  let delay = 100;
  for (;;) {
    try {
      const res = await fetch(`${base}/done`, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { done?: boolean };
      if (body && body.done === true) return;
    } catch {
      // fall through to retry
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 1000);
  }
}

server.listen(0, '0.0.0.0', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  void (async () => {
    await register(port);
    await pollDone();
    server.close();
    setTimeout(() => process.exit(0), 200);
  })();
});
