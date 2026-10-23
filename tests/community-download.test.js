const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  parseCommunityInstallUrl,
  validateArchiveUrl,
} = require("../src/community-download");

test("parses a valid GHOSTMAN install link with a Discord RAR attachment", () => {
  const downloadUrl =
    "https://cdn.discordapp.com/attachments/123/456/plugin.rar?ex=123&hm=abc";
  const installUrl = new URL("ghostman://install");
  installUrl.searchParams.set("id", "my-plugin");
  installUrl.searchParams.set("url", downloadUrl);

  assert.deepEqual(parseCommunityInstallUrl(installUrl.href), {
    pluginId: "my-plugin",
    downloadUrl,
  });
});

test("accepts GitHub release ZIPs and rejects unsupported or unsafe downloads", () => {
  assert.equal(
    validateArchiveUrl(
      "https://github.com/owner/repo/releases/download/v1.0/plugin.zip",
    ).hostname,
    "github.com",
  );
  assert.throws(
    () =>
      validateArchiveUrl(
        "https://cdn.discordapp.com/attachments/123/456/plugin.ipa",
      ),
    /solo archivi ZIP o RAR/,
  );
  assert.throws(
    () =>
      validateArchiveUrl(
        "https://evil.example/releases/download/v1/plugin.zip",
      ),
    /solo archivi ZIP o RAR/,
  );
});

test("rejects malformed or non-install protocol links", () => {
  assert.throws(
    () => parseCommunityInstallUrl("https://example.com"),
    /Link di installazione GHOSTMAN non valido/,
  );
  assert.throws(
    () =>
      parseCommunityInstallUrl(
        "ghostman://install?id=../outside&url=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Freleases%2Fdownload%2Fv1%2Fx.zip",
      ),
    /Link di installazione GHOSTMAN non valido/,
  );
});
