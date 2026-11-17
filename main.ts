// main.ts — the forge entrypoint.
//
// One process, two phases. First it starts the forge on an ephemeral port and
// tells the trial environment where to find it; then it waits until the
// environment says the trial is over and leaves quietly:
//
//   1. createApp() builds the forge — git smart HTTP, REST v3, GraphQL and
//      MCP — on top of its own in-memory store.
//   2. The server binds port 0 with no host pinned, so the kernel picks a
//      free port on every interface. Pinning nothing matters: the suite
//      dials the address our register request came from, and a loopback-only
//      bind would refuse that dial from the suite's side. Never 8080 —
//      the environment owns that port.
//   3. We POST {"port"} to $MAKEFUN_ENV_URL/register so the suite can find us.
//      A 200 means accepted; a 409 means another entry already holds the
//      slot, and we simply wait like any other entry. Anything else is
//      retried — the environment may still be starting.
//   4. We poll GET $MAKEFUN_ENV_URL/done with exponential back-off until it
//      answers {"done": true}. The environment answers at once ({"done":
//      false} while the suite runs), so this is a poll, not a request held
//      open. A failed or slow poll is retried the same way; the process
//      never leaves before the environment says done.
//   5. Close the listener and exit 0. The harness then stops the
//      environment, which writes the export the scorer reads.
//
// Without MAKEFUN_ENV_URL there is nothing to register with, so the program
// exits 1 at once. Only the standard library is used.

import { createApp } from "./app.ts";
import type { Server } from "node:http";

// How long one register or done request may take before it is abandoned.
const REQUEST_TIMEOUT_MS = 30_000;
// Back-off between retries: start here, double each time, stop here.
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readEnvOrigin(): string | undefined {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") {
    return undefined;
  }
  return trimmed;
}

function joinEnvUrl(origin: string, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${suffix}`;
}

function retryPauseMs(attempt: number): number {
  const step = Math.min(attempt, 8);
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** step);
}

// Sleep for the back-off after `attempt` failed tries and hand back the
// attempt number the next try should count as, so the three retry loops
// below cannot drift apart.
async function pauseBeforeRetry(attempt: number): Promise<number> {
  await sleep(retryPauseMs(attempt));
  return attempt + 1;
}

async function registerForge(origin: string, port: number): Promise<void> {
  const target = joinEnvUrl(origin, "/register");
  const payload = JSON.stringify({ port });
  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // The environment may still be coming up: wait and try again rather
      // than failing a trial that has barely started.
      attempt = await pauseBeforeRetry(attempt);
      continue;
    }
    if (response.status === 200 || response.status === 409) {
      return;
    }
    if (response.status === 400 || response.status === 405) {
      const detail = await response.text();
      throw new Error(`register answered HTTP ${response.status}: ${detail}`);
    }
    // Any other status is treated like a network error: back off, retry.
    attempt = await pauseBeforeRetry(attempt);
  }
}

async function waitForDone(origin: string): Promise<void> {
  const target = joinEnvUrl(origin, "/done");
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(target, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const body: unknown = await response.json();
        const finished =
          typeof body === "object" &&
          body !== null &&
          (body as { done?: unknown }).done === true;
        if (finished) {
          return;
        }
      }
      // Any other answer just means "not done yet": wait and ask again.
    } catch {
      // The environment is not answering yet, or the poll timed out:
      // that is not done either, so poll again.
    }
    attempt = await pauseBeforeRetry(attempt);
  }
}

async function startForge(): Promise<{ server: Server; port: number }> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      resolve();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    server.close();
    throw new Error("the forge did not bind an ephemeral TCP port");
  }
  return { server, port: bound.port };
}

async function main(): Promise<void> {
  const origin = readEnvOrigin();
  if (origin === undefined) {
    process.stderr.write("[forge] MAKEFUN_ENV_URL is not set: there is no env to register with\n");
    process.exit(1);
  }
  const { server, port } = await startForge();
  process.stdout.write(`[forge] listening on port ${port}\n`);
  await registerForge(origin, port);
  process.stdout.write("[forge] registered; waiting for the env to say done\n");
  await waitForDone(origin);
  server.close();
  process.stdout.write("[forge] done\n");
}

try {
  await main();
  process.exit(0);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[forge] ${detail}\n`);
  process.exit(1);
}
