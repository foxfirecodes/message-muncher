import {DiscordSDK} from '@discord/embedded-app-sdk'
import type {Snapshot, WireSnapshot} from './game.js'

type Config = {discordClientId: string; guestMode: boolean; channelConfigured: boolean}
const canvas = document.querySelector<HTMLCanvasElement>('#game')!
const context = canvas.getContext('2d')!
const status = document.querySelector<HTMLElement>('#status')!
const leaderboard = document.querySelector<HTMLOListElement>('#leaderboard')!
const score = document.querySelector<HTMLElement>('#score')!
const playerCount = document.querySelector<HTMLElement>('#player-count')!
const profile = document.querySelector<HTMLElement>('#profile')!
const profileAvatar = document.querySelector<HTMLImageElement>('#profile-avatar')!
const profileFallback = document.querySelector<HTMLElement>('#profile-fallback')!
const profileName = document.querySelector<HTMLElement>('#profile-name')!
const profileMode = document.querySelector<HTMLElement>('#profile-mode')!
let snapshot: Snapshot | null = null
let snapshotReceivedAt = performance.now()
let socket: WebSocket | null = null
const keys = new Set<string>()
const avatarImages = new Map<string, HTMLImageElement>()
const renderPositions = new Map<string, {x: number; y: number}>()
let previousFrameTime = performance.now()

function getAvatar(url: string) {
  const cached = avatarImages.get(url)
  if (cached) return cached
  const image = new Image()
  image.src = url
  avatarImages.set(url, image)
  return image
}

function setStatus(message: string, kind: 'loading' | 'ready' | 'error' = 'loading') {
  status.textContent = message
  status.dataset.kind = kind
}

async function authorize(config: Config) {
  if (config.discordClientId && !location.search.includes('guest=1')) {
    try {
      setStatus('Connecting to Discord…')
      const discord = new DiscordSDK(config.discordClientId)
      await discord.ready()
      const {code} = await discord.commands.authorize({client_id: config.discordClientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify']})
      const response = await fetch('/api/token', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code})})
      if (!response.ok) throw new Error(((await response.json()) as {error?: string}).error ?? 'Authorization failed')
      const result = await response.json() as {access_token: string; session_token: string}
      await discord.commands.authenticate({access_token: result.access_token})
      return result.session_token
    } catch (error) {
      if (!config.guestMode) throw error
      console.warn('Discord SDK unavailable; entering local guest mode.', error)
    }
  }
  const response = await fetch('/api/guest', {method: 'POST'})
  if (!response.ok) throw new Error('Guest mode is unavailable')
  return ((await response.json()) as {session_token: string}).session_token
}

