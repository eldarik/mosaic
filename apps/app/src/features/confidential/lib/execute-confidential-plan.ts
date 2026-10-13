import {
    type InstructionPlan,
    type Rpc,
    type Signature,
    type SolanaRpcApi,
    type Transaction,
    type TransactionSigner,
    compileTransaction,
    flattenTransactionPlan,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    getSignersFromTransactionMessage,
    isTransactionModifyingSigner,
    isTransactionPartialSigner,
    partiallySignTransactionWithSigners,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
} from '@solana/kit';
import type { estimateAndSetConfidentialResourceLimits } from '@solana/mosaic-sdk/confidential';
import type { FullTransaction } from '@/lib/solana/types';
import type { ConfidentialTxVersion } from './transaction-version';

/**
 * Confidential-transfer SDK builders return a kit `InstructionPlan` rather than a
 * single transaction message: several of them (configure, transfer, withdraw)
 * span multiple transactions — zero-knowledge proofs are verified into dedicated
 * context-state accounts in setup transactions, the token instruction references
 * them, and a cleanup transaction reclaims the rent.
 *
 * This is the browser counterpart to the CLI's `sendOrOutputInstructionPlan`
 * (`packages/cli/src/utils/instruction-plan.ts`): it plans the instructions into
 * fee-payer-bound messages and signs/sends/confirms each in order with a fresh
 * blockhash. The send loop mirrors the polling send/confirm approach proven in
 * the SDK's devnet end-to-end test — a fresh blockhash per attempt,
 * `skipPreflight: true`, and `getSignatureStatuses` polling — which is more
 * robust than WebSocket confirmation against lagging public RPCs.
 *
 * ## Transaction version
 *
 * `version` selects the format the SDK planner packs into. It defaults to `0`,
 * which is what this module has always sent. At `version: 1` (SIMD-0385) the
 * planner gets 4096 bytes per message instead of 1232 and folds proof setup, the
 * token instruction and cleanup into far fewer transactions — but version 1
 * carries its resource limits in header fields that **default to zero on chain**,
 * with none of the 200k-compute-units-per-instruction fallback legacy and
 * version-0 transactions get. A version-1 message sent without them fails, so
 * the send loop below simulates and sets them per transaction. See
 * `useConfidentialTxVersion` for how the version is chosen.
 */

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Transient public-RPC conditions — rate limits, load-balanced nodes lagging
// behind the latest state, dropped txs / expired blockhashes. All are safe to
// retry with a fresh blockhash.
const TRANSIENT =
    /429|Too Many Requests|debit an account|could not find|IncorrectProgramId|Blockhash(NotFound)?|block height exceeded|not confirmed|BlockhashNotFound/i;

// A wallet or node that cannot handle a version-1 transaction at all: an
// unknown message version, a wire transaction it fails to deserialize, or an
// RPC whose simulation result omits `loadedAccountsDataSize` (which version 1
// cannot be sent without, so the SDK's estimator throws on it). Kept narrow and
// separate from TRANSIENT on purpose — it triggers a re-plan at version 0, and
// must never swallow a genuine failure of the operation itself.
const V1_UNSUPPORTED =
    /unsupported (transaction|message) version|unknown (transaction|message) version|transaction version .* not supported|failed to deserialize|loadedAccountsDataSize/i;

// The user declining the wallet prompt. Never a reason to fall back: re-planning
// at version 0 would just put a second prompt in front of someone who said no.
const USER_REJECTED = /user (rejected|denied|declined|cancell?ed)|rejected the request/i;

/**
 * An error and everything it wraps, outermost first.
 *
 * Kit wraps via the standard `cause`; `@solana/connector` wraps via its own
 * `originalError` instead — a failed wallet signature surfaces as "Failed to
 * sign transaction 1 of 1" wrapping "Failed to sign transaction" wrapping the
 * wallet's actual error — so both links are followed.
 */
function errorChain(err: unknown): Error[] {
    const chain: Error[] = [];
    let current: unknown = err;
    // Bounded: a malformed `cause` graph could otherwise cycle forever.
    for (let depth = 0; current instanceof Error && depth < 8; depth++) {
        chain.push(current);
        current = current.cause ?? (current as { originalError?: unknown }).originalError;
    }
    return chain;
}

/**
 * Every message in an error's chain (see {@link errorChain}), joined.
 *
 * Kit wraps the real failure: a 429 from `simulateTransaction` surfaces as
 * `SolanaError: Failed to estimate the compute unit consumption for this
 * transaction message`, with `HTTP error (429): Too Many Requests` only on
 * `cause`. Matching the outer message alone therefore misses both the rate
 * limits that should be retried and the format rejections that should fall back
 * to version 0 — so every classifier below reads the whole chain.
 */
