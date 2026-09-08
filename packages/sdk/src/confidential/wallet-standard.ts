import type { Address, MessagePartialSigner, SignableMessage, SignatureBytes } from '@solana/kit';
import { getWallets } from '@wallet-standard/core';
import { AeKey, ElGamalSecretKey } from '@solana/mosaic-sdk/_zk';
import type { SignMessage } from './keys.js';

/**
 * The confidential key derivation (`deriveConfidentialKeysForOwnerMint` /
 * `deriveConfidentialSupplyKeys`) signs a canonical, domain-separated message
 * and feeds the raw Ed25519 signature into the WASM ZK SDK. It expects a kit
 * {@link MessagePartialSigner} (`signMessages([SignableMessage]) -> [{
 * [address]: SignatureBytes }]`).
 *
 * Browser wallet-connection libraries typically only expose a single-message
 * `signMessage(bytes) => Promise<Uint8Array>` primitive, and several of them
 * mishandle it (see {@link createResilientSignMessage}), so this module
 * bridges to the browser's own Wallet Standard registry directly and adapts
 * the result into a `MessagePartialSigner`.
 *
 * ⚠️ Key-derivation compatibility depends on the wallet signing the **raw**
 * message bytes (as a CLI keypair signer does — see `createKeyPairMessageSigner`
 * in `./keys.js`). Wallets that hash or prefix the message before signing will
 * derive different keys and cannot decrypt an account configured elsewhere —
 * cross-check with `mosaic confidential inspect-account` when validating a new
 * wallet.
 *
 * This module is browser-only (it calls into `@wallet-standard/core`'s wallet
 * registry) and is deliberately not re-exported from `./index.js` — reach it
 * via the dedicated `@solana/mosaic-sdk/confidential/wallet-standard` subpath
 * so Node/CLI consumers of `@solana/mosaic-sdk/confidential` never pull this
 * dependency in. `@wallet-standard/core`'s `getWallets()` still degrades
 * gracefully in Node (it feature-detects `window` and returns an empty
 * registry), so importing this module there is safe — it just never finds a
 * wallet.
 */

/** The Wallet Standard `solana:signMessage` feature shape this module relies on. */
interface SolanaSignMessageOutput {
    signedMessage?: Uint8Array;
    signature?: Uint8Array;
}
interface SolanaSignMessageFeature {
    signMessage: (input: {
        account: unknown;
        message: Uint8Array;
    }) => Promise<readonly SolanaSignMessageOutput[] | SolanaSignMessageOutput | Uint8Array>;
}

/**
 * Pull the raw signature bytes out of the several shapes wallets return:
 * bare bytes, Wallet Standard's `[{ signedMessage, signature }]`, or a single
 * `{ signature }`. Returns undefined rather than throwing, because a caller may
 * need to treat "no usable signature" as a reason to try another path.
 */
function toSignatureBytes(result: unknown): Uint8Array | undefined {
    if (result instanceof Uint8Array) return result;
    if (Array.isArray(result)) return toSignatureBytes(result[0]);
    const signature = (result as { signature?: unknown } | null)?.signature;
    return signature instanceof Uint8Array ? signature : undefined;
}

function extractSignature(result: unknown): Uint8Array {
    const signature = toSignatureBytes(result);
    if (!signature) throw new Error('The wallet returned an unrecognised signMessage result.');
    return signature;
}

/**
 * Did the user dismiss the wallet prompt, rather than the signer refusing the
 * message outright? A cancellation must not be reported as an incompatibility.
 */
