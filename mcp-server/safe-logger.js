import fs from 'fs';
import util from 'util';

const LOG_PATH = process.env.HIVEMIND_MCP_LOG_PATH || '/tmp/hivemind-mcp.log';

function serializeContext(ctx) {
  if (ctx === undefined) {
    return '';
  }

  if (typeof ctx === 'string') {
    return ctx;
  }

  try {
    return JSON.stringify(ctx);
  } catch {
    return util.inspect(ctx, { depth: 4, breakLength: Infinity });
  }
}

function writeLine(level, namespace, message, ctx) {
  const timestamp = new Date().toISOString();
  const context = serializeContext(ctx);
  const suffix = context ? ` ${context}` : '';

  try {
    fs.appendFileSync(LOG_PATH, `[${timestamp}] [${level}] [${namespace}] ${message}${suffix}\n`);
  } catch {
    // Never write to stdio from MCP helpers.
  }
}

export function createSafeLogger(namespace) {
  return {
    debug(message, ctx) {
      writeLine('DEBUG', namespace, message, ctx);
    },
    info(message, ctx) {
      writeLine('INFO', namespace, message, ctx);
    },
    warn(message, ctx) {
      writeLine('WARN', namespace, message, ctx);
    },
    error(message, ctx) {
      writeLine('ERROR', namespace, message, ctx);
    }
  };
}

export const safeLog = createSafeLogger('HIVEMIND');
