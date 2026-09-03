#!/usr/bin/env node

import path from "path";
import chalk from "chalk";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime.js";
import { Command, InvalidArgumentError } from "commander";
import { asAppError, AppError } from "./errors.js";
import {
  downloadVersions,
  DownloadFileEvent,
  DownloadResult,
  isPackageName,
  OperationWarning,
  showVersions,
  VersionsResult,
} from "./versions.js";
import { getConfigFilePath, getOutputDir, setOutputDir } from "./config.js";

dayjs.extend(relativeTime);

interface ShowCommandOptions {
  abi?: string[];
}

interface PullCommandOptions {
  limit?: number;
  offset?: number;
  all?: boolean;
  threads?: number;
  unattended?: boolean;
  output?: string;
  downloadTimeout?: number;
  abi?: string[];
}

const SPINNER_FRAMES = ["|", "/", "-", "\\"];

class Spinner {
  private timer: NodeJS.Timeout | null = null;

  private frame = 0;

  private message = "";

  private lastLineLength = 0;

  private render(): void {
    const frame = SPINNER_FRAMES[this.frame];
    const line = this.message ? `${frame} ${this.message}` : frame;
    const paddingLength = Math.max(this.lastLineLength - line.length, 0);

    process.stdout.write(`\r${line}${" ".repeat(paddingLength)}`);
    this.lastLineLength = line.length;
  }

  start(message?: string): void {
    if (typeof message === "string") {
      this.message = message;
    }

    if (this.timer) {
      this.render();
      return;
    }

    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, 120);
  }

  setMessage(message: string): void {
    this.message = message;

    if (this.timer) {
      this.render();
    }
  }

  log(line: string): void {
    const clearWidth = Math.max(this.lastLineLength, process.stdout.columns || 80);
    process.stdout.write("\r" + " ".repeat(clearWidth) + "\r");
    process.stdout.write(`${line}\n`);
    this.lastLineLength = 0;

    if (this.timer) {
      this.render();
    }
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
    process.stdout.write("\r" + " ".repeat(Math.max(this.lastLineLength, process.stdout.columns || 80)) + "\r");
    this.lastLineLength = 0;
  }
}

const MAX_COLUMN_WIDTH = 42;
const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

type TableCell = string | number | boolean | null | undefined;
type TableRow = Record<string, TableCell>;

