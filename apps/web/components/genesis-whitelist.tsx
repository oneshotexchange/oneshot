import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowRight, ArrowUpRight, Check, CheckCircle2, Copy, Loader2, RefreshCw, Users } from 'lucide-react';
import Link from './navigation';
import { ThemePicker } from './theme-picker';
import { Button, ErrorState } from './ui';
import { useGenesisAuth } from './genesis-auth';
import { apiUrl } from '../lib/api-url';
import { clearGenesisReferral, genesisAccountRequest, loadGenesisCampaign, readGenesisReferral } from '../lib/client-genesis-api';
import { GENESIS_CONSENT_VERSION, genesisAllVerified, genesisDisplayStatus, type GenesisMe, type GenesisPublicCampaign, type GenesisTask } from '../lib/genesis-schema';
import '../app/genesis.css';

function sessionStorageIfAvailable() { try { return window.sessionStorage; } catch { return undefined; } }
export function GenesisMark() { return <span className="brand-symbol" aria-hidden="true"><i /><i /><i /></span>; }
export function GenesisPrint() {
  return <div className="genesis-print" aria-label="oneshot Genesis first edition campaign poster" role="img">
    <div className="genesis-print-top"><span>oneshot</span><span>First edition / 01</span></div>
    <div className="genesis-print-art" aria-hidden="true"><svg viewBox="0 0 400 400" fill="none"><g stroke="currentColor" strokeWidth="1">{Array.from({length: 12}, (_, i) => <rect key={i} x={38+i*9} y={38+i*9} width={324-i*18} height={324-i*18} rx={3} transform={`rotate(${i*3} 200 200)`} />)}</g><path d="M123 143H279V171H123ZM151 187H279V215H151ZM181 231H279V259H181Z" fill="currentColor" /></svg></div>
    <div className="genesis-print-bottom"><span>A place<br />to begin.</span><span className="genesis-print-edition">Genesis<br /><strong>750</strong></span></div>
  </div>;
}

