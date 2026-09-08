jest.mock('@wallet-standard/core', () => ({
    getWallets: jest.fn(),
}));

import type { Address } from '@solana/kit';
import { createSignableMessage, generateKeyPairSigner } from '@solana/kit';
import { getWallets } from '@wallet-standard/core';
import { AeKey, ElGamalSecretKey } from '@solana/zk-sdk/node';
import { createKeyPairMessageSigner, deriveConfidentialKeysForOwnerMint, freeConfidentialKeys } from '../keys.js';
import { createMessageSigner, createResilientSignMessage, signMessageViaWalletStandard } from '../wallet-standard.js';
import type { SignMessage } from '../keys.js';

const mockGetWallets = getWallets as jest.Mock;

const OWNER = 'FAKE_OWNER_ADDRESS' as Address;
// A realistic canonical key-derivation message (arbitrary seed — these tests
// don't care which scheme produced it, only that it carries a recognised
// domain separator).
const MESSAGE = ElGamalSecretKey.signerMessage(new Uint8Array([1, 2, 3]));
const ARBITRARY_MESSAGE = new Uint8Array([1, 2, 3]);
const MINT_A = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address;

/** Registers `wallets` as what the mocked `@wallet-standard/core` registry returns. */
function setWallets(wallets: unknown[]): void {
    mockGetWallets.mockReturnValue({ get: () => wallets });
}

/** A minimal Wallet-Standard-shaped wallet exposing `solana:signMessage` (if `signMessage` is given). */
function fakeWallet(address: string, signMessage?: (input: { account: unknown; message: Uint8Array }) => unknown) {
    return {
        accounts: [{ address }],
        features: signMessage ? { 'solana:signMessage': { signMessage } } : {},
    };
}

/** `createResilientSignMessage` only returns `undefined` for an undefined owner — never true in these tests. */
function resilientOrThrow(owner: Address, fallback: SignMessage | undefined): SignMessage {
    const fn = createResilientSignMessage(owner, fallback);
    if (!fn) throw new Error('expected createResilientSignMessage to return a signer');
    return fn;
}

beforeEach(() => {
    mockGetWallets.mockReset();
    setWallets([]);
});

describe('createResilientSignMessage', () => {
    it('signs via the Wallet Standard registry when a matching wallet is found', async () => {
        const signature = new Uint8Array([9, 9, 9]);
        const signMessage = jest.fn(async () => [{ signedMessage: MESSAGE, signature }]);
        setWallets([fakeWallet(OWNER, signMessage)]);
        const fallback = jest.fn();

        const result = await resilientOrThrow(OWNER, fallback)(MESSAGE);

        expect(result).toEqual(signature);
        expect(signMessage).toHaveBeenCalledWith({
            account: expect.objectContaining({ address: OWNER }),
            message: MESSAGE,
        });
        expect(fallback).not.toHaveBeenCalled();
    });

    it('falls back when no wallet in the registry can sign for the owner', async () => {
        setWallets([fakeWallet('SOME_OTHER_ADDRESS', jest.fn())]);
        const fallbackSignature = new Uint8Array([5]);
        const fallback = jest.fn(async () => fallbackSignature);

        const result = await resilientOrThrow(OWNER, fallback)(MESSAGE);

        expect(result).toEqual(fallbackSignature);
        expect(fallback).toHaveBeenCalledWith(MESSAGE);
    });

    it('throws when no wallet matches and there is no fallback', async () => {
        await expect(resilientOrThrow(OWNER, undefined)(MESSAGE)).rejects.toThrow(/No Wallet Standard wallet/);
    });

    it('falls back when the Wallet Standard feature throws a non-rejection error', async () => {
        const signMessage = jest.fn(async () => {
            throw new Error('malformed request');
        });
        setWallets([fakeWallet(OWNER, signMessage)]);
        const fallbackSignature = new Uint8Array([7]);
        const fallback = jest.fn(async () => fallbackSignature);

        const result = await resilientOrThrow(OWNER, fallback)(MESSAGE);

        expect(result).toEqual(fallbackSignature);
    });

    it.each([
        ['a numeric code 4001', { code: 4001 }],
        ['a message matching the rejection pattern', new Error('User rejected the request')],
    ])('re-throws a genuine user rejection (%s) without trying the fallback', async (_desc, rejection) => {
        const signMessage = jest.fn(async () => {
            throw rejection;
        });
        setWallets([fakeWallet(OWNER, signMessage)]);
        const fallback = jest.fn();

        await expect(resilientOrThrow(OWNER, fallback)(MESSAGE)).rejects.toBe(rejection);
        expect(fallback).not.toHaveBeenCalled();
    });

    it('falls back when the Wallet Standard result shape is unrecognised', async () => {
        setWallets([
            fakeWallet(
                OWNER,
                jest.fn(async () => ({})),
            ),
        ]);
        const fallbackSignature = new Uint8Array([2]);
        const fallback = jest.fn(async () => fallbackSignature);

        const result = await resilientOrThrow(OWNER, fallback)(MESSAGE);

        expect(result).toEqual(fallbackSignature);
    });

    it('returns undefined synchronously when there is no owner', () => {
        expect(createResilientSignMessage(undefined, jest.fn())).toBeUndefined();
    });

    it('rejects an arbitrary non-derivation message without touching the wallet or the fallback', async () => {
        const signMessage = jest.fn();
        setWallets([fakeWallet(OWNER, signMessage)]);
        const fallback = jest.fn();

        await expect(resilientOrThrow(OWNER, fallback)(ARBITRARY_MESSAGE)).rejects.toThrow(
            /confidential-balance key-derivation/,
        );
        expect(signMessage).not.toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
    });
});

