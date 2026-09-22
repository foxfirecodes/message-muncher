# Message Muncher

A realtime Discord App Channel game. New messages in the configured channel appear as snacks on a shared world map; players move with WASD or the arrow keys, grow by eating messages, and race up the live leaderboard.

## Run locally

```sh
npm install
npm run dev
```

Open <http://localhost:3000>. Local development automatically uses guest players and seeds demo messages. Use the input at the bottom of the game to spawn more.

## Connect Discord

1. Create an application, root URL mapping, OAuth redirect, bot installation, and App Channel by following the supplied App Channels guide.
2. In **Bot**, enable the **Message Content Intent**. The bot needs it to turn message text into game objects.
3. Enable Developer Mode in Discord, right-click the App Channel, and copy its channel ID.
4. Copy `.env.example` to `.env` and fill in the application ID, client secret, bot token, channel ID, and a random session secret. The server loads `.env` automatically on startup.
5. Start the app and tunnel port 3000 with `cloudflared tunnel --url http://localhost:3000`.
6. Set the Activity root mapping to the tunnel hostname (without `https://`) and open the App Channel.

The frontend, API, and `/ws` WebSocket all use relative same-origin URLs, as required by Discord's proxy. One configured channel maps to one isolated arena; this intentionally prevents message contents from leaking across servers or channels.

Authenticated player scores are restored by Discord user ID from `data/player-scores.json`. Score changes stay buffered in memory and are atomically written after two seconds of inactivity or during graceful shutdown. Set `PLAYER_DATA_PATH` to move the file; mount that location on persistent storage in production.

## Production

Run `npm run build` and `npm start` on a host that supports HTTPS and WebSockets. Set `NODE_ENV=production`; guest players, seeded messages, and the demo-message endpoint are then disabled. This MVP stores the world in one Node process, so use a single instance. Add shared state (for example Redis) before scaling horizontally.
