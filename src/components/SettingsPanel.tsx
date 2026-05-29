import { KeyRound, Link2, Trash2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { ConnectBinanceModal } from "@/components/ConnectBinanceModal";
import { useCredentials } from "@/context/CredentialsContext";

export function SettingsPanel() {
  const {
    activeSlot,
    setActiveSlot,
    apiKey,
    apiSecret,
    connectionName,
    setApiKey,
    setApiSecret,
    save,
    clear,
  } = useCredentials();
  const [showConnect, setShowConnect] = useState(false);
  const connected = Boolean(apiKey.trim());

  return (
    <>
      <ConnectBinanceModal open={showConnect} onClose={() => setShowConnect(false)} />
      <div className="mx-auto max-w-xl space-y-5">
        {/* API key card */}
        <div className="ui-card p-6 sm:p-8">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50">
              <KeyRound className="h-5 w-5 text-indigo-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">Binance Futures</h2>
              <p className="text-xs text-slate-400">API credentials for USD-M perpetuals</p>
            </div>
          </div>

          <p className="mb-5 text-sm leading-relaxed text-slate-500">
            Your secret never leaves this browser — it's stored locally only. Create a separate API
            key with <span className="font-medium text-slate-700">futures trading on</span>,{" "}
            <span className="font-medium text-slate-700">withdrawals off</span>, and your home IP
            (from the footer) whitelisted.
          </p>

          {/* Account selector */}
          <div className="mb-5">
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Active account
            </label>
            <div className="inline-flex overflow-hidden rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              {(["A", "B"] as const).map((slot) => (
                <button
                  key={slot}
                  type="button"
                  onClick={() => setActiveSlot(slot)}
                  className={`rounded-md px-5 py-1.5 text-sm font-semibold transition ${
                    activeSlot === slot
                      ? "bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  Account {slot}
                </button>
              ))}
            </div>
          </div>

          {/* Connection status */}
          {connected ? (
            <div className="mb-5 flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
              <div>
                <p className="text-sm font-semibold text-emerald-800">Connected</p>
                <p className="mt-0.5 text-xs text-emerald-600">
                  <span className="font-semibold text-emerald-900">{connectionName}</span> · stored locally
                </p>
              </div>
            </div>
          ) : (
            <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              No API key on file — click <span className="font-semibold">Connect Binance</span> to walk through IP whitelist and paste keys.
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setShowConnect(true)}
              className="ui-btn-primary gap-2 px-5 py-2.5"
            >
              <Link2 className="h-4 w-4 opacity-90" />
              {connected ? "Review connection" : "Connect Binance"}
            </button>
            <button
              type="button"
              onClick={() => setShowConnect(true)}
              className="ui-btn-secondary"
            >
              Update details
            </button>
            <button
              type="button"
              onClick={() => void clear()}
              className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-100"
            >
              <Trash2 className="h-4 w-4" />
              Disconnect
            </button>
          </div>

          {/* Advanced: manual fields */}
          <details className="group mt-6 rounded-xl border border-slate-200">
            <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-slate-500 transition hover:text-slate-800 [&::-webkit-details-marker]:hidden">
              Advanced: manual credential fields
            </summary>
            <div className="space-y-4 border-t border-slate-100 px-4 pb-4 pt-4">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                API Key
                <input
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  className="ui-input mt-2 w-full font-mono text-sm"
                />
              </label>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Secret
                <input
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  type="password"
                  autoComplete="off"
                  className="ui-input mt-2 w-full font-mono text-sm"
                  placeholder="••••••••"
                />
              </label>
              <button type="button" onClick={save} className="ui-btn-secondary text-sm">
                Save manual changes
              </button>
            </div>
          </details>
        </div>

        {/* IP reminder card */}
        <div className="ui-card px-5 py-4">
          <div className="mb-2 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-indigo-400" />
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              IP allowlist reminder
            </p>
          </div>
          <p className="text-sm leading-relaxed text-slate-500">
            Restrict your Binance API key by IP and paste the address from{" "}
            <span className="font-medium text-slate-700">Connect Binance</span> or this page's
            footer into{" "}
            <span className="font-medium text-slate-700">API Management → Trusted IPs only</span>.
          </p>
        </div>
      </div>
    </>
  );
}
