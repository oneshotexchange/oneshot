import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { BASE_SEPOLIA_GENESIS_HASH } from '@oneshot/evm';
import { encodeFunctionData, hashTypedData } from 'viem';
import { REVIEWED_NFT_REGISTRY_ABI } from '../../../packages/evm/src/reviewed-nft-abi';
import { apiUrl } from '../lib/api-url';
import { customerErrorDetails, customerFetch } from '../lib/customer-http';
import { accountExternalNftImportSchema, externalImportAddressSchema, externalNftImportDecisionSchema } from '../lib/external-nft-import';
import { reviewedNftAdmissionBundleSchema, type ReviewedNftAdmissionBundle } from '../lib/external-nft-admission';
import { Address, Badge, Button, ErrorState, Field, InfoRow, SafetyNote } from './ui';

const rawHash = z.string().regex(/^0x[a-f0-9]{64}$/).refine(value => !/^0x0{64}$/.test(value));
const rawUint = z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(value => BigInt(value) < 2n ** 256n);
const inspectedDeploymentSchema = z.object({
  deploymentId: z.string().regex(/^[a-f0-9]{64}$/), chainId: z.union([z.literal(31337), z.literal(84532)]),
  genesisHash: rawHash, registry: externalImportAddressSchema, marketplace: externalImportAddressSchema,
}).strict().refine(value => value.registry !== value.marketplace && (value.chainId !== 84532 || value.genesisHash === BASE_SEPOLIA_GENESIS_HASH));
const inspectionSchema = z.object({
  deployment: inspectedDeploymentSchema, collection: externalImportAddressSchema, runtimeCodeHash: rawHash,
  currentReviewVersion: rawUint, checkpoint: z.object({ number: rawUint, hash: rawHash, timestamp: rawUint }).strict(),
  inspectedAt: z.string().datetime(),
}).strict();
const reviewSchema = z.object({
  decision: z.enum(['review-approved', 'rejected']), actor: z.string().min(1).max(128),
  operatorEvidence: z.string().max(8000), customerNote: z.string().max(500),
  inspection: inspectionSchema.nullable(), inspectionCommitment: z.string().regex(/^[a-f0-9]{64}$/).nullable(), reviewedAt: z.string().datetime(),
}).strict();
const recordSchema = z.object({
  schemaVersion: z.literal(1), ownerUserId: z.string().regex(/^did:privy:[a-zA-Z0-9_-]{1,256}$/),
  request: accountExternalNftImportSchema, review: reviewSchema.nullable(),
}).strict().superRefine((value, context) => {
  const { request, review } = value;
  if ((request.status === 'review-approved' || request.status === 'rejected') && review?.decision !== request.status
    || request.status === 'submitted' && review !== null || request.reviewedAt !== (review?.reviewedAt ?? null)
    || request.customerNote !== (review?.customerNote ?? null)
    || review && (review.decision === 'review-approved' ? !review.inspection || !review.inspectionCommitment : review.inspection !== null || review.inspectionCommitment !== null)
    || review?.inspection && (review.inspection.collection !== request.collection || review.inspection.deployment.deploymentId !== request.deploymentId))
    context.addIssue({ code: 'custom', message: 'The review does not match this import request.' });
});
const queueSchema = z.object({ items: z.array(recordSchema).max(20), nextCursor: z.string().max(2048).nullable() }).strict()
  .refine(value => new Set(value.items.map(record => record.request.id)).size === value.items.length && (!value.nextCursor || value.items.length === 20));
