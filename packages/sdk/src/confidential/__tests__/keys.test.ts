import type { Address } from '@solana/kit';
import { generateKeyPairSigner, getAddressDecoder } from '@solana/kit';
import { ElGamalKeypair, AeKey } from '@solana/zk-sdk/node';
import {
    assertConfidentialKeysMatchAccount,
    deriveConfidentialKeys,
    deriveConfidentialSupplyKeys,
    freeConfidentialKeys,
    decryptAesBalance,
    decryptElGamalBalance,
} from '../keys.js';

// Uses the real @solana/zk-sdk WASM (verified to load under ts-jest ESM).
const MINT_A = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address;
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address;

describe('deriveConfidentialKeys', () => {
    it('is deterministic: same signer yields the same keys', async () => {
        const signer = await generateKeyPairSigner();
        const a = await deriveConfidentialKeys({ signer });
        const b = await deriveConfidentialKeys({ signer });

        expect(a.elgamal.pubkey().toBytes()).toEqual(b.elgamal.pubkey().toBytes());
        expect(a.aes.toBytes()).toEqual(b.aes.toBytes());

        freeConfidentialKeys(a);
        freeConfidentialKeys(b);
    });

    it('binds keys to the wallet: a different signer yields different keys', async () => {
        const signerA = await generateKeyPairSigner();
        const signerB = await generateKeyPairSigner();
        const a = await deriveConfidentialKeys({ signer: signerA });
        const b = await deriveConfidentialKeys({ signer: signerB });

        expect(a.elgamal.pubkey().toBytes()).not.toEqual(b.elgamal.pubkey().toBytes());
        expect(a.aes.toBytes()).not.toEqual(b.aes.toBytes());

        freeConfidentialKeys(a);
        freeConfidentialKeys(b);
    });

    it('produces usable keys (AES round-trip)', async () => {
        const signer = await generateKeyPairSigner();
        const keys = await deriveConfidentialKeys({ signer });
        const ciphertext = new Uint8Array(keys.aes.encrypt(7_777n).toBytes());
        expect(decryptAesBalance(keys.aes, ciphertext)).toBe(7_777n);
        freeConfidentialKeys(keys);
    });

    // The derivation frees the intermediate `ConfidentialKeys` pair once it has
    // taken the two components out. Both must survive that: exercise each with a
    // real crypto round-trip, which would fault on a dangling WASM pointer.
    it('produces usable keys after the intermediate pair is freed', async () => {
        const signer = await generateKeyPairSigner();
        const keys = await deriveConfidentialKeys({ signer });

        const aesCiphertext = new Uint8Array(keys.aes.encrypt(7_777n).toBytes());
        expect(decryptAesBalance(keys.aes, aesCiphertext)).toBe(7_777n);

        const pubkey = keys.elgamal.pubkey();
        const elgamalCiphertext = new Uint8Array(pubkey.encryptU64(42n).toBytes());
        expect(decryptElGamalBalance(keys.elgamal, elgamalCiphertext)).toBe(42n);
        pubkey.free();

        freeConfidentialKeys(keys);
    });

    // One signature, not two — the regression this guards against is a
    // user-visible double wallet prompt for a single key derivation.
    it('requests exactly one signature', async () => {
        const signer = await generateKeyPairSigner();
        const signMessages = jest.fn(signer.signMessages.bind(signer));
        const keys = await deriveConfidentialKeys({ signer: { ...signer, signMessages } });

        expect(signMessages).toHaveBeenCalledTimes(1);
        freeConfidentialKeys(keys);
    });

    it('re-throws a genuine user rejection without diagnosing it as an incompatibility', async () => {
        const signer = await generateKeyPairSigner();
        const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 });
        const signMessages = jest.fn(async () => {
            throw rejection;
        });

        await expect(deriveConfidentialKeys({ signer: { ...signer, signMessages } })).rejects.toBe(rejection);
    });

    it('diagnoses a non-rejection signer refusal instead of surfacing the raw error', async () => {
        const signer = await generateKeyPairSigner();
        const signMessages = jest.fn(async () => {
            throw new Error('unsupported payload');
        });

        await expect(deriveConfidentialKeys({ signer: { ...signer, signMessages } })).rejects.toThrow(
            /solana-conf-bal\/v1/,
        );
    });
});