function connect(token: string) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  socket = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`)
  socket.addEventListener('open', () => setStatus('LIVE', 'ready'))
  socket.addEventListener('message', (event) => {
    const incoming = JSON.parse(event.data) as WireSnapshot
    snapshot = {...incoming, foods: incoming.foods ?? snapshot?.foods ?? []}
    snapshotReceivedAt = performance.now()
    updateHud()
  })
  socket.addEventListener('close', () => setStatus('Disconnected — reload to rejoin', 'error'))
}

function resize() {
  const bounds = canvas.getBoundingClientRect()
  const scale = window.devicePixelRatio || 1
  canvas.width = Math.round(bounds.width * scale)
  canvas.height = Math.round(bounds.height * scale)
  context.setTransform(scale, 0, 0, scale, 0, 0)
}

function roundedRect(x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath(); context.roundRect(x, y, width, height, radius)
}

function wrappedDelta(from: number, to: number, size: number) {
  const direct = to - from
  if (Math.abs(direct) <= size / 2) return direct
  return direct - Math.sign(direct) * size
}

function interpolatePlayers(now: number) {
  if (!snapshot) return []
  const deltaSeconds = Math.min((now - previousFrameTime) / 1000, .1)
  const blend = 1 - Math.exp(-18 * deltaSeconds)
  const activeIds = new Set(snapshot.players.map((player) => player.id))
  for (const id of renderPositions.keys()) if (!activeIds.has(id)) renderPositions.delete(id)
  return snapshot.players.map((player) => {
    const position = renderPositions.get(player.id) ?? {x: player.x, y: player.y}
    position.x = (position.x + wrappedDelta(position.x, player.x, snapshot!.world.width) * blend + snapshot!.world.width) % snapshot!.world.width
    position.y = (position.y + wrappedDelta(position.y, player.y, snapshot!.world.height) * blend + snapshot!.world.height) % snapshot!.world.height
    renderPositions.set(player.id, position)
    return {...player, ...position}
  })
}

function drawMap(width: number, height: number, cameraX: number, cameraY: number) {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  const palette = dark
    ? {field: '#101218', grid: '#262a33', land: '#16181e', coast: '#3b414c', word: '#c7ccd6', panel: '#16181e', line: '#262a33', ink: '#e3e5ea'}
    : {field: '#f4f5f8', grid: '#dfe2e8', land: '#e8eaf0', coast: '#c9ced8', word: '#3c424c', panel: '#ffffff', line: '#d4d8e0', ink: '#22252b'}
  context.fillStyle = palette.field; context.fillRect(0, 0, width, height)
  context.save(); context.translate(width / 2 - cameraX, height / 2 - cameraY)
  context.strokeStyle = palette.grid; context.lineWidth = 1
  for (let x = 0; x <= 2400; x += 100) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, 1400); context.stroke() }
  for (let y = 0; y <= 1400; y += 100) { context.beginPath(); context.moveTo(0, y); context.lineTo(2400, y); context.stroke() }
  context.fillStyle = palette.land; context.strokeStyle = palette.coast; context.lineWidth = 2
  const continents: Array<Array<[number, number]>> = [
    [[220,230],[390,150],[630,200],[760,340],[650,450],[560,430],[500,590],[390,520],[300,390]],
    [[610,560],[760,610],[820,790],[730,1040],[610,1180],[550,890]],
    [[1020,230],[1170,180],[1280,260],[1420,260],[1510,390],[1410,470],[1260,430],[1190,540],[1070,430]],
    [[1230,510],[1470,490],[1640,610],[1550,900],[1430,1120],[1290,920],[1180,680]],
    [[1500,250],[1780,190],[2100,300],[2180,470],[1980,560],[1830,480],[1680,550],[1530,420]],
    [[1900,840],[2110,800],[2220,940],[2130,1080],[1920,1040],[1840,930]],
  ]
  for (const points of continents) {
    context.beginPath(); points.forEach(([x,y], index) => index ? context.lineTo(x,y) : context.moveTo(x,y))
    context.closePath(); context.fill(); context.stroke()
  }
  context.strokeStyle = palette.line; context.strokeRect(0, 0, 2400, 1400); context.restore()
  return palette
}

function draw() {
  const now = performance.now()
  const width = canvas.clientWidth, height = canvas.clientHeight
  const players = interpolatePlayers(now)
  previousFrameTime = now
  const self = players.find((player) => player.id === snapshot?.selfId)
  const cameraX = self?.x ?? 1200, cameraY = self?.y ?? 700
  const palette = drawMap(width, height, cameraX, cameraY)
  if (!snapshot) { requestAnimationFrame(draw); return }
  context.save(); context.translate(width / 2 - cameraX, height / 2 - cameraY)
  for (const food of snapshot.foods) {
    const screenX = food.x - cameraX + width / 2
    const screenY = food.y - cameraY + height / 2
    if (screenX < -280 || screenX > width + 280 || screenY < -50 || screenY > height + 50) continue
    context.font = '500 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    const label = food.text.length > 36 ? `${food.text.slice(0, 35)}…` : food.text
    const measured = Math.min(260, context.measureText(label).width + 30)
    context.fillStyle = palette.panel
    roundedRect(food.x - measured / 2, food.y - 15, measured, 30, 6); context.fill()
    context.strokeStyle = palette.line; context.lineWidth = 1; context.stroke()
    context.fillStyle = palette.word; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(label, food.x, food.y, measured - 18)
  }
  for (const player of players) {
    const radius = 15 + Math.sqrt(player.score) * 3.1
    context.save(); context.translate(player.x, player.y)
    const estimatedServerNow = snapshot.now + (now - snapshotReceivedAt)
    const emoteProgress = Math.max(0, Math.min(1, (estimatedServerNow - player.emoteStartedAt) / 700))
    const isEmoting = player.emoteStartedAt > 0 && emoteProgress < 1
    if (isEmoting) {
      const pulse = 1 + Math.sin(emoteProgress * Math.PI) * .28
      context.rotate(emoteProgress * Math.PI * 2)
      context.scale(pulse, pulse)
    }

    context.save()
    context.globalAlpha = .52
    context.shadowColor = player.color
    context.shadowBlur = player.id === snapshot.selfId ? 25 : 17
    context.fillStyle = player.color
    context.beginPath(); context.arc(0, 3, radius + 2, 0, Math.PI * 2); context.fill()
    context.restore()

    const avatar = player.avatarUrl ? getAvatar(player.avatarUrl) : null
    context.save()
    context.beginPath(); context.arc(0, 0, radius, 0, Math.PI * 2); context.clip()
    if (avatar?.complete && avatar.naturalWidth > 0) {
      context.drawImage(avatar, -radius, -radius, radius * 2, radius * 2)
    } else {
      context.fillStyle = player.color
      context.fillRect(-radius, -radius, radius * 2, radius * 2)
      context.fillStyle = '#fff'
      context.font = `700 ${Math.max(11, radius * .8)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
      context.textAlign = 'center'; context.textBaseline = 'middle'
      context.fillText(player.username.slice(0, 1).toUpperCase(), 0, 1)
    }
    context.restore()

    context.strokeStyle = player.id === snapshot.selfId ? palette.ink : player.color
    context.lineWidth = player.id === snapshot.selfId ? 2.5 : 2
    context.beginPath(); context.arc(0, 0, radius, 0, Math.PI * 2); context.stroke()
    context.restore()

    context.save(); context.translate(player.x, player.y)
    context.font = '700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'; context.textAlign = 'center'; context.textBaseline = 'bottom'; context.fillStyle = palette.ink
    context.fillText(player.username, 0, -radius - 8); context.restore()
  }
  context.restore(); requestAnimationFrame(draw)
}

