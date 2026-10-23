const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");
const { createCommunityPlugins } = require("../src/community-plugins");

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createFixture(manifestOverrides = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ghostman-community-plugin-"),
  );
  temporaryDirectories.push(root);
  const sourceDirectory = path.join(root, "downloaded-plugin");
  const installedDirectory = path.join(root, "user-data", "community-plugins");
  await fs.mkdir(sourceDirectory, { recursive: true });
  await fs.writeFile(
    path.join(sourceDirectory, "manifest.json"),
    JSON.stringify({
      id: "sample-community-tool",
      name: "Sample Community Tool",
      version: "1.0.0",
      description: "A community test plugin.",
      runtime: "python",
      entry: "main.py",
      inputs: [],
      ...manifestOverrides,
    }),
  );
  await fs.writeFile(
    path.join(sourceDirectory, "main.py"),
    "print('community plugin')\n",
  );
  await fs.mkdir(path.join(sourceDirectory, "assets"));
  await fs.writeFile(path.join(sourceDirectory, "assets", "note.txt"), "asset");

  let allowInstall = true;
  let allowReplace = true;
  const installer = createCommunityPlugins({
    pluginsDirectory: installedDirectory,
    selectPluginDirectory: async () => sourceDirectory,
    confirmInstall: async () => allowInstall,
    confirmReplace: async () => allowReplace,
  });

  return {
    installer,
    sourceDirectory,
    installedDirectory,
    setAllowInstall: (value) => {
      allowInstall = value;
    },
    setAllowReplace: (value) => {
      allowReplace = value;
    },
  };
}

test("installs an extracted Python plugin into the persistent user plugin directory", async () => {
  const { installer, installedDirectory } = await createFixture();
  const installed = await installer.importPlugin();

  assert.equal(installed.id, "sample-community-tool");
  assert.equal(installed.version, "1.0.0");
  assert.equal(
    await fs.readFile(
      path.join(installedDirectory, installed.id, "main.py"),
      "utf8",
    ),
    "print('community plugin')\n",
  );
  assert.equal(
    await fs.readFile(
      path.join(installedDirectory, installed.id, "assets", "note.txt"),
      "utf8",
    ),
    "asset",
  );
});

test("installs a plugin directly from an already imported folder", async () => {
  const { installer, sourceDirectory, installedDirectory } =
    await createFixture();
  const installed = await installer.importPlugin(sourceDirectory);

  assert.equal(installed.id, "sample-community-tool");
  assert.equal(
    await fs.readFile(
      path.join(installedDirectory, installed.id, "main.py"),
      "utf8",
    ),
    "print('community plugin')\n",
  );
});

test("requires confirmation before installing or replacing a plugin", async () => {
  const fixture = await createFixture();
  fixture.setAllowInstall(false);
  assert.equal(await fixture.installer.importPlugin(), null);
  await assert.rejects(
    fs.access(path.join(fixture.installedDirectory, "sample-community-tool")),
    { code: "ENOENT" },
  );

  fixture.setAllowInstall(true);
  await fixture.installer.importPlugin();
  fixture.setAllowReplace(false);
  await fs.writeFile(
    path.join(fixture.sourceDirectory, "main.py"),
    "print('new version')\n",
  );
  assert.equal(await fixture.installer.importPlugin(), null);
  assert.equal(
    await fs.readFile(
      path.join(fixture.installedDirectory, "sample-community-tool", "main.py"),
      "utf8",
    ),
    "print('community plugin')\n",
  );
});

test("rejects invalid runtimes, entry paths, and reserved built-in plugin IDs", async () => {
  const unsupported = await createFixture({ runtime: "javascript" });
  await assert.rejects(
    unsupported.installer.importPlugin(),
    /solo plugin Python/,
  );

  const traversal = await createFixture({ entry: "..\\outside.py" });
  await assert.rejects(
    traversal.installer.importPlugin(),
    /solo plugin Python/,
  );

  const reserved = await createFixture();
  const installer = createCommunityPlugins({
    pluginsDirectory: reserved.installedDirectory,
    selectPluginDirectory: async () => reserved.sourceDirectory,
    confirmInstall: async () => true,
    getReservedPluginIds: async () => ["sample-community-tool"],
  });
  await assert.rejects(installer.importPlugin(), /già usato/);
});

test("replacing an installed community plugin is atomic and updates all assets", async () => {
  const fixture = await createFixture();
  await fixture.installer.importPlugin();
  await fs.writeFile(
    path.join(fixture.sourceDirectory, "main.py"),
    "print('updated plugin')\n",
  );

  const updated = await fixture.installer.importPlugin();
  assert.equal(updated.version, "1.0.0");
  assert.equal(
    await fs.readFile(
      path.join(
        fixture.installedDirectory,
        "sample-community-tool",
        "main.py",
      ),
      "utf8",
    ),
    "print('updated plugin')\n",
  );
});
