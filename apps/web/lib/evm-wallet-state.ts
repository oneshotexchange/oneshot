export type EvmIdentity = {
  connected: boolean;
  account: { address: `0x${string}` } | null;
  network: { chainId: number; name: string } | null;
};

export function parseEvmIdentity(accounts: unknown, chainId: unknown): EvmIdentity {
  if (!Array.isArray(accounts) || accounts.length === 0) return { connected: false, account: null, network: null };
  if (typeof accounts[0] !== 'string' || !/^0x[\da-fA-F]{40}$/.test(accounts[0])) throw new Error('The wallet returned an invalid EVM address.');
  if (typeof chainId !== 'string' || !/^0x[\da-fA-F]+$/.test(chainId)) throw new Error('The wallet returned an invalid EVM chain ID.');
  const id = Number(BigInt(chainId));
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('The wallet chain ID is unsupported.');
  return { connected: true, account: { address: accounts[0].toLowerCase() as `0x${string}` }, network: { chainId: id, name: id === 31337 ? 'Local Anvil (not Zero)' : `Chain ${id} · unverified` } };
}
