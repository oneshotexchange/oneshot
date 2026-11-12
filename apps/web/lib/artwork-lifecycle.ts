export interface ArtworkResource {
  setVisible(visible: boolean): void;
  replay(): void;
  dispose(): void;
}

type ArtworkAttempt = { revision: number; abort: AbortController };

/** Owns one canvas resource and at most one pending creation for that canvas. */
export function createArtworkLifecycle({ load, onReady }: {
  load(signal: AbortSignal): Promise<ArtworkResource>;
  onReady(ready: boolean): void;
}) {
  let allowed = true, visible = false, blocked = false, disposed = false;
  let revision = 0, failed = false;
  let current: ArtworkResource | null = null;
  let pending: ArtworkAttempt | null = null;

  const report = (ready: boolean) => { if (!disposed) onReady(ready); };
  const release = (resource: ArtworkResource) => {
    // A broken graphics cleanup must not leave an unhandled asynchronous task.
    try { resource.dispose(); } catch { /* The poster remains available. */ }
  };
  const releaseCurrent = () => {
    const resource = current;
    current = null;
    if (resource) release(resource);
  };
  const valid = (attempt: ArtworkAttempt) => !disposed && allowed && !blocked
    && pending === attempt && attempt.revision === revision && !attempt.abort.signal.aborted;

  function invalidate() {
    revision++;
    pending?.abort.abort();
    releaseCurrent();
    failed = false;
    report(false);
    // Keep the pending slot occupied until the aborted factory actually settles.
    // GPU compilation, for example, cannot always honor AbortSignal immediately.
  }

  function startIfEligible() {
    if (disposed || !allowed || !visible || blocked || failed || current || pending) return;
    const attempt: ArtworkAttempt = { revision, abort: new AbortController() };
    pending = attempt;
    void initialize(attempt);
  }

  async function initialize(attempt: ArtworkAttempt) {
    try {
      const resource = await load(attempt.abort.signal);
      if (!valid(attempt)) { release(resource); return; }
      current = resource;
      // Hiding a pending scene does not invalidate it: retain the loaded scene,
      // pause it, and let it resume when its artwork becomes visible again.
      resource.setVisible(visible);
      resource.replay();
      report(true);
    } catch {
      if (valid(attempt)) {
        failed = true;
        releaseCurrent();
        report(false);
      }
    } finally {
      if (pending === attempt) pending = null;
      startIfEligible();
    }
  }

  return {
    setVisible(next: boolean) {
      if (disposed) return;
      visible = next;
      current?.setVisible(next);
      startIfEligible();
    },
    setAllowed(next: boolean) {
      if (disposed || allowed === next) return;
      allowed = next;
      if (!next) invalidate();
      else { failed = false; startIfEligible(); }
    },
    contextLost() {
      if (disposed || blocked) return;
      blocked = true;
      invalidate();
    },
    contextRestored() {
      if (disposed || !blocked) return;
      blocked = false;
      failed = false;
      startIfEligible();
    },
    replay() {
      if (disposed || !allowed || blocked) return;
      if (current) current.replay();
      else {
        // An explicit replay may retry a failed load; visibility updates cannot.
        failed = false;
        startIfEligible();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      revision++;
      pending?.abort.abort();
      releaseCurrent();
    },
  };
}
