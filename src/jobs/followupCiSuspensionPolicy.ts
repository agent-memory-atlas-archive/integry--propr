/**
 * Decides which workflows may have their runs cancelled while a follow-up
 * implementation replaces a pull request head.
 *
 * Eligibility is never inferred. A trigger event is not a workflow
 * classification and neither is a workflow's name: preview, deployment and
 * publication workflows use `pull_request` and `pull_request_target` like
 * validation workflows do, and a workflow called `Build` or `CI` is free to
 * deploy. Cancelling one of those tears down an environment instead of freeing
 * a runner. Only the exact workflows an operator selected are eligible; with
 * nothing selected nothing is ever cancelled.
 */

/** Both pull request events qualify once a workflow was selected; nothing else does, whatever it is called. */
const PULL_REQUEST_EVENTS: ReadonlySet<string> = new Set(['pull_request', 'pull_request_target']);

/** Operator-selected workflows, as a documented fallback for repositories configured outside the UI. */
export const VALIDATION_WORKFLOW_ALLOWLIST_ENV = 'CANCEL_CI_FOLLOWUP_WORKFLOWS';

/** Where a selection came from, so logs and the UI can say what to change. */
export type ValidationWorkflowPolicySource = 'repository' | 'environment' | 'none';

export interface ValidationWorkflowPolicy {
    /** Exact workflow identities selected by an operator. Empty means nothing is eligible. */
    selected: ReadonlySet<string>;
    source: ValidationWorkflowPolicySource;
}

/** No selection: the safe state this feature starts in and falls back to. */
export const NO_VALIDATION_WORKFLOWS_SELECTED: ValidationWorkflowPolicy = { selected: new Set(), source: 'none' };

export interface WorkflowRunIdentity {
    name?: string | null;
    path?: string | null;
    event?: string | null;
    /** GitHub's numeric workflow ID, which an operator may select instead of a path. */
    workflow_id?: number | null;
}

function normalize(value: string | null | undefined): string {
    return (value ?? '').trim().toLowerCase();
}

/**
 * The spellings one selected workflow can be written as: its numeric ID, its
 * workflow file path, that file's name with and without extension, and its
 * display name. Every one of them identifies exactly one workflow — none of
 * them is a substring match.
 */
export function workflowIdentities(run: WorkflowRunIdentity): string[] {
    const identities = new Set<string>();
    const name = normalize(run.name);
    if (name) identities.add(name);
    if (typeof run.workflow_id === 'number' && Number.isFinite(run.workflow_id)) identities.add(String(run.workflow_id));
    const path = normalize(run.path);
    if (path) {
        identities.add(path);
        const file = path.split('/').pop() ?? '';
        if (file) {
            identities.add(file);
            identities.add(file.replace(/\.ya?ml$/, ''));
        }
    }
    return [...identities].filter(Boolean);
}

/** Normalizes what an operator typed or stored into comparable workflow identities. */
export function parseWorkflowSelection(values: Iterable<string | null | undefined> | null | undefined): string[] {
    const selection: string[] = [];
    for (const value of values ?? []) {
        const identity = normalize(value);
        if (identity && !selection.includes(identity)) selection.push(identity);
    }
    return selection;
}

export function createValidationWorkflowPolicy(
    selection: Iterable<string | null | undefined> | null | undefined,
    source: Exclude<ValidationWorkflowPolicySource, 'none'>,
): ValidationWorkflowPolicy {
    const selected = parseWorkflowSelection(selection);
    return selected.length === 0 ? NO_VALIDATION_WORKFLOWS_SELECTED : { selected: new Set(selected), source };
}

/**
 * The documented fallback for instances that configure repositories outside the
 * Web UI: the same explicit selection, read from the environment. It applies
 * only to repositories that selected no workflows themselves.
 */
export function loadValidationWorkflowPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ValidationWorkflowPolicy {
    return createValidationWorkflowPolicy((env[VALIDATION_WORKFLOW_ALLOWLIST_ENV] ?? '').split(','), 'environment');
}

/** The repository's own selection decides; the environment fallback applies only when it selected nothing. */
export function resolveValidationWorkflowPolicy(
    repositorySelection: readonly string[] | null | undefined,
    env: NodeJS.ProcessEnv = process.env,
): ValidationWorkflowPolicy {
    const repository = createValidationWorkflowPolicy(repositorySelection, 'repository');
    return repository.selected.size > 0 ? repository : loadValidationWorkflowPolicyFromEnv(env);
}

/**
 * Whether this workflow's runs may be cancelled for an obsolete head: only when
 * the operator selected this exact workflow, and only for a pull request event.
 * An unselected workflow is never cancelled, whatever its name suggests it does.
 */
export function isEligibleValidationWorkflow(
    run: WorkflowRunIdentity,
    policy: ValidationWorkflowPolicy = NO_VALIDATION_WORKFLOWS_SELECTED,
): boolean {
    if (policy.selected.size === 0) return false;
    if (!PULL_REQUEST_EVENTS.has(normalize(run.event))) return false;
    return workflowIdentities(run).some(identity => policy.selected.has(identity));
}
