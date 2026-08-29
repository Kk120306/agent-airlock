import { defineConfig } from "@playwright/test";

const producerPort = 3212;
const receiverPort = 3213;

export default defineConfig({
  testDir: "./tests/phase12-real",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  use: {
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command:
        "AIRLOCK_DEMO_PORT=3212 AIRLOCK_DEMO_DATA_ROOT=.e2e-phase12-producer node scripts/run-phase-ten-demo.mjs --reset",
      url: `http://127.0.0.1:${producerPort}/api/health`,
      timeout: 30_000,
      reuseExistingServer: false,
    },
    {
      command:
        "AIRLOCK_DEMO_PORT=3213 AIRLOCK_DEMO_DATA_ROOT=.e2e-phase12-receiver node scripts/run-phase-ten-demo.mjs --reset",
      url: `http://127.0.0.1:${receiverPort}/api/health`,
      timeout: 30_000,
      reuseExistingServer: false,
    },
  ],
});
