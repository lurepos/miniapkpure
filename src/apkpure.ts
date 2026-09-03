import https from "https";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import readline from "readline";
import { AppError } from "./errors.js";
import {
  createNetworkRetryPolicy,
  isRetryableNetworkError,
  retryWithBackoff,
} from "./retry.js";

const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const APKPURE_USER_AGENT =
  "Dalvik/2.1.0 (Linux; U; Android 15; Pixel 4a (5G) Build/BP1A.250505.005); APKPure/3.20.53 (Aegon)";
const APKPURE_SEARCH_URL = "https://apkpure.com/search?q=%s";
const APKPURE_VERSIONS_URL =
  "https://tapi.pureapk.com/v3/get_app_his_version?hl=en&package_name=%s";
const DEFAULT_DEVICE_LANGUAGE = "en-US";
const DEFAULT_DEVICE_ABIS = ["arm64-v8a", "armeabi-v7a", "armeabi", "x86", "x86_64"];

export interface PackageRecord {
  url: string;
  rating: number;
  slug: string;
  name: string;
  beautyName: string;
}

export interface MarketplaceVersion {
  packageName: string;
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

export interface PackageVersionFetchOptions {
  abis?: string[];
}

interface RemoteVersionResponse {
  asset?: {
    url?: string;
    size?: number | string;
    type?: string;
    sha1?: string;
    torrent_url?: string;
  };
  version_name?: string;
  version_code?: string;
  version_date?: string;
  update_date?: string;
  update_time?: string;
  update_on?: string;
  native_code?: string | string[];
  asset_usability?: string;
  is_off_download?: boolean;
}

const retryPolicy = createNetworkRetryPolicy();

function unslugify(slug: string): string {
  return decodeURIComponent(slug)
    .replace(/-/g, " ")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizeNameToBeautyName(name: string): string {
  return name
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function createPackage(url: string, rating = 0): PackageRecord {
  const name = decodeURIComponent(url.split("/").slice(-1).join("/"));
  const slug = decodeURIComponent(url.split("/").slice(-2, -1).join("/"));

  return { url, rating, slug, name, beautyName: unslugify(slug) };
}

export function createPackageFromName(name: string): PackageRecord {
  const normalized = name.trim();

  return {
    url: "",
    rating: 0,
    slug: normalized,
    name: normalized,
    beautyName: normalizeNameToBeautyName(normalized),
  };
}

function dedupePackages(packages: PackageRecord[]): PackageRecord[] {
  return packages.filter(
    (pkg, index, self) =>
      index === self.findIndex((item) => (item.url || item.name) === (pkg.url || pkg.name))
  );
}

function buildApiHeaders(options?: PackageVersionFetchOptions): Record<string, string> {
  const abis =
    (options?.abis || []).map((abi) => abi.trim()).filter((abi) => abi.length > 0).length > 0
      ? options?.abis
      : DEFAULT_DEVICE_ABIS;

  return {
    "User-Agent": APKPURE_USER_AGENT,
    "ual-access-businessid": "projecta",
    "ual-access-projecta": JSON.stringify({
      device_info: {
        abis,
        language: DEFAULT_DEVICE_LANGUAGE,
        os_ver: "35",
      },
    }),
  };
}

function getJson(url: string, message: string, headers?: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: headers || buildApiHeaders() },
      (response) => {
        let body = "";

        response.on("data", (chunk) => {
          body += String(chunk);
        });

        response.on("end", () => {
          const statusCode = response.statusCode || 0;
          if (statusCode !== 200) {
            reject(new AppError("E_REMOTE_FETCH_FAILED", `${message} (HTTP ${statusCode}).`, { statusCode }));
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(
              new AppError("E_REMOTE_FETCH_FAILED", "Invalid JSON response from ApkPure endpoint.", {
                error,
                url,
              })
            );
          }
        });
      }
    );

    request.setTimeout(retryPolicy.timeoutMs, () => {
      request.destroy(
        new AppError("E_REMOTE_FETCH_FAILED", `Request timeout after ${retryPolicy.timeoutMs}ms.`, {
          url,
          statusCode: 408,
        })
      );
    });

    request.on("error", (error) => {
      if (error instanceof AppError) {
        reject(error);
        return;
      }

      reject(new AppError("E_REMOTE_FETCH_FAILED", "Network failure during remote fetch.", { error, url }));
    });
  });
}

function normalizeVersionTimestamp(item: RemoteVersionResponse): string {
  return item.version_date || item.update_date || item.update_time || item.update_on || "unknown";
}

function normalizeVersionTag(raw: unknown): string {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.replace(/\s/g, "") : "unknown";
}

