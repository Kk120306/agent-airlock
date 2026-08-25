import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/demo-e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3200",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "AIRLOCK_DEMO_PORT=3200 AIRLOCK_DEMO_DATA_ROOT=.e2e-demo node scripts/run-demo.mjs --reset",
    url: "http://127.0.0.1:3200/api/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