function messageChain(err: unknown): string {
    return errorChain(err)
        .map(e => e.message)
        .join(' | ');
}

/**
 * Whether the wallet failed to sign for a reason other than the user declining.
 *
 * On a version-1 attempt this is treated as the wallet not handling the format:
 * a wallet can list `1` in `supportedTransactionVersions` and still fail on the
 * wire bytes, and nothing has been sent at that point, so re-planning at
 * version 0 is safe.
 */
function isWalletSigningFailure(err: unknown): boolean {
    const chain = errorChain(err);
    const codes = chain.map(e => (e as { code?: unknown }).code);
    if (codes.includes('USER_REJECTED') || USER_REJECTED.test(messageChain(err))) return false;
    return codes.includes('SIGNING_FAILED');
}

/** Runs an RPC call, retrying on HTTP 429 with exponential backoff. */
async function withBackoff<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let delay = 500;
    for (let attempt = 0; attempt < 8; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (!/429|Too Many Requests/i.test(messageChain(err))) throw err;
            await sleep(delay);
            delay = Math.min(delay * 2, 8_000);
        }
    }
    throw new Error(`${label}: exhausted retries after repeated 429s`);
}

/**
 * Replaces the provisory resource limits a version-1 planner left behind with
 * simulated ones. Injected rather than imported at module scope so the
 * `@solana/zk-sdk` WASM behind `@solana/mosaic-sdk/confidential` stays lazy.
 */
type EstimateResourceLimits = typeof estimateAndSetConfidentialResourceLimits;