function normalizeVersionCode(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function normalizeAbi(raw: unknown): string | undefined {
  const values =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === "string").join(",")
        : "";

  if (!values) {
    return undefined;
  }

  return values
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .join(",");
}

function toNumberOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

function findChromeExecutable(): string {
  const override = process.env.APKPURE_CHROME_PATH;
  if (override && fs.existsSync(override)) {
    return override;
  }

  const chromeRoot = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
  if (fs.existsSync(chromeRoot)) {
    const versions = fs
      .readdirSync(chromeRoot)
      .sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
    for (const version of versions) {
      for (const sub of ["chrome-linux64", "chrome-linux"]) {
        const candidate = path.join(chromeRoot, version, sub, "chrome");
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  throw new AppError(
    "E_REMOTE_FETCH_FAILED",
    "Chrome executable not found in ~/.cache/puppeteer. Run `npx puppeteer browsers install chrome` or set APKPURE_CHROME_PATH."
  );
}

class CdpBrowser {
  private ws: WebSocket | null = null;

  private nextId = 1;

  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();

  private eventWaiters: {
    method: string;
    sessionId?: string;
    predicate?: (params: Record<string, unknown>) => boolean;
    resolve: (params: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];

  private constructor(private readonly child: ChildProcess) {}

  static async launch(): Promise<CdpBrowser> {
    const executablePath = findChromeExecutable();
    const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    const child = spawn(
      executablePath,
      [
        ...(hasDisplay ? [] : ["--headless=new"]),
        "--remote-debugging-port=0",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );

    const wsUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AppError("E_REMOTE_FETCH_FAILED", "Chrome did not report a DevTools endpoint in time."));
        child.kill();
      }, 15000);

      const stderr = child.stderr;
      if (!stderr) {
        clearTimeout(timer);
        reject(new AppError("E_REMOTE_FETCH_FAILED", "Chrome stderr is unavailable."));
        return;
      }

      const lines = readline.createInterface({ input: stderr });
      lines.on("line", (line) => {
        const match = line.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          lines.close();
          resolve(match[1]);
        }
      });

      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new AppError("E_REMOTE_FETCH_FAILED", `Chrome exited before DevTools endpoint was ready (code ${code}).`));
      });
    });

    const browser = new CdpBrowser(child);
    await browser.connect(wsUrl);
    return browser;
  }

  private connect(wsUrl: string): Promise<void> {
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.addEventListener("message", (event) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(String(event.data)) as CdpMessage;
      } catch {
        return;
      }

      if (message.id !== undefined) {
        const handler = this.pending.get(message.id);
        if (handler) {
          this.pending.delete(message.id);
          if (message.error) {
            handler.reject(new Error(message.error.message));
          } else {
            handler.resolve(message.result || {});
          }
        }
        return;
      }

      if (message.method) {
        this.eventWaiters = this.eventWaiters.filter((waiter) => {
          if (waiter.method !== message.method || waiter.sessionId !== message.sessionId) {
            return true;
          }
          if (waiter.predicate && !waiter.predicate(message.params || {})) {
            return true;
          }

          clearTimeout(waiter.timer);
          waiter.resolve(message.params || {});
          return false;
        });
      }
    });

    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new AppError("E_REMOTE_FETCH_FAILED", "CDP WebSocket connection failed.")), { once: true });
    });
  }

  private send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new AppError("E_REMOTE_FETCH_FAILED", "CDP connection is not open."));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params: params || {}, sessionId });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(payload);
    });
  }

  private waitEvent(
    method: string,
    sessionId: string,
    timeoutMs: number,
    predicate?: (params: Record<string, unknown>) => boolean
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((waiter) => waiter.timer !== timer);
        reject(new AppError("E_REMOTE_FETCH_FAILED", `Timed out waiting for CDP event ${method}.`));
      }, timeoutMs);

      this.eventWaiters.push({ method, sessionId, predicate, resolve, reject, timer });
    });
  }

  async scrape(url: string, expression: string, timeoutMs: number): Promise<unknown> {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const session = String(sessionId);

    const evaluate = async (evalExpression: string): Promise<unknown> => {
      const evaluated = (await this.send(
        "Runtime.evaluate",
        { expression: evalExpression, returnByValue: true, awaitPromise: true },
        session
      )) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } };

      if (evaluated.exceptionDetails) {
        throw new AppError(
          "E_REMOTE_FETCH_FAILED",
          `ApkPure search page script failed: ${evaluated.exceptionDetails.exception?.description || "unknown error"}.`
        );
      }

      return evaluated.result?.value;
    };

    try {
      await this.send("Page.enable", {}, session);
      await this.send("Emulation.setUserAgentOverride", { userAgent: DESKTOP_USER_AGENT }, session);

      const loadPromise = this.waitEvent("Page.loadEventFired", session, timeoutMs);
      await this.send("Page.navigate", { url }, session);
      await loadPromise.catch(() => {});

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const title = String((await evaluate("document.title")) || "");
        if (title && !/just a moment|attention required/i.test(title)) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      while (true) {
        const value = await evaluate(expression);
        const hasValue = Array.isArray(value) ? value.length > 0 : Boolean(value);
        const outOfTime = Date.now() >= deadline;

        if (hasValue || outOfTime) {
          return value;
        }

        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } finally {
      await this.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    try {
      await this.send("Browser.close");
    } catch {}

    try {
      this.ws?.close();
    } catch {}

    if (this.child.exitCode === null && !this.child.killed) {
      this.child.kill("SIGKILL");
    }
  }
}

