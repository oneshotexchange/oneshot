"use client";

import { Check, Copy, Link2, LogOut, Wallet } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useWallet } from '../lib/client-wallet';
import { shortAddress } from '../lib/client-api';
import { Button, Modal } from './ui';
import { useToast } from './providers';

export function WalletButton({ full = false }: { full?: boolean }) {
  const wallet = useWallet(); const { account, connected, network, configured, authenticated, connect, disconnect, isLoading } = wallet;
  const [open, setOpen] = useState(false); const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const close = useCallback(() => setOpen(false), []); const toast = useToast();
  const showError = (message: string) => toast({ kind: 'error', message });
  async function openPrivy(action: () => Promise<void>, failureMessage = 'Wallet connection did not open. Try connecting again.') { close(); try { await action(); } catch { showError(failureMessage); } }
  const label = connected ? shortAddress(account?.address) : authenticated ? 'Add a wallet' : configured ? 'Connect wallet' : 'Wallet unavailable';
  return <><Button variant={connected ? 'secondary' : 'primary'} className={full ? 'full-width' : 'wallet-button'} loading={isLoading} onClick={() => {
    if (!configured || wallet.unavailableReason || authenticated) setOpen(true);
    else void openPrivy(connect);
  }}><Wallet size={16} />{label}</Button>
    {open && <Modal title={wallet.unavailableReason ? 'Wallet unavailable' : connected ? 'Your wallet' : 'Your account'} description={wallet.unavailableReason ? 'Try connecting again later.' : undefined} onClose={close}>
      {wallet.unavailableReason ? <p className="wallet-empty">You can keep browsing without a wallet.</p> : <div className="wallet-details">
        {connected && account ? <><div className="wallet-address">{account.address}</div><div className="wallet-network">{network?.name || 'Wallet network unavailable'}</div>{wallet.wallets.length > 1 && <label className="field"><span className="field-label">Selected wallet</span><select className="input-control" value={account.address} onChange={event => { try { wallet.selectWallet(event.target.value); } catch { showError('Choose a connected wallet linked to this account and try again.'); } }}>{wallet.wallets.map(option => <option value={option.address} key={option.address}>{option.label} ({shortAddress(option.address)})</option>)}</select></label>}<Button variant="secondary" className="full-width" onClick={async () => { const address = account.address; try { await navigator.clipboard.writeText(address); setCopiedAddress(address); } catch { toast({ kind: 'error', message: 'Could not copy the address. Select the address above to copy it manually.' }); } }}>{copiedAddress === account.address ? <Check size={16} /> : <Copy size={16} />}{copiedAddress === account.address ? 'Copied' : 'Copy address'}</Button></> : <><p className="wallet-empty">{authenticated ? 'You’re signed in. Connect a linked Ethereum wallet, or link a new one.' : 'Use a wallet or email to sign in.'}</p><Button className="full-width" loading={isLoading} onClick={() => void openPrivy(connect)}><Wallet size={16} />{authenticated ? 'Connect a wallet' : 'Sign in'}</Button></>}
        {authenticated && <><Button variant="secondary" className="full-width" onClick={() => void openPrivy(wallet.linkWallet, 'Could not link a wallet. Try linking it again from your account.')}><Link2 size={16} />Link another wallet</Button><Button variant="ghost" className="full-width" onClick={async () => { try { await disconnect(); close(); } catch { showError('Sign-out could not be completed. Try signing out again.'); } }}><LogOut size={16} />Sign out</Button></>}
      </div>}
      <p className="wallet-footnote">Connecting a wallet does not send a transaction. Review each transaction before signing.</p>
    </Modal>}
  </>;
}
