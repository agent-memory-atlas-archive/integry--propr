---
title: Goals
---

Goals keep a coding-agent session working toward a continuing objective. Use a [task](./launching-work.md) for a single bounded request, or a [plan](./planning.md) when you want to approve the issue breakdown first.

Goals retain an objective, provider session, goal branch, and delivery history across execution attempts. Choose a configured, goal-capable agent when creating a goal. ProPR probes the configured runtime before accepting it.

## Start and monitor a goal

1. Open **Goals**, choose **New Goal**, then select a repository and a goal-capable agent/model.
2. Choose **Agent orchestrates through ProPR** or **Agent implements directly**. Orchestrated goals coordinate work through ProPR; direct goals work in the goal workspace. Direct checkpoint cadence is guidance to the agent, not a commit timer.
3. Enter the objective and attach supporting material. Respect the character limit shown for the selected provider. Start the goal and open it from the work queue.

![Goals work queue showing an active analytics goal and a completed billing goal with status and progress](/img/screenshots/0.9.0/goals.png)

The detail console brings together context, current activity, progress, artifacts, logs and published [visual previews](./visual-previews.md). Repository and status filters narrow the queue. A finished task is distinct from a finished goal; use the goal's result and final PR to assess completion.

## Native execution and corrections

Codex and Claude Code have native goal execution support. Antigravity supports goals through persistent CLI conversations, as described below. Availability is checked against the configured runtime: an agent listed for ordinary tasks is not necessarily goal-capable. If none is available, use the capability diagnostics and recheck after updating the runtime.

Send a correction from the goal console or through MCP's `send_goal_input` to steer the existing session. The timeline records your message verbatim so you can distinguish operator input from agent output. Delivery follows the provider's reported capability: Codex and Claude use native live controls, while other supported providers may resume at a safe boundary. A queued input is not proof that the agent has already acted on it.

**Pause**, **Resume** and **Cancel** also follow provider boundaries. A pending pause or cancellation can take time to acknowledge; watch the displayed state. Model changes apply at a boundary. Terminal goals no longer accept corrections. Inspect earlier inputs with MCP's `list_goal_inputs`, or use `get_goal` for progress and current activity.

## Antigravity sessions

Antigravity uses the same ProPR goal lifecycle as the other supported agents, backed by its native persistent conversation storage. The CLI must support noninteractive execution, `--output-format stream-json`, and exact `--conversation` resume. ProPR mounts persistent Antigravity configuration for goals and saves the conversation identity from the initial stream event. Ordinary task invocations continue to use disposable state.

The stream supplies live narration and activity to goal details and `get_agent_activity`. A successful goal invocation must report a resumable conversation and a terminal success result. CLI success alone does not prove delivery.

Antigravity queues operator input for a safe boundary and resumes the saved conversation with the correction. Pause stops execution at a resumable boundary; resume continues that conversation. Cancel terminates the goal through the shared lifecycle. Antigravity does not advertise live steering; Codex and Claude have separate native control transports within this same lifecycle.

## Checkpoints and controls

For direct implementation, ProPR prepares the branch and opens the draft PR before agent execution. The agent edits the prepared worktree and requests checkpoints by ending its turn with JSON:

```json
{"checkpointReady":true,"message":"feat(example): implement the next coherent change","summary":"Describe the completed work."}
```

Optional `include` and `exclude` arrays select repository-relative files. ProPR validates, commits, pushes, and records the checkpoint, then resumes the conversation with acknowledgement. The agent must leave Git operations and PR creation to ProPR.

## Completion

ProPR publishes the final direct-implementation checkpoint and validates an **open draft PR on the saved goal branch against the expected base branch**. A provider saying it is finished, or reporting a different PR, cannot bypass this validation. Inspect goal details for checkpoint, input-delivery, and final PR evidence.

When validating a runtime upgrade, run a disposable goal through creation, activity, a checkpoint, operator input, pause/resume, cancellation, and successful final draft PR validation. Unit tests and CLI help probes alone do not establish that the authenticated integration works end to end.
