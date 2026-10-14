import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskModelIdentity } from '../routes/taskModelIdentity.js';

const followup = { task_id: 'followup', task_type: 'pr-comment', model_name: 'claude-opus-5-5', initial_job_data: JSON.stringify({ pullRequestNumber: 7 }) };

test('an unresolved PR follow-up never borrows the configured default', () => {
  assert.deepEqual(taskModelIdentity(followup, []), { modelName: null, agentAlias: null });
});
test('saved execution evidence repairs historical follow-ups without a queued model override', () => {
  assert.deepEqual(taskModelIdentity(followup, [], [{ model_name: 'gpt-6-astra' }]), { modelName: 'gpt-6-astra', agentAlias: null });
});
test('resolved implementation and review routing outrank stale task and job identities', () => {
  for (const commandMode of [undefined, 'review']) {
    const task = { ...followup, initial_job_data: { modelName: 'claude-opus-5-5', agentAlias: 'claude', commandMode } };
    assert.deepEqual(taskModelIdentity(task, [{ metadata: JSON.stringify({ model: 'gpt-6-astra', executionRouting: { model: 'gpt-6-astra', agentAlias: 'codex' } }) }]), { modelName: 'gpt-6-astra', agentAlias: 'codex' });
  }
});
test('session history uses the latest recorded model without retaining the wrong provider', () => {
  assert.deepEqual(taskModelIdentity(followup, [{ metadata: { model: 'claude-opus-5-5' } }, { metadata: { model: 'gpt-6-astra' } }]), { modelName: 'gpt-6-astra', agentAlias: null });
});
test('explicit selections and virtual synthetic identity remain available', () => {
  assert.deepEqual(taskModelIdentity({ ...followup, initial_job_data: { modelName: 'gpt-6-astra', agentAlias: 'codex' } }, []), { modelName: 'gpt-6-astra', agentAlias: 'codex' });
  assert.deepEqual(taskModelIdentity(followup, [{ metadata: { syntheticRouting: { virtualModel: 'balanced', virtualAgentAlias: 'pool' }, model: 'gpt-6-astra' } }]), { modelName: 'balanced', agentAlias: 'pool' });
});

test('actual persisted execution wins over a stale history model', () => {
  assert.deepEqual(taskModelIdentity(followup, [{ metadata: { model: 'claude-opus-5-5' } }], [{ model_name: 'gpt-6-astra' }]), { modelName: 'gpt-6-astra', agentAlias: null });
});
