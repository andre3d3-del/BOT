import dns from "node:dns";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Avoid Windows/macOS quirks where localhost maps to IPv6 ::1 while the server
// only listens on IPv4 — that shows as "connection refused" in the browser.
dns.setDefaultResultOrder("ipv4first");

export default defineConfig({
  plugins: [basicSsl(), react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
});
