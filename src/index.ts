import { Command } from "commander";

const PRODUCT_NAME = "TubeAlfred CLI";
const PACKAGE_VERSION = "0.1.0";
const DEFAULT_API_URL = "https://api.tubealfred.com";

type HttpMethod = "GET" | "POST";
type QueryValue = string | number | boolean | undefined;

interface RequestOptions {
  method?: HttpMethod;
  path: string;
  query?: Record<string, QueryValue>;
  body?: Record<string, unknown>;
}

interface GlobalOptions {
  apiKey?: string;
  apiUrl?: string;
  json?: boolean;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];

  return value === undefined || value === "" ? undefined : value;
}

function fail(message: string): never {
  process.stderr.write(`[${PRODUCT_NAME}] ${message}\n`);
  process.exit(1);
}

function getGlobalOptions(command: Command): Required<GlobalOptions> {
  const options = command.optsWithGlobals<GlobalOptions>();
  const apiKey = options.apiKey ?? readEnv("TUBEALFRED_API_KEY") ?? readEnv("TUBE_ALFRED_API_KEY");
  const apiUrl = options.apiUrl ?? readEnv("TUBEALFRED_API_URL") ?? DEFAULT_API_URL;

  if (!apiKey) {
    fail("Missing TUBEALFRED_API_KEY. Create one at https://tubealfred.com/app/api-keys.");
  }

  return {
    apiKey,
    apiUrl: apiUrl.replace(/\/+$/, ""),
    json: options.json ?? false,
  };
}

function appendQuery(url: URL, query: Record<string, QueryValue> = {}): void {
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
}

