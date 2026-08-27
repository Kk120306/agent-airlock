import { defineConfig } from "@playwright/test";

const port = 3221;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/container-browser",
  globalTeardown: "./tests/container-browser/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL,
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "AIRLOCK_CONTAINER_DEMO_PORT=3221 AIRLOCK_CONTAINER_DEMO_FIXTURE_PORT=43994 node scripts/run-container-browser-fixture.mjs --demo --ephemeral",
    url: `${baseURL}/api/health`,
    timeout: 30_000,
    reuseExistingServer: false,
  },
});
