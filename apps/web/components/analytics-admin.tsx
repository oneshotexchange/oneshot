import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { Activity, Eye, RefreshCw, Share2, ShieldCheck, Users, Wallet } from 'lucide-react';
import { apiUrl } from '../lib/api-url';
import { customerErrorDetails, customerFetch, customerResponseJson } from '../lib/customer-http';
import { Badge, Button, ErrorState } from './ui';
import '../app/analytics-admin.css';

const analyticsSummarySchema = z.object({
  generatedAt: z.string(),
  days: z.number(),
  traffic: z.object({
    uniqueVisitors: z.number(),
    returningVisitors: z.number(),
    totalPageViews: z.number(),
    todayUniqueVisitors: z.number(),
    todayPageViews: z.number(),
    last7dUniqueVisitors: z.number(),
    last7dPageViews: z.number(),
    topPages: z.array(
      z.object({
        path: z.string(),
        totalViews: z.number(),
        todayViews: z.number(),
      }),
    ),
  }),
  xAuth: z.object({
    uniqueConnectedXAccounts: z.number(),
    activeXSessions: z.number(),
    connectXStarted: z.number(),
    connectXSucceeded: z.number(),
    connectXFailed: z.number(),
    todayConnectXStarted: z.number(),
    todayConnectXSucceeded: z.number(),
    todayConnectXFailed: z.number(),
  }),
  eligibility: z.object({
    totalChecks: z.number(),
    todayChecks: z.number(),
    byTier: z.object({
      lzWinner: z.number(),
      lzUser5tx: z.number(),
      community: z.number(),
    }),
  }),
  airdropFunnel: z.object({
    totalParticipants: z.number(),
    boundWallets: z.number(),
    unlockedBoxes: z.number(),
    reservedSlots: z.number(),
    tiers: z.object({
      lzWinner: z.number(),
      lzUser5tx: z.number(),
      community: z.number(),
    }),
    missions: z.object({
      followVerified: z.number(),
      repostVerified: z.number(),
      postsVerifiedUsers: z.number(),
      totalVerifiedPosts: z.number(),
      totalEngagementScore: z.number(),
      createTokenVerified: z.number(),
      tradeTokenVerified: z.number(),
    }),
    referrals: z.object({
      totalInvited: z.number(),
      totalQualified: z.number(),
      activeReferrers: z.number(),
    }),
    snapshot: z.object({
      total: z.number(),
      winners: z.number(),
      fiveTx: z.number(),
    }),
    recentParticipants: z.array(
      z.object({
        username: z.string(),
        name: z.string(),
        avatarUrl: z.string().nullable(),
        tier: z.string(),
        walletBound: z.boolean(),
        followVerified: z.boolean(),
        repostVerified: z.boolean(),
        postsCount: z.number(),
        createdAt: z.string(),
      }),
    ),
  }),
  daily: z.array(
    z.object({
      day: z.string(),
      uniqueVisitors: z.number(),
      pageViews: z.number(),
      connectXStarted: z.number(),
      connectXSucceeded: z.number(),
      connectXFailed: z.number(),
      eligibilityChecks: z.number(),
      airdropEnrolled: z.number(),
      walletLinked: z.number(),
      missionsVerified: z.number(),
    }),
  ),
});

type AnalyticsSummary = z.infer<typeof analyticsSummarySchema>;

