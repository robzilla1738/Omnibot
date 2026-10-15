import { defineConfig } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT || 1420);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests",
  use: { baseURL, browserName: process.env.PLAYWRIGHT_BROWSER === "webkit" ? "webkit" : "chromium", channel: process.env.PLAYWRIGHT_CHANNEL || undefined, viewport: { width: 1280, height: 840 } },
  webServer: { command: `pnpm dev --port ${port} --strictPort`, url: baseURL, reuseExistingServer: !process.env.CI },
});
