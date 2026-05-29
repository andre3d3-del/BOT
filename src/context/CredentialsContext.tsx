import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type StoredCreds = {
  apiKey: string;
  apiSecret: string;
  connectionName: string;
  /** UI preference — wire to futures position sync later. */
  importOpenPositions: boolean;
};

export type AccountSlotId = "A" | "B";
type StoredCredsV2 = {
  activeSlot: AccountSlotId;
  accounts: Record<AccountSlotId, StoredCreds>;
};

const STORAGE_KEY = "binance_futures_creds_v2";

function emptyCreds(name: string): StoredCreds {
  return {
    apiKey: "",
    apiSecret: "",
    connectionName: name,
    importOpenPositions: true,
  };
}

function load(): StoredCredsV2 {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacyRaw = localStorage.getItem("binance_futures_creds_v1");
      if (legacyRaw) {
        const legacy = JSON.parse(legacyRaw) as Partial<StoredCreds>;
        return {
          activeSlot: "A",
          accounts: {
            A: {
              apiKey: legacy.apiKey ?? "",
              apiSecret: legacy.apiSecret ?? "",
              connectionName:
                typeof legacy.connectionName === "string" ? legacy.connectionName : "Account A",
              importOpenPositions: legacy.importOpenPositions !== false,
            },
            B: emptyCreds("Account B"),
          },
        };
      }
      return {
        activeSlot: "A",
        accounts: {
          A: emptyCreds("Account A"),
          B: emptyCreds("Account B"),
        },
      };
    }
    const j = JSON.parse(raw) as Partial<StoredCredsV2>;
    const asAccount = (x: Partial<StoredCreds> | undefined, fallback: string): StoredCreds => ({
      apiKey: x?.apiKey ?? "",
      apiSecret: x?.apiSecret ?? "",
      connectionName: typeof x?.connectionName === "string" ? x.connectionName : fallback,
      importOpenPositions: x?.importOpenPositions !== false,
    });
    return {
      activeSlot: j.activeSlot === "B" ? "B" : "A",
      accounts: {
        A: asAccount(j.accounts?.A, "Account A"),
        B: asAccount(j.accounts?.B, "Account B"),
      },
    };
  } catch {
    return {
      activeSlot: "A",
      accounts: {
        A: emptyCreds("Account A"),
        B: emptyCreds("Account B"),
      },
    };
  }
}

type Ctx = StoredCreds & {
  accounts: Record<AccountSlotId, StoredCreds>;
  activeSlot: AccountSlotId;
  setActiveSlot: (slot: AccountSlotId) => void;
  setApiKey: (v: string) => void;
  setApiSecret: (v: string) => void;
  setConnectionName: (v: string) => void;
  setImportOpenPositions: (v: boolean) => void;
  save: () => void;
  clear: () => void;
};

const CredentialsContext = createContext<Ctx | null>(null);

export function CredentialsProvider({ children }: { children: ReactNode }) {
  const loaded = load();
  const [accounts, setAccounts] = useState<Record<AccountSlotId, StoredCreds>>(loaded.accounts);
  const [activeSlot, setActiveSlot] = useState<AccountSlotId>(loaded.activeSlot);

  const active = accounts[activeSlot];
  const apiKey = active.apiKey;
  const apiSecret = active.apiSecret;
  const connectionName = active.connectionName;
  const importOpenPositions = active.importOpenPositions;

  const setApiKey = useCallback(
    (v: string) =>
      setAccounts((prev) => ({ ...prev, [activeSlot]: { ...prev[activeSlot], apiKey: v } })),
    [activeSlot]
  );
  const setApiSecret = useCallback(
    (v: string) =>
      setAccounts((prev) => ({ ...prev, [activeSlot]: { ...prev[activeSlot], apiSecret: v } })),
    [activeSlot]
  );
  const setConnectionName = useCallback(
    (v: string) =>
      setAccounts((prev) => ({ ...prev, [activeSlot]: { ...prev[activeSlot], connectionName: v } })),
    [activeSlot]
  );
  const setImportOpenPositions = useCallback(
    (v: boolean) =>
      setAccounts((prev) => ({
        ...prev,
        [activeSlot]: { ...prev[activeSlot], importOpenPositions: v },
      })),
    [activeSlot]
  );

  const save = useCallback(() => {
    const payload: StoredCredsV2 = {
      activeSlot,
      accounts,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [accounts, activeSlot]);

  const clear = useCallback(() => {
    setAccounts((prev) => ({
      ...prev,
      [activeSlot]: emptyCreds(activeSlot === "A" ? "Account A" : "Account B"),
    }));
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeSlot,
        accounts: {
          ...accounts,
          [activeSlot]: emptyCreds(activeSlot === "A" ? "Account A" : "Account B"),
        },
      } satisfies StoredCredsV2)
    );
  }, [accounts, activeSlot]);

  const value = useMemo(
    () => ({
      accounts,
      activeSlot,
      setActiveSlot,
      apiKey,
      apiSecret,
      connectionName,
      importOpenPositions,
      setApiKey,
      setApiSecret,
      setConnectionName,
      setImportOpenPositions,
      save,
      clear,
    }),
    [
      accounts,
      activeSlot,
      setActiveSlot,
      apiKey,
      apiSecret,
      connectionName,
      importOpenPositions,
      save,
      clear,
    ]
  );

  return (
    <CredentialsContext.Provider value={value}>{children}</CredentialsContext.Provider>
  );
}

export function useCredentials(): Ctx {
  const v = useContext(CredentialsContext);
  if (!v) throw new Error("CredentialsProvider missing");
  return v;
}
