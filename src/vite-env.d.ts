/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BINANCE_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
