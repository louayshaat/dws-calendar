import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // In dev, proxy /api calls to the local Express server
  server: {
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
