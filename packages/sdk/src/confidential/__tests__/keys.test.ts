import { generateKeyPairSigner } from '@solana/kit';
import { ElGamalKeypair, AeKey } from '@solana/zk-sdk/node';
import { deriveConfidentialKeys, freeConfidentialKeys, decryptAesBalance, decryptElGamalBalance } from '../keys.js';

// Uses the real @solana/zk-sdk WASM (verified to load under ts-jest ESM).

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
