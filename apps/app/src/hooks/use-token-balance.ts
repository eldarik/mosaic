'use client';

import { useCallback, useEffect } from 'react';
import { useConnector } from '@solana/connector/react';
import { useTokenAccountStore, useTokenAccountState } from '@/stores/token-account-store';

interface TokenBalanceResult {
    /** Raw balance in smallest unit (bigint) */
    rawBalance: bigint;
    /** Formatted balance as string with decimals */
    formattedBalance: string;
    /** Number of decimals for the token */
    decimals: number;
    /** UI amount as number */
    uiAmount: number;
}

interface UseTokenBalanceReturn {
    balance: TokenBalanceResult | null;
    isLoading: boolean;
    error: string | null;
    refetch: () => void;
    /** Whether a token account exists for this mint */
    hasTokenAccount: boolean;
}

/**
 * Hook to fetch the token balance for the connected wallet
 * Uses centralized token account store for state management
 */
export function useTokenBalance(mintAddress: string | undefined): UseTokenBalanceReturn {
    const { selectedAccount, cluster } = useConnector();
    const walletAddress = selectedAccount ? String(selectedAccount) : undefined;
    const rpcUrl = cluster?.url;

    // Get state from store
    const accountState = useTokenAccountState(walletAddress, mintAddress);
    const { fetchTokenAccount, refetchTokenAccount } = useTokenAccountStore();

    // Fetch on mount and when dependencies change
    useEffect(() => {
        if (!walletAddress || !mintAddress || !rpcUrl) return;

        // Only fetch if we haven't fetched yet
        if (accountState.lastFetched === null) {
            fetchTokenAccount(walletAddress, mintAddress, rpcUrl);
        }
    }, [walletAddress, mintAddress, rpcUrl, accountState.lastFetched, fetchTokenAccount]);

    // Stable identity: callers list it in effect deps, and a fresh function per
    // render would re-run those effects on every store update the fetch causes.
    const refetch = useCallback(() => {
        if (walletAddress && mintAddress && rpcUrl) {
            refetchTokenAccount(walletAddress, mintAddress, rpcUrl);
        }
    }, [walletAddress, mintAddress, rpcUrl, refetchTokenAccount]);

    return {
        balance: accountState.balance,
        isLoading: accountState.isLoading,
        error: accountState.error,
        refetch,
        hasTokenAccount: accountState.hasTokenAccount,
    };
}
