import path from "path";
import { download, DownloadOptions, DownloadProgress } from "./download.js";
import {
  createPackage,
  createPackageFromName,
  getPackageVersions,
  MarketplaceVersion,
  PackageRecord,
  PackageVersionFetchOptions,
  searchPackages,
} from "./apkpure.js";
import { getConfigFilePath, getOutputDir, setOutputDir } from "./config.js";
import {
  downloadVersions,
  DownloadFileEvent,
  DownloadFileResult,
  DownloadResult,
  isPackageName,
  normalizeAbiDisplay,
  OperationWarning,
  showVersions,
  VersionsResult,
  VersionsRow,
} from "./versions.js";
import { AppError } from "./errors.js";

export interface ApkPureOptions {
  outputDir?: string;
}

export interface ClientDownloadOptions {
  limit?: number;
  offset?: number;
  all?: boolean;
  threads?: number;
  unattended?: boolean;
  outputDir?: string;
  abis?: string[];
  downloadTimeoutMs?: number;
  onInteractionStarted?: () => void;
  onInteractionEnded?: () => void;
  onProgressMessage?: (message: string) => void;
  onFileCompleted?: (event: DownloadFileEvent) => void;
}

export interface ClientInfoOptions {
  unattended?: boolean;
  abis?: string[];
  onInteractionStarted?: () => void;
  onInteractionEnded?: () => void;
  onProgressMessage?: (message: string) => void;
}

export class ApkPure {
  private customOutputDir?: string;

  constructor(options?: ApkPureOptions) {
    if (options?.outputDir && options.outputDir.trim().length > 0) {
      this.customOutputDir = path.resolve(options.outputDir.trim());
    }
  }

  getOutputDir(): string | undefined {
    return this.customOutputDir || getOutputDir();
  }

  getConfigFilePath(): string {
    return getConfigFilePath();
  }

  setOutputDir(dir: string): string {
    const resolved = path.resolve(dir.trim());
    setOutputDir(resolved);
    this.customOutputDir = resolved;
    return resolved;
  }

  async searchPackages(query: string | string[]): Promise<PackageRecord[]> {
    const queries = Array.isArray(query) ? query : [query];
    return searchPackages(queries);
  }

  async getPackageVersions(
    packageName: string,
    options?: PackageVersionFetchOptions
  ): Promise<MarketplaceVersion[]> {
    return getPackageVersions(packageName, options);
  }

  async getPackageInfo(query: string, options?: ClientInfoOptions): Promise<VersionsResult> {
    return showVersions({
      query,
      unattended: options?.unattended ?? true,
      abis: options?.abis,
      onInteractionStarted: options?.onInteractionStarted,
      onInteractionEnded: options?.onInteractionEnded,
      onProgressMessage: options?.onProgressMessage,
    });
  }

  async downloadPackage(
    query: string,
    options?: ClientDownloadOptions
  ): Promise<DownloadResult> {
    const targetDir =
      options?.outputDir && options.outputDir.trim().length > 0
        ? path.resolve(options.outputDir.trim())
        : this.getOutputDir();

    if (!targetDir) {
      throw new AppError(
        "E_INVALID_INPUT",
        "Output path is not configured. Pass outputDir in options or call setOutputDir()."
      );
    }

    return downloadVersions({
      query,
      limit: options?.limit,
      offset: options?.offset,
      all: options?.all,
      threads: options?.threads,
      unattended: options?.unattended ?? true,
      outputPath: targetDir,
      abis: options?.abis,
      downloadTimeoutMs: options?.downloadTimeoutMs,
      onInteractionStarted: options?.onInteractionStarted,
      onInteractionEnded: options?.onInteractionEnded,
      onProgressMessage: options?.onProgressMessage,
      onFileCompleted: options?.onFileCompleted,
    });
  }

  async downloadUrl(
    downloadUrl: string,
    destinationFilePath: string,
    options?: DownloadOptions
  ): Promise<void> {
    return download(downloadUrl, destinationFilePath, options);
  }
}

export async function queryPackages(query: string): Promise<PackageRecord[]> {
  return searchPackages([query]);
}

export async function downloadPackage(
  downloadUrl: string,
  destinationFilePath: string,
  options?: DownloadOptions
): Promise<void> {
  return download(downloadUrl, destinationFilePath, options);
}

export {
  download,
  downloadVersions,
  getPackageVersions,
  searchPackages,
  showVersions,
  getOutputDir,
  setOutputDir,
  getConfigFilePath,
  createPackage,
  createPackageFromName,
  isPackageName,
  normalizeAbiDisplay,
};

export type {
  DownloadOptions,
  DownloadProgress,
  DownloadFileEvent,
  DownloadFileResult,
  DownloadResult,
  MarketplaceVersion,
  PackageRecord,
  PackageVersionFetchOptions,
  OperationWarning,
  VersionsResult,
  VersionsRow,
};

export default ApkPure;