/** Signs `baseMessage` with a fresh blockhash, sends it, and polls until confirmed. */
async function signSendConfirm(
    rpc: Rpc<SolanaRpcApi>,
    baseMessage: unknown,
    version: ConfidentialTxVersion,
    estimateResourceLimits: EstimateResourceLimits,
): Promise<Signature> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const { value: bh } = await withBackoff('getLatestBlockhash', () => rpc.getLatestBlockhash().send());
            const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
                bh,
                baseMessage as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[1],
            );
            // Version 1 only, and deliberately here rather than once over the
            // whole plan: simulation needs a lifetime (planned messages have
            // none), and a plan's later transactions read proof context-state
            // accounts its own earlier transactions create, so simulating them
            // before those land fails on a missing account.
            const message =
                version === 1
                    ? await withBackoff('estimateResourceLimits', () =>
                          estimateResourceLimits({ rpc, transactionMessage: withLifetime as FullTransaction }),
                      )
                    : withLifetime;
            const signed = await signTransactionMessageWithSigners(message as FullTransaction);
            const signature = getSignatureFromTransaction(signed);
            const wire = getBase64EncodedWireTransaction(signed);
            // skipPreflight avoids spurious preflight failures on lagging public-RPC
            // nodes; execution errors still surface via getSignatureStatuses below.
            await withBackoff('sendTransaction', () =>
                rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: true }).send(),
            );
            const deadline = Date.now() + 45_000;
            while (Date.now() < deadline) {
                const status = await withBackoff('getSignatureStatuses', () =>
                    rpc.getSignatureStatuses([signature]).send(),
                );
                const entry = status.value[0];
                if (entry?.err)
                    throw new Error(
                        `Transaction ${signature} failed: ${JSON.stringify(entry.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
                    );
                if (entry?.confirmationStatus === 'confirmed' || entry?.confirmationStatus === 'finalized')
                    return signature;
                await sleep(1_000);
            }
            throw new Error(`Transaction ${signature} not confirmed within 45s`);
        } catch (err) {
            lastErr = err;
            if (!TRANSIENT.test(messageChain(err))) throw err;
            await sleep(2_000); // let lagging nodes catch up, then retry with a fresh blockhash
        }
    }
    throw lastErr;
}

/** Progress callback: `(current, total)` as each transaction in a plan is sent. */
export type ConfidentialPlanProgress = (current: number, total: number) => void;

/**
 * How the plan's transactions reach the wallet.
 *
 * - `each` — one wallet prompt per transaction, each signed right before it is
 *   sent with a fresh blockhash. The default.
 * - `batch` — every transaction signed up front in a single wallet prompt
 *   (`signAllTransactions`), then sent in order. A plan of N transactions costs
 *   one prompt instead of N. If the shared blockhash expires before the last one
 *   lands, the rest are re-signed in another single prompt.
 *
 * `batch` needs a wallet signer that can sign several transactions at once (a
 * kit `TransactionModifyingSigner`, which is what `useConnectorSigner` returns),
 * and at version 1 a single-transaction plan: a version-1 message's resource
 * limits are simulated just before signing, and a later transaction cannot be
 * simulated before the earlier ones it depends on have landed. Anything else
 * runs as `each`.
 */
export type ConfidentialPlanSigning = 'each' | 'batch';

const BATCH_CONFIRM_TIMEOUT_MS = 120_000;
const MAX_REBATCHES = 2;

/**
 * Sends already-signed transactions in order, waiting for each to confirm
 * before sending the next — later transactions read accounts earlier ones
 * create. Returns how many landed: fewer than `signed.length` only when the
 * shared blockhash expired with transaction `[returned]` provably not landed,
 * so the caller can re-sign the rest.
 */
async function sendSignedInOrder(
    rpc: Rpc<SolanaRpcApi>,
    signed: Transaction[],
    blockhash: Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0]['blockhash'],
    onSent: (signature: Signature) => void,
    onProgress: () => void,
): Promise<number> {
    for (let i = 0; i < signed.length; i++) {
        onProgress();
        const signature = getSignatureFromTransaction(signed[i]);
        const wire = getBase64EncodedWireTransaction(signed[i]);
        const deadline = Date.now() + BATCH_CONFIRM_TIMEOUT_MS;
        let polls = 0;
        let landed = false;
        while (!landed) {
            if (Date.now() > deadline) throw new Error(`Transaction ${signature} not confirmed within 120s`);
            // Re-broadcasting the same signed bytes is idempotent, and covers a
            // send dropped by a lagging node; at most every 5th poll.
            if (polls % 5 === 0) {
                await withBackoff('sendTransaction', () =>
                    rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: true }).send(),
                );
            }
            await sleep(1_000);
            const status = await withBackoff('getSignatureStatuses', () =>
                rpc.getSignatureStatuses([signature]).send(),
            );
            const entry = status.value[0];
            if (entry?.err)
                throw new Error(
                    `Transaction ${signature} failed: ${JSON.stringify(entry.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
                );
            if (entry?.confirmationStatus === 'confirmed' || entry?.confirmationStatus === 'finalized') {
                landed = true;
                break;
            }
            polls++;
            // Once the blockhash is no longer valid this transaction can never
            // land, so it is safe to re-sign it (and the rest) with a fresh one.
            if (polls % 5 === 0) {
                const { value: valid } = await withBackoff('isBlockhashValid', () =>
                    rpc.isBlockhashValid(blockhash, { commitment: 'confirmed' }).send(),
                );
                if (!valid) {
                    const final = await withBackoff('getSignatureStatuses', () =>
                        rpc.getSignatureStatuses([signature]).send(),
                    );
                    if (final.value[0]?.err) throw new Error(`Transaction ${signature} failed`);
                    if (final.value[0]) {
                        landed = true;
                        break;
                    }
                    return i;
                }
            }
        }
        onSent(signature);
    }
    return signed.length;
}

/**
 * Signs `messages` in one wallet prompt and sends them in order (see
 * {@link ConfidentialPlanSigning}). The wallet signs first — a modifying signer
 * may change the bytes — then each message's other signers (the ephemeral
 * proof context-state keypairs) add their signatures locally.
 */
async function signAndSendBatch(input: {
    rpc: Rpc<SolanaRpcApi>;
    messages: unknown[];
    wallet: TransactionSigner;
    version: ConfidentialTxVersion;
    estimateResourceLimits: EstimateResourceLimits;
    signatures: Signature[];
    total: number;
    onProgress?: ConfidentialPlanProgress;
    onAwaitingSignature?: () => void;
}): Promise<void> {
    const { rpc, wallet } = input;
    if (!isTransactionModifyingSigner(wallet)) throw new Error('Batch signing needs a transaction-modifying signer.');

    let remaining = input.messages;
    for (let round = 0; remaining.length > 0; round++) {
        if (round > MAX_REBATCHES) throw new Error('The transaction blockhash kept expiring before confirmation.');

        const { value: bh } = await withBackoff('getLatestBlockhash', () => rpc.getLatestBlockhash().send());
        const messages = await Promise.all(
            remaining.map(async base => {
                const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
                    bh,
                    base as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[1],
                ) as FullTransaction;
                // Only reached with a single message at version 1; see ConfidentialPlanSigning.
                return input.version === 1
                    ? withBackoff('estimateResourceLimits', () =>
                          input.estimateResourceLimits({ rpc, transactionMessage: withLifetime }),
                      )
                    : withLifetime;
            }),
        );

        input.onAwaitingSignature?.();
        const walletSigned = await wallet.modifyAndSignTransactions(messages.map(m => compileTransaction(m)));
        const signed = await Promise.all(
            walletSigned.map((tx, i) =>
                partiallySignTransactionWithSigners(
                    getSignersFromTransactionMessage(messages[i])
                        .filter(s => s.address !== wallet.address)
                        .filter(isTransactionPartialSigner),
                    tx,
                ),
            ),
        );

        const landed = await sendSignedInOrder(
            rpc,
            signed,
            bh.blockhash,
            signature => input.signatures.push(signature),
            () => input.onProgress?.(input.signatures.length + 1, input.total),
        );
        remaining = remaining.slice(landed);
    }
}

