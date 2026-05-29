import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Cpu,
  GitBranch,
  KeyRound,
  Link2,
  ListOrdered,
  RefreshCw,
  ShieldCheck,
  Target,
  TrendingUp,
  Zap,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useCredentials } from "@/context/CredentialsContext";

// ── Flow pipeline step ───────────────────────────────────────────────────────

function FlowStep({
  icon: Icon,
  label,
  detail,
  accent,
  last,
}: {
  icon: typeof Zap;
  label: string;
  detail: string;
  accent: string;
  last?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-start gap-3">
      <div className="flex flex-col items-center">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ${accent}`}
        >
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </div>
        {!last && (
          <div className="mt-2 h-full w-px bg-slate-200" style={{ minHeight: "2rem" }} />
        )}
      </div>
      <div className="min-w-0 pb-6">
        <p className="text-[13px] font-semibold text-slate-800">{label}</p>
        <p className="mt-0.5 text-[12px] leading-snug text-slate-500">{detail}</p>
      </div>
    </div>
  );
}

// ── Checklist row ────────────────────────────────────────────────────────────

function CheckRow({ done, text }: { done: boolean; text: string }) {
  return (
    <div className="flex items-start gap-2.5 py-2">
      {done ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" strokeWidth={2} />
      ) : (
        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" strokeWidth={2} />
      )}
      <span className={`text-sm leading-snug ${done ? "text-slate-700" : "text-slate-500"}`}>
        {text}
      </span>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function DashboardHome() {
  const navigate = useNavigate();
  const { apiKey, connectionName, activeSlot } = useCredentials();
  const connected = Boolean(apiKey.trim());

  const flowSteps: {
    icon: typeof Zap;
    label: string;
    detail: string;
    accent: string;
  }[] = [
    {
      icon: Target,
      label: "Set entry price",
      detail: "Pick your anchor price — the line that acts as your single TP target.",
      accent: "bg-indigo-50 text-indigo-600 ring-indigo-200",
    },
    {
      icon: ListOrdered,
      label: "Configure the grid",
      detail: "Choose step count, $ per step and spacing %. Preview the TP table before sending.",
      accent: "bg-violet-50 text-violet-600 ring-violet-200",
    },
    {
      icon: Link2,
      label: "Send to Binance",
      detail: "All limit orders land in your Futures account in one click. Cancel anytime.",
      accent: "bg-sky-50 text-sky-600 ring-sky-200",
    },
    {
      icon: Cpu,
      label: "Auto-fill watcher",
      detail: "The backend session watches the account stream. When an order fills, TP fires.",
      accent: "bg-amber-50 text-amber-600 ring-amber-200",
    },
    {
      icon: RefreshCw,
      label: "Cycle repeats",
      detail: "Each fill triggers a fresh TP. Stop the session whenever you want to exit.",
      accent: "bg-emerald-50 text-emerald-600 ring-emerald-200",
    },
  ];

  return (
    <div className="space-y-6">
      {/* ── Status hero ─────────────────────────────────────────────────── */}
      <div className="ui-card overflow-hidden">
        <div className="flex items-stretch divide-x divide-slate-100">
          {/* Connection state */}
          <div className="flex min-w-0 flex-1 flex-col justify-between gap-3 p-5 sm:p-6">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              <KeyRound className="h-3.5 w-3.5" />
              Exchange connection
            </div>
            {connected ? (
              <div>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-500 shadow shadow-emerald-200" />
                  <span className="text-base font-bold text-slate-900">
                    {connectionName || `Account ${activeSlot}`}
                  </span>
                  <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">
                    Slot {activeSlot}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-500">
                  Futures API key on file — USD-M perpetuals ready.
                </p>
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-amber-400" />
                  <span className="text-base font-bold text-slate-900">Not connected</span>
                </div>
                <p className="mt-1 text-sm text-slate-500">
                  No API key on file. Add one in Settings to go live.
                </p>
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => navigate("/bot")}
                className="ui-btn-primary gap-1.5 px-4 py-2 text-[13px]"
              >
                <TrendingUp className="h-3.5 w-3.5" />
                Open Bot
              </button>
              <button
                type="button"
                onClick={() => navigate("/settings")}
                className="ui-btn-secondary px-4 py-2 text-[13px]"
              >
                {connected ? "Manage keys" : "Add keys"}
              </button>
            </div>
          </div>

          {/* Mode badge */}
          <div className="hidden shrink-0 flex-col items-center justify-center gap-1.5 px-8 sm:flex">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600 shadow-lg shadow-indigo-200">
              <Zap className="h-7 w-7 text-white" strokeWidth={2.5} />
            </div>
            <span className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Grid TP Pro
            </span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-400">
              Futures · USD-M
            </span>
          </div>

          {/* Security badge */}
          <div className="hidden shrink-0 flex-col items-start justify-center gap-2 px-6 sm:flex">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              <ShieldCheck className="h-3.5 w-3.5" />
              Security
            </div>
            <ul className="space-y-1.5 text-[12px] text-slate-500">
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Keys stored locally only
              </li>
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                No withdrawals needed
              </li>
              <li className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                Whitelist your IP on Binance
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* ── How the cycle works ─────────────────────────────────────────── */}
      <div className="ui-card p-5 sm:p-6">
        <div className="mb-5 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600">
            <GitBranch className="h-4 w-4 text-white" strokeWidth={2} />
          </div>
          <h2 className="text-base font-semibold text-slate-900">How the cycle works</h2>
          <ArrowRight className="h-4 w-4 text-slate-300" />
          <span className="text-sm text-slate-400">Entry → Fill → TP → Repeat</span>
        </div>

        {/* Desktop: horizontal pipeline */}
        <div className="hidden gap-0 sm:flex">
          {flowSteps.map((step, i) => (
            <div key={step.label} className="flex min-w-0 flex-1 items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-col items-center gap-2 text-center">
                <div
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1 ${step.accent}`}
                >
                  <step.icon className="h-5 w-5" strokeWidth={1.75} />
                </div>
                <p className="text-[12px] font-semibold leading-tight text-slate-800">
                  {step.label}
                </p>
                <p className="text-[11px] leading-snug text-slate-400">{step.detail}</p>
              </div>
              {i < flowSteps.length - 1 && (
                <div className="mt-[1.375rem] shrink-0 px-1 text-slate-300">
                  <ArrowRight className="h-4 w-4" />
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Mobile: vertical flow */}
        <div className="flex flex-col gap-0 sm:hidden">
          {flowSteps.map((step, i) => (
            <FlowStep
              key={step.label}
              icon={step.icon}
              label={step.label}
              detail={step.detail}
              accent={step.accent}
              last={i === flowSteps.length - 1}
            />
          ))}
        </div>
      </div>

      {/* ── Bottom grid: setup checklist + key rules ─────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Setup checklist */}
        <div className="ui-card p-5 sm:p-6">
          <h2 className="mb-4 text-sm font-semibold text-slate-900">Quick setup checklist</h2>
          <div className="divide-y divide-slate-100">
            <CheckRow
              done={connected}
              text="Add a Binance USD-M Futures API key in Settings"
            />
            <CheckRow
              done={false}
              text="Whitelist your outbound IP on Binance API Management"
            />
            <CheckRow
              done={false}
              text="Open Bot → pick a trading pair from the left panel"
            />
            <CheckRow
              done={false}
              text="Set entry price, grid steps and $ per step"
            />
            <CheckRow
              done={false}
              text="Send the grid — watch orders land on Binance"
            />
            <CheckRow
              done={false}
              text="Enable Auto TP to let fills trigger take-profits"
            />
          </div>
          {!connected && (
            <button
              type="button"
              onClick={() => navigate("/settings")}
              className="mt-4 w-full rounded-lg border border-dashed border-indigo-300 py-2.5 text-sm font-medium text-indigo-600 transition hover:border-indigo-400 hover:bg-indigo-50"
            >
              + Connect Binance to start
            </button>
          )}
        </div>

        {/* Key rules */}
        <div className="ui-card divide-y divide-slate-100 p-5 sm:p-6">
          <h2 className="mb-4 text-sm font-semibold text-slate-900">Rules to trade by</h2>

          {[
            {
              emoji: "🔑",
              rule: "One restricted key",
              note: "Futures trading on · Withdrawals off · IP-locked",
              bg: "bg-indigo-50",
            },
            {
              emoji: "💰",
              rule: "Small $ per step first",
              note: "Scale up only after watching at least one full cycle complete.",
              bg: "bg-emerald-50",
            },
            {
              emoji: "📐",
              rule: "Hedge mode = intentional",
              note: "Only enable if Binance shows LONG and SHORT columns separately.",
              bg: "bg-amber-50",
            },
            {
              emoji: "🚨",
              rule: "Session = exchange listener",
              note: "Stop the session before manually cancelling orders to avoid TP misfires.",
              bg: "bg-red-50",
            },
          ].map(({ emoji, rule, note, bg }) => (
            <div key={rule} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base ${bg}`}
              >
                {emoji}
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-slate-800">{rule}</p>
                <p className="text-[12px] leading-snug text-slate-500">{note}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
