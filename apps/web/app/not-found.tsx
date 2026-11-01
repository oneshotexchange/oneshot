"use client";

import { ArrowLeft, Compass } from "lucide-react";
import { ButtonLink, EmptyState } from "../components/ui";
export default function NotFound() { return <div className="panel"><EmptyState icon={Compass} title="Page not found" description="The link may be out of date, or this asset is no longer available." action={<ButtonLink href="/"><ArrowLeft size={16} />Back to home</ButtonLink>} /></div>; }
