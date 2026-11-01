"use client";

import { PrivyWalletProvider } from "../lib/client-wallet";
import { createContext, useCallback, useContext, useState } from "react";
import { CheckCircle2, CircleAlert, X } from "lucide-react";

type Notice = { message: string; kind?: "success" | "error" };
const ToastContext = createContext<(notice: Notice) => void>(() => {});
export function useToast() { return useContext(ToastContext); }

export function Providers({ children }: { children: React.ReactNode }) {
  const [notices, setNotices] = useState<(Notice & { id: number })[]>([]);
  const toast = useCallback((notice: Notice) => {
    const id = Date.now(); setNotices(previous => [...previous.slice(-2), { ...notice, id }]);
    window.setTimeout(() => setNotices(previous => previous.filter(item => item.id !== id)), 6500);
  }, []);
  return <PrivyWalletProvider>
    <ToastContext.Provider value={toast}>{children}<div className="toast-stack" role="status" aria-live="polite">{notices.map(notice => <div className={`toast ${notice.kind === "error" ? "toast-error" : ""}`} key={notice.id}>{notice.kind === "error" ? <CircleAlert size={18} /> : <CheckCircle2 size={18} />}<span>{notice.message}</span><button aria-label="Dismiss notification" onClick={() => setNotices(previous => previous.filter(item => item.id !== notice.id))}><X size={16} /></button></div>)}</div></ToastContext.Provider>
  </PrivyWalletProvider>;
}
