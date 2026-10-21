declare module "*/challenges.mjs" {
  export function detectChallenge(state: unknown): any;
}

declare module "*/url-validation.mjs" {
  export function validateUrlWithDns(
    url: string,
  ): Promise<{ valid: boolean; reason?: string }>;
}
