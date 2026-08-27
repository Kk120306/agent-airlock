import { defineConfig } from "@playwright/test";

const port = 3211;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/phase11-real",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 45_000,
  use: {
    baseURL,
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "AIRLOCK_DEMO_PORT=3211 AIRLOCK_DEMO_DATA_ROOT=.e2e-phase11-real node scripts/run-phase-eleven-demo.mjs --reset",
    url: `${baseURL}/api/health`,
    timeout: 30_000,
    reuseExistingServer: false,
  },
});
