import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Pre-bundle heavy deps so the dev server does not reload the page the first time they are used.
  optimizeDeps: { include: ["@huggingface/transformers", "mediabunny", "gifenc"] },
  worker: { format: "es" },
});
