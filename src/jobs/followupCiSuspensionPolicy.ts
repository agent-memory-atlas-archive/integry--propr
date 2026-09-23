/**
 * Decides which workflows may have their runs cancelled while a follow-up
 * implementation replaces a pull request head.
 *
 * A trigger event is not a workflow classification: preview, deployment and
 * publication workflows use `pull_request` and `pull_request_target` like
 * validation workflows do, and cancelling one of those can tear down an
 * environment instead of freeing a runner. Eligibility is therefore an explicit
 * policy: either the exact workflows an operator listed, or — with nothing
 * configured — only `pull_request` workflows whose name or file identifies them
 * as validation and never as publication.
 */

/** Both pull request events exist; only an explicit allowlist can qualify `pull_request_target`. */
const PULL_REQUEST_EVENTS: ReadonlySet<string> = new Set(['pull_request', 'pull_request_target']);
/**
 * `pull_request_target` runs against the base branch with repository secrets,
 * which is how preview and deployment automation is written (this repository's
 * own "PR Preview" is one), so the default policy never qualifies it.
 */
const DEFAULT_EVENTS: ReadonlySet<string> = new Set(['pull_request']);

/** A workflow that states it validates the revision: these are the runs a replacement commit makes obsolete. */
const VALIDATION_WORKFLOW_PATTERN = /(^|[^a-z])(ci|checks?|tests?|testing|lint|linting|build|builds|compile|validate|validation|verify|verification|typecheck|types|unit|e2e|integration|compat|compatibility|coverage|guard|guards|review|audit|scan|scanning|analysis|analyze|analyse|codeql|quality|format|formatting|spell|security)([^a-z]|$)/;
/** A workflow that publishes something. Cancelling one can leave an environment half-updated, so it is never eligible by default. */
const PUBLICATION_WORKFLOW_PATTERN = /(^|[^a-z])(deploy|deploys|deployment|deployments|preview|previews|publish|publishes|publishing|release-please|provision|promote|promotion|rollout|staging|production|pages|announce|upload|uploads|npm|dockerhub)([^a-z]|$)/;

/** Operator-listed workflows, by display name, workflow file path or file name. */
export const VALIDATION_WORKFLOW_ALLOWLIST_ENV = 'CANCEL_CI_FOLLOWUP_WORKFLOWS';

export interface ValidationWorkflowPolicy {
    /** Explicitly eligible workflow identities; empty means the documented default policy applies. */
    allowlist: ReadonlySet<string>;
}

export interface WorkflowRunIdentity {
    name?: string | null;
    path?: string | null;
    event?: string | null;
}

function normalize(value: string | null | undefined): string {
    return (value ?? '').trim().toLowerCase();
}

/** Every spelling one workflow can be referred to by: its display name, its file path, and that file's name with and without extension. */
export function workflowIdentities(run: WorkflowRunIdentity): string[] {
    const identities = new Set<string>();
    const name = normalize(run.name);
    if (name) identities.add(name);
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

/**
 * Reads the configured allowlist. Unset or empty means the default policy;
 * entries are matched case-insensitively against the workflow's name, path or
 * file name.
 */
export function loadValidationWorkflowPolicy(env: NodeJS.ProcessEnv = process.env): ValidationWorkflowPolicy {
    const configured = (env[VALIDATION_WORKFLOW_ALLOWLIST_ENV] ?? '')
        .split(',')
        .map(entry => normalize(entry))
        .filter(Boolean);
    return { allowlist: new Set(configured) };
}

/**
 * Whether this workflow's runs may be cancelled for an obsolete head. With an
 * allowlist configured only those workflows qualify — including
 * `pull_request_target` ones, which the operator named deliberately. Without
 * one, a `pull_request` workflow qualifies when its name or file says it
 * validates the revision and says nothing about publishing it.
 */
export function isEligibleValidationWorkflow(
    run: WorkflowRunIdentity,
    policy: ValidationWorkflowPolicy = loadValidationWorkflowPolicy(),
): boolean {
    const event = normalize(run.event);
    if (!PULL_REQUEST_EVENTS.has(event)) return false;
    const identities = workflowIdentities(run);
    if (identities.length === 0) return false;
    if (policy.allowlist.size > 0) {
        return identities.some(identity => policy.allowlist.has(identity));
    }
    if (!DEFAULT_EVENTS.has(event)) return false;
    if (identities.some(identity => PUBLICATION_WORKFLOW_PATTERN.test(identity))) return false;
    return identities.some(identity => VALIDATION_WORKFLOW_PATTERN.test(identity));
}
