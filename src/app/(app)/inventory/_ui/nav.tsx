"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import { setLanguageAction } from "../actions";

export function InventoryNav({ items, label }: { items: { href: string; label: string; exact?: boolean }[]; label: string }) {
  const path = usePathname();
  return (
    <nav className="inv-nav" aria-label={label}>
      {items.map((i) => {
        const active = i.exact ? path === i.href : path === i.href || path.startsWith(`${i.href}/`);
        return (
          <Link key={i.href} href={i.href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function LanguageSwitch({ next, label }: { next: "ar" | "en"; label: string }) {
  const [pending, start] = useTransition();
  return (
    <button type="button" className="secondary inv-lang" lang={next} disabled={pending} onClick={() => start(() => setLanguageAction(next))}>
      {label}
    </button>
  );
}
