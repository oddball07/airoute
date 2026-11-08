/** Silent `Logger` for tests that captures warn/info lines for assertions. */
import type { Logger } from "@airoute/core";

export interface TestLogger {
  logger: Logger;
  warns: string[];
  infos: string[];
}

export function createTestLogger(): TestLogger {
  const warns: string[] = [];
  const infos: string[] = [];
  const logger: Logger = {
    debug() {},
    info(message: string) {
      infos.push(message);
    },
    warn(message: string) {
      warns.push(message);
    },
    error() {},
    child() {
      return logger;
    },
  };
  return { logger, warns, infos };
}
