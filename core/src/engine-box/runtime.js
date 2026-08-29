import { createEngineBoxRuntimeConfig, evaluateReadiness } from '../../../engine-box/lib/runtime-contract.mjs';

/**
 * Single boot-time authority for the proprietary Engine Box build. Images use
 * this module before importing hosted service entry points. Keeping it pure
 * makes the appliance boundary independently testable.
 */
export function loadEngineBoxRuntime(env = process.env) {
  return createEngineBoxRuntimeConfig(env);
}

export function engineBoxReadiness(input) {
  return evaluateReadiness(input);
}

export function assertEngineBoxCapability(runtime, capability) {
  if (!runtime?.enabled) return;
  if (!runtime.capabilities.includes(capability)) {
    throw new Error(`Engine Box capability is disabled: ${capability}`);
  }
}
