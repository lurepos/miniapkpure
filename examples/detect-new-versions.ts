import { getPackageVersions } from "../src/index.js";

const APP_PACKAGE = "com.whatsapp";
const CURRENT_LOCAL_VERSION = "2.24.4.75";

async function checkUpdates() {
  const versions = await getPackageVersions(APP_PACKAGE);

  if (!versions || versions.length === 0) {
    return;
  }

  const latestVersion = versions[0];

  if (latestVersion.versionTag !== CURRENT_LOCAL_VERSION) {
    console.log("New update detected:", {
      version: latestVersion.versionTag,
      code: latestVersion.versionCode,
      releaseDate: latestVersion.timestamp,
      sizeMB: (latestVersion.size / 1024 / 1024).toFixed(2),
      downloadUrl: latestVersion.downloadUrl,
    });
  }
}

checkUpdates().catch(() => {});
