/**
 * Adapter Registry
 *
 * Central registry for provider adapter classes.
 * Adapters self-register at module load time; the sync engine
 * resolves them by providerKey at runtime.
 */

export class AdapterRegistry {
  /** @type {Map<string, Function>} */
  #registry = new Map();

  /**
   * Register an adapter class for a provider key.
   * Idempotent: calling twice with the same key overrides and warns.
   * @param {string} providerKey
   * @param {Function} AdapterClass
   */
  register(providerKey, AdapterClass) {
    if (this.#registry.has(providerKey)) {
      console.warn(`AdapterRegistry: overriding existing adapter for "${providerKey}"`);
    }
    this.#registry.set(providerKey, AdapterClass);
  }

  /**
   * Return the registered adapter class, or null if not found.
   * @param {string} providerKey
   * @returns {Function|null}
   */
  get(providerKey) {
    return this.#registry.get(providerKey) ?? null;
  }

  /**
   * List all registered provider keys.
   * @returns {string[]}
   */
  list() {
    return [...this.#registry.keys()];
  }

  /**
   * Instantiate an adapter with a runtime context.
   * @param {string} providerKey
   * @param {{ providerKey: string, tokenResolver: Function, prisma: object, logger: object }} ctx
   * @returns {InstanceType<Function>}
   */
  instantiate(providerKey, ctx) {
    const AdapterClass = this.get(providerKey);
    if (!AdapterClass) {
      throw new Error(`AdapterRegistry: no adapter registered for "${providerKey}"`);
    }
    return new AdapterClass({ ...ctx, providerKey });
  }
}

/** Singleton instance used across the application. */
const adapterRegistry = new AdapterRegistry();
export default adapterRegistry;
