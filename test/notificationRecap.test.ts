import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    buildMergeNotificationRecap,
    buildReviewNotificationRecap,
    buildReviewNotificationSummary,
    buildWorkNotificationRecap,
    compactNotificationRecap,
    fullNotificationSummary,
} from '../src/jobs/notificationRecap.js';

const REVIEW = [
    '## Overall Evaluation',
    'Two changes are required before merge.',
    '',
    '## Actionable Findings',
    '### F1: Preserve terminal state',
    '- **violatedRequirement:** Terminal states cannot be resurrected',
    '- **evidence:** src/worker.ts:128 — the new branch accepts the transition',
    '- **introducedByPR:** true — the changed handler added the branch',
    '- **requiredForMerge:** true',
    '- **minimumCorrection:** reject transitions from terminal states',
    '### F2: Keep the receipt atomic',
    '- **violatedRequirement:** Receipt updates must be atomic',
    '- **evidence:** src/inbox.ts:44 — the update runs outside the transaction',
    '- **introducedByPR:** true — the changed service moved the update',
    '- **requiredForMerge:** true',
    '- **minimumCorrection:** move the update into the transaction',
    '',
    '## Suggestions and Follow-ups',
    'No suggestions.',
    '',
    '## Score',
    'Score: 6/10',
].join('\n');

describe('notification recaps', () => {
    test('turns Markdown work summaries into compact plain text', () => {
        assert.equal(
            compactNotificationRecap('## Summary of Changes\n\n- Added swipe dismissal\n- Added **Undo** support'),
            'Added swipe dismissal · Added Undo support',
        );
        assert.equal(
            compactNotificationRecap('Updated `notification_user_states` in __init_db.ts__ and _src/snake_case_file.ts_ ~~twice~~ *once*'),
            'Updated notification_user_states in init_db.ts and src/snake_case_file.ts twice once',
        );
        assert.equal(
            buildWorkNotificationRecap('', { commandMode: 'fix', filesChanged: 2 }),
            'Applied the requested review fixes across 2 files.',
        );
    });

    test('includes the review score, issue count, and issue titles', () => {
        assert.equal(buildReviewNotificationRecap([{
            analysisResult: { success: true, response: REVIEW },
            findingCount: 2,
        }]), 'Score 6/10 · 2 issues found: Preserve terminal state; Keep the receipt atomic');
    });

    test('describes clean and conflict-resolving merge outcomes', () => {
        assert.equal(buildMergeNotificationRecap({
            baseBranch: 'main', headBranch: 'feature/inbox', conflictedFiles: [],
        }), 'Merged main into feature/inbox cleanly.');
        assert.match(buildMergeNotificationRecap({
            baseBranch: 'main', headBranch: 'feature/inbox',
            conflictedFiles: ['Inbox.tsx'], summary: 'Kept both accessibility handlers.',
        }), /resolved conflicts in 1 file.*Kept both accessibility handlers/);
    });

    test('keeps the full summary for the Inbox detail pane, dropping only hidden comments', () => {
        const summary = '## Summary of Changes\n\n<!-- marker -->\n- Fixed the **Inbox** detail pane\n- Added tests';
        assert.equal(fullNotificationSummary(summary), '## Summary of Changes\n\n\n- Fixed the **Inbox** detail pane\n- Added tests');
        assert.equal(fullNotificationSummary('  <!-- only -->  '), undefined);
        assert.equal(fullNotificationSummary(42), undefined);
        const long = fullNotificationSummary('word '.repeat(5_000))!;
        assert.equal(Array.from(long).length, 20_000);
        assert.ok(long.endsWith('…'));
    });

    test('keeps every posted review in full, without its details footer', () => {
        const body = (label: string) => `## 🔍 AI Code Review — ${label}\n\n## Overall Evaluation\n\nLooks right.\n\n---\n### 🤖 Review Details\n\n* **Model:** Opus`;
        assert.equal(buildReviewNotificationSummary([
            { analysisResult: { success: true }, commentBody: body('Claude') },
            { analysisResult: { success: false }, commentBody: 'error' },
            { analysisResult: { success: true }, commentBody: body('GPT') },
        ]), `## 🔍 AI Code Review — Claude\n\n## Overall Evaluation\n\nLooks right.\n\n## 🔍 AI Code Review — GPT\n\n## Overall Evaluation\n\nLooks right.`);
        assert.equal(buildReviewNotificationSummary([{ analysisResult: { success: false } }]), undefined);
    });
});
