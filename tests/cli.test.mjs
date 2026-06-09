import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const apiKey = "ta_test_123456789";
const cliPath = new URL("../dist/index.js", import.meta.url).pathname;

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        TUBEALFRED_API_KEY: apiKey,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolve({ code, stderr, stdout });
    });
  });
}

function startServer(handler) {
  const server = createServer(handler);

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        throw new Error("Unable to bind test server.");
      }

      resolve({
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }

              closeResolve();
            });
          }),
        url: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

test("prints command help", async () => {
  const result = await runCli(["--help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: tubealfred/);
  assert.match(result.stdout, /video <video_id>/);
  assert.match(result.stdout, /channel-shorts \[options\] <channel_id>/);
  assert.match(result.stdout, /hashtag \[options\] <hashtag>/);
  assert.match(result.stdout, /resolve <url>/);
  assert.match(result.stdout, /billing-usage/);
});

test("uses /v1 API paths without duplicating /api", async () => {
  const seenPaths = [];
  const server = await startServer((request, response) => {
    seenPaths.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: { id: "abc123", title: "Demo" } }));
  });

  try {
    const result = await runCli(["--api-url", server.url, "video", "abc123"]);

    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { data: { id: "abc123", title: "Demo" } });
    assert.deepEqual(seenPaths, ["/v1/youtube/video/abc123"]);
  } finally {
    await server.close();
  }
});

test("supports new channel, hashtag, replies, and resolve API paths", async () => {
  const seenPaths = [];
  const server = await startServer((request, response) => {
    seenPaths.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: { ok: true } }));
  });

  try {
    const commands = [
      ["--api-url", server.url, "channel-about", "@mkbhd"],
      ["--api-url", server.url, "channel-shorts", "@mkbhd", "--continuation-token", "NEXT"],
      ["--api-url", server.url, "channel-playlists", "@mkbhd"],
      ["--api-url", server.url, "channel-community", "@mkbhd"],
      ["--api-url", server.url, "hashtag", "#laravel", "--continuation-token", "NEXT"],
      ["--api-url", server.url, "replies", "video123", "comment123", "--count", "25"],
      ["--api-url", server.url, "resolve", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ];

    for (const args of commands) {
      const result = await runCli(args);
      assert.equal(result.code, 0, result.stderr);
    }

    assert.deepEqual(seenPaths, [
      "/v1/youtube/channel/%40mkbhd/about",
      "/v1/youtube/channel/%40mkbhd/shorts?continuation_token=NEXT",
      "/v1/youtube/channel/%40mkbhd/playlists",
      "/v1/youtube/channel/%40mkbhd/community",
      "/v1/youtube/search/hashtag?hashtag=%23laravel&continuation_token=NEXT",
      "/v1/youtube/video/video123/comments/comment123/replies?count=25",
      "/v1/youtube/utility/resolve?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ",
    ]);
  } finally {
    await server.close();
  }
});

test("supports newly documented page, related, batch, utility, and trending paths", async () => {
  const seen = [];
  const server = await startServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      seen.push({ body: body ? JSON.parse(body) : null, method: request.method, url: request.url ?? "" });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: { ok: true } }));
    });
  });

  try {
    const commands = [
      ["--api-url", server.url, "video-enhanced", "abc123", "--fields", "id,title"],
      ["--api-url", server.url, "--format", "json", "transcript-full", "abc123", "--language", "en", "--kind", "manual"],
      ["--api-url", server.url, "related", "abc123", "--continuation-token", "NEXT"],
      ["--api-url", server.url, "related-page", "abc123", "--continuation-token", "NEXT"],
      ["--api-url", server.url, "channel-videos-page", "@mkbhd", "--continuation-token", "NEXT"],
      ["--api-url", server.url, "channel-streams", "@mkbhd"],
      ["--api-url", server.url, "channel-streams-page", "@mkbhd", "--continuation-token", "NEXT"],
      ["--api-url", server.url, "channel-shorts-page", "@mkbhd", "--continuation-token", "NEXT"],
      ["--api-url", server.url, "channel-playlists-page", "@mkbhd", "--continuation-token", "NEXT"],
      ["--api-url", server.url, "channel-community-page", "@mkbhd", "--continuation-token", "NEXT"],
      ["--api-url", server.url, "search-page", "laravel", "--continuation-token", "NEXT", "--channel-id", "@tubealfred"],
      ["--api-url", server.url, "hashtag-page", "#laravel", "--continuation-token", "NEXT"],
      ["--api-url", server.url, "playlist-metadata", "PL123"],
      ["--api-url", server.url, "playlist-page", "PL123", "--continuation-token", "NEXT"],
      ["--api-url", server.url, "videos-batch", "dQw4w9WgXcQ", "--fields", "id,title"],
      ["--api-url", server.url, "channels-batch", "@mkbhd"],
      ["--api-url", server.url, "trending"],
      ["--api-url", server.url, "trending-shorts"],
    ];

    for (const args of commands) {
      const result = await runCli(args);
      assert.equal(result.code, 0, result.stderr);
    }

    assert.deepEqual(
      seen.map((entry) => `${entry.method} ${entry.url}`),
      [
        "GET /v1/youtube/video/abc123/enhanced?fields=id%2Ctitle",
        "GET /v1/youtube/video/abc123/transcript?language=en&kind=manual",
        "GET /v1/youtube/video/abc123/related?continuation_token=NEXT",
        "POST /v1/youtube/video/abc123/related/page",
        "POST /v1/youtube/channel/%40mkbhd/videos/page",
        "GET /v1/youtube/channel/%40mkbhd/streams",
        "POST /v1/youtube/channel/%40mkbhd/streams/page",
        "POST /v1/youtube/channel/%40mkbhd/shorts/page",
        "POST /v1/youtube/channel/%40mkbhd/playlists/page",
        "POST /v1/youtube/channel/%40mkbhd/community/page",
        "POST /v1/youtube/search/page",
        "POST /v1/youtube/search/hashtag/page",
        "GET /v1/youtube/playlist/PL123/metadata",
        "POST /v1/youtube/playlist/PL123/page",
        "POST /v1/youtube/videos:batch?fields=id%2Ctitle",
        "POST /v1/youtube/channels:batch",
        "GET /v1/youtube/trending",
        "GET /v1/youtube/trending/shorts",
      ],
    );
    assert.deepEqual(seen[3].body, { continuation_token: "NEXT" });
    assert.deepEqual(seen[10].body, { query: "laravel", continuation_token: "NEXT", channel_id: "@tubealfred" });
    assert.deepEqual(seen[14].body, { ids: ["dQw4w9WgXcQ"] });
  } finally {
    await server.close();
  }
});

