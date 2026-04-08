/**
 * Live Log Streamer - In-memory log capture
 * Captures console.log output and serves via API
 */

// In-memory log buffer
const logBuffer = {
  'hm-control': [],
  'hm-core': [],
};

const MAX_LOG_LINES = 500;

/**
 * Capture console output for a container
 */
export function captureLogs(containerName) {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  function capture(type, args) {
    const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const entry = {
      type,
      line,
      timestamp: new Date().toISOString(),
    };

    const buffer = logBuffer[containerName] || [];
    buffer.push(entry);

    // Trim buffer
    if (buffer.length > MAX_LOG_LINES) {
      buffer.shift();
    }

    logBuffer[containerName] = buffer;
  }

  // Override console methods
  console.log = function(...args) {
    capture('info', args);
    originalLog.apply(console, args);
  };

  console.error = function(...args) {
    capture('error', args);
    originalError.apply(console, args);
  };

  console.warn = function(...args) {
    capture('warn', args);
    originalWarn.apply(console, args);
  };

  return () => {
    // Restore original methods
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  };
}

/**
 * Get recent logs for a container
 */
export async function streamDockerLogs(containerName, lines = 50, since = '2m') {
  const buffer = logBuffer[containerName] || [];

  // Filter by time if since is provided
  const sinceTime = Date.now() - parseSince(since);
  const filtered = buffer.filter(entry => new Date(entry.timestamp).getTime() > sinceTime);

  // Return last N lines
  return filtered.slice(-lines).map(e => `[${e.timestamp}] [${e.type.toUpperCase()}] ${e.line}`);
}

function parseSince(since) {
  const match = since.match(/^(\d+)([smhd])$/);
  if (!match) return 5 * 60 * 1000; // default 5m

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return 5 * 60 * 1000;
  }
}

/**
 * Get log buffer for API response
 */
export function getLogBuffer(containerName) {
  return logBuffer[containerName] || [];
}

/**
 * Get all buffers
 */
export function getAllLogBuffers() {
  return logBuffer;
}

export default { streamDockerLogs, captureLogs, getLogBuffer };
