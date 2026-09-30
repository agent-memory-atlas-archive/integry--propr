# Goals

Goals keep a coding-agent session working toward a continuing objective. Use a [task](./launching-work.md) for a single bounded request, or a [plan](./planning.md) when you want to approve the issue breakdown first.

## Start and monitor a goal

1. Open **Goals**, choose **New Goal**, then select a repository and a goal-capable agent/model.
2. Choose **Agent orchestrates through ProPR** or **Agent implements directly**. Orchestrated goals coordinate work through ProPR; direct goals work in the goal workspace. Direct checkpoint cadence is guidance to the agent, not a commit timer.
3. Enter the objective and attach supporting material. Respect the character limit shown for the selected provider. Start the goal and open it from the work queue.

![Goals work queue showing an active analytics goal and a completed billing goal with status and progress](/img/screenshots/0.9.0/goals.png)

The detail console brings together context, current activity, progress, artifacts, logs and published [visual previews](./visual-previews.md). Repository and status filters narrow the queue. A finished task is distinct from a finished goal; use the goal's result and final PR to assess completion.

## Native execution and corrections

Codex and Claude Code have native goal execution support. Availability is checked against the configured runtime: an agent listed for ordinary tasks is not necessarily goal-capable. If none is available, use the capability diagnostics and recheck after updating the runtime.

Send a correction from the goal console to steer the existing session. The timeline records your message verbatim so you can distinguish operator input from agent output. Delivery follows the provider's reported capability: Codex and Claude use native live controls, while other supported providers may resume at a safe boundary. A queued input is not proof that the agent has already acted on it.

**Pause**, **Resume** and **Cancel** also follow provider boundaries. A pending pause or cancellation can take time to acknowledge; watch the displayed state. Model changes apply at a boundary. Terminal goals no longer accept corrections. Inspect earlier inputs with MCP's `list_goal_inputs`, or use `get_goal` for progress and current activity.
