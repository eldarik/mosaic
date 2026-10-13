'use client';

import { useCallback, useMemo, useState } from 'react';
import {
    type Address,
    type GetMinimumBalanceForRentExemptionApi,
    type Rpc,
    type Signature,
    type SolanaRpcApi,
    type TransactionSigner,
    createSolanaRpc,
    sequentialInstructionPlan,
} from '@solana/kit';
import { useConnector } from '@solana/connector/react';
import type { ConfidentialRecipientNotReadyReason, ConfidentialSendErrorCode } from '@solana/mosaic-sdk/confidential';
import { useConnectorSigner } from '@/features/wallet/hooks/use-connector-signer';
import { humanizeError } from '@/lib/errors';
import { useConfidentialKeys } from './use-confidential-keys';
import { useConfidentialTxVersion } from './use-confidential-tx-version';
import { executeConfidentialPlan } from '../lib/execute-confidential-plan';
import {
    buildApprovePlan,
    buildConfigurePlan,
    buildSendPreparation,
    buildTransferPlan,
    checkRecipient,
    fetchConfidentialMintConfig,
    fetchSendPreparationStatus,
    resolveAta,
} from '../lib/operations';

type RpcWithRent = Rpc<GetMinimumBalanceForRentExemptionApi & SolanaRpcApi>;

export type ConfidentialSendStage =
    | 'checking-recipient'
    | 'unlocking'
    | 'preparing'
    | 'waiting-for-preparation'
    | 'sending'
    | 'enabling';

export type ConfidentialSendStatus =
    | { kind: 'idle' }
    | {
          kind: 'running';
          stage: ConfidentialSendStage;
          /** The wallet is showing (or about to show) a signature prompt. */
          awaitingWallet: boolean;
          progress?: { current: number; total: number };
      }
    | {
          kind: 'success';
          action: 'send' | 'enable';
          amount?: string;
          recipient?: Address;
          /** Every transaction that landed, in order; the last is the transfer itself. */
          signatures: Signature[];
      }
    | { kind: 'recipient-not-ready'; recipient: Address; reason: ConfidentialRecipientNotReadyReason }
    | { kind: 'error'; message: string; code?: ConfidentialSendErrorCode };

const PREPARATION_POLL_MS = 1_500;
const PREPARATION_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One-button confidential send: recipient + amount in, everything else
 * decided here.
 *
 * 1. Check the recipient can receive — before anything is signed, since a
 *    sender can never configure someone else's account.
 * 2. Derive the sender's keys (one message signature, cached for the session).
 * 3. Build and land the *preparation*: configure / approve / deposit the
 *    shortfall / apply, as one batch-signed plan. Skipped when the available
 *    confidential balance already covers the amount.
 * 4. Wait for the preparation to show up at `confirmed`, then build the
 *    transfer against that state and land it as a second batch.
 *
 * Worst case for a fresh holder: one message prompt plus two transaction
 * prompts, against nine for the step-by-step wizard at version 0.
 */
