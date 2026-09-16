import logger from '../utils/logger.js';

export const UNIFIED_AGENT_IMAGE_RETRY_BASE_DELAY_MS = 5_000;
export const UNIFIED_AGENT_IMAGE_RETRY_MAX_DELAY_MS = 5 * 60_000;
export const UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS = 5;
const UNIFIED_AGENT_IMAGE_RETRY_JITTER_RATIO = 0.25;

export interface UnavailableUnifiedAgentImage {
    imageTag?: string;
    error: string;
    recordedAt: string;
    retryCount?: number;
    nextRetryAt?: string;
    circuitBreakerOpen?: boolean;
    operatorActionRequired?: boolean;
}

export function getUnifiedAgentImageRetryDelay(
    retryCount: number,
    random = Math.random,
): number {
    const exponentialDelay = Math.min(
        UNIFIED_AGENT_IMAGE_RETRY_MAX_DELAY_MS,
        UNIFIED_AGENT_IMAGE_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryCount - 1),
    );
    const jitter = 1 + (random() * 2 - 1) * UNIFIED_AGENT_IMAGE_RETRY_JITTER_RATIO;
    return Math.round(exponentialDelay * jitter);
}

export function scheduleUnifiedAgentImageRetry(options: {
    unavailable: UnavailableUnifiedAgentImage | null;
    imagePreparationOwner: boolean;
    retryTimer: NodeJS.Timeout | null;
    startRecovery: () => Promise<void>;
    setRetryTimer: (timer: NodeJS.Timeout | null) => void;
}): void {
    const { unavailable } = options;
    if (
        options.imagePreparationOwner
        || options.retryTimer
        || !unavailable
        || unavailable.circuitBreakerOpen
        || (unavailable.retryCount ?? 0) >= UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS
    ) return;

    const delay = unavailable.nextRetryAt
        ? Math.max(0, Date.parse(unavailable.nextRetryAt) - Date.now())
        : getUnifiedAgentImageRetryDelay(unavailable.retryCount ?? 1);
    unavailable.nextRetryAt = new Date(Date.now() + delay).toISOString();
    const timer = setTimeout(() => {
        options.setRetryTimer(null);
        if (!unavailable.circuitBreakerOpen) void options.startRecovery();
    }, delay);
    timer.unref?.();
    options.setRetryTimer(timer);
}

export function recordUnifiedAgentImageFailure(options: {
    previous: UnavailableUnifiedAgentImage | null;
    imageTag: string | undefined;
    error: string;
    diskPressure: boolean;
    attemptFailed?: boolean;
}): { state: UnavailableUnifiedAgentImage; shouldRetry: boolean } {
    const sameImage = options.previous?.imageTag === options.imageTag;
    const previous = sameImage ? options.previous : null;
    const attemptFailed = options.attemptFailed ?? true;
    const retryCount = (previous?.retryCount ?? 0) + (attemptFailed ? 1 : 0);
    const circuitBreakerOpen = previous?.circuitBreakerOpen
        || options.diskPressure || retryCount >= UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS;
    const operatorActionRequired = previous?.operatorActionRequired || options.diskPressure;
    const nextRetryAt = attemptFailed
        ? new Date(Date.now() + getUnifiedAgentImageRetryDelay(retryCount)).toISOString()
        : previous?.nextRetryAt;
    const state: UnavailableUnifiedAgentImage = {
        imageTag: options.imageTag,
        error: options.error,
        recordedAt: new Date().toISOString(),
        retryCount,
        circuitBreakerOpen: circuitBreakerOpen || undefined,
        operatorActionRequired: operatorActionRequired || undefined,
        nextRetryAt: circuitBreakerOpen ? undefined : nextRetryAt,
    };
    return { state, shouldRetry: !circuitBreakerOpen };
}

export function logUnifiedAgentImageCircuitOpen(
    imageTag: string | undefined,
    error: string,
    retryCount: number | undefined,
    diskPressure: boolean,
): void {
    logger.error(
        { imageTag, error, retryCount, diskPressure },
        diskPressure
            ? 'Unified agent image recovery halted by disk pressure; operator action is required'
            : 'Unified agent image recovery circuit breaker opened after repeated failures',
    );
}

export function startUnifiedAgentImageRecovery(options: {
    unavailable: UnavailableUnifiedAgentImage | null;
    pendingBackgroundRefresh: Promise<void> | null;
    imageTag: string | undefined;
    clearRetry: () => void;
    enqueuePreparation: (imageTag: string) => Promise<unknown>;
    refresh: () => Promise<void>;
    recordFailure: (imageTag: string, error: string) => void;
    setPendingBackgroundRefresh: (promise: Promise<void> | null) => void;
}): Promise<void> {
    if (options.pendingBackgroundRefresh) return options.pendingBackgroundRefresh;
    if (!options.imageTag) return Promise.resolve();
    const unavailable = options.unavailable?.imageTag === options.imageTag ? options.unavailable : null;
    // Inspect-only discovery has not attempted preparation yet. Let the first
    // attempt proceed, then enforce its deadline for both owners and consumers.
    if (unavailable?.circuitBreakerOpen || (
        (unavailable?.retryCount ?? 0) > 0
        && unavailable?.nextRetryAt
        && Date.parse(unavailable.nextRetryAt) > Date.now()
    )) return Promise.resolve();

    options.clearRetry();
    const recovery = options.enqueuePreparation(options.imageTag)
        .then(() => options.refresh())
        .catch(error => {
            const message = error instanceof Error ? error.message : String(error);
            options.recordFailure(options.imageTag as string, message);
            logger.error({ imageTag: options.imageTag, error: message }, 'Worker-owned unified agent image recovery failed');
        })
        .finally(() => options.setPendingBackgroundRefresh(null));
    options.setPendingBackgroundRefresh(recovery);
    return recovery;
}
