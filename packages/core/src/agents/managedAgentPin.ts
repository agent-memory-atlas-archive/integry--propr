import { AGENT_TYPES } from './constants.js';
import type { AgentType } from './types.js';
import { AGENT_DEFAULT_VERSIONS } from './version/types.js';
import type { AgentCliVersionMatrix } from './version/versionService.js';

/**
 * A published Desktop runtime binds one digest-pinned managed agent image to
 * its source revision (see docker/launcher/orchestrator.mjs). The launcher
 * hands the pin to every app container; generic and hosted stacks never set it.
 */
export interface ManagedAgentPin {
    image: string;
    sourceRevision: string;
}

/** Mirrors the launcher's MANAGED_AGENT_IMAGE: propr/agent:<source SHA>@sha256:<digest>. */
const MANAGED_AGENT_IMAGE = /^propr\/agent:([0-9a-f]{40})@sha256:[0-9a-f]{64}$/;

export function readManagedAgentPin(env: NodeJS.ProcessEnv = process.env): ManagedAgentPin | null {
    const image = env.PROPR_MANAGED_AGENT_IMAGE?.trim();
    const sourceRevision = env.PROPR_MANAGED_AGENT_REVISION?.trim();
    if (!image || !sourceRevision) return null;
    return MANAGED_AGENT_IMAGE.exec(image)?.[1] === sourceRevision ? { image, sourceRevision } : null;
}

/**
 * Agent types whose configured CLI version differs from the snapshot the pin
 * was built with. The pin is built from this app's source revision without
 * build-arg overrides, so its snapshot is this revision's default matrix; the
 * image labels are verified against the same matrix before it is used.
 */
export function managedAgentVersionDifferences(versions: AgentCliVersionMatrix): AgentType[] {
    return AGENT_TYPES.filter(type => versions[type] !== AGENT_DEFAULT_VERSIONS[type]);
}

/** The pin when it can serve this exact CLI matrix; null keeps the generated-bundle path. */
export function managedAgentPinFor(versions: AgentCliVersionMatrix, env: NodeJS.ProcessEnv = process.env): ManagedAgentPin | null {
    const pin = readManagedAgentPin(env);
    return pin && managedAgentVersionDifferences(versions).length === 0 ? pin : null;
}
