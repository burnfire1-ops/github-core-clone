import { createForgeServer } from './app.ts';

// main.ts — entrypoint and lifecycle: bind an ephemeral port, register it
// with the suite environment, poll /done, exit 0 when the suite is done.

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

if (!ENV_URL) {
  console.error('MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url);
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const server = createForgeServer(TOKEN);
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    console.error('could not bind a port');
    process.exit(1);
  }
  const port = address.port;

  // Register with a short exponential backoff. The first register wins;
  // a 409 means another registration already holds the base URL.
  let delay = 100;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const res = await postJson(ENV_URL.replace(/\/$/, '') + '/register', { port });
      if (res.status === 200 || res.status === 409) break;
    } catch {
      // retry below
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }

  // Poll /done with a short backoff; never hold a request open.
  let pollDelay = 250;
  for (;;) {
    const done = await getJson(ENV_URL.replace(/\/$/, '') + '/done');
    if (done && done.done === true) break;
    await sleep(pollDelay);
    pollDelay = Math.min(pollDelay * 2, 2000);
    if (pollDelay > 1000) pollDelay = 500;
  }

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
