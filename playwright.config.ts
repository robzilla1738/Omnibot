import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: { baseURL: "http://localhost:1420", browserName: "chromium", channel: process.env.PLAYWRIGHT_CHANNEL || undefined, viewport: { width: 1280, height: 840 } },
  webServer: { command: "pnpm dev", url: "http://localhost:1420", reuseExistingServer: !process.env.CI },
});
