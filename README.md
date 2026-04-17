# ⚔️ Evony Discord Bot

A Discord bot that shares Barbarian, Ares, and Pyramid coordinates for the Evony game.

## 📋 Features

- ✅ Barbarian coordinate lookup
- ✅ Ares coordinate lookup
- ✅ Pyramid coordinate lookup (with level filtering)
- ✅ Automatic web scraping from iScout.club (Puppeteer)
- ✅ User coordinate storage and distance-based sorting
- ✅ Auto-scraping scheduler (5-minute rotation)
- ✅ Server log viewing (pagination/filtering)
- ✅ Command alias support
- ✅ Prisma database integration
- ✅ Hot reload development environment
- ✅ Error handling

## 🚀 Installation

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables Setup

Create a `.env` file and configure the required information:

```bash
cp env.example .env
```

Open the `.env` file and enter the following information:

```env
# Discord bot token
DISCORD_TOKEN=your_discord_bot_token_here

# iScout.club account information
ISCOUT_URL=https://www.iscout.club/en
ISCOUT_EMAIL=your_email@example.com
ISCOUT_PASSWORD=your_password

# Database (SQLite)
DATABASE_URL="file:./dev.db"

# Puppeteer Chrome path (optional, auto-detected)
# PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

### 3. Creating a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Enter an application name and create
4. Select "Bot" from the left menu
5. Click "Reset Token" to generate a token
6. Copy the generated token to `DISCORD_TOKEN` in your `.env` file

### 4. Bot Permission Setup

1. In the Developer Portal's "Bot" menu:

   - Enable the following in **Privileged Gateway Intents** section:
     - ✅ SERVER MEMBERS INTENT
     - ✅ MESSAGE CONTENT INTENT

2. In "OAuth2" → "URL Generator" menu:

   - **SCOPES**: Select `bot`
   - **BOT PERMISSIONS**:
     - ✅ Send Messages
     - ✅ Send Messages in Threads
     - ✅ Embed Links
     - ✅ Read Message History
     - ✅ Use Slash Commands

3. Invite the bot to your server using the generated URL

### 5. Database Initialization

Initialize the database using Prisma:

```bash
# Generate Prisma client
npx prisma generate

# Apply database schema
npx prisma db push
```

## 💻 Running the Bot

### Development Mode (Direct TypeScript execution)

```bash
npm run dev
```

### 🐛 Debug Mode (VS Code)

Press **F5** to:

- ✅ Automatically start TypeScript Watch mode
- ✅ Automatically attach debugger
- ✅ Set breakpoints
- ✅ Auto-recompile on code changes

Or in VS Code:

1. Click "Run and Debug" in the left sidebar (Ctrl+Shift+D / Cmd+Shift+D)
2. Select "🔥 Discord Bot (Hot Reload)"
3. Click the play button or press **F5**

### Production Mode

```bash
# Build
npm run build

# Run
npm start
```

### Other Scripts

```bash
# TypeScript watch mode (auto-recompile)
npm run watch

# Development mode + auto-restart (hot reload)
npm run dev:watch
```

## 🔄 Auto-Scraping System

The bot automatically scrapes coordinates in rotation:

```
0 min   → 🔺 Pyramid
5 min   → 🗡️ Barbarian
10 min  → ⚡ Ares
15 min  → 🔺 Pyramid (repeat)
```

- **Each type updates every 15 minutes**
- **Reduced server load** (distributed scraping)
- Check current schedule with `!status`
- Initial scraping of all types on bot startup

## 🎯 Key Features in Detail

### 📍 Distance-Based Sorting

Once you save your coordinates with `!setpos`:

- Pyramid searches are sorted by proximity
- Sort priority: **Higher level first** → **Closer distance first**
- Distance displayed for each coordinate (📏 icon)

```bash
!setpos 500 600    # Save your coordinates
!pyramid          # View results sorted by distance
!pyramid 5        # Level 5 only, sorted by distance
```

## 📝 Available Commands

### 📍 Coordinate Commands

| Command           | Aliases        | Description                              |
| ----------------- | -------------- | ---------------------------------------- |
| `!barbarian`      | `!bb`, `!barb` | Display barbarian coordinates            |
| `!ares`           | `!ar`          | Display Ares coordinates                 |
| `!pyramid [level]` | `!py`, `!pyr`  | Display pyramid coordinates (level filter available) |

### 📍 Position Commands

| Command           | Aliases             | Description                 |
| ----------------- | ------------------- | --------------------------- |
| `!setpos <X> <Y>` | `!pos`, `!position` | Save your coordinates       |
| `!mypos`          | `!getpos`           | View your saved coordinates |
| `!positions`      | -                   | View all user coordinates   |

### ⚙️ System Commands

| Command        | Description                        |
| -------------- | ---------------------------------- |
| `!help`        | Display all commands               |
| `!about`       | Explain how the bot works          |
| `!status`      | Check cache status and schedule    |
| `!logs [filter]` | View server logs (pagination support) |

### Usage Examples

```bash
# Coordinate lookup
!barbarian
!bb
!ares
!pyramid 5  # Level 5 pyramids only