async function request(command: Command, options: RequestOptions): Promise<unknown> {
  const globals = getGlobalOptions(command);
  const url = new URL(options.path, `${globals.apiUrl}/`);
  appendQuery(url, options.query);

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${globals.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": `tubealfred-cli/${PACKAGE_VERSION} (node ${process.versions.node})`,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const body = text ? parseJson(text) : null;

  if (!response.ok) {
    const detail = typeof body === "object" && body !== null ? JSON.stringify(body, null, 2) : text;
    fail(`Request failed with HTTP ${response.status}.\n${detail}`);
  }

  return body;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function printJson(value: unknown, compact = false): void {
  process.stdout.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
}

function unwrapData(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "data" in value) {
    return (value as { data: unknown }).data;
  }

  return value;
}

function extractTranscriptText(value: unknown): string | null {
  const data = unwrapData(value);

  if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    const transcript = record.transcript;

    if (typeof transcript === "string") {
      return transcript;
    }

    if (Array.isArray(transcript)) {
      return transcript
        .map((segment) => {
          if (typeof segment === "string") {
            return segment;
          }

          if (typeof segment === "object" && segment !== null && "text" in segment) {
            const text = (segment as { text?: unknown }).text;

            return typeof text === "string" ? text : "";
          }

          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    const text = record.text;
    if (typeof text === "string") {
      return text;
    }
  }

  return null;
}

function addContinuationOptions(command: Command): Command {
  return command.option("--continuation-token <token>", "pagination continuation token");
}

function output(command: Command, value: unknown, options: { transcriptText?: boolean } = {}): void {
  const globals = getGlobalOptions(command);

  if (options.transcriptText && !globals.json) {
    const text = extractTranscriptText(value);

    if (text) {
      process.stdout.write(`${text}\n`);
      return;
    }
  }

  printJson(value, globals.json);
}

const program = new Command()
  .name("tubealfred")
  .description("TubeAlfred command-line tools for YouTube data.")
  .version(PACKAGE_VERSION)
  .option("--api-key <key>", "TubeAlfred API key. Defaults to TUBEALFRED_API_KEY.")
  .option("--api-url <url>", "TubeAlfred API base URL.", DEFAULT_API_URL)
  .option("--json", "print compact JSON");

program
  .command("video")
  .argument("<video_id>", "YouTube video ID")
  .description("Fetch YouTube video details.")
  .action(async (videoId: string, _options: unknown, command: Command) => {
    const value = await request(command, {
      path: `/api/v1/youtube/video/${encodeURIComponent(videoId)}`,
    });
    output(command, value);
  });

program
  .command("transcript")
  .argument("<video_id>", "YouTube video ID")
  .description("Fetch a YouTube video transcript.")
  .action(async (videoId: string, _options: unknown, command: Command) => {
    const value = await request(command, {
      path: `/api/v1/youtube/video/${encodeURIComponent(videoId)}/transcript/fast`,
    });
    output(command, value, { transcriptText: true });
  });

program
  .command("comments")
  .argument("<video_id>", "YouTube video ID")
  .description("Fetch the first comments page for a video.")
  .option("--count <count>", "number of comments to fetch", parseInt)
  .action(async (videoId: string, options: { count?: number }, command: Command) => {
    const value = await request(command, {
      path: `/api/v1/youtube/video/${encodeURIComponent(videoId)}/comments`,
      query: { count: options.count },
    });
    output(command, value);
  });

program
  .command("comments-page")
  .argument("<video_id>", "YouTube video ID")
  .requiredOption("--continuation-token <token>", "pagination continuation token")
  .option("--count <count>", "number of comments to fetch", parseInt)
  .description("Fetch a subsequent comments page.")
  .action(async (videoId: string, options: { continuationToken: string; count?: number }, command: Command) => {
    const value = await request(command, {
      method: "POST",
      path: `/api/v1/youtube/video/${encodeURIComponent(videoId)}/comments/page`,
      body: {
        continuation_token: options.continuationToken,
        count: options.count,
      },
    });
    output(command, value);
  });

program
  .command("channel")
  .argument("<channel_id>", "UC channel ID, @handle, or username")
  .description("Fetch YouTube channel details.")
  .action(async (channelId: string, _options: unknown, command: Command) => {
    const value = await request(command, {
      path: `/api/v1/youtube/channel/${encodeURIComponent(channelId)}`,
    });
    output(command, value);
  });

addContinuationOptions(
  program
    .command("channel-videos")
    .argument("<channel_id>", "UC channel ID, @handle, or username")
    .description("Fetch latest videos for a channel."),
).action(async (channelId: string, options: { continuationToken?: string }, command: Command) => {
  const value = await request(command, {
    path: `/api/v1/youtube/channel/${encodeURIComponent(channelId)}/videos`,
    query: { continuation_token: options.continuationToken },
  });
  output(command, value);
});

addContinuationOptions(
  program
    .command("search")
    .argument("<query>", "search query")
    .description("Search YouTube."),
).action(async (query: string, options: { continuationToken?: string }, command: Command) => {
  const value = await request(command, {
    path: "/api/v1/youtube/search/",
    query: {
      query,
      continuation_token: options.continuationToken,
    },
  });
  output(command, value);
});

program
  .command("suggestions")
  .argument("<query>", "partial search query")
  .description("Fetch YouTube search suggestions.")
  .option("--prev <query>", "previous query context")
  .action(async (query: string, options: { prev?: string }, command: Command) => {
    const value = await request(command, {
      path: "/api/v1/youtube/search/suggestions",
      query: { q: query, prev: options.prev },
    });
    output(command, value);
  });

addContinuationOptions(
  program
    .command("playlist")
    .argument("<playlist_id>", "YouTube playlist ID")
    .description("Fetch playlist contents."),
).action(async (playlistId: string, options: { continuationToken?: string }, command: Command) => {
  const value = await request(command, {
    path: `/api/v1/youtube/playlist/${encodeURIComponent(playlistId)}`,
    query: { continuation_token: options.continuationToken },
  });
  output(command, value);
});

program
  .command("resolve")
  .argument("<url>", "YouTube URL")
  .description("Resolve a YouTube URL into canonical identifiers.")
  .action(async (url: string, _options: unknown, command: Command) => {
    const value = await request(command, {
      path: "/api/v1/youtube/resolve",
      query: { url },
    });
    output(command, value);
  });

program.parseAsync().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
