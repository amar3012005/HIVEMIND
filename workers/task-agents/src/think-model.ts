import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { GatewayEnv } from "./gateway";

const DEEPSEEK_MODEL = "deepseek/deepseek-v4-flash-0731:nitro";
const FAST_START_MODEL = "openai/gpt-oss-20b:nitro";

export function thinkModel(env: GatewayEnv): LanguageModel | string {
  if (env.OPENROUTER_MODEL !== DEEPSEEK_MODEL) return "@cf/zai-org/glm-5.3-flash";
  return openRouterModel(env, DEEPSEEK_MODEL);
}

export function initialPlanModel(env: GatewayEnv): LanguageModel | null {
  if (env.OPENROUTER_MODEL !== DEEPSEEK_MODEL) return null;
  return openRouterModel(env, FAST_START_MODEL);
}

function openRouterModel(env: GatewayEnv, model: string): LanguageModel {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.AI_GATEWAY_ID || !env.CLOUDFLARE_AI_GATEWAY_TOKEN || !env.CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS) {
    throw new Error("OpenRouter gateway configuration is incomplete");
  }
  const provider = createOpenRouter({
    baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/openrouter/v1`,
    apiKey: "gateway-byok",
    compatibility: "strict",
    headers: {
      "cf-aig-authorization": `Bearer ${env.CLOUDFLARE_AI_GATEWAY_TOKEN}`,
      "cf-aig-byok-alias": env.CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS,
    },
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      return fetch(input, { ...init, headers });
    },
  });
  return provider.chat(model, { extraBody: { reasoning: { effort: "low" } } });
}
