/**
 * Did the user dismiss the wallet prompt, rather than the signer refusing the
 * message outright? A cancellation must not be reported as an incompatibility.
 *
 * Used by `./wallet-standard.js`'s `createResilientSignMessage` to tell a
 * browser wallet's message-signing feature throwing from the user dismissing
 * its prompt. Kept as a standalone module (no import of `./wallet-standard.js`)
 * so a future signer path (e.g. `./keys.js`) could reuse the same check without
 * pulling in the browser-only wallet-standard module.
 */
export function isSignerRejection(error: unknown): boolean {
    if ((error as { code?: unknown } | null)?.code === 4001) return true;
    return /reject|denied|declin|cancel/i.test(describeError(error));
}

export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? 'unknown error');
}
