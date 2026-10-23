const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");
const { createPluginPages } = require("../src/plugin-pages");

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createFixture(manifestOverrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ghostman-plugin-page-"));
  temporaryDirectories.push(root);
  const pluginDirectory = path.join(root, "plugins", "community");
  await fs.mkdir(pluginDirectory, { recursive: true });
  await fs.writeFile(
    path.join(pluginDirectory, "manifest.json"),
    JSON.stringify({
      id: "community",
      runtime: "html",
      entry: "index.html",
      ...manifestOverrides,
    }),
  );
  await fs.writeFile(path.join(pluginDirectory, "index.html"), "<h1>Community</h1>");

  const openedPaths = [];
  const pages = createPluginPages({
    pluginDirectories: [path.join(root, "plugins")],
    openPath: async (filePath) => {
      openedPaths.push(filePath);
      return "";
    },
  });
  return { pages, openedPaths, pluginDirectory };
}

test("opens the declared HTML entry of a bundled community plugin", async () => {
  const { pages, openedPaths, pluginDirectory } = await createFixture();

  assert.equal(await pages.openPage("community"), true);
  assert.deepEqual(openedPaths, [path.join(pluginDirectory, "index.html")]);
});

test("rejects non-HTML plugins and unsafe entry paths", async () => {
  const pythonPlugin = await createFixture({ runtime: "python" });
  await assert.rejects(
    pythonPlugin.pages.openPage("community"),
    /pagina HTML apribile/,
  );

  const traversalPlugin = await createFixture({ entry: "..\\outside.html" });
  await assert.rejects(
    traversalPlugin.pages.openPage("community"),
    /pagina HTML apribile/,
  );
});

test("reports browser opening errors", async () => {
  const { pluginDirectory } = await createFixture();
  const pages = createPluginPages({
    pluginDirectories: [path.dirname(pluginDirectory)],
    openPath: async () => "No browser is associated with this file",
  });

  await assert.rejects(
    pages.openPage("community"),
    /No browser is associated with this file/,
  );
});

test("exposes the approved HTML plugin as a safe mobile site with assets", async () => {
  const { pages, pluginDirectory } = await createFixture();
  await fs.mkdir(path.join(pluginDirectory, "assets"));
  await fs.writeFile(path.join(pluginDirectory, "assets", "site.css"), "body {}");

  const site = await pages.getRemoteSite("community");
  assert.equal(site.id, "plugin-site-community");
  assert.equal(site.kind, "folder");
  assert.equal(site.entryPath, "index.html");
  assert.ok(site.contents.some((item) => item.path === "assets/site.css"));

  const resource = await pages.readRemoteSiteFile(
    site.id,
    "assets/site.css",
  );
  assert.equal(resource.file.name, "site.css");
  assert.equal(resource.contents.toString("utf8"), "body {}");
  await assert.rejects(
    pages.readRemoteSiteFile(site.id, "../outside.txt"),
    /Percorso del sito non valido/,
  );
});
