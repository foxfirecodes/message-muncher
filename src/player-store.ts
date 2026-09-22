import {mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'

type StoredPlayer = {score: number; updatedAt: string}
type StoreFile = {version: 1; players: Record<string, StoredPlayer>}

export class PlayerStore {
  private readonly players = new Map<string, StoredPlayer>()
  private dirty = false
  private timer?: NodeJS.Timeout
  private flushChain = Promise.resolve()

  constructor(private readonly path: string, private readonly debounceMs = 2_000) {}

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoreFile>
      if (parsed.version !== 1 || !parsed.players) throw new Error('Unsupported player store format')
      for (const [id, player] of Object.entries(parsed.players)) {
        if (Number.isFinite(player.score) && player.score >= 0) this.players.set(id, player)
      }
      console.log(`Loaded ${this.players.size} persisted player score${this.players.size === 1 ? '' : 's'}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`Could not load player scores from ${this.path}`, error)
    }
  }

  getScore(id: string) {
    if (id.startsWith('guest-')) return 0
    return this.players.get(id)?.score ?? 0
  }

  setScore(id: string, score: number) {
    if (id.startsWith('guest-')) return
    const normalized = Math.max(0, Math.floor(score))
    if (this.players.get(id)?.score === normalized) return
    this.players.set(id, {score: normalized, updatedAt: new Date().toISOString()})
    this.dirty = true
    this.scheduleFlush()
  }

  private scheduleFlush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), this.debounceMs)
    this.timer.unref()
  }

  async flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.flushChain = this.flushChain.then(async () => {
      if (!this.dirty) return
      this.dirty = false
      const file: StoreFile = {version: 1, players: Object.fromEntries(this.players)}
      const temporaryPath = `${this.path}.tmp`
      try {
        await mkdir(dirname(this.path), {recursive: true})
        await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
        await rename(temporaryPath, this.path)
      } catch (error) {
        this.dirty = true
        console.error(`Could not persist player scores to ${this.path}`, error)
      }
    })
    await this.flushChain
    if (this.dirty) this.scheduleFlush()
  }
}
