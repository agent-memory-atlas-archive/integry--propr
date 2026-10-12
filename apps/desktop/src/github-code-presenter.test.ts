import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGithubCodePresenter } from './github-code-presenter';
import { isSafeExternalUrl } from './security';
import { openAllowedExternalUrl } from './external-url';

const url = 'https://github.com/login/device';
test('real presenter opens verification URL through real external policy and copies only on native action', async () => {
  const controller = new AbortController();
  const opened: string[] = []; const copied: string[] = [];
  let dialogs = 0;
  assert.equal(isSafeExternalUrl(url), true);
  const present = createGithubCodePresenter({
    isShuttingDown: () => false,
    openExternal: value => openAllowedExternalUrl(value, async allowed => { opened.push(allowed); }),
    copy: value => copied.push(value),
    showDialog: async options => {
      dialogs++;
      assert.ok(options.buttons?.includes('Copy code'));
      assert.ok(options.buttons?.includes('Cancel sign-in'));
      if (dialogs === 1) return { response: 1 }; // copy before opening
      if (dialogs === 2) return { response: 0 }; // open
      if (dialogs === 3) return { response: 0 }; // copy while waiting
      return new Promise(resolve => options.signal!.addEventListener('abort', () => resolve({ response: 1 }), { once: true }));
    },
  });
  const close = await present('fixture-code', url, controller.signal, () => controller.abort());
  await new Promise(resolve => setImmediate(resolve));
  await close();
  assert.deepEqual(opened, [url]); assert.deepEqual(copied, ['fixture-code', 'fixture-code']);
  assert.equal(controller.signal.aborted, false);
  await openAllowedExternalUrl('javascript:alert(1)', async value => { opened.push(value); });
  assert.deepEqual(opened, [url]);
});

test('late native Copy response after cancellation cannot touch clipboard or open browser', async () => {
  const controller = new AbortController();
  const present = createGithubCodePresenter({
    isShuttingDown: () => false, copy: () => assert.fail('late copy'), openExternal: async () => assert.fail('late browser'),
    showDialog: async () => { controller.abort(); return { response: 1 }; },
  });
  await assert.rejects(present('fixture-code', url, controller.signal, () => controller.abort()));
});

for (const waiting of [false, true]) test(`native Cancel sign-in aborts the attempt (${waiting ? 'waiting' : 'initial'} dialog)`, async () => {
  const controller = new AbortController(); let calls = 0; let opened = 0;
  const present = createGithubCodePresenter({
    isShuttingDown: () => false, copy: () => assert.fail('cancel must not copy'),
    openExternal: async () => { opened++; },
    showDialog: async () => ({ response: waiting ? (++calls === 1 ? 0 : 1) : 2 }),
  });
  if (waiting) { const close = await present('fixture-code', url, controller.signal, () => controller.abort()); await close(); }
  else await assert.rejects(present('fixture-code', url, controller.signal, () => controller.abort()));
  assert.equal(controller.signal.aborted, true); assert.equal(opened, waiting ? 1 : 0);
});
