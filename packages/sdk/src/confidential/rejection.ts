/**
 * Did the user dismiss the wallet prompt, rather than the signer refusing the
 * message outright? A cancellation must not be reported as an incompatibility.
 *
 * Shared by {@link "./keys.js".deriveConfidentialKeys} (a signer that refuses
 * the key-derivation message outright vs. a genuine cancel) and
 * `./wallet-standard.js` (a browser wallet's message-signing feature throwing
 * vs. the user dismissing its prompt) — kept dependency-free so neither module
 * has to import the other just to share this check.
 */
export function isSignerRejection(error: unknown): boolean {
    if ((error as { code?: unknown } | null)?.code === 4001) return true;
    return /reject|denied|declin|cancel/i.test(describeError(error));
}

export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? 'unknown error');
}
