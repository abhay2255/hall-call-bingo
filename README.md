# Hall Call — Multiplayer Games

Real-time multiplayer party games. Pick **Hall Call Bingo** or **Grid Wars**
from the landing screen, one player creates a room, 1–3 friends join with a
4-letter code, and everyone plays together over Socket.IO.

## Hall Call Bingo

- Choose a board size when you create a room: **5×5** (numbers 1–25),
  **6×6** (1–36), or **7×7** (1–49).
- Choose how many players the room holds: **2, 3, or 4**.
- Win pattern is the classic **5 lines** (rows/columns/diagonals) — the
  "X Marks the Spot" pattern has been removed.
- Choose how boards are filled: **Random Shuffle** (numbers auto-shuffled
  for you, like always) or **Manual Entry** — every player gets a blank
  grid and taps cells in order to fill in 1, 2, 3… (tap a filled cell again
  to remove it — everything after it shifts back automatically). Anyone
  who runs out of time or leaves gaps gets the rest of their board
  auto-filled randomly so the round can still begin on time.
- Choose **speed mode**: off, or a 10/15/30 second countdown per turn. Run
  out the clock and your turn is automatically skipped.
- **Board mode, setup time, and speed mode can all be changed from the
  lobby screen too** — not just at room creation — so the host can switch
  a room to Manual Entry (or back) before any round, including rematches.
- Once the host starts the game, every player gets their **own board** with
  the numbers shuffled independently.
- Play happens **in turns**, cycling through the players in the order they
  joined. Only the current player can tap a cell on their board; everyone
  else's board is locked and shows "Waiting for &lt;name&gt;'s turn…" until
  it comes back around to them.
- On your turn, tap any unmarked number on **your own board**. That single
  tap calls the number for the whole room, and it's **instantly colored in
  on every player's board** that has it — no one else needs to tap anything
  to catch up.
- A number can only ever be called once — once it's out, it's marked
  everywhere it appears and can't be selected again.
- After each turn, play passes to the next player automatically.
- First player to complete 5 lines wins the round.

### Power-ups

Each player gets **one of each power-up per round**, usable instead of
calling a number on your turn:

- **👀 Peek** — reveals one random unmarked number from every opponent's
  board, just to you.
- **⏭️ Skip** — skips the very next player's turn entirely.
- **🔀 Swap** — trade your entire board (numbers, marks, and progress) with
  an opponent of your choice. High risk, high reward — you might steal a
  near-win, or hand yours away.

### Reactions & sound

Tap an emoji under the board to send a floating reaction the whole room
can see. There's also a row of **voice-line buttons** using real audio
clips — tapping one plays the clip and broadcasts it to everyone in the
room in real time. Numbers get a synthesized "ding" and a spoken call-out
as they're called — mute everything with the speaker icon in the game
header.

### Rematch & series score

After a round ends, hit **Rematch** to go back to the lobby with the same
room and players (fresh boards, fresh power-ups) instead of leaving. Each
player's win count carries across rounds and is shown in the lobby, on the
scoreboard, and on the end-of-round screen — handy for a best-of-3 or
best-of-5 series.

## Grid Wars (dots and boxes)

- Pick **⚡ Grid Wars** on the landing screen instead of Bingo.
- Choose a box grid size (**3×3**, **4×4**, or **5×5** boxes) and how many
  players (2–4) when creating the room.
- Play happens **in turns**. On your turn, tap any undrawn line between two
  dots to draw it.
- Complete the 4th side of a box and you **claim it and get an extra turn**
  — the classic dots-and-boxes bonus-turn rule. Keep chaining boxes as long
  as you keep completing them.
- Each player is assigned a color, shown on their drawn lines, claimed
  boxes, and in the scoreboard.
- When every line on the board is drawn, the player with the most boxes
  wins. Ties are a draw. Rematch and series-win tracking work the same way
  as Bingo.

No database is used — everything lives in server memory for the lifetime of
the process, which is all games like this need.

## Project structure

```
bingo-app/
├── package.json
├── server.js          # Express + Socket.IO server, all game logic
├── public/
│   ├── index.html
│   ├── style.css
│   └── client.js
└── README.md
```

## 1. Run it locally first (optional but recommended)

```bash
npm install
npm start
```

Visit `http://localhost:3000`, open a second tab (or another browser), create
a room in one tab and join it from the other using the room code, to try the
multiplayer flow before deploying.

## 2. Deploy to an EC2 instance

These steps assume a fresh **Ubuntu 22.04/24.04** EC2 instance.

### a) Launch the instance & open the port

1. Launch an EC2 instance (a `t3.micro`/`t2.micro` is plenty for a casual
   Bingo room).
2. In the instance's **Security Group**, add an inbound rule:
   - Type: Custom TCP, Port: `3000` (or `80` if you follow step *e* below),
     Source: `0.0.0.0/0` (or your own IP for testing).
   - Keep the default SSH rule (port 22) so you can connect.

### b) Connect and install Node.js

```bash
ssh -i your-key.pem ubuntu@<EC2_PUBLIC_IP>

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

### c) Upload the project

From your own machine (not the EC2 box), zip and copy this folder up:

```bash
scp -i your-key.pem -r bingo-app ubuntu@<EC2_PUBLIC_IP>:~/bingo-app
```

### d) Install dependencies and start the server

Back on the EC2 instance:

```bash
cd ~/bingo-app
npm install
npm start
```

Visit `http://<EC2_PUBLIC_IP>:3000` — the lobby screen should load. Open the
same URL on two different devices/browsers to test multiplayer for real.

### e) Keep it running after you disconnect

Use `pm2` so the server survives SSH disconnects and restarts on crash/reboot:

```bash
sudo npm install -g pm2
pm2 start server.js --name hall-call-bingo
pm2 save
pm2 startup      # follow the printed command to enable boot startup
```

Useful pm2 commands: `pm2 logs hall-call-bingo`, `pm2 restart hall-call-bingo`.

### f) Optional: serve on port 80 with a normal URL

Port 3000 works fine, but if you'd rather share `http://<EC2_PUBLIC_IP>/`
without a port number, put Nginx in front as a reverse proxy:

```bash
sudo apt-get install -y nginx
```

Create `/etc/nginx/sites-available/bingo`:

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Then enable it and open port 80 in the security group instead of 3000:

```bash
sudo ln -s /etc/nginx/sites-available/bingo /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

The `Upgrade`/`Connection` headers above are important — Socket.IO needs
WebSocket upgrade support to pass through the proxy cleanly.

### g) Optional: HTTPS

If you point a domain name at the instance, `sudo apt-get install -y certbot
python3-certbot-nginx` and run `sudo certbot --nginx` to get a free TLS
certificate — handy if you want to avoid "not secure" warnings when sharing
the link.

## Notes & easy extensions

- Game state is in-memory only; restarting the server clears any in-progress
  rooms. That's expected for a casual party game.
- `maxPlayers` is capped at 4 per the brief, but the cap lives in one line in
  `server.js` (`Math.min(4, ...)`) if you ever want to raise it.
- The win condition is 5 completed lines (any mix of rows/columns/diagonals)
  regardless of board size, matching the classic BINGO word. If you'd rather
  require a "blackout" (full board) for 6×6/7×7, that's a small change to
  `countLines`/the win check in `server.js`.
