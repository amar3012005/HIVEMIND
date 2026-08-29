import { loadEngineBoxRuntime } from './runtime.js';

const runtime = loadEngineBoxRuntime(process.env);
if (!runtime.enabled) throw new Error('ENGINE_BOX_MODE=true is required for the Engine Box server entrypoint');

// The canonical Core server remains the implementation authority. This entry
// point is the appliance boundary; excluded components are never selected by
// the Engine Box Compose configuration.
await import('../server.js');
