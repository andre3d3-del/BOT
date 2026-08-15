import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Search, AlertCircle, CheckCircle2, Loader2,
  KeyRound, ArrowUpDown, RefreshCw, X, Play, Square, Plus, Trash2, Pencil,
  Info, ChevronDown, ChevronUp,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type BrokerCreds = { brokerKey: string; brokerSecret: string };
type SubAccount  = { email: string };

// Per-asset balance for one account
type AssetBalance = { available: string; wallet: string };
// Full balance map keyed by email → per-asset data
type BalanceMap   = Record<string, { assets: Record<string, AssetBalance> }>;
type AccountId    = "master" | string;

type WalletType = "UMFUTURE" | "SPOT" | "CMFUTURE" | "MARGIN" | "FUNDING";

const WALLET_OPTIONS: { value: WalletType; label: string }[] = [
  { value: "UMFUTURE", label: "USD-M Futures" },
  { value: "SPOT",     label: "Spot" },
  { value: "CMFUTURE", label: "Coin-M Futures" },
  { value: "MARGIN",   label: "Cross Margin" },
  { value: "FUNDING",  label: "Funding" },
];

const walletLabel = (w: WalletType) => WALLET_OPTIONS.find((o) => o.value === w)?.label ?? w;

type AutoRuleType = "fixed" | "pull" | "topup";

type AutoRule = {
  id: string;
  label: string;
  enabled: boolean;
  from: string;
  to: string;
  asset: string;
  fromWalletType: WalletType;
  toWalletType: WalletType;
  type: AutoRuleType;
  amount?: number;
  pullAbove?: number;
  keepBalance?: number;
  topUpTo?: number;
  topUpBelow?: number;
};

type LogEntry = {
  id: string;
  time: string;
  rule: string;
  status: "ok" | "skip" | "error";
  msg: string;
};

// ── localStorage ─────────────────────────────────────────────────────────────

const CREDS_KEY      = "binance_broker_creds_v1";
const AUTO_RULES_KEY = "transfer_auto_rules_v1";

function loadCreds(): BrokerCreds {
  try {
    const raw = localStorage.getItem(CREDS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<BrokerCreds>;
      return { brokerKey: p.brokerKey ?? "", brokerSecret: p.brokerSecret ?? "" };
    }
  } catch { /* ignore */ }
  return { brokerKey: "", brokerSecret: "" };
}

function saveCreds(c: BrokerCreds) {
  localStorage.setItem(CREDS_KEY, JSON.stringify(c));
}

function loadAutoRules(): AutoRule[] {
  try {
    const raw = localStorage.getItem(AUTO_RULES_KEY);
    return raw ? (JSON.parse(raw) as AutoRule[]) : [];
  } catch { return []; }
}

function saveAutoRules(rules: AutoRule[]) {
  localStorage.setItem(AUTO_RULES_KEY, JSON.stringify(rules));
}

// ── API helpers ───────────────────────────────────────────────────────────────

type ApiError = { message: string; code?: number };

async function apiFetch<T>(path: string, body: object): Promise<T> {
  const res  = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const err: ApiError = {
      message: String(data.error ?? "Request failed"),
      code: typeof data.code === "number" ? data.code : undefined,
    };
    throw err;
  }
  return data as T;
}

async function apiLoadAccounts(c: BrokerCreds): Promise<SubAccount[]> {
  const d = await apiFetch<{ accounts: SubAccount[] }>("/api/broker/accounts", c);
  return d.accounts ?? [];
}

type BalanceSummaryRow = {
  email?: string;
  assets?: Record<string, { available?: string; wallet?: string }>;
};

async function apiLoadBalances(c: BrokerCreds): Promise<BalanceMap> {
  const d = await apiFetch<{ futuresSummary?: BalanceSummaryRow[] }>(
    "/api/broker/balances",
    { ...c, futuresType: 1 }
  );
  const map: BalanceMap = {};
  for (const row of d.futuresSummary ?? []) {
    if (!row.email) continue;
    const assets: Record<string, AssetBalance> = {};
    for (const [sym, val] of Object.entries(row.assets ?? {})) {
      assets[sym] = {
        available: val?.available ?? "0",
        wallet:    val?.wallet    ?? "0",
      };
    }
    map[row.email] = { assets };
  }
  return map;
}

type TransferResp = { txnId?: string | number; tranId?: string | number };

async function apiTransfer(c: BrokerCreds, params: {
  fromEmail?:       string;
  toEmail?:         string;
  asset:            string;
  amount:           string;
  fromAccountType:  WalletType;
  toAccountType:    WalletType;
}): Promise<TransferResp> {
  return apiFetch<TransferResp>("/api/broker/transfer", {
    brokerKey: c.brokerKey, brokerSecret: c.brokerSecret, ...params,
  });
}

// ── Auto transfer: server-side worker control ─────────────────────────────────
// The rule loop runs inside the always-on proxy process (see server/binance-proxy.mjs),
// so it keeps executing when this page is refreshed or closed. The page only starts /
// stops the worker and polls its status + activity log.

type AutoStatusResp = {
  running:     boolean;
  intervalSec: number | null;
  rules?:      AutoRule[];
  log?:        LogEntry[];
  lastRunAt?:  number | null;
  nextRunAt?:  number | null;
};

