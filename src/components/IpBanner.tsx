import { RefreshCw, Globe } from "lucide-react";
import { usePublicIp } from "@/hooks/usePublicIp";

export function IpBanner() {
  const ip = usePublicIp();

  return (
    <div className="relative z-[1] flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-200 bg-white px-4 py-2.5 sm:px-6">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-slate-50">
          <Globe className="h-3.5 w-3.5 text-slate-400" />
        </span>
        <span className="hidden font-medium sm:inline">Paste this IP in Binance</span>
        <span className="font-medium sm:hidden">Your IP</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {ip.status === "loading" && (
          <span className="text-xs text-slate-400">Detecting outbound IP…</span>
        )}
        {ip.status === "error" && (
          <span className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-600">
            {ip.message}
          </span>
        )}
        {ip.status === "ok" && (
          <>
            <code className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-mono text-[11px] font-medium tracking-wide text-emerald-700">
              {ip.ipv4}
            </code>
            <button
              type="button"
              onClick={() => ip.refresh()}
              className="ui-btn-outline gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-slate-800"
              title="Refresh detected IP"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>
          </>
        )}
      </div>

      <p className="basis-full text-[10px] leading-snug text-slate-400 sm:basis-auto">
        Binance → API Management → your key → &quot;Restrict access&quot; → add addresses like this one.
      </p>
    </div>
  );
}