function pct(part: number, total: number): string {
  if (!total || total <= 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

function barWidth(part: number, total: number): string {
  if (!total || total <= 0 || part <= 0) return '0%';
  return `${Math.min(100, Math.round((part / total) * 100))}%`;
}

function tierLabel(tier: string): string {
  if (tier === 'lz_winner') return 'LZ Winner';
  if (tier === 'lz_user_5tx') return 'LZ 5+ Tx';
  return 'Community';
}

function SafeAvatar({ username, avatarUrl }: { username: string; avatarUrl: string | null }) {
  const [broken, setBroken] = useState(false);
  const allowed = Boolean(avatarUrl && avatarUrl.startsWith('https://pbs.twimg.com/') && !broken);
  if (allowed) {
    return (
      <img
        src={avatarUrl!}
        alt=""
        className="analytics-avatar"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }
  return <span className="analytics-avatar-fallback">{(username.slice(0, 2) || 'X').toUpperCase()}</span>;
}

export function AnalyticsAdmin({ token }: { token: string }) {
  const [days, setDays] = useState<7 | 14 | 30>(14);
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await customerFetch(apiUrl(`/api/admin/analytics?days=${days}`), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      });
      const body = await customerResponseJson(response);
      if (!response.ok) {
        throw new Error(customerErrorDetails(body).message || 'Could not load site analytics.');
      }
      setData(analyticsSummarySchema.parse(body));
    } catch (reason) {
      setError(
        reason instanceof z.ZodError
          ? 'Analytics response format could not be read. Try again.'
          : reason instanceof Error
            ? reason.message
            : 'Could not load site analytics.',
      );
    } finally {
      setBusy(false);
    }
  }, [days, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const participantsTotal = data?.airdropFunnel.totalParticipants ?? 0;

  return (
    <section className="genesis-admin analytics-admin">
      <div className="genesis-admin-heading">
        <div>
          <h2>Traffic &amp; Conversion Analytics</h2>
          <p className="genesis-helper">
            {data
              ? `Updated ${new Date(data.generatedAt).toLocaleString()} · Privacy-safe counts with live database totals`
              : 'Loading visitor traffic and X conversion metrics…'}
          </p>
        </div>
        <div className="analytics-admin-controls">
          <div className="analytics-range-group" role="group" aria-label="Trend window">
            {([7, 14, 30] as const).map(windowDays => (
              <button
                key={windowDays}
                type="button"
                className="analytics-range-btn"
                aria-pressed={days === windowDays}
                onClick={() => setDays(windowDays)}
              >
                {windowDays}d
              </button>
            ))}
          </div>
          <Button variant="secondary" onClick={() => void load()} loading={busy}>
            <RefreshCw size={14} /> Refresh
          </Button>
        </div>
      </div>

      {error && <ErrorState message={error} retry={() => void load()} />}

      {data && (
        <>
          <div className="analytics-kpi-grid">
            <div className="analytics-kpi-card">
              <div className="analytics-kpi-head">
                <span>Unique visitors</span>
                <Users size={15} />
              </div>
              <div className="analytics-kpi-value">{data.traffic.uniqueVisitors.toLocaleString()}</div>
              <div className="analytics-kpi-sub">
                Today: {data.traffic.todayUniqueVisitors.toLocaleString()} · 7d: {data.traffic.last7dUniqueVisitors.toLocaleString()} · Returning: {data.traffic.returningVisitors.toLocaleString()}
              </div>
            </div>

            <div className="analytics-kpi-card">
              <div className="analytics-kpi-head">
                <span>Total page views</span>
                <Eye size={15} />
              </div>
              <div className="analytics-kpi-value">{data.traffic.totalPageViews.toLocaleString()}</div>
              <div className="analytics-kpi-sub">
                Today: {data.traffic.todayPageViews.toLocaleString()} · Last 7d: {data.traffic.last7dPageViews.toLocaleString()}
              </div>
            </div>

            <div className="analytics-kpi-card">
              <div className="analytics-kpi-head">
                <span>Connected X accounts</span>
                <ShieldCheck size={15} />
              </div>
              <div className="analytics-kpi-value">{data.xAuth.uniqueConnectedXAccounts.toLocaleString()}</div>
              <div className="analytics-kpi-sub">
                Active sessions: {data.xAuth.activeXSessions.toLocaleString()} · OAuth starts: {data.xAuth.connectXStarted.toLocaleString()} · Completed: {data.xAuth.connectXSucceeded.toLocaleString()} · Failed: {data.xAuth.connectXFailed.toLocaleString()}
              </div>
            </div>

            <div className="analytics-kpi-card">
              <div className="analytics-kpi-head">
                <span>Wallet eligibility checks</span>
                <Wallet size={15} />
              </div>
              <div className="analytics-kpi-value">{data.eligibility.totalChecks.toLocaleString()}</div>
              <div className="analytics-kpi-sub">
                Today: {data.eligibility.todayChecks.toLocaleString()} · LZ Winner: {data.eligibility.byTier.lzWinner.toLocaleString()} · 5+ Tx: {data.eligibility.byTier.lzUser5tx.toLocaleString()}
              </div>
            </div>

            <div className="analytics-kpi-card">
              <div className="analytics-kpi-head">
                <span>Airdrop participants</span>
                <Activity size={15} />
              </div>
              <div className="analytics-kpi-value">{data.airdropFunnel.totalParticipants.toLocaleString()}</div>
              <div className="analytics-kpi-sub">
                Wallets linked: {data.airdropFunnel.boundWallets.toLocaleString()} ({pct(data.airdropFunnel.boundWallets, data.airdropFunnel.totalParticipants)}) · Boxes unlocked: {data.airdropFunnel.unlockedBoxes.toLocaleString()}
              </div>
            </div>

            <div className="analytics-kpi-card">
              <div className="analytics-kpi-head">
                <span>Referrals</span>
                <Share2 size={15} />
              </div>
              <div className="analytics-kpi-value">{data.airdropFunnel.referrals.totalInvited.toLocaleString()}</div>
              <div className="analytics-kpi-sub">
                Qualified: {data.airdropFunnel.referrals.totalQualified.toLocaleString()} · Active referrers: {data.airdropFunnel.referrals.activeReferrers.toLocaleString()}
              </div>
            </div>
          </div>

          <div className="analytics-split-grid">
            <div className="panel">
              <div className="analytics-panel-title">
                <h3>Airdrop mission funnel</h3>
                <span>{participantsTotal.toLocaleString()} enrolled</span>
              </div>
              <div className="analytics-funnel-list">
                <div className="analytics-funnel-row">
                  <div className="analytics-funnel-meta">
                    <span>Wallet linked</span>
                    <span>
                      {data.airdropFunnel.boundWallets.toLocaleString()} ({pct(data.airdropFunnel.boundWallets, participantsTotal)})
                    </span>
                  </div>
                  <div className="analytics-bar">
                    <div className="analytics-bar-fill" style={{ width: barWidth(data.airdropFunnel.boundWallets, participantsTotal) }} />
                  </div>
                </div>

                <div className="analytics-funnel-row">
                  <div className="analytics-funnel-meta">
                    <span>Mission 1: Follow verified</span>
                    <span>
                      {data.airdropFunnel.missions.followVerified.toLocaleString()} ({pct(data.airdropFunnel.missions.followVerified, participantsTotal)})
                    </span>
                  </div>
                  <div className="analytics-bar">
                    <div className="analytics-bar-fill" style={{ width: barWidth(data.airdropFunnel.missions.followVerified, participantsTotal) }} />
                  </div>
                </div>

                <div className="analytics-funnel-row">
                  <div className="analytics-funnel-meta">
                    <span>Mission 2: Repost verified</span>
                    <span>
                      {data.airdropFunnel.missions.repostVerified.toLocaleString()} ({pct(data.airdropFunnel.missions.repostVerified, participantsTotal)})
                    </span>
                  </div>
                  <div className="analytics-bar">
                    <div className="analytics-bar-fill" style={{ width: barWidth(data.airdropFunnel.missions.repostVerified, participantsTotal) }} />
                  </div>
                </div>

                <div className="analytics-funnel-row">
                  <div className="analytics-funnel-meta">
                    <span>Mission 3: Posted (&ge; 1 verified post)</span>
                    <span>
                      {data.airdropFunnel.missions.postsVerifiedUsers.toLocaleString()} users · {data.airdropFunnel.missions.totalVerifiedPosts.toLocaleString()} posts ({data.airdropFunnel.missions.totalEngagementScore.toLocaleString()} pts)
                    </span>
                  </div>
                  <div className="analytics-bar">
                    <div className="analytics-bar-fill" style={{ width: barWidth(data.airdropFunnel.missions.postsVerifiedUsers, participantsTotal) }} />
                  </div>
                </div>

                <div className="analytics-funnel-row">
                  <div className="analytics-funnel-meta">
                    <span>Mission 4: Token created / Box unlocked</span>
                    <span>
                      {data.airdropFunnel.missions.createTokenVerified.toLocaleString()} / {data.airdropFunnel.unlockedBoxes.toLocaleString()}
                    </span>
                  </div>
                  <div className="analytics-bar">
                    <div className="analytics-bar-fill" style={{ width: barWidth(data.airdropFunnel.unlockedBoxes, participantsTotal) }} />
                  </div>
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="analytics-panel-title">
                <h3>X OAuth &amp; tier breakdown</h3>
                <span>Snapshot: {data.airdropFunnel.snapshot.total.toLocaleString()}</span>
              </div>
              <div className="analytics-kv-grid">
                <div className="analytics-kv-row">
                  <span>Unique X accounts (all-time)</span>
                  <strong>{data.xAuth.uniqueConnectedXAccounts.toLocaleString()}</strong>
                </div>
                <div className="analytics-kv-row">
                  <span>OAuth completion rate (tracked)</span>
                  <strong>{pct(data.xAuth.connectXSucceeded, data.xAuth.connectXStarted)}</strong>
                </div>
                <div className="analytics-kv-row">
                  <span>Today X logins (started / ok / failed)</span>
                  <strong>
                    {data.xAuth.todayConnectXStarted.toLocaleString()} / {data.xAuth.todayConnectXSucceeded.toLocaleString()} / {data.xAuth.todayConnectXFailed.toLocaleString()}
                  </strong>
                </div>
                <div className="analytics-kv-row">
                  <span>Enrolled tiers: LZ Winner / 5+ Tx / Community</span>
                  <strong>
                    {data.airdropFunnel.tiers.lzWinner.toLocaleString()} / {data.airdropFunnel.tiers.lzUser5tx.toLocaleString()} / {data.airdropFunnel.tiers.community.toLocaleString()}
                  </strong>
                </div>
                <div className="analytics-kv-row">
                  <span>Eligibility checks (Community)</span>
                  <strong>{data.eligibility.byTier.community.toLocaleString()}</strong>
                </div>
                <div className="analytics-kv-row">
                  <span>Reserved general slots</span>
                  <strong>{data.airdropFunnel.reservedSlots.toLocaleString()}</strong>
                </div>
              </div>
            </div>
          </div>

          <div className="analytics-split-grid">
            <div className="panel">
              <div className="analytics-panel-title">
                <h3>Page views by route</h3>
                <span>Public routes only</span>
              </div>
              {data.traffic.topPages.length === 0 ? (
                <p className="genesis-helper">No public page views recorded yet.</p>
              ) : (
                <div className="analytics-table-wrap">
                  <table className="analytics-table">
                    <thead>
                      <tr>
                        <th>Route</th>
                        <th>Today</th>
                        <th>All-time</th>
                        <th>Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.traffic.topPages.map(row => (
                        <tr key={row.path}>
                          <td><code>{row.path}</code></td>
                          <td>{row.todayViews.toLocaleString()}</td>
                          <td>{row.totalViews.toLocaleString()}</td>
                          <td>{pct(row.totalViews, data.traffic.totalPageViews)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="panel">
              <div className="analytics-panel-title">
                <h3>Recent airdrop signups</h3>
                <span>Latest {data.airdropFunnel.recentParticipants.length}</span>
              </div>
              {data.airdropFunnel.recentParticipants.length === 0 ? (
                <p className="genesis-helper">No enrolled participants yet.</p>
              ) : (
                <div className="analytics-recent-list">
                  {data.airdropFunnel.recentParticipants.map(user => (
                    <div className="analytics-recent-row" key={`${user.username}-${user.createdAt}`}>
                      <div className="analytics-recent-user">
                        <SafeAvatar username={user.username} avatarUrl={user.avatarUrl} />
                        <div className="analytics-recent-identity">
                          <strong>@{user.username}</strong>
                          <small>{new Date(user.createdAt).toLocaleString()}</small>
                        </div>
                      </div>
                      <div className="analytics-recent-badges">
                        <Badge tone={user.tier === 'lz_winner' ? 'mint' : 'neutral'}>{tierLabel(user.tier)}</Badge>
                        {user.walletBound && <Badge tone="mint">Wallet</Badge>}
                        {user.followVerified && <Badge tone="mint">Follow</Badge>}
                        {user.repostVerified && <Badge tone="mint">Repost</Badge>}
                        {user.postsCount > 0 && <Badge tone="mint">{user.postsCount} post{user.postsCount === 1 ? '' : 's'}</Badge>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="analytics-panel-title">
              <h3>Daily activity (last {data.days} days, UTC)</h3>
              <span>Newest first</span>
            </div>
            <div className="analytics-table-wrap">
              <table className="analytics-table">
                <thead>
                  <tr>
                    <th>Day (UTC)</th>
                    <th>Unique visitors</th>
                    <th>Page views</th>
                    <th>X starts</th>
                    <th>X connected</th>
                    <th>X failed</th>
                    <th>Eligibility checks</th>
                    <th>Enrolled</th>
                    <th>Wallets linked</th>
                    <th>Missions</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.daily].reverse().map(row => (
                    <tr key={row.day}>
                      <td><code>{row.day}</code></td>
                      <td>{row.uniqueVisitors.toLocaleString()}</td>
                      <td>{row.pageViews.toLocaleString()}</td>
                      <td>{row.connectXStarted.toLocaleString()}</td>
                      <td>{row.connectXSucceeded.toLocaleString()}</td>
                      <td>{row.connectXFailed.toLocaleString()}</td>
                      <td>{row.eligibilityChecks.toLocaleString()}</td>
                      <td>{row.airdropEnrolled.toLocaleString()}</td>
                      <td>{row.walletLinked.toLocaleString()}</td>
                      <td>{row.missionsVerified.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
