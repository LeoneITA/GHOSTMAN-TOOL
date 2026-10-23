const versionPattern = /^\d+\.\d+\.\d+$/;

function parseUpdateManifest(contents) {
  let manifest;
  try {
    manifest = JSON.parse(contents);
  } catch {
    throw new Error("Il file update/version.json non contiene JSON valido.");
  }

  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    typeof manifest.version !== "string" ||
    !versionPattern.test(manifest.version) ||
    (manifest.file !== undefined &&
      ![
        "GHOSTMAN-Setup.exe",
        `GHOSTMAN-${manifest.version}.exe`,
      ].includes(manifest.file)) ||
    (manifest.notes !== undefined &&
      (typeof manifest.notes !== "string" || manifest.notes.length > 12_000))
  ) {
    throw new Error("Il file update/version.json non rispetta il formato previsto.");
  }

  return {
    version: manifest.version,
    file: manifest.file || "GHOSTMAN-Setup.exe",
    notes: manifest.notes || "",
  };
}

function getUpdateFileUrl(repository, version, file) {
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    typeof version !== "string" ||
    !versionPattern.test(version) ||
    typeof file !== "string" ||
    file !== `GHOSTMAN-${version}.exe`
  ) {
    throw new Error("Percorso del pacchetto di aggiornamento non valido.");
  }

  return `https://github.com/${repository}/releases/download/v${version}/${file}`;
}

function getPublishedReleaseAssetUrl(release, repository, version, file) {
  if (
    !release ||
    typeof release !== "object" ||
    release.tag_name !== `v${version}` ||
    !Array.isArray(release.assets)
  ) {
    return "";
  }

  const asset = release.assets.find(
    (item) => item && item.name === file && typeof item.browser_download_url === "string",
  );
  if (!asset) return "";

  const expectedUrl = getUpdateFileUrl(repository, version, file);
  return asset.browser_download_url === expectedUrl ? expectedUrl : "";
}

function parseReleaseVersion(release) {
  if (
    !release ||
    typeof release !== "object" ||
    release.draft === true ||
    release.prerelease === true ||
    typeof release.tag_name !== "string"
  ) {
    throw new Error("La release GitHub non è valida.");
  }

  const match = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name);
  if (!match) {
    throw new Error("La release GitHub non contiene una versione valida.");
  }

  return {
    version: match[1],
    notes: typeof release.body === "string" ? release.body.slice(0, 12_000) : "",
  };
}

function getPublishedInstallerUrl(release, repository, version) {
  if (
    !release ||
    release.tag_name !== `v${version}` ||
    !Array.isArray(release.assets)
  ) {
    return "";
  }
  const expectedUrl =
    `https://github.com/${repository}/releases/download/v${version}/GHOSTMAN-Setup.exe`;
  const asset = release.assets.find(
    (item) =>
      item &&
      item.name === "GHOSTMAN-Setup.exe" &&
      item.browser_download_url === expectedUrl,
  );
  return asset ? expectedUrl : "";
}

function isTrustedInstallerUrl(value, repository, version) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === "github.com" &&
    !url.port &&
    !url.username &&
    !url.password &&
    typeof repository === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
    typeof version === "string" &&
    versionPattern.test(version) &&
    url.pathname ===
      `/${repository}/releases/download/v${version}/GHOSTMAN-Setup.exe` &&
    !url.search &&
    !url.hash
  );
}

function isTrustedUpdateFileUrl(value, repository, version, file) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === "github.com" &&
    !url.port &&
    !url.username &&
    !url.password &&
    typeof version === "string" &&
    versionPattern.test(version) &&
    file === `GHOSTMAN-${version}.exe` &&
    url.pathname ===
      `/${repository}/releases/download/v${version}/${file}` &&
    !url.search &&
    !url.hash
  );
}

module.exports = {
  getUpdateFileUrl,
  getPublishedReleaseAssetUrl,
  parseReleaseVersion,
  getPublishedInstallerUrl,
  isTrustedInstallerUrl,
  isTrustedUpdateFileUrl,
  parseUpdateManifest,
};
