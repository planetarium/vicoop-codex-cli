import { runLogin } from "../auth/login.js";

export interface LoginCmdOptions {
  noBrowser?: boolean;
}

export async function loginCommand(opts: LoginCmdOptions): Promise<number> {
  await runLogin({ noBrowser: opts.noBrowser });
  return 0;
}
