import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getInstanceCatalog,
  getReadinessTaskExistence,
  getTasks,
  setAuthenticatedApiReadIdentity,
  setDesktopConnectionScope,
} from './proprApi';

const catalog = (name: string) => ({
  agents: [],
  repositories: [{ name, enabled: true }],
});

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const desktopScope = (name: string) => ({
  bridge: {} as never,
  profileId: `profile-${name}`,
  transportScope: `transport-${name}`,
});

afterEach(() => {
  setDesktopConnectionScope(null);
  setAuthenticatedApiReadIdentity(null);
  vi.restoreAllMocks();
});

describe('same-scope startup reads', () => {
  it('shares one pending catalog read between two consumers, then reads fresh after settlement', async () => {
    const first = deferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(jsonResponse(catalog('second/repo')));

    const consumerA = getInstanceCatalog();
    const consumerB = getInstanceCatalog();

    expect(consumerB).toBe(consumerA);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    first.resolve(jsonResponse(catalog('first/repo')));
    await expect(Promise.all([consumerA, consumerB])).resolves.toEqual([
      catalog('first/repo'),
      catalog('first/repo'),
    ]);

    await expect(getInstanceCatalog()).resolves.toEqual(catalog('second/repo'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('removes a failed pending read so a later consumer can retry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ error: 'temporary' }, 503))
      .mockResolvedValueOnce(jsonResponse(catalog('recovered/repo')));

    const consumerA = getInstanceCatalog();
    const consumerB = getInstanceCatalog();
    expect(consumerB).toBe(consumerA);
    await expect(consumerA).rejects.toThrow('HTTP 503');
    await expect(consumerB).rejects.toThrow('HTTP 503');

    await expect(getInstanceCatalog()).resolves.toEqual(catalog('recovered/repo'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects a deferred account-A response and never shares it with account B', async () => {
    setAuthenticatedApiReadIdentity('account-a');
    const accountA = deferred<Response>();
    const accountB = deferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(accountA.promise)
      .mockReturnValueOnce(accountB.promise);

    const oldRead = getInstanceCatalog();
    const oldReadRejected = expect(oldRead).rejects.toMatchObject({ name: 'AbortError' });
    setAuthenticatedApiReadIdentity('account-b');
    const newRead = getInstanceCatalog();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    accountA.resolve(jsonResponse(catalog('account-a/private')));
    accountB.resolve(jsonResponse(catalog('account-b/private')));
    await oldReadRejected;
    await expect(newRead).resolves.toEqual(catalog('account-b/private'));
  });

  it('starts fresh reads after a Desktop reconnect rotates its transport scope', async () => {
    setDesktopConnectionScope(desktopScope('a'));
    const connectionA = deferred<Response>();
    const connectionB = deferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(connectionA.promise)
      .mockReturnValueOnce(connectionB.promise);

    const oldRead = getInstanceCatalog();
    const oldReadRejected = expect(oldRead).rejects.toMatchObject({ name: 'AbortError' });
    setDesktopConnectionScope(desktopScope('b'));
    const newRead = getInstanceCatalog();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    connectionA.resolve(jsonResponse(catalog('connection-a/private')));
    connectionB.resolve(jsonResponse(catalog('connection-b/private')));
    await oldReadRejected;
    await expect(newRead).resolves.toEqual(catalog('connection-b/private'));
  });

  it('shares only readiness existence reads and preserves distinct task query contracts', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(jsonResponse({ tasks: [], total: 0 })));

    await Promise.all([
      getTasks('all', 100, 0),
      getTasks({ limit: 30, forReview: true, excludeMerged: true }),
      getReadinessTaskExistence(),
      getReadinessTaskExistence(),
    ]);

    const urls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(urls).toHaveLength(3);
    expect(urls).toContain('/api/tasks?status=all&limit=100&offset=0&repository=all');
    expect(urls).toContain('/api/tasks?status=all&limit=30&offset=0&repository=all&forReview=true&excludeMerged=true');
    expect(urls).toContain('/api/tasks?status=all&limit=1&offset=0&repository=all');
  });
});
