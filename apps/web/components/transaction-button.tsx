"use client";

import { LockKeyhole } from "lucide-react";
import { Button } from "./ui";

type ConfirmedTransaction = { success: boolean; collectionId?: string; listingId?: string; [key: string]: unknown };

/** Submission stays closed until the Zero chain and deployed contracts are verified. */
export function TransactionButton({ label, variant = "primary", className = "" }: {
  action: string; label: string; params?: Record<string, unknown>; disabled?: boolean;
  onSuccess?: (result: ConfirmedTransaction) => void;
  variant?: "primary" | "secondary" | "ghost"; className?: string; onBefore?: () => Promise<void>;
}) {
  return <Button variant={variant} className={className} disabled title="Transactions are not available yet."><LockKeyhole size={14} />{label} unavailable</Button>;
}
