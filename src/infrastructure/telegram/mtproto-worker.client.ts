export interface MtprotoMediaInfo {
  file_size: number
  file_name: string | null
  mime_type: string | null
  document_id: string
  access_hash: string
  dc_id: number
  file_reference: string | null
}

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
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/ready`, {
        headers: { 'X-Worker-Secret': this.secret },
        signal: AbortSignal.timeout(3_000),
      })
      return response.ok
    } catch {
      return false
    }
  }
}