type AdminRecord = z.infer<typeof recordSchema>;
type Queue = z.infer<typeof queueSchema>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type PreparedBundle = { id: string; revision: number; bundle: ReviewedNftAdmissionBundle; text: string };
const reviewTypes = { ReviewPermit: [
  { name: 'collection', type: 'address' }, { name: 'runtimeCodeHash', type: 'bytes32' }, { name: 'reviewVersion', type: 'uint256' },
  { name: 'deadline', type: 'uint256' }, { name: 'deploymentSalt', type: 'bytes32' },
] } as const;
const typedMessageSchema = z.object({ collection: externalImportAddressSchema, runtimeCodeHash: rawHash, reviewVersion: rawUint, deadline: rawUint, deploymentSalt: rawHash }).strict();
const preparedSchema = z.object({
  bundle: reviewedNftAdmissionBundleSchema,
  typedData: z.object({
    domain: z.object({ name: z.literal('OneshotReviewedCollectionRegistry'), version: z.literal('1'), chainId: z.union([z.literal(31337), z.literal(84532)]), verifyingContract: externalImportAddressSchema }).strict(),
    primaryType: z.literal('ReviewPermit'),
    types: z.object({ ReviewPermit: z.tuple([
      z.object({ name: z.literal('collection'), type: z.literal('address') }).strict(), z.object({ name: z.literal('runtimeCodeHash'), type: z.literal('bytes32') }).strict(),
      z.object({ name: z.literal('reviewVersion'), type: z.literal('uint256') }).strict(), z.object({ name: z.literal('deadline'), type: z.literal('uint256') }).strict(),
      z.object({ name: z.literal('deploymentSalt'), type: z.literal('bytes32') }).strict(),
    ]) }).strict(), message: typedMessageSchema,
  }).strict(), admissionStatus: z.literal('not-established'),
}).strict();
const validatedSchema = z.object({
  call: z.object({ chainId: z.union([z.literal(31337), z.literal(84532)]), from: externalImportAddressSchema, to: externalImportAddressSchema,
    data: z.string().max(32770).regex(/^0x(?:[a-fA-F0-9]{2})*$/), value: z.literal('0x0') }).strict(),
  simulation: z.object({ blockNumber: rawUint, blockHash: rawHash, gasEstimate: rawUint.refine(value => BigInt(value) > 0n && BigInt(value) <= 8000000n) }).strict(),
  permitHash: rawHash, deadline: rawUint, admissionStatus: z.literal('not-established'),
}).strict();
class StaleReviewError extends Error {}
const readFailure = () => new Error('The external collection administration response could not be verified. Reload and try again.');
// Twenty full records include private evidence. Allow JSON's six-byte escaped
// surrogate representation at every text limit while keeping reads bounded.
const maximumResponseBytes = 2 * 1024 * 1024;
const maximumBundleBytes = 64 * 1024;
const message = (error: unknown) => error instanceof z.ZodError ? readFailure().message : error instanceof Error ? error.message : 'This action could not finish. Please try again.';

