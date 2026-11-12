export interface MtprotoMediaInfo {
  file_size: number
  file_name: string | null
  mime_type: string | null
  document_id: string
  access_hash: string
  dc_id: number
  file_reference: string | null
}

export type WorkerReadiness =
  | { status: 'ready' }
  | { status: 'unauthorized'; httpStatus: 403 }
  | { status: 'not_found'; httpStatus: 404 }
  | { status: 'http_error'; httpStatus: number }
  | { status: 'unreachable' }

export class MtprotoWorkerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string
  ) {}

  async getMediaInfo(chatId: string, messageId: number): Promise<MtprotoMediaInfo> {
    const url = new URL(`${this.baseUrl.replace(/\/+$/, '')}/media-info`)
    url.searchParams.set('chat_id', chatId)
    url.searchParams.set('message_id', String(messageId))

    const response = await fetch(url, {
      headers: { 'X-Worker-Secret': this.secret },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      let detail = ''
      try {
        const body = (await response.json()) as { detail?: unknown }
        if (typeof body.detail === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(body.detail)) {
          detail = ` ${body.detail}`
        }
      } catch {
        detail = ''
      }
      throw new Error(`MTProto worker media resolution failed (${response.status}${detail}).`)
    }

    const data = (await response.json()) as MtprotoMediaInfo
    if (
      !Number.isSafeInteger(data.file_size) ||
      data.file_size <= 0 ||
      !data.document_id ||
      !data.access_hash ||
      !Number.isInteger(data.dc_id)
    ) {
      throw new Error('MTProto worker returned invalid media metadata.')
    }
    return data
  }

  async isReady(): Promise<boolean> {
    return (await this.probeReadiness()).status === 'ready'
  }

  async probeReadiness(): Promise<WorkerReadiness> {
    const candidates = [
      `${this.baseUrl.replace(/\/+$/, '')}/readyz`,
      `${this.baseUrl.replace(/\/+$/, '')}/ready`,
    ]

    for (const url of candidates) {
      try {
        const response = await fetch(url, {
          headers: { 'X-Worker-Secret': this.secret },
          signal: AbortSignal.timeout(3_000),
        })
        if (response.ok) return { status: 'ready' }
        if (response.status === 403) return { status: 'unauthorized', httpStatus: 403 }
        if (response.status === 404) continue
        return { status: 'http_error', httpStatus: response.status }
      } catch {
        continue
      }
    }

    return { status: 'unreachable' }
  }
}
