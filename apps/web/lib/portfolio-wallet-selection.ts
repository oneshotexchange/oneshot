const address = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);

/** One public wallet selection is shared by token and NFT inspection; an invalid URL never falls back silently. */
export function portfolioWalletSelection(search: string, connectedWallet?: string | null) {
  const params = new URLSearchParams(search), selected = params.get('wallet');
  if (selected !== null && (params.getAll('wallet').length !== 1 || !address(selected))) return { wallet: null, selected: null, error: 'Enter one complete, nonzero Ethereum wallet address to view this portfolio.' };
  const wallet = selected !== null ? selected.toLowerCase() : address(connectedWallet) ? connectedWallet.toLowerCase() : null;
  return { wallet, selected: selected?.toLowerCase() || null, error: null };
}
