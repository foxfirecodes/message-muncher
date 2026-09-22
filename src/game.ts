import type {WebSocket} from 'ws'

export const WORLD = {width: 2400, height: 1400} as const
export type Identity = {id: string; username: string; avatarUrl?: string}
export type Player = Identity & {x: number; y: number; dx: number; dy: number; score: number; color: string; emoteStartedAt: number}
export type Food = {id: string; text: string; author: string; x: number; y: number; createdAt: number}
export type Snapshot = {
  type: 'snapshot'; now: number; selfId: string; world: typeof WORLD
  players: Player[]; foods: Food[]
  leaderboard: Array<{id: string; username: string; score: number; color: string}>
}
export type WireSnapshot = Omit<Snapshot, 'foods'> & {foods?: Food[]}

const COLORS = ['#3a45c9', '#6b73e0', '#9a6b00', '#6f42c1', '#1f8a4c', '#c0392f']
const FOOD_LIMIT = 5_000
const FOOD_LIFETIME_MS = 15 * 60 * 1000

function randomPosition(margin = 70) {
  return {x: margin + Math.random() * (WORLD.width - margin * 2), y: margin + Math.random() * (WORLD.height - margin * 2)}
}

export function playerRadius(score: number) { return 15 + Math.sqrt(score) * 3.1 }

export class Game {
  readonly players = new Map<string, Player>()
  readonly foods = new Map<string, Food>()
  private readonly sockets = new Map<string, WebSocket>()
  private readonly socketFoodVersions = new Map<string, number>()
  private foodVersion = 0

  constructor(private readonly scoreStore: {getScore(id: string): number; setScore(id: string, score: number): void}) {}

  join(identity: Identity, socket: WebSocket) {
    const existing = this.players.get(identity.id)
    if (!existing) {
      this.players.set(identity.id, {...identity, ...randomPosition(150), dx: 0, dy: 0, score: this.scoreStore.getScore(identity.id), color: COLORS[this.players.size % COLORS.length]!, emoteStartedAt: 0})
    } else {
      existing.username = identity.username
      existing.avatarUrl = identity.avatarUrl
    }
    this.sockets.get(identity.id)?.close(4000, 'Connected somewhere else')
    this.sockets.set(identity.id, socket)
    this.socketFoodVersions.set(identity.id, -1)
  }

  leave(id: string, socket: WebSocket) {
    if (this.sockets.get(id) !== socket) return
    this.sockets.delete(id)
    this.socketFoodVersions.delete(id)
    this.players.delete(id)
  }

  input(id: string, x: number, y: number) {
    const player = this.players.get(id)
    if (!player || !Number.isFinite(x) || !Number.isFinite(y)) return
    const length = Math.hypot(x, y)
    player.dx = length > 0 ? x / Math.max(1, length) : 0
    player.dy = length > 0 ? y / Math.max(1, length) : 0
  }

  emote(id: string) {
    const player = this.players.get(id)
    if (!player || Date.now() - player.emoteStartedAt < 700) return
    player.emoteStartedAt = Date.now()
  }

  addMessage(id: string, text: string, author: string) {
    const cleaned = text.replace(/\s+/g, ' ').trim().slice(0, 96)
    if (!cleaned || this.foods.has(id)) return false
    this.foods.set(id, {id, text: cleaned, author: author.slice(0, 40), ...randomPosition(), createdAt: Date.now()})
    this.foodVersion += 1
    while (this.foods.size > FOOD_LIMIT) {
      const oldest = this.foods.keys().next().value as string | undefined
      if (!oldest) break
      this.foods.delete(oldest)
      this.foodVersion += 1
    }
    return true
  }

  tick(deltaSeconds: number) {
    const dt = Math.min(deltaSeconds, 0.1)
    const now = Date.now()
    for (const [id, food] of this.foods) {
      if (now - food.createdAt > FOOD_LIFETIME_MS) {
        this.foods.delete(id)
        this.foodVersion += 1
      }
    }
    for (const player of this.players.values()) {
      const speed = Math.max(115, 225 - playerRadius(player.score) * 1.6)
      player.x = (player.x + player.dx * speed * dt + WORLD.width) % WORLD.width
      player.y = (player.y + player.dy * speed * dt + WORLD.height) % WORLD.height
      const radius = playerRadius(player.score)
      for (const [foodId, food] of this.foods) {
        if (Math.hypot(player.x - food.x, player.y - food.y) <= radius + 10) {
          this.foods.delete(foodId)
          this.foodVersion += 1
          player.score += 1
          this.scoreStore.setScore(player.id, player.score)
        }
      }
    }
  }

  broadcast() {
    const players = [...this.players.values()]
    const foods = [...this.foods.values()]
    const leaderboard = players.map(({id, username, score, color}) => ({id, username, score, color}))
      .sort((a, b) => b.score - a.score || a.username.localeCompare(b.username)).slice(0, 8)
    for (const [selfId, socket] of this.sockets) {
      if (socket.readyState !== socket.OPEN) continue
      const includeFoods = this.socketFoodVersions.get(selfId) !== this.foodVersion
      const snapshot: WireSnapshot = {type: 'snapshot', now: Date.now(), selfId, world: WORLD, players, leaderboard}
      if (includeFoods) {
        snapshot.foods = foods
        this.socketFoodVersions.set(selfId, this.foodVersion)
      }
      socket.send(JSON.stringify(snapshot))
    }
  }
}