async function apiAutoStart(c: BrokerCreds, rules: AutoRule[], intervalSec: number): Promise<AutoStatusResp> {
  return apiFetch<AutoStatusResp>("/api/broker/auto/start", { ...c, rules, intervalSec });
}

async function apiAutoUpdate(c: BrokerCreds, rules: AutoRule[], intervalSec: number): Promise<AutoStatusResp> {
  return apiFetch<AutoStatusResp>("/api/broker/auto/update", { ...c, rules, intervalSec });
}

async function apiAutoStop(c: BrokerCreds): Promise<AutoStatusResp> {
  return apiFetch<AutoStatusResp>("/api/broker/auto/stop", { brokerKey: c.brokerKey });
}

async function apiAutoStatus(c: BrokerCreds): Promise<AutoStatusResp> {
  return apiFetch<AutoStatusResp>("/api/broker/auto/status", { brokerKey: c.brokerKey });
}

async function apiAutoClearLog(c: BrokerCreds): Promise<void> {
  await apiFetch("/api/broker/auto/clear-log", { brokerKey: c.brokerKey });
}

// ── Error helper ─────────────────────────────────────────────────────────────

function BrokerKeyHelp({ code }: { code?: number }) {
  const isAuthError = code === -2015 || !code;
  if (!isAuthError) return null;
  return (
    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800 space-y-1.5">
      <p className="font-semibold text-amber-900">Check the following:</p>
      <ol className="list-decimal list-inside space-y-1">
        <li>You need the <strong>master account</strong> API key — the account that <em>owns</em> the sub-accounts (under Conta → Gerenciamento de API, not under Subcontas).</li>
        <li>This is NOT the sub-account trading key you use for the bot.</li>
        <li>The key must have <strong>"Enable Reading"</strong> and <strong>"Allow Universal Transfer"</strong> (Permitir Transferência Universal) permissions checked.</li>
        <li>If the key has IP restrictions, add this proxy server's IP (shown in the footer banner) to the whitelist on Binance.</li>
      </ol>
    </div>
  );
}

// ── Add/Edit Rule form ────────────────────────────────────────────────────────

function blankRule(accounts: SubAccount[]): AutoRule {
  return {
    id: `r_${Date.now()}`,
    label: "",
    enabled: true,
    from: "master",
    to: accounts[0]?.email || "",
    asset: "USDT",
    fromWalletType: "UMFUTURE",
    toWalletType:   "UMFUTURE",
    type: "fixed",
    amount: 100,
  };
}

