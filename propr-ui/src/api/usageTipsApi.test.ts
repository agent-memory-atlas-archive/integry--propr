import { beforeEach, expect, it, vi } from 'vitest';
import { USAGE_TIPS_CATALOG } from '@propr/shared';
import { getUsageTips, dismissUsageTip } from './usageTipsApi';
import { apiFetch } from './apiClient';
vi.mock('./apiClient', () => ({ API_BASE_URL: '', apiFetch: vi.fn(), handleApiResponse: vi.fn(async (res: Response) => { if (!res.ok) throw new Error('failed'); }) }));
beforeEach(() => vi.resetAllMocks());
it('GET only reads and drops unknown IDs before the cap', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ enabled: true, tips: [{ id: 'unknown' }, ...USAGE_TIPS_CATALOG.slice(0, 3)] })));
  expect((await getUsageTips()).tips).toHaveLength(3);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(apiFetch).mock.calls[0][1]?.method).toBeUndefined();
});
it('explicit POST preserves the supplied event identifier and enables safe auth replay', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response('{}'));
  const eventId = crypto.randomUUID();
  await dismissUsageTip('pr-review', eventId);
  await dismissUsageTip('pr-review', eventId);
  for (const [, init, options] of vi.mocked(apiFetch).mock.calls) {
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ tipId: 'pr-review', eventId });
    expect(options?.replayMutationAfterTokenRefresh).toBe(true);
  }
});
