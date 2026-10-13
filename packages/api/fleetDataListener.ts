import type { RequestHandler } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FleetDataPlane } from '../core/src/fleet/dataPlane.js';
import { parseEnvelope } from '../core/src/fleet/contract.js';
import type { InstanceStorageService } from '../core/src/storage/service.js';
import { storageControlRoot } from '../core/src/storage/lifecycle.js';

/** Explicit refusal on the customer listener, also used by tunnel ingress. */
export const refusePublicFleetData: RequestHandler = (req, res, next) => {
  if (req.path !== '/v1/invoke') { next(); return; }
  res.set('Cache-Control', 'no-store').status(404).json({ error: 'fleet_data_unavailable' });
};

/** Separate Unix listener only. Never mount this handler on Express or the tunnel. */
export async function listenFleetData(plane: FleetDataPlane): Promise<Server> {
  const runtime = await plane.runtime();
  const socket = path.join(plane.files.root, `data-${runtime.runtimeGeneration}.sock`);
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let timer: NodeJS.Timeout | undefined;
    try {
      if (req.method !== 'POST' || req.url !== '/v1/invoke' || req.headers['content-type'] !== 'application/json' || req.headers['content-encoding']) throw new Error();
      const parts: Buffer[] = []; let length = 0;
      timer = setTimeout(() => req.destroy(), 5000);
      for await (const part of req) {
        const bytes = Buffer.from(part); length += bytes.length;
        if (length > 8192) throw new Error();
        parts.push(bytes);
      }
      clearTimeout(timer);
      const raw = Buffer.concat(parts).toString('utf8');
      if (parseEnvelope(raw).request.action === 'artifact.stream') {
        await plane.stream(raw, async (download, authorize) => {
          await authorize();
          const size = download.status.sizeBytes!;
          res.writeHead(200, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Length': size, 'X-Content-Type-Options': 'nosniff' });
          let sent = 0;
          const bounded = new Transform({ transform(chunk, _encoding, callback) {
            sent += chunk.length;
            if (sent > size || sent > 512 * 1024 ** 2) { callback(new Error()); return; }
            // Revalidate before every released chunk, including after backpressure.
            void authorize().then(() => callback(null, chunk), () => callback(new Error()));
          } });
          await pipeline(download.file.createReadStream({ highWaterMark: 64 * 1024 }), bounded, res, { signal: AbortSignal.timeout(60_000) });
          if (sent !== size) throw new Error();
        });
      } else {
        const result = await plane.invoke(raw);
        const body = JSON.stringify(result);
        if (Buffer.byteLength(body) > 32768) throw new Error();
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body);
      }
    } catch {
      if (res.headersSent) res.destroy();
      else { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"fleet_data_unavailable"}'); }
    } finally { clearTimeout(timer); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 16;
  server.maxConnections = 8;
  await plane.files.check();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // A string filesystem path is the ONLY listen overload used here; never TCP.
    server.listen(socket, () => { server.off('error', reject); resolve(); });
  });
  try { await fs.chmod(socket, 0o600); await plane.files.check(); }
  catch (error) { server.close(); throw error; }
  return server;
}

/** Provisioning is Fleet's job. Missing authority does not create or enable controls. */
export async function startConfiguredFleetData(storage: InstanceStorageService): Promise<Server | undefined> {
  const root = path.join(path.dirname(storageControlRoot()), 'fleet-data-control');
  try { await fs.lstat(path.join(root, 'authority.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const plane = new FleetDataPlane(storage, root);
  await plane.initialize();
  return listenFleetData(plane);
}
