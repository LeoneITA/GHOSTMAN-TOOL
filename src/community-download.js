const { createWriteStream } = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { randomUUID } = require("node:crypto");

const pluginIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const maxArchiveBytes = 100 * 1024 * 1024;
const initialHosts = new Set(["github.com", "cdn.discordapp.com"]);
const redirectHosts = new Set([
  ...initialHosts,
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

function parseCommunityInstallUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Link di installazione GHOSTMAN non valido.");
  }

  const pluginId = parsed.searchParams.get("id");
  const downloadUrl = parsed.searchParams.get("url");
  if (
    parsed.protocol !== "ghostman:" ||
    parsed.hostname !== "install" ||
    parsed.pathname !== "" ||
    !pluginId ||
    !pluginIdPattern.test(pluginId) ||
    !downloadUrl
  ) {
    throw new Error("Link di installazione GHOSTMAN non valido.");
  }
  validateArchiveUrl(downloadUrl);
  return { pluginId, downloadUrl };
}

function validateArchiveUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Link del pacchetto non valido.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !initialHosts.has(url.hostname) ||
    !/\.(zip|rar)$/i.test(url.pathname) ||
    (url.hostname === "github.com" &&
      !/\/releases\/download\//.test(url.pathname)) ||
    (url.hostname === "cdn.discordapp.com" &&
      !/\/attachments\//.test(url.pathname))
  ) {
    throw new Error("Sono accettati solo archivi ZIP o RAR da GitHub o Discord.");
  }
  return url;
}

async function downloadCommunityArchive(rawUrl) {
  let currentUrl = validateArchiveUrl(rawUrl);
  let response;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    response = await fetch(currentUrl.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
      headers: { "User-Agent": "GHOSTMAN-Community-Installer" },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirectCount === 5) {
      throw new Error("Il download ha superato il limite di reindirizzamenti.");
    }
    const location = response.headers.get("location");
    if (!location) throw new Error("Reindirizzamento del download non valido.");
    currentUrl = new URL(location, currentUrl);
    if (
      currentUrl.protocol !== "https:" ||
      currentUrl.username ||
      currentUrl.password ||
      (currentUrl.port && currentUrl.port !== "443") ||
      !redirectHosts.has(currentUrl.hostname)
    ) {
      throw new Error("Il download è stato reindirizzato a un host non autorizzato.");
    }
  }
  if (!response.ok) {
    throw new Error(`Download del plugin non riuscito (HTTP ${response.status}).`);
  }
  const finalUrl = currentUrl;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxArchiveBytes) {
    throw new Error("Il pacchetto supera il limite di 100 MiB.");
  }
  if (!response.body) throw new Error("Il server non ha inviato il pacchetto.");

  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "ghostman-community-download-"),
  );
  const filePath = path.join(
    directory,
    `${randomUUID()}${path.extname(initialUrl.pathname).toLowerCase()}`,
  );
  let receivedBytes = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, callback) {
          receivedBytes += chunk.length;
          if (receivedBytes > maxArchiveBytes) {
            callback(new Error("Il pacchetto supera il limite di 100 MiB."));
            return;
          }
          callback(null, chunk);
        },
      }),
      createWriteStream(filePath, { flags: "wx" }),
    );
    if (receivedBytes === 0) throw new Error("Il pacchetto scaricato è vuoto.");
    return { directory, filePath };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  downloadCommunityArchive,
  parseCommunityInstallUrl,
  validateArchiveUrl,
};
