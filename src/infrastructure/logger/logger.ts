import pino from 'pino'
import { getConfig } from '../../config/env.js'

let loggerInstance: pino.Logger | null = null

export function createLogger(): pino.Logger {
  if (loggerInstance) return loggerInstance

  let config: { logLevel: string; nodeEnv: string }
  try {
    config = getConfig()
  } catch {
    config = {
      logLevel: process.env['LOG_LEVEL'] || 'info',
      nodeEnv: process.env['NODE_ENV'] || 'development',
    }
  }

  const options: pino.LoggerOptions = {
    level: config.logLevel,
    redact: {
      paths: [
        'token',
        'secret',
        'password',
        'telegramBotToken',
        'req.headers.authorization',
        'req.headers["x-telegram-bot-api-secret-token"]',
      ],
      censor: '[REDACTED]',
    },
  }

  if (config.nodeEnv === 'development') {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    }
  }

  loggerInstance = pino(options)
  return loggerInstance
}

export const logger = createLogger()
