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
