import { KeyRound, Link2, Trash2, ShieldCheck, Users, Eye, EyeOff, Plus, Pencil, Check, X, RotateCcw, AlertTriangle, Loader2 } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { ConnectBinanceModal } from "@/components/ConnectBinanceModal";
import { useCredentials } from "@/context/CredentialsContext";

// ── User management helpers ───────────────────────────────────────────────────
async function adminFetch<T>(path: string, body?: object): Promise<T> {
  const isGet = body === undefined;
  const res = await fetch(path, isGet
    ? { method: "GET" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? "Request failed"));
  return data as T;
}

// ── Factory reset ─────────────────────────────────────────────────────────────
// Every key this app writes to localStorage starts with one of these prefixes
// (see CredentialsContext, TransferPanel, StrategyPanel, WatchlistPanel, tradingPrefsStorage).
const APP_STORAGE_PREFIXES = ["futures_", "binance_", "transfer_"];

// Config-only reset: clears this browser's saved settings and stops the server-side
// Auto Transfer worker. Does NOT cancel Binance orders/positions or stop running DCA bots.
async function runFactoryReset() {
  // 1. Stop AND purge the server-side Auto Transfer worker (best-effort — read the
  //    broker key before we wipe storage). `purge` drops the job + its activity log
  //    from the proxy's memory so nothing reappears when the account is reconnected.
  try {
    const raw = localStorage.getItem("binance_broker_creds_v1");
    const brokerKey = raw ? (JSON.parse(raw)?.brokerKey ?? "") : "";
    if (brokerKey) {
      await fetch("/api/broker/auto/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brokerKey, purge: true }),
      }).catch(() => { /* proxy offline — still clear local state */ });
    }
  } catch { /* ignore */ }

  // 2. Clear every app-owned localStorage key.
  try {
    const keys = Object.keys(localStorage).filter((k) => APP_STORAGE_PREFIXES.some((p) => k.startsWith(p)));
    for (const k of keys) localStorage.removeItem(k);
  } catch { /* ignore */ }

  // 3. Reload so every panel re-initialises from a clean slate.
  window.location.reload();
}

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

  // ── User management state ─────────────────────────────────────────────────
  const [adminToken,    setAdminToken]    = useState("");
  const [users,         setUsers]         = useState<string[]>([]);
  const [userWarning,   setUserWarning]   = useState("");
  const [userError,     setUserError]     = useState("");
  const [userLoading,   setUserLoading]   = useState(false);
  const [changingPw,    setChangingPw]    = useState<string | null>(null);
  const [newPw,         setNewPw]         = useState("");
  const [showNewPw,     setShowNewPw]     = useState(false);
  const [pwBusy,        setPwBusy]        = useState(false);
  const [pwMsg,         setPwMsg]         = useState<{ ok: boolean; text: string } | null>(null);
  const [addUsername,   setAddUsername]   = useState("");
  const [addPassword,   setAddPassword]   = useState("");
  const [showAddForm,   setShowAddForm]   = useState(false);
  const [addBusy,       setAddBusy]       = useState(false);

  // ── Factory reset state ───────────────────────────────────────────────────
  const [resetConfirm,  setResetConfirm]  = useState(false);
  const [resetting,     setResetting]     = useState(false);
  const handleFactoryReset = async () => {
    setResetting(true);
    await runFactoryReset(); // navigates away via reload on success
  };

  // Auto-fetch admin token from the proxy on mount — no manual config needed
  const loadUsers = useCallback(async (token: string) => {
    setUserLoading(true);
    setUserError(""); setUserWarning("");
    try {
      const d = await adminFetch<{ users: string[]; warning?: string }>("/api/admin/list-users", { adminToken: token });
      setUsers(d.users ?? []);
      if (d.warning) setUserWarning(d.warning);
    } catch (err) {
      setUserError((err as Error).message);
      setUsers([]);
    } finally {
      setUserLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const d = await adminFetch<{ token: string }>("/api/admin/my-token");
        if (d.token) { setAdminToken(d.token); void loadUsers(d.token); }
      } catch {
        setUserError("Could not reach proxy server — make sure it is running.");
      }
    })();
  }, [loadUsers]);

  const handleSetPassword = async (username: string, password: string) => {
    setPwBusy(true); setPwMsg(null);
    try {
      await adminFetch("/api/admin/set-password", { adminToken, username, password });
      setPwMsg({ ok: true, text: `Password updated for ${username}` });
      setChangingPw(null); setNewPw("");
    } catch (err) {
      setPwMsg({ ok: false, text: (err as Error).message });
    } finally {
      setPwBusy(false);
    }
  };

  const handleDeleteUser = async (username: string) => {
    if (!confirm(`Delete user "${username}"?`)) return;
    try {
      await adminFetch("/api/admin/delete-user", { adminToken, username });
      setUsers((prev) => prev.filter((u) => u !== username));
      setPwMsg({ ok: true, text: `User ${username} deleted` });
    } catch (err) {
      setPwMsg({ ok: false, text: (err as Error).message });
    }
  };

  const handleAddUser = async () => {
    if (!addUsername.trim() || !addPassword) return;
    setAddBusy(true); setPwMsg(null);
    try {
      await adminFetch("/api/admin/set-password", { adminToken, username: addUsername.trim(), password: addPassword });
      await loadUsers(adminToken);
      setAddUsername(""); setAddPassword(""); setShowAddForm(false);
      setPwMsg({ ok: true, text: `User ${addUsername.trim()} created` });
    } catch (err) {
      setPwMsg({ ok: false, text: (err as Error).message });
    } finally {
      setAddBusy(false);
    }
  };

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

        {/* User management card */}
        <div className="ui-card p-6 sm:p-8">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50">
              <Users className="h-5 w-5 text-violet-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">User Management</h2>
              <p className="text-xs text-slate-400">Change site login passwords (htpasswd)</p>
            </div>
          </div>

          {userError && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{userError}</div>
          )}

          {userWarning && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{userWarning}</div>
          )}

          {pwMsg && (
            <div className={`mb-4 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
              pwMsg.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"
            }`}>
              {pwMsg.ok ? <Check className="h-3.5 w-3.5 shrink-0" /> : <X className="h-3.5 w-3.5 shrink-0" />}
              {pwMsg.text}
              <button onClick={() => setPwMsg(null)} className="ml-auto opacity-50 hover:opacity-100"><X className="h-3 w-3" /></button>
            </div>
          )}

          {adminToken && (
            <>
              {userLoading ? (
                <p className="py-4 text-center text-sm text-slate-400">Loading users…</p>
              ) : (
                <div className="space-y-2">
                  {users.length === 0 && (
                    <p className="py-3 text-center text-sm text-slate-400">No users found in {"{HTPASSWD_FILE}"}.</p>
                  )}

                  {users.map((username) => (
                    <div key={username} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-mono text-sm font-semibold text-slate-800">{username}</span>
                        <div className="flex items-center gap-1.5">
                          <button type="button"
                            onClick={() => { setChangingPw(changingPw === username ? null : username); setNewPw(""); setPwMsg(null); }}
                            className="flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100">
                            <Pencil className="h-3 w-3" />
                            Change password
                          </button>
                          <button type="button" onClick={() => void handleDeleteUser(username)}
                            className="flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-100">
                            <Trash2 className="h-3 w-3" />
                            Delete
                          </button>
                        </div>
                      </div>

                      {changingPw === username && (
                        <div className="mt-3 flex gap-2">
                          <div className="relative flex-1">
                            <input
                              type={showNewPw ? "text" : "password"}
                              value={newPw}
                              onChange={(e) => setNewPw(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter" && newPw.length >= 4) void handleSetPassword(username, newPw); }}
                              placeholder="New password (min 4 chars)"
                              className="ui-input w-full pr-10 font-mono text-sm"
                              autoFocus
                            />
                            <button type="button" onClick={() => setShowNewPw((v) => !v)}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700">
                              {showNewPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                          <button type="button"
                            disabled={pwBusy || newPw.length < 4}
                            onClick={() => void handleSetPassword(username, newPw)}
                            className="rounded-md bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-40">
                            {pwBusy ? "Saving…" : "Save"}
                          </button>
                          <button type="button" onClick={() => { setChangingPw(null); setNewPw(""); }}
                            className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50">
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Add new user */}
                  {showAddForm ? (
                    <div className="rounded-xl border border-dashed border-indigo-300 bg-indigo-50/40 p-4 space-y-2">
                      <p className="text-xs font-semibold text-indigo-700">New user</p>
                      <input
                        type="text"
                        value={addUsername}
                        onChange={(e) => setAddUsername(e.target.value)}
                        placeholder="Username"
                        className="ui-input w-full text-sm"
                        autoFocus
                      />
                      <div className="relative">
                        <input
                          type={showNewPw ? "text" : "password"}
                          value={addPassword}
                          onChange={(e) => setAddPassword(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") void handleAddUser(); }}
                          placeholder="Password (min 4 chars)"
                          className="ui-input w-full pr-10 text-sm"
                        />
                        <button type="button" onClick={() => setShowNewPw((v) => !v)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700">
                          {showNewPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      <div className="flex gap-2">
                        <button type="button" disabled={addBusy || !addUsername.trim() || addPassword.length < 4}
                          onClick={() => void handleAddUser()}
                          className="flex-1 rounded-lg bg-indigo-600 py-2 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-40">
                          {addBusy ? "Creating…" : "Create user"}
                        </button>
                        <button type="button" onClick={() => { setShowAddForm(false); setAddUsername(""); setAddPassword(""); }}
                          className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" onClick={() => { setShowAddForm(true); setPwMsg(null); }}
                      className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-300 py-2.5 text-xs font-semibold text-slate-500 hover:border-indigo-400 hover:text-indigo-600 transition-colors">
                      <Plus className="h-4 w-4" />
                      Add new user
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Factory reset card */}
        <div className="ui-card border-red-200 p-6 sm:p-8">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-50">
              <RotateCcw className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">Factory Reset</h2>
              <p className="text-xs text-slate-400">Wipe local settings and start clean</p>
            </div>
          </div>

          <div className="mb-5 space-y-3 text-sm leading-relaxed text-slate-500">
            <p>Use this if the app gets into a bad state. It restores factory settings:</p>
            <ul className="space-y-1.5 text-xs">
              <li className="flex gap-2">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                <span><strong className="text-slate-700">Clears</strong> this browser's saved API keys (trading + broker), auto-transfer rules, all strategy sessions, watchlist and preferences.</span>
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                <span><strong className="text-slate-700">Stops</strong> the server-side Auto Transfer worker.</span>
              </li>
              <li className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                <span><strong className="text-slate-700">Does NOT</strong> cancel any open orders or positions on Binance, and does not stop running strategy (DCA) bots on the server.</span>
              </li>
            </ul>
          </div>

          {!resetConfirm ? (
            <button
              type="button"
              onClick={() => setResetConfirm(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-100"
            >
              <RotateCcw className="h-4 w-4" />
              Reset to factory settings
            </button>
          ) : (
            <div className="rounded-xl border border-red-300 bg-red-50 p-4">
              <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-red-800">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                This clears all saved settings in this browser. Continue?
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={resetting}
                  onClick={() => void handleFactoryReset()}
                  className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-40"
                >
                  {resetting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                  {resetting ? "Resetting…" : "Yes, reset everything"}
                </button>
                <button
                  type="button"
                  disabled={resetting}
                  onClick={() => setResetConfirm(false)}
                  className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-500 hover:bg-slate-50 disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
