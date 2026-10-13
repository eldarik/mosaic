import {
    type Address,
    type Commitment,
    type GetMinimumBalanceForRentExemptionApi,
    type InstructionPlan,
    type Rpc,
    type SolanaRpcApi,
    type TransactionSigner,
    sequentialInstructionPlan,
    singleInstructionPlan,
} from '@solana/kit';
import {
    TOKEN_2022_PROGRAM_ADDRESS,
    fetchMaybeToken,
    fetchMint,
    findAssociatedTokenPda,
    getApplyConfidentialPendingBalanceInstruction,
    getConfidentialDepositInstruction,
} from '@solana-program/token-2022';
import { fetchConfidentialAccountState } from './account-state.js';
import {
    createApproveConfidentialAccountInstructionPlan,
    createConfigureConfidentialAccountInstructionPlan,
} from './configure-account.js';
import { isConfidentialMintBurn, isConfidentialTransferMint, type DecodedToken } from './extensions.js';
import {
    type ConfidentialKeys,
    assertConfidentialKeysMatchAccount,
    decryptAesBalance,
    decryptElGamalBalance,
} from './keys.js';
import { type TokenAmount, tokenAmountToRaw } from './util.js';

/**
 * "Send privately" in as few wallet prompts as possible.
 *
 * A confidential transfer can only spend the source's *available* confidential
 * balance, and only to a destination that is already configured. Getting a
 * plain holder there by hand takes up to four separate operations (configure →
 * deposit → apply → transfer), each its own signing round. This module folds
 * everything before the transfer into one **preparation** plan and leaves the
 * transfer itself as a second plan, so a caller that batch-signs each plan needs
 * two signing rounds at most — one when the available balance already covers
 * the amount.
 *
 * Why preparation can be one plan: `ApplyPendingBalance` carries no proof. Its
 * data is the expected pending-credit counter and the AES-encrypted new
 * available balance, and both follow from the current decrypted state plus the
 * deposit this plan itself adds — so the apply is built against the *projected*
 * post-deposit state instead of waiting for the deposit to land.
 *
 * Why the transfer is a separate plan: its equality proof is over the
 * post-apply ElGamal `availableBalance` ciphertext, which would have to be
 * projected with Ristretto point arithmetic that `@solana/zk-sdk` does not
 * expose. So the caller lands the preparation, waits for
 * {@link getConfidentialSendPreparationStatus} to report `landed`, and then
 * builds the transfer with `createConfidentialTransferInstructionPlan` against
 * the real on-chain state.
 *
 * Recipient readiness is checked separately ({@link checkConfidentialRecipient})
 * and should run first: a sender can never configure someone else's account
 * (configure needs the owner's signature and a proof from the owner's ElGamal
 * secret), so an unready recipient has to be caught before anything is spent.
 */

export type ConfidentialSendErrorCode =
    /** The mint has no `ConfidentialTransferMint` extension. */
    | 'mint-not-confidential'
    /** The sender's account needs approval and the sender is not the mint's confidential authority. */
    | 'not-approved'
    /** Available + pending + public balance does not cover the amount. */
    | 'insufficient-balance';

/** A send that cannot be prepared, caught before anything is signed or sent. */
export class ConfidentialSendError extends Error {
    readonly code: ConfidentialSendErrorCode;
    /** Raw balances behind an `insufficient-balance` error. */
    readonly balances?: { available: bigint; pending: bigint; public: bigint; required: bigint };

    constructor(
        code: ConfidentialSendErrorCode,
        message: string,
        balances?: { available: bigint; pending: bigint; public: bigint; required: bigint },
    ) {
        super(message);
        this.name = 'ConfidentialSendError';
        this.code = code;
        this.balances = balances;
    }
}

export type ConfidentialRecipientNotReadyReason =
    /** The recipient has no token account for this mint. */
    | 'no-account'
    /** The token account exists but is not configured for confidential transfers. */
    | 'not-configured'
    /** Configured, but the mint requires approval and it has not been approved. */
    | 'not-approved'
    /** Configured and approved, but the owner has disabled incoming confidential transfers. */
    | 'credits-disabled';

export type ConfidentialRecipientStatus =
    | { ready: true; tokenAccount: Address }
    | { ready: false; tokenAccount: Address; reason: ConfidentialRecipientNotReadyReason };

async function resolveAssociatedTokenAccount(owner: Address, mint: Address): Promise<Address> {
    const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    return ata;
}

function getConfidentialAccountExtension(token: DecodedToken) {
    if (token.data.extensions.__option !== 'Some') return null;
    const ext = token.data.extensions.value.find(e => e.__kind === 'ConfidentialTransferAccount');
    return ext && ext.__kind === 'ConfidentialTransferAccount' ? ext : null;
}

/**
 * Whether `recipient` (a wallet address) can receive a confidential transfer of
 * `mint` right now. Reads the recipient's associated token account only — no
 * keys, no signing.
 */
