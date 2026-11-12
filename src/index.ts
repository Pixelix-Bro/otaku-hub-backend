import { bootstrap, initializeBackend } from './app/bootstrap.js'

async function main(): Promise<void> {
  const server = await bootstrap()
  try {
    const port = Number(process.env.PORT || 3000)
    await server.listen({ host: '0.0.0.0', port })
    await initializeBackend()
  } catch (error) {
    await server.close().catch(() => undefined)
    throw error
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error('❌ Failed to start application:', message)
  process.exitCode = 1
})
