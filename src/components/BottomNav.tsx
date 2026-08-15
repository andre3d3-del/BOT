import { ArrowLeftRight, Bot, LayoutDashboard, Settings } from "lucide-react";

type Tab = "dashboard" | "bots" | "transfers" | "settings";

export function BottomNav({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const items: { id: Tab; label: string; icon: typeof Bot }[] = [
    { id: "dashboard", label: "Home",      icon: LayoutDashboard },
    { id: "bots",      label: "Bot",       icon: Bot },
    { id: "transfers", label: "Transfers", icon: ArrowLeftRight },
    { id: "settings",  label: "Settings",  icon: Settings },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-slate-200 bg-white/95 backdrop-blur-sm md:hidden">
      <div className="flex h-16 items-stretch">
        {items.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onTab(id)}
              className="relative flex flex-1 flex-col items-center justify-center gap-1 transition-colors active:bg-slate-50"
            >
              {active && (
                <span className="absolute top-0 left-1/2 h-0.5 w-10 -translate-x-1/2 rounded-full bg-indigo-500" />
              )}
              <Icon
                className={`h-5 w-5 transition-colors ${active ? "text-indigo-600" : "text-slate-400"}`}
                strokeWidth={active ? 2.5 : 2}
              />
              <span className={`text-[10px] font-semibold tracking-wide transition-colors ${
                active ? "text-indigo-600" : "text-slate-400"
              }`}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