/**
 * Plans a confidential `InstructionPlan` into fee-payer-bound transaction
 * messages, then signs, sends, and confirms each in order — returning every
 * signature. `onProgress` fires before each transaction so multi-tx proof flows
 * can surface "sending 2/3".
 *
 * At `version: 1`, a failure that looks like the wallet or the node rejecting
 * the format falls back to version 0 and starts over — but only while nothing
 * has landed yet. Once the first transaction confirms, the plan's proof
 * context-state accounts exist on chain and re-planning would be wrong, so from
 * that point the error propagates.
 */
export async function executeConfidentialPlan(input: {
    instructionPlan: InstructionPlan;
    feePayer: TransactionSigner;
    rpc: Rpc<SolanaRpcApi>;
    onProgress?: ConfidentialPlanProgress;
    /** Transaction format to plan into. Defaults to `0`. */
    version?: ConfidentialTxVersion;
    /** See {@link ConfidentialPlanSigning}. Defaults to `each`. */
    signing?: ConfidentialPlanSigning;
    /** Fires right before a batch is handed to the wallet (`batch` signing only). */
    onAwaitingSignature?: () => void;
}): Promise<Signature[]> {
    // Lazy import: pulls in the @solana/zk-sdk WASM dependency only when a
    // confidential operation actually runs.
    const { estimateAndSetConfidentialResourceLimits: estimateResourceLimits, planConfidentialInstructions } =
        await import('@solana/mosaic-sdk/confidential');

    const run = async (version: ConfidentialTxVersion, signatures: Signature[]): Promise<Signature[]> => {
        const plan = await planConfidentialInstructions({
            instructionPlan: input.instructionPlan,
            feePayer: input.feePayer,
            version,
        });
        const messages = flattenTransactionPlan(plan).map(single => single.message);

        const batch =
            input.signing === 'batch' &&
            isTransactionModifyingSigner(input.feePayer) &&
            (version === 0 || messages.length === 1);
        if (batch) {
            await signAndSendBatch({
                rpc: input.rpc,
                messages,
                wallet: input.feePayer,
                version,
                estimateResourceLimits,
                signatures,
                total: messages.length,
                onProgress: input.onProgress,
                onAwaitingSignature: input.onAwaitingSignature,
            });
            return signatures;
        }

        for (let i = 0; i < messages.length; i++) {
            input.onProgress?.(i + 1, messages.length);
            signatures.push(await signSendConfirm(input.rpc, messages[i], version, estimateResourceLimits));
        }
        return signatures;
    };

    const version = input.version ?? 0;
    const signatures: Signature[] = [];
    try {
        return await run(version, signatures);
    } catch (err) {
        if (version !== 1 || signatures.length > 0) throw err;

        const message = messageChain(err);
        if (V1_UNSUPPORTED.test(message) || isWalletSigningFailure(err)) {
            // Logged so the wallet's own wording can be read off the console
            // and, if it is a format rejection, folded into V1_UNSUPPORTED.
            // eslint-disable-next-line no-console
            console.warn(`Version-1 confidential transaction rejected; retrying at version 0: ${message}`);
            return run(0, signatures);
        }

        // A version-1 attempt that failed before anything landed, in a way
        // V1_UNSUPPORTED does not recognise. It may still be a wallet or node
        // refusing the format under wording we have not seen — the set of
        // rejection strings is not something we can enumerate up front — so name
        // the version in the error rather than letting the raw message imply the
        // operation itself is broken. The original text is preserved verbatim so
        // it can be read off the UI and folded into V1_UNSUPPORTED.
        throw new Error(`Confidential operation failed on a version-1 transaction: ${message}`, { cause: err });
    }
}
