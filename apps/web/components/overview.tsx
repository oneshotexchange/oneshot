"use client";

import Link from "./navigation";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { items, Token, useApi } from "../lib/client-api";
import { TokenTable } from "./market-data";
import { IndexedActivityHighlights, IndexedCollectionHighlights } from "./indexed-nfts";
import { ErrorState, Loading, SectionHeader, Tabs } from "./ui";
import { LaunchHero } from "./launch-hero";
import { OneshotLogo } from "./brand";

export function Overview() {
  const [tab, setTab] = useState("tokens");
  const tokens = useApi<unknown>("/api/tokens");
  return <>
    <LaunchHero />
    <Link href="/whitelist" className="genesis-home-link"><OneshotLogo compact className="genesis-home-mark" /><span>Meet oneshot Genesis <span>750 places in the first edition</span></span><ArrowUpRight size={16}/></Link>

    <section className="discovery-section section-gap"><SectionHeader title="Explore" action={<Link className="text-link" href={tab === "tokens" ? "/tokens" : "/nfts"}>View all <ArrowUpRight size={15} /></Link>} /><div className="panel"><div className="panel-toolbar"><Tabs tabs={[{ value: "tokens", label: "Token markets" }, { value: "nfts", label: "NFT collections" }]} active={tab} onChange={setTab} /></div>{tab === "tokens" ? tokens.loading ? <Loading /> : tokens.error ? <ErrorState message={tokens.error} retry={tokens.refresh} /> : <TokenTable tokens={items<Token>(tokens.data, "tokens").slice(0, 5)} compact /> : <IndexedCollectionHighlights />}</div></section>
    <section className="panel activity-panel section-gap"><SectionHeader title="Recent NFT activity" action={<Link className="text-link" href="/activity">View activity <ArrowUpRight size={14} /></Link>} /><IndexedActivityHighlights /></section>
  </>;
}
