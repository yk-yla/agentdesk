import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const browserPreview = mode === "browser-preview";
  return {
    root: path.join(sourceDir, "renderer"),
    base: "./",
    plugins: [react()],
    define: {
      __CODEX_BROWSER_PREVIEW__: JSON.stringify(browserPreview),
    },
    build: {
      outDir: path.join(sourceDir, browserPreview ? "../build/preview" : "../build/renderer"),
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks: {
            "react-vendor": ["react", "react-dom"],
          },
        },
      },
    },
  };
});
