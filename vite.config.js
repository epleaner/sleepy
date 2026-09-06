import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000"
    }
  },
  preview: {
    allowedHosts: ["nappy-production.up.railway.app"]
  }
});