/** Both transport and consumption are bounded; successful unreadable responses are never queue data. */
async function request(path: string, token: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  try {
    const response = await customerFetch(apiUrl('/api/admin/external-nfts/imports' + path), {
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', credentials: 'omit', redirect: 'error', signal: deadline,
    });
    const reader = response.body?.getReader(); if (!reader) throw readFailure();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        deadline.throwIfAborted(); const part = await reader.read(); if (part.done) break;
        bytes += part.value.length; if (bytes > maximumResponseBytes) { await reader.cancel().catch(() => undefined); throw readFailure(); } chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    deadline.throwIfAborted(); const data = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    let value: unknown; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); } catch { throw readFailure(); }
    if (!response.ok) throw new Error(customerErrorDetails(value).message?.slice(0, 1500) || 'The administration request failed. Reload and try again.');
    return value;
  } catch (error) {
    if (signal.aborted) throw error;
    if (deadline.aborted) throw new Error('The administration request timed out. Reload the saved request before trying again.');
    throw error;
  }
}
/** Opaque permit/validation JSON is display-only. No transaction fields are inferred from it. */
function boundedObject(value: unknown): { value: JsonObject; text: string } {
  let nodes = 0;
  function check(item: unknown, depth: number): item is JsonValue {
    if (++nodes > 4096 || depth > 16) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isSafeInteger(item);
    if (typeof item === 'string') return item.length <= 32768;
    if (Array.isArray(item)) return item.length <= 1024 && item.every(child => check(child, depth + 1));
    return !!item && typeof item === 'object' && Object.entries(item).every(([key, child]) => key.length <= 128 && check(child, depth + 1));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !check(value, 0)) throw readFailure();
  const text = JSON.stringify(value, null, 2); if (new TextEncoder().encode(text).length > maximumBundleBytes) throw readFailure();
  return { value: value as JsonObject, text };
}
function preparedPermit(value: unknown, record: AdminRecord): PreparedBundle {
  const parsed = preparedSchema.parse(value), bundle = parsed.bundle, inspected = record.review?.inspection;
  const currentTime = BigInt(Math.floor(Date.now() / 1000));
  if (!inspected || bundle.requestId !== record.request.id || bundle.requestRevision !== record.request.revision || bundle.deploymentId !== record.request.deploymentId
    || bundle.collection !== record.request.collection || bundle.inspectionCommitment !== record.review!.inspectionCommitment
    || bundle.runtimeCodeHash !== inspected.runtimeCodeHash || bundle.chainId !== inspected.deployment.chainId || bundle.registry !== inspected.deployment.registry
    || BigInt(bundle.reviewVersion) !== BigInt(inspected.currentReviewVersion) + 1n || BigInt(bundle.deadline) <= currentTime || BigInt(bundle.deadline) > currentTime + 960n
    || parsed.typedData.domain.chainId !== bundle.chainId || parsed.typedData.domain.verifyingContract !== bundle.registry) throw readFailure();
  const expectedMessage = { collection: bundle.collection, runtimeCodeHash: bundle.runtimeCodeHash, reviewVersion: bundle.reviewVersion, deadline: bundle.deadline, deploymentSalt: bundle.deploymentSalt };
  if (JSON.stringify(parsed.typedData.message) !== JSON.stringify(expectedMessage)
    || hashTypedData({ domain: parsed.typedData.domain, primaryType: 'ReviewPermit', types: reviewTypes, message: { ...expectedMessage, runtimeCodeHash: bundle.runtimeCodeHash, reviewVersion: BigInt(bundle.reviewVersion), deadline: BigInt(bundle.deadline), deploymentSalt: bundle.deploymentSalt } }) !== bundle.permitHash) throw readFailure();
  return { id: record.request.id, revision: record.request.revision, bundle, text: boundedObject(parsed).text };
}
function download(text: string, id: string, revision: number) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `external-collection-permit-${id}-r${revision}.json`;
  document.body.appendChild(link); try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); }
}
const label = (status: AdminRecord['request']['status']) => ({ submitted: 'Awaiting review', 'review-approved': 'Review approved', rejected: 'Rejected', withdrawn: 'Withdrawn' })[status];