function RuleForm({
  initial,
  accounts,
  onSave,
  onCancel,
}: {
  initial: AutoRule;
  accounts: SubAccount[];
  onSave: (r: AutoRule) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<AutoRule>(initial);
  const set = <K extends keyof AutoRule>(k: K, v: AutoRule[K]) => setD((p) => ({ ...p, [k]: v }));

  const inputCls = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none";
  const labelCls = "block text-xs font-semibold text-slate-500 mb-1";

  const accountOptions = (
    <>
      <option value="master">Master Account</option>
      {accounts.map((a) => (
        <option key={a.email} value={a.email}>{a.email}</option>
      ))}
    </>
  );

  const typeLabels: Record<AutoRuleType, string> = {
    fixed: "Fixed Amount",
    pull:  "Pull Excess",
    topup: "Top-up When Low",
  };

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 space-y-3">
      <p className="text-xs font-bold uppercase tracking-wider text-indigo-700">
        {d.label === "" ? "New Rule" : "Edit Rule"}
      </p>

      <div>
        <label className={labelCls}>Label (optional)</label>
        <input className={inputCls} placeholder="e.g. Pull excess from Sub1" value={d.label} onChange={(e) => set("label", e.target.value)} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>From account</label>
          <select className={inputCls} value={d.from} onChange={(e) => set("from", e.target.value)}>{accountOptions}</select>
        </div>
        <div>
          <label className={labelCls}>From wallet</label>
          <select className={inputCls} value={d.fromWalletType} onChange={(e) => set("fromWalletType", e.target.value as WalletType)}>
            {WALLET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>To account</label>
          <select className={inputCls} value={d.to} onChange={(e) => set("to", e.target.value)}>{accountOptions}</select>
        </div>
        <div>
          <label className={labelCls}>To wallet</label>
          <select className={inputCls} value={d.toWalletType} onChange={(e) => set("toWalletType", e.target.value as WalletType)}>
            {WALLET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Asset</label>
          <select className={inputCls} value={d.asset} onChange={(e) => set("asset", e.target.value)}>
            <option>USDT</option>
            <option>USDC</option>
            <option>BNB</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Rule Type</label>
          <select className={inputCls} value={d.type} onChange={(e) => set("type", e.target.value as AutoRuleType)}>
            {(["fixed", "pull", "topup"] as AutoRuleType[]).map((t) => (
              <option key={t} value={t}>{typeLabels[t]}</option>
            ))}
          </select>
        </div>
      </div>

      {d.type === "fixed" && (
        <div>
          <label className={labelCls}>Amount ({d.asset})</label>
          <input type="number" min="0" step="any" className={inputCls} placeholder="100" value={d.amount ?? ""} onChange={(e) => set("amount", Number(e.target.value))} />
        </div>
      )}

      {d.type === "pull" && (
        <>
          <p className="text-[11px] text-slate-500">Transfers excess from the <em>source</em> sub-account when its balance exceeds the threshold.</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Pull above ({d.asset})</label>
              <input type="number" min="0" step="any" className={inputCls} placeholder="1000" value={d.pullAbove ?? ""} onChange={(e) => set("pullAbove", Number(e.target.value))} />
            </div>
            <div>
              <label className={labelCls}>Keep balance ({d.asset})</label>
              <input type="number" min="0" step="any" className={inputCls} placeholder="500" value={d.keepBalance ?? ""} onChange={(e) => set("keepBalance", Number(e.target.value))} />
            </div>
          </div>
        </>
      )}

      {d.type === "topup" && (
        <>
          <p className="text-[11px] text-slate-500">Tops up the <em>destination</em> account when its balance drops below the threshold.</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Top-up to ({d.asset})</label>
              <input type="number" min="0" step="any" className={inputCls} placeholder="1000" value={d.topUpTo ?? ""} onChange={(e) => set("topUpTo", Number(e.target.value))} />
            </div>
            <div>
              <label className={labelCls}>When below ({d.asset})</label>
              <input type="number" min="0" step="any" className={inputCls} placeholder="300" value={d.topUpBelow ?? ""} onChange={(e) => set("topUpBelow", Number(e.target.value))} />
            </div>
          </div>
        </>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onSave(d)}
          className="flex-1 rounded-lg bg-indigo-600 py-2 text-xs font-bold text-white hover:bg-indigo-700"
        >
          Save Rule
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function TransferPanel() {
  // Credentials
  const [creds,     setCreds]     = useState<BrokerCreds>(loadCreds);
  const [editCreds, setEditCreds] = useState(() => !loadCreds().brokerKey);
  const [tmpKey,    setTmpKey]    = useState(() => loadCreds().brokerKey);
  const [tmpSecret, setTmpSecret] = useState(() => loadCreds().brokerSecret);
  const [connecting, setConnecting] = useState(false);
  const [connectErr, setConnectErr] = useState<{ msg: string; code?: number } | null>(null);

  // Data
  const [accounts, setAccounts] = useState<SubAccount[]>([]);
  const [balances, setBalances] = useState<BalanceMap>({});
  const [loading,  setLoading]  = useState(false);

  // Transfer form
  const [fromId,         setFromId]         = useState<AccountId>("master");
  const [fromWalletType, setFromWalletType] = useState<WalletType>("UMFUTURE");
  const [toId,           setToId]           = useState<AccountId>("");
  const [toWalletType,   setToWalletType]   = useState<WalletType>("UMFUTURE");
  const [asset,          setAsset]          = useState("USDT");
  const [amount,         setAmount]         = useState("");

  // Balance panel
  const [searchQ,  setSearchQ]  = useState("");
  const [hideZero, setHideZero] = useState(false);

  // Submit
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const resultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Right panel tabs
  const [rightTab, setRightTab] = useState<"balances" | "auto">("balances");

  // Auto Transfer
  const [autoRules,       setAutoRules]       = useState<AutoRule[]>(loadAutoRules);
  const [autoRunning,     setAutoRunning]     = useState(false);
  const [autoIntervalSec, setAutoIntervalSec] = useState("60");
  const [autoLog,         setAutoLog]         = useState<LogEntry[]>([]);
  const [editingRule,     setEditingRule]     = useState<AutoRule | null>(null);
  const [showAddForm,     setShowAddForm]     = useState(false);
  const [showGuide,       setShowGuide]       = useState(false);
  const [autoBusy,        setAutoBusy]        = useState(false);

  // ── Load data ───────────────────────────────────────────────────────────────
  const loadData = useCallback(async (c: BrokerCreds) => {
    if (!c.brokerKey || !c.brokerSecret) return;
    setLoading(true);
    try {
      const [accs, bals] = await Promise.all([apiLoadAccounts(c), apiLoadBalances(c)]);
      setAccounts(accs);
      setBalances(bals);
      setToId((prev) => prev || accs[0]?.email || "");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (creds.brokerKey && creds.brokerSecret) void loadData(creds);
  }, [creds, loadData]);

  // Apply a status snapshot from the server-side worker to local UI state.
  const applyAutoStatus = useCallback((s: AutoStatusResp) => {
    setAutoRunning(!!s.running);
    if (s.log) setAutoLog(s.log);
    // Reflect the running worker's interval; when stopped keep the user's chosen value.
    if (s.running && s.intervalSec) setAutoIntervalSec(String(s.intervalSec));
  }, []);

  // Hydrate on connect and poll the worker's status/log while the page is open.
  // The worker itself runs on the server, so refreshing or closing this page does
  // not interrupt it — this effect only mirrors its state into the UI.
  useEffect(() => {
    if (!creds.brokerKey || !creds.brokerSecret) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await apiAutoStatus(creds);
        if (!cancelled) applyAutoStatus(s);
      } catch { /* ignore transient poll errors */ }
    };
    void poll();
    const t = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [creds, applyAutoStatus]);

  // While the worker is running, push local rule edits to the server (debounced),
  // without firing an immediate cycle.
  useEffect(() => {
    if (!autoRunning || !creds.brokerKey || !creds.brokerSecret) return;
    const sec = Math.max(10, Number(autoIntervalSec) || 60);
    const t = setTimeout(() => { void apiAutoUpdate(creds, autoRules, sec).catch(() => {}); }, 500);
    return () => clearTimeout(t);
  }, [autoRules, autoRunning, creds, autoIntervalSec]);

  // ── Auto controls ───────────────────────────────────────────────────────────
  const pushAutoError = (msg: string) =>
    setAutoLog((prev) => [{ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, time: new Date().toLocaleTimeString(), rule: "auto", status: "error" as const, msg }, ...prev].slice(0, 100));

  const handleStartAuto = async () => {
    const sec = Math.max(10, Number(autoIntervalSec) || 60);
    setAutoBusy(true);
    try {
      const s = await apiAutoStart(creds, autoRules, sec);
      applyAutoStatus(s);
      setAutoRunning(true);
    } catch (err) {
      pushAutoError((err as ApiError).message ?? "Failed to start auto transfer");
    } finally {
      setAutoBusy(false);
    }
  };

  const handleStopAuto = async () => {
    setAutoBusy(true);
    try {
      const s = await apiAutoStop(creds);
      applyAutoStatus(s);
      setAutoRunning(false);
    } catch (err) {
      pushAutoError((err as ApiError).message ?? "Failed to stop auto transfer");
    } finally {
      setAutoBusy(false);
    }
  };

  // ── Rule management ─────────────────────────────────────────────────────────
  const updateRules = (rules: AutoRule[]) => { setAutoRules(rules); saveAutoRules(rules); };
  const handleSaveRule = (rule: AutoRule) => {
    const updated = autoRules.find((r) => r.id === rule.id)
      ? autoRules.map((r) => (r.id === rule.id ? rule : r))
      : [...autoRules, rule];
    updateRules(updated);
    setEditingRule(null);
    setShowAddForm(false);
  };
  const handleDeleteRule = (id: string) => updateRules(autoRules.filter((r) => r.id !== id));
  const handleToggleRule = (id: string) => updateRules(autoRules.map((r) => r.id === id ? { ...r, enabled: !r.enabled } : r));

  // ── Connect ─────────────────────────────────────────────────────────────────
  const handleConnect = async () => {
    const c: BrokerCreds = { brokerKey: tmpKey.trim(), brokerSecret: tmpSecret.trim() };
    setConnecting(true);
    setConnectErr(null);
    try {
      const [accs, bals] = await Promise.all([apiLoadAccounts(c), apiLoadBalances(c)]);
      saveCreds(c);
      setCreds(c);
      setAccounts(accs);
      setBalances(bals);
      setToId(accs[0]?.email || "");
      setEditCreds(false);
    } catch (err) {
      const e = err as ApiError;
      setConnectErr({ msg: e.message, code: e.code });
    } finally {
      setConnecting(false);
    }
  };

  // ── Form helpers ────────────────────────────────────────────────────────────
  const swap = () => {
    const tmpId = fromId; setFromId(toId); setToId(tmpId);
    const tmpWt = fromWalletType; setFromWalletType(toWalletType); setToWalletType(tmpWt);
  };

  const fromAvail: string | null =
    fromId !== "master" && fromWalletType === "UMFUTURE"
      ? (balances[fromId]?.assets?.[asset]?.available ?? null)
      : null;

  const handleMax = () => {
    if (fromAvail && Number(fromAvail) > 0) setAmount(Number(fromAvail).toFixed(4));
  };

  // ── Submit ──────────────────────────────────────────────────────────────────
  const showResult = (r: { ok: boolean; msg: string }) => {
    setResult(r);
    if (resultTimer.current) clearTimeout(resultTimer.current);
    resultTimer.current = setTimeout(() => setResult(null), 8000);
  };

  const handleTransfer = async () => {
    if (!amount || Number(amount) <= 0 || fromId === toId || !toId) return;
    setSubmitting(true);
    setResult(null);
    try {
      const resp = await apiTransfer(creds, {
        fromEmail:       fromId !== "master" ? fromId : undefined,
        toEmail:         toId   !== "master" ? toId   : undefined,
        asset, amount,
        fromAccountType: fromWalletType,
        toAccountType:   toWalletType,
      });
      const txId = resp.txnId ?? resp.tranId ?? "—";
      showResult({ ok: true, msg: `Transfer complete — TxID: ${txId} · Refreshing balances…` });
      setAmount("");
      await loadData(creds);
      showResult({ ok: true, msg: `Transfer complete — TxID: ${txId} · Balances updated` });
    } catch (err) {
      showResult({ ok: false, msg: (err as ApiError).message ?? "Transfer failed" });
    } finally {
      setSubmitting(false);
    }
  };

  // ── Derived ─────────────────────────────────────────────────────────────────
  const connected = Boolean(creds.brokerKey);

  // Detect unsupported transfer combinations before the user hits Confirm
  const isSubToSub = fromId !== "master" && toId !== "master" && Boolean(toId);
  const isCrossWalletSubToSub = isSubToSub && fromWalletType !== toWalletType;
  const isSubToSubNonFutures  = isSubToSub && !isCrossWalletSubToSub &&
    fromWalletType !== "UMFUTURE" && fromWalletType !== "CMFUTURE";
  const transferBlocked = isCrossWalletSubToSub || isSubToSubNonFutures;

  // All asset symbols seen across all sub-accounts, sorted (USDT first, then alphabetical)
  const allAssets = useMemo(() => {
    const seen = new Set<string>();
    for (const acc of Object.values(balances)) {
      for (const sym of Object.keys(acc.assets)) seen.add(sym);
    }
    const sorted = [...seen].sort();
    const priority = ["USDT", "USDC", "BNB"];
    return [
      ...priority.filter((s) => seen.has(s)),
      ...sorted.filter((s) => !priority.includes(s)),
    ];
  }, [balances]);

  const tableRows = [
    { id: "master" as AccountId, email: "Master Account" },
    ...accounts.map((a) => ({ id: a.email as AccountId, email: a.email })),
  ].filter((row) => {
    if (searchQ && !row.email.toLowerCase().includes(searchQ.toLowerCase())) return false;
    if (hideZero && row.id !== "master") {
      const hasAny = allAssets.some((s) => Number(balances[row.id]?.assets?.[s]?.available ?? 0) > 0);
      if (!hasAny) return false;
    }
    return true;
  });

  const accountOptions = (
    <>
      <option value="master">Master Account</option>
      {accounts.map((a) => (
        <option key={a.email} value={a.email}>{a.email}</option>
      ))}
    </>
  );

  const ruleTypeLabel: Record<AutoRuleType, string> = {
    fixed: "Fixed",
    pull:  "Pull excess",
    topup: "Top-up",
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full w-full flex-col overflow-y-auto pb-16 md:flex-row md:overflow-hidden md:pb-0">

      {/* ── LEFT: Transfer form ──────────────────────────────────────────── */}
      <div className="w-full border-b border-slate-200 bg-white px-4 py-5 sm:px-7 sm:py-7 md:w-[420px] md:shrink-0 md:overflow-y-auto md:border-b-0 md:border-r">

        {editCreds ? (
          <div className="mb-7 space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-5">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-slate-500" />
              <span className="text-sm font-semibold text-slate-800">Master Account API Keys</span>
            </div>
            <p className="text-xs leading-relaxed text-slate-500">
              Enter the API key of the <strong className="text-slate-700">master/broker account</strong> that owns
              the sub-accounts. This is NOT the sub-account trading key.
            </p>
            <input
              type="text"
              placeholder="API Key"
              value={tmpKey}
              onChange={(e) => setTmpKey(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 font-mono text-sm focus:border-indigo-400 focus:outline-none"
            />
            <input
              type="password"
              placeholder="API Secret"
              value={tmpSecret}
              onChange={(e) => setTmpSecret(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleConnect(); }}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 font-mono text-sm focus:border-indigo-400 focus:outline-none"
            />
            {connectErr && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3">
                <p className="text-xs font-semibold text-red-700">{connectErr.msg}</p>
                <BrokerKeyHelp code={connectErr.code} />
              </div>
            )}
            <button
              onClick={() => void handleConnect()}
              disabled={connecting || !tmpKey.trim() || !tmpSecret.trim()}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-40"
            >
              {connecting && <Loader2 className="h-4 w-4 animate-spin" />}
              {connecting ? "Connecting…" : "Connect"}
            </button>
          </div>
        ) : (
          <div className="mb-6 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5">
            <div className="flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              <span>Master account connected</span>
            </div>
            <button
              onClick={() => { setEditCreds(true); setTmpKey(creds.brokerKey); setTmpSecret(creds.brokerSecret); setConnectErr(null); }}
              className="text-xs text-slate-400 hover:text-slate-700"
            >
              Change
            </button>
          </div>
        )}

        <h2 className="mb-5 text-xl font-bold text-slate-900">Transfer</h2>

        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">Transfer from</p>
        <select
          value={fromId}
          onChange={(e) => setFromId(e.target.value as AccountId)}
          disabled={!connected || loading}
          className="mb-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none disabled:opacity-50"
        >
          {accountOptions}
        </select>
        <select
          value={fromWalletType}
          onChange={(e) => setFromWalletType(e.target.value as WalletType)}
          disabled={!connected}
          className="mb-2 w-full rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-sm text-slate-600 focus:border-indigo-400 focus:outline-none disabled:opacity-50"
        >
          {WALLET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <div className="my-3 flex justify-center">
          <button
            type="button"
            onClick={swap}
            disabled={!connected}
            className="rounded-full border border-slate-200 bg-white p-2 text-slate-400 shadow-sm hover:bg-slate-50 hover:text-indigo-600 disabled:opacity-40 transition-colors"
          >
            <ArrowUpDown className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">Transfer to</p>
        <select
          value={toId}
          onChange={(e) => setToId(e.target.value as AccountId)}
          disabled={!connected || loading}
          className="mb-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none disabled:opacity-50"
        >
          {accountOptions}
        </select>
        <select
          value={toWalletType}
          onChange={(e) => setToWalletType(e.target.value as WalletType)}
          disabled={!connected}
          className="mb-4 w-full rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-sm text-slate-600 focus:border-indigo-400 focus:outline-none disabled:opacity-50"
        >
          {WALLET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">Currency</p>
        <select
          value={asset}
          onChange={(e) => setAsset(e.target.value)}
          disabled={!connected}
          className="mb-4 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none disabled:opacity-50"
        >
          <option value="USDT">USDT</option>
          <option value="USDC">USDC</option>
          <option value="BNB">BNB</option>
        </select>

        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">Amount</p>
        <input
          type="number"
          min="0"
          step="any"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={!connected}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none disabled:opacity-50"
        />
        <div className="mt-1.5 mb-5 flex items-center justify-between text-xs text-slate-400">
          <span>
            Available to transfer:{" "}
            <span className="font-semibold text-slate-700">
              {fromAvail != null
                ? `${Number(fromAvail).toFixed(2)} ${asset}`
                : fromWalletType !== "UMFUTURE"
                  ? `— (${walletLabel(fromWalletType)})`
                  : "0"}
            </span>
          </span>
          <button
            type="button"
            onClick={handleMax}
            disabled={!fromAvail || Number(fromAvail) <= 0}
            className="font-semibold text-indigo-500 hover:text-indigo-700 disabled:opacity-40"
          >
            Max
          </button>
        </div>

        {/* Unsupported combination warning */}
        {isCrossWalletSubToSub && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            <p className="font-semibold text-amber-900 mb-1">Sub→Sub cross-wallet not supported</p>
            <p>Binance does not allow transferring between different wallet types across two sub-accounts in one step.</p>
            <p className="mt-1">Do it in two transfers: <strong>{walletLabel(fromWalletType)} → Master → {walletLabel(toWalletType)}</strong></p>
          </div>
        )}
        {isSubToSubNonFutures && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            <p className="font-semibold text-amber-900 mb-1">Sub→Sub only supports futures wallets</p>
            <p>Direct sub-to-sub transfers are limited to <strong>USD-M Futures</strong> or <strong>Coin-M Futures</strong>.</p>
            <p className="mt-1">Use <strong>Master</strong> as an intermediary for Spot / Margin / Funding.</p>
          </div>
        )}

        {result && (
          <div className={`mb-4 flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${
            result.ok
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}>
            {result.ok
              ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              : <AlertCircle  className="mt-0.5 h-4 w-4 shrink-0" />}
            <span className="flex-1">{result.msg}</span>
            <button onClick={() => setResult(null)} className="opacity-50 hover:opacity-100">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => void handleTransfer()}
          disabled={
            submitting || !connected || loading || transferBlocked ||
            !amount || Number(amount) <= 0 ||
            fromId === toId || !toId
          }
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-800 py-3 text-sm font-semibold text-white hover:bg-slate-900 disabled:opacity-40 transition-colors"
        >
          {submitting
            ? <><Loader2 className="h-4 w-4 animate-spin" /> Processing…</>
            : "Confirm"}
        </button>
      </div>

      {/* ── RIGHT panel ──────────────────────────────────────────────────── */}
      <div className="flex w-full flex-col bg-white md:min-w-0 md:flex-1 md:overflow-hidden">

        {/* Tab switcher */}
        <div className="flex shrink-0 border-b border-slate-200 px-7 pt-5 gap-1">
          {(["balances", "auto"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setRightTab(tab)}
              className={`pb-3 px-1 mr-4 text-sm font-semibold border-b-2 transition-colors ${
                rightTab === tab
                  ? "border-indigo-600 text-indigo-700"
                  : "border-transparent text-slate-400 hover:text-slate-700"
              }`}
            >
              {tab === "balances" ? "Balances" : "Auto Transfer"}
              {tab === "auto" && autoRunning && (
                <span className="ml-1.5 inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              )}
            </button>
          ))}
        </div>

        {/* ── Balances tab ─────────────────────────────────────────────── */}
        {rightTab === "balances" && (
          <div className="px-4 py-4 sm:px-7 sm:py-5 md:flex-1 md:overflow-y-auto">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Balance Comparison</h3>
                <p className="text-xs text-slate-400 mt-0.5">Shows available-to-transfer per coin (excludes unrealised PnL)</p>
              </div>
              <button
                type="button"
                onClick={() => void loadData(creds)}
                disabled={loading || !connected}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-40"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>

            <div className="mb-2 flex gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search by email…"
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-indigo-400 focus:outline-none"
                />
              </div>
              <div className="flex items-center rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-600">
                USD‑M Futures balances
              </div>
            </div>

            <label className="mb-4 flex cursor-pointer items-center gap-2 text-xs text-slate-500 select-none">
              <input
                type="checkbox"
                checked={hideZero}
                onChange={(e) => setHideZero(e.target.checked)}
                className="h-3.5 w-3.5 rounded accent-indigo-600"
              />
              Hide accounts with no transferable balance
            </label>

            {loading && accounts.length === 0 ? (
              <div className="flex items-center gap-2 py-8 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading accounts…
              </div>
            ) : (
              <div className="overflow-x-auto overflow-hidden rounded-2xl border border-slate-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-800 text-white">
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap">E-mail</th>
                      {allAssets.map((sym) => (
                        <th key={sym} className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider whitespace-nowrap">
                          {sym} Available
                        </th>
                      ))}
                      {allAssets.length === 0 && (
                        <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider">Available</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((row, i) => {
                      const isFrom = row.id === fromId;
                      const isTo   = row.id === toId;
                      return (
                        <tr
                          key={row.id}
                          onClick={() => { if (row.id !== fromId) setToId(row.id); }}
                          className={`cursor-pointer border-b border-slate-100 last:border-0 transition-colors ${
                            i % 2 === 0 ? "bg-white" : "bg-slate-50/50"
                          } ${isFrom ? "!bg-indigo-50" : ""} ${isTo ? "!bg-emerald-50" : ""} hover:!bg-slate-100`}
                        >
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              <span className="text-slate-700">{row.email}</span>
                              <div className="flex gap-1">
                                {isFrom && <span className="rounded-full bg-indigo-100 px-1.5 py-px text-[10px] font-bold uppercase text-indigo-600">from</span>}
                                {isTo   && <span className="rounded-full bg-emerald-100 px-1.5 py-px text-[10px] font-bold uppercase text-emerald-600">to</span>}
                              </div>
                            </div>
                          </td>
                          {allAssets.map((sym) => {
                            const avail = row.id !== "master"
                              ? Number(balances[row.id]?.assets?.[sym]?.available ?? 0)
                              : null;
                            return (
                              <td key={sym} className={`px-4 py-3 text-right font-mono whitespace-nowrap ${
                                avail != null && avail > 0 ? "text-slate-900" : "text-slate-300"
                              }`}>
                                {avail != null ? avail.toFixed(2) : "—"}
                              </td>
                            );
                          })}
                          {allAssets.length === 0 && (
                            <td className="px-4 py-3 text-right font-mono text-slate-300">—</td>
                          )}
                        </tr>
                      );
                    })}
                    {tableRows.length === 0 && (
                      <tr>
                        <td colSpan={allAssets.length + 1} className="px-4 py-10 text-center text-sm text-slate-400">
                          {!connected
                            ? "Connect master account API keys to view accounts"
                            : "No accounts match your search"}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Auto Transfer tab ─────────────────────────────────────────── */}
        {rightTab === "auto" && (
          <div className="space-y-5 px-4 py-4 sm:px-7 sm:py-5 md:flex-1 md:overflow-y-auto">

            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">Auto Transfer Rules</h3>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1.5">
                  <span className="text-xs text-slate-500">Every</span>
                  <input
                    type="number"
                    min="10"
                    step="10"
                    value={autoIntervalSec}
                    onChange={(e) => setAutoIntervalSec(e.target.value)}
                    disabled={autoRunning}
                    className="w-14 rounded border-0 bg-transparent text-center text-sm font-semibold text-slate-800 focus:outline-none disabled:opacity-60"
                  />
                  <span className="text-xs text-slate-500">s</span>
                </div>
                {autoRunning ? (
                  <button
                    onClick={() => void handleStopAuto()}
                    disabled={autoBusy}
                    className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-100 disabled:opacity-40"
                  >
                    {autoBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />}
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={() => void handleStartAuto()}
                    disabled={autoBusy || !connected || autoRules.filter((r) => r.enabled).length === 0}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-40"
                  >
                    {autoBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-current" />}
                    Start
                  </button>
                )}
              </div>
            </div>

            {autoRunning && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                Running — checking rules every {autoIntervalSec}s
              </div>
            )}

            {!connected && (
              <p className="text-xs text-amber-600 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                Connect master account API keys first.
              </p>
            )}

            {/* ── Guide: full card when no rules, collapsible when rules exist ── */}
            {autoRules.length === 0 && !showAddForm ? (
              <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <Info className="h-4 w-4 text-indigo-500 shrink-0" />
                  <p className="text-sm font-bold text-indigo-800">How to set up Auto Transfer</p>
                </div>

                <ol className="space-y-3">
                  {[
                    { n: "1", title: "Add a rule", desc: 'Click "Add Rule" below. Choose source/destination accounts, wallet types, asset (USDT / USDC / BNB), and a transfer type.' },
                    { n: "2", title: "Set the interval", desc: "Choose how often the bot checks — e.g. every 60 seconds. Minimum is 10 s." },
                    { n: "3", title: "Click Start", desc: "The bot runs in the background and executes transfers automatically whenever a rule condition is met." },
                  ].map(({ n, title, desc }) => (
                    <li key={n} className="flex gap-3">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-bold text-white mt-0.5">{n}</span>
                      <div>
                        <p className="text-xs font-semibold text-indigo-900">{title}</p>
                        <p className="text-xs text-indigo-700 leading-relaxed">{desc}</p>
                      </div>
                    </li>
                  ))}
                </ol>

                <div className="rounded-lg border border-indigo-200 bg-white/70 p-3 space-y-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-500 mb-2">Rule types</p>
                  {[
                    { tag: "Fixed",   color: "bg-blue-100 text-blue-700",   desc: "Sends a fixed amount every interval, regardless of balance." },
                    { tag: "Pull",    color: "bg-amber-100 text-amber-700",  desc: "Monitors the source — when balance exceeds a threshold, pulls the excess to the destination." },
                    { tag: "Top-up",  color: "bg-purple-100 text-purple-700", desc: "Monitors the destination — when balance drops below a threshold, tops it up from the source." },
                  ].map(({ tag, color, desc }) => (
                    <div key={tag} className="flex items-start gap-2">
                      <span className={`mt-0.5 shrink-0 rounded-full px-1.5 py-px text-[10px] font-bold uppercase ${color}`}>{tag}</span>
                      <p className="text-xs text-slate-600">{desc}</p>
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => { setShowAddForm(true); setEditingRule(null); }}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 py-2.5 text-xs font-bold text-white hover:bg-indigo-700 transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  Add your first rule
                </button>
              </div>
            ) : autoRules.length > 0 && (
              <div>
                <button
                  onClick={() => setShowGuide((v) => !v)}
                  className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-indigo-600 transition-colors mb-2"
                >
                  <Info className="h-3.5 w-3.5" />
                  How it works
                  {showGuide ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
                {showGuide && (
                  <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2 text-xs text-slate-600">
                    <p><span className="font-semibold text-slate-700">Fixed</span> — sends a set amount every interval.</p>
                    <p><span className="font-semibold text-slate-700">Pull</span> — when source balance exceeds a threshold, pulls the excess.</p>
                    <p><span className="font-semibold text-slate-700">Top-up</span> — when destination drops below a threshold, tops it up from source.</p>
                    <p className="pt-1 text-slate-400">Set an interval, enable your rules, then click <span className="font-semibold text-emerald-600">Start</span>.</p>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              {/* (empty state now handled by guide above) */}

              {autoRules.map((rule) => (
                <div key={rule.id}>
                  {editingRule?.id === rule.id ? (
                    <RuleForm
                      initial={editingRule}
                      accounts={accounts}
                      onSave={handleSaveRule}
                      onCancel={() => setEditingRule(null)}
                    />
                  ) : (
                    <div className={`rounded-xl border px-4 py-3 ${
                      rule.enabled ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50 opacity-60"
                    }`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-slate-800 truncate">
                              {rule.label || `${rule.from} → ${rule.to}`}
                            </span>
                            <span className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-bold uppercase ${
                              rule.type === "fixed" ? "bg-blue-100 text-blue-600"
                              : rule.type === "pull" ? "bg-amber-100 text-amber-700"
                              : "bg-purple-100 text-purple-700"
                            }`}>
                              {ruleTypeLabel[rule.type]}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-slate-500 truncate">
                            {rule.from} [{walletLabel(rule.fromWalletType ?? "UMFUTURE")}] → {rule.to} [{walletLabel(rule.toWalletType ?? "UMFUTURE")}] · {rule.asset}
                            {rule.type === "fixed" && ` · ${rule.amount} ${rule.asset}`}
                            {rule.type === "pull"  && ` · pull above ${rule.pullAbove}, keep ${rule.keepBalance}`}
                            {rule.type === "topup" && ` · top-up to ${rule.topUpTo} when < ${rule.topUpBelow}`}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            onClick={() => handleToggleRule(rule.id)}
                            className={`h-5 w-9 rounded-full transition-colors ${rule.enabled ? "bg-emerald-500" : "bg-slate-200"}`}
                          >
                            <span className={`block h-4 w-4 rounded-full bg-white shadow transition-transform mx-0.5 ${rule.enabled ? "translate-x-4" : "translate-x-0"}`} />
                          </button>
                          <button onClick={() => { setEditingRule(rule); setShowAddForm(false); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => handleDeleteRule(rule.id)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {showAddForm && !editingRule && (
                <RuleForm
                  initial={blankRule(accounts)}
                  accounts={accounts}
                  onSave={handleSaveRule}
                  onCancel={() => setShowAddForm(false)}
                />
              )}

              {!showAddForm && !editingRule && (
                <button
                  onClick={() => { setShowAddForm(true); setEditingRule(null); }}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-300 py-2.5 text-xs font-semibold text-slate-500 hover:border-indigo-400 hover:text-indigo-600 transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  Add Rule
                </button>
              )}
            </div>

            {autoLog.length > 0 && (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Activity Log</p>
                  <button onClick={() => { setAutoLog([]); void apiAutoClearLog(creds).catch(() => {}); }} className="text-xs text-slate-400 hover:text-slate-700">Clear</button>
                </div>
                <div className="space-y-0 rounded-xl border border-slate-200 overflow-hidden">
                  {autoLog.map((entry) => (
                    <div key={entry.id} className={`flex items-start gap-2 px-3 py-2 text-xs border-b border-slate-100 last:border-0 ${
                      entry.status === "ok"    ? "bg-emerald-50"
                      : entry.status === "error" ? "bg-red-50"
                      : "bg-white"
                    }`}>
                      <span className="shrink-0 font-mono text-slate-400">{entry.time}</span>
                      <span className={`shrink-0 font-bold ${
                        entry.status === "ok"    ? "text-emerald-600"
                        : entry.status === "error" ? "text-red-600"
                        : "text-slate-400"
                      }`}>
                        {entry.status === "ok" ? "✓" : entry.status === "error" ? "✗" : "↷"}
                      </span>
                      <div className="min-w-0">
                        <span className="font-semibold text-slate-700">{entry.rule}</span>
                        <span className="text-slate-500"> — {entry.msg}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