export function GenesisWhitelist() {
  const [, setSearchParams] = useSearchParams();
  useEffect(() => { const previous = document.title; document.title = 'oneshot Genesis | Whitelist'; return () => { document.title = previous; }; }, []);
  const wallet = useGenesisAuth(); const walletRef = useRef(wallet); walletRef.current = wallet;
  const identity = wallet.authenticated && wallet.userId ? `${wallet.userId}:${wallet.xAccount?.id || ''}:${wallet.sessionId}` : null;
  const currentScope = useRef(identity); currentScope.current = identity;
  const [campaign, setCampaign] = useState<GenesisPublicCampaign | null>(null);
  const [campaignError, setCampaignError] = useState<string | null>(null); const [campaignLoading, setCampaignLoading] = useState(true);
  const [account, setAccount] = useState<{ scope: string; data: GenesisMe } | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null); const [accountLoading, setAccountLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); const [consent, setConsent] = useState(false);
  const [postUrl, setPostUrl] = useState(''); const [sharePostUrl, setSharePostUrl] = useState('');
  const [referral, setReferral] = useState(() => readGenesisReferral(window.location.search, sessionStorageIfAvailable()));
  const [notice, setNotice] = useState('');
  const [nominee, setNominee] = useState(''); const [nominationConfirmed,setNominationConfirmed] = useState(false);
  const me = account?.scope === identity ? account.data : null; const app = me?.application || null;
  const requests = useRef(0);
  const loadCampaign = useCallback(async () => {
    setCampaignLoading(true); setCampaignError(null);
    try { setCampaign(await loadGenesisCampaign()); } catch (error) { setCampaignError((error as Error).message); } finally { setCampaignLoading(false); }
  }, []);
  useEffect(() => { void loadCampaign(); }, [loadCampaign]);
  const refreshAccount = useCallback(async (signal?: AbortSignal) => {
    const scope = currentScope.current; if (!scope) return;
    const request = ++requests.current; setAccountLoading(true); setAccountError(null);
    try {
      const data = await genesisAccountRequest('me', { getToken: () => walletRef.current.getAccessToken(), sessionId: walletRef.current.sessionId, scope: () => currentScope.current, signal });
      if (currentScope.current === scope && requests.current === request) setAccount({ scope, data });
    } catch (error) { if (!signal?.aborted && currentScope.current === scope && requests.current === request) setAccountError((error as Error).message); }
    finally { if (currentScope.current === scope && requests.current === request) setAccountLoading(false); }
  }, []);
  useEffect(() => { setAccount(null); setAccountError(null); setPostUrl(''); setSharePostUrl(''); setBusy(null); setNotice(''); setConsent(false); requests.current++; const controller = new AbortController(); if (identity) void refreshAccount(controller.signal); else setAccountLoading(false); return () => controller.abort(); }, [identity, refreshAccount]);
  const pending = app && Object.values(app.checks).some(check => check?.state === 'pending');
  useEffect(() => { if (!pending) return; const timer = window.setInterval(() => void refreshAccount(), 8000); return () => window.clearInterval(timer); }, [pending, refreshAccount]);
  function removeInvitation() {
    clearGenesisReferral(sessionStorageIfAvailable()); setReferral(null);
    setSearchParams(params => { params.delete('ref'); return params; }, { replace: true });
  }
  async function action(name: string, path: string, body: unknown) {
    const scope = currentScope.current; if (!scope || busy) return;
    setBusy(name); setAccountError(null); setNotice('');
    try {
      const data = await genesisAccountRequest(path, { body, getToken: () => walletRef.current.getAccessToken(), sessionId: walletRef.current.sessionId, scope: () => currentScope.current });
      if (scope === currentScope.current) { setAccount({ scope, data }); if (path === 'enroll') clearGenesisReferral(sessionStorageIfAvailable()); if (path === 'submit') setNotice('Your application has been received. You can return here to check its status.'); }
    } catch (error) { if (scope === currentScope.current) setAccountError((error as Error).message); }
    finally { if (scope === currentScope.current) setBusy(null); }
  }
  async function connectX() {
    setBusy('connect'); setAccountError(null);
    try { await wallet.connectX(); } catch { setAccountError('X sign-in could not open. Try again, or return here a little later.'); }
    finally { setBusy(null); }
  }
  async function copy(text: string, message = 'Invitation link copied.') { try { await navigator.clipboard.writeText(text); setNotice(message); } catch { setNotice('Select the invitation link below and copy it manually.'); } }
  const open = campaign?.state === 'open';
  const taskCount = (me?.profile ? 1 : 0) + Object.values(app?.checks || {}).filter(check => check?.state === 'verified').length;
  const canSubmit = app && !app.submittedAt && (['follow','post','share'] as const).every(task => app.checks[task] && app.checks[task]?.state !== 'needs_action');
  const postIntent = `https://x.com/intent/post?text=${encodeURIComponent(`I'm applying for the oneshot Genesis whitelist.${campaign?.projectHandle ? ` @${campaign.projectHandle}` : ''}\n${me?.shareUrl || ''}`)}`;
  return <div className="genesis-page">
    <a className="skip-link" href="#genesis-application">Skip to application</a>
    <header className="genesis-header"><Link href="/" className="brand" aria-label="oneshot home"><GenesisMark /><span>oneshot</span></Link><nav aria-label="Genesis navigation"><a href="#genesis-details">The details</a><Link href="/">Back to app <ArrowUpRight size={14}/></Link><ThemePicker />{wallet.authenticated && <button className="genesis-signout" onClick={() => { void wallet.disconnect().catch(() => setAccountError('Could not sign out. Please try again.')); }}>Sign out</button>}</nav></header>
    <main>
      <section className="genesis-hero"><div className="genesis-hero-copy"><div className="genesis-edition-label">The first edition</div><h1>oneshot<br /><em>Genesis.</em></h1><p>A first edition for the people who show up early. Apply for one of <strong>750 free-mint places</strong>.</p><div className="genesis-hero-actions"><a className="button button-primary" href="#genesis-application">{app?.submittedAt ? 'View my application' : 'Explore the whitelist'} <ArrowDown size={16}/></a><span>{campaignLoading ? 'Checking applications…' : campaignError ? 'Status unavailable' : campaign?.state === 'open' ? 'Applications open' : campaign?.state === 'closed' ? 'Applications closed' : 'Applications open soon'}</span></div><div className="genesis-hero-footnote">No wallet or transaction needed to apply.</div></div><GenesisPrint /></section>
      <section id="genesis-details" className="genesis-details" aria-label="How the whitelist works"><div><span>01 / Apply</span><h2>Bring your perspective.</h2><p>Connect X, share what interests you about oneshot, and send your application.</p></div><div><span>02 / Selection</span><h2>750 people. A place each.</h2><p>Applications are reviewed. Additional eligible applicants join the reserve list.</p></div><div><span>03 / Mint</span><h2>Your wallet comes later.</h2><p>Selected accounts choose their mint wallet before the claim window. Network fees may apply.</p></div></section>
      <section className="genesis-application-layout" id="genesis-application"><aside className="genesis-application-intro"><span className="genesis-edition-label">Your place starts here</span><h2>{app?.submittedAt ? 'You’re on the journey.' : 'Make your introduction.'}</h2><p>One X account. One application. Your progress stays with your X account.</p><dl><div><dt>Allocation</dt><dd>750 guaranteed recipients</dd></div><div><dt>Selection</dt><dd>Reviewed applications</dd></div><div><dt>Mint price</dt><dd>Free for selected recipients</dd></div>{campaign?.closesAt && <div><dt>Applications close</dt><dd>{new Date(campaign.closesAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</dd></div>}</dl><a href="#genesis-questions" className="genesis-text-link">A few things to know <ArrowRight size={16}/></a></aside>
        <div className="genesis-application-panel">
          <div className="genesis-panel-heading"><div><h2>{app?.submittedAt ? 'Your application' : 'Apply for Genesis'}</h2><p>{app ? `Connected as @${app.profile.username}` : 'Start with your X account.'}</p></div><span className="genesis-progress">{taskCount}<span>/ 4 complete</span></span></div>
          <div className="genesis-progress-track" aria-label={`${taskCount} of 4 steps complete`}><span style={{ width: `${taskCount * 25}%` }}/></div>
          {campaignError && <ErrorState message="Application availability could not be checked." retry={() => void loadCampaign()}/>}
          {wallet.error && <ErrorState message={wallet.error} retry={() => void wallet.refresh()}/>}
          {new URLSearchParams(window.location.search).get('x_login') === 'failed' && <ErrorState message="X sign-in could not finish. Please connect X again."/>}
          {accountError && <ErrorState message={accountError} retry={wallet.authenticated ? () => void wallet.refresh().then(() => refreshAccount()) : undefined}/>}
          {notice && <p className="genesis-notice" role="status">{notice}</p>}
          {me?.nomination && !me.nomination.accepted && <div className="genesis-availability"><h3>@{me.nomination.from} nominated you.</h3><p>Complete and submit your application, then accept the nomination while applications and nominations are open.</p>{app?.status === 'under_review' && <Button disabled={!me.nominationsOpen || Boolean(busy)} onClick={() => void action('accept','nominations/accept',{id:me.nomination!.id})}>Accept nomination <Check size={15}/></Button>}</div>}
          {!campaignLoading && campaign && !open && <div className="genesis-availability"><h3>{campaign.state === 'closed' ? 'Applications have closed.' : 'The first edition is on its way.'}</h3><p>{campaign.state === 'closed' ? 'Already applied? Sign in with the same X account to check your application.' : 'Return here for the application window and collection details.'}</p><Button variant="ghost" onClick={() => void loadCampaign()}><RefreshCw size={14}/>Check availability</Button></div>}
          {accountLoading && !me && <p className="genesis-loading" role="status"><Loader2 size={16} className="spin"/>Loading your application…</p>}
          <TaskRow number="01" title="Connect your X" done={Boolean(me?.profile)} description={me?.profile ? `@${me.profile.username} is connected to your Genesis application.` : 'Use the account you want to apply with. No posting permission needed.'}>
            {!me?.profile && <Button onClick={() => void connectX()} disabled={!wallet.configured || wallet.isLoading || Boolean(busy)} loading={busy === 'connect'}>Connect X <ArrowUpRight size={15}/></Button>}
            {!wallet.configured && <p className="genesis-helper">X sign-in is temporarily unavailable. Please return a little later.</p>}
          </TaskRow>
          {me?.profile && !app && !accountLoading && <div className="genesis-enroll"><label><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)}/><span>I agree to link my public X identity and submitted post evidence to my oneshot application for verification and review.</span></label>{referral && <div className="genesis-referral-applied">An invitation is attached. <button onClick={removeInvitation}>Remove invitation</button></div>}<Button onClick={() => void action('enroll','enroll',{ consentVersion: GENESIS_CONSENT_VERSION, ...(referral ? { referral } : {}) })} disabled={!consent || !open || Boolean(busy)} loading={busy === 'enroll'}>Start my application <ArrowRight size={15}/></Button></div>}
          <TaskRow number="02" title="Follow oneshot" done={app?.checks.follow?.state === 'verified'} description="Keep up with selection rounds and mint announcements." check={app?.checks.follow}>
            {app && !app.submittedAt && <div className="genesis-task-actions">{campaign?.projectHandle && <a className="button button-secondary" href={`https://x.com/${campaign.projectHandle}`} target="_blank" rel="noreferrer">Open X <ArrowUpRight size={14}/></a>}<Button variant="ghost" loading={busy === 'follow'} disabled={!open || Boolean(busy)} onClick={() => void action('follow','verify',{task:'follow'})}>Check follow</Button></div>}
          </TaskRow>
          <TaskRow number="03" title="Share your perspective" done={app?.checks.post?.state === 'verified'} description={`Write an original post about oneshot${campaign?.projectHandle ? ` and mention @${campaign.projectHandle}` : ''}. Tell us what caught your attention.`} check={app?.checks.post}>
            {app && !app.submittedAt && <div className="genesis-post-field"><a className="genesis-text-link" href={postIntent} target="_blank" rel="noreferrer">Write on X <ArrowUpRight size={14}/></a><label htmlFor="genesis-post">Your public post link</label><div><input id="genesis-post" type="url" placeholder="https://x.com/you/status/…" value={postUrl} onChange={event => setPostUrl(event.target.value)} maxLength={512}/><Button variant="secondary" disabled={!postUrl || !open || Boolean(busy)} loading={busy === 'post'} onClick={() => void action('post','verify',{ task:'post',postUrl })}>Check post</Button></div></div>}
          </TaskRow>
          <TaskRow number="04" title="Invite your community" done={app?.checks.share?.state === 'verified'} description="Include your personal invitation in your post. The same post can complete both steps." check={app?.checks.share}>
            {me?.shareUrl && <div className="genesis-invitation"><label htmlFor="genesis-invitation">Your invitation link</label><div><input id="genesis-invitation" value={me.shareUrl} readOnly onFocus={event => event.target.select()}/><Button variant="ghost" aria-label="Copy invitation link" onClick={() => void copy(me.shareUrl!)}><Copy size={16}/></Button></div></div>}
            {app && !app.submittedAt && <div className="genesis-post-field"><label htmlFor="genesis-share-post">Post containing your invitation</label><div><input id="genesis-share-post" type="url" placeholder="Paste the same post, or another one" value={sharePostUrl} onChange={event => setSharePostUrl(event.target.value)} maxLength={512}/><Button variant="secondary" disabled={!(sharePostUrl || postUrl) || !open || Boolean(busy)} loading={busy === 'share'} onClick={() => void action('share','verify',{ task:'share',postUrl:sharePostUrl || postUrl })}>Check invitation</Button></div><p className="genesis-helper">Invitations count after a distinct person submits a verified application. No minimum number is needed to apply.</p></div>}
          </TaskRow>
          {app && <div className="genesis-submit">{app.submittedAt ? <ApplicationStatus me={me!} onRefresh={() => void refreshAccount()}/> : <><Button className="full-width" disabled={!canSubmit || !open || Boolean(busy)} loading={busy === 'submit'} onClick={() => void action('submit','submit',{expectedRevision:app.revision})}>Submit application <ArrowRight size={16}/></Button><p>{genesisAllVerified(app) ? 'Your checks are complete. Send your application for review.' : canSubmit ? 'You can submit while checks are pending. Your submission time will be saved.' : 'Complete the four steps to send your application.'}</p></>}</div>}
          {app?.submittedAt && (['follow','post','share'] as const).filter(task => ['temporarily_unavailable','needs_action'].includes(app.checks[task]?.state || '')).map(task => <div key={task} className="genesis-recovery"><p>{app.checks[task]?.message}</p><Button variant="secondary" disabled={Boolean(busy)} onClick={() => void action(task,'verify',{ task, ...(app.checks[task]?.postId ? {postUrl:`https://x.com/i/web/status/${app.checks[task]?.postId}`} : {}) })}>Retry {task} check</Button><p className="genesis-helper">If the post needs a correction, use a new public post link while applications are open.</p>{task !== 'follow' && open && <div className="genesis-post-field"><input aria-label={`Corrected ${task} post link`} value={task === 'post' ? postUrl : sharePostUrl} onChange={event => task === 'post' ? setPostUrl(event.target.value) : setSharePostUrl(event.target.value)} placeholder="https://x.com/you/status/…"/><Button disabled={Boolean(busy) || !(task === 'post' ? postUrl : sharePostUrl)} onClick={() => void action(task,'verify',{ task,postUrl:task === 'post' ? postUrl : sharePostUrl })}>Check corrected post</Button></div>}</div>)}
          <p className="genesis-panel-footnote">Applying does not guarantee selection. The free mint has no mint price; network fees may apply. Collection and claim details will be announced here.</p>
        </div>
      </section>
      {app?.submittedAt && <section className="genesis-after-application"><div><Users size={22}/><h2>Your invitation, your people.</h2><p><strong>{me?.qualifiedReferrals || 0}</strong> qualified invitations. Every person counts once, after their application checks pass.</p><p>Referrals support review. They do not automatically award a place.</p></div><div className="genesis-share-preview"><h2>A card worth sharing.</h2><p>Choose whether your X handle and profile picture appear on your public invitation. Your wallet stays private.</p><label><input type="checkbox" checked={app.shareConsent} disabled={Boolean(busy)} onChange={event => void action('card','share',{ enabled:event.target.checked,expectedRevision:app.revision })}/>Show my X profile on my invitation card</label>{me?.shareUrl && <><img alt="Your current oneshot Genesis invitation card" src={apiUrl(`/api/oneshot/genesis/share/${app.code}/image`) + `?v=${app.revision}`}/><div className="genesis-task-actions"><a className="button button-secondary" href={me.shareUrl} target="_blank" rel="noreferrer">Preview invitation <ArrowUpRight size={14}/></a><button className="button button-ghost" onClick={() => void copy(me.shareUrl!)}>Copy link <Copy size={14}/></button></div></>}</div></section>}
      {app?.publishedDecision === 'selected' && Boolean(app.nominationQuota) && <section className="genesis-nominations"><div><span className="genesis-edition-label">Pass a place forward</span><h2>Who would you bring?</h2><p>You have {Math.max(0,(app.nominationQuota || 0)-(app.nominations?.length || 0))} nominations left. Each accepted nomination uses a reserved place within the 750-person allocation.</p></div><div>{app.nominations?.map(n => <p key={n.id} className="genesis-nominee">@{n.username}<span>{n.accepted?'Accepted':'Awaiting acceptance'}</span></p>)}{!me?.nominationsOpen && <p className="genesis-helper">Nominations are not open right now.</p>}{(app.nominations?.length || 0) < (app.nominationQuota || 0) && <><label className="field"><span className="field-label">Their X handle</span><input value={nominee} onChange={event => {setNominee(event.target.value.replace(/^@/,''));setNominationConfirmed(false);}} placeholder="username" maxLength={15}/></label><label className="genesis-helper"><input type="checkbox" checked={nominationConfirmed} onChange={event => setNominationConfirmed(event.target.checked)}/> I have checked this handle. A submitted nomination cannot be changed.</label><Button className="section-gap" disabled={!me?.nominationsOpen || !/^[A-Za-z0-9_]{1,15}$/.test(nominee) || !nominationConfirmed || Boolean(busy)} loading={busy==='nominate'} onClick={() => void action('nominate','nominations',{username:nominee})}>Nominate @{nominee || 'someone'} <ArrowRight size={15}/></Button></>}</div></section>}
      <section id="genesis-questions" className="genesis-questions"><div><span className="genesis-edition-label">Before you apply</span><h2>A few things<br />to know.</h2></div><div><details><summary>Does applying guarantee an NFT?</summary><p>No. The team reviews applications and selects 750 guaranteed recipients. Additional eligible applicants can join the reserve list.</p></details><details><summary>Do I need a wallet now?</summary><p>No wallet or transaction is needed to apply. Selected accounts will choose their mint wallet before the claim window.</p></details><details><summary>What does a free mint cost?</summary><p>Selected recipients pay no mint price. Network fees may still apply. The network, claim window and transaction terms will be shown before minting.</p></details><details><summary>How do invitations count?</summary><p>A distinct person must join through your invitation and submit an application that passes its checks. Clicks and copied links do not count. You do not need a minimum number of invitations to apply.</p></details><details><summary>Can oneshot post from my X account?</summary><p>This application uses X to confirm your identity. You write and publish your own posts on X. Task checks read public account and post evidence.</p></details><details><summary>What information is saved?</summary><p>Your public X identity and profile are saved when you sign in. Submitted post evidence, verification results and referral attribution are saved with your application for review. Personal invitation cards are optional. You can sign out at the top of this page.</p><Link href="/settings" className="genesis-text-link">Account settings <ArrowRight size={14}/></Link></details></div></section>
    </main><footer className="genesis-footer"><Link href="/" className="brand"><GenesisMark/><span>oneshot</span></Link><span>The first edition starts with its people.</span><Link href="/settings">Account settings <ArrowUpRight size={14}/></Link></footer>
  </div>;
}
function TaskRow({ number,title,description,done,check,children }: { number:string;title:string;description:string;done?:boolean;check?:{state:string;message:string};children?:React.ReactNode }) {
  return <section className={`genesis-task ${done ? 'genesis-task-done' : ''}`}><span className="genesis-task-number">{done ? <Check size={17}/> : number}</span><div className="genesis-task-body"><h3>{title}{done && <span>Complete</span>}</h3><p>{description}</p>{check && <p className={`genesis-check genesis-check-${check.state}`} role="status">{check.state === 'pending' && <Loader2 size={12} className="spin"/>}{check.message}</p>}{children}</div></section>;
}
function ApplicationStatus({me,onRefresh}:{me:GenesisMe;onRefresh():void}) {
  const app = me.application!;
  return <div className={`genesis-status ${app.publishedDecision === 'selected' ? 'genesis-status-selected' : ''}`}><CheckCircle2 size={24}/><div><span>Your application</span><h3>{genesisDisplayStatus(app)}</h3><p>{app.publishedDecision === 'selected' ? 'A Genesis free-mint place is reserved for you. Return here for wallet selection and the claim window.' : app.publishedDecision === 'reserve' ? 'You are on the reserve list. A place has not been allocated to you.' : app.publishedDecision === 'not_selected' ? 'You were not selected in this round. Thank you for taking part.' : app.status === 'awaiting_verification' ? 'Your submission time is saved. Outstanding X checks will finish before review.' : 'Your application is with the team. Return here to see the published decision.'}</p><button className="genesis-text-link" onClick={onRefresh}>Refresh status <RefreshCw size={13}/></button></div></div>;
}
