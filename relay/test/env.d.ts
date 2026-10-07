import type { Env } from "../src/machine"

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}