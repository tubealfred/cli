import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

import { Command, InvalidArgumentError } from "commander";

const PRODUCT_NAME = "TubeAlfred CLI";
const DEFAULT_API_URL = "https://api.tubealfred.com";
const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_RETRIES = 1;
const MIN_COUNT = 1;
const MAX_COUNT = 100;

type HttpMethod = "GET" | "POST";
type QueryValue = string | number | boolean | undefined;
type OutputFormat = "json" | "pretty" | "text";

interface PackageMetadata {
  version?: string;
}

interface RequestOptions {
  method?: HttpMethod;
  path: string;
  query?: Record<string, QueryValue>;
  body?: Record<string, unknown>;
}

interface GlobalOptions {
  apiKey?: string;
  apiUrl?: string;
  format?: OutputFormat;
  json?: boolean;
  output?: string;
  retries?: number;
  timeout?: number;
}

function packageVersion(): string {
  try {
    const metadata = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as PackageMetadata;

    return metadata.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];

  return value === undefined || value === "" ? undefined : value;
}

function fail(message: string): never {
  process.stderr.write(`[${PRODUCT_NAME}] ${message}\n`);
  process.exit(1);
}

function positiveInteger(value: string, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(`${label} must be a positive integer.`);
  }

  const parsed = Number.parseInt(value, 10);

  if (parsed < 1 || parsed > max) {
    throw new InvalidArgumentError(`${label} must be between 1 and ${max}.`);
  }

  return parsed;
}

function countOption(value: string): number {
  return positiveInteger(value, "Count", MAX_COUNT);
}

function retriesOption(value: string): number {
  return positiveInteger(value, "Retries", 5);
}

function timeoutOption(value: string): number {
  const timeout = positiveInteger(value, "Timeout", 300_000);

  if (timeout < 1_000) {
    throw new InvalidArgumentError("Timeout must be at least 1000 milliseconds.");
  }

  return timeout;
}

function validateNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new InvalidArgumentError(`${label} is required.`);
  }

  return trimmed;
}

function validateApiKey(apiKey: string): string {
  const trimmed = validateNonEmpty(apiKey, "API key");

  if (!/^ta_(live|test)_[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new InvalidArgumentError(
      "API key must look like a TubeAlfred key, for example ta_live_... or ta_test_....",
    );
  }

  return trimmed;
}

function validateBaseUrl(value: string): string {
  const trimmed = validateNonEmpty(value, "API URL");

  try {
    const url = new URL(trimmed);

    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new InvalidArgumentError("API URL must use https unless it points to localhost.");
    }

    return url.toString().replace(/\/+$/, "");
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      throw error;
    }

    throw new InvalidArgumentError("API URL must be a valid URL.");
  }
}

function getGlobalOptions(command: Command): Required<GlobalOptions> {
  const options = command.optsWithGlobals<GlobalOptions>();
  const apiKey = options.apiKey ?? readEnv("TUBEALFRED_API_KEY") ?? readEnv("TUBE_ALFRED_API_KEY");
  const apiUrl = options.apiUrl ?? readEnv("TUBEALFRED_API_URL") ?? DEFAULT_API_URL;

  if (!apiKey) {
    fail("Missing TUBEALFRED_API_KEY. Create one at https://tubealfred.com/app/api-keys.");
  }

  return {
    apiKey: validateApiKey(apiKey),
    apiUrl: validateBaseUrl(apiUrl),
    format: options.json ? "json" : options.format ?? "pretty",
    json: options.json ?? false,
    output: options.output ?? "",
    retries: options.retries ?? DEFAULT_RETRIES,
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
  };
}

function appendQuery(url: URL, query: Record<string, QueryValue> = {}): void {
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
}

