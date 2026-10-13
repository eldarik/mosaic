import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { createMockSigner } from '../../__tests__/test-utils.js';
import type { ConfidentialKeys } from '../keys.js';

// --- Mocks --------------------------------------------------------------------
// Keep the real instruction encoders (pure codecs) and ATA derivation, but stub
// the account fetches, the upstream configure plan and the WASM decryption so
// the send planner's decisions can be asserted without a cluster or WASM.
const mockConfigurePlan = { kind: 'configurePlan' } as const;
let mockMint: unknown;
let mockSenderAccount: unknown;
let mockRecipientAccount: unknown;
let mockAccountState: unknown;
// ElGamal "ciphertexts" are tagged by their first byte; the mock decrypts by tag.
const mockElgamalPlaintext: Record<number, bigint> = {};
let mockAesPlaintext = 0n;

jest.mock('@solana-program/token-2022', () => ({
    ...jest.requireActual('@solana-program/token-2022'),
    fetchMint: jest.fn(async () => mockMint),
    fetchMaybeToken: jest.fn(async (_rpc: unknown, addr: string) =>
        addr === SENDER_ATA ? mockSenderAccount : mockRecipientAccount,
    ),
}));

jest.mock('@solana-program/token-2022/confidential', () => ({
    getCreateConfidentialTransferAccountInstructionPlan: jest.fn(async () => mockConfigurePlan),
}));

jest.mock('../keys.js', () => ({
    assertConfidentialKeysMatchAccount: jest.fn(),
    decryptAesBalance: jest.fn(() => mockAesPlaintext),
    decryptElGamalBalance: jest.fn((_keypair: unknown, ct: Uint8Array) => mockElgamalPlaintext[ct[0]] ?? 0n),
}));

jest.mock('../account-state.js', () => ({
    fetchConfidentialAccountState: jest.fn(async () => mockAccountState),
}));

