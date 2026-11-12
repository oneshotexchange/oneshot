export type StudioIllustrationKind = 'tokens' | 'collection' | 'portfolio' | 'activity';

/** Small editorial drawings for first-party empty and draft states. */
export function StudioIllustration({ kind, className = '' }: { kind: StudioIllustrationKind; className?: string }) {
  return <svg className={`studio-illustration studio-illustration-${kind} ${className}`} viewBox="0 0 200 140" fill="none" aria-hidden="true" focusable="false">
    {kind === 'tokens' && <>
      <path className="studio-ground" d="M25 110 96 130 176 101" />
      <g className="studio-plane-secondary">
        <path className="studio-depth" d="m32 80 63 24 65-26v12l-65 26-63-24Z" />
        <path className="studio-panel studio-outline" d="m32 80 63-25 65 23-65 26Z" />
        <path className="studio-fine" d="m43 80 52 19 53-21" />
      </g>
      <g className="studio-plane-primary">
        <path className="studio-depth studio-outline" d="m83 24 33-5 28 26 7 42-27 25-38-5-23-30 1-32Z" />
        <path className="studio-accent studio-outline" d="m75 22 33-4 28 26 7 42-27 25-38-5-23-30 1-32Z" />
        <path className="studio-edge" d="m76 29 29-4 25 24 6 35-23 21-32-4-20-26 1-28Z" />
        <path className="studio-engraving" d="m84 45 24-4 15 15-3 27-25 5-16-17Z" />
        <path className="studio-engraving" d="m81 66 16 13 23-5M97 79l-1-26 13-12" />
      </g>
    </>}
    {kind === 'collection' && <>
      <path className="studio-ground" d="m30 116 75 13 66-20" />
      <g className="studio-plane-secondary">
        <path className="studio-depth studio-outline" d="m59 25 98 16-14 78-98-16Z" />
        <path className="studio-panel studio-outline" d="m55 21 98 16-14 78-98-16Z" />
        <path className="studio-fine" d="m65 32 76 12-11 59-76-12Z" />
      </g>
      <g className="studio-plane-primary">
        <path className="studio-depth studio-outline" d="m39 38 91-13 13 84-91 13Z" />
        <path className="studio-paper studio-outline" d="m35 34 91-13 13 84-91 13Z" />
        <path className="studio-fine" d="m45 42 73-10 10 64-73 10Z" />
        <path className="studio-accent" d="m52 88 28-47 13 25 24-19 8 48-69 10Z" />
        <path className="studio-quiet" d="m80 41 13 25-9 29-28 10Z" />
        <path className="studio-engraving" d="m58 98 35-32 27 23" />
      </g>
      <path className="studio-fine" d="m134 28 26 4m-24 2 19 3" />
    </>}
    {kind === 'portfolio' && <>
      <path className="studio-ground" d="m26 113 80 15 69-21" />
      <path className="studio-depth studio-outline" d="m30 56 91-24 48 26v47l-91 23-48-26Z" />
      <path className="studio-panel studio-outline" d="m30 52 91-24 48 26-91 24Z" />
      <g className="studio-plane-secondary">
        <path className="studio-panel studio-outline" d="m55 35 63-17 31 18-63 18Z" />
        <path className="studio-fine" d="m66 36 51-14 20 12" />
      </g>
      <g className="studio-plane-primary">
        <path className="studio-paper studio-outline" d="m49 44 66-18 33 19-65 18Z" />
        <path className="studio-accent" d="m78 36 16-4 34 19-16 4Z" />
        <path className="studio-fine" d="m58 44 14-4m-5 9 14-4" />
      </g>
      <path className="studio-panel studio-outline" d="m30 52 48 26 91-24v47l-91 24-48-27Z" />
      <path className="studio-fine" d="m37 65 41 22 82-21m-5 29-77 21-40-22" />
      <path className="studio-accent studio-outline" d="m139 68 30-8v23l-30 8-12-7V75Z" />
      <path className="studio-engraving" d="m143 78 11-3m-4-4v8" />
      <path className="studio-fine" d="M78 87v29" />
    </>}
    {kind === 'activity' && <>
      <path className="studio-ground" d="m30 116 76 14 69-22" />
      <g className="studio-plane-secondary">
        <path className="studio-depth studio-outline" d="m65 26 88 12 8 81-89-13Z" />
        <path className="studio-panel studio-outline" d="m61 22 88 12 8 81-89-13Z" />
      </g>
      <g className="studio-plane-primary">
        <path className="studio-depth studio-outline" d="m45 34 72-12 24 16 13 74-93 15Z" />
        <path className="studio-paper studio-outline" d="m41 30 72-12 24 16 13 74-93 15Z" />
        <path className="studio-panel studio-outline" d="m113 18 3 22 21-6Z" />
        <path className="studio-connector" d="m67 48 8 49" />
        <path className="studio-accent" d="m66 42 6 4-4 7-6-4Zm4 24 6 4-4 7-6-4Zm4 24 6 4-4 7-6-4Z" />
        <path className="studio-record" d="m82 46 23-4m-21 11 39-7m-37 24 22-4m-20 11 39-7m-37 24 23-4m-21 11 39-7" />
      </g>
      <path className="studio-fine" d="m32 57-11 2m14 18-9 2" />
    </>}
  </svg>;
}
