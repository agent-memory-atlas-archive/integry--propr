import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localSetupSearchPath } from './localSetupPlatform.js';

test('Finder path finds Docker Desktop and optional GitHub CLI without reading a shell profile', () => {
  const result = localSetupSearchPath('darwin', '/usr/bin:/bin', '/Users/Test User')!.split(':');
  assert.ok(result.includes('/Applications/Docker.app/Contents/Resources/bin'));
  assert.ok(result.includes('/Users/Test User/.docker/bin'));
  assert.ok(result.includes('/opt/homebrew/bin'));
  assert.equal(result[0], '/usr/bin');
  assert.equal(localSetupSearchPath('darwin', result.join(':'), '/Users/Test User'), result.join(':'));
  assert.equal(localSetupSearchPath('linux', '/custom/bin'), '/custom/bin');
  assert.equal(localSetupSearchPath('win32', 'C:\\Windows'), 'C:\\Windows');
  assert.ok(!localSetupSearchPath('darwin', ':.:relative:/bin', '/Users/Test')!.split(':').includes('.'));
});
