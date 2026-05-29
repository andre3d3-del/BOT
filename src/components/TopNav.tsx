import { Bot, LayoutDashboard, Settings, Zap } from "lucide-react";

type Tab = "dashboard" | "bots" | "settings";

export function TopNav({
  tab,
  onTab,
  activeSymbol,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  activeSymbol?: string;
}) {
  const navItems: { id: Tab; label: string; icon: typeof Bot }[] = [
    { id: "dashboard", label: "Home", icon: LayoutDashboard },
    { id: "bots", label: "Bot", icon: Bot },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  return (
    <header className="flex h-14 shrink-0 items-center border-b border-slate-200 bg-white px-4 sm:px-6">
      {/* Logo */}
      <div className="flex items-center gap-2.5 pr-8">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600">
          <Zap className="h-4 w-4 text-white" strokeWidth={2.5} />
        </div>
        <span className="text-sm font-bold tracking-tight text-slate-900">Grid TP Pro</span>
      </div>

      {/* Navigation */}
      <nav className="flex items-center gap-1" aria-label="Main">
        {navItems.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onTab(id)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-indigo-50 text-indigo-700"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              }`}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={active ? 2.5 : 2} />
              {label}
            </button>
          );
        })}
      </nav>

      {/* Right side */}
      <div className="ml-auto flex items-center gap-3">
        {tab === "bots" && activeSymbol && (
          <div className="flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            <span className="text-xs font-semibold text-indigo-700">{activeSymbol}</span>
          </div>
        )}
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          Futures · USD-M
        </span>
      </div>
    </header>
  );
}