export async function checkConfidentialRecipient(input: {
    rpc: Rpc<SolanaRpcApi>;
    mint: Address;
    /** The recipient's wallet (owner) address. */
    recipient: Address;
    commitment?: Commitment;
}): Promise<ConfidentialRecipientStatus> {
    const tokenAccount = await resolveAssociatedTokenAccount(input.recipient, input.mint);
    const account = await fetchMaybeToken(input.rpc, tokenAccount, { commitment: input.commitment ?? 'confirmed' });
    if (!account.exists) return { ready: false, tokenAccount, reason: 'no-account' };

    const ext = getConfidentialAccountExtension(account);
    if (!ext) return { ready: false, tokenAccount, reason: 'not-configured' };
    if (!ext.approved) return { ready: false, tokenAccount, reason: 'not-approved' };
    if (!ext.allowConfidentialCredits) return { ready: false, tokenAccount, reason: 'credits-disabled' };
    return { ready: true, tokenAccount };
}

/** What {@link createConfidentialSendPreparationInstructionPlan} decided. */
export interface ConfidentialSendPreparation {
    /** Instructions to land before the transfer, or `null` when nothing is needed. */
    plan: InstructionPlan | null;
    /** The sender's confidential token account (their associated token account). */
    tokenAccount: Address;
    /** The amount to transfer, in base units. */
    rawAmount: bigint;
    /** Mint decimals, for formatting. */
    decimals: number;
    /** Which steps the plan contains. `deposit` is the base-unit amount moved from the public balance. */
    steps: { configure: boolean; approve: boolean; deposit: bigint; apply: boolean };
    /** The spendable confidential balance once the plan has landed. */
    availableAfter: bigint;
    /**
     * The AES ciphertext the plan's apply writes as the new decryptable
     * available balance, or `null` when there is no apply. Encryption is
     * randomized, so seeing these exact bytes on chain proves this apply landed.
     */
    newDecryptableAvailableBalance: Uint8Array | null;
}

/**
 * Builds everything a send needs before the transfer itself: configure the
 * sender's account if it isn't, approve it if the mint requires that and the
 * sender is the confidential authority, deposit any shortfall from the public
 * balance, and apply the pending balance — one sequential plan.
 *
 * Only the shortfall is deposited, so the rest of the public balance stays
 * public. The pending balance is applied whenever the available balance alone
 * does not cover the amount.
 *
 * @throws {ConfidentialSendError} when the send cannot happen at all
 * (`mint-not-confidential`, `not-approved`, `insufficient-balance`). Nothing has
 * been signed at that point.
 */
