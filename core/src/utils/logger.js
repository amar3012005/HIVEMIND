/**
 * Centralized Logger Utility
 * HIVE-MIND Cross-Platform Context Sync
 *
 * Simple console-based logger with structured output
 * Used across all services for consistent logging
 */

const LOG_LEVELS = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
};

const currentLevel = process.env.LOG_LEVEL || LOG_LEVELS.DEBUG;

const shouldLog = (level) => {
  const levels = [LOG_LEVELS.DEBUG, LOG_LEVELS.INFO, LOG_LEVELS.WARN, LOG_LEVELS.ERROR];
  const currentIndex = levels.indexOf(currentLevel);
  const levelIndex = levels.indexOf(level);
  return levelIndex >= currentIndex;
};

const formatMessage = (level, message, data) => {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] [${level}] ${message}`;
  if (data !== undefined && data !== null) {
    return `${base} ${JSON.stringify(data, null, 2)}`;
  }
  return base;
};

export const logger = {
  debug: (message, data) => {
    if (shouldLog(LOG_LEVELS.DEBUG)) {
      console.debug(formatMessage(LOG_LEVELS.DEBUG, message, data));
    }
  },

  info: (message, data) => {
    if (shouldLog(LOG_LEVELS.INFO)) {
      console.info(formatMessage(LOG_LEVELS.INFO, message, data));
    }
  },

  warn: (message, data) => {
    if (shouldLog(LOG_LEVELS.WARN)) {
      console.warn(formatMessage(LOG_LEVELS.WARN, message, data));
    }
  },

  error: (message, data) => {
    if (shouldLog(LOG_LEVELS.ERROR)) {
      console.error(formatMessage(LOG_LEVELS.ERROR, message, data));
    }
  },
};

export default logger;
