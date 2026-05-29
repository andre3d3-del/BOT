import { ArrowLeft, Check, ChevronDown, Copy, ExternalLink, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useCredentials } from "@/context/CredentialsContext";
import { usePublicIp } from "@/hooks/usePublicIp";

const GUIDE_BINANCE_API = "https://www.binance.com/en/my/settings/api-management";

type Tab = "fast" | "keys";

export function ConnectBinanceModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const {
    activeSlot,
    apiKey,
    apiSecret,
    connectionName,
    importOpenPositions,
    setApiKey,
    setApiSecret,
    setConnectionName,
    setImportOpenPositions,
    save,
  } = useCredentials();

  const [tab, setTab] = useState<Tab>("keys");
  const [copiedIp, setCopiedIp] = useState(false);
  const ip = usePublicIp();

  const ipBlockLines =
    ip.status === "ok"
      ? ip.ipv4.split(/\s*,\s*/).concat()
      : ip.status === "error"
        ? [`(could not detect: ${ip.message})`]
        : ["Detecting…"];

  const copyIps = useCallback(async () => {
    const text = ipBlockLines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIp(true);
      window.setTimeout(() => setCopiedIp(false), 2000);
    } catch { /* ignore */ }
  }, [ipBlockLines]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const modal = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close backdrop"
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-binance-title"
        className="relative flex max-h-[min(728px,calc(100vh-1.25rem))] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
      >
        {/* Header */}
        <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 px-4 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h2
            id="connect-binance-title"
            className="flex flex-1 items-center gap-2.5 text-base font-semibold text-slate-900"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-50 text-amber-600 ring-1 ring-amber-200">
              <span className="text-sm font-bold leading-none">₿</span>
            </span>
            Connect Binance
            <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">
              Account {activeSlot}
            </span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Tabs */}
        <div className="flex shrink-0 gap-6 border-b border-slate-200 px-4">
          {(["fast", "keys"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`border-b-2 px-1 py-3.5 text-sm font-semibold transition ${
                tab === t
                  ? "border-indigo-600 text-indigo-700"
                  : "border-transparent text-slate-400 hover:text-slate-700"
              }`}
              onClick={() => setTab(t)}
            >
              {t === "fast" ? "Fast Connect" : "API Keys"}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {tab === "fast" ? (
            <div className="space-y-4 p-6 text-sm leading-relaxed text-slate-500">
              <p>
                OAuth-style provisioning is not used in this self-hosted build. Use{" "}
                <button
                  type="button"
                  className="font-semibold text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:text-indigo-800"
                  onClick={() => setTab("keys")}
                >
                  API Keys
                </button>{" "}
                once your IP whitelist is set.
              </p>
              <button
                type="button"
                onClick={() => setTab("keys")}
                className="ui-btn-primary w-full py-3 font-semibold"
              >
                Go to API Keys
              </button>
            </div>
          ) : (
            <>
              {/* Guide section */}
              <div className="space-y-4 border-b border-slate-100 px-6 py-5">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold text-slate-900">Connect keys securely</h3>
                  <a
                    href={GUIDE_BINANCE_API}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-600 hover:bg-slate-100"
                  >
                    Full guide
                    <ExternalLink className="h-3 w-3 opacity-70" />
                  </a>
                </div>
                <ol className="list-decimal space-y-3 pl-4 text-[13px] leading-relaxed text-slate-500">
                  <li>
                    Log in to Binance and open{" "}
                    <span className="font-medium text-slate-700">Wallet → API Management</span>.
                  </li>
                  <li>
                    Enable{" "}
                    <span className="font-medium text-slate-700">"Restrict access to trusted IPs"</span>{" "}
                    — paste outbound addresses your requests use:
                  </li>
                  <div className="relative my-3 ml-[-0.5rem] overflow-hidden rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-3 font-mono text-[13px] leading-relaxed text-emerald-800">
                    <div className="whitespace-pre pr-10">{ipBlockLines.join("\n")}</div>
                    <button
                      type="button"
                      title="Copy IPs"
                      onClick={() => void copyIps()}
                      className="absolute right-2 top-2 rounded-lg p-2 text-emerald-500 transition hover:bg-emerald-100 hover:text-emerald-700"
                    >
                      {copiedIp ? (
                        <Check className="h-4 w-4 text-emerald-600" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                  <li>
                    Paste the Futures-capable keys below — enable USD‑M Futures, disallow withdrawal.
                  </li>
                </ol>
              </div>

              {/* Credentials form */}
              <div className="space-y-4 px-6 py-5">
                <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                  Name
                  <input
                    value={connectionName}
                    onChange={(e) => setConnectionName(e.target.value)}
                    className="ui-input mt-1.5 w-full"
                  />
                </label>
                <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                  API Key
                  <input
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="ui-input mt-1.5 w-full font-mono text-[13px]"
                  />
                </label>
                <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                  API Secret
                  <input
                    value={apiSecret}
                    onChange={(e) => setApiSecret(e.target.value)}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    className="ui-input mt-1.5 w-full font-mono text-[13px]"
                  />
                </label>

                <label className="flex cursor-pointer gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-3 transition hover:bg-slate-100">
                  <input
                    type="checkbox"
                    checked={importOpenPositions}
                    onChange={(e) => setImportOpenPositions(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-2 focus:ring-indigo-500/30"
                  />
                  <span className="text-sm leading-snug text-slate-600">
                    Import all open positions when connecting the exchange
                  </span>
                </label>
                <p className="text-[11px] text-slate-400">
                  Persists locally only — syncing live positions has not shipped yet.
                </p>

                <details className="group rounded-lg border border-slate-200">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-xs text-slate-500 [&::-webkit-details-marker]:hidden">
                    <ChevronDown className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
                    Account types when issuing keys
                  </summary>
                  <div className="border-t border-slate-100 px-3.5 pb-3 pt-2 text-[11px] leading-relaxed text-slate-500">
                    Turn on <span className="font-medium text-slate-700">USD‑M Futures</span> trading. Omit
                    withdrawal; IP-restrict in all environments.
                  </div>
                </details>

                <button
                  type="button"
                  disabled={!apiKey.trim() || !apiSecret.trim()}
                  onClick={() => { save(); onClose(); }}
                  className="ui-btn-primary w-full py-3 text-[0.9375rem] font-semibold disabled:opacity-40"
                >
                  Connect
                </button>

                <p className="text-center text-[11px] text-slate-400">
                  New to Binance?{" "}
                  <a
                    href="https://accounts.binance.com/register"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="font-semibold text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:text-indigo-800"
                  >
                    Create an account
                  </a>
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