function updateHud() {
  if (!snapshot) return
  const self = snapshot.players.find((player) => player.id === snapshot?.selfId)
  score.textContent = String(self?.score ?? 0)
  playerCount.textContent = `${snapshot.players.length} muncher${snapshot.players.length === 1 ? '' : 's'} online`
  if (self) {
    profile.hidden = false
    profileName.textContent = self.username
    profileMode.textContent = self.id.startsWith('guest-') ? 'LOCAL PREVIEW' : 'PLAYING AS'
    profileFallback.textContent = self.username.slice(0, 1).toUpperCase()
    if (self.avatarUrl) {
      profileAvatar.src = self.avatarUrl
      profileAvatar.alt = `${self.username}'s Discord avatar`
      profileAvatar.hidden = false
      profileFallback.hidden = true
    } else {
      profileAvatar.hidden = true
      profileFallback.hidden = false
    }
  }
  leaderboard.replaceChildren(...snapshot.leaderboard.map((entry, index) => {
    const item = document.createElement('li')
    if (entry.id === snapshot?.selfId) item.className = 'is-you'
    const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = String(index + 1)
    const dot = document.createElement('i'); dot.style.setProperty('--player-color', entry.color)
    const name = document.createElement('span'); name.textContent = entry.username
    const points = document.createElement('strong'); points.textContent = String(entry.score)
    item.append(rank, dot, name, points); return item
  }))
}

function sendInput() {
  const left = keys.has('arrowleft') || keys.has('a'), right = keys.has('arrowright') || keys.has('d')
  const up = keys.has('arrowup') || keys.has('w'), down = keys.has('arrowdown') || keys.has('s')
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type: 'input', x: Number(right) - Number(left), y: Number(down) - Number(up)}))
}

window.addEventListener('keydown', (event) => {
  if (['arrowleft','arrowright','arrowup','arrowdown','w','a','s','d','t'].includes(event.key.toLowerCase())) event.preventDefault()
  if (event.key.toLowerCase() === 't' && !event.repeat && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type: 'emote'}))
  keys.add(event.key.toLowerCase()); sendInput()
})
window.addEventListener('keyup', (event) => { keys.delete(event.key.toLowerCase()); sendInput() })
window.addEventListener('blur', () => { keys.clear(); sendInput() })
window.addEventListener('resize', resize)

resize(); requestAnimationFrame(draw)
try {
  const config = await (await fetch('/api/config')).json() as Config
  connect(await authorize(config))
} catch (error) {
  console.error(error); setStatus(error instanceof Error ? error.message : 'Could not start the game', 'error')
}