# Position setting
!setpos 500 600
!mypos
!positions

# System
!status
!logs
!logs error  # Error logs only
```

## 📁 Project Structure

```
evony-bot/
├── src/
│   ├── index.ts              # Main entry point (Discord bot initialization)
│   ├── commands/
│   │   └── index.ts          # Discord command handlers
│   ├── services/
│   │   ├── cache.ts          # Scraping data caching
│   │   ├── db.ts             # Prisma database service
│   │   ├── scheduler.ts      # Auto-scraping scheduler
│   │   └── scraper.ts        # Puppeteer web scraping
│   ├── types/
│   │   └── coordinate.ts     # Coordinate type definitions
│   └── utils/
│       ├── coordinateTypes.ts # Coordinate type helper functions
│       ├── distance.ts        # Distance calculation utilities
│       └── format.ts          # Formatting utilities (power, etc.)
├── prisma/
│   ├── schema.prisma         # Prisma schema
│   └── migrations/           # Database migrations
├── .env                      # Environment variables (not included in git)
├── env.example               # Environment variable example
├── ecosystem.config.js       # PM2 configuration
├── package.json
├── tsconfig.json
└── README.md
```

## 🌐 iScout.club Scraping System

The bot automatically collects coordinate data from [iScout.club](https://www.iscout.club).

### Scraping Method

- **Puppeteer + Stealth Plugin**: Bypass bot detection
- **Auto Login**: Minimize re-login with session saving
- **Cloudflare Response**: Automatic captcha handling
- **Preset Selection**: Uses "EvonyBot" preset for filtering

### Data Flow

```
iScout.club (Website)
    ↓ Puppeteer scraping
Scraper Service (src/services/scraper.ts)
    ↓ Data refinement
Cache Service (src/services/cache.ts)
    ↓ On command request
Discord command response
```

### Scraping Configuration

Configure your iScout.club account information in the `.env` file:

```env
ISCOUT_URL=https://www.iscout.club/en
ISCOUT_EMAIL=your_email@example.com
ISCOUT_PASSWORD=your_password
```

### Supported Features

- ✅ **Barbarian**: Includes level, power, and alliance information
- ✅ **Pyramid**: Automatically filters levels 4 and 5
- ✅ **Ares**: Basic coordinate information
- ✅ **Auto Retry**: Retry on next cycle if scraping fails

## 🛠️ Tech Stack

- **Runtime**: Node.js + TypeScript
- **Discord**: Discord.js v14
- **Web Scraping**: Puppeteer + Stealth Plugin
- **Database**: Prisma + SQLite
- **Process Management**: PM2 (production)
- **Development Tools**: ts-node, ts-node-dev

## 💾 Database Schema

The bot uses Prisma and SQLite to store the following data:

### User

- Discord ID
- Username
- X, Y coordinates
- Min/Max power range (barbarian filter)
- Created/Updated timestamps

## 🔧 TypeScript Configuration

The project is written in TypeScript, and settings can be changed in the `tsconfig.json` file.

### VS Code Debugging Tips

1. **Set Breakpoint**: Click to the left of line numbers to add a red dot
2. **F5**: Start debugging
3. **F10**: Step over
4. **F11**: Step into
5. **Shift+F11**: Step out
6. **F9**: Toggle breakpoint
7. **Shift+F5**: Stop debugging

### Debug Modes

- **🔥 Discord Bot (Hot Reload)**: Auto-restart on code changes (default)
- **🤖 Discord Bot Debug**: Breakpoint debugging
- **🚀 Discord Bot (Built Files)**: Production-like execution

### TypeScript Watch Mode

TypeScript watch mode automatically runs when you start debugging. Code is automatically recompiled on save.

## 🚀 Server Deployment (evony-bot SSH)

### Quick Deployment Command

```bash
# Run deployment script (recommended)
./deploy.sh
```

Or manual deployment:

```bash
# Build & Deploy (run locally)
cd "/Users/devjm/Documents/Persnal Project/Evony Bot" && \
npm run build && \
tar -czf /tmp/evony-bot.tar.gz \
  --exclude='node_modules' \
  --exclude='chrome' \
  --exclude='chrome-user-data' \
  --exclude='.git' \
  --exclude='*.log' \
  --exclude='.env' \
  --exclude='*.db' \
  --exclude='*.db-journal' \
  --exclude='*.png' \
  --exclude='*.html' \
  . && \
