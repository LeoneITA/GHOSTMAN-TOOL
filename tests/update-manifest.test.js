const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  getInstallerDownloadUrl,
  getPublishedReleaseAssetUrl,
  getPublishedInstallerUrl,
  isTrustedUpdateFileUrl,
  isTrustedInstallerUrl,
  parseReleaseVersion,
  parseUpdateManifest,
} = require("../src/update-manifest");

test("builds a version-specific installer URL without using the GitHub API", () => {
  assert.equal(
    getInstallerDownloadUrl("LeoneITA/GHOSTMAN-TOOL", "1.1.10"),
    "https://github.com/LeoneITA/GHOSTMAN-TOOL/releases/download/v1.1.10/GHOSTMAN-Setup.exe",
  );
  assert.throws(
    () => getInstallerDownloadUrl("LeoneITA/GHOSTMAN-TOOL", "../latest"),
    /Percorso del pacchetto/,
  );
});

test("parses a version manifest with a changelog and matching portable EXE", () => {
  assert.deepEqual(
    parseUpdateManifest(
      JSON.stringify({
        version: "0.2.9",
        file: "GHOSTMAN-0.2.9.exe",
        notes: "Miglioramenti e correzioni.",
      }),
    ),
    {
      version: "0.2.9",
      file: "GHOSTMAN-0.2.9.exe",
      notes: "Miglioramenti e correzioni.",
    },
  );
});

test("uses update/version.json version without requiring an EXE filename", () => {
  assert.deepEqual(
    parseUpdateManifest(JSON.stringify({ version: "0.4.4" })),
    {
      version: "0.4.4",
      file: "GHOSTMAN-Setup.exe",
      notes: "",
    },
  );
});

test("rejects invalid manifests and mismatched filenames", () => {
  assert.throws(() => parseUpdateManifest("{"), /JSON valido/);
  assert.throws(
    () =>
      parseUpdateManifest(
        JSON.stringify({
          version: "0.2.9",
          file: "GHOSTMAN-0.2.8.exe",
        }),
      ),
    /formato previsto/,
  );
  assert.throws(
    () =>
      parseUpdateManifest(
        JSON.stringify({ version: "0.4.4", file: "malware.exe" }),
      ),
    /formato previsto/,
  );
});

test("offers a download only after the matching release asset is published", () => {
  const url =
    "https://github.com/LeoneITA/GHOSTMAN-TOOL/releases/download/v0.2.9/GHOSTMAN-0.2.9.exe";
  const release = {
    tag_name: "v0.2.9",
    assets: [{ name: "GHOSTMAN-0.2.9.exe", browser_download_url: url }],
  };
  assert.equal(
    getPublishedReleaseAssetUrl(
      release,
      "LeoneITA/GHOSTMAN-TOOL",
      "0.2.9",
      "GHOSTMAN-0.2.9.exe",
    ),
    url,
  );
  assert.equal(
    isTrustedUpdateFileUrl(
      url,
      "LeoneITA/GHOSTMAN-TOOL",
      "0.2.9",
      "GHOSTMAN-0.2.9.exe",
    ),
    true,
  );
  assert.equal(
    getPublishedReleaseAssetUrl(
      { tag_name: "v0.2.9", assets: [] },
      "LeoneITA/GHOSTMAN-TOOL",
      "0.2.9",
      "GHOSTMAN-0.2.9.exe",
    ),
    "",
  );
  assert.equal(
    getPublishedReleaseAssetUrl(
      { tag_name: "v0.2.8", assets: release.assets },
      "LeoneITA/GHOSTMAN-TOOL",
      "0.2.9",
      "GHOSTMAN-0.2.9.exe",
    ),
    "",
  );
  assert.equal(
    isTrustedUpdateFileUrl(
      "https://attacker.example/GHOSTMAN-0.2.9.exe",
      "LeoneITA/GHOSTMAN-TOOL",
      "0.2.9",
      "GHOSTMAN-0.2.9.exe",
    ),
    false,
  );
  assert.equal(
    isTrustedUpdateFileUrl(
      url,
      "LeoneITA/GHOSTMAN-TOOL",
      "0.2.10",
      "GHOSTMAN-0.2.10.exe",
    ),
    false,
  );
});

test("reads the app version and installer URL from the latest GitHub release", () => {
  const release = {
    tag_name: "v0.3.4",
    draft: false,
    prerelease: false,
    body: "Correzioni e miglioramenti.",
    assets: [
      {
        name: "GHOSTMAN-Setup.exe",
        browser_download_url:
          "https://github.com/LeoneITA/GHOSTMAN-TOOL/releases/download/v0.3.4/GHOSTMAN-Setup.exe",
      },
    ],
  };

  assert.deepEqual(parseReleaseVersion(release), {
    version: "0.3.4",
    notes: "Correzioni e miglioramenti.",
  });
  assert.equal(
    getPublishedInstallerUrl(release, "LeoneITA/GHOSTMAN-TOOL", "0.3.4"),
    release.assets[0].browser_download_url,
  );
  assert.equal(
    isTrustedInstallerUrl(
      release.assets[0].browser_download_url,
      "LeoneITA/GHOSTMAN-TOOL",
      "0.3.4",
    ),
    true,
  );
  assert.equal(
    getPublishedInstallerUrl(
      { ...release, assets: [] },
      "LeoneITA/GHOSTMAN-TOOL",
      "0.3.4",
    ),
    "",
  );
  assert.throws(
    () => parseReleaseVersion({ ...release, tag_name: "latest" }),
    /versione valida/,
  );
});
