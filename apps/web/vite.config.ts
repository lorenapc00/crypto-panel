import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()], server: { port: 5174, strictPort: true, proxy: { "/api": process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3100" } } });
