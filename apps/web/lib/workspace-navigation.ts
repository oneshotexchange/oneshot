/** Collection filters belong to the same page and retain its scroll/reviews.
 * Deployment references remain part of the page identity, including invalid or
 * duplicate references. Other routes retain their complete query boundary so
 * draft handoffs, selected wallets and item navigation keep their existing reset.
 */
export function workspaceNavigationKey(pathname: string, search: string): string {
  if (/^\/nfts\/0x[a-f\d]{40}\/?$/i.test(pathname)) {
    return JSON.stringify([pathname, new URLSearchParams(search).getAll('deployment')]);
  }
  return pathname + search;
}