export async function createConfidentialSendPreparationInstructionPlan(input: {
    rpc: Rpc<GetMinimumBalanceForRentExemptionApi & SolanaRpcApi>;
    /** Pays for account creation when the sender's account has to be configured. */
    payer: TransactionSigner;
    /** The sending wallet. Signs configure, deposit and apply (and approve, when it is the authority). */
    owner: TransactionSigner;
    mint: Address;
    /** Amount to send — decimal string (e.g. `"1.5"`) or raw `bigint`. */
    amount: TokenAmount;
    /** The sender's confidential keys. */
    keys: ConfidentialKeys;
    commitment?: Commitment;
}): Promise<ConfidentialSendPreparation> {
    const commitment = input.commitment ?? 'confirmed';
    const tokenAccount = await resolveAssociatedTokenAccount(input.owner.address, input.mint);
    const [mint, account] = await Promise.all([
        fetchMint(input.rpc, input.mint, { commitment }),
        fetchMaybeToken(input.rpc, tokenAccount, { commitment }),
    ]);

    if (!isConfidentialTransferMint(mint) || mint.data.extensions.__option !== 'Some') {
        throw new ConfidentialSendError(
            'mint-not-confidential',
            `Mint ${input.mint} is not configured for confidential transfers.`,
        );
    }
    const mintExt = mint.data.extensions.value.find(e => e.__kind === 'ConfidentialTransferMint');
    const autoApprove = mintExt?.__kind === 'ConfidentialTransferMint' ? mintExt.autoApproveNewAccounts : false;
    const confidentialAuthority =
        mintExt?.__kind === 'ConfidentialTransferMint' && mintExt.authority.__option === 'Some'
            ? mintExt.authority.value
            : null;

    const decimals = mint.data.decimals;
    const rawAmount = tokenAmountToRaw(input.amount, decimals);
    const publicBalance = account.exists ? account.data.amount : 0n;
    const ext = account.exists ? getConfidentialAccountExtension(account) : null;

    // Current confidential state; an unconfigured account starts from zero.
    let available = 0n;
    let pending = 0n;
    let creditCounter = 0n;
    if (ext) {
        assertConfidentialKeysMatchAccount(input.keys, ext.elgamalPubkey, `token account ${tokenAccount}`);
        available = decryptAesBalance(input.keys.aes, new Uint8Array(ext.decryptableAvailableBalance));
        creditCounter = ext.pendingBalanceCreditCounter;
        // The pending balance is only non-zero after a credit; skip the
        // discrete-log decryption otherwise.
        if (creditCounter > 0n) {
            const low = decryptElGamalBalance(input.keys.elgamal, new Uint8Array(ext.pendingBalanceLow));
            const high = decryptElGamalBalance(input.keys.elgamal, new Uint8Array(ext.pendingBalanceHigh));
            pending = low + (high << 16n);
        }
    }

    const configure = !ext;
    const approved = ext ? ext.approved : autoApprove;
    const approve = !approved;
    if (approve && confidentialAuthority !== input.owner.address) {
        throw new ConfidentialSendError(
            'not-approved',
            `Your confidential account for this mint needs approval from the mint's confidential authority` +
                (confidentialAuthority ? ` (${confidentialAuthority})` : '') +
                ' before it can send.',
        );
    }

    const shortfall = rawAmount > available ? rawAmount - available : 0n;
    const deposit = shortfall > pending ? shortfall - pending : 0n;
    // A ConfidentialMintBurn mint has no public side to deposit from.
    const depositable = isConfidentialMintBurn(mint) ? 0n : publicBalance;
    if (deposit > depositable) {
        throw new ConfidentialSendError(
            'insufficient-balance',
            `Insufficient balance: sending ${rawAmount} needs ${deposit} more than the private balance holds, ` +
                `but only ${depositable} is available to move from the public balance.`,
            { available, pending, public: depositable, required: rawAmount },
        );
    }
    const apply = shortfall > 0n;

    const plans: InstructionPlan[] = [];
    if (configure) {
        plans.push(
            await createConfigureConfidentialAccountInstructionPlan({
                rpc: input.rpc,
                payer: input.payer,
                owner: input.owner,
                mint: input.mint,
                keys: input.keys,
            }),
        );
    }
    if (approve) {
        plans.push(
            createApproveConfidentialAccountInstructionPlan({
                tokenAccount,
                mint: input.mint,
                authority: input.owner,
            }),
        );
    }
    if (deposit > 0n) {
        plans.push(
            singleInstructionPlan(
                getConfidentialDepositInstruction({
                    token: tokenAccount,
                    mint: input.mint,
                    authority: input.owner,
                    amount: deposit,
                    decimals,
                }),
            ),
        );
    }

    let newDecryptableAvailableBalance: Uint8Array | null = null;
    const availableAfter = apply ? available + pending + deposit : available;
    if (apply) {
        const ciphertext = input.keys.aes.encrypt(availableAfter);
        try {
            newDecryptableAvailableBalance = new Uint8Array(ciphertext.toBytes());
        } finally {
            ciphertext.free?.();
        }
        plans.push(
            singleInstructionPlan(
                getApplyConfidentialPendingBalanceInstruction({
                    token: tokenAccount,
                    authority: input.owner,
                    // The deposit above adds one credit before this apply runs.
                    expectedPendingBalanceCreditCounter: creditCounter + (deposit > 0n ? 1n : 0n),
                    newDecryptableAvailableBalance,
                }),
            ),
        );
    }

    return {
        plan: plans.length > 0 ? sequentialInstructionPlan(plans) : null,
        tokenAccount,
        rawAmount,
        decimals,
        steps: { configure, approve, deposit, apply },
        availableAfter,
        newDecryptableAvailableBalance,
    };
}

/**
 * Where a landed (or landing) preparation stands, read from the sender's
 * account:
 *
 * - `landed` — the account reflects the preparation; build the transfer now.
 * - `pending` — the RPC does not show it yet (a lagging node); poll again.
 * - `diverged` — the apply landed, but another credit arrived between reading
 *   the balance and applying it. The on-chain available balance then includes
 *   an amount the written AES balance does not, so a transfer built now would
 *   fail its proof. This is the race the expected/actual credit counters exist
 *   to expose; re-applying does not repair it, because the missing credit is
 *   already folded into the ElGamal available balance. Recovering means
 *   re-deriving the available balance from that ElGamal ciphertext, which is
 *   out of scope here, so callers should stop and surface it.
 */
export type ConfidentialSendPreparationStatus = 'landed' | 'pending' | 'diverged';

export async function getConfidentialSendPreparationStatus(input: {
    rpc: Rpc<SolanaRpcApi>;
    preparation: ConfidentialSendPreparation;
    commitment?: Commitment;
}): Promise<ConfidentialSendPreparationStatus> {
    const { preparation } = input;
    const state = await fetchConfidentialAccountState(input.rpc, preparation.tokenAccount, {
        commitment: input.commitment ?? 'confirmed',
    });
    if (!state || !state.approved) return 'pending';

    const written = preparation.newDecryptableAvailableBalance;
    if (written === null) return 'landed';

    const onChain = state.ciphertexts.decryptableAvailableBalance;
    const sameBytes = onChain.length === written.length && onChain.every((byte, i) => byte === written[i]);
    if (!sameBytes) return 'pending';

    return state.expectedPendingBalanceCreditCounter === state.actualPendingBalanceCreditCounter
        ? 'landed'
        : 'diverged';
}
