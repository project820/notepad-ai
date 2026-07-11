export type CreateWindowOptions = {
  restore?: unknown;
  openFilePath?: string;
  isLaunchWindow?: boolean;
};

export function shouldUseMockKeychain(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NOTEPAD_AI_USERDATA) && env.NOTEPAD_AI_INTEGRATION_TEST === '1';
}

export function shouldPublishLaunchWindow(opts: CreateWindowOptions): boolean {
  return opts.isLaunchWindow === true && !opts.restore && !opts.openFilePath;
}
