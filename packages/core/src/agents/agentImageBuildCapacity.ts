import fs from 'node:fs/promises';

/**
 * Runtime-agent builds install roughly 4 GB of packages and can temporarily
 * retain the bundle, runtime, and intermediate layers at the same time. Keep
 * a 12 GiB byte reserve plus an inode reserve so a 125 GB host still has room
 * for Redis, logs, and normal application activity while a build runs.
 */
export const AGENT_IMAGE_BUILD_MIN_FREE_BYTES = 12 * 1024 ** 3;
export const AGENT_IMAGE_BUILD_MIN_FREE_INODES = 100_000;

export interface AgentImageBuildDiskSpace {
    availableBytes: number;
    freeInodes: number;
}

export class AgentImageBuildCapacityError extends Error {
    readonly code = 'ENOSPC';
    readonly diskSpace: AgentImageBuildDiskSpace;

    constructor(
        diskSpace: AgentImageBuildDiskSpace,
        minFreeBytes = AGENT_IMAGE_BUILD_MIN_FREE_BYTES,
        minFreeInodes = AGENT_IMAGE_BUILD_MIN_FREE_INODES,
    ) {
        const availableGiB = (diskSpace.availableBytes / 1024 ** 3).toFixed(2);
        const requiredGiB = (minFreeBytes / 1024 ** 3).toFixed(2);
        super(
            `Insufficient disk capacity for agent image preparation (ENOSPC): `
            + `${availableGiB} GiB available, ${diskSpace.freeInodes} free inodes; `
            + `requires at least ${requiredGiB} GiB and ${minFreeInodes} free inodes`,
        );
        this.name = 'AgentImageBuildCapacityError';
        this.diskSpace = diskSpace;
    }
}

export async function readAgentImageBuildDiskSpace(
    rootPath = process.env.PROPR_ROOT || process.cwd(),
): Promise<AgentImageBuildDiskSpace> {
    const stats = await fs.statfs(rootPath);
    return {
        availableBytes: Number(stats.bavail) * Number(stats.bsize),
        freeInodes: Number(stats.ffree),
    };
}

export async function assertAgentImageBuildCapacity(options: {
    rootPath?: string;
    minFreeBytes?: number;
    minFreeInodes?: number;
    readDiskSpace?: (rootPath: string) => Promise<AgentImageBuildDiskSpace>;
} = {}): Promise<AgentImageBuildDiskSpace> {
    const minFreeBytes = options.minFreeBytes ?? AGENT_IMAGE_BUILD_MIN_FREE_BYTES;
    const minFreeInodes = options.minFreeInodes ?? AGENT_IMAGE_BUILD_MIN_FREE_INODES;
    const diskSpace = await (options.readDiskSpace ?? readAgentImageBuildDiskSpace)(
        options.rootPath ?? process.env.PROPR_ROOT ?? process.cwd(),
    );
    if (diskSpace.availableBytes < minFreeBytes || diskSpace.freeInodes < minFreeInodes) {
        throw new AgentImageBuildCapacityError(diskSpace, minFreeBytes, minFreeInodes);
    }
    return diskSpace;
}

export function isAgentImageDiskPressureError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /ENOSPC|no space left on device|insufficient disk|insufficient.*inode|not enough.*free (?:space|inode)/i.test(message);
}
