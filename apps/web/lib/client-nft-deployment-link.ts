/** A shared collection link cannot silently switch to a replacement local deployment. */
export function nftDeploymentLinkIssue(search: string, deploymentId: string | null | undefined): string | null {
  const query = new URLSearchParams(search), values = query.getAll('deployment');
  if (!values.length) return null;
  if (values.length !== 1 || !/^[a-f0-9]{64}$/.test(values[0])) return 'This collection link is invalid. Ask the creator for a new link.';
  if (!deploymentId) return 'This collection is currently unavailable on its original test network.';
  if (values[0] !== deploymentId) return 'The test network has changed since this collection link was created. Ask the creator for a current link.';
  return null;
}
