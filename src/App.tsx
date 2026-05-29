import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { CredentialsProvider } from "@/context/CredentialsContext";
import { loadActiveSymbol, persistActiveSymbol } from "@/lib/tradingPrefsStorage";
import { DashboardHome } from "@/components/DashboardHome";
import { IpBanner } from "@/components/IpBanner";
import { SettingsPanel } from "@/components/SettingsPanel";
import { TopNav } from "@/components/TopNav";
import { StrategyPanel } from "@/components/StrategyPanel";
import { WatchlistPanel } from "@/components/WatchlistPanel";

type Tab = "dashboard" | "bots" | "settings";

function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [symbol, setSymbol] = useState(loadActiveSymbol);

  useEffect(() => {
    persistActiveSymbol(symbol);
  }, [symbol]);

  const path = location.pathname.toLowerCase();
  const tab: Tab =
    path === "/bot" ? "bots" : path === "/settings" ? "settings" : "dashboard";

  const handleTab = (next: Tab) => {
    if (next === "bots") { navigate("/bot"); return; }
    if (next === "settings") { navigate("/settings"); return; }
    navigate("/");
  };

  return (
    <div className="flex h-full flex-col">
      {/* ── Top navigation bar ── */}
      <TopNav tab={tab} onTab={handleTab} activeSymbol={symbol} />

      {/* ── Page body ── */}
      <div className="relative min-h-0 flex-1">
        <Routes>
          {/* Dashboard — scrollable page */}
          <Route
            path="/"
            element={
              <div className="h-full overflow-y-auto bg-slate-50">
                <div className="mx-auto max-w-5xl px-6 py-8 sm:px-8">
                  <DashboardHome />
                </div>
              </div>
            }
          />

          {/* Bot — fixed-height 3-column layout, each column scrolls independently */}
          <Route
            path="/bot"
            element={
              <div className="flex h-full overflow-hidden">
                {/* Column 1 — Pair selector */}
                <aside className="w-56 shrink-0 overflow-y-auto border-r border-slate-200 bg-white">
                  <WatchlistPanel activeSymbol={symbol} onSelect={setSymbol} />
                </aside>

                {/* Columns 2 + 3 — Strategy config and live orders (split inside StrategyPanel) */}
                <div className="min-w-0 flex-1 overflow-hidden">
                  <StrategyPanel symbol={symbol} />
                </div>
              </div>
            }
          />

          {/* Settings — scrollable page */}
          <Route
            path="/settings"
            element={
              <div className="h-full overflow-y-auto bg-slate-50">
                <div className="mx-auto max-w-xl px-6 py-8 sm:px-8">
                  <SettingsPanel />
                </div>
              </div>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>

      {/* ── Footer / IP banner ── */}
      <IpBanner />
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
