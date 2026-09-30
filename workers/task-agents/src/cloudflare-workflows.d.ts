declare module "cloudflare:workflows" {
  /** Native Cloudflare Workflow error that terminates a permanent step failure. */
  export class NonRetryableError extends Error {
    constructor(message?: string);
  }
}
