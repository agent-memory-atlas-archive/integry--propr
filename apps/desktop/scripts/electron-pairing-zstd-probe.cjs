const { app, session } = require('electron');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let endpoint;
  try {
    endpoint = new URL(process.argv.at(-1));
  } catch {
    throw new Error('Native zstd pairing endpoint is missing');
  }
  if (endpoint.protocol !== 'http:'
    || endpoint.hostname !== '127.0.0.1'
    || !endpoint.port
    || endpoint.username
    || endpoint.password
    || endpoint.pathname !== '/valid'
    || endpoint.search
    || endpoint.hash) throw new Error('Native zstd pairing endpoint is invalid');

  const clientModuleUrl = pathToFileURL(resolve(
    __dirname,
    '../../../packages/client/dist/pairingProtocol.js',
  )).href;
  const { requestPairingProtocol } = await import(clientModuleUrl);
  const electronFetch = session.defaultSession.fetch.bind(session.defaultSession);
  const requestOnce = async path => {
    let responseEncoding;
    let responseLength;
    try {
      const value = await requestPairingProtocol(async (...args) => {
        const response = await electronFetch(...args);
        responseEncoding = response.headers.get('content-encoding');
        responseLength = response.headers.get('content-length');
        return response;
      }, new URL(path, endpoint), { method: 'POST' });
      return { kind: 'success', responseEncoding, responseLength, value };
    } catch (error) {
      return {
        kind: error && typeof error.kind === 'string' ? error.kind : 'unexpected',
        message: error instanceof Error ? error.message : '',
        responseEncoding,
        responseLength,
      };
    }
  };

  // On a CI worker the first request a freshly launched Electron makes can
  // wait well past the client's fixed 8s header deadline while the default
  // session's network stack finishes starting: across the full-suite runs it
  // was always the first path that stalled, in about half of them, and once
  // for more than 40s. Later requests never did. That start-up cost says
  // nothing about compression, so the default session must first reach the
  // loopback server with a plain request under its own, longer budget, and
  // only then are the pairing requests measured.
  const readinessBudgetMs = 45_000;
  const readinessAttemptMs = 15_000;
  const awaitReadiness = async () => {
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    let attempts = 0;
    let lastFailure = '';
    while (elapsed() < readinessBudgetMs) {
      attempts += 1;
      try {
        const response = await electronFetch(new URL('/ready', endpoint).href, {
          signal: AbortSignal.timeout(Math.min(readinessAttemptMs, readinessBudgetMs - elapsed())),
        });
        await response.arrayBuffer();
        if (response.ok) return { attempts, elapsedMs: elapsed(), ready: true };
        lastFailure = `status ${response.status}`;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }
      // A refused connection fails at once; do not spin on it.
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    }
    return { attempts, elapsedMs: elapsed(), lastFailure, ready: false };
  };

  // Once the stack is up, a saturated worker can still stall a request past
  // the header deadline. That is a worker hiccup rather than a compression
  // result, so one stalled path is retried and every stall is reported so the
  // test can surface it. Retries stay bounded to keep the run inside the
  // fixture budget; beyond that the timeout is reported as the outcome.
  const maximumStallRetries = 1;
  const stalls = [];
  const request = async path => {
    const attempt = await requestOnce(path);
    if (attempt.kind !== 'timeout') return attempt;
    stalls.push(path);
    if (stalls.length > maximumStallRetries) return attempt;
    return requestOnce(path);
  };

  const readiness = await awaitReadiness();
  process.stdout.write(`${JSON.stringify(readiness.ready ? {
    readiness,
    valid: await request('/valid'),
    decodedOverLimit: await request('/decoded-over-limit'),
    truncated: await request('/truncated'),
    stacked: await request('/stacked'),
    stalls,
  } : { readiness })}\n`);
  app.quit();
}).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
