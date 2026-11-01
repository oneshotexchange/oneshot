"use client";

import Link from "./navigation";
import { useLocation, useNavigate } from "react-router-dom";
import { Activity, ArrowUpRight, ChevronRight, Gem, Layers2, LayoutDashboard, Menu, Plus, Search, Settings2, Wallet, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { WalletButton } from "./wallet-button";
import { ThemePicker } from "./theme-picker";

const navigation = [
  { label: "Home", href: "/", icon: LayoutDashboard },
  { label: "Token markets", href: "/tokens", icon: Layers2 },
  { label: "NFT collections", href: "/nfts", icon: Gem },
  { label: "Portfolio", href: "/portfolio", icon: Wallet },
  { label: "Activity", href: "/activity", icon: Activity },
];
export function Shell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !["INPUT", "TEXTAREA", "SELECT"].includes((event.target as HTMLElement)?.tagName) && searchRef.current?.offsetParent) {
        event.preventDefault(); searchRef.current.focus();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);
  const section = pathname.startsWith("/tokens") ? "Token markets" : pathname.startsWith("/nfts") ? "NFT collections" : pathname.startsWith("/portfolio") ? "Portfolio" : pathname.startsWith("/activity") ? "Activity" : pathname.startsWith("/settings") ? "Settings" : pathname.startsWith("/admin") ? "Administration" : "Home";
  return <div className="app-shell">
    <a href="#main-content" className="skip-link">Skip to content</a>
    {mobileOpen && <div className="sidebar-scrim" onClick={() => setMobileOpen(false)} />}
    <aside id="main-navigation" className={'sidebar ' + (mobileOpen ? 'sidebar-open' : '')}>
      <div className="sidebar-brand"><Link href="/" className="brand" aria-label="oneshot home"><span className="brand-symbol"><i /><i /><i /></span><span>oneshot</span></Link><button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><X size={20} /></button></div>
      <nav className="main-nav" aria-label="Main navigation">{navigation.map(item => {
        const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(item.href + "/") && !pathname.endsWith("/new");
        return <Link key={item.href} href={item.href} className={active ? "active" : ""} onClick={() => setMobileOpen(false)}><item.icon size={18} strokeWidth={1.7} /><span>{item.label}</span></Link>;
      })}</nav>
      <nav className="main-nav create-nav" aria-label="Create">
        <Link href="/tokens/new" className={pathname === "/tokens/new" ? "active-sub" : ""} onClick={() => setMobileOpen(false)}><Plus size={18} /><span>Launch a token</span><ArrowUpRight size={14} /></Link>
        <Link href="/nfts/new" className={pathname === "/nfts/new" ? "active-sub" : ""} onClick={() => setMobileOpen(false)}><Plus size={18} /><span>Create a collection</span><ArrowUpRight size={14} /></Link>
      </nav>
      <div className="sidebar-bottom"><Link href="/settings" className={'sidebar-settings ' + (pathname === "/settings" ? "active" : "")} onClick={() => setMobileOpen(false)}><Settings2 size={17} />Settings</Link><div className="sidebar-footer"><span>oneshot</span></div></div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={mobileOpen} aria-controls="main-navigation" onClick={() => setMobileOpen(true)}><Menu size={20} /></button><span className="breadcrumb-root">oneshot</span><ChevronRight size={12} /><span>{section}</span></div>
        <form className="global-search" onSubmit={event => { event.preventDefault(); if (search.trim()) navigate('/tokens?q=' + encodeURIComponent(search.trim())); }}><Search size={15} /><input ref={searchRef} aria-keyshortcuts="/" aria-label="Search tokens or addresses" placeholder="Search tokens or addresses" value={search} onChange={event => setSearch(event.target.value)} /><kbd>/</kbd></form>
        <div className="topbar-actions"><ThemePicker /><WalletButton /></div>
      </header>
      <div className="network-banner"><span>Zero launches and trading are currently unavailable.</span></div>
      <main id="main-content" className="main-content" key={pathname}>{children}</main>
      <footer className="workspace-footer"><span className="brand-tiny">oneshot</span><div><a href="https://layerzero.network/zero" target="_blank" rel="noreferrer">About Zero <ArrowUpRight size={12} /></a><Link href="/settings">Settings</Link></div></footer>
    </div>
  </div>;
}

