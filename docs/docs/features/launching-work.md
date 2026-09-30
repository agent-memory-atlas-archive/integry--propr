# Launching Work

Use **New Task** for one bounded change, **New Plan** when you want to review a set of issues before execution, or **New Goal** for a continuing objective. The header defaults to New Task, switches to New Plan in Plans/Planner Studio and New Goal in Goals, and keeps the other two actions in its menu. All three use configured repositories and agents.

## Start a task

1. Open **New Task** (`/tasks/new`) and select an enabled repository.
2. Enter the **Instruction** with the intended result and acceptance criteria. Attach relevant files if needed, and choose agent/model routing when overriding the default.
3. Choose **Run task**. ProPR creates a GitHub issue and submits the ordinary implementation task. Follow the linked task for progress and its resulting PR.

![New task form with a repository, invoice formatting instruction and Run task action](/img/screenshots/0.9.0/new-task.png)

The repository workspace's **New task** action prefills the repository. Select a to-do and choose **Run task** to prefill its text; launching does not mark the to-do complete. Submission acceptance is not implementation completion. If submission reports a failure or uncertain issue creation, use the displayed recovery action instead of starting duplicate requests.

MCP clients can use `create_task` with execute scope and a stable idempotency key; see [MCP](./mcp.md). The CLI's existing issue implementation and `task inspect` commands are described in [CLI workflows](./cli-workflows.md).

## Plan or goal?

[Planner Studio](../tutorials/planner-studio.md) lets you edit, refine and approve a complete plan before creating issues. [Goals](./goals.md) keep an agent working toward an objective with progress, corrective inputs and pause/resume controls.
