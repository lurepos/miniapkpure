import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { downloadPackage, getPackageVersions } from "../src/index.js";

const TARGET_APP = "com.instagram.android";
const DOWNLOAD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "downloads");

async function pullLatestApk() {
  const versions = await getPackageVersions(TARGET_APP, {
    abis: ["arm64-v8a"],
  });

  if (!versions || versions.length === 0) {
    return;
  }

  const latest = versions[0];
  if (!latest.downloadUrl) {
    return;
  }

  const fileName = `${TARGET_APP}_v${latest.versionTag}_${latest.abi || "universal"}.apk`;
  const filePath = path.join(DOWNLOAD_DIR, fileName);

  if (fs.existsSync(filePath)) {
    return;
  }

  try {
    await downloadPackage(latest.downloadUrl, filePath);
    console.log({ status: "success", savedTo: filePath });
  } catch (err) {
    console.log({ status: "error", error: err });
  }
}

pullLatestApk().catch(() => {});
