const assert = require("node:assert/strict");
const { createWriteStream } = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");
const yazl = require("yazl");
const { createCommunityFiles } = require("../src/community-files");

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createService(selectedItems = []) {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "ghostman-community-files-"),
  );
  temporaryDirectories.push(temporaryDirectory);
  const sourceDirectory = path.join(temporaryDirectory, "downloads");
  await fs.mkdir(sourceDirectory);
  const selected = [];

  for (const [index, item] of selectedItems.entries()) {
    const entry = typeof item === "string" ? { name: item, kind: "file" } : item;
    const sourcePath = path.join(sourceDirectory, entry.name);
    if (entry.kind === "folder") {
      await fs.mkdir(sourcePath, { recursive: true });
      for (const [relativePath, contents] of Object.entries(entry.files)) {
        const filePath = path.join(sourcePath, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, contents);
      }
    } else if (entry.kind === "zip") {
      const zip = new yazl.ZipFile();
      const output = createWriteStream(sourcePath);
      const saved = new Promise((resolve, reject) => {
        output.on("close", resolve);
        output.on("error", reject);
      });
      for (const [relativePath, contents] of Object.entries(entry.files)) {
        zip.addBuffer(Buffer.from(contents), relativePath);
      }
      zip.outputStream.pipe(output);
      zip.end();
      await saved;
    } else {
      await fs.writeFile(sourcePath, `test content ${index}`);
    }
    selected.push({ kind: entry.kind, path: sourcePath });
  }

  const openedPaths = [];
  const service = createCommunityFiles({
    userDataPath: path.join(temporaryDirectory, "user-data"),
    selectItems: async () => selected,
    saveFileDialog: async (name) =>
      path.join(temporaryDirectory, `exported-${name}`),
    selectExportDirectory: async (name) => {
      const exportRoot = path.join(temporaryDirectory, `export-${name}`);
      await fs.mkdir(exportRoot, { recursive: true });
      return exportRoot;
    },
    openPath: async (filePath) => {
      openedPaths.push(filePath);
      return "";
    },
  });

  return { service, selected, openedPaths, temporaryDirectory };
}

test("imports multiple file types locally and lets users open, export, and remove them", async () => {
  const { service, selected, openedPaths, temporaryDirectory } =
    await createService(["example.py", "preview.html", "document.docx", "tool.exe"]);

  const imported = await service.importFiles();
  assert.deepEqual(
    imported.map((file) => file.name),
    ["example.py", "preview.html", "document.docx", "tool.exe"],
  );
  assert.deepEqual(await service.list(), imported);
  assert.ok(imported.every((file) => file.remoteAllowed === false));

  await service.setRemoteAllowed(imported[0].id, true);
  assert.equal(
    (await service.list()).find((file) => file.id === imported[0].id)
      .remoteAllowed,
    true,
  );
  const remoteCopy = await service.readRemoteFile(imported[0].id);
  assert.equal(remoteCopy.file.name, "example.py");
  assert.equal(remoteCopy.contents.toString("utf8"), "test content 0");
  await service.setRemoteAllowed(imported[0].id, false);
  assert.equal(
    (await service.list()).find((file) => file.id === imported[0].id)
      .remoteAllowed,
    false,
  );
  await assert.rejects(
    service.readRemoteFile(imported[0].id),
    /non è abilitato/,
  );

  await service.openFile(imported[0].id);
  assert.equal(openedPaths.length, 1);
  assert.notEqual(openedPaths[0], selected[0].path);
  assert.equal(await fs.readFile(openedPaths[0], "utf8"), "test content 0");

  assert.equal(await service.exportFile(imported[1].id), true);
  assert.equal(
    await fs.readFile(
      path.join(temporaryDirectory, "exported-preview.html"),
      "utf8",
    ),
    "test content 1",
  );

  await service.removeFile(imported[2].id);
  assert.deepEqual(
    (await service.list()).map((file) => file.name),
    ["example.py", "preview.html", "tool.exe"],
  );
  await assert.rejects(service.openFile(imported[2].id), /non trovato/);
});

test("cancelled file selection leaves the local library unchanged", async () => {
  const { service } = await createService();
  assert.deepEqual(await service.importFiles(), []);
  assert.deepEqual(await service.list(), []);
});

