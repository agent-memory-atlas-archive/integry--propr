---
title: Goals
---

Goals retain an objective, provider session, goal branch, and delivery history across execution attempts. Choose a configured, goal-capable agent when creating a goal. ProPR probes the configured runtime before accepting it.

## Antigravity sessions

Antigravity uses the same ProPR goal lifecycle as the other supported agents, backed by its native persistent conversation storage. The CLI must support noninteractive execution, `--output-format stream-json`, and exact `--conversation` resume. ProPR mounts persistent Antigravity configuration for goals and saves the conversation identity from the initial stream event. Ordinary task invocations continue to use disposable state.

The stream supplies live narration and activity to goal details and `get_agent_activity`. A successful goal invocation must report a resumable conversation and a terminal success result. CLI success alone does not prove delivery.

## Checkpoints and controls

For direct implementation, ProPR prepares the branch and opens the draft PR before agent execution. The agent edits the prepared worktree and requests checkpoints by ending its turn with JSON:

```json
{"checkpointReady":true,"message":"feat(example): implement the next coherent change","summary":"Describe the completed work."}
```

Optional `include` and `exclude` arrays select repository-relative files. ProPR validates, commits, pushes, and records the checkpoint, then resumes the conversation with acknowledgement. The agent must leave Git operations and PR creation to ProPR.

Send corrections using `send_goal_input`. Antigravity queues input for a safe boundary and resumes the saved conversation with the correction. Pause stops execution at a resumable boundary; resume continues that conversation. Cancel terminates the goal through the shared lifecycle. Antigravity does not advertise live steering; Codex and Claude have separate native control transports within this same lifecycle.

## Completion

ProPR publishes the final direct-implementation checkpoint and validates an **open draft PR on the saved goal branch against the expected base branch**. A provider saying it is finished, or reporting a different PR, cannot bypass this validation. Inspect goal details for checkpoint, input-delivery, and final PR evidence.

When validating a runtime upgrade, run a disposable goal through creation, activity, a checkpoint, operator input, pause/resume, cancellation, and successful final draft PR validation. Unit tests and CLI help probes alone do not establish that the authenticated integration works end to end.
