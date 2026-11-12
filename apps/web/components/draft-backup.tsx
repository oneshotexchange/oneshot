import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Download, FileUp } from 'lucide-react';
import { draftBackupFilename, draftBackupMaxBytes, type DraftKind } from '../lib/draft-backup';
import { Button, ErrorState, Modal } from './ui';
import './draft-backup.css';

export function DraftBackup<T extends { name: string }>({ kind, name, serialize, parse, onRestore }: {
  kind: DraftKind;
  name: string;
  serialize(): string;
  parse(text: string): T;
  onRestore(draft: T): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [pending, setPending] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => () => { generation.current += 1; }, []);

  function download() {
    setError(null); setNotice(null);
    let url: string | null = null;
    try {
      const content = serialize();
      url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = draftBackupFilename(kind, name);
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setNotice('Backup download started. Keep this file private; it contains your draft details.');
    } catch { setError('This draft could not be downloaded. Check its fields and try again.'); }
    // Let the browser finish receiving the object URL before releasing it.
    finally { if (url) { const created = url; window.setTimeout(() => URL.revokeObjectURL(created), 30_000); } }
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    const ticket = ++generation.current;
    setError(null); setNotice(null); setPending(null); setBusy(true);
    try {
      if (file.size > draftBackupMaxBytes) throw new Error('Choose a draft backup smaller than 1 MiB.');
      const text = await file.text();
      if (ticket === generation.current) setPending(parse(text));
    } catch (reason) { if (ticket === generation.current) setError(reason instanceof Error ? reason.message : 'This backup could not be opened. Try another file.'); }
    finally { if (ticket === generation.current) setBusy(false); }
  }

  return <section className="draft-backup" aria-label="Draft backup">
    <div className="button-row">
      <Button type="button" variant="secondary" onClick={download}><Download size={14} />Download draft</Button>
      <Button type="button" variant="ghost" loading={busy} onClick={() => input.current?.click()}><FileUp size={14} />Restore backup</Button>
      <input ref={input} type="file" accept="application/json,.json" aria-label="Choose a draft backup" hidden onChange={event => void chooseFile(event)} />
    </div>
    <p className="field-hint">Save a JSON copy to move your draft to another browser.{kind === 'collection' ? ' Image files are not included.' : ''}</p>
    {error && <div role="alert"><ErrorState message={error} /></div>}
    {notice && <p className="data-notice" role="status">{notice}</p>}
    {pending && <Modal title="Restore as a new draft?" onClose={() => setPending(null)}>
      <div className="draft-backup-confirm">
        <p><strong>{pending.name || 'Untitled draft'}</strong></p>
        <p>This replaces the form you’re editing. Your saved drafts stay unchanged until you save this copy.</p>
        {kind === 'collection' && <p>Select the original image files again before uploading. Check mint dates, prices and wallet addresses before saving.</p>}
        <p>Restoring a backup does not publish anything or make a transaction.</p>
        <div className="button-row"><Button type="button" onClick={() => {
          try { onRestore(pending); setPending(null); setError(null); setNotice('Backup opened as a new draft. Review your details before saving.'); }
          catch { setPending(null); setError('This backup could not be restored. Your saved drafts have not changed.'); }
        }}>Use as new draft</Button><Button type="button" variant="secondary" onClick={() => setPending(null)}>Cancel</Button></div>
      </div>
    </Modal>}
  </section>;
}
