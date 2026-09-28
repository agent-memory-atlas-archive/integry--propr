import {
    boundedProviderOutput,
    MAX_PROVIDER_OUTPUT_BYTES,
} from '../../agents/impl/utils/boundedProviderOutput.js';

/**
 * Event IDs derive from a record's offset within the snapshot, so a section
 * that grows must not move the records of the sections before it: the
 * transcript (append-only, and readable) comes first, then the process's
 * stdout, then its stderr diagnostics. Earlier sections also take precedence
 * for the byte budget, so diagnostics never push the transcript out.
 */
export function buildLiveOutputSnapshot(transcript: string, stdout: string, stderr: string, maximumBytes = MAX_PROVIDER_OUTPUT_BYTES): string {
    const sections: string[] = [];
    let remaining = maximumBytes;
    for (const section of [transcript, stdout, stderr]) {
        const separator = sections.length > 0 ? 1 : 0;
        const bounded = boundedProviderOutput(section, remaining - separator);
        if (!bounded) continue;
        sections.push(bounded);
        remaining -= Buffer.byteLength(bounded) + separator;
    }
    return sections.join('\n');
}
