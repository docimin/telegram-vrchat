# telegram-vrchat

A Telegram DM bot that turns images into VRChat **stickers**, **emoji**, **animated emoji** and **prints**, plus a small **companion app** that uploads them to each person's own VRChat account.

Every conversation with the bot happens in a private chat. The bot is invite-only and meant for a group of friends.

## How it works

```
 friend's phone           your VPS                       friend's PC
 Telegram DM  ───────▶  bot: convert image  ◀─── poll ───  companion app
                        (sticker / emoji /                 (VRChat login lives here)
                         print / spritesheet)                    │
                                                                 ▼
                                                           VRChat API
```

1. A friend DMs the bot an image, GIF or short video and picks what it should become.
2. The bot converts it to VRChat's format and sends the finished PNG back. They can upload that file by hand at vrchat.com, no companion needed.
3. With the companion running on their PC, they tap **Upload to VRChat** instead. The companion picks up the job and uploads it with their own VRChat session.

### Why a companion app

VRChat's [Creator Guidelines](https://hello.vrchat.com/creator-guidelines) (API Usage section) say apps must never ask for or store anyone's VRChat credentials or session data, and must not act on another user's behalf: VRChat assumes API calls come from the user's own device and IP. A bot that logged into your friends' accounts from a server would get them and you moderated.

So the server never sees a VRChat login. The companion runs on each person's PC, logs in there (password goes straight to VRChat and is not saved, only the session cookie is kept locally), and uploads from that PC. The server only holds converted images and a per-device pairing token.

## What it makes

| Input | Output | Notes |
| --- | --- | --- |
| Image | Sticker | Transparent edges trimmed, fitted into 1024x1024 PNG, transparency kept |
| Image | Emoji | Same as sticker, plus one of VRChat's 27 emoji effects |
| Image | Print | 1920x1080 PNG. Non-16:9 photos: crop to fill, or fit on a blurred background. The caption becomes the print note |
| GIF / video (up to 60 s) | Animated emoji | 1024x1024 spritesheet in VRChat's 2x2 / 4x4 / 8x8 grid, up to 64 frames, frame rate picked to fit the clip |

Sticker, emoji and print uploads need VRC+. VRChat allows 18 custom stickers and 18 custom emoji per account.

Telegram compresses photos; send them as a *file* for full quality. Bots can download files up to 20 MB.

## Running the bot

You need a bot token from [@BotFather](https://t.me/BotFather), your numeric Telegram user ID, and a server with a public HTTPS address (the companion talks to it).

```bash
cp .env.example .env
```

Fill in `.env`, then pick one of the options below.

### Docker compose (VPS)

Builds the bot, the companion downloads and an HTTPS reverse proxy (Caddy). Set `DOMAIN` in `.env` and point that domain at the server.

```bash
docker compose up -d --build
```

### Directly with Bun

Needs Bun and `ffmpeg`/`ffprobe` on the PATH. Put it behind any HTTPS reverse proxy.

```bash
bun install
```

```bash
bun run build:companion
```

```bash
bun run start
```

The companion API listens on `PORT` (default 8080). Data (SQLite database and converted files) goes to `DATA_DIR`; files are deleted after 7 days.

## Using it

**Owner:** message the bot, then send `/invite` to get a one-time invite link for each friend. `/users` lists people, `/revoke <telegram id>` removes someone.

**Friends:**

1. Open the invite link and press Start.
2. Send an image, GIF or short video and pick Sticker, Emoji or Print.
3. For one-tap uploads, send `/pair`. Download the companion from the links in that message, run it, paste the pairing link, and log in to VRChat when it asks.
4. Keep the companion running while you want uploads to go through. Uploads tapped while it is off wait in the queue.

Other commands: `/devices` lists paired companions, `/unpair` disconnects them, `/help` shows the help text.

## The companion

Standalone executables for Windows, Linux and macOS (Apple Silicon) are built into `dist/` by `bun run build:companion` and served by the bot at `/download/windows`, `/download/linux` and `/download/macos`. Double-clicking it on Windows pairs, logs in and starts uploading. The binaries are unsigned, so Windows SmartScreen and macOS Gatekeeper will warn the first time.

```
vrc-companion            pair, log in and start uploading
vrc-companion pair LINK  pair using the link from /pair
vrc-companion login      log in to VRChat (supports authenticator, email and recovery codes)
vrc-companion logout     end the VRChat session on this PC
vrc-companion status     show pairing and login state
vrc-companion unpair     forget the pairing
```

It stores its config (bot URL, device token, VRChat session cookies) at:

- Windows: `%APPDATA%\vrc-companion\config.json`
- Linux: `~/.config/vrc-companion/config.json` (mode 600)
- macOS: `~/Library/Application Support/vrc-companion/config.json`

It identifies itself to VRChat as `VRCUploadCompanion/<version> <VRCHAT_CONTACT>`, backs off on HTTP 429 and 5xx, and makes no VRChat calls while idle (it waits on the bot, not on VRChat).

## Development

```bash
bun test
```

```bash
bun run typecheck
```

```
src/shared/     protocol between bot and companion, VRChat format constants
src/server/     bot server: config, SQLite store, job queue, companion API, converters, Telegram adapter
src/companion/  companion app: VRChat client, bot client, prompts, main loop
test/           converter tests, Telegram flow against a mock Bot API, end-to-end upload flow against a mock VRChat
```

Conversion (`items.ts`, `media.ts`), the queue and the companion API know nothing about Telegram; `bot.ts` is the only Telegram-specific file. A Discord adapter would be another file next to it that listens to the same queue events.

## Not verified yet

- Nothing has been uploaded to the real VRChat API yet. Endpoints and field names follow the community docs at [vrchat.community](https://vrchat.community) and are tested against a mock.
- Prints are uploaded as a plain 1920x1080 photo. The wiki says prints are stored at 1080p but does not say whether VRChat adds the white frame itself; check the first real print.
- The VRChat API is unofficial and can change without notice.
