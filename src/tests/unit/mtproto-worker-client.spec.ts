import { afterEach, describe, expect, it, vi } from 'vitest'

import { MtprotoWorkerClient } from '../../infrastructure/telegram/mtproto-worker.client.js'

describe('MTProto worker readiness probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('distinguishes private DNS failures from other network errors', async () => {
    const dnsError = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENOTFOUND' },
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(dnsError))

    await expect(
      new MtprotoWorkerClient('http://worker.internal:8000', 'secret').probeReadiness()
    ).resolves.toEqual({ status: 'unreachable', reason: 'dns' })
  })

  it('distinguishes a closed worker port', async () => {
    const connectionError = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(connectionError))

    await expect(
      new MtprotoWorkerClient('http://worker.internal:8000', 'secret').probeReadiness()
    ).resolves.toEqual({ status: 'unreachable', reason: 'connection' })
  })

  it('uses the legacy ready route only when readyz is missing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      new MtprotoWorkerClient('http://worker.internal:8000', 'secret').probeReadiness()
    ).resolves.toEqual({ status: 'ready' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://worker.internal:8000/readyz')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://worker.internal:8000/ready')
  })

  it('reports not_found when neither readiness endpoint exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))

    await expect(
      new MtprotoWorkerClient('http://worker.internal:8000', 'secret').probeReadiness()
    ).resolves.toEqual({ status: 'not_found', httpStatus: 404 })
  })
})
