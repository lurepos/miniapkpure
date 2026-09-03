import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import { AppError } from "./errors.js";
import {
  createPackageFromName,
  getPackageVersions,
  MarketplaceVersion,
  PackageRecord,
  searchPackages,
} from "./apkpure.js";
import { download } from "./download.js";
import { selectPackage } from "./config.js";

const ANDROID_PACKAGE_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i;
const ABI_PRIORITY = ["arm64-v8a", "armeabi-v7a", "armeabi", "x86", "x86_64"];
const ABI_PRIORITY_MAP = new Map(ABI_PRIORITY.map((abi, index) => [abi, index]));

export interface OperationWarning {
  message: string;
  details?: unknown;
}

export function isPackageName(input: string): boolean {
  return ANDROID_PACKAGE_NAME_PATTERN.test(input.trim());
}

function compareAbiTokens(left: string, right: string): number {
  const leftPriority = ABI_PRIORITY_MAP.get(left);
  const rightPriority = ABI_PRIORITY_MAP.get(right);

  if (typeof leftPriority === "number" && typeof rightPriority === "number") {
    return leftPriority - rightPriority;
  }
  if (typeof leftPriority === "number") {
    return -1;
  }
  if (typeof rightPriority === "number") {
    return 1;
  }
  return left.localeCompare(right);
}

function normalizeAbiTokens(raw?: string): string[] {
  if (!raw) {
    return [];
  }

  return Array.from(
    new Set(
      raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    )
  ).sort(compareAbiTokens);
}

export function normalizeAbiDisplay(raw?: string): string | undefined {
  const tokens = normalizeAbiTokens(raw);
  return tokens.length > 0 ? tokens.join(",") : undefined;
}

function normalizeAbiFileSegment(raw?: string): string | undefined {
  const tokens = normalizeAbiTokens(raw);
  return tokens.length > 0 ? tokens.join("+") : undefined;
}

