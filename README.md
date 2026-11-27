# telegram-vrchat

Made by **Herr Coroni**.

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

Sticker, emoji and print uploads need VRC+.

### Transparency

Transparent PNG, WebP, GIF and WebM files keep their transparency in every output, and the bot says when it found any. Telegram sends *photos* as JPEG, which turns a transparent background white, so send images as a *file* to keep it (and full quality). Bots can download files up to 20 MB.

For images that arrive with a white background anyway, the bot offers **Remove white background**. It removes white connected to the image edges (white enclosed by an outline, like eyes or fur, stays) and softens the cut edge. **Undo background removal** brings the original back.

### Full inventory

VRChat allows 18 stickers, 18 emoji (animated ones included) and 64 prints. Before each upload the companion counts what is there. If there is no free slot, the bot says so, shows a preview and the date of your oldest item, and offers **Delete oldest and upload**. Nothing is deleted unless you tap that button, and only that exact item is deleted. **Retry** uploads again after you made room yourself.

## Running the bot

You need a bot token from [@BotFather](https://t.me/BotFather), your numeric Telegram user ID, and a server with a public HTTPS address (the companion talks to it).

```bash
cp .env.example .env
```

Fill in `.env`, then pick one of the options below.

### Docker compose (VPS)

Runs the bot plus Caddy, which gets an HTTPS certificate automatically. Point your domain at the server, then in `.env` set `DOMAIN` to it and `PUBLIC_URL` to `https://<that domain>`.

```bash
docker compose up -d --build
```

The bot's data (database and converted files) lives in the `bot-data` volume, so rebuilding or updating keeps it. Logs: `docker compose logs -f bot`.

### Docker only

The [Dockerfile](Dockerfile) builds a slim image (Bun, sharp, ffmpeg) that runs as a non-root user and has a health check. Put your own HTTPS reverse proxy in front of port 8080.

```bash
docker build -t telegram-vrchat .
```

```bash
docker run -d --name telegram-vrchat --restart unless-stopped --env-file .env -p 8080:8080 -v telegram-vrchat-data:/data telegram-vrchat
```

### Directly with Bun

Needs Bun and `ffmpeg`/`ffprobe` on the PATH. Put it behind any HTTPS reverse proxy.

```bash
bun install
```

```bash
bun run start
```

Run exactly one copy per bot token: Telegram delivers messages to only one poller and answers `409 Conflict` to the others. Don't scale the bot to more than one replica, and stop any copy on your PC once the server runs it. During a redeploy the old and new copy may overlap for a moment; the new one keeps retrying for up to 3 minutes until the old one is gone.

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

Standalone executables for Windows, Linux and macOS (Apple Silicon). The bot's `/download/windows`, `/download/linux` and `/download/macos` links (used in `/pair`) point to the latest GitHub release, or serve local builds from `DIST_DIR` if you made some with `bun run build:companion`. Double-clicking it on Windows pairs, logs in and starts uploading. The binaries are unsigned, so Windows SmartScreen and macOS Gatekeeper will warn the first time.

They are also attached to every [GitHub release](https://github.com/docimin/telegram-vrchat/releases). To publish one, bump `version` in `package.json` (the companion reports that version), push, and run the **Build companion** workflow from the Actions tab:

```bash
gh workflow run build-companion.yml
```

It typechecks, runs the tests, builds all three platforms and creates release `v<version>` with the binaries and a `SHA256SUMS` file. It stops if that release already exists. `-f release=false` builds without releasing and keeps the files as a workflow artifact instead.

```
vrc-companion            pair, log in and start uploading
vrc-companion pair LINK  pair using the link from /pair
vrc-companion login      log in to VRChat (supports authenticator, email and recovery codes)
vrc-companion logout     end the VRChat session on this PC
vrc-companion status     show pairing and login state
vrc-companion update     check for a newer version and install it
vrc-companion unpair     forget the pairing
```

It stores its config (bot URL, device token, VRChat session cookies) at:

- Windows: `%APPDATA%\vrc-companion\config.json`
- Linux: `~/.config/vrc-companion/config.json` (mode 600)
- macOS: `~/Library/Application Support/vrc-companion/config.json`

It identifies itself to VRChat as `VRCUploadCompanion/<version> <VRCHAT_CONTACT>`, backs off on HTTP 429 and 5xx, and makes no VRChat calls while idle (it waits on the bot, not on VRChat).

### Updates

On every start the companion asks GitHub for the latest release. If it is newer, it asks `Install it now? [Y/n]`. On yes it downloads the file for your system, checks it against the release's `SHA256SUMS`, replaces itself and restarts into the new version. On no it carries on and asks again next start. Without a terminal (for example as a background service) it only logs that an update exists, and when run from source with `bun run` it never replaces anything. On Windows the old `.exe` is moved aside to `.exe.old` and deleted on the next start.

Companions from before v0.2.0 have no updater, so friends on v0.1.0 need to download the new version once by hand.

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

- Sticker, emoji and print uploads have worked against the real VRChat API. Animated emoji, deleting the oldest item, and VRChat's response to a full inventory have only been tested against a mock. Endpoints and field names follow the community docs at [vrchat.community](https://vrchat.community).
- Prints are uploaded as a plain 1920x1080 photo. The wiki says prints are stored at 1080p but does not say whether VRChat adds the white frame itself; check the first real print.
- The inventory limits (18 / 18 / 64) come from the VRChat Wiki. VRChat's error message for a full inventory is undocumented; the companion also treats upload errors mentioning a limit as "full".
- The VRChat API is unofficial and can change without notice.

## Credits

Made by Herr Coroni.
