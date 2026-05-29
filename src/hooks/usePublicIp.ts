import { useCallback, useEffect, useState } from "react";

type IpState =
  | { status: "loading" }
  | { status: "ok"; ipv4: string }
  | { status: "error"; message: string };

export function usePublicIp(): IpState & { refresh: () => void } {
  const [state, setState] = useState<IpState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const r = await fetch("https://api.ipify.org?format=json", {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(r.statusText);
      const j = (await r.json()) as { ip?: string };
      if (!j.ip) throw new Error("No IP in response");
      setState({ status: "ok", ipv4: j.ip });
    } catch (e) {
      setState({
        status: "error",
        message: e instanceof Error ? e.message : "Failed to load IP",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, refresh: load };
}
