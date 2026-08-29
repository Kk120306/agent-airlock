import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/phase9-ui",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
