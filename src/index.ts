import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

import { Command, InvalidArgumentError } from "commander";
import { OPERATIONS, type OperationId } from "./generated/operations.js";

const PRODUCT_NAME = "TubeAlfred CLI";
const DEFAULT_API_URL = "https://api.tubealfred.com";
const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_RETRIES = 1;

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

function oneOf(label: string, allowed: readonly string[]): (value: string) => string {
  return (value: string): string => {
    if (!allowed.includes(value)) {
      throw new InvalidArgumentError(`${label} must be one of: ${allowed.join(", ")}.`);
    }

    return value;
  };
}

function validateIds(values: string[], label: string): string[] {
  return values.map((value) => validateNonEmpty(value, label));
}

interface ManifestParameter {
  name: string;
  in: "path" | "query" | "body";
  required: boolean;
  description: string | null;
  schema: {
    type?: string;
    enum?: readonly string[];
    minimum?: number;
    maximum?: number;
  };
}

interface ManifestOperation {
  id: OperationId;
  command: string;
  method: HttpMethod;
  path: string;
  description: string;
  parameters: readonly ManifestParameter[];
}

const manifestOperations = OPERATIONS as readonly ManifestOperation[];
const argumentParameterNames = new Set(["query", "hashtag", "q", "url", "ids"]);

function isArgumentParameter(parameter: ManifestParameter): boolean {
  return parameter.in === "path" || (parameter.required && argumentParameterNames.has(parameter.name));
}

function optionName(name: string): string {
  return name.replaceAll("_", "-");
}

function optionProperty(name: string): string {
  return name.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function parameterLabel(parameter: ManifestParameter): string {
  const label = parameter.name.replaceAll("_", " ");

  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function parameterParser(parameter: ManifestParameter): ((value: string) => unknown) | undefined {
  const label = parameterLabel(parameter);

  if (parameter.schema.type === "integer") {
    return (value) => positiveInteger(value, label, parameter.schema.maximum);
  }

  if (parameter.schema.enum) {
    return oneOf(label, parameter.schema.enum);
  }

  if (parameter.schema.type === "string") {
    return (value) => validateNonEmpty(value, label);
  }

  return undefined;
}

function operationRequest(
  operation: ManifestOperation,
  values: Record<string, unknown>,
): RequestOptions {
  let path = operation.path;
  const query: Record<string, QueryValue> = {};
  const body: Record<string, unknown> = {};

  for (const parameter of operation.parameters) {
    const value = values[parameter.name];

    if (parameter.in === "path") {
      path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
    } else if (parameter.in === "query") {
      query[parameter.name] = value as QueryValue;
    } else if (value !== undefined) {
      body[parameter.name] = value;
    }
  }

  return {
    method: operation.method,
    path,
    query,
    body: Object.keys(body).length === 0 ? undefined : body,
  };
}

function addManifestCommand(program: Command, operation: ManifestOperation): void {
  const command = program.command(operation.command).description(operation.description);
  const argumentsInOrder = operation.parameters.filter(isArgumentParameter);

  for (const parameter of argumentsInOrder) {
    const variadic = parameter.schema.type === "array";
    const syntax = `<${parameter.name}${variadic ? "..." : ""}>`;
    const description = parameter.description ?? parameterLabel(parameter);
    const parser = variadic ? undefined : parameterParser(parameter);

    if (parser) {
      command.argument(syntax, description, parser);
    } else {
      command.argument(syntax, description);
    }
  }

  for (const parameter of operation.parameters.filter((candidate) => !isArgumentParameter(candidate))) {
    const description = parameter.description ?? parameterLabel(parameter);
    const flag = parameter.schema.type === "boolean"
      ? `--${optionName(parameter.name)}`
      : `--${optionName(parameter.name)} <value>`;
    const parser = parameterParser(parameter);

    if (parameter.required) {
      if (parser) {
        command.requiredOption(flag, description, parser);
      } else {
        command.requiredOption(flag, description);
      }
    } else if (parser) {
      command.option(flag, description, parser);
    } else {
      command.option(flag, description);
    }
  }

  command.action(async (...actionArguments: unknown[]) => {
    const invokedCommand = actionArguments.at(-1) as Command;
    const options = actionArguments.at(-2) as Record<string, unknown>;
    const positional = actionArguments.slice(0, -2);
    const values: Record<string, unknown> = {};

    argumentsInOrder.forEach((parameter, index) => {
      const value = positional[index];
      values[parameter.name] = parameter.schema.type === "array"
        ? validateIds(value as string[], parameterLabel(parameter))
        : value;
    });

    for (const parameter of operation.parameters.filter((candidate) => !isArgumentParameter(candidate))) {
      values[parameter.name] = options[optionProperty(parameter.name)];
    }

    const value = await request(invokedCommand, operationRequest(operation, values));
    const isTranscript = operation.id === "video_transcript" || operation.id === "video_transcript_fast";
    await output(invokedCommand, value, isTranscript
      ? { defaultFormat: "text", transcriptText: true }
      : {});
  });
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

for (const operation of manifestOperations) {
  addManifestCommand(program, operation);
}

program
  .command("billing-usage")
  .description("Fetch credit balance and billing usage.")
  .action(async (_options: unknown, command: Command) => {
    const value = await request(command, { path: "/v1/billing/usage" });
    await output(command, value);
  });

program.parseAsync().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
