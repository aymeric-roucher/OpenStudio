import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the built site works from any folder (e.g. GitHub Pages at /OpenStudio/).
  base: "./",
  // Pre-bundle heavy deps so the dev server does not reload the page the first time they are used.
  optimizeDeps: { include: ["@huggingface/transformers", "mediabunny", "gifenc"] },
  worker: { format: "es" },
});
