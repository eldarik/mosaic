'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronLeft, Lock } from 'lucide-react';
import type { Address } from '@solana/kit';
import { useConnector } from '@solana/connector/react';
import { Button } from '@/components/ui/button';
import { useTokenStore } from '@/stores/token-store';
import { ConfidentialKeysProvider } from '@/features/confidential/hooks/use-confidential-keys';
import { ConfidentialSendForm } from '@/features/confidential/components/confidential-send-form';
import { WalletSupportNotice } from '@/features/confidential/components/wallet-support-notice';

export default function ConfidentialSendPage() {
    const { connected, selectedAccount } = useConnector();
    const params = useParams();
    const address = params.address as string;

    if (!connected || !selectedAccount) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center p-8">
                <div className="text-center">
                    <h2 className="text-3xl font-bold mb-4">Wallet Required</h2>
                    <p className="mb-6">Please connect your Solana wallet to send privately.</p>
                </div>
            </div>
        );
    }

    return <ConfidentialSendConnected address={address} />;
}

function ConfidentialSendConnected({ address }: { address: string }) {
    const findTokenByAddress = useTokenStore(state => state.findTokenByAddress);
    const token = findTokenByAddress(address);

    return (
        <div className="flex-1 p-8">
            <div className="max-w-xl mx-auto space-y-8">
                {/* Header */}
                <div className="flex items-center space-x-4">
                    <Link className="p-0" href={`/manage/${address}`}>
                        <Button variant="ghost" size="icon" className="w-6 h-10 group">
                            <ChevronLeft className="h-5 w-5 group-hover:-translate-x-1 transition-transform duration-200 ease-in-out" />
                        </Button>
                    </Link>
                    <div className="h-12 w-12 rounded-full bg-primary/5 flex items-center justify-center border border-primary/10">
                        <Lock className="h-5 w-5 text-primary/60" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold">Send Privately</h1>
                        <p className="text-md text-muted-foreground -mt-1">{token?.symbol ?? address}</p>
                    </div>
                </div>

                <ConfidentialKeysProvider>
                    <WalletSupportNotice />
                    <ConfidentialSendForm mint={address as Address} symbol={token?.symbol} />
                </ConfidentialKeysProvider>
            </div>
        </div>
    );
}
