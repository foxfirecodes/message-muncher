import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto'
import {existsSync} from 'node:fs'
import {serve} from '@hono/node-server'
import {serveStatic} from '@hono/node-server/serve-static'
import {ChannelType, Client, Events, GatewayDispatchEvents, GatewayIntentBits, Routes, type APIChannel, type APIMessage} from 'discord.js'
import {Hono} from 'hono'
import {WebSocketServer, type RawData, type WebSocket} from 'ws'
import {Game, type Identity} from './game.js'
import {PlayerStore} from './player-store.js'

if (existsSync('.env')) process.loadEnvFile('.env')

const PORT = Number(process.env.PORT ?? 3000)
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? ''
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? ''
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? ''
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID ?? ''
const SESSION_SECRET = process.env.SESSION_SECRET ?? randomBytes(32).toString('hex')
const IS_PRODUCTION = process.env.NODE_ENV === 'production'
const PLAYER_DATA_PATH = process.env.PLAYER_DATA_PATH ?? './data/player-scores.json'
type Session = Identity & {exp: number}

function signSession(identity: Identity) {
  const payload = Buffer.from(JSON.stringify({...identity, exp: Date.now() + 12 * 60 * 60 * 1000})).toString('base64url')
  const signature = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function readSession(token: string | null): Session | null {
  if (!token) return null
  const [payload, supplied] = token.split('.')
  if (!payload || !supplied) return null
  const expected = createHmac('sha256', SESSION_SECRET).update(payload).digest()
  let signature: Buffer
  try { signature = Buffer.from(supplied, 'base64url') } catch { return null }
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Session
    return session.exp > Date.now() && session.id && session.username ? session : null
  } catch { return null }
}

const app = new Hono()
const playerStore = new PlayerStore(PLAYER_DATA_PATH)
await playerStore.load()
const game = new Game(playerStore)
app.get('/api/config', (c) => c.json({discordClientId: DISCORD_CLIENT_ID, guestMode: !IS_PRODUCTION, channelConfigured: Boolean(DISCORD_CHANNEL_ID)}))

app.post('/api/token', async (c) => {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) return c.json({error: 'Discord OAuth is not configured'}, 503)
  const {code} = await c.req.json<{code?: string}>()
  if (!code) return c.json({error: 'Missing authorization code'}, 400)
  const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code}),
  })
  if (!tokenResponse.ok) {
    console.error('Discord token exchange failed', tokenResponse.status, await tokenResponse.text())
    return c.json({error: 'Discord authorization failed'}, 401)
  }
  const token = await tokenResponse.json() as {access_token: string}
  const userResponse = await fetch('https://discord.com/api/users/@me', {headers: {Authorization: `Bearer ${token.access_token}`}})
  if (!userResponse.ok) return c.json({error: 'Could not load Discord user'}, 401)
  const user = await userResponse.json() as {id: string; username: string; global_name?: string; avatar?: string}
  const identity: Identity = {
    id: user.id,
    username: user.global_name || user.username,
    avatarUrl: user.avatar ? `/api/avatar/${user.id}/${user.avatar}` : undefined,
  }
  return c.json({access_token: token.access_token, session_token: signSession(identity)})
})

app.get('/api/avatar/:userId/:avatarHash', async (c) => {
  const userId = c.req.param('userId')
  const avatarHash = c.req.param('avatarHash')
  if (!/^\d+$/.test(userId) || !/^[a-zA-Z0-9_]+$/.test(avatarHash)) return c.notFound()
  const extension = avatarHash.startsWith('a_') ? 'gif' : 'png'
  const response = await fetch(`https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${extension}?size=128`)
  if (!response.ok || !response.body) return c.notFound()
  return new Response(response.body, {
    headers: {
      'Content-Type': response.headers.get('Content-Type') ?? `image/${extension}`,
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  })
})

app.post('/api/guest', (c) => {
  if (IS_PRODUCTION) return c.json({error: 'Guest mode is disabled'}, 403)
  const identity = {id: `guest-${randomBytes(8).toString('hex')}`, username: `Muncher-${randomBytes(2).toString('hex')}`}
  return c.json({session_token: signSession(identity)})
})

app.post('/api/demo-message', async (c) => {
  if (IS_PRODUCTION) return c.json({error: 'Demo messages are disabled'}, 403)
  const body = await c.req.json<{text?: string; author?: string}>()
  return c.json({added: game.addMessage(`demo-${randomBytes(8).toString('hex')}`, body.text ?? '', body.author ?? 'Local chat')})
})

app.use('/*', serveStatic({root: './public'}))
app.get('*', serveStatic({path: './public/index.html'}))
const server = serve({fetch: app.fetch, port: PORT}, (info) => console.log(`Message Muncher is running on http://localhost:${info.port}`))
const wss = new WebSocketServer({noServer: true})

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  if (url.pathname !== '/ws') return socket.destroy()
  const session = readSession(url.searchParams.get('token'))
  if (!session) return socket.destroy()
  wss.handleUpgrade(request, socket, head, (webSocket) => attachPlayer(webSocket, session))
})

