import type { FastifyInstance } from 'fastify'

import { bootstrap, initializeBackend } from './app/bootstrap.js'
import { gracefulShutdown, registerShutdownHandlers } from './app/shutdown.js'
import { getConfig } from './config/env.js'

let server: FastifyInstance | undefined
registerShutdownHandlers(() => server)

async function main(): Promise<void> {
  const activeServer = await bootstrap()
  server = activeServer
  try {
    const port = getConfig().port
    await activeServer.listen({ host: '0.0.0.0', port })
    await initializeBackend()
  } catch (error) {
    await gracefulShutdown(activeServer)
    throw error
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error('❌ Failed to start application:', message)
  process.exitCode = 1
})
