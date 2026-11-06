"use client";

import Link from "./navigation";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { items, Token, useApi } from "../lib/client-api";
import { TokenTable } from "./market-data";
import { IndexedActivityHighlights, IndexedCollectionHighlights } from "./indexed-nfts";
import { ButtonLink, ErrorState, Loading, SectionHeader, Tabs } from "./ui";

export function Overview() {
  const [tab, setTab] = useState("tokens");
  const tokens = useApi<unknown>("/api/tokens");
  return <>
    <Link href="/whitelist" className="genesis-home-link"><span>Meet oneshot Genesis <span>750 places in the first edition</span></span><ArrowUpRight size={16}/></Link>
    <section className="home-studio" aria-labelledby="home-title">
      <div className="home-studio-copy">
        <h1 id="home-title">Tokens for your community<br /><em>Collections for your art</em></h1>
        <p>Start with a draft and work out the details before anything goes onchain.</p>
        <div className="home-studio-actions"><ButtonLink href="/tokens/new">Start a token <ArrowUpRight size={16} /></ButtonLink><ButtonLink href="/nfts/new" variant="secondary">Start a collection <ArrowUpRight size={16} /></ButtonLink></div>
      </div>
      <div className="home-print" aria-hidden="true">
        <div className="home-print-token"><span className="print-coin"><i /><i /><i /></span></div>
        <div className="home-print-edition"><span className="print-canvas"><i /><i /><i /></span></div>
      </div>
    </section>

    <section className="discovery-section section-gap"><SectionHeader title="Explore" action={<Link className="text-link" href={tab === "tokens" ? "/tokens" : "/nfts"}>View all <ArrowUpRight size={15} /></Link>} /><div className="panel"><div className="panel-toolbar"><Tabs tabs={[{ value: "tokens", label: "Token markets" }, { value: "nfts", label: "NFT collections" }]} active={tab} onChange={setTab} /></div>{tab === "tokens" ? tokens.loading ? <Loading /> : tokens.error ? <ErrorState message={tokens.error} retry={tokens.refresh} /> : <TokenTable tokens={items<Token>(tokens.data, "tokens").slice(0, 5)} compact /> : <IndexedCollectionHighlights />}</div></section>
    <section className="panel activity-panel section-gap"><SectionHeader title="Recent NFT activity" action={<Link className="text-link" href="/activity">View activity <ArrowUpRight size={14} /></Link>} /><IndexedActivityHighlights /></section>
  </>;
}
