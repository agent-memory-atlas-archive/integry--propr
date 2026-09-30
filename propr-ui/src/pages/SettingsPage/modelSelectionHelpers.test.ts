import { describe, expect, it } from 'vitest';
import { buildPlanGenerationOptions, buildPrReviewOptions } from './modelSelectionHelpers';

describe('Claude model recommendations', () => {
  it('recommends Sonnet 5.5 instead of legacy Sonnet releases', () => {
    const agents = [{
      alias: 'claude',
      enabled: true,
      supportedModels: ['claude-sonnet-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6'],
    }];

    for (const options of [buildPlanGenerationOptions(agents), buildPrReviewOptions(agents)]) {
      expect(options.find(option => option.value === 'claude:claude-sonnet-5-5')?.isRecommended).toBe(true);
      expect(options.find(option => option.value === 'claude:claude-sonnet-5')?.isRecommended).toBe(false);
      expect(options.find(option => option.value === 'claude:claude-sonnet-4-6')?.isRecommended).toBe(false);
      expect(options[0]?.value).toBe('claude:claude-sonnet-5-5');
    }
  });
});
