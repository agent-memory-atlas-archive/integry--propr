import React from 'react';
import { buildPrReviewOptions, type ModelSelectionAgent } from './modelSelectionHelpers';
import { SettingsCheckboxField, SettingsField } from './SettingsLayout';
import { SETTINGS_CONTROL } from './settingsStyles';

interface ReviewContextSettingsProps {
  settings: {
    pr_review_context_enabled: boolean;
    pr_review_context_model: string;
    pr_review_max_context_tokens: number;
  };
  agents: ModelSelectionAgent[];
  onSettingChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onEnabledChange: (enabled: boolean) => void;
  onMaxContextTokensChange: (value: number) => void;
  onMaxContextTokensBlur: () => void;
}

const ReviewContextSettings: React.FC<ReviewContextSettingsProps> = ({
  settings, agents, onSettingChange, onEnabledChange, onMaxContextTokensChange, onMaxContextTokensBlur
}) => {
  const options = buildPrReviewOptions(agents.filter(agent => agent.enabled));
  return (
    <>
      <SettingsCheckboxField
        id="pr_review_context_enabled"
        label="Gather related unchanged code"
        helperText="Lets a read-only scout locate relevant unchanged callers, consumers, contracts, configuration, and tests before the review. Scout failure never blocks the review."
        checked={settings.pr_review_context_enabled}
        onChange={(event) => onEnabledChange(event.target.checked)}
      />

      <SettingsField
        label="Context Scout Model"
        htmlFor="pr_review_context_model"
        helperText="A fast coding-agent model used only to find relevant file ranges. If unset, ProPR uses the Fast Analysis Model, then the review model."
      >
        <select
          id="pr_review_context_model"
          name="pr_review_context_model"
          value={settings.pr_review_context_model}
          onChange={onSettingChange}
          disabled={!settings.pr_review_context_enabled || options.length === 0}
          className={SETTINGS_CONTROL}
        >
          <option value="">Use Fast Analysis Model</option>
          {options.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}{option.isRecommended ? ' (Recommended)' : ''}
            </option>
          ))}
        </select>
      </SettingsField>

      <SettingsField
        label="Maximum Review Context"
        htmlFor="pr_review_max_context_tokens"
        helperText="Maximum input context per review request, in tokens. Use 0 for the selected review model's automatic safe limit; explicit values are still capped at the model's hard limit."
      >
        <input
          id="pr_review_max_context_tokens"
          name="pr_review_max_context_tokens"
          type="number"
          min={0}
          max={2000000}
          step={10000}
          value={settings.pr_review_max_context_tokens}
          onChange={(event) => onMaxContextTokensChange(Number(event.target.value))}
          onBlur={onMaxContextTokensBlur}
          className={SETTINGS_CONTROL}
        />
      </SettingsField>
    </>
  );
};

export default ReviewContextSettings;
