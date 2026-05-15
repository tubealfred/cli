# @tubealfred/cli

Command-line access to the [TubeAlfred YouTube API](https://tubealfred.com/docs).

## Install

Run on demand:

```bash
npx -y @tubealfred/cli --help
```

Or install globally:

```bash
npm install -g @tubealfred/cli
```

## Configuration

Set your TubeAlfred API key:

```bash
export TUBEALFRED_API_KEY=ta_live_...
```

Optional:

```bash
export TUBEALFRED_API_URL=https://api.tubealfred.com
```

## Commands

```bash
tubealfred video VIDEO_ID
tubealfred transcript VIDEO_ID
tubealfred comments VIDEO_ID --count 100
tubealfred channel CHANNEL_ID_OR_HANDLE
tubealfred channel-videos CHANNEL_ID_OR_HANDLE
tubealfred search "laravel queues"
tubealfred suggestions "laravel"
tubealfred playlist PLAYLIST_ID
tubealfred resolve "https://www.youtube.com/watch?v=..."
```

Use `--json` to print raw JSON.

## License

MIT
