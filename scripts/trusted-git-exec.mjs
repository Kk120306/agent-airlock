import {
  execFile as execFileCallback,
  execFileSync as execFileSyncDefault,
} from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const trustedGitExecutable = "/usr/bin/git";

export function trustedGitEnvironment(environment = process.env) {
  if (
    environment === null ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    throw new TypeError("A process environment object is required");
  }

  const trusted = {};
  for (const [name, value] of Object.entries(environment)) {
    if (
      name === "PATH" ||
      name.startsWith("GIT_") ||
      typeof value !== "string"
    ) {
      continue;
    }
    trusted[name] = value;
  }

  trusted.PATH = "/usr/bin:/bin";
  trusted.GIT_CONFIG_GLOBAL = "/dev/null";
  trusted.GIT_CONFIG_NOSYSTEM = "1";
  trusted.GIT_CONFIG_COUNT = "3";
  trusted.GIT_CONFIG_KEY_0 = "core.fsmonitor";
  trusted.GIT_CONFIG_VALUE_0 = "false";
  trusted.GIT_CONFIG_KEY_1 = "core.untrackedCache";
  trusted.GIT_CONFIG_VALUE_1 = "false";
  trusted.GIT_CONFIG_KEY_2 = "core.hooksPath";
  trusted.GIT_CONFIG_VALUE_2 = "/dev/null";
  trusted.GIT_NO_REPLACE_OBJECTS = "1";
  trusted.GIT_OPTIONAL_LOCKS = "0";
  return trusted;
}

function trustedGitOptions(options = {}) {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    throw new TypeError("Git execution options must be an object");
  }
  return {
    ...options,
    env: trustedGitEnvironment(options.env ?? process.env),
  };
}

export function runTrustedGit(
  argumentsList,
  options = {},
  execute = execFile,
) {
  return execute(
    trustedGitExecutable,
    argumentsList,
    trustedGitOptions(options),
  );
}

export function runTrustedGitSync(
  argumentsList,
  options = {},
  execute = execFileSyncDefault,
) {
  return execute(
    trustedGitExecutable,
    argumentsList,
    trustedGitOptions(options),
  );
}
