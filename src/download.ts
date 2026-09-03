import fs from "fs";
import https from "https";
import path from "path";
import { AppError } from "./errors.js";
import {
  createNetworkRetryPolicy,
  isRetryableNetworkError,
  retryWithBackoff,
} from "./retry.js";

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
}

export interface DownloadOptions {
  timeoutMs?: number;
  onProgress?: (progress: DownloadProgress) => void;
}

const DEFAULT_USER_AGENT =
  "Dalvik/2.1.0 (Linux; U; Android 15; Pixel 4a (5G) Build/BP1A.250505.005); APKPure/3.20.53 (Aegon)";
const REDIRECT_STATUS_CODES = new Set([301, 302, 307, 308]);
const MAX_REDIRECTS = 8;

async function downloadOnce(
  url: string,
  destinationFilePath: string,
  onProgress: ((progress: DownloadProgress) => void) | undefined,
  redirectDepth: number,
  timeoutMs: number
): Promise<void> {
  if (redirectDepth > MAX_REDIRECTS) {
    throw new AppError("E_DOWNLOAD_FAILED", "Too many redirects during download.");
  }

  const file = fs.createWriteStream(destinationFilePath, { flags: "w" });

  return new Promise((resolve, reject) => {
    let settled = false;

    const finalizeFailure = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      file.close(() => reject(error));
    };

    const request = https.get(
      url,
      { headers: { "User-Agent": DEFAULT_USER_AGENT } },
      (response) => {
        const statusCode = response.statusCode || 0;
        if (REDIRECT_STATUS_CODES.has(statusCode)) {
          const nextUrl = response.headers.location;
          response.resume();

          if (!nextUrl) {
            finalizeFailure(new AppError("E_DOWNLOAD_FAILED", "Missing redirect target.", { url, statusCode }));
            return;
          }

          file.close(async () => {
            try {
              await fs.promises.unlink(destinationFilePath);
            } catch {}
            downloadOnce(nextUrl, destinationFilePath, onProgress, redirectDepth + 1, timeoutMs)
              .then(resolve)
              .catch(reject);
          });
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          finalizeFailure(new AppError("E_DOWNLOAD_FAILED", `Download failed (HTTP ${statusCode}).`, { url, statusCode }));
          return;
        }

        const totalBytes = Number.parseInt(response.headers["content-length"] || "0", 10);
        let receivedBytes = 0;

        response.on("data", (chunk) => {
          receivedBytes += chunk.length;
          if (!onProgress) {
            return;
          }

          if (totalBytes > 0) {
            onProgress({
              receivedBytes,
              totalBytes,
              percent: Math.round((receivedBytes / totalBytes) * 100),
            });
            return;
          }

          onProgress({ receivedBytes });
        });

        response.on("error", (error) => {
          finalizeFailure(
            new AppError("E_DOWNLOAD_FAILED", "Response stream failed during download.", { error, url })
          );
        });

        response.pipe(file);
        file.on("finish", () => {
          if (settled) {
            return;
          }
          settled = true;
          file.close(() => resolve());
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new AppError("E_DOWNLOAD_FAILED", `Download timeout after ${timeoutMs}ms.`, { url, statusCode: 408 })
      );
    });

    request.on("error", (error) => {
      if (error instanceof AppError) {
        finalizeFailure(error);
        return;
      }

      finalizeFailure(new AppError("E_DOWNLOAD_FAILED", "Network failure during download.", { error, url }));
    });

    file.on("error", (error) => {
      finalizeFailure(new AppError("E_DOWNLOAD_FAILED", "Failed to write download file.", { error, url }));
    });
  });
}

export async function download(
  url: string,
  destinationFilePath: string,
  options?: DownloadOptions
): Promise<void> {
  const retryPolicy = createNetworkRetryPolicy({ timeoutMs: options?.timeoutMs });

  await fs.promises.mkdir(path.dirname(destinationFilePath), { recursive: true });

  await retryWithBackoff(
    async () => {
      try {
        await downloadOnce(
          url,
          destinationFilePath,
          options?.onProgress,
          0,
          retryPolicy.timeoutMs
        );
      } catch (error) {
        try {
          await fs.promises.unlink(destinationFilePath);
        } catch {}
        throw error;
      }
    },
    retryPolicy,
    isRetryableNetworkError
  );
}