import {
    findAssociatedTokenPda,
    getApplyConfidentialPendingBalanceInstructionDataDecoder,
    getConfidentialDepositInstructionDataDecoder,
    TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import {
    ConfidentialSendError,
    checkConfidentialRecipient,
    createConfidentialSendPreparationInstructionPlan,
    getConfidentialSendPreparationStatus,
    type ConfidentialSendPreparation,
} from '../send.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address;
const OWNER = 'FA4EafWTpd3WEpB5hzsMjPwWnFBzjN25nKHsStgxBpiT' as Address;
const RECIPIENT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address;
const OTHER_AUTHORITY = 'HA3KcFsXNjRJsRZq1P1Y8qPAeSZnZsFyauCDEsSSGqTj' as Address;
let SENDER_ATA: Address;
let RECIPIENT_ATA: Address;

const WRITTEN_AES = new Uint8Array(36).fill(7);
const fakeKeys = {
    elgamal: {},
    aes: { encrypt: jest.fn(() => ({ toBytes: () => WRITTEN_AES, free: jest.fn() })) },
} as unknown as ConfidentialKeys;

const rpc = {} as Rpc<SolanaRpcApi>;
const owner = createMockSigner(OWNER);

function mintWith(ext: { autoApprove?: boolean; authority?: Address | null; mintBurn?: boolean } = {}) {
    const authority = ext.authority === undefined ? OTHER_AUTHORITY : ext.authority;
    return {
        data: {
            decimals: 6,
            extensions: {
                __option: 'Some',
                value: [
                    {
                        __kind: 'ConfidentialTransferMint',
                        autoApproveNewAccounts: ext.autoApprove ?? true,
                        authority: authority ? { __option: 'Some', value: authority } : { __option: 'None' },
                    },
                    ...(ext.mintBurn ? [{ __kind: 'ConfidentialMintBurn' }] : []),
                ],
            },
        },
    };
}

function tokenAccount(publicAmount: bigint, ct?: Record<string, unknown>) {
    return {
        exists: true,
        data: {
            amount: publicAmount,
            extensions: ct
                ? {
                      __option: 'Some',
                      value: [
                          {
                              __kind: 'ConfidentialTransferAccount',
                              approved: true,
                              allowConfidentialCredits: true,
                              elgamalPubkey: OWNER,
                              decryptableAvailableBalance: new Uint8Array(36),
                              pendingBalanceLow: new Uint8Array(64).fill(1),
                              pendingBalanceHigh: new Uint8Array(64).fill(2),
                              pendingBalanceCreditCounter: 0n,
                              ...ct,
                          },
                      ],
                  }
                : { __option: 'None' },
        },
    };
}

/** The sequential plan's children, in order. */
function steps(plan: unknown): any[] {
    expect(plan).toMatchObject({ kind: 'sequential' });
    return (plan as { plans: unknown[] }).plans;
}

const decodeDeposit = (p: any) => getConfidentialDepositInstructionDataDecoder().decode(p.instruction.data);
const decodeApply = (p: any) => getApplyConfidentialPendingBalanceInstructionDataDecoder().decode(p.instruction.data);

beforeAll(async () => {
    [SENDER_ATA] = await findAssociatedTokenPda({ owner: OWNER, mint: MINT, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    [RECIPIENT_ATA] = await findAssociatedTokenPda({
        owner: RECIPIENT,
        mint: MINT,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
});

beforeEach(() => {
    jest.clearAllMocks();
    mockMint = mintWith();
    mockAesPlaintext = 0n;
    mockElgamalPlaintext[1] = 0n;
    mockElgamalPlaintext[2] = 0n;
});

const prepare = (amount: string | bigint) =>
    createConfidentialSendPreparationInstructionPlan({
        rpc: rpc as never,
        payer: owner,
        owner,
        mint: MINT,
        amount,
        keys: fakeKeys,
    });

describe('createConfidentialSendPreparationInstructionPlan', () => {
    it('configures, deposits and applies for a fresh holder with only a public balance', async () => {
        mockSenderAccount = tokenAccount(5_000_000n);

        const prep = await prepare('2');

        expect(prep.steps).toEqual({ configure: true, approve: false, deposit: 2_000_000n, apply: true });
        expect(prep.tokenAccount).toBe(SENDER_ATA);
        expect(prep.availableAfter).toBe(2_000_000n);
        const [configure, deposit, apply] = steps(prep.plan);
        expect(configure).toBe(mockConfigurePlan);
        expect(decodeDeposit(deposit)).toMatchObject({ amount: 2_000_000n, decimals: 6 });
        // The deposit adds the first credit, so the apply expects one.
        expect(decodeApply(apply).expectedPendingBalanceCreditCounter).toBe(1n);
        expect(fakeKeys.aes.encrypt).toHaveBeenCalledWith(2_000_000n);
        expect(prep.newDecryptableAvailableBalance).toEqual(WRITTEN_AES);
    });

    it('returns no plan when the available balance already covers the amount', async () => {
        mockSenderAccount = tokenAccount(0n, {});
        mockAesPlaintext = 3_000_000n;

        const prep = await prepare('1.5');

        expect(prep.plan).toBeNull();
        expect(prep.steps).toEqual({ configure: false, approve: false, deposit: 0n, apply: false });
        expect(prep.newDecryptableAvailableBalance).toBeNull();
    });

    it('applies the pending balance without depositing when pending covers the shortfall', async () => {
        mockSenderAccount = tokenAccount(9_000_000n, { pendingBalanceCreditCounter: 3n });
        mockAesPlaintext = 1_000_000n;
        // pending = low + (high << 16)
        mockElgamalPlaintext[1] = 0n;
        mockElgamalPlaintext[2] = 30n; // 30 << 16 = 1_966_080

        const prep = await prepare('2');

        expect(prep.steps).toEqual({ configure: false, approve: false, deposit: 0n, apply: true });
        const [apply] = steps(prep.plan);
        expect(decodeApply(apply).expectedPendingBalanceCreditCounter).toBe(3n);
        expect(prep.availableAfter).toBe(1_000_000n + 1_966_080n);
    });

    it('deposits only the shortfall left after available and pending', async () => {
        mockSenderAccount = tokenAccount(9_000_000n, { pendingBalanceCreditCounter: 2n });
        mockAesPlaintext = 1_000_000n;
        mockElgamalPlaintext[1] = 500_000n & 0xffffn;
        mockElgamalPlaintext[2] = 500_000n >> 16n;

        const prep = await prepare('4');

        expect(prep.steps.deposit).toBe(2_500_000n);
        const [deposit, apply] = steps(prep.plan);
        expect(decodeDeposit(deposit).amount).toBe(2_500_000n);
        expect(decodeApply(apply).expectedPendingBalanceCreditCounter).toBe(3n);
        expect(prep.availableAfter).toBe(4_000_000n);
    });

    it('throws insufficient-balance before building anything', async () => {
        mockSenderAccount = tokenAccount(1_000_000n, {});
        mockAesPlaintext = 500_000n;

        const err = await prepare('2').catch(e => e);

        expect(err).toBeInstanceOf(ConfidentialSendError);
        expect(err.code).toBe('insufficient-balance');
        expect(err.balances).toEqual({ available: 500_000n, pending: 0n, public: 1_000_000n, required: 2_000_000n });
    });

    it('does not count the public balance of a confidential mint-burn mint', async () => {
        mockMint = mintWith({ mintBurn: true });
        mockSenderAccount = tokenAccount(9_000_000n, {});

        await expect(prepare('1')).rejects.toMatchObject({ code: 'insufficient-balance' });
    });

    it('throws not-approved when approval is needed from another authority', async () => {
        mockMint = mintWith({ autoApprove: false });
        mockSenderAccount = tokenAccount(5_000_000n);

        await expect(prepare('1')).rejects.toMatchObject({ code: 'not-approved' });
    });

    it('approves its own account when the sender is the confidential authority', async () => {
        mockMint = mintWith({ autoApprove: false, authority: OWNER });
        mockSenderAccount = tokenAccount(0n, { approved: false });
        mockAesPlaintext = 5_000_000n;

        const prep = await prepare('1');

        expect(prep.steps).toEqual({ configure: false, approve: true, deposit: 0n, apply: false });
        expect(steps(prep.plan)).toHaveLength(1);
    });

    it('rejects a mint without confidential transfers', async () => {
        mockMint = { data: { decimals: 6, extensions: { __option: 'None' } } };
        mockSenderAccount = tokenAccount(5_000_000n);

        await expect(prepare('1')).rejects.toMatchObject({ code: 'mint-not-confidential' });
    });
});

describe('checkConfidentialRecipient', () => {
    const check = () => checkConfidentialRecipient({ rpc, mint: MINT, recipient: RECIPIENT });

    it.each([
        ['no-account', { exists: false }],
        ['not-configured', tokenAccount(0n)],
        ['not-approved', tokenAccount(0n, { approved: false })],
        ['credits-disabled', tokenAccount(0n, { allowConfidentialCredits: false })],
    ])('reports %s', async (reason, account) => {
        mockRecipientAccount = account;
        await expect(check()).resolves.toEqual({ ready: false, tokenAccount: RECIPIENT_ATA, reason });
    });

    it('reports ready for a configured, approved account accepting credits', async () => {
        mockRecipientAccount = tokenAccount(0n, {});
        await expect(check()).resolves.toEqual({ ready: true, tokenAccount: RECIPIENT_ATA });
    });
});

describe('getConfidentialSendPreparationStatus', () => {
    const preparation = (written: Uint8Array | null) =>
        ({ tokenAccount: SENDER_ATA, newDecryptableAvailableBalance: written }) as ConfidentialSendPreparation;
    const state = (decryptable: Uint8Array, expected = 1n, actual = 1n, approved = true) => ({
        approved,
        expectedPendingBalanceCreditCounter: expected,
        actualPendingBalanceCreditCounter: actual,
        ciphertexts: { decryptableAvailableBalance: decryptable },
    });
    const status = (written: Uint8Array | null) =>
        getConfidentialSendPreparationStatus({ rpc, preparation: preparation(written) });

    it('is pending until the account exists and is approved', async () => {
        mockAccountState = null;
        await expect(status(null)).resolves.toBe('pending');
        mockAccountState = state(new Uint8Array(36), 0n, 0n, false);
        await expect(status(null)).resolves.toBe('pending');
    });

    it('is landed for a configure-only preparation once the account is approved', async () => {
        mockAccountState = state(new Uint8Array(36));
        await expect(status(null)).resolves.toBe('landed');
    });

    it('is pending until the written decryptable balance shows up', async () => {
        mockAccountState = state(new Uint8Array(36));
        await expect(status(WRITTEN_AES)).resolves.toBe('pending');
    });

    it('is landed when the apply landed with no racing credit', async () => {
        mockAccountState = state(WRITTEN_AES, 2n, 2n);
        await expect(status(WRITTEN_AES)).resolves.toBe('landed');
    });

    it('is diverged when a credit raced the apply', async () => {
        mockAccountState = state(WRITTEN_AES, 2n, 3n);
        await expect(status(WRITTEN_AES)).resolves.toBe('diverged');
    });
});