const SEARCH_EXTRACT_EXPRESSION = `(() => Array.from(document.querySelectorAll("a"))
  .map((el) => ({
    url: el.href,
    rating: el.querySelector(".star")?.textContent?.trim() || "0",
  }))
  .filter((item) =>
    item.url &&
    /^https:\\/\\/apkpure\\.com\\/[^/]+\\/[^/]+\\.[^/]+$/.test(item.url) &&
    !item.url.includes("com.apkpure.aegon")
  ))()`;

async function searchViaWeb(browser: CdpBrowser, term: string): Promise<PackageRecord[]> {
  const url = APKPURE_SEARCH_URL.replace("%s", encodeURIComponent(term));

  return retryWithBackoff(
    async () => {
      const value = await browser.scrape(url, SEARCH_EXTRACT_EXPRESSION, retryPolicy.timeoutMs);

      const rawPackages = (Array.isArray(value) ? value : []) as { url: string; rating: string }[];
      return rawPackages.map((pkg) => createPackage(pkg.url, Number.parseFloat(pkg.rating)));
    },
    retryPolicy,
    isRetryableNetworkError
  );
}

export async function searchPackages(terms: string[]): Promise<PackageRecord[]> {
  let browser: CdpBrowser | null = null;
  const packages: PackageRecord[] = [];

  try {
    for (const term of terms) {
      const normalizedTerm = term.trim();
      if (!normalizedTerm) {
        continue;
      }

      if (!browser) {
        browser = await CdpBrowser.launch();
      }

      packages.push(...(await searchViaWeb(browser, normalizedTerm)));
    }
  } catch (error) {
    throw new AppError("E_REMOTE_FETCH_FAILED", "ApkPure search failed.", { error });
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  return dedupePackages(packages);
}

export async function getPackageVersions(
  packageName: string,
  options?: PackageVersionFetchOptions
): Promise<MarketplaceVersion[]> {
  const normalizedPackageName = packageName.trim();
  const url = APKPURE_VERSIONS_URL.replace("%s", encodeURIComponent(normalizedPackageName));

  return retryWithBackoff(
    async () => {
      const payload = (await getJson(
        url,
        `Version fetch failed for ${normalizedPackageName}.`,
        buildApiHeaders(options)
      )) as { version_list?: RemoteVersionResponse[] };

      return (payload.version_list || [])
        .map((item): MarketplaceVersion | null => {
          const downloadUrl = item.asset?.url || "";
          if (!downloadUrl) {
            return null;
          }

          const hasTorrentSource =
            typeof item.asset?.torrent_url === "string" && item.asset.torrent_url.trim().length > 0;

          let source: MarketplaceVersion["source"] = "direct";
          if (hasTorrentSource) source = "both";

          const mapped: MarketplaceVersion = {
            packageName: normalizedPackageName,
            versionTag: normalizeVersionTag(item.version_name),
            timestamp: normalizeVersionTimestamp(item),
            size: toNumberOrZero(item.asset?.size),
            downloadUrl,
            source,
            isOffDownload: Boolean(item.is_off_download),
          };

          const versionCode = normalizeVersionCode(item.version_code);
          if (versionCode) {
            mapped.versionCode = versionCode;
          }

          const abi = normalizeAbi(item.native_code);
          if (abi) {
            mapped.abi = abi;
          }

          if (item.asset?.type) {
            mapped.assetType = item.asset.type;
          }

          if (item.asset_usability) {
            mapped.assetUsability = item.asset_usability;
          }

          if (item.asset?.sha1) {
            mapped.sha1 = item.asset.sha1;
          }

          return mapped;
        })
        .filter((item): item is MarketplaceVersion => Boolean(item));
    },
    retryPolicy,
    isRetryableNetworkError
  );
}