export function useConfidentialSend({ mint }: { mint: Address }) {
    const { selectedAccount, cluster } = useConnector();
    const signer = useConnectorSigner();
    const { getKeys } = useConfidentialKeys();
    const { version } = useConfidentialTxVersion();
    const [status, setStatus] = useState<ConfidentialSendStatus>({ kind: 'idle' });

    const owner = selectedAccount ? (String(selectedAccount) as Address) : undefined;
    const rpc = useMemo<RpcWithRent | null>(
        () => (cluster?.url ? (createSolanaRpc(cluster.url) as RpcWithRent) : null),
        [cluster?.url],
    );

    const running = useCallback(
        (stage: ConfidentialSendStage, awaitingWallet = false) => setStatus({ kind: 'running', stage, awaitingWallet }),
        [],
    );

    const fail = useCallback((err: unknown) => {
        const code =
            err instanceof Error && err.name === 'ConfidentialSendError'
                ? (err as Error & { code: ConfidentialSendErrorCode }).code
                : undefined;
        setStatus({ kind: 'error', message: humanizeError(err), code });
    }, []);

    /** Executes `plan` as one batch, mirroring progress into the running status. */
    const execute = useCallback(
        (plan: Parameters<typeof executeConfidentialPlan>[0]['instructionPlan'], stage: ConfidentialSendStage) => {
            if (!rpc || !signer) throw new Error('Wallet not connected.');
            return executeConfidentialPlan({
                instructionPlan: plan,
                feePayer: signer as unknown as TransactionSigner,
                rpc,
                version,
                signing: 'batch',
                onAwaitingSignature: () => setStatus({ kind: 'running', stage, awaitingWallet: true }),
                onProgress: (current, total) =>
                    setStatus({ kind: 'running', stage, awaitingWallet: false, progress: { current, total } }),
            });
        },
        [rpc, signer, version],
    );

    const send = useCallback(
        async (recipient: Address, amount: string) => {
            if (!rpc || !signer || !owner) {
                setStatus({ kind: 'error', message: 'Connect a wallet first.' });
                return;
            }
            if (recipient === owner) {
                setStatus({ kind: 'error', message: 'The recipient is your own wallet.' });
                return;
            }
            const authority = signer as unknown as TransactionSigner;

            try {
                running('checking-recipient');
                const recipientStatus = await checkRecipient({ rpc, mint, recipient });
                if (!recipientStatus.ready) {
                    setStatus({ kind: 'recipient-not-ready', recipient, reason: recipientStatus.reason });
                    return;
                }

                running('unlocking', true);
                const keys = await getKeys();

                running('preparing');
                const preparation = await buildSendPreparation({
                    rpc,
                    payer: authority,
                    owner: authority,
                    mint,
                    amount,
                    keys,
                });

                const signatures: Signature[] = [];
                if (preparation.plan) {
                    signatures.push(...(await execute(preparation.plan, 'preparing')));

                    running('waiting-for-preparation');
                    const deadline = Date.now() + PREPARATION_TIMEOUT_MS;
                    for (;;) {
                        const state = await fetchSendPreparationStatus({ rpc, preparation });
                        if (state === 'landed') break;
                        if (state === 'diverged') {
                            throw new Error(
                                'Another payment arrived while your private balance was being prepared, so it is out of sync. ' +
                                    'Nothing was sent to the recipient. Use the advanced page to inspect the balance before retrying.',
                            );
                        }
                        if (Date.now() > deadline) {
                            throw new Error(
                                'Your private balance was prepared, but the RPC has not shown it yet. Nothing was sent to the recipient — try again in a moment.',
                            );
                        }
                        await sleep(PREPARATION_POLL_MS);
                    }
                }

                running('sending');
                const transferPlan = await buildTransferPlan({
                    rpc,
                    payer: authority,
                    mint,
                    sourceToken: preparation.tokenAccount,
                    destinationToken: recipientStatus.tokenAccount,
                    authority,
                    amount,
                    keys,
                    // The preparation was just confirmed; a finalized read would miss it.
                    commitment: 'confirmed',
                });
                signatures.push(...(await execute(transferPlan, 'sending')));

                setStatus({ kind: 'success', action: 'send', amount, recipient, signatures });
            } catch (err) {
                fail(err);
            }
        },
        [rpc, signer, owner, mint, getKeys, execute, running, fail],
    );

    /**
     * The receiving side's one click: configure the connected wallet's account
     * (and approve it, when this wallet is the mint's confidential authority on
     * a manual-approval mint), in one batch.
     */
    const enableReceiving = useCallback(async () => {
        if (!rpc || !signer || !owner) {
            setStatus({ kind: 'error', message: 'Connect a wallet first.' });
            return;
        }
        const authority = signer as unknown as TransactionSigner;
        try {
            running('unlocking', true);
            const keys = await getKeys();

            running('enabling');
            const mintConfig = await fetchConfidentialMintConfig(rpc, mint);
            if (!mintConfig) throw new Error('This mint does not support confidential transfers.');

            const plans = [await buildConfigurePlan({ rpc, payer: authority, owner: authority, mint, keys })];
            if (!mintConfig.autoApproveNewAccounts && mintConfig.authority === owner) {
                plans.push(await buildApprovePlan({ tokenAccount: await resolveAta(owner, mint), mint, authority }));
            }
            const signatures = await execute(sequentialInstructionPlan(plans), 'enabling');
            setStatus({ kind: 'success', action: 'enable', signatures });
        } catch (err) {
            fail(err);
        }
    }, [rpc, signer, owner, mint, getKeys, execute, running, fail]);

    const reset = useCallback(() => setStatus({ kind: 'idle' }), []);

    return { status, send, enableReceiving, reset, rpc, owner };
}
