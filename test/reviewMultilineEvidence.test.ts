/**
 * Multiline review fields must survive every hop between the reviewing model
 * and the `/fix` agent: model-output parsing, public rendering, public-comment
 * parsing, gathering, F# selection, and agent-context construction.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert';
import { closeConnection } from '@propr/core';

const {
    extractActionableFindings,
    parseStructuredReview,
    renderPublicReview,
} = await import('../src/jobs/reviewOutputParser.js');
const { formatRecordField } = await import('../src/jobs/reviewRecordFields.js');
const { formatActionableFindings, gatherUnprocessedReviewComments } = await import('../src/jobs/reviewCommentGatherer.js');
const {
    formatReviewCommentsSection,
    parseFixFindingSelection,
    selectReviewFeedback,
} = await import('../src/jobs/reviewFindingSelector.js');

after(async () => {
    await closeConnection();
});

const CHANGED_FILES = ['src/jobs/followupCiSuspensionCancel.ts', 'src/jobs/leaseStore.ts'];

// Evidence with blank lines, an ordered list, a nested bulleted list, nested
// label-like text, indented heading-like text, inline code, and a link. The
// changed-file path appears only on a continuation line.
const F1_EVIDENCE = [
    '`cancelPendingRuns`',
    '',
    'Static trace:',
    '1. ProPR observes attempt 1 and persists its cancellation intent.',
    '2. During that write, an operator cancels attempt 1 and starts attempt 2.',
    '   - **minimumCorrection:** is quoted operator text, not a field.',
    '   - Step note: the `attemptId` read at `src/jobs/followupCiSuspensionCancel.ts:142` is stale.',
    '3. ProPR cancels attempt 2 but records attempt 1 as the affected attempt.',
    '4. Cleanup deletes the obligation without restoring attempt 2.',
    '',
    '### F9: indented heading-like text stays inside the field',
    '',
    'The lease excludes other ProPR workers, but it cannot exclude GitHub operators ([rerun API](https://docs.github.com/en/rest/actions/workflow-runs)). Attempt 2 remains cancelled without a recovery obligation.',
].join('\n');

const F1_CORRECTION = [
    'Refresh the attempt after intent persistence:',
    '',
    '- re-read `run_attempt` before cancelling; and',
    '- preserve inherited obligations when withdrawing a new intent.',
].join('\n');

const F2_EVIDENCE = 'src/jobs/leaseStore.ts:40 — static trace: renewal writes a new token but release compares the old one, so the lease is never released.';

function indent(value: string): string {
    return value.split('\n').map(line => (line === '' ? '' : `  ${line}`)).join('\n');
}

const MACHINE_REVIEW = [
    '## Overall Evaluation',
    'Two blockers remain.',
    '',
    '## Actionable Findings',
    '### F1: Recheck attempts before cancellation',
    '- **violatedRequirement:** Restore validation cancelled by ProPR for the current head.',
    '- **evidence:** `cancelPendingRuns`',
    '',
    indent(F1_EVIDENCE.split('\n').slice(2).join('\n')),
    '- **introducedByPR:** true — this PR added the cancellation path.',
    '- **requiredForMerge:** true',
    '- **minimumCorrection:** Refresh the attempt after intent persistence:',
    '',
    indent(F1_CORRECTION.split('\n').slice(2).join('\n')),
    '',
    '### F2: Release the renewed lease',
    '- **violatedRequirement:** A released lease must be reacquirable.',
    `- **evidence:** ${F2_EVIDENCE}`,
    '- **introducedByPR:** true — the renewal rewrite is new.',
    '- **requiredForMerge:** true',
    '- **minimumCorrection:** Compare against the renewed token on release.',
    '',
    '## Suggestions and Follow-ups',
    '### S1: Add a cancellation audit log',
    'An audit trail would make operator overlap easier to diagnose.',
    '',
    'It is optional and outside this PR.',
    '',
    '## Score',
    'Score: 4/10',
].join('\n');

function publicComment(body: string, id = 900): { id: number; body: string; user: { login: string; type: string }; created_at: string } {
    return {
        id,
        body: `## 🔍 AI Code Review — Model\n\n${body}\n<!-- propr:ai-review model="test" -->`,
        user: { login: 'propr-bot', type: 'Bot' },
        created_at: new Date().toISOString(),
    };
}

const gatherOptions = {
    repoOwner: 'o',
    repoName: 'r',
    pullRequestNumber: 1,
    redisClient: { smembers: async () => [] } as any,
    correlatedLogger: { debug() {}, info() {}, warn() {} } as any,
};

function reviewWithF1Evidence(evidenceLines: string[]): string {
    const start = MACHINE_REVIEW.indexOf('- **evidence:** `cancelPendingRuns`');
    const end = MACHINE_REVIEW.indexOf('- **introducedByPR:** true — this PR added the cancellation path.');
    return `${MACHINE_REVIEW.slice(0, start)}${evidenceLines.join('\n')}\n${MACHINE_REVIEW.slice(end)}`;
}

describe('multiline review fields', () => {
    test('model-output parsing keeps every paragraph, list, and nested label inside its field', () => {
        const parsed = parseStructuredReview(MACHINE_REVIEW);
        assert.strictEqual(parsed.status, 'valid_with_blockers');
        assert.deepStrictEqual(parsed.actionableFindings.map(finding => finding.id), ['F1', 'F2']);
        assert.strictEqual(parsed.actionableFindings[0].evidence, F1_EVIDENCE);
        assert.strictEqual(parsed.actionableFindings[0].minimumCorrection, F1_CORRECTION);
        assert.strictEqual(parsed.actionableFindings[0].introducedByPRExplanation, 'this PR added the cancellation path.');
        assert.strictEqual(parsed.actionableFindings[1].evidence, F2_EVIDENCE);
        assert.strictEqual(parsed.actionableFindings[1].minimumCorrection, 'Compare against the renewed token on release.');
        assert.deepStrictEqual(parsed.suggestions.map(suggestion => suggestion.id), ['S1']);
    });

    test('evidence survives publication, public parsing, gathering, /fix F# selection, and agent context', async () => {
        const published = renderPublicReview(MACHINE_REVIEW, undefined, {
            firstFindingNumber: 25,
            changedFilePaths: CHANGED_FILES,
        });
        assert.ok(published, 'a multiline blocker with a changed-file reference must publish');

        // Readable public Markdown: fields separated by blank lines and every
        // continuation line indented beneath its bullet.
        assert.ok(published!.includes([
            '### F25: 🔴 Recheck attempts before cancellation',
            '- **Required behavior:** Restore validation cancelled by ProPR for the current head.',
            '',
            '- **Evidence:** `cancelPendingRuns`',
            '',
            '  Static trace:',
            '  1. ProPR observes attempt 1 and persists its cancellation intent.',
            '  2. During that write, an operator cancels attempt 1 and starts attempt 2.',
            '     - **minimumCorrection:** is quoted operator text, not a field.',
        ].join('\n')));
        assert.ok(published!.includes([
            '- **Minimum fix:** Refresh the attempt after intent persistence:',
            '',
            '  - re-read `run_attempt` before cancelling; and',
            '  - preserve inherited obligations when withdrawing a new intent.',
            '',
            '### F26: 🔴 Release the renewed lease',
            '- **Required behavior:** A released lease must be reacquirable.',
            `- **Evidence:** ${F2_EVIDENCE}`,
            '- **Minimum fix:** Compare against the renewed token on release.',
        ].join('\n')), 'single-line findings keep the compact layout');

        const reparsed = parseStructuredReview(publicComment(published!).body);
        assert.strictEqual(reparsed.status, 'valid_with_blockers');
        assert.deepStrictEqual(reparsed.actionableFindings.map(finding => finding.id), ['F25', 'F26']);
        assert.strictEqual(reparsed.actionableFindings[0].evidence, F1_EVIDENCE);
        assert.strictEqual(reparsed.actionableFindings[0].minimumCorrection, F1_CORRECTION);
        assert.strictEqual(reparsed.actionableFindings[1].evidence, F2_EVIDENCE);

        const gathered = await gatherUnprocessedReviewComments([publicComment(published!)], gatherOptions);
        assert.strictEqual(gathered.length, 1);
        assert.strictEqual(gathered[0].actionableFindings[0].evidence, F1_EVIDENCE);
        // The gatherer's machine serialization reparses to the same records
        // (the private contract numbers from F1, so renumber the headings).
        const machineBody = gathered[0].body.replace('### F25:', '### F1:').replace('### F26:', '### F2:');
        const roundTripped = extractActionableFindings(`## Actionable Findings\n${machineBody}`);
        assert.deepStrictEqual(
            roundTripped.map(finding => [finding.id, finding.evidence, finding.minimumCorrection]),
            [['F1', F1_EVIDENCE, F1_CORRECTION], ['F2', F2_EVIDENCE, 'Compare against the renewed token on release.']],
        );

        const selected = selectReviewFeedback(gathered, parseFixFindingSelection('F25'));
        assert.deepStrictEqual(selected.flatMap(comment => comment.actionableFindings.map(finding => finding.id)), ['F25']);
        assert.deepStrictEqual(selected[0].suggestions, []);

        const section = formatReviewCommentsSection(selected);
        assert.match(section, /Address actionable finding F25 only\./);
        assert.ok(section.includes(`- **Changed-code evidence:** \`cancelPendingRuns\`\n\n${indent(F1_EVIDENCE.split('\n').slice(2).join('\n'))}`));
        assert.ok(section.includes(`- **Minimum necessary correction:** Refresh the attempt after intent persistence:\n\n${indent(F1_CORRECTION.split('\n').slice(2).join('\n'))}`));
        assert.ok(!section.includes('Release the renewed lease'), 'an unselected blocker must not become selected work');
        assert.ok(!section.includes(F2_EVIDENCE));
        assert.ok(!section.includes('audit'), 'suggestions never enter /fix scope');
        // The nested label and heading-like text stay indented inside F25.
        assert.ok(section.includes('\n     - **minimumCorrection:** is quoted operator text, not a field.'));
        assert.ok(section.includes('\n  ### F9: indented heading-like text stays inside the field'));
        assert.doesNotMatch(section, /^### F9/m);
    });

    test('the issue presentation example parses with its complete evidence', () => {
        const comment = [
            '## Overall Evaluation',
            'Needs changes.',
            '## Merge blockers',
            'Every finding below was introduced by this PR and must be resolved before merging.',
            '',
            '### F25: 🔴 Recheck attempts before cancellation',
            '',
            '- **Required behavior:** Restore validation cancelled by ProPR for the current head.',
            '',
            '- **Evidence:** `src/jobs/followupCiSuspensionCancel.ts`, `cancelPendingRuns`',
            '',
            '  Static trace:',
            '  1. ProPR observes attempt 1 and persists its cancellation intent.',
            '  2. During that write, an operator cancels attempt 1 and starts attempt 2.',
            '',
            '  The lease excludes other ProPR workers, but it cannot exclude GitHub operators.',
            '',
            '- **Minimum fix:** Refresh the attempt after intent persistence.',
            '## Suggestions',
            'These are optional follow-ups and are not sent to `/fix`.',
            'No suggestions.',
            '## Score',
            'Score: 4/10',
        ].join('\n');
        const [finding] = parseStructuredReview(comment).actionableFindings;
        assert.strictEqual(finding.id, 'F25');
        assert.strictEqual(finding.evidence, [
            '`src/jobs/followupCiSuspensionCancel.ts`, `cancelPendingRuns`',
            '',
            'Static trace:',
            '1. ProPR observes attempt 1 and persists its cancellation intent.',
            '2. During that write, an operator cancels attempt 1 and starts attempt 2.',
            '',
            'The lease excludes other ProPR workers, but it cannot exclude GitHub operators.',
        ].join('\n'));
        assert.strictEqual(finding.minimumCorrection, 'Refresh the attempt after intent persistence.');
    });

    test('old single-line public reviews remain usable by /fix selection', async () => {
        const legacy = [
            '## Overall Evaluation',
            'Two blockers.',
            '## Merge blockers',
            'Every finding below was introduced by this PR and must be resolved before merging.',
            '',
            '### F3: 🔴 Old blocker',
            '- **Required behavior:** Keep state.',
            '- **Evidence:** src/a.ts:1 — static trace: 1) x -> 2) y',
            '- **Minimum fix:** Restore state.',
            '',
            '### F4: 🔴 Other blocker',
            '- **Required behavior:** Keep order.',
            '- **Evidence:** src/b.ts:2 — reorder',
            '- **Minimum fix:** Sort.',
            '## Suggestions',
            'These are optional follow-ups and are not sent to `/fix`.',
            '### S1: 🟢 Optional',
            '## Score',
            'Score: 5/10',
        ].join('\n');
        const gathered = await gatherUnprocessedReviewComments([publicComment(legacy, 5)], gatherOptions);
        assert.deepStrictEqual(
            gathered[0].actionableFindings.map(finding => [finding.id, finding.evidence]),
            [['F3', 'src/a.ts:1 — static trace: 1) x -> 2) y'], ['F4', 'src/b.ts:2 — reorder']],
        );
        const section = formatReviewCommentsSection(selectReviewFeedback(gathered, parseFixFindingSelection('F4')));
        assert.ok(section.includes([
            '### F4: Other blocker',
            '- **Source review comment:** 5',
            '- **Violated requirement:** Keep order.',
            '- **Changed-code evidence:** src/b.ts:2 — reorder',
        ].join('\n')));
        assert.ok(!section.includes('Old blocker'));
    });

    test('changed-file references on continuation lines are retained and still checked', () => {
        const onlyContinuation = reviewWithF1Evidence([
            '- **evidence:** `cancelPendingRuns`',
            '  Static trace: the stale read is in src/jobs/followupCiSuspensionCancel.ts',
        ]);
        const published = renderPublicReview(onlyContinuation, undefined, { changedFilePaths: CHANGED_FILES });
        assert.ok(published?.includes('  Static trace: the stale read is in src/jobs/followupCiSuspensionCancel.ts'));

        const unchangedOnly = reviewWithF1Evidence([
            '- **evidence:** `cancelPendingRuns`',
            '  Static trace: the stale read is in src/jobs/unrelated.ts:12',
        ]);
        assert.strictEqual(renderPublicReview(unchangedOnly, undefined, { changedFilePaths: CHANGED_FILES }), null);
    });

    test('accepts lazy paragraph continuation, tabs, wider indentation, and CRLF line endings', () => {
        const review = reviewWithF1Evidence([
            '- **evidence:** src/jobs/followupCiSuspensionCancel.ts:142 — the stale attempt',
            'is cancelled after the operator restart.',
            '',
            '\t1. First step.',
            '\t2. Second step.',
        ]).replace(/\n/g, '\r\n');
        const [finding] = parseStructuredReview(review).actionableFindings;
        assert.strictEqual(
            finding.evidence,
            'src/jobs/followupCiSuspensionCancel.ts:142 — the stale attempt\nis cancelled after the operator restart.\n\n1. First step.\n2. Second step.',
        );

        const published = renderPublicReview(review, undefined, { changedFilePaths: CHANGED_FILES })!;
        assert.ok(published.includes('- **Evidence:** src/jobs/followupCiSuspensionCancel.ts:142 — the stale attempt\n  is cancelled after the operator restart.\n\n  1. First step.'));
    });

    test('evidence that opens with a closed three-backtick code span survives publication and /fix selection', async () => {
        const evidence = [
            '```src/jobs/followupCiSuspensionCancel.ts``` cancels the stale attempt.',
            '1. ProPR persists the cancellation intent.',
            '2. An operator restarts the run before the cancel lands.',
        ].join('\n');
        const review = reviewWithF1Evidence([
            '- **evidence:** ```src/jobs/followupCiSuspensionCancel.ts``` cancels the stale attempt.',
            indent(evidence.split('\n').slice(1).join('\n')),
        ]);
        const [parsed] = parseStructuredReview(review).actionableFindings;
        assert.strictEqual(parsed.evidence, evidence);

        const published = renderPublicReview(review, undefined, { changedFilePaths: CHANGED_FILES })!;
        assert.ok(published);
        const reparsed = parseStructuredReview(publicComment(published).body);
        assert.strictEqual(reparsed.status, 'valid_with_blockers');
        assert.strictEqual(reparsed.actionableFindings[0].evidence, evidence);

        const gathered = await gatherUnprocessedReviewComments([publicComment(published)], gatherOptions);
        const selected = selectReviewFeedback(gathered, parseFixFindingSelection('F1'));
        assert.deepStrictEqual(selected.flatMap(comment => comment.actionableFindings.map(finding => finding.evidence)), [evidence]);

        // A closed span on an indented continuation line does not open a fence
        // that would swallow the fields after it.
        const continuation = reviewWithF1Evidence([
            '- **evidence:** src/jobs/followupCiSuspensionCancel.ts:142 — trace',
            '  ```cancelPendingRuns``` reads the stale attempt.',
        ]);
        assert.strictEqual(
            parseStructuredReview(continuation).actionableFindings[0].evidence,
            'src/jobs/followupCiSuspensionCancel.ts:142 — trace\n```cancelPendingRuns``` reads the stale attempt.',
        );
        assert.strictEqual(
            formatRecordField('Evidence', evidence).split('\n')[0],
            '- **Evidence:** ```src/jobs/followupCiSuspensionCancel.ts``` cancels the stale attempt.',
        );
    });

    test('rejects unsupported formatting instead of publishing apparently complete evidence', () => {
        const unsupported: Record<string, string[]> = {
            'an outdented paragraph after a blank line': [
                '- **evidence:** src/jobs/followupCiSuspensionCancel.ts:1 — trace',
                '',
                'This paragraph escaped the field.',
            ],
            'an unindented numbered list': [
                '- **evidence:** src/jobs/followupCiSuspensionCancel.ts:1 — trace',
                '1. first step',
            ],
            'a top-level label that would look like a new field': [
                '- **evidence:** src/jobs/followupCiSuspensionCancel.ts:1 — trace',
                '- Static trace: 1. first step',
            ],
            'an unindented heading': [
                '- **evidence:** src/jobs/followupCiSuspensionCancel.ts:1 — trace',
                '#### Details',
            ],
            'an unclosed code fence': [
                '- **evidence:** src/jobs/followupCiSuspensionCancel.ts:1 — trace',
                '  ```ts',
                '  cancel(attempt);',
            ],
            'text that escapes an open fence': [
                '- **evidence:** src/jobs/followupCiSuspensionCancel.ts:1 — trace',
                '  ```ts',
                'cancel(attempt);',
                '  ```',
            ],
            'content after a thematic break': [
                '- **evidence:** src/jobs/followupCiSuspensionCancel.ts:1 — trace',
                '---',
                '  orphaned continuation',
            ],
            'a duplicate field': [
                '- **evidence:** src/jobs/followupCiSuspensionCancel.ts:1 — trace',
                '- **evidence:** src/jobs/followupCiSuspensionCancel.ts:2 — second trace',
            ],
        };
        for (const [description, lines] of Object.entries(unsupported)) {
            const review = reviewWithF1Evidence(lines);
            assert.strictEqual(parseStructuredReview(review).status, 'invalid', description);
            assert.strictEqual(renderPublicReview(review, undefined, { changedFilePaths: CHANGED_FILES }), null, description);
        }

        const preamble = MACHINE_REVIEW.replace(
            '### F2: Release the renewed lease\n',
            '### F2: Release the renewed lease\nUnstructured preamble.\n',
        );
        assert.strictEqual(parseStructuredReview(preamble).status, 'invalid');
    });

    test('missing fields and tampered public continuations stay rejected', async () => {
        const missing = MACHINE_REVIEW.replace('- **minimumCorrection:** Compare against the renewed token on release.\n', '');
        assert.strictEqual(parseStructuredReview(missing).status, 'invalid');

        const published = renderPublicReview(MACHINE_REVIEW, undefined, { changedFilePaths: CHANGED_FILES })!;
        const tampered = published.replace(
            '  Static trace:\n',
            'Static trace escaped its field.\n\n  Static trace:\n',
        );
        assert.notStrictEqual(tampered, published);
        assert.strictEqual(parseStructuredReview(tampered).status, 'invalid');
        const gathered = await gatherUnprocessedReviewComments([publicComment(tampered)], gatherOptions);
        assert.deepStrictEqual(gathered[0].actionableFindings, []);
        assert.strictEqual(gathered[0].reviewStatus, 'invalid');
    });

    test('field serialization keeps block-leading values out of the label paragraph', () => {
        assert.strictEqual(formatRecordField('Evidence', 'one line'), '- **Evidence:** one line');
        assert.strictEqual(
            formatRecordField('Minimum fix', '1. Re-read the attempt.\n2. Keep the obligation.'),
            '- **Minimum fix:**\n\n  1. Re-read the attempt.\n  2. Keep the obligation.',
        );
        const findings = parseStructuredReview(MACHINE_REVIEW).actionableFindings.map(finding => ({
            ...finding,
            minimumCorrection: '1. Re-read the attempt.\n2. Keep the obligation.',
        }));
        const reparsed = extractActionableFindings(`## Actionable Findings\n${formatActionableFindings(findings)}`);
        assert.deepStrictEqual(reparsed.map(finding => finding.minimumCorrection), [
            '1. Re-read the attempt.\n2. Keep the obligation.',
            '1. Re-read the attempt.\n2. Keep the obligation.',
        ]);
    });
});