function isTransientStatus(status: number): boolean {
  return [408, 429, 500, 502, 503, 504].includes(status);
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function request(command: Command, options: RequestOptions): Promise<unknown> {
  const globals = getGlobalOptions(command);
  const url = new URL(options.path, `${globals.apiUrl}/`);
  appendQuery(url, options.query);

  let lastNetworkError: unknown;

  for (let attempt = 0; attempt <= globals.retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), globals.timeout);

    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${globals.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": `tubealfred-cli/${packageVersion()} (node ${process.versions.node})`,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      const text = await response.text();
      const body = text ? parseJson(text) : null;

      if (response.ok) {
        return body;
      }

      if (attempt < globals.retries && isTransientStatus(response.status)) {
        await delay(250 * (attempt + 1));
        continue;
      }

      const detail = typeof body === "object" && body !== null ? JSON.stringify(body, null, 2) : text;
      fail(`Request failed with HTTP ${response.status}.\n${detail}`);
    } catch (error) {
      lastNetworkError = error;

      if (attempt < globals.retries && isNetworkError(error)) {
        await delay(250 * (attempt + 1));
        continue;
      }

      fail(networkErrorMessage(error, globals.timeout));
    } finally {
      clearTimeout(timeout);
    }
  }

  fail(networkErrorMessage(lastNetworkError, globals.timeout));
}

