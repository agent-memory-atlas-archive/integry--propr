/**
 * Authorized follow-up requests for PR reviews.
 *
 * A review judges the PR against its original objective, but a person may
 * later ask ProPR to change that behavior on the same PR (a GitHub follow-up
 * comment or a Desktop/API follow-up). Without those requests the reviewer
 * treats the requested change as a regression against the original objective.
 *
 * Only requests ProPR itself accepted and completed count. The evidence is the
 * existing work-evidence marker that ProPR's completion comment carries: a
 * `phase=completed` marker inside a comment authored by the authenticated
 * ProPR identity names the trigger comments that passed the follow-up author,
 * assignment and API authorization gates when they were dispatched. Anything
 * else in the comment history — prior reviews, bot summaries, review
 * suggestions, unprocessed or untrusted comments — never becomes a requirement
 * here merely by appearing on the PR.
 */

import { parseSlashCommand } from '@propr/core';

export interface FollowupSourceComment {
    id: number;
    user: { login: string; type?: string } | null;
    body?: string | null;
    created_at: string;
}

export interface AuthorizedFollowupRequest {
    commentId: number;
    createdAt: string;
    /** GitHub login of the person, or undefined for a ProPR API follow-up. */
    requester?: string;
    /** The requested behavior change, without command lines or ProPR markers. */
    text: string;
}

const COMPLETED_EVIDENCE = /<!-- propr:work-evidence phase=completed trigger-comment-ids=([\d,]+) -->/g;
// Mirrors `prepareApiFollowup`: the API registers and posts the request as the bot.
const API_FOLLOWUP_MARKER = /\n\n<!-- propr-api-followup:[a-f0-9-]{36} -->$/;

function completedTriggerIds(comments: readonly FollowupSourceComment[], botLogin: string): Set<number> {
    const ids = new Set<number>();
    for (const comment of comments) {
        if (comment.user?.login !== botLogin || !comment.body) continue;
        for (const match of comment.body.matchAll(COMPLETED_EVIDENCE)) {
            for (const id of match[1].split(',')) {
                const parsed = Number(id);
                if (Number.isSafeInteger(parsed) && parsed > 0) ids.add(parsed);
            }
        }
    }
    return ids;
}

/**
 * The behavior a completed trigger comment asked for. Review, merge and
 * Ultrafix commands request no behavior change, and `/fix` selectors only name
 * review records, so selected review prose is never imported as a requirement;
 * prose written below a `/fix`, `/use` or `/switch` command line is the
 * person's own request.
 */
function requestedText(body: string): string {
    const command = parseSlashCommand(body);
    if (!command) return body.trim();
    return ['fix', 'use', 'switch'].includes(command.command) ? command.instructions.trim() : '';
}

/**
 * Follow-up requests ProPR accepted and completed on this PR, newest first.
 * `botLogin` must be the authenticated ProPR identity; completion markers in
 * any other author's comment are ignored.
 */
export function collectAuthorizedFollowupRequests(
    comments: readonly FollowupSourceComment[],
    botLogin: string | undefined,
): AuthorizedFollowupRequest[] {
    if (!botLogin) return [];
    const completed = completedTriggerIds(comments, botLogin);
    const requests: AuthorizedFollowupRequest[] = [];
    for (const comment of comments) {
        if (!completed.has(comment.id) || !comment.body || !comment.user) continue;
        let body = comment.body;
        let requester: string | undefined = comment.user.login;
        if (requester === botLogin) {
            // A bot-authored trigger is only a request when the API posted it.
            if (!API_FOLLOWUP_MARKER.test(body)) continue;
            body = body.replace(API_FOLLOWUP_MARKER, '');
            requester = undefined;
        }
        const text = requestedText(body);
        if (text) requests.push({ commentId: comment.id, createdAt: comment.created_at, requester, text });
    }
    return requests.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.commentId - a.commentId);
}

/** Prompt text for the review's authorized follow-up section; empty when there are none. */
export function formatAuthorizedFollowupRequests(requests: readonly AuthorizedFollowupRequest[]): string {
    return requests.map(request => {
        const source = request.requester ? `requested by @${request.requester}` : 'submitted through ProPR by an authorized user';
        return `---\n**Follow-up request** (comment ${request.commentId}, ${request.createdAt}, ${source})\n${request.text}\n---\n`;
    }).join('');
}
