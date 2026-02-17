import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [dts({ rollupTypes: true })],
  build: {
    lib: {
      entry: "src/pulse-sync.ts",
      name: "PulseSync",
      fileName: "pulse-sync",
      formats: ["es", "umd"],
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
