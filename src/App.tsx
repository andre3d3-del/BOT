import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { CredentialsProvider } from "@/context/CredentialsContext";
import { loadActiveSymbol, persistActiveSymbol } from "@/lib/tradingPrefsStorage";
import { BottomNav } from "@/components/BottomNav";
import { DashboardHome } from "@/components/DashboardHome";
import { IpBanner } from "@/components/IpBanner";
import { SettingsPanel } from "@/components/SettingsPanel";
import { TopNav } from "@/components/TopNav";
import { StrategyPanel } from "@/components/StrategyPanel";
import { TransferPanel } from "@/components/TransferPanel";
import { WatchlistPanel } from "@/components/WatchlistPanel";

type Tab = "dashboard" | "bots" | "transfers" | "settings";

function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [symbol, setSymbol] = useState(loadActiveSymbol);
  // Mobile-only: which panel to show on the Bot page
  const [mobileBotTab, setMobileBotTab] = useState<"pairs" | "strategy">("strategy");

  useEffect(() => {
    persistActiveSymbol(symbol);
  }, [symbol]);

  const path = location.pathname.toLowerCase();
  const tab: Tab =
    path === "/bot"       ? "bots"      :
    path === "/transfers" ? "transfers" :
    path === "/settings"  ? "settings"  : "dashboard";

  const handleTab = (next: Tab) => {
    if (next === "bots")      { navigate("/bot");       return; }
    if (next === "transfers") { navigate("/transfers"); return; }
    if (next === "settings")  { navigate("/settings");  return; }
    navigate("/");
  };

  return (
    <div className="flex h-full flex-col">
      {/* ── Top nav (desktop only) ── */}
      <TopNav tab={tab} onTab={handleTab} activeSymbol={symbol} />

      {/* ── Page body ── */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <Routes>

          {/* Dashboard */}
          <Route
            path="/"
            element={
              <div className="h-full overflow-y-auto bg-slate-50 pb-16 md:pb-0">
                <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
                  <DashboardHome />
                </div>
              </div>
            }
          />

          {/* Bot */}
          <Route
            path="/bot"
            element={
              <div className="flex h-full flex-col overflow-hidden">

                {/* Mobile tab switcher — Pairs / Strategy */}
                <div className="flex shrink-0 border-b border-slate-200 bg-white md:hidden">
                  {(["pairs", "strategy"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setMobileBotTab(t)}
                      className={`flex-1 py-3 text-sm font-semibold transition-colors border-b-2 ${
                        mobileBotTab === t
                          ? "border-indigo-600 text-indigo-700"
                          : "border-transparent text-slate-400"
                      }`}
                    >
                      {t === "pairs" ? "Pairs" : "Strategy"}
                    </button>
                  ))}
                </div>

                {/* Content area */}
                <div className="flex min-h-0 flex-1 overflow-hidden">

                  {/* Pair list sidebar */}
                  <aside className={`shrink-0 overflow-y-auto border-slate-200 bg-white md:flex md:w-56 md:border-r ${
                    mobileBotTab === "pairs" ? "flex w-full" : "hidden"
                  }`}>
                    <WatchlistPanel
                      activeSymbol={symbol}
                      onSelect={(s) => {
                        setSymbol(s);
                        setMobileBotTab("strategy"); // switch to strategy after picking a pair
                      }}
                    />
                  </aside>

                  {/* Strategy + orders */}
                  <div className={`min-w-0 flex-1 overflow-hidden md:flex ${
                    mobileBotTab === "strategy" ? "flex" : "hidden"
                  }`}>
                    <StrategyPanel symbol={symbol} />
                  </div>

                </div>
              </div>
            }
          />

          {/* Transfers */}
          <Route
            path="/transfers"
            element={
              <div className="flex h-full overflow-hidden">
                <TransferPanel />
              </div>
            }
          />

          {/* Settings */}
          <Route
            path="/settings"
            element={
              <div className="h-full overflow-y-auto bg-slate-50 pb-16 md:pb-0">
                <div className="mx-auto max-w-xl px-4 py-6 sm:px-6 sm:py-8">
                  <SettingsPanel />
                </div>
              </div>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>

      {/* ── Footer IP banner (desktop only — bottom nav takes this space on mobile) ── */}
      <div className="hidden md:block">
        <IpBanner />
      </div>

      {/* ── Bottom nav (mobile only) ── */}
      <BottomNav tab={tab} onTab={handleTab} />
    </div>
  );
}

export default function App() {
  return (
    <CredentialsProvider>
      <Shell />
    </CredentialsProvider>
  );
}