describe('signMessageViaWalletStandard: signature shape normalization', () => {
    const signature = new Uint8Array([1, 2, 3, 4]);

    const shapes: [string, () => Promise<unknown>][] = [
        ['a bare Uint8Array', async () => signature],
        ['the spec-conformant array form', async () => [{ signedMessage: MESSAGE, signature }]],
        ['a single non-array object', async () => ({ signedMessage: MESSAGE, signature })],
    ];

    it.each(shapes)('accepts %s', async (_desc, resultFactory) => {
        setWallets([fakeWallet(OWNER, jest.fn(resultFactory))]);

        const result = await signMessageViaWalletStandard(OWNER, MESSAGE);

        expect(result).toEqual(signature);
    });

    it('rejects an unrecognised result shape', async () => {
        setWallets([
            fakeWallet(
                OWNER,
                jest.fn(async () => ({})),
            ),
        ]);

        await expect(signMessageViaWalletStandard(OWNER, MESSAGE)).rejects.toThrow(/unrecognised signMessage result/);
    });
});

describe('signMessageViaWalletStandard: canonical message enforcement', () => {
    it('accepts an AeKey derivation message alongside an ElGamal one', async () => {
        const signature = new Uint8Array([9]);
        const aeMessage = AeKey.signerMessage(new Uint8Array([1, 2, 3]));
        setWallets([
            fakeWallet(
                OWNER,
                jest.fn(async () => signature),
            ),
        ]);

        const result = await signMessageViaWalletStandard(OWNER, aeMessage);

        expect(result).toEqual(signature);
    });

    it('refuses to sign an arbitrary message, without ever calling the wallet', async () => {
        const signMessage = jest.fn();
        setWallets([fakeWallet(OWNER, signMessage)]);

        await expect(signMessageViaWalletStandard(OWNER, ARBITRARY_MESSAGE)).rejects.toThrow(
            /confidential-balance key-derivation/,
        );
        expect(signMessage).not.toHaveBeenCalled();
    });
});

describe('createMessageSigner', () => {
    it('wraps a SignMessage function into a MessagePartialSigner', async () => {
        const signature = new Uint8Array([1, 2, 3]);
        const signMessage = jest.fn(async () => signature);
        const signer = createMessageSigner(OWNER, signMessage);

        expect(signer.address).toBe(OWNER);

        const message = createSignableMessage(new Uint8Array([9, 9]));
        const [result] = await signer.signMessages([message]);

        expect(result).toEqual({ [OWNER]: signature });
        expect(signMessage).toHaveBeenCalledWith(new Uint8Array(message.content));
    });

    it('preserves message order across multiple messages', async () => {
        const signMessage = jest.fn(async (bytes: Uint8Array) => bytes);
        const signer = createMessageSigner(OWNER, signMessage);
        const first = createSignableMessage(new Uint8Array([1]));
        const second = createSignableMessage(new Uint8Array([2]));

        const [firstResult, secondResult] = await signer.signMessages([first, second]);

        expect(firstResult[OWNER]).toEqual(new Uint8Array([1]));
        expect(secondResult[OWNER]).toEqual(new Uint8Array([2]));
    });
});

describe('integration with deriveConfidentialKeysForOwnerMint', () => {
    // Guards against a shape-normalization bug silently corrupting real key
    // derivation: forces the fallback path (empty Wallet Standard registry) and
    // asserts the derived keys are byte-identical to the plain, non-resilient path.
    it('derives byte-identical keys through the fallback path', async () => {
        const signer = await generateKeyPairSigner();
        const realSign = createKeyPairMessageSigner(signer);
        const owner = signer.address;

        const resilientSigner = createMessageSigner(owner, resilientOrThrow(owner, realSign));

        const viaResilient = await deriveConfidentialKeysForOwnerMint({ signer: resilientSigner, owner, mint: MINT_A });
        const viaDirect = await deriveConfidentialKeysForOwnerMint({ signer, owner, mint: MINT_A });

        expect(viaResilient.elgamal.pubkey().toBytes()).toEqual(viaDirect.elgamal.pubkey().toBytes());
        expect(viaResilient.aes.toBytes()).toEqual(viaDirect.aes.toBytes());

        freeConfidentialKeys(viaResilient);
        freeConfidentialKeys(viaDirect);
    });
});
