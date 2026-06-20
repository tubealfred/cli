# @tubealfred/cli

Command-line access to the [TubeAlfred API](https://tubealfred.com/docs).

Use it to fetch YouTube video, transcript, comment, reply, channel, Shorts, playlist, community, search, hashtag, suggestion, and URL resolution data, plus account billing usage, from your terminal through your TubeAlfred account.

## Requirements

- Node.js 18 or newer.
- A TubeAlfred account.
- A TubeAlfred API key with `youtube.read` for YouTube commands and `billing.read` for billing usage.

Create an API key in TubeAlfred:

```text
https://tubealfred.com/app/api-keys
```

Choose **Create key**, select the scopes you need, then copy the key immediately. TubeAlfred only shows the full key once.

## Install

Run on demand:

```bash
npx -y @tubealfred/cli --help
```

Or install globally:

```bash
npm install -g @tubealfred/cli
```

## Authentication

Set the API key you created at `https://tubealfred.com/app/api-keys`. Prefer an environment variable so your API key does not appear in shell history:

```bash
export TUBEALFRED_API_KEY=ta_live_...
```

Test keys are also supported:

```bash
export TUBEALFRED_API_KEY=ta_test_...
```

You can pass a key with `--api-key`, but environment variables are safer for regular use.

## Configuration

Production is the default API target:

```text
https://api.tubealfred.com
```

Override it only for local or staging testing:

```bash
export TUBEALFRED_API_URL=http://localhost:8000
```

or:

```bash
tubealfred --api-url http://localhost:8000 video VIDEO_ID
```

Network controls:

```bash
tubealfred --timeout 60000 --retries 2 video VIDEO_ID
```

## Commands

```bash
tubealfred video VIDEO_ID
tubealfred transcript VIDEO_ID
tubealfred comments VIDEO_ID --count 100
tubealfred comments-page VIDEO_ID --continuation-token TOKEN --count 100
tubealfred replies VIDEO_ID COMMENT_ID --count 100
tubealfred replies-page VIDEO_ID COMMENT_ID --continuation-token TOKEN --count 100
tubealfred channel CHANNEL_ID_OR_HANDLE
tubealfred channel-about CHANNEL_ID_OR_HANDLE
tubealfred channel-videos CHANNEL_ID_OR_HANDLE
tubealfred channel-shorts CHANNEL_ID_OR_HANDLE
tubealfred channel-playlists CHANNEL_ID_OR_HANDLE
tubealfred channel-community CHANNEL_ID_OR_HANDLE
tubealfred search "how to learn faster"
tubealfred search "how to learn faster" --upload-date month --duration three_to_twenty_mins --sort popularity --type video
tubealfred search "live coding" --live
tubealfred hashtag "#howto"
tubealfred suggestions "how to"
tubealfred playlist PLAYLIST_ID
tubealfred resolve "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
tubealfred billing-usage
```

## Search filters

`tubealfred search` accepts optional filters:

- `--upload-date <value>` — `all`, `today`, `week`, `month`, `year`
- `--duration <value>` — `all`, `under_three_mins`, `three_to_twenty_mins`, `over_twenty_mins`
- `--sort <value>` — `relevance`, `popularity`
- `--type <value>` — `all`, `video`, `shorts`, `channel`, `playlist`, `movie`
- `--features <list>` — comma-separated: `hd`, `subtitles`, `creative_commons`, `3d`, `live`, `purchased`, `4k`, `360`, `location`, `hdr`, `vr180`
- `--live` — shortcut for `--features live`
- `--shorts` — shortcut for `--type shorts`

Each search result's `description` is YouTube's truncated snippet. Use `tubealfred video VIDEO_ID` for a result's full description.

## Output

Default output is pretty JSON for most commands:

```bash
tubealfred video VIDEO_ID
```

Compact JSON:

```bash
tubealfred --format json video VIDEO_ID
```

Backward-compatible compact JSON shortcut:

```bash
tubealfred --json video VIDEO_ID
```

Transcript text output:

```bash
tubealfred transcript VIDEO_ID
```

Write output to a file:

```bash
tubealfred --output transcript.txt transcript VIDEO_ID
```

## Pagination

Some commands return a continuation token when more results are available. Pass that token into the matching page command:

```bash
tubealfred comments VIDEO_ID --count 100
tubealfred comments-page VIDEO_ID --continuation-token TOKEN --count 100
tubealfred replies VIDEO_ID COMMENT_ID --count 100
tubealfred replies-page VIDEO_ID COMMENT_ID --continuation-token TOKEN --count 100
```

Channel, playlist, search, hashtag, Shorts, playlists, and community pagination use the same `--continuation-token` option:

```bash
tubealfred search "creator economy" --continuation-token TOKEN
tubealfred hashtag "#creator" --continuation-token TOKEN
tubealfred channel-shorts @mkbhd --continuation-token TOKEN
```

## CI Usage

Create a TubeAlfred API key at `https://tubealfred.com/app/api-keys`, then set `TUBEALFRED_API_KEY` in your CI secret store and call the CLI normally:

```bash
npx -y @tubealfred/cli --format json video VIDEO_ID
```

## Troubleshooting

- `Missing TUBEALFRED_API_KEY`: export `TUBEALFRED_API_KEY` or pass `--api-key`.
- `API key must look like...`: check that the key starts with `ta_live_` or `ta_test_`.
- `Request timed out`: increase `--timeout` or retry later.
- `HTTP 401` or `HTTP 403`: check API key validity and account access.
- `HTTP 429`: reduce request rate or retry after your limit resets.
- `Text output is not available`: use `--format pretty` or `--format json` for non-transcript responses.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
