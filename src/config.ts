import fs from "fs";
import os from "os";
import path from "path";
import { select } from "@inquirer/prompts";
import { AppError } from "./errors.js";
import { PackageRecord } from "./apkpure.js";

interface AppConfig {
  outputDir?: string;
}

function resolveConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(appData, ".apkpure-downloader");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", ".apkpure-downloader");
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfig, ".apkpure-downloader");
}

const configFile = path.join(resolveConfigDir(), "settings.dat");

let config: AppConfig | undefined;

function loadConfig(): AppConfig {
  if (config) {
    return config;
  }

  try {
    if (fs.existsSync(configFile)) {
      const parsed = JSON.parse(fs.readFileSync(configFile, "utf8")) as { outputDir?: unknown };
      if (typeof parsed.outputDir === "string" && parsed.outputDir.trim().length > 0) {
        config = { outputDir: path.resolve(parsed.outputDir.trim()) };
        return config;
      }
    }
  } catch {}

  config = {};
  return config;
}

export function getConfigFilePath(): string {
  return configFile;
}

export function getOutputDir(): string | undefined {
  return loadConfig().outputDir;
}

export function setOutputDir(dir: string): void {
  const resolved = path.resolve(dir);
  loadConfig().outputDir = resolved;

  if (!fs.existsSync(path.dirname(configFile))) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
  }

  fs.writeFileSync(configFile, JSON.stringify({ outputDir: resolved }, null, 2), "utf8");
}

function formatRating(rating: number): string {
  if (rating <= 0 || Number.isNaN(rating)) {
    return "-";
  }

  return rating.toFixed(1);
}

export async function selectPackage(query: string, options: PackageRecord[]): Promise<PackageRecord> {
  try {
    return await select({
      message: `"${query}" — select a package:`,
      choices: options.map((pkg) => ({
        name: `${pkg.beautyName} (${pkg.name}) [Rating: ${formatRating(pkg.rating)}]`,
        value: pkg,
      })),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      throw new AppError("E_INVALID_INPUT", "Package selection cancelled.");
    }

    throw new AppError(
      "E_NON_INTERACTIVE_INPUT_REQUIRED",
      "Interactive selection is unavailable. Provide a package name or remove --unattended in a TTY terminal.",
      { error }
    );
  }
}