describe('deriveConfidentialSupplyKeys', () => {
    it('is deterministic: same mint authority + mint yields the same supply keys', async () => {
        const signer = await generateKeyPairSigner();
        const a = await deriveConfidentialSupplyKeys({ signer, mint: MINT_A });
        const b = await deriveConfidentialSupplyKeys({ signer, mint: MINT_A });

        expect(a.elgamal.pubkey().toBytes()).toEqual(b.elgamal.pubkey().toBytes());
        expect(a.aes.toBytes()).toEqual(b.aes.toBytes());

        freeConfidentialKeys(a);
        freeConfidentialKeys(b);
    });

    it('binds supply keys to the mint', async () => {
        const signer = await generateKeyPairSigner();
        const a = await deriveConfidentialSupplyKeys({ signer, mint: MINT_A });
        const b = await deriveConfidentialSupplyKeys({ signer, mint: MINT_B });

        expect(a.elgamal.pubkey().toBytes()).not.toEqual(b.elgamal.pubkey().toBytes());
        expect(a.aes.toBytes()).not.toEqual(b.aes.toBytes());

        freeConfidentialKeys(a);
        freeConfidentialKeys(b);
    });

    // The point of the domain tag: account keys are wallet-only (no seed at all),
    // so without this tag a mint authority's supply-key derivation would collide
    // with its own account-key derivation, and handing out account keys (to an
    // auditor, to support, in a backup) would also hand out the total-supply keys.
    it('is domain-separated from the wallet-only account derivation', async () => {
        const signer = await generateKeyPairSigner();
        const supply = await deriveConfidentialSupplyKeys({ signer, mint: MINT_A });
        const account = await deriveConfidentialKeys({ signer });

        expect(supply.elgamal.pubkey().toBytes()).not.toEqual(account.elgamal.pubkey().toBytes());
        expect(supply.aes.toBytes()).not.toEqual(account.aes.toBytes());

        freeConfidentialKeys(supply);
        freeConfidentialKeys(account);
    });

    it('requests exactly one signature', async () => {
        const signer = await generateKeyPairSigner();
        const signMessages = jest.fn(signer.signMessages.bind(signer));
        const keys = await deriveConfidentialSupplyKeys({
            signer: { ...signer, signMessages },
            mint: MINT_A,
        });

        expect(signMessages).toHaveBeenCalledTimes(1);
        freeConfidentialKeys(keys);
    });

    it('produces usable keys (AES + ElGamal round-trip)', async () => {
        const signer = await generateKeyPairSigner();
        const keys = await deriveConfidentialSupplyKeys({ signer, mint: MINT_A });

        expect(decryptAesBalance(keys.aes, new Uint8Array(keys.aes.encrypt(4_200n).toBytes()))).toBe(4_200n);
        const pubkey = keys.elgamal.pubkey();
        expect(decryptElGamalBalance(keys.elgamal, new Uint8Array(pubkey.encryptU64(11n).toBytes()))).toBe(11n);
        pubkey.free();

        freeConfidentialKeys(keys);
    });
});

describe('assertConfidentialKeysMatchAccount', () => {
    it('does not throw when the derived pubkey matches the registered one', async () => {
        const signer = await generateKeyPairSigner();
        const keys = await deriveConfidentialKeys({ signer });
        const registered = getAddressDecoder().decode(keys.elgamal.pubkey().toBytes());

        expect(() => assertConfidentialKeysMatchAccount(keys, registered, 'token account X')).not.toThrow();

        freeConfidentialKeys(keys);
    });

    // The scenario the reviewer flagged: an account configured under an older
    // key-derivation scheme re-derives to different key bytes under the current
    // wallet-only one. Simulated here by comparing against a registered pubkey
    // from an unrelated derivation (a different signer).
    it('throws a targeted error when the derived pubkey does not match', async () => {
        const signer = await generateKeyPairSigner();
        const otherSigner = await generateKeyPairSigner();
        const keys = await deriveConfidentialKeys({ signer });
        const staleRegistered = await deriveConfidentialKeys({ signer: otherSigner });
        const registered = getAddressDecoder().decode(staleRegistered.elgamal.pubkey().toBytes());

        expect(() => assertConfidentialKeysMatchAccount(keys, registered, 'token account X')).toThrow(
            /does not match token account X's registered key/,
        );

        freeConfidentialKeys(keys);
        freeConfidentialKeys(staleRegistered);
    });
});

describe('balance decryption round-trips', () => {
    it('decryptAesBalance recovers the AES-encrypted amount', () => {
        const aes = AeKey.fromSeed(new Uint8Array(32).fill(7));
        const ciphertext = new Uint8Array(aes.encrypt(123_456n).toBytes());
        expect(decryptAesBalance(aes, ciphertext)).toBe(123_456n);
        aes.free();
    });

    it('decryptElGamalBalance recovers a (small) ElGamal-encrypted amount', () => {
        const elgamal = ElGamalKeypair.fromSeed(new Uint8Array(32).fill(8));
        const ciphertext = new Uint8Array(elgamal.pubkey().encryptU64(4_096n).toBytes());
        expect(decryptElGamalBalance(elgamal, ciphertext)).toBe(4_096n);
        elgamal.free();
    });

    it('decryptAesBalance throws on a malformed ciphertext', () => {
        const aes = AeKey.fromSeed(new Uint8Array(32).fill(9));
        expect(() => decryptAesBalance(aes, new Uint8Array(8))).toThrow(/AES ciphertext/);
        aes.free();
    });

    it('decryptElGamalBalance throws on a malformed ciphertext', () => {
        const elgamal = ElGamalKeypair.fromSeed(new Uint8Array(32).fill(10));
        expect(() => decryptElGamalBalance(elgamal, new Uint8Array(8))).toThrow(/ElGamal ciphertext/);
        elgamal.free();
    });
});
