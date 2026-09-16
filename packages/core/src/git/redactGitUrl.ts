/**
 * Strips credentials that Git echoes back inside remote URLs and error output.
 * Kept in a dependency-free module so any Git helper can redact without pulling
 * in GitHub authentication.
 */
export function redactAuthenticatedGitUrl(message: string): string {
    return message
        .replace(/https:\/\/x-access-token:[^@\s'"]+@github\.com\//g, 'https://x-access-token:[REDACTED]@github.com/')
        .replace(/\b(?:ghs|ghp|gho|ghu|ghr|github_pat)_[A-Za-z0-9_.-]+/g, '[REDACTED_GITHUB_TOKEN]');
}
