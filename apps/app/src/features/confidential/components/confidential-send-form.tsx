'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Address } from '@solana/kit';
import { useConnector } from '@solana/connector/react';
import { CheckCircle2, ExternalLink, Loader2, Lock, ShieldCheck, UserX } from 'lucide-react';
import type { ConfidentialRecipientNotReadyReason } from '@solana/mosaic-sdk/confidential';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AmountInput } from '@/components/shared/form/amount-input';
import { SolanaAddressInput } from '@/components/shared/form/solana-address-input';
import { useInputValidation } from '@/hooks/use-input-validation';
import { useTokenBalance } from '@/hooks/use-token-balance';
import { buildExplorerUrl, getClusterName } from '@/lib/solana/explorer';
import { useConfidentialAccount } from '../hooks/use-confidential-account';
import { useConfidentialSend, type ConfidentialSendStatus } from '../hooks/use-confidential-send';
import { resolveAta } from '../lib/operations';

interface ConfidentialSendFormProps {
    mint: Address;
    symbol?: string;
}

const shorten = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

/** The button's label for an in-flight send — one line, always saying what the user is waiting on. */
function runningLabel(status: Extract<ConfidentialSendStatus, { kind: 'running' }>): string {
    const progress =
        status.progress && status.progress.total > 1 ? ` ${status.progress.current}/${status.progress.total}` : '';
    switch (status.stage) {
        case 'checking-recipient':
            return 'Checking recipient…';
        case 'unlocking':
            return 'Unlock your private balance in your wallet…';
        case 'preparing':
            return status.awaitingWallet ? 'Approve in your wallet (1 of 2)…' : `Preparing private balance${progress}…`;
        case 'waiting-for-preparation':
            return 'Waiting for confirmation…';
        case 'sending':
            return status.awaitingWallet ? 'Approve the transfer in your wallet…' : `Sending privately${progress}…`;
        case 'enabling':
            return status.awaitingWallet ? 'Approve in your wallet…' : `Enabling private receiving${progress}…`;
    }
}

/** What an unready recipient has to do, and what the sender can do meanwhile. */
function RecipientNotReady({
    recipient,
    reason,
    symbol,
}: {
    recipient: Address;
    reason: ConfidentialRecipientNotReadyReason;
    symbol?: string;
}) {
    const [copied, setCopied] = useState(false);
    const token = symbol ?? 'this token';

    const headline: Record<ConfidentialRecipientNotReadyReason, string> = {
        'no-account': `${shorten(recipient)} has not enabled private receiving for ${token} yet.`,
        'not-configured': `${shorten(recipient)} has not enabled private receiving for ${token} yet.`,
        'not-approved': `${shorten(recipient)}'s private account is waiting for approval by the mint's confidential authority.`,
        'credits-disabled': `${shorten(recipient)} has turned off incoming private transfers.`,
    };

    const copyLink = async () => {
        try {
            await navigator.clipboard.writeText(window.location.href);
            setCopied(true);
            setTimeout(() => setCopied(false), 2_000);
        } catch {
            /* clipboard unavailable — the instruction text still applies */
        }
    };

    return (
        <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
            <div className="flex items-start gap-2">
                <UserX className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p className="font-medium">{headline[reason]} Nothing was sent.</p>
            </div>
            <ul className="list-disc space-y-1.5 pl-6 text-muted-foreground">
                {(reason === 'no-account' || reason === 'not-configured') && (
                    <li>
                        Send them this page. They connect their wallet and press{' '}
                        <span className="font-medium text-foreground">Enable private receiving</span> — one click.{' '}
                        <button type="button" onClick={copyLink} className="font-medium text-primary hover:underline">
                            {copied ? 'Link copied' : 'Copy link'}
                        </button>
                    </li>
                )}
                {reason === 'not-approved' && (
                    <li>
                        The mint&apos;s confidential authority can approve the account on the advanced page (step 2,
                        &ldquo;Approve account&rdquo;).
                    </li>
                )}
                {reason === 'credits-disabled' && (
                    <li>
                        They can turn incoming private transfers back on from the advanced page (step 3, &ldquo;Enable
                        confidential credits&rdquo;).
                    </li>
                )}
                <li>
                    Or send a regular transfer from the token page instead — it arrives right away, but the amount is
                    visible on chain.
                </li>
            </ul>
        </div>
    );
}

/**
 * The one-button confidential send: recipient wallet, amount, "Send privately".
 * Configure / deposit / apply happen behind the button as needed; see
 * `useConfidentialSend`.
 */