test("imports, opens, remotely reads, and exports complete site folders", async () => {
  const { service, openedPaths, temporaryDirectory } = await createService([
    {
      name: "sample-site",
      kind: "folder",
      files: {
        "index.html": "<link rel='stylesheet' href='css/site.css'>",
        "css/site.css": "body { color: white; }",
        "js/app.js": "document.title = 'site';",
        "assets/logo.svg": "<svg></svg>",
      },
    },
  ]);

  const [site] = await service.importFiles();
  assert.equal(site.kind, "folder");
  assert.equal(site.entryPath, "index.html");
  assert.equal(
    await service.getFolderPath(site.id),
    path.join(
      temporaryDirectory,
      "user-data",
      "community-files",
      site.id,
      site.name,
    ),
  );
  assert.equal(
    site.size,
    [
      "<link rel='stylesheet' href='css/site.css'>",
      "body { color: white; }",
      "document.title = 'site';",
      "<svg></svg>",
    ].reduce((size, contents) => size + Buffer.byteLength(contents), 0),
  );

  await service.openFile(site.id);
  assert.equal(path.basename(openedPaths[0]), "index.html");

  await service.setRemoteAllowed(site.id, true);
  const stylesheet = await service.readRemoteSiteFile(site.id, "css/site.css");
  assert.equal(stylesheet.file.name, "site.css");
  assert.equal(stylesheet.contents.toString("utf8"), "body { color: white; }");
  await assert.rejects(
    service.readRemoteSiteFile(site.id, "../outside.txt"),
    /Percorso del sito non valido/,
  );
  await assert.rejects(
    service.readRemoteSiteFile(site.id, "missing.css"),
    (error) => error.statusCode === 404,
  );

  assert.equal(await service.exportFile(site.id), true);
  const exportedPath = path.join(
    temporaryDirectory,
    "export-sample-site",
    "sample-site",
  );
  assert.equal(
    await fs.readFile(path.join(exportedPath, "css", "site.css"), "utf8"),
    "body { color: white; }",
  );
  assert.equal(
    await fs.readFile(path.join(exportedPath, "assets", "logo.svg"), "utf8"),
    "<svg></svg>",
  );
});

test("folder export does not overwrite an existing folder", async () => {
  const { service, temporaryDirectory } = await createService([
    {
      name: "sample-site",
      kind: "folder",
      files: { "index.html": "<h1>site</h1>" },
    },
  ]);
  const [site] = await service.importFiles();
  const destination = path.join(
    temporaryDirectory,
    "export-sample-site",
    "sample-site",
  );
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, "keep.txt"), "keep");

  await assert.rejects(service.exportFile(site.id), /Esiste già una cartella/);
  assert.equal(await fs.readFile(path.join(destination, "keep.txt"), "utf8"), "keep");
});

test("folders without an HTML entry cannot be enabled for mobile access", async () => {
  const { service } = await createService([
    { name: "project", kind: "folder", files: { "notes.txt": "local only" } },
  ]);
  const [folder] = await service.importFiles();
  assert.equal(folder.entryPath, "");
  await assert.rejects(service.getFolderPath("not-a-valid-id"), /non valido/);
  await assert.rejects(
    service.setRemoteAllowed(folder.id, true),
    /deve contenere index\.html o index\.htm/,
  );
});

test("imports a ZIP as an expandable folder and supports nested mobile sites", async () => {
  const { service, openedPaths } = await createService([
    {
      name: "site-package.zip",
      kind: "zip",
      files: {
        "public/index.html": "<link rel='stylesheet' href='css/site.css'>",
        "public/css/site.css": "body { color: white; }",
        "public/assets/logo.svg": "<svg></svg>",
      },
    },
  ]);

  const [site] = await service.importFiles();
  assert.equal(site.name, "site-package");
  assert.equal(site.kind, "folder");
  assert.equal(site.entryPath, "public/index.html");

  const [listedSite] = await service.list();
  assert.deepEqual(
    listedSite.contents.map((item) => item.path),
    ["public/assets/logo.svg", "public/css/site.css", "public/index.html"],
  );

  await service.openFile(site.id);
  assert.equal(path.basename(openedPaths[0]), "index.html");
  assert.equal(path.basename(path.dirname(openedPaths[0])), "public");

  await service.setRemoteAllowed(site.id, true);
  const stylesheet = await service.readRemoteSiteFile(
    site.id,
    "public/css/site.css",
  );
  assert.equal(stylesheet.contents.toString("utf8"), "body { color: white; }");
});

test("rejects invalid RAR archives without leaving partial imports", async () => {
  const { service } = await createService([{ name: "broken.rar", kind: "rar" }]);

  await assert.rejects(service.importFiles(), /Impossibile leggere il file RAR/);
  assert.deepEqual(await service.list(), []);
});

test("rejects ZIP path traversal and removes partially extracted data", async () => {
  const { service, selected, temporaryDirectory } = await createService([
    {
      name: "unsafe.zip",
      kind: "zip",
      files: { "ab/evil.txt": "must not escape" },
    },
  ]);
  const archive = await fs.readFile(selected[0].path);
  const originalName = Buffer.from("ab/evil.txt");
  const traversalName = Buffer.from("../evil.txt");
  let offset = 0;
  while ((offset = archive.indexOf(originalName, offset)) !== -1) {
    traversalName.copy(archive, offset);
    offset += traversalName.length;
  }
  await fs.writeFile(selected[0].path, archive);

  await assert.rejects(
    service.importFiles(),
    /percorso non sicuro|invalid relative path/,
  );
  assert.deepEqual(await service.list(), []);
  await assert.rejects(
    fs.access(path.join(temporaryDirectory, "user-data", "outside.txt")),
    { code: "ENOENT" },
  );
});
