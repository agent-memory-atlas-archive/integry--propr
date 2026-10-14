import { expect, it } from 'vitest';
import { getHistoryDerivedData } from './useHistoryData';
import type { TaskInfo } from './types';

it('uses the execution-reconciled API identity even when legacy history has a default model', () => {
  const result = getHistoryDerivedData([{ state: 'PROCESSING', timestamp: '2026-10-13T12:00:00Z', metadata: { model: 'claude-opus-5-5' } }], { modelName: 'gpt-6-astra' } as TaskInfo);
  expect(result.modelName).toBe('GPT-6 Astra');
});
it('uses the latest recorded model when task identity is unavailable', () => {
  const result = getHistoryDerivedData(['claude-opus-5-5', 'gpt-6-astra'].map(model => ({ state: 'PROCESSING', timestamp: '2026-10-13T12:00:00Z', metadata: { model } })), null);
  expect(result.modelName).toBe('GPT-6 Astra');
});
it('keeps unresolved routing unknown', () => {
  expect(getHistoryDerivedData([], null).modelName).toBe('Unknown Model');
});