test("supports billing usage API path", async () => {
  const seenPaths = [];
  const server = await startServer((request, response) => {
    seenPaths.push(`${request.method} ${request.url ?? ""}`);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: { balance: 430 } }));
  });

  try {
    const result = await runCli(["--api-url", server.url, "billing-usage"]);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { data: { balance: 430 } });
    assert.deepEqual(seenPaths, ["GET /v1/billing/usage"]);
  } finally {
    await server.close();
  }
});

test("forwards search filters and boolean flags", async () => {
  let seenUrl = "";
  const server = await startServer((request, response) => {
    seenUrl = request.url ?? "";
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: { ok: true } }));
  });

  try {
    const result = await runCli([
      "--api-url",
      server.url,
      "search",
      "laravel tutorial",
      "--upload-date",
      "month",
      "--duration",
      "three_to_twenty_mins",
      "--sort",
      "popularity",
      "--type",
      "video",
      "--features",
      "hd,subtitles",
      "--live",
    ]);

    assert.equal(result.code, 0, result.stderr);

    const parsed = new URL(seenUrl, "http://localhost");
    assert.equal(parsed.pathname, "/v1/youtube/search/");
    assert.equal(parsed.searchParams.get("query"), "laravel tutorial");
    assert.equal(parsed.searchParams.get("upload_date"), "month");
    assert.equal(parsed.searchParams.get("duration"), "three_to_twenty_mins");
    assert.equal(parsed.searchParams.get("sort"), "popularity");
    assert.equal(parsed.searchParams.get("type"), "video");
    assert.equal(parsed.searchParams.get("features"), "hd,subtitles");
    assert.equal(parsed.searchParams.get("live"), "true");
    assert.equal(parsed.searchParams.get("shorts"), null);
  } finally {
    await server.close();
  }
});

test("rejects invalid search filter values", async () => {
  const result = await runCli(["search", "laravel", "--upload-date", "decade"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Upload date must be one of/);
});

test("validates count input", async () => {
  const result = await runCli(["comments", "abc123", "--count", "abc"]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Count must be a positive integer/);
});

test("returns clean HTTP errors", async () => {
  const server = await startServer((_request, response) => {
    response.statusCode = 404;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const result = await runCli(["--api-url", server.url, "video", "abc123"]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Request failed with HTTP 404/);
    assert.match(result.stderr, /not found/);
  } finally {
    await server.close();
  }
});

test("times out slow API requests", async () => {
  const server = await startServer((_request, response) => {
    setTimeout(() => {
      response.end(JSON.stringify({ data: { ok: true } }));
    }, 2_000);
  });

  try {
    const result = await runCli([
      "--api-url",
      server.url,
      "--timeout",
      "1000",
      "--retries",
      "1",
      "video",
      "abc123",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Request timed out after 1000ms/);
  } finally {
    await server.close();
  }
});

test("writes transcript text output to a file", async () => {
  const server = await startServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        data: {
          transcript: [
            { text: "First line" },
            { text: "Second line" },
          ],
        },
      }),
    );
  });
  const tempDir = await mkdtemp(join(tmpdir(), "tubealfred-cli-"));
  const outputFile = join(tempDir, "transcript.txt");

  try {
    const result = await runCli([
      "--api-url",
      server.url,
      "--output",
      outputFile,
      "transcript",
      "abc123",
    ]);

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(await readFile(outputFile, "utf8"), "First line\nSecond line\n");
  } finally {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
