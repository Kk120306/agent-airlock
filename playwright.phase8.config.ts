import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/phase8-e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3208",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "AIRLOCK_DEMO_PORT=3208 AIRLOCK_DEMO_DATA_ROOT=.e2e-phase8 node scripts/run-phase-eight-demo.mjs --reset",
    url: "http://127.0.0.1:3208/api/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
