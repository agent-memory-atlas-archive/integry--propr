import assert from "node:assert/strict";
import { test } from "node:test";
import { followupHandoffPath, type FollowupHandoffStatus } from "../api/followupHandoffs.js";
import { ApiError } from "../api/errors.js";
import {
  createHandoffsCommand,
  formatHandoffStatus,
  formatRecoverySummary,
  handoffErrorMessage,
  parseHandoffTarget,
} from "./handoffCommands.js";

test("handoff targets parse owner/repo and a positive pull request number", () => {
  assert.deepEqual(parseHandoffTarget("Integry/ProPR", "42"), { owner: "Integry", repo: "ProPR", pullRequest: 42 });
  assert.throws(() => parseHandoffTarget("not-a-repo", "42"), /expected owner\/repo/);
  assert.throws(() => parseHandoffTarget("a/b/c", "42"), /expected owner\/repo/);
  assert.throws(() => parseHandoffTarget("integry/propr", "0"), /positive integer/);
  assert.throws(() => parseHandoffTarget("integry/propr", "4.2"), /positive integer/);
});

test("handoff API paths address the admin endpoints with encoded segments", () => {
  assert.equal(followupHandoffPath("integry", "propr", 42), "/api/admin/followup-handoffs/integry/propr/42");
  assert.equal(followupHandoffPath("integry", "propr", 42, "resume"), "/api/admin/followup-handoffs/integry/propr/42/resume");
  assert.equal(followupHandoffPath("integry", "propr", 42, "release"), "/api/admin/followup-handoffs/integry/propr/42/release");
  assert.equal(followupHandoffPath("a b", "c/d", 7), "/api/admin/followup-handoffs/a%20b/c%2Fd/7");
});

function handoffStatus(): FollowupHandoffStatus {
  return {
    repository: "integry/propr", pullRequest: 42, taskId: "task-1",
    predecessorTaskIds: ["task-0"], successorTaskId: null, phase: "pushed",
    status: "awaiting_operator", statusReason: "cancelled_by_user", operatorAuthorized: false,
    liveness: "not_checked", branchName: "propr/fix-42", commitHash: "abc123",
    completionCommentUrl: null, nextAction: "resume --authorize-cancelled to publish the cancelled work",
    retainedWorktreePath: "/tmp/worktrees/fix-42", updatedAt: 1760650000000,
  };
}

test("human handoff output shows phase, status, liveness, lineage, retained work and next action", () => {
  const text = formatHandoffStatus(handoffStatus()).join("\n");
  assert.match(text, /integry\/propr#42/);
  assert.match(text, /Phase:\s+pushed/);
  assert.match(text, /Status:\s+awaiting_operator \(cancelled_by_user\)/);
  assert.match(text, /Liveness:\s+not_checked/);
  assert.match(text, /Branch:\s+propr\/fix-42/);
  assert.match(text, /Predecessors:\s+task-0/);
  assert.match(text, /Successor task:\s+\(none\)/);
  assert.match(text, /Retained worktree: \/tmp\/worktrees\/fix-42/);
  assert.match(text, /Commit:\s+abc123/);
  assert.match(text, /Next action:\s+resume --authorize-cancelled/);
});

test("recovery summaries render every counter", () => {
  const line = formatRecoverySummary({
    inspected: 3, published: 1, noChanges: 1, cleanupPending: 1, skippedLiveAgent: 0,
    failedClosed: 0, awaitingOperator: 0, lockedByOtherWriter: 0, errors: 0,
  });
  assert.match(line, /inspected 3/);
  assert.match(line, /published 1/);
  assert.match(line, /cleanup pending 1/);
  assert.match(line, /errors 0/);
});

test("refusal codes become actionable operator messages", () => {
  const conflict = (body: Record<string, unknown>) =>
    new ApiError("Request failed with status 409.", "UNKNOWN", 409, body as never);
  assert.match(
    handoffErrorMessage(conflict({ error: "cancelled", code: "requires_cancellation_authorization" })),
    /--authorize-cancelled/
  );
  assert.match(
    handoffErrorMessage(conflict({ released: false, reason: "worktree_holds_unpublished_work" })),
    /--force/
  );
  assert.match(
    handoffErrorMessage(conflict({ error: "no", code: "cancellation_authorization_unavailable" })),
    /not granted/
  );
  assert.match(handoffErrorMessage(conflict({ error: "held", code: "superseded" })), /\(superseded\)/);
  assert.equal(handoffErrorMessage(new Error("plain failure")), "plain failure");
});

test("the handoffs command group registers list, inspect, resume and release with their flags", () => {
  const command = createHandoffsCommand();
  assert.equal(command.name(), "handoffs");
  const names = command.commands.map(subcommand => subcommand.name()).sort();
  assert.deepEqual(names, ["inspect", "list", "release", "resume"]);
  const flags = (name: string) =>
    command.commands.find(subcommand => subcommand.name() === name)!.options.map(option => option.long);
  assert.ok(flags("resume").includes("--authorize-cancelled"));
  assert.ok(flags("release").includes("--force"));
  for (const name of names) assert.ok(flags(name).includes("--json"), `${name} supports --json`);
});
