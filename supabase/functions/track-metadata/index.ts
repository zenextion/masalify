type Recording = {
  title?: string
  score?: number
  'artist-credit'?: Array<{ name?: string; artist?: { name?: string }; joinphrase?: string } | string>
}

type SearchResponse = { recordings?: Recording[] }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders })
}

function normalizeTitle(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function creditedArtist(recording: Recording) {
  const credits = recording['artist-credit'] || []
  return credits.map(credit => {
    if (typeof credit === 'string') return credit
    return `${credit.name || credit.artist?.name || ''}${credit.joinphrase || ''}`
  }).join('').trim()
}

// MusicBrainz allows a maximum average of one request per second per source IP.
// Serialize lookups handled by this Edge Function isolate to avoid bursts.
let musicBrainzQueue: Promise<void> = Promise.resolve()
let lastMusicBrainzRequestAt = 0

function searchMusicBrainz(title: string) {
  const result = musicBrainzQueue.then(async () => {
    const delay = Math.max(0, 1100 - (Date.now() - lastMusicBrainzRequestAt))
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    lastMusicBrainzRequestAt = Date.now()

    const query = new URLSearchParams({ query: `recording:"${title.replace(/["\\]/g, ' ')}"`, fmt: 'json', limit: '5' })
    const response = await fetch(`https://musicbrainz.org/ws/2/recording/?${query}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Masalify/1.0 (https://wpjutnjfnypsawfvxcdq.supabase.co)',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new Error(`MusicBrainz returned HTTP ${response.status}`)
    return await response.json() as SearchResponse
  })
  musicBrainzQueue = result.then(() => undefined, () => undefined)
  return result
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Yalnızca POST isteği kabul edilir.' }, 405)

  let payload: { title?: unknown }
  try {
    payload = await request.json()
  } catch {
    return json({ error: 'İstek gövdesi geçerli JSON değil.' }, 400)
  }

  const title = typeof payload?.title === 'string' ? payload.title.trim() : ''
  if (!title || title.length > 200) return json({ error: 'Şarkı adı 1–200 karakter arasında olmalı.' }, 400)

  try {
    const result = await searchMusicBrainz(title)
    const exactMatches = (result.recordings || []).filter(recording =>
      typeof recording.title === 'string'
      && normalizeTitle(recording.title) === normalizeTitle(title)
      && Number(recording.score || 0) >= 95
      && creditedArtist(recording),
    )
    const artists = [...new Set(exactMatches.map(creditedArtist))]
    // A title shared by multiple artists is ambiguous; do not guess.
    if (artists.length !== 1) return json({ artist: '' })
    return json({ artist: artists[0] })
  } catch (error) {
    console.error('MusicBrainz artist lookup failed:', error instanceof Error ? error.message : 'Unknown error')
    return json({ error: 'Müzik bilgisi servisine şu anda ulaşılamıyor.' }, 502)
  }
})