/** A token change unmounts every private record and artifact before rendering the next session. */
export function ExternalNftAdmin({ token }: { token: string }) { return <ExternalNftAdminSession key={token} token={token} />; }
function ExternalNftAdminSession({ token }: { token: string }) {
  const [queue, setQueue] = useState<Queue | null>(null), [cursor, setCursor] = useState<string | null>(null), [history, setHistory] = useState<(string | null)[]>([]);
  const [selected, setSelected] = useState<AdminRecord | null>(null), [opening, setOpening] = useState(false), [queueBusy, setQueueBusy] = useState(false), [busy, setBusy] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [outdated, setOutdated] = useState(false);
  const [decision, setDecision] = useState<'review-approved' | 'rejected'>('review-approved'), [customerNote, setCustomerNote] = useState(''), [operatorEvidence, setOperatorEvidence] = useState('');
  const [bundle, setBundle] = useState<PreparedBundle | null>(null), [signature, setSignature] = useState(''), [submitter, setSubmitter] = useState(''), [validated, setValidated] = useState<string | null>(null);
  const queueGeneration = useRef(0), detailGeneration = useRef(0), queueAbort = useRef<AbortController | null>(null), detailAbort = useRef<AbortController | null>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const clearPermit = () => { setBundle(null); setSignature(''); setSubmitter(''); setValidated(null); };
  useEffect(() => () => { queueGeneration.current++; detailGeneration.current++; queueAbort.current?.abort(); detailAbort.current?.abort(); }, []);
  async function loadQueue(next: string | null = cursor) {
    const generation = ++queueGeneration.current; queueAbort.current?.abort(); const controller = new AbortController(); queueAbort.current = controller;
    setQueueBusy(true); setQueueError(null);
    try {
      const query = new URLSearchParams({ limit: '20', ...(next ? { cursor: next } : {}) });
      const response = queueSchema.parse(await request(`?${query}`, token, controller.signal));
      if (generation !== queueGeneration.current || controller.signal.aborted) return false;
      setQueue(response); setCursor(next);
      const selectedNow = selectedRef.current, current = selectedNow && response.items.find(item => item.request.id === selectedNow.request.id);
      if (current && current.request.revision !== selectedNow!.request.revision) { setOutdated(true); clearPermit(); }
      return true;
    } catch (reason) { if (generation === queueGeneration.current && !controller.signal.aborted) { setQueueError(message(reason)); setQueue(null); } return false; }
    finally { if (generation === queueGeneration.current) setQueueBusy(false); }
  }
  useEffect(() => { void loadQueue(null); }, []);
  function operation() {
    const generation = ++detailGeneration.current; detailAbort.current?.abort(); const controller = new AbortController(); detailAbort.current = controller;
    return { controller, current: () => generation === detailGeneration.current && !controller.signal.aborted };
  }
  async function open(id: string) {
    const reloading = selectedRef.current?.request.id === id;
    const op = operation(); setOpening(true); setBusy(false); if (!reloading) setSelected(null); setError(null); setNotice(null); setOutdated(reloading); clearPermit();
    try {
      const response = recordSchema.parse(await request(`/${id}`, token, op.controller.signal)); if (response.request.id !== id) throw readFailure();
      if (!op.current()) return; setSelected(response); setOutdated(false); setDecision(response.review?.decision ?? 'review-approved'); setCustomerNote(response.review?.customerNote ?? ''); setOperatorEvidence(response.review?.operatorEvidence ?? '');
    } catch (reason) { if (op.current()) setError(message(reason)); }
    finally { if (op.current()) setOpening(false); }
  }
  async function latest(record: AdminRecord, signal: AbortSignal) {
    const response = recordSchema.parse(await request(`/${record.request.id}`, token, signal));
    if (JSON.stringify(response) !== JSON.stringify(record)) throw new StaleReviewError('This request changed. Reload the saved request before reviewing or preparing a permit. Your notes are still open.');
  }
  async function review() {
    if (!selected || busy || opening || outdated || selected.request.status !== 'submitted') return;
    const notes = externalNftImportDecisionSchema.safeParse({ decision, customerNote, operatorEvidence });
    if (!notes.success || decision === 'review-approved' && !notes.data.operatorEvidence) { setError('Approval requires private operator evidence. Check the note limits before continuing.'); return; }
    const record = selected, op = operation(); setBusy(true); setError(null); setNotice(null); clearPermit();
    try {
      await latest(record, op.controller.signal); if (!op.current()) return;
      const response = recordSchema.parse(await request(`/${record.request.id}/review`, token, op.controller.signal, { expectedRevision: record.request.revision, ...notes.data }));
      if (response.request.id !== record.request.id || response.request.revision !== record.request.revision + 1 || response.request.status !== notes.data.decision
        || response.request.collection !== record.request.collection || response.request.deploymentId !== record.request.deploymentId
        || response.review?.customerNote !== notes.data.customerNote || response.review?.operatorEvidence !== notes.data.operatorEvidence) throw readFailure();
      if (!op.current()) return; setSelected(response); setNotice('Review saved. This does not establish onchain admission or enable trading.');
      setQueue(old => old ? { ...old, items: old.items.map(item => item.request.id === response.request.id ? response : item) } : old);
    } catch (reason) { if (op.current()) { setError(message(reason)); setOutdated(true); } }
    finally { if (op.current()) setBusy(false); }
  }
  async function prepare() {
    if (!selected || selected.request.status !== 'review-approved' || busy || outdated) return;
    const record = selected, op = operation(); setBusy(true); setError(null); setNotice(null); clearPermit();
    try {
      await latest(record, op.controller.signal); if (!op.current()) return;
      const response = preparedPermit(await request(`/${record.request.id}/permit`, token, op.controller.signal, { expectedRevision: record.request.revision }), record);
      if (op.current()) { setBundle(response); setNotice('Permit bundle prepared for inspection and signing in an authority-controlled tool. No signature or transaction was created here.'); }
    } catch (reason) { if (op.current()) { setError(message(reason)); if (reason instanceof StaleReviewError) { setOutdated(true); clearPermit(); } } }
    finally { if (op.current()) setBusy(false); }
  }
  async function validate() {
    if (!selected || !bundle || bundle.id !== selected.request.id || bundle.revision !== selected.request.revision || busy || outdated) return;
    const wallet = externalImportAddressSchema.safeParse(submitter.trim()), signed = signature.trim();
    if (!wallet.success || !/^0x(?:[\da-fA-F]{2}){1,4096}$/.test(signed)) { setError('Provide the nonzero submitter address and the authority signature as hexadecimal bytes.'); return; }
    const record = selected, prepared = bundle, op = operation(); setBusy(true); setError(null); setNotice(null); setValidated(null);
    try {
      await latest(record, op.controller.signal); if (!op.current()) return;
      const response = validatedSchema.parse(await request(`/${record.request.id}/validate-permit`, token, op.controller.signal, { expectedRevision: record.request.revision, bundle: prepared.bundle, signature: signed, submitter: wallet.data }));
      const b = prepared.bundle, expectedData = encodeFunctionData({ abi: REVIEWED_NFT_REGISTRY_ABI, functionName: 'admitReviewed', args: [b.collection, b.runtimeCodeHash, BigInt(b.reviewVersion), BigInt(b.deadline), signed as `0x${string}`] });
      if (response.call.chainId !== b.chainId || response.call.from !== wallet.data || response.call.to !== b.registry || response.call.data.toLowerCase() !== expectedData.toLowerCase()
        || response.permitHash !== b.permitHash || response.deadline !== b.deadline || BigInt(b.deadline) <= BigInt(Math.floor(Date.now() / 1000))) throw readFailure();
      if (op.current()) { setValidated(boundedObject(response).text); setNotice('The server returned the unsigned call and simulation below. This interface has not sent a transaction.'); }
    } catch (reason) { if (op.current()) { setError(message(reason)); if (reason instanceof StaleReviewError) { setOutdated(true); clearPermit(); } } }
    finally { if (op.current()) setBusy(false); }
  }
  const canReview = selected?.request.status === 'submitted' && !busy && !opening && !outdated;
  async function nextPage() { if (queueBusy || !queue?.nextCursor) return; const before = cursor; if (await loadQueue(queue.nextCursor)) setHistory(old => [...old, before]); }
  async function previousPage() { if (queueBusy || !history.length) return; const before = history.at(-1) ?? null; if (await loadQueue(before)) setHistory(old => old.slice(0, -1)); }
  return <section className="panel section-gap" aria-labelledby="external-nft-admin-heading">
    <div className="section-header"><div><h2 id="external-nft-admin-heading">External NFT collection reviews</h2><p className="field-hint">Review approval does not enable trading. Admission requires the authority permit and a separately verified onchain transaction.</p></div><Button variant="secondary" loading={queueBusy} onClick={() => void loadQueue()}>Refresh queue</Button></div>
    {queueError && <ErrorState message={queueError} retry={() => void loadQueue()} />}
    {queue && <><div className="card-list">{queue.items.map(item => <article className="panel" key={item.request.id}>
      <div className="section-header"><div><Address value={item.request.collection} full /><p className="field-hint">{new Date(item.request.createdAt).toLocaleString()} · Revision {item.request.revision}</p></div><Badge tone={item.request.status === 'submitted' ? 'amber' : 'neutral'}>{label(item.request.status)}</Badge></div>
      <Button variant="secondary" onClick={() => void open(item.request.id)} disabled={opening}>Open review</Button>
    </article>)}</div>{!queue.items.length && <p className="field-hint">No import requests on this page.</p>}
      <div className="button-row"><Button variant="secondary" disabled={queueBusy || !history.length} onClick={() => void previousPage()}>Previous page</Button><Button variant="secondary" disabled={queueBusy || !queue.nextCursor} onClick={() => void nextPage()}>Next page</Button></div></>}
    {opening && <p role="status">Loading the saved request…</p>}
    {error && <ErrorState message={error} />}{notice && <p role="status" className="field-hint">{notice}</p>}
    {selected && <article className="section-gap">
      <div className="section-header"><h3>Selected request</h3><Button variant="ghost" disabled={busy || opening} onClick={() => void open(selected.request.id)}>Reload saved request</Button></div>
      <p className="field-hint">Reloading replaces the open review notes with the saved version.</p>
      {outdated && <SafetyNote amber>This saved request must be reloaded before another review. Your open notes have been retained.</SafetyNote>}
      <InfoRow label="Collection"><Address value={selected.request.collection} full /></InfoRow><InfoRow label="Request ID"><code style={{ overflowWrap: 'anywhere' }}>{selected.request.id}</code></InfoRow>
      <InfoRow label="Deployment ID"><code style={{ overflowWrap: 'anywhere' }}>{selected.request.deploymentId}</code></InfoRow><InfoRow label="Account"><code style={{ overflowWrap: 'anywhere' }}>{selected.ownerUserId}</code></InfoRow><InfoRow label="State">{label(selected.request.status)} · Revision {selected.request.revision}</InfoRow>
      <Field label="Requester note"><textarea readOnly value={selected.request.note} rows={3} /></Field><Field label="Requester reference" hint="Reference text is untrusted. This interface does not fetch it."><textarea readOnly value={selected.request.reference} rows={2} /></Field>
      {selected.review?.inspection && <details><summary>Stored inspection evidence</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(selected.review.inspection, null, 2)}</pre><p className="field-hint">Inspection commitment: {selected.review.inspectionCommitment}</p></details>}
      <Field label="Review decision"><select value={decision} disabled={!canReview} onChange={event => setDecision(event.target.value === 'rejected' ? 'rejected' : 'review-approved')}><option value="review-approved">Approve review for registry submission</option><option value="rejected">Reject request</option></select></Field>
      <Field label="Customer note" hint="Optional message visible to the requesting account."><textarea value={customerNote} onChange={event => setCustomerNote(event.target.value)} maxLength={500} disabled={!canReview} rows={3} /></Field>
      <Field label="Private operator evidence" hint="Administrator-only notes. Required for approval; never published to the customer."><textarea value={operatorEvidence} onChange={event => setOperatorEvidence(event.target.value)} maxLength={8000} disabled={!canReview} rows={5} /></Field>
      <div className="button-row"><Button onClick={() => void review()} loading={busy} disabled={!canReview || decision === 'review-approved' && !operatorEvidence.trim()}>Save review decision</Button>{selected.request.status === 'review-approved' && <Button variant="secondary" disabled={busy || outdated} onClick={() => void prepare()}>Prepare unsigned permit bundle</Button>}</div>
      {bundle && bundle.id === selected.request.id && bundle.revision === selected.request.revision && <div className="section-gap">
        <h3>Authority permit bundle</h3><SafetyNote>Inspect this bundle and sign only in the authority-controlled tool. No authority key is requested or stored here. Permits expire after 15 minutes; withdrawing the request does not revoke a signature already issued.</SafetyNote>
        <Field label="Readonly permit JSON"><textarea readOnly value={bundle.text} rows={12} spellCheck={false} /></Field><Button variant="secondary" onClick={() => download(bundle.text, bundle.id, bundle.revision)}>Download permit JSON</Button>
        <Field label="Authority signature"><textarea value={signature} onChange={event => { setSignature(event.target.value); setValidated(null); }} maxLength={8194} rows={3} spellCheck={false} disabled={busy} /></Field>
        <Field label="Transaction submitter address"><input value={submitter} onChange={event => { setSubmitter(event.target.value); setValidated(null); }} maxLength={42} spellCheck={false} disabled={busy} /></Field>
        <Button variant="secondary" onClick={() => void validate()} disabled={busy || outdated || !signature.trim() || !submitter.trim()}>Validate signature and unsigned call</Button>
        {validated && <><h3>Unsigned call and simulation</h3><p className="field-hint">Validation does not send this call. Onchain admission and indexer confirmation are separate steps.</p><Field label="Readonly validation response"><textarea readOnly value={validated} rows={12} spellCheck={false} /></Field></>}
      </div>}
    </article>}
  </section>;
}
