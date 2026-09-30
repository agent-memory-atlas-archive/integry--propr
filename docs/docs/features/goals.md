# Goals

Goals keep a coding-agent session working toward a continuing objective. Use a [task](./launching-work.md) for a single bounded request, or a [plan](./planning.md) when you want to approve the issue breakdown first.

## Which agents run goals

| Agent | Goal support |
| --- | --- |
| Claude Code | Native goal execution. Corrections reach the running session live. |
| Codex | Native goal execution. Corrections reach the running session live. |
| Antigravity CLI | Resumable sessions. ProPR resumes the same session after checkpoints; corrections and pause apply at the next safe boundary. |
| OpenCode, Mistral Vibe | Not supported. Use tasks or plans with these agents. |

Synthetic pools cannot run goals. Availability is also checked against the configured runtime image: an agent listed for ordinary tasks is not necessarily goal-capable in your installation. If no goal-capable agent is available, use the capability diagnostics and recheck after updating the runtime.

## Start and monitor a goal

1. Open **Goals**, choose **New Goal**, then select a repository and a goal-capable agent/model.
2. Choose a launch strategy (see below) and, optionally, the maximum number of parallel tasks and whether the agent runs Ultrafix before it finishes.
3. Enter the objective and attach supporting material. Respect the character limit shown for the selected provider. Start the goal and open it from the work queue.

![Goals work queue showing an active analytics goal and a completed billing goal with status and progress](/img/screenshots/0.9.0/goals.png)

The detail console brings together context, current activity, progress, artifacts, logs and published [visual previews](./visual-previews.md). Repository and status filters narrow the queue. A finished task is distinct from a finished goal; use the goal's result and final PR to assess completion.

## Launch strategies

**Agent implements directly.** The agent works in the goal workspace. ProPR opens a draft PR on the goal branch and owns every commit and push. When a coherent set of changes is ready, the agent requests a checkpoint; ProPR validates the listed paths, commits only that scope, pushes, records the commit and publishes current visual previews to the draft PR. The checkpoint cadence defaults to roughly every 15 minutes. It is guidance to the agent, not a timer that interrupts it.

**Agent orchestrates through ProPR.** The agent decides how to break the objective down, creates GitHub issues, and starts and monitors their implementation through ProPR, optionally building an epic PR from the resulting PRs. It must track every issue and PR it creates and finish with a validated draft PR containing the final implementation.

In both strategies, **max parallel tasks** is a limit the agent enforces itself; ProPR does not schedule a plan graph for goals. With **Ultrafix** enabled, the agent runs Ultrafix as part of delivery before declaring the goal complete; with it disabled, the agent runs Ultrafix only if a later correction asks for it.

## Corrections, pause and cancel

Send a correction from the goal console to steer the existing session. The timeline records your message verbatim so you can distinguish operator input from agent output. Delivery follows the agent's capability: Claude Code and Codex receive input live, while Antigravity receives it when the session resumes at the next safe boundary. A queued input is not proof that the agent has already acted on it.

**Pause**, **Resume** and **Cancel** also follow provider boundaries. A pending pause or cancellation can take time to acknowledge; watch the displayed state. Model changes apply at a boundary. Terminal goals no longer accept corrections.

Goals are launched and managed from the Web UI or [MCP](./mcp.md): `create_goal`, `get_goal` for progress and current activity, `send_goal_input` for corrections, and `list_goal_inputs` to inspect earlier inputs. The `propr` CLI has no goal commands.
