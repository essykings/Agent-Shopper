import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Run `npm run app:mock` (or `npm run app`) for the server on port 3000, then `npm run web:dev` for live editing.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://localhost:3000" } },
});