export function ConfidentialSendForm({ mint, symbol }: ConfidentialSendFormProps) {
    const { cluster } = useConnector();
    const clusterName = getClusterName(cluster);
    const { validateSolanaAddress, validateAmount } = useInputValidation();
    const { status, send, enableReceiving, reset, rpc, owner } = useConfidentialSend({ mint });
    const tokenBalance = useTokenBalance(mint);

    // The connected wallet's own confidential account, read without keys, for
    // the "Enable private receiving" card.
    const [ownTokenAccount, setOwnTokenAccount] = useState<Address | undefined>();
    useEffect(() => {
        let active = true;
        if (owner) void resolveAta(owner, mint).then(ata => active && setOwnTokenAccount(ata));
        return () => {
            active = false;
        };
    }, [owner, mint]);
    const ownAccount = useConfidentialAccount({ tokenAccount: ownTokenAccount, rpc });

    const [recipient, setRecipient] = useState('');
    const [amount, setAmount] = useState('');

    const isRunning = status.kind === 'running';
    const inputsValid = validateSolanaAddress(recipient) && validateAmount(amount);

    // Refresh both balance views after anything lands — once per success. The
    // refetchers change identity as the reads they start resolve, so without
    // the guard each refresh would schedule the next one.
    const { refetch: refetchPublic } = tokenBalance;
    const { refresh: refreshOwn } = ownAccount;
    const handledStatus = useRef<ConfidentialSendStatus | null>(null);
    useEffect(() => {
        if (status.kind !== 'success' || handledStatus.current === status) return;
        handledStatus.current = status;
        refetchPublic();
        refreshOwn();
        if (status.action === 'send') {
            setRecipient('');
            setAmount('');
        }
    }, [status, refetchPublic, refreshOwn]);

    const transferSignature = useMemo(
        () => (status.kind === 'success' ? status.signatures[status.signatures.length - 1] : undefined),
        [status],
    );

    return (
        <div className="space-y-6">
            <Card className="rounded-2xl">
                <CardHeader className="flex flex-row items-start gap-3 space-y-0">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                        <Lock className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                        <h3 className="font-semibold">Send privately</h3>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                            The amount is encrypted on chain — only you, the recipient and the mint&apos;s auditor (if
                            any) can see it. Your public balance is moved into your private balance as needed.
                        </p>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    <SolanaAddressInput
                        label="Recipient wallet address"
                        value={recipient}
                        onChange={value => {
                            setRecipient(value);
                            if (status.kind !== 'running' && status.kind !== 'idle') reset();
                        }}
                        placeholder="Enter recipient Solana address..."
                        disabled={isRunning}
                        required
                    />
                    <AmountInput
                        label="Amount"
                        value={amount}
                        onChange={value => {
                            setAmount(value);
                            if (status.kind !== 'running' && status.kind !== 'idle') reset();
                        }}
                        disabled={isRunning}
                        balance={tokenBalance.balance?.formattedBalance}
                        balanceLoading={tokenBalance.isLoading}
                        balanceSymbol={symbol}
                        helpText="Spent from your private balance first, then your public balance."
                        required
                    />

                    <Button
                        onClick={() => void send(recipient as Address, amount)}
                        disabled={isRunning || !inputsValid}
                        className="w-full"
                    >
                        {status.kind === 'running' ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                {runningLabel(status)}
                            </>
                        ) : (
                            'Send privately'
                        )}
                    </Button>

                    {status.kind === 'recipient-not-ready' && (
                        <RecipientNotReady recipient={status.recipient} reason={status.reason} symbol={symbol} />
                    )}

                    {status.kind === 'error' && status.message && (
                        <p className="break-words text-sm text-destructive">{status.message}</p>
                    )}

                    {status.kind === 'success' && status.action === 'send' && transferSignature && (
                        <div className="space-y-2 rounded-xl border border-green-500/30 bg-green-500/5 p-3">
                            <p className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-400">
                                <CheckCircle2 className="h-4 w-4" />
                                Sent {status.amount} {symbol} privately to{' '}
                                {status.recipient && shorten(status.recipient)}
                            </p>
                            <a
                                href={buildExplorerUrl(transferSignature, clusterName)}
                                target="_blank"
                                rel="noreferrer"
                                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                            >
                                View transfer <ExternalLink className="h-3 w-3" />
                            </a>
                            {status.signatures.length > 1 && (
                                <details className="text-xs text-muted-foreground">
                                    <summary className="cursor-pointer">
                                        All {status.signatures.length} transactions
                                    </summary>
                                    <ol className="mt-1 space-y-0.5 pl-4">
                                        {status.signatures.map(sig => (
                                            <li key={sig}>
                                                <a
                                                    href={buildExplorerUrl(sig, clusterName)}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="font-mono hover:text-primary"
                                                >
                                                    {sig.slice(0, 8)}…{sig.slice(-8)}
                                                </a>
                                            </li>
                                        ))}
                                    </ol>
                                </details>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* The receiving side's one click. Shown only while this wallet cannot receive yet. */}
            {ownTokenAccount && !ownAccount.isLoading && !ownAccount.isConfigured && (
                <Card className="rounded-2xl">
                    <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-start gap-3">
                            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary/60" />
                            <div>
                                <p className="text-sm font-medium">Receive privately</p>
                                <p className="text-sm text-muted-foreground">
                                    Others can only send you {symbol ?? 'this token'} privately once you enable it.
                                </p>
                            </div>
                        </div>
                        <Button variant="outline" onClick={() => void enableReceiving()} disabled={isRunning}>
                            Enable private receiving
                        </Button>
                    </CardContent>
                </Card>
            )}
            {status.kind === 'success' && status.action === 'enable' && (
                <p className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                    <CheckCircle2 className="h-4 w-4" /> Private receiving is enabled for this wallet.
                </p>
            )}

            <p className="text-xs text-muted-foreground">
                Need to deposit, withdraw or inspect balances step by step?{' '}
                <Link href={`/confidential/${mint}`} className="text-primary hover:underline">
                    Open the advanced view
                </Link>
                .
            </p>
        </div>
    );
}