function normalizeAbiList(values?: string[]): string[] {
  return Array.from(
    new Set(
      (values || [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  ).sort(compareAbiTokens);
}

function normalizeAbiListDisplay(values?: string[]): string | undefined {
  const tokens = normalizeAbiList(values);
  return tokens.length > 0 ? tokens.join(",") : undefined;
}

function describeVersionVariant(version: Pick<MarketplaceVersion, "abi" | "assetType">): string {
  const abi = normalizeAbiDisplay(version.abi) || "-";
  const assetType = version.assetType?.trim().toUpperCase();

  return assetType ? `${abi} (${assetType})` : abi;
}

function sortVersionsByTimestampDesc(versions: MarketplaceVersion[]): MarketplaceVersion[] {
  return versions
    .map((version, index) => ({ version, index }))
    .sort((left, right) => {
      const leftDate = dayjs(left.version.timestamp);
      const rightDate = dayjs(right.version.timestamp);
      const leftValue = leftDate.isValid() ? leftDate.valueOf() : Number.NEGATIVE_INFINITY;
      const rightValue = rightDate.isValid() ? rightDate.valueOf() : Number.NEGATIVE_INFINITY;

      if (leftValue !== rightValue) {
        return rightValue - leftValue;
      }

      return left.index - right.index;
    })
    .map((entry) => entry.version);
}

function buildVersionLogicalKey(version: Pick<MarketplaceVersion, "versionTag" | "versionCode">): string {
  const versionCode = version.versionCode?.trim();
  return versionCode ? `code:${versionCode}` : `tag:${version.versionTag.toLowerCase()}`;
}

function buildVersionCanonicalKey(version: MarketplaceVersion): string {
  const abiKey = normalizeAbiDisplay(version.abi) || "-";
  const assetType = version.assetType?.trim().toLowerCase() || "-";

  return `${buildVersionLogicalKey(version)}|abi:${abiKey}|type:${assetType}`;
}

function canonicalizeVersions(versions: MarketplaceVersion[]): MarketplaceVersion[] {
  const seen = new Set<string>();

  return versions.filter((version) => {
    const key = buildVersionCanonicalKey(version);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function getPreferredVersionClass(tokens: string[]): number {
  const hasKnownAbi = tokens.some((token) => ABI_PRIORITY_MAP.has(token));

  if (tokens.length === 1 && hasKnownAbi) {
    return 0;
  }
  if (tokens.length > 1 && hasKnownAbi) {
    return 1;
  }
  if (tokens.length === 1) {
    return 2;
  }
  if (tokens.length > 1) {
    return 3;
  }
  return 4;
}

function getAbiPriorityValue(abi: string): number {
  const priority = ABI_PRIORITY_MAP.get(abi);
  return typeof priority === "number" ? priority : Number.MAX_SAFE_INTEGER;
}

function selectPreferredVersionWithoutAbi(versions: MarketplaceVersion[]): MarketplaceVersion | undefined {
  return versions
    .map((version, index) => ({ version, index, abiTokens: normalizeAbiTokens(version.abi) }))
    .sort((left, right) => {
      const leftClass = getPreferredVersionClass(left.abiTokens);
      const rightClass = getPreferredVersionClass(right.abiTokens);
      if (leftClass !== rightClass) {
        return leftClass - rightClass;
      }

      const leftPriority = left.abiTokens.reduce(
        (best, token) => Math.min(best, getAbiPriorityValue(token)),
        Number.MAX_SAFE_INTEGER
      );
      const rightPriority = right.abiTokens.reduce(
        (best, token) => Math.min(best, getAbiPriorityValue(token)),
        Number.MAX_SAFE_INTEGER
      );
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      if (left.abiTokens.length !== right.abiTokens.length) {
        return left.abiTokens.length - right.abiTokens.length;
      }

      return left.index - right.index;
    })[0]?.version;
}

interface AbiSelectionResult {
  selected: MarketplaceVersion[];
  unresolvedAbis: string[];
  availableVariants: string[];
}

function selectVersionsForRequestedAbis(
  versions: MarketplaceVersion[],
  requestedAbis: string[]
): AbiSelectionResult {
  const normalizedRequestedAbis = normalizeAbiList(requestedAbis);
  const candidates = versions.map((version, index) => ({
    version,
    index,
    abiTokens: normalizeAbiTokens(version.abi),
  }));
  const availableVariants = Array.from(
    new Set(candidates.map((candidate) => describeVersionVariant(candidate.version)))
  );
  const selectedIndexes = new Set<number>();
  const unresolved = new Set(normalizedRequestedAbis);

  normalizedRequestedAbis.forEach((requestedAbi) => {
    const exactMatch = candidates.find(
      (candidate) => candidate.abiTokens.length === 1 && candidate.abiTokens[0] === requestedAbi
    );
    if (!exactMatch) {
      return;
    }

    selectedIndexes.add(exactMatch.index);
    unresolved.delete(requestedAbi);
  });

  while (unresolved.size > 0) {
    const bestBundle = candidates
      .filter((candidate) => !selectedIndexes.has(candidate.index) && candidate.abiTokens.length > 1)
      .map((candidate) => ({
        candidate,
        coveredAbis: candidate.abiTokens.filter((abi) => unresolved.has(abi)),
      }))
      .filter((entry) => entry.coveredAbis.length > 0)
      .sort((left, right) => {
        if (left.coveredAbis.length !== right.coveredAbis.length) {
          return right.coveredAbis.length - left.coveredAbis.length;
        }
        if (left.candidate.abiTokens.length !== right.candidate.abiTokens.length) {
          return left.candidate.abiTokens.length - right.candidate.abiTokens.length;
        }
        return left.candidate.index - right.candidate.index;
      })[0];

    if (!bestBundle) {
      break;
    }

    selectedIndexes.add(bestBundle.candidate.index);
    bestBundle.coveredAbis.forEach((abi) => {
      unresolved.delete(abi);
    });
  }

  return {
    selected: candidates
      .filter((candidate) => selectedIndexes.has(candidate.index))
      .sort((left, right) => left.index - right.index)
      .map((candidate) => candidate.version),
    unresolvedAbis: Array.from(unresolved).sort(compareAbiTokens),
    availableVariants,
  };
}

function groupVersions(sortedVersions: MarketplaceVersion[]): {
  groupedVersions: MarketplaceVersion[];
  groupedMap: Map<string, MarketplaceVersion[]>;
} {
  const groupedMap = new Map<string, MarketplaceVersion[]>();
  sortedVersions.forEach((version) => {
    const key = buildVersionLogicalKey(version);
    const list = groupedMap.get(key) || [];
    list.push(version);
    groupedMap.set(key, list);
  });

  const groupedVersions = Array.from(groupedMap.values()).map((entries) => entries[0]);
  return { groupedVersions, groupedMap };
}

function selectVersionRange(
  items: MarketplaceVersion[],
  selector: { limit: number; offset: number }
): MarketplaceVersion[] {
  return items.slice(selector.offset, selector.offset + selector.limit);
}

function resolveVersionSelector(
  input: { limit?: number; offset?: number; last?: number; all?: boolean } | undefined,
  operation: "download" | "show"
): { limit: number; offset: number } {
  if (operation === "show" || !input) {
    return {
      limit: Number.MAX_SAFE_INTEGER,
      offset: 0,
    };
  }

  const limitVal = input.all
    ? Number.MAX_SAFE_INTEGER
    : typeof input.limit === "number"
      ? input.limit
      : typeof input.last === "number"
        ? input.last
        : 1;

  return {
    limit: limitVal,
    offset: input.offset && input.offset > 0 ? input.offset : 0,
  };
}

async function resolvePackageInput(
  query: string,
  options: {
    unattended: boolean;
    onInteractionStarted?: () => void;
    onInteractionEnded?: () => void;
  }
): Promise<PackageRecord> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new AppError("E_INVALID_INPUT", "Package query is required.");
  }

  if (isPackageName(trimmed)) {
    return createPackageFromName(trimmed);
  }

  const searchResults = await searchPackages([trimmed]);
  if (searchResults.length === 0) {
    throw new AppError("E_INVALID_INPUT", `No packages found for: ${trimmed}.`);
  }

  const exact = searchResults.find(
    (candidate) => candidate.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (exact) {
    return exact;
  }

  if (options.unattended) {
    throw new AppError(
      "E_NON_INTERACTIVE_INPUT_REQUIRED",
      "Package selection is required. Remove --unattended or provide a package name."
    );
  }

  options.onInteractionStarted?.();
  const selected = await selectPackage(trimmed, searchResults);
  options.onInteractionEnded?.();

  return selected;
}

export interface VersionsRow {
  offset: number;
  name: string;
  versionTag: string;
  versionCode?: string;
  timestamp: string;
  size: number;
  downloadUrl: string;
  abi?: string;
  assetType?: string;
  assetUsability?: string;
  source?: "direct" | "torrent" | "both" | "none";
  sha1?: string;
  isOffDownload?: boolean;
}

export interface VersionsResult {
  message: string;
  rows: VersionsRow[];
  warnings: OperationWarning[];
}

export interface ShowInput {
  query: string;
  unattended: boolean;
  abis?: string[];
  onInteractionStarted?: () => void;
  onInteractionEnded?: () => void;
  onProgressMessage?: (message: string) => void;
}

export async function showVersions(input: ShowInput): Promise<VersionsResult> {
  const selector = { limit: Number.MAX_SAFE_INTEGER, offset: 0 };
  const pkg = await resolvePackageInput(input.query, {
    unattended: input.unattended,
    onInteractionStarted: input.onInteractionStarted,
    onInteractionEnded: input.onInteractionEnded,
  });

  const warnings: OperationWarning[] = [];
  input.onProgressMessage?.(`Querying version files for ${pkg.name}`);
  const versions = await getPackageVersions(pkg.name, { abis: input.abis });

  const canonicalVersions = canonicalizeVersions(sortVersionsByTimestampDesc(versions));
  const { groupedVersions, groupedMap } = groupVersions(canonicalVersions);
  const selectedGrouped = selectVersionRange(groupedVersions, selector);

  if (selectedGrouped.length === 0) {
    warnings.push({ message: `No versions matched selector for ${pkg.name}.` });
  }

  const selectedRows = canonicalVersions.filter((version) => {
    const key = buildVersionLogicalKey(version);
    return selectedGrouped.some((selected) => buildVersionLogicalKey(selected) === key);
  });

  const groupOffsetMap = new Map<string, number>();
  groupedVersions.forEach((version, index) => {
    groupOffsetMap.set(buildVersionLogicalKey(version), index);
  });

  const rows: VersionsRow[] = selectedRows.map((version) => {
    const key = buildVersionLogicalKey(version);
    const offset = groupOffsetMap.get(key) ?? 0;
    return {
      offset,
      name: pkg.name,
      versionTag: version.versionTag,
      versionCode: version.versionCode,
      timestamp: version.timestamp,
      size: version.size,
      downloadUrl: version.downloadUrl,
      abi: version.abi,
      assetType: version.assetType,
      assetUsability: version.assetUsability,
      source: version.source,
      sha1: version.sha1,
      isOffDownload: version.isOffDownload,
    };
  });

  return {
    message: `Show completed for ${pkg.name}.`,
    rows,
    warnings,
  };
}

export interface DownloadFileResult {
  versionTag: string;
  abi?: string;
  status: "downloaded" | "skipped" | "failed";
  size: number;
  relativePath: string | null;
}

export interface DownloadFileEvent {
  packageName: string;
  versionTag: string;
  abi?: string;
  status: DownloadFileResult["status"];
  relativePath: string | null;
  fullPath: string | null;
}

export interface DownloadResult {
  message: string;
  showAbi: boolean;
  downloaded: number;
  skipped: number;
  failed: number;
  bytes: number;
  files: DownloadFileResult[];
  warnings: OperationWarning[];
}

export interface DownloadInput {
  query: string;
  limit?: number;
  offset?: number;
  all?: boolean;
  unattended: boolean;
  outputPath: string;
  threads?: number;
  abis?: string[];
  downloadTimeoutMs?: number;
  onInteractionStarted?: () => void;
  onInteractionEnded?: () => void;
  onProgressMessage?: (message: string) => void;
  onFileCompleted?: (event: DownloadFileEvent) => void;
}

function detectExtension(downloadUrl: string): ".apk" | ".xapk" {
  return downloadUrl.toLowerCase().includes(".xapk") ? ".xapk" : ".apk";
}

function sanitizeFilePart(input: string): string {
  return input
    .trim()
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "_");
}

function buildDownloadFilePath(
  outputPath: string,
  packageName: string,
  version: MarketplaceVersion,
  includeAbi: boolean
): string {
  const parts = [sanitizeFilePart(packageName || "unknown.package"), sanitizeFilePart(version.versionTag || "unknown")];

  if (version.versionCode) {
    parts.push(sanitizeFilePart(version.versionCode));
  }

  if (includeAbi && version.abi) {
    parts.push(sanitizeFilePart(normalizeAbiFileSegment(version.abi) || ""));
  }

  if (version.sha1) {
    parts.push(sanitizeFilePart(version.sha1.slice(0, 8)));
  }

  return path.join(outputPath, `${parts.join("_")}${detectExtension(version.downloadUrl)}`);
}

function formatVersionLabel(version: Pick<MarketplaceVersion, "versionTag" | "versionCode">): string {
  return version.versionCode ? `${version.versionTag} (${version.versionCode})` : version.versionTag;
}

export async function downloadVersions(input: DownloadInput): Promise<DownloadResult> {
  const selector = resolveVersionSelector(input, "download");
  const pkg = await resolvePackageInput(input.query, {
    unattended: input.unattended,
    onInteractionStarted: input.onInteractionStarted,
    onInteractionEnded: input.onInteractionEnded,
  });

  const warnings: OperationWarning[] = [];
  input.onProgressMessage?.(`Querying version files for ${pkg.name}`);
  const versions = await getPackageVersions(pkg.name, { abis: input.abis });

  const canonicalVersions = canonicalizeVersions(sortVersionsByTimestampDesc(versions));
  const { groupedVersions, groupedMap } = groupVersions(canonicalVersions);
  const selectedGrouped = selectVersionRange(groupedVersions, selector);
  const showAbi = Array.isArray(input.abis) && input.abis.length > 0;

  if (selectedGrouped.length === 0) {
    warnings.push({ message: `No versions matched selector for ${pkg.name}` });
  }

  const plannedVersions: { order: number; version: MarketplaceVersion }[] = [];
  const selectionFailures: { order: number; version: MarketplaceVersion; requestedAbi: string }[] = [];
  const defaultSelections: {
    version: MarketplaceVersion;
    selected: MarketplaceVersion;
    availableVariants: string[];
  }[] = [];
  let nextOrder = 0;

  if (showAbi) {
    const requestedAbi = normalizeAbiListDisplay(input.abis) || "-";

    selectedGrouped.forEach((groupedVersion) => {
      const key = buildVersionLogicalKey(groupedVersion);
      const candidates = groupedMap.get(key) || [groupedVersion];
      const selection = selectVersionsForRequestedAbis(candidates, input.abis || []);

      if (selection.unresolvedAbis.length > 0) {
        warnings.push({
          message: `Requested ABI set ${requestedAbi} is not fully available for ${pkg.name} ${formatVersionLabel(groupedVersion)}. Available variants: ${selection.availableVariants.join(", ") || "-"}`,
        });

        selectionFailures.push({ order: nextOrder, version: groupedVersion, requestedAbi });
        nextOrder += 1;
        return;
      }

      selection.selected.forEach((version) => {
        plannedVersions.push({ order: nextOrder, version });
        nextOrder += 1;
      });
    });
  } else {
    selectedGrouped.forEach((groupedVersion) => {
      const key = buildVersionLogicalKey(groupedVersion);
      const candidates = groupedMap.get(key) || [groupedVersion];
      const selected = selectPreferredVersionWithoutAbi(candidates) || groupedVersion;

      if (candidates.length > 1) {
        defaultSelections.push({
          version: groupedVersion,
          selected,
          availableVariants: Array.from(new Set(candidates.map((candidate) => describeVersionVariant(candidate)))),
        });
      }

      plannedVersions.push({ order: nextOrder, version: selected });
      nextOrder += 1;
    });

    if (defaultSelections.length > 0) {
      warnings.push({
        message:
          "Multiple ABI variants detected. Default pull selected preferred ABI order: arm64-v8a > armeabi-v7a > armeabi > x86 > x86_64. Use --abi to override.",
      });
    }
  }

  const result: DownloadResult = {
    message: `Pull completed for ${pkg.name}.`,
    showAbi,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
    files: [],
    warnings,
  };

  const fileResults: { order: number; file: DownloadFileResult }[] = [];
  selectionFailures.forEach((failure) => {
    result.failed += 1;

    fileResults.push({
      order: failure.order,
      file: {
        versionTag: failure.version.versionTag,
        abi: failure.requestedAbi,
        status: "failed",
        size: 0,
        relativePath: null,
      },
    });
  });

  if (plannedVersions.length > 0) {
    fs.mkdirSync(input.outputPath, { recursive: true });
  }

  interface DownloadTask {
    order: number;
    version: MarketplaceVersion;
    filePath: string;
    relativePath: string;
  }

  const tasks: DownloadTask[] = [];
  plannedVersions.forEach(({ order, version }) => {
    const filePath = buildDownloadFilePath(input.outputPath, pkg.name, version, showAbi);
    const relativePath = path.relative(input.outputPath, filePath).replace(/\\/g, "/");

    if (fs.existsSync(filePath)) {
      result.skipped += 1;

      fileResults.push({
        order,
        file: {
          versionTag: version.versionTag,
          abi: version.abi,
          status: "skipped",
          size: fs.statSync(filePath).size,
          relativePath,
        },
      });
      input.onFileCompleted?.({
        packageName: pkg.name,
        versionTag: version.versionTag,
        abi: version.abi,
        status: "skipped",
        relativePath,
        fullPath: filePath,
      });

      return;
    }

    tasks.push({ order, version, filePath, relativePath });
  });

  const queue = [...tasks];

  if (tasks.length > 0) {
    const noun = tasks.length === 1 ? "file" : "files";
    input.onProgressMessage?.(`Downloading ${tasks.length} version ${noun} for ${pkg.name}`);
  }

  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;

      try {
        await download(task.version.downloadUrl, task.filePath, {
          timeoutMs: input.downloadTimeoutMs,
        });
        const stat = fs.statSync(task.filePath);

        result.downloaded += 1;
        result.bytes += stat.size;

        fileResults.push({
          order: task.order,
          file: {
            versionTag: task.version.versionTag,
            abi: task.version.abi,
            status: "downloaded",
            size: stat.size,
            relativePath: task.relativePath,
          },
        });
        input.onFileCompleted?.({
          packageName: pkg.name,
          versionTag: task.version.versionTag,
          abi: task.version.abi,
          status: "downloaded",
          relativePath: task.relativePath,
          fullPath: task.filePath,
        });
      } catch (error) {
        result.failed += 1;

        fileResults.push({
          order: task.order,
          file: {
            versionTag: task.version.versionTag,
            abi: task.version.abi,
            status: "failed",
            size: 0,
            relativePath: task.relativePath,
          },
        });
        input.onFileCompleted?.({
          packageName: pkg.name,
          versionTag: task.version.versionTag,
          abi: task.version.abi,
          status: "failed",
          relativePath: task.relativePath,
          fullPath: task.filePath,
        });

        warnings.push({
          message: `Download failed for ${pkg.name} ${task.version.versionTag}.`,
          details: { error },
        });
      }
    }
  };

  const threads = Math.min(Math.max(input.threads || 1, 1), 5);
  const pool = Array.from({ length: Math.min(threads, tasks.length) }, () => worker());
  await Promise.all(pool);

  result.files = fileResults.sort((a, b) => a.order - b.order).map((entry) => entry.file);

  return result;
}
