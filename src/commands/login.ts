import { runDeviceLogin, runLogin } from "../auth/login.js";
import {
  CloudflareChallengeError,
  DeviceFlowError,
  DeviceFlowNotEnabledError,
} from "../auth/device.js";
import {
  formatCloudflareChallenge,
  formatDeviceFlowNotEnabled,
  printError,
} from "../cli/help-errors.js";

export interface LoginCmdOptions {
  noBrowser?: boolean;
  /** Use OpenAI's device-code flow instead of the loopback browser flow. */
  deviceCode?: boolean;
}

export async function loginCommand(opts: LoginCmdOptions): Promise<number> {
  if (opts.deviceCode) {
    try {
      await runDeviceLogin({ noBrowser: opts.noBrowser });
      return 0;
    } catch (err) {
      if (err instanceof DeviceFlowNotEnabledError) {
        printError(formatDeviceFlowNotEnabled());
        return 1;
      }
      if (err instanceof CloudflareChallengeError) {
        printError(formatCloudflareChallenge());
        return 1;
      }
      if (err instanceof DeviceFlowError) {
        printError(err.message);
        return 1;
      }
      throw err;
    }
  }

  await runLogin({ noBrowser: opts.noBrowser });
  return 0;
}