function networkErrorMessage(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === "AbortError") {
    return `Request timed out after ${timeoutMs}ms. Try again or increase --timeout.`;
  }

  if (error instanceof Error) {
    return `Network request failed: ${error.message}`;
  }

  return "Network request failed.";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function stringifyJson(value: unknown, compact = false): string {
  if (value === undefined) {
    return "";
  }

  return `${JSON.stringify(value, null, compact ? 0 : 2)}\n`;
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

    const segments = record.segments;
    if (Array.isArray(segments)) {
      return segments
        .map((segment) => {
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

  return typeof data === "string" ? data : null;
}

async function writeOutput(command: Command, content: string): Promise<void> {
  const globals = getGlobalOptions(command);

  if (globals.output) {
    await writeFile(globals.output, content, "utf8");
    return;
  }

  process.stdout.write(content);
}

async function output(
  command: Command,
  value: unknown,
  options: { defaultFormat?: OutputFormat; transcriptText?: boolean } = {},
): Promise<void> {
  const globals = getGlobalOptions(command);
  const format = globals.format === "pretty" && options.defaultFormat ? options.defaultFormat : globals.format;

  if (format === "text" || options.transcriptText) {
    const text = extractTranscriptText(value);

    if (text) {
      await writeOutput(command, `${text}\n`);
      return;
    }

    if (format === "text") {
      fail("Text output is not available for this response. Use --format pretty or --format json.");
    }
  }

  await writeOutput(command, stringifyJson(value, format === "json"));
}

function addContinuationOptions(command: Command): Command {
  return command.option("--continuation-token <token>", "pagination continuation token", (value) =>
    validateNonEmpty(value, "Continuation token"),
  );
}

function addRequiredContinuationOption(command: Command): Command {
  return command.requiredOption("--continuation-token <token>", "pagination continuation token", (value) =>
    validateNonEmpty(value, "Continuation token"),
  );
}

function addFieldsOption(command: Command): Command {
  return command.option("--fields <fields>", "comma-separated response fields", (value) =>
    validateNonEmpty(value, "Fields"),
  );
}

function addTranscriptOptions(command: Command): Command {
  return command
    .option("--language <code>", "preferred caption language code", (value) =>
      validateNonEmpty(value, "Language"),
    )
    .option("--kind <kind>", "caption track kind (manual, auto, any)", oneOf("Caption kind", ["manual", "auto", "any"]));
}

function oneOf(label: string, allowed: readonly string[]): (value: string) => string {
  return (value: string): string => {
    if (!allowed.includes(value)) {
      throw new InvalidArgumentError(`${label} must be one of: ${allowed.join(", ")}.`);
    }
    return value;
  };
}

function addSearchFilterOptions(command: Command): Command {
  return command
    .option("--channel-id <channel_id>", "restrict search to a channel ID, handle, or username", (value) =>
      validateNonEmpty(value, "Channel ID"),
    )
    .option(
      "--upload-date <value>",
      "filter by upload date (all, today, week, month, year)",
      oneOf("Upload date", ["all", "today", "week", "month", "year"]),
    )
    .option(
      "--duration <value>",
      "filter by duration (all, under_three_mins, three_to_twenty_mins, over_twenty_mins)",
      oneOf("Duration", ["all", "under_three_mins", "three_to_twenty_mins", "over_twenty_mins"]),
    )
    .option(
      "--sort <value>",
      "ranking preference (relevance, popularity)",
      oneOf("Sort", ["relevance", "popularity"]),
    )
    .option(
      "--type <value>",
      "result type (all, video, shorts, channel, playlist, movie)",
      oneOf("Type", ["all", "video", "shorts", "channel", "playlist", "movie"]),
    )
    .option(
      "--features <list>",
      "comma-separated features (hd, subtitles, creative_commons, 3d, live, purchased, 4k, 360, location, hdr, vr180)",
      (value) => validateNonEmpty(value, "Features"),
    )
    .option("--live", "shortcut for features=live")
    .option("--shorts", "shortcut for type=shorts");
}

function addCountOption(command: Command): Command {
  return command.option("--count <count>", `number of items to fetch (${MIN_COUNT}-${MAX_COUNT})`, countOption);
}

function addCommentSortOption(command: Command): Command {
  return command.option("--sort <value>", "comment sort order (top, newest)", oneOf("Sort", ["top", "newest"]));
}

function validateIds(values: string[], label: string): string[] {
  return values.map((value) => validateNonEmpty(value, label));
}

const program = new Command()
  .name("tubealfred")
  .description("TubeAlfred command-line tools for YouTube data and account usage.")
  .version(packageVersion())
  .option("--api-key <key>", "TubeAlfred API key. Prefer TUBEALFRED_API_KEY for shell safety.")
  .option("--api-url <url>", "TubeAlfred API base URL.", DEFAULT_API_URL)
  .option("--format <format>", "output format: pretty, json, or text", (value) => {
    if (!["pretty", "json", "text"].includes(value)) {
      throw new InvalidArgumentError("Format must be one of: pretty, json, text.");
    }

    return value as OutputFormat;
  })
  .option("--json", "print compact JSON; equivalent to --format json")
  .option("--output <file>", "write output to a file instead of stdout")
  .option("--retries <count>", "retry transient network/API failures", retriesOption, DEFAULT_RETRIES)
  .option("--timeout <ms>", "request timeout in milliseconds", timeoutOption, DEFAULT_TIMEOUT_MS);

program
  .command("video")
  .argument("<video_id>", "YouTube video ID", (value) => validateNonEmpty(value, "Video ID"))
  .description("Fetch YouTube video details.")
  .action(async (videoId: string, _options: unknown, command: Command) => {
    const value = await request(command, {
      path: `/v1/youtube/video/${encodeURIComponent(videoId)}`,
    });
    await output(command, value);
  });

addFieldsOption(
  program
    .command("video-enhanced")
    .argument("<video_id>", "YouTube video ID", (value) => validateNonEmpty(value, "Video ID"))
    .description("Fetch enhanced YouTube video details."),
).action(async (videoId: string, options: { fields?: string }, command: Command) => {
  const value = await request(command, {
    path: `/v1/youtube/video/${encodeURIComponent(videoId)}/enhanced`,
    query: { fields: options.fields },
  });
  await output(command, value);
});

addTranscriptOptions(
  program
    .command("transcript")
    .argument("<video_id>", "YouTube video ID", (value) => validateNonEmpty(value, "Video ID"))
    .description("Fetch a YouTube video transcript."),
).action(async (videoId: string, options: { language?: string; kind?: string }, command: Command) => {
    const value = await request(command, {
      path: `/v1/youtube/video/${encodeURIComponent(videoId)}/transcript/fast`,
      query: {
        language: options.language,
        kind: options.kind,
      },
    });
    await output(command, value, { defaultFormat: "text", transcriptText: true });
  },
);

addTranscriptOptions(
  program
    .command("transcript-full")
    .argument("<video_id>", "YouTube video ID", (value) => validateNonEmpty(value, "Video ID"))
    .description("Fetch a full YouTube video transcript."),
).action(async (videoId: string, options: { language?: string; kind?: string }, command: Command) => {
  const value = await request(command, {
    path: `/v1/youtube/video/${encodeURIComponent(videoId)}/transcript`,
    query: {
      language: options.language,
      kind: options.kind,
    },
  });
  await output(command, value, { defaultFormat: "text", transcriptText: true });
});

addContinuationOptions(
  program
    .command("related")
    .argument("<video_id>", "YouTube video ID", (value) => validateNonEmpty(value, "Video ID"))
    .description("Fetch related videos for a YouTube video."),
).action(async (videoId: string, options: { continuationToken?: string }, command: Command) => {
  const value = await request(command, {
    path: `/v1/youtube/video/${encodeURIComponent(videoId)}/related`,
    query: { continuation_token: options.continuationToken },
  });
  await output(command, value);
});

addRequiredContinuationOption(
  program
    .command("related-page")
    .argument("<video_id>", "YouTube video ID", (value) => validateNonEmpty(value, "Video ID"))
    .description("Fetch a related videos continuation page."),
).action(async (videoId: string, options: { continuationToken: string }, command: Command) => {
  const value = await request(command, {
    method: "POST",
    path: `/v1/youtube/video/${encodeURIComponent(videoId)}/related/page`,
    body: { continuation_token: options.continuationToken },
  });
  await output(command, value);
});

addCommentSortOption(addCountOption(
  program
    .command("comments")
    .argument("<video_id>", "YouTube video ID", (value) => validateNonEmpty(value, "Video ID"))
    .description("Fetch the first comments page for a video."),
)).action(async (videoId: string, options: { count?: number; sort?: string }, command: Command) => {
  const value = await request(command, {
    path: `/v1/youtube/video/${encodeURIComponent(videoId)}/comments`,
    query: { count: options.count, sort: options.sort },
  });
  await output(command, value);
});

addCountOption(
  program
    .command("comments-page")
    .argument("<video_id>", "YouTube video ID", (value) => validateNonEmpty(value, "Video ID"))
    .requiredOption("--continuation-token <token>", "pagination continuation token", (value) =>
      validateNonEmpty(value, "Continuation token"),
    )
    .description("Fetch a subsequent comments page."),
).action(
  async (videoId: string, options: { continuationToken: string; count?: number }, command: Command) => {
    const value = await request(command, {
      method: "POST",
      path: `/v1/youtube/video/${encodeURIComponent(videoId)}/comments/page`,
      body: {
        continuation_token: options.continuationToken,
        count: options.count,
      },
    });
    await output(command, value);
  },
);

addCommentSortOption(addCountOption(
  program
    .command("replies")
    .argument("<video_id>", "YouTube video ID", (value) => validateNonEmpty(value, "Video ID"))
    .argument("<comment_id>", "top-level YouTube comment ID", (value) =>
      validateNonEmpty(value, "Comment ID"),
    )
    .description("Fetch the first replies page for a top-level comment."),
)).action(async (videoId: string, commentId: string, options: { count?: number; sort?: string }, command: Command) => {
  const value = await request(command, {
    path: `/v1/youtube/video/${encodeURIComponent(videoId)}/comments/${encodeURIComponent(commentId)}/replies`,
    query: { count: options.count, sort: options.sort },
  });
  await output(command, value);
});

addCountOption(
  program
    .command("replies-page")
    .argument("<video_id>", "YouTube video ID", (value) => validateNonEmpty(value, "Video ID"))
    .argument("<comment_id>", "top-level YouTube comment ID", (value) =>
      validateNonEmpty(value, "Comment ID"),
    )
    .requiredOption("--continuation-token <token>", "pagination continuation token", (value) =>
      validateNonEmpty(value, "Continuation token"),
    )
    .description("Fetch a subsequent replies page for a top-level comment."),
).action(
  async (
    videoId: string,
    commentId: string,
    options: { continuationToken: string; count?: number },
    command: Command,
  ) => {
    const value = await request(command, {
      method: "POST",
      path: `/v1/youtube/video/${encodeURIComponent(videoId)}/comments/${encodeURIComponent(commentId)}/replies/page`,
      body: {
        continuation_token: options.continuationToken,
        count: options.count,
      },
    });
    await output(command, value);
  },
);

program
  .command("channel")
  .argument("<channel_id>", "UC channel ID, @handle, or username", (value) =>
    validateNonEmpty(value, "Channel ID"),
  )
  .description("Fetch YouTube channel details.")
  .action(async (channelId: string, _options: unknown, command: Command) => {
    const value = await request(command, {
      path: `/v1/youtube/channel/${encodeURIComponent(channelId)}`,
    });
  await output(command, value);
});

program
  .command("channel-about")
  .argument("<channel_id>", "UC channel ID, @handle, or username", (value) =>
    validateNonEmpty(value, "Channel ID"),
  )
  .description("Fetch a channel about section.")
  .action(async (channelId: string, _options: unknown, command: Command) => {
    const value = await request(command, {
      path: `/v1/youtube/channel/${encodeURIComponent(channelId)}/about`,
    });
    await output(command, value);
  });

addContinuationOptions(
  program
    .command("channel-videos")
    .argument("<channel_id>", "UC channel ID, @handle, or username", (value) =>
      validateNonEmpty(value, "Channel ID"),
    )
    .description("Fetch latest videos for a channel."),
).action(async (channelId: string, options: { continuationToken?: string }, command: Command) => {
  const value = await request(command, {
    path: `/v1/youtube/channel/${encodeURIComponent(channelId)}/videos`,
    query: { continuation_token: options.continuationToken },
  });
  await output(command, value);
});

addRequiredContinuationOption(
  program
    .command("channel-videos-page")
    .argument("<channel_id>", "UC channel ID, @handle, or username", (value) =>
      validateNonEmpty(value, "Channel ID"),
    )
    .description("Fetch a subsequent videos page for a channel."),
).action(async (channelId: string, options: { continuationToken: string }, command: Command) => {
  const value = await request(command, {
    method: "POST",
    path: `/v1/youtube/channel/${encodeURIComponent(channelId)}/videos/page`,
    body: { continuation_token: options.continuationToken },
  });
  await output(command, value);
});

program
  .command("channel-streams")
  .argument("<channel_id>", "UC channel ID, @handle, or username", (value) =>
    validateNonEmpty(value, "Channel ID"),
  )
  .description("Fetch live streams for a channel.")
  .action(async (channelId: string, _options: unknown, command: Command) => {
    const value = await request(command, {
      path: `/v1/youtube/channel/${encodeURIComponent(channelId)}/streams`,
    });
    await output(command, value);
  });

addRequiredContinuationOption(
  program
    .command("channel-streams-page")
    .argument("<channel_id>", "UC channel ID, @handle, or username", (value) =>
      validateNonEmpty(value, "Channel ID"),
    )
    .description("Fetch a subsequent streams page for a channel."),
).action(async (channelId: string, options: { continuationToken: string }, command: Command) => {
  const value = await request(command, {
    method: "POST",
    path: `/v1/youtube/channel/${encodeURIComponent(channelId)}/streams/page`,
    body: { continuation_token: options.continuationToken },
  });
  await output(command, value);
});

addContinuationOptions(
  program
    .command("channel-shorts")
    .argument("<channel_id>", "UC channel ID, @handle, or username", (value) =>
      validateNonEmpty(value, "Channel ID"),
    )
    .description("Fetch latest Shorts for a channel."),
).action(async (channelId: string, options: { continuationToken?: string }, command: Command) => {
  const value = await request(command, {
    path: `/v1/youtube/channel/${encodeURIComponent(channelId)}/shorts`,
    query: { continuation_token: options.continuationToken },
  });
  await output(command, value);
});

addRequiredContinuationOption(
  program
    .command("channel-shorts-page")
    .argument("<channel_id>", "UC channel ID, @handle, or username", (value) =>
      validateNonEmpty(value, "Channel ID"),
    )
    .description("Fetch a subsequent Shorts page for a channel."),
).action(async (channelId: string, options: { continuationToken: string }, command: Command) => {
  const value = await request(command, {
    method: "POST",
    path: `/v1/youtube/channel/${encodeURIComponent(channelId)}/shorts/page`,
    body: { continuation_token: options.continuationToken },
  });
  await output(command, value);
});

addContinuationOptions(
  program
    .command("channel-playlists")
    .argument("<channel_id>", "UC channel ID, @handle, or username", (value) =>
      validateNonEmpty(value, "Channel ID"),
    )
    .description("Fetch published playlists for a channel."),
).action(async (channelId: string, options: { continuationToken?: string }, command: Command) => {
  const value = await request(command, {
    path: `/v1/youtube/channel/${encodeURIComponent(channelId)}/playlists`,
    query: { continuation_token: options.continuationToken },
  });
  await output(command, value);
});

addRequiredContinuationOption(
  program
    .command("channel-playlists-page")
    .argument("<channel_id>", "UC channel ID, @handle, or username", (value) =>
      validateNonEmpty(value, "Channel ID"),
    )
    .description("Fetch a subsequent playlists page for a channel."),
).action(async (channelId: string, options: { continuationToken: string }, command: Command) => {
  const value = await request(command, {
    method: "POST",
    path: `/v1/youtube/channel/${encodeURIComponent(channelId)}/playlists/page`,
    body: { continuation_token: options.continuationToken },
  });
  await output(command, value);
});

addContinuationOptions(
  program
    .command("channel-community")
    .argument("<channel_id>", "UC channel ID, @handle, or username", (value) =>
      validateNonEmpty(value, "Channel ID"),
    )
    .description("Fetch community posts for a channel."),
).action(async (channelId: string, options: { continuationToken?: string }, command: Command) => {
  const value = await request(command, {
    path: `/v1/youtube/channel/${encodeURIComponent(channelId)}/community`,
    query: { continuation_token: options.continuationToken },
  });
  await output(command, value);
});

addRequiredContinuationOption(
  program
    .command("channel-community-page")
    .argument("<channel_id>", "UC channel ID, @handle, or username", (value) =>
      validateNonEmpty(value, "Channel ID"),
    )
    .description("Fetch a subsequent community page for a channel."),
).action(async (channelId: string, options: { continuationToken: string }, command: Command) => {
  const value = await request(command, {
    method: "POST",
    path: `/v1/youtube/channel/${encodeURIComponent(channelId)}/community/page`,
    body: { continuation_token: options.continuationToken },
  });
  await output(command, value);
});

addSearchFilterOptions(
  addContinuationOptions(
    program
      .command("search")
      .argument("<query>", "search query", (value) => validateNonEmpty(value, "Search query"))
      .description("Search YouTube."),
  ),
).action(
  async (
    query: string,
    options: {
      continuationToken?: string;
      channelId?: string;
      uploadDate?: string;
      duration?: string;
      sort?: string;
      type?: string;
      features?: string;
      live?: boolean;
      shorts?: boolean;
    },
    command: Command,
  ) => {
    const value = await request(command, {
      path: "/v1/youtube/search/",
      query: {
        query,
        continuation_token: options.continuationToken,
        channel_id: options.channelId,
        upload_date: options.uploadDate,
        duration: options.duration,
        sort: options.sort,
        type: options.type,
        features: options.features,
        live: options.live,
        shorts: options.shorts,
      },
    });
    await output(command, value);
  },
);

addSearchFilterOptions(
  addRequiredContinuationOption(
    program
      .command("search-page")
      .argument("<query>", "search query", (value) => validateNonEmpty(value, "Search query"))
      .description("Fetch a subsequent YouTube search page."),
  ),
).action(
  async (
    query: string,
    options: {
      continuationToken: string;
      channelId?: string;
      uploadDate?: string;
      duration?: string;
      sort?: string;
      type?: string;
      features?: string;
      live?: boolean;
      shorts?: boolean;
    },
    command: Command,
  ) => {
    const value = await request(command, {
      method: "POST",
      path: "/v1/youtube/search/page",
      body: {
        query,
        continuation_token: options.continuationToken,
        channel_id: options.channelId,
        upload_date: options.uploadDate,
        duration: options.duration,
        sort: options.sort,
        type: options.type,
        features: options.features,
        live: options.live,
        shorts: options.shorts,
      },
    });
    await output(command, value);
  },
);

addContinuationOptions(
  program
    .command("hashtag")
    .argument("<hashtag>", "YouTube hashtag, with or without #", (value) =>
      validateNonEmpty(value, "Hashtag"),
    )
    .description("Search YouTube by hashtag."),
).action(async (hashtag: string, options: { continuationToken?: string }, command: Command) => {
  const value = await request(command, {
    path: "/v1/youtube/search/hashtag",
    query: {
      hashtag,
      continuation_token: options.continuationToken,
    },
  });
  await output(command, value);
});

addRequiredContinuationOption(
  program
    .command("hashtag-page")
    .argument("<hashtag>", "YouTube hashtag, with or without #", (value) =>
      validateNonEmpty(value, "Hashtag"),
    )
    .description("Fetch a subsequent hashtag search page."),
).action(async (hashtag: string, options: { continuationToken: string }, command: Command) => {
  const value = await request(command, {
    method: "POST",
    path: "/v1/youtube/search/hashtag/page",
    body: {
      hashtag,
      continuation_token: options.continuationToken,
    },
  });
  await output(command, value);
});

program
  .command("suggestions")
  .argument("<query>", "partial search query", (value) => validateNonEmpty(value, "Search query"))
  .description("Fetch YouTube search suggestions.")
  .option("--prev <query>", "previous query context", (value) => validateNonEmpty(value, "Previous query"))
  .action(async (query: string, options: { prev?: string }, command: Command) => {
    const value = await request(command, {
      path: "/v1/youtube/search/suggestions",
      query: { q: query, prev: options.prev },
    });
  await output(command, value);
});

program
  .command("resolve")
  .argument("<url>", "YouTube URL", (value) => validateNonEmpty(value, "YouTube URL"))
  .description("Resolve a YouTube URL into canonical identifiers.")
  .action(async (url: string, _options: unknown, command: Command) => {
    const value = await request(command, {
      path: "/v1/youtube/utility/resolve",
      query: { url },
    });
    await output(command, value);
  });

addContinuationOptions(
  program
    .command("playlist")
    .argument("<playlist_id>", "YouTube playlist ID", (value) => validateNonEmpty(value, "Playlist ID"))
    .description("Fetch playlist contents."),
).action(async (playlistId: string, options: { continuationToken?: string }, command: Command) => {
  const value = await request(command, {
    path: `/v1/youtube/playlist/${encodeURIComponent(playlistId)}`,
    query: { continuation_token: options.continuationToken },
  });
  await output(command, value);
});

program
  .command("playlist-metadata")
  .argument("<playlist_id>", "YouTube playlist ID", (value) => validateNonEmpty(value, "Playlist ID"))
  .description("Fetch playlist metadata.")
  .action(async (playlistId: string, _options: unknown, command: Command) => {
    const value = await request(command, {
      path: `/v1/youtube/playlist/${encodeURIComponent(playlistId)}/metadata`,
    });
    await output(command, value);
  });

addRequiredContinuationOption(
  program
    .command("playlist-page")
    .argument("<playlist_id>", "YouTube playlist ID", (value) => validateNonEmpty(value, "Playlist ID"))
    .description("Fetch a subsequent playlist page."),
).action(async (playlistId: string, options: { continuationToken: string }, command: Command) => {
  const value = await request(command, {
    method: "POST",
    path: `/v1/youtube/playlist/${encodeURIComponent(playlistId)}/page`,
    body: { continuation_token: options.continuationToken },
  });
  await output(command, value);
});

addFieldsOption(
  program
    .command("videos-batch")
    .argument("<ids...>", "YouTube video IDs")
    .description("Fetch details for multiple videos."),
).action(async (ids: string[], options: { fields?: string }, command: Command) => {
  const value = await request(command, {
    method: "POST",
    path: "/v1/youtube/videos:batch",
    query: { fields: options.fields },
    body: { ids: validateIds(ids, "Video ID") },
  });
  await output(command, value);
});

addFieldsOption(
  program
    .command("channels-batch")
    .argument("<ids...>", "YouTube channel IDs, handles, or usernames")
    .description("Fetch details for multiple channels."),
).action(async (ids: string[], options: { fields?: string }, command: Command) => {
  const value = await request(command, {
    method: "POST",
    path: "/v1/youtube/channels:batch",
    query: { fields: options.fields },
    body: { ids: validateIds(ids, "Channel ID") },
  });
  await output(command, value);
});

program
  .command("trending")
  .description("Fetch trending YouTube videos.")
  .action(async (_options: unknown, command: Command) => {
    const value = await request(command, {
      path: "/v1/youtube/trending",
    });
    await output(command, value);
  });

program
  .command("trending-shorts")
  .description("Fetch trending YouTube Shorts.")
  .action(async (_options: unknown, command: Command) => {
    const value = await request(command, {
      path: "/v1/youtube/trending/shorts",
    });
    await output(command, value);
  });

program
  .command("billing-usage")
  .description("Fetch credit balance and billing usage.")
  .action(async (_options: unknown, command: Command) => {
    const value = await request(command, {
      path: "/v1/billing/usage",
    });
    await output(command, value);
  });

program.parseAsync().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
