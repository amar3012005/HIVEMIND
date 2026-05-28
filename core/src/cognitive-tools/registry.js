import { CanonicalSynthesisTool } from './canonical-synthesis-tool.js';
import { BridgeSynthesisTool } from './bridge-synthesis-tool.js';
import { CompressionTool } from './compression-tool.js';

/**
 * Single registry — Turing.assess uses this. GraphActionExecutor calls
 * the named tool from here on approve.
 *
 * The cognitionLoopFactory is shared across tools so we only spin up one
 * CognitionLoop instance for LLM helper access.
 */
let _registry = null;

export function getCognitiveToolRegistry({ prisma, memoryStore, logger = console } = {}) {
  if (_registry) return _registry;

  let _loopInstance = null;
  const cognitionLoopFactory = async () => {
    if (_loopInstance) return _loopInstance;
    const { CognitionLoop } = await import('../memory/cognition-loop.js');
    _loopInstance = new CognitionLoop({
      prisma,
      memoryGraphEngine: memoryStore?.engine || memoryStore || null,
      persistentMemoryStore: memoryStore || null,
      logger,
    });
    return _loopInstance;
  };

  const ctx = { prisma, memoryStore, logger, cognitionLoopFactory };
  const tools = {
    canonical_synthesis: new CanonicalSynthesisTool(ctx),
    bridge_synthesis:    new BridgeSynthesisTool(ctx),
    compression:         new CompressionTool(ctx),
  };

  _registry = {
    tools,
    get(name) { return tools[name] || null; },
    list() { return Object.keys(tools); },
    /** Run all tools' assess() and return list of applicable proposals. */
    async assessAll({ verifications, orgId }) {
      const out = [];
      for (const tool of Object.values(tools)) {
        try {
          const r = await tool.assess({ verifications, orgId });
          if (r?.applicable) {
            out.push({ tool_name: tool.name, cognitive_role: tool.cognitiveRole, ...r });
          }
        } catch (err) {
          logger?.warn?.(`[cognitive-tools] ${tool.name}.assess failed: ${err.message}`);
        }
      }
      return out;
    },
  };
  return _registry;
}

/** For tests: drop singleton so a fresh registry can be built. */
export function _resetRegistry() { _registry = null; }