function visibleLength(value: string): number {
  return value.replace(ANSI_PATTERN, "").length;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  if (width <= 3) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 3)}...`;
}

function cellToString(value: TableCell): string {
  if (value === null || value === undefined) {
    return "-";
  }

  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }

  return String(value);
}

function renderTable(columns: string[], rows: TableRow[]): string {
  if (rows.length === 0) {
    return "";
  }

  const widths = columns.map((column) => {
    const valueWidth = rows.reduce((max, row) => {
      const current = visibleLength(cellToString(row[column]));
      return Math.max(max, current);
    }, column.length);

    return Math.min(valueWidth, MAX_COLUMN_WIDTH);
  });

  const renderRow = (row: TableRow): string =>
    columns
      .map((column, index) => {
        const raw = cellToString(row[column]);
        const visibleRaw = raw.replace(ANSI_PATTERN, "");
        if (visibleRaw.length > widths[index]) {
          return truncate(visibleRaw, widths[index]).padEnd(widths[index], " ");
        }

        return `${raw}${" ".repeat(Math.max(widths[index] - visibleRaw.length, 0))}`;
      })
      .join("  ");

  const header = columns.map((column, index) => column.padEnd(widths[index], " ")).join("  ");
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  const body = rows.map((row) => renderRow(row));

  return [header, separator, ...body].join("\n");
}

function toMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function writeStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function capitalize(text: string): string {
  if (!text) {
    return text;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function renderWarnings(operation: string, warnings: OperationWarning[]): void {
  warnings.forEach((warning) => {
    writeStdout(chalk.yellow(`Warning ${capitalize(operation)}: ${warning.message}`));
  });
}

function renderError(operation: string, error: AppError): void {
  writeStderr(chalk.bold.red(`Error ${capitalize(operation)} [${error.code}]: ${error.message}`));
}

function renderShowResult(result: VersionsResult): void {
  const header = chalk.bold.green(`Success ${capitalize("show")}: ${result.message}`);
  if (result.rows.length === 0) {
    writeStdout(header);
    return;
  }

  const rows: TableRow[] = result.rows.map((item) => {
    const date = dayjs(item.timestamp);
    const updated = date.isValid()
      ? `${date.format("MMM D, YYYY")} (${date.fromNow()})`
      : item.timestamp;

    return {
      Offset: chalk.cyan(String(item.offset)),
      Package: item.name,
      Version: chalk.magenta(item.versionTag),
      Code: item.versionCode || "-",
      ABI: item.abi || "-",
      Type: item.assetType || "-",
      Size: chalk.yellow(toMB(item.size)),
      Updated: chalk.dim(updated),
    };
  });

  const columns = ["Offset", "Package", "Version", "Code", "ABI", "Type", "Size", "Updated"];
  const table = renderTable(columns, rows);
  writeStdout(table ? `${header}\n${table}` : header);
}

function renderPullResult(result: DownloadResult): void {
  writeStdout(chalk.bold.green(`Success ${capitalize("download")}: ${result.message}`));
}

function formatPullFileEvent(event: DownloadFileEvent): string {
  const filePath = event.fullPath || event.relativePath || "-";
  const variant = event.abi ? ` [${event.abi}]` : "";
  const normalized = filePath.replace(/\\/g, "/");

  if (event.status === "downloaded") {
    return `✅ Downloaded file${variant}: ${chalk.magenta(event.versionTag)} -> ${chalk.dim(normalized)}`;
  }

  if (event.status === "skipped") {
    return `⏭️ File already exists${variant}: ${chalk.magenta(event.versionTag)} -> ${chalk.dim(normalized)}`;
  }

  return `❌ Failed file download${variant}: ${chalk.magenta(event.versionTag)} -> ${chalk.dim(normalized)}`;
}

function buildInitialLookupLabel(query: string): string {
  return isPackageName(query)
    ? `Querying version files for ${query.trim()}`
    : `Querying ${query.trim()}`;
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Value must be a positive integer.");
  }
  return parsed;
}

function parseThreads(value: string): number {
  const parsed = parsePositiveInt(value);
  if (parsed > 5) {
    throw new InvalidArgumentError("Value must be between 1 and 5.");
  }
  return parsed;
}

function parseNonNegativeInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new InvalidArgumentError("Value must be a non-negative integer.");
  }
  return parsed;
}

function parseAbiList(value: string): string[] {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (items.length === 0) {
    throw new InvalidArgumentError("ABI list must contain at least one value.");
  }

  return items;
}

function isStdinPiped(): boolean {
  const override = process.env.APKPURE_STDIN_MODE;
  if (override === "tty") {
    return false;
  }
  if (override === "pipe") {
    return true;
  }

  return process.stdin.isTTY !== true;
}

async function readStdinText(): Promise<string> {
  if (process.stdin.readableEnded) {
    return "";
  }

  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      chunks.push(chunk);
    });
    process.stdin.on("end", () => {
      resolve(chunks.join(""));
    });
    process.stdin.on("error", (error) => {
      reject(error);
    });
    process.stdin.resume();
  });
}

interface ResolvedInput {
  mode: "single" | "batch";
  query?: string;
  queries?: string[];
}

async function resolveInput(input: string): Promise<ResolvedInput> {
  const piped = isStdinPiped();
  const query = input.trim();

  if (query) {
    return { mode: "single", query };
  }

  if (!piped) {
    throw new AppError("E_INVALID_INPUT", "Package query is required.");
  }

  const stdinText = await readStdinText();
  const lines = stdinText
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new AppError("E_INVALID_INPUT", "No package queries received from stdin.");
  }

  return { mode: "batch", queries: lines };
}

function resolveOutputPath(downloadDirOverride?: string): string {
  if (downloadDirOverride && downloadDirOverride.trim().length > 0) {
    return path.resolve(downloadDirOverride.trim());
  }

  const savedOutputDir = getOutputDir();
  if (savedOutputDir) {
    return savedOutputDir;
  }

  throw new AppError(
    "E_INVALID_INPUT",
    "output path is not configured. Run `apkpure output <dir>` or use --output <path>."
  );
}

function resolvePullSelectorOptions(options: PullCommandOptions): {
  limit?: number;
  offset?: number;
  all: boolean;
} {
  if (options.all && typeof options.limit === "number") {
    throw new AppError("E_INVALID_INPUT", "Use either --limit <n> or --all, not both.");
  }

  return {
    limit: options.limit ?? 1,
    offset: options.offset,
    all: Boolean(options.all),
  };
}

interface OperationCallbacks {
  onInteractionStarted: () => void;
  onInteractionEnded: () => void;
  onProgressMessage: (message: string) => void;
  onLiveMessage: (message: string) => void;
}

async function runCommand<T extends { warnings: OperationWarning[] }>(
  operation: string,
  runner: (callbacks: OperationCallbacks) => Promise<T>,
  renderer: (result: T) => void,
  settings?: {
    spinnerMessage?: string;
    resolveExitCode?: (result: T) => number;
  }
): Promise<void> {
  const spinner = new Spinner();
  let exitCode = 0;

  try {
    spinner.start(settings?.spinnerMessage);
    const result = await runner({
      onInteractionStarted: () => spinner.stop(),
      onInteractionEnded: () => spinner.start(),
      onProgressMessage: (message) => spinner.setMessage(message),
      onLiveMessage: (message) => spinner.log(message),
    });
    spinner.stop();

    renderWarnings(operation, result.warnings);
    renderer(result);

    if (settings?.resolveExitCode) {
      exitCode = settings.resolveExitCode(result);
    }
  } catch (error) {
    spinner.stop();

    const appError = asAppError(error);
    renderError(operation, appError);

    exitCode = appError.exitCode;
  }

  process.exitCode = exitCode;
}

function writeBatchSummary(operation: string, summaryLines: string[]): void {
  writeStdout(`${chalk.bold.cyan(`Batch ${operation} summary:`)} ${summaryLines.join(" | ")}`);
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function runShowBatch(queries: string[], options: ShowCommandOptions, unattended: boolean): Promise<void> {
  let succeeded = 0;
  let failed = 0;
  let warnings = 0;
  let exitCode = 0;
  let processed = 0;

  for (const query of queries) {
    processed += 1;

    try {
      const result = await showVersions({
        query,
        unattended,
        abis: options.abi,
      });

      renderWarnings("show", result.warnings);
      renderShowResult(result);

      warnings += result.warnings.length;
      succeeded += 1;
    } catch (error) {
      const appError = asAppError(error);
      renderError(`show (${query})`, appError);
      failed += 1;
      exitCode = Math.max(exitCode, appError.exitCode);
    }
  }

  writeBatchSummary("show", [
    `processed=${processed}/${queries.length}`,
    `ok=${succeeded}`,
    `failed=${failed}`,
    `warnings=${warnings}`,
  ]);

  process.exitCode = failed > 0 ? Math.max(exitCode, 2) : 0;
}

async function runPullBatch(
  queries: string[],
  options: PullCommandOptions,
  unattended: boolean,
  outputPath: string
): Promise<void> {
  const selectorOptions = resolvePullSelectorOptions(options);
  const threads = Math.min(Math.max(options.threads || 1, 1), 5);
  let succeeded = 0;
  let failedItems = 0;
  let warnings = 0;
  let downloaded = 0;
  let skipped = 0;
  let failedFiles = 0;
  let bytes = 0;
  let exitCode = 0;
  let processed = 0;

  for (const query of queries) {
    processed += 1;

    try {
      const result = await downloadVersions({
        query,
        limit: selectorOptions.limit,
        offset: selectorOptions.offset,
        all: selectorOptions.all,
        threads,
        unattended,
        outputPath,
        abis: options.abi,
        downloadTimeoutMs: options.downloadTimeout,
      });

      renderWarnings("download", result.warnings);
      renderPullResult(result);

      warnings += result.warnings.length;
      downloaded += result.downloaded;
      skipped += result.skipped;
      failedFiles += result.failed;
      bytes += result.bytes;

      if (result.failed > 0) {
        failedItems += 1;
        exitCode = Math.max(exitCode, 4);
      } else {
        succeeded += 1;
      }
    } catch (error) {
      const appError = asAppError(error);
      renderError(`download (${query})`, appError);
      failedItems += 1;
      exitCode = Math.max(exitCode, appError.exitCode);
    }
  }

  writeBatchSummary("download", [
    `processed=${processed}/${queries.length}`,
    `ok=${succeeded}`,
    `failed-items=${failedItems}`,
    `downloaded=${downloaded}`,
    `skipped=${skipped}`,
    `failed-files=${failedFiles}`,
    `size=${formatMegabytes(bytes)}`,
    `warnings=${warnings}`,
  ]);

  process.exitCode = failedItems > 0 || failedFiles > 0 ? Math.max(exitCode, 4) : 0;
}

function buildProgram(): Command {
  const program = new Command();

  program
    .name("apkpure")
    .description("Download & inspect ApkPure packages.")
    .version("0.6.0", "--version", "Display version information.")
    .helpOption("--help", "Display help information.");

  program
    .command("download [query]")
    .description("Download latest versions.")
    .option("--limit <n>", "Limit to newest N versions (default: 1).", parsePositiveInt)
    .option("--all", "Download all versions.")
    .option("--offset <n>", "Skip newest N versions before selecting.", parseNonNegativeInt)
    .option("--threads <n>", "Concurrent downloads (max 5).", parseThreads)
    .option("--unattended", "Disable prompts and require exact package name.")
    .option("--abi <list>", "Comma-separated ABI list (e.g. arm64-v8a,armeabi-v7a).", parseAbiList)
    .option("--output <path>", "Set output path for this download.")
    .helpOption("--help", "Display command help.")
    .action(
      async (input: string | undefined, commandOptions: PullCommandOptions) => {
      const unattended = Boolean(commandOptions.unattended);
      const outputPath = resolveOutputPath(commandOptions.output);
      const selectorOptions = resolvePullSelectorOptions(commandOptions);
      const resolvedInput = await resolveInput(input || "");

      if (resolvedInput.mode === "batch") {
        await runPullBatch(resolvedInput.queries || [], commandOptions, unattended, outputPath);
        return;
      }

      await runCommand(
        "download",
        (callbacks) =>
          downloadVersions({
            query: resolvedInput.query || "",
            limit: selectorOptions.limit,
            offset: selectorOptions.offset,
            all: selectorOptions.all,
            threads: commandOptions.threads || 1,
            unattended,
            outputPath,
            abis: commandOptions.abi,
            downloadTimeoutMs: commandOptions.downloadTimeout,
            onInteractionStarted: callbacks.onInteractionStarted,
            onInteractionEnded: callbacks.onInteractionEnded,
            onProgressMessage: callbacks.onProgressMessage,
            onFileCompleted: (event) => callbacks.onLiveMessage(formatPullFileEvent(event)),
          }),
        (result) => {
          renderPullResult(result);
        },
        {
          spinnerMessage: buildInitialLookupLabel(resolvedInput.query || ""),
          resolveExitCode: (result) => (result.failed > 0 ? 4 : 0),
        }
      );
    },
    );

  program
    .command("info [query]")
    .description("Inspect all package versions.")
    .option("--abi <list>", "Comma-separated ABI list (e.g. arm64-v8a,armeabi-v7a).", parseAbiList)
    .helpOption("--help", "Display command help.")
    .action(async (input: string | undefined, commandOptions: ShowCommandOptions) => {
      const unattended = false;
      const resolvedInput = await resolveInput(input || "");

      if (resolvedInput.mode === "batch") {
        await runShowBatch(resolvedInput.queries || [], commandOptions, unattended);
        return;
      }

      await runCommand(
        "show",
        (callbacks) =>
          showVersions({
            query: resolvedInput.query || "",
            unattended,
            abis: commandOptions.abi,
            onInteractionStarted: callbacks.onInteractionStarted,
            onInteractionEnded: callbacks.onInteractionEnded,
            onProgressMessage: callbacks.onProgressMessage,
          }),
        (result) => {
          renderShowResult(result);
        },
        {
          spinnerMessage: buildInitialLookupLabel(resolvedInput.query || ""),
        }
      );
    });

  program
    .command("output [path]")
    .description("Show or set default output directory.")
    .helpOption("--help", "Display command help.")
    .action((dir?: string) => {
      const trimmed = typeof dir === "string" ? dir.trim() : "";

      if (!trimmed) {
        const current = getOutputDir();
        if (current) {
          writeStdout(
            `${chalk.cyan("Output path:")} ${chalk.bold(current)}\n` +
              `${chalk.dim("  Config path:")} ${chalk.dim(getConfigFilePath())}\n`
          );
          return;
        }

        writeStdout(
          `${chalk.yellow("output path is not configured.")}\n` +
            `${chalk.dim("  config file:")} ${chalk.dim(getConfigFilePath())}\n` +
            `${chalk.dim("Run `apkpure output <dir>` to set it.")}\n`
        );
        return;
      }

      const resolved = path.resolve(trimmed);
      setOutputDir(resolved);

      writeStdout(
        `${chalk.green("output path updated:")} ${chalk.bold(resolved)}\n` +
          `${chalk.dim("  config file:")} ${chalk.dim(getConfigFilePath())}\n`
      );
    });

  program.action(async () => {
    program.outputHelp();
  });

  return program;
}

buildProgram()
  .parseAsync()
  .catch((error) => {
    const appError = asAppError(error);
    process.stderr.write(`[${appError.code}] ${appError.message}\n`);
    process.exitCode = appError.exitCode;
  });
