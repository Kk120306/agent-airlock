import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3199",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node tests/fixtures/start-baseline-server.mjs",
    url: "http://127.0.0.1:3199/api/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