function attachPlayer(socket: WebSocket, session: Session) {
  game.join(session, socket)
  socket.on('message', (raw: RawData) => {
    try {
      const message = JSON.parse(raw.toString()) as {type?: string; x?: number; y?: number}
      if (message.type === 'input') game.input(session.id, Number(message.x), Number(message.y))
      if (message.type === 'emote') game.emote(session.id)
    } catch { /* Ignore malformed client input. */ }
  })
  socket.on('close', () => game.leave(session.id, socket))
}

let previousTick = performance.now()
setInterval(() => { const now = performance.now(); game.tick((now - previousTick) / 1000); previousTick = now }, 1000 / 60)
setInterval(() => game.broadcast(), 50)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await playerStore.flush()
    process.exit(0)
  })
}

if (DISCORD_BOT_TOKEN && DISCORD_CHANNEL_ID) {
  const bot = new Client({intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]})
  const watchedChannelIds = new Set([DISCORD_CHANNEL_ID])
  const ingestRawMessage = (message: APIMessage) => {
    if (!watchedChannelIds.has(message.channel_id) || message.author.bot) return false
    const content = message.content.trim() || (message.attachments.length ? 'shared an attachment' : '')
    const author = message.author.global_name ?? message.author.username
    return game.addMessage(message.id, content, author)
  }
  const ingestMessage = (message: Parameters<NonNullable<Parameters<typeof bot.on<'messageCreate'>>[1]>>[0]) => {
    if (message.channelId !== DISCORD_CHANNEL_ID || message.author.bot) return false
    const content = message.cleanContent || (message.attachments.size ? 'shared an attachment' : '')
    return game.addMessage(message.id, content, message.member?.displayName ?? message.author.globalName ?? message.author.username)
  }
  bot.on('messageCreate', (message) => {
    if (ingestMessage(message)) console.log(`Ingested Discord message ${message.id}`)
  })
  bot.ws.on(GatewayDispatchEvents.MessageCreate, (message: APIMessage) => {
    if (ingestRawMessage(message)) console.log(`Ingested live Gateway message ${message.id}`)
  })
  bot.once(Events.ClientReady, async () => {
    console.log(`Discord bot connected as ${bot.user?.tag}; discovering text channels from ${DISCORD_CHANNEL_ID}`)
    try {
      const appChannel = await bot.rest.get(Routes.channel(DISCORD_CHANNEL_ID)) as APIChannel & {guild_id?: string}
      if (!appChannel.guild_id) throw new Error('Configured channel does not belong to a guild')
      const guildChannels = await bot.rest.get(Routes.guildChannels(appChannel.guild_id)) as APIChannel[]
      for (const channel of guildChannels) {
        if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) watchedChannelIds.add(channel.id)
      }
      console.log(`Watching ${watchedChannelIds.size} guild text channel${watchedChannelIds.size === 1 ? '' : 's'} for live messages`)

      let added = 0
      const channelIds = [...watchedChannelIds]
      for (let offset = 0; offset < channelIds.length; offset += 5) {
        const batch = channelIds.slice(offset, offset + 5)
        const counts = await Promise.all(batch.map(async (channelId) => {
          try {
            const messages = await bot.rest.get(Routes.channelMessages(channelId), {
              query: new URLSearchParams({limit: '100'}),
            }) as APIMessage[]
            let channelAdded = 0
            for (const message of messages.reverse()) if (ingestRawMessage(message)) channelAdded += 1
            return channelAdded
          } catch (error) {
            console.warn(`Could not load message history from channel ${channelId}`, error)
            return 0
          }
        }))
        added += counts.reduce((sum, count) => sum + count, 0)
      }
      console.log(`Loaded ${added} recent messages from ${watchedChannelIds.size} guild channels into the arena`)
    } catch (error) {
      console.error(`Could not load messages from channel ${DISCORD_CHANNEL_ID}`, error)
    }
  })
  bot.login(DISCORD_BOT_TOKEN).catch((error) => console.error('Discord bot login failed', error))
} else {
  console.warn('Discord bot is disabled; set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID to ingest channel messages.')
  const samples = ['hello from the channel!', 'who left all these messages here?', 'meet me by South America', 'tiny snack, enormous ambition', 'the leaderboard fears me', 'om nom nom :3']
  for (let i = 0; i < 24; i++) game.addMessage(`seed-${i}`, samples[i % samples.length]!, 'Demo chat')
}
