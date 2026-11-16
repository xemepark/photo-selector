import { defineConfig } from "vite";

// Tauri 開發模式固定使用 1420 port
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022" },
});
