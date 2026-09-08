export type PwaPlatformContext = {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean;
};

export function shouldShowIosInstallHelp(context: PwaPlatformContext): boolean {
  const iosDevice = /iphone|ipad|ipod/iu.test(context.userAgent)
    || (context.platform === "MacIntel" && context.maxTouchPoints > 1);
  return iosDevice && !context.standalone;
}
