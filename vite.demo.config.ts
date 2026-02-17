import { defineConfig } from "vite";

export default defineConfig({
  root: "demo",
  server: {
    fs: { strict: false },
  },
  build: {
    outDir: "../dist/demo",
    emptyOutDir: true,
  },
});