scp /tmp/evony-bot.tar.gz evony-bot:~/ && \
ssh evony-bot "cd ~/evony-bot && tar -xzf ~/evony-bot.tar.gz && npx prisma migrate deploy && pm2 restart evony-bot"
```

**⚠️ Important**: Database files are excluded with `--exclude='*.db'` to preserve server data.

### Initial Server Setup

```bash
# 1. SSH connection
ssh evony-bot

# 2. Create project directory
mkdir -p ~/evony-bot && cd ~/evony-bot

# 3. Extract files
tar -xzf ~/evony-bot.tar.gz

# 4. Install dependencies
npm install

# 5. Prisma setup
npx prisma generate
npx prisma db push

# 6. Environment variable setup (create .env)
cat >> .env << EOF
DISCORD_TOKEN=your_token_here
ISCOUT_URL=https://www.iscout.club/en
ISCOUT_EMAIL=your_email
ISCOUT_PASSWORD=your_password
DATABASE_URL="file:./dev.db"
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
EOF

# 7. Start with PM2
pm2 start ecosystem.config.js
pm2 save
```

### PM2 Commands

```bash
# View logs
pm2 logs evony-bot --lines 50

# Restart
pm2 restart evony-bot

# Check status
pm2 status

# Full restart (reload environment variables)
pm2 stop evony-bot && pm2 delete evony-bot && pm2 start ecosystem.config.js
```

### Important Notes

- ⚠️ **`.env` file is excluded from deployment** - Managed directly on the server
- ⚠️ **Database (`.db`) files are also excluded** - Preserves existing server data
- ⚠️ **PUPPETEER_EXECUTABLE_PATH** - Use `/usr/bin/chromium` on ARM64 servers
- ⚠️ **Prisma Migrations** - Deployment script automatically runs `prisma migrate deploy` on schema changes
- ✅ **Safe Deployment** - All user data and coordinate data are preserved

## 📚 References

- [Discord.js Official Documentation](https://discord.js.org/)
- [Discord.js Guide](https://discordjs.guide/)
- [Discord Developer Portal](https://discord.com/developers/applications)
- [Prisma Documentation](https://www.prisma.io/docs)
- [Puppeteer Documentation](https://pptr.dev/)
- [iScout.club](https://www.iscout.club) - Coordinate data source

## ⚠️ Warnings

- Never upload the `.env` file to GitHub!
- If your bot token is exposed, immediately regenerate it in the Discord Developer Portal.
- MESSAGE CONTENT INTENT must be enabled to read messages.
- Keep your iScout.club account information secure.
- Cloudflare captcha may need to be solved manually once initially.

## 🔧 Troubleshooting

### Chrome/Chromium Related Errors

**Problem**: Puppeteer cannot find Chrome

**Solution**:

```bash
# macOS (Homebrew)
brew install chromium

# Ubuntu/Debian
sudo apt-get install chromium-browser

# Or set environment variable
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

### Login Failure

**Problem**: iScout.club login failure

**Solution**:

1. Check email/password in `.env` file
2. Delete `chrome-user-data` folder and restart
3. Run in local environment with headless=false for manual login

### Database Errors

**Problem**: Prisma-related errors

**Solution**:

```bash
# Regenerate Prisma client
npx prisma generate

# Reset database
rm -f prisma/dev.db
npx prisma db push
```

### Log Checking

```bash
# Real-time log viewing
pm2 logs evony-bot --lines 100

# Or in Discord
!logs
!logs error
```

## 📄 License

ISC
