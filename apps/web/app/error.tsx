"use client";

import { ArrowLeft, RefreshCw } from "lucide-react";
import { Button, ButtonLink } from "../components/ui";

export default function WorkspaceError({ retry }: { error: unknown; retry: () => void }) {
  return <section className="panel detail-error" role="alert" aria-labelledby="workspace-error-title"><div className="empty-state"><div className="empty-icon"><RefreshCw size={24} strokeWidth={1.4} /></div><h2 id="workspace-error-title" style={{ fontSize: 21, letterSpacing: "-.5px" }}>This page couldn’t load</h2><p>Try again or return home.</p><div className="button-row section-gap"><Button variant="secondary" onClick={retry}><RefreshCw size={14} />Try again</Button><ButtonLink href="/" variant="ghost"><ArrowLeft size={14} />Back to home</ButtonLink></div></div></section>;
}
