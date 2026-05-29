import type { ReactNode } from "react";

/** Short explanation under a form label — keeps the UI approachable. */
export function FieldHint({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
      {children}
    </p>
  );
}
