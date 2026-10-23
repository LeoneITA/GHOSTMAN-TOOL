const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");

test("Discord Toolkit is declared as an executable Python plugin", async () => {
  const pluginDirectory = path.join(__dirname, "..", "plugins", "discord-toolkit");
  const manifest = JSON.parse(
    await fs.readFile(path.join(pluginDirectory, "manifest.json"), "utf8"),
  );

  assert.equal(manifest.id, path.basename(pluginDirectory));
  assert.equal(manifest.runtime, "python");
  assert.equal(manifest.entry, "discord.py");
  assert.equal(manifest.id, "discord-toolkit");

  const entryPath = path.join(pluginDirectory, manifest.entry);
  const entry = await fs.readFile(entryPath, "utf8");
  assert.ok(entry.trim());
});