function isSignerRejection(error: unknown): boolean {
    if ((error as { code?: unknown } | null)?.code === 4001) return true;
    return /reject|denied|declin|cancel/i.test(describeError(error));
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

// `ElGamalSecretKey.signerMessage(seed)` / `AeKey.signerMessage(seed)` are always
// `domainSeparator + seed`; calling them with an empty seed yields the bare
// domain separator, which every canonical key-derivation message must start
// with regardless of what seed (token account, owner, owner+mint, ...) is in
// use. This lets `assertCanonicalDerivationMessage` recognise a real
// derivation message without hard-coding — or needing to agree with upstream
// on — the seed scheme itself.
const ELGAMAL_MESSAGE_PREFIX = ElGamalSecretKey.signerMessage(new Uint8Array(0));
const AE_MESSAGE_PREFIX = AeKey.signerMessage(new Uint8Array(0));

function hasPrefix(message: Uint8Array, prefix: Uint8Array): boolean {
    if (message.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
        if (message[i] !== prefix[i]) return false;
    }
    return true;
}

/**
 * This module exists only to sign confidential-balance key-derivation
 * messages (see `deriveConfidentialKeys` / `deriveConfidentialKeysForOwnerMint`
 * in `./keys.js`) — not to be a general-purpose "sign anything via Wallet
 * Standard" utility. Refuses anything that isn't one, so a caller can't be
 * tricked (or accidentally used) into blind-signing an arbitrary message
 * under the `confidential/` banner.
 */
function assertCanonicalDerivationMessage(message: Uint8Array): void {
    if (hasPrefix(message, ELGAMAL_MESSAGE_PREFIX) || hasPrefix(message, AE_MESSAGE_PREFIX)) return;
    throw new Error(
        'signMessageViaWalletStandard only signs confidential-balance key-derivation messages; ' +
            'refusing to sign an unrecognised message.',
    );
}

/**
 * Signs `message` by going straight to the browser's Wallet Standard registry
 * (`@wallet-standard/core`'s `getWallets()`), independently of whatever
 * higher-level wallet-connection framework an app uses.
 *
 * The registry holds the wallet's *genuine* `solana:signMessage` feature and
 * its real `WalletAccount` objects — some connection frameworks' own signing
 * path loses access to one or both (see {@link createResilientSignMessage}).
 */
export async function signMessageViaWalletStandard(owner: Address, message: Uint8Array): Promise<Uint8Array> {
    assertCanonicalDerivationMessage(message);
    const wallets = getWallets().get();

    for (const wallet of wallets) {
        const feature = wallet.features['solana:signMessage'] as SolanaSignMessageFeature | undefined;
        const account = wallet.accounts.find(candidate => candidate.address === owner);
        if (typeof feature?.signMessage === 'function' && account) {
            return extractSignature(await feature.signMessage({ account, message }));
        }
    }

    throw new Error(
        `No Wallet Standard wallet in this browser exposes message signing for ${owner}. ` +
            'Confidential balances need a wallet that can sign messages.',
    );
}

/**
 * Message signing that survives a wallet-connection framework's own broken
 * message-signing path.
 *
 * This function exists because of concrete, verified bugs in `@solana/connector`
 * 0.1.4 (the version this monorepo's app depends on) that specifically break
 * Phantom and any other wallet its internal "authenticity score" demotes:
 *
 * The connector scores wallets for authenticity and drops any scoring below 0.6
 * from the Wallet Standard registry — Phantom currently scores **0.595**. It
 * then re-registers the wallet through a *legacy* path that builds a wallet
 * object with **`accounts: []`**. When the connector's own transaction-signer
 * later calls `signMessage({ account, message, chain })`, the `account` it
 * supplies is not one of the wallet's real `WalletAccount`s, so the wallet
 * throws while dereferencing it and the connector reports the useless "Failed
 * to sign message".
 *
 * (That legacy path *does* synthesize a raw-bytes shim, but it is immediately
 * overwritten by the wallet's genuine Wallet Standard features on the next
 * line — so calling the wallet object's feature with raw bytes fails too,
 * inside the wallet.)
 *
 * For a wallet that *passes* the authenticity check the path is broken in a
 * quieter way: Wallet Standard's `signMessage` resolves to an **array** of
 * `{ signedMessage, signature }` outputs, but the connector reads `.signature`
 * off the array itself, which is `undefined`. Nothing throws — the caller just
 * receives no signature. That surfaces downstream as the SDK's "Signer … did
 * not return a signature".
 *
 * Transactions are unaffected by any of this — they never take this path.
 *
 * So the Wallet Standard registry is tried **first**: it is the standard-compliant
 * path and it costs one prompt. `fallback` (a connection framework's own
 * single-message signer, if the caller has one) is used only for a wallet the
 * registry cannot serve, and a genuine user rejection is re-thrown rather than
 * retried so declining a prompt does not raise a second one.
 */
export function createResilientSignMessage(
    owner: Address | undefined,
    fallback: SignMessage | undefined,
): SignMessage | undefined {
    if (!owner) return undefined;

    return async (message: Uint8Array): Promise<Uint8Array> => {
        assertCanonicalDerivationMessage(message);
        try {
            return await signMessageViaWalletStandard(owner, message);
        } catch (err) {
            if (isSignerRejection(err) || !fallback) throw err;
            // Last resort. Its result is validated because the fallback can
            // resolve with `undefined` instead of failing.
            const signature = toSignatureBytes(await fallback(message));
            if (!signature) throw err;
            return signature;
        }
    };
}

/**
 * Wraps a single-message {@link SignMessage} into a kit {@link MessagePartialSigner}
 * bound to `address`, so it can drive `deriveConfidentialKeysForOwnerMint` /
 * `deriveConfidentialSupplyKeys`.
 */
export function createMessageSigner(address: Address, signMessage: SignMessage): MessagePartialSigner {
    return {
        address,
        async signMessages(messages: readonly SignableMessage[]) {
            return Promise.all(
                messages.map(async message => {
                    const signature = await signMessage(new Uint8Array(message.content));
                    return { [address]: signature as SignatureBytes } as Record<Address, SignatureBytes>;
                }),
            );
        },
    };
}
