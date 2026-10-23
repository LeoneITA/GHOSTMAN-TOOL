const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createRemoteAccess } = require("./remote");
const { createCommunityFiles } = require("./community-files");
const { createCommunityPlugins } = require("./community-plugins");
const { createPluginPages } = require("./plugin-pages");
const {
  downloadCommunityArchive,
  parseCommunityInstallUrl,
} = require("./community-download");
const {
  getPublishedInstallerUrl,
  isTrustedInstallerUrl,
  parseReleaseVersion,
  parseUpdateManifest,
} = require("./update-manifest");

const isDev = !app.isPackaged;
const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
const updateRepository = "LeoneITA/GHOSTMAN-TOOL";
const pluginIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const pluginInputTypes = new Set(["text", "number", "url"]);
const maxPluginInputBytes = 64 * 1024;
const maxPluginOutputBytes = 1024 * 1024;
const pluginTimeoutMs = 30_000;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
let pendingInstallLinks = process.argv.filter((argument) =>
  argument.startsWith("ghostman://"),
);
let updateState = {
  status: "idle",
  version: app.getVersion(),
  notes: "",
  progress: 0,
  portable: isPortable,
  downloadUrl: "",
  error: "",
  manifestUpdate: {
    status: "idle",
    available: false,
    ready: false,
    version: app.getVersion(),
    notes: "",
    downloadUrl: "",
    error: "",
  },
};

function publishUpdateState(nextState) {
  updateState = { ...updateState, ...nextState };
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("ghostman:update-state", updateState);
  }
}

function normalizeReleaseNotes(notes) {
  if (typeof notes === "string") return notes.slice(0, 12_000);
  if (Array.isArray(notes)) {
    return notes
      .map((note) =>
        note && typeof note.note === "string" ? note.note : "",
      )
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 12_000);
  }
  return "";
}

function compareVersions(left, right) {
  const parse = (version) =>
    String(version)
      .replace(/^v/i, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10));
  const leftParts = parse(left);
  const rightParts = parse(right);

  if (
    leftParts.length !== 3 ||
    rightParts.length !== 3 ||
    [...leftParts, ...rightParts].some((part) => !Number.isInteger(part))
  ) {
    throw new Error("Versione di aggiornamento non valida.");
  }

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

async function checkLatestReleaseUpdate() {
  publishUpdateState({
    manifestUpdate: {
      ...updateState.manifestUpdate,
      status: "checking",
      error: "",
    },
  });
  const manifestResponse = await fetch(
    `https://raw.githubusercontent.com/${updateRepository}/main/update/version.json?t=${Date.now()}`,
    {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!manifestResponse.ok) {
    throw new Error(
      `Impossibile leggere update/version.json da GitHub (HTTP ${manifestResponse.status}).`,
    );
  }
  const manifest = parseUpdateManifest(await manifestResponse.text());
  const currentVersion = app.getVersion();
  const available = compareVersions(manifest.version, currentVersion) > 0;

  if (!available) {
    const manifestUpdate = {
      status: "not-available",
      available: false,
      ready: false,
      version: manifest.version,
      notes: manifest.notes,
      downloadUrl: "",
      error: "",
    };
    publishUpdateState({ manifestUpdate });
    if (isPortable) {
      publishUpdateState({
        status: "not-available",
        version: currentVersion,
        notes: "",
        downloadUrl: "",
        error: "",
      });
    }
    return updateState;
  }

  const tag = `v${manifest.version}`;
  const response = await fetch(
    `https://api.github.com/repos/${updateRepository}/releases/tags/${tag}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "GHOSTMAN-Desktop",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (response.status === 404) {
    const manifestUpdate = {
      status: "preparing",
      available: true,
      ready: false,
      version: manifest.version,
      notes: manifest.notes,
      downloadUrl: "",
      error: "",
    };
    publishUpdateState({ manifestUpdate });
    if (isPortable) {
      publishUpdateState({
        status: "preparing",
        version: manifest.version,
        notes: manifest.notes,
        downloadUrl: "",
        error: "",
      });
    }
    return updateState;
  }
  if (!response.ok) {
    throw new Error(`GitHub ha risposto con errore HTTP ${response.status}.`);
  }

  const release = await response.json();
  const releaseInfo = parseReleaseVersion(release);
  if (releaseInfo.version !== manifest.version) {
    throw new Error(
      "La release GitHub non corrisponde alla versione dichiarata in update/version.json.",
    );
  }
  const downloadUrl = available
    ? getPublishedInstallerUrl(release, updateRepository, releaseInfo.version)
    : "";
  const manifestUpdate = {
    status: available ? (downloadUrl ? "available" : "preparing") : "not-available",
    available,
    ready: Boolean(downloadUrl),
    version: manifest.version,
    notes: manifest.notes || releaseInfo.notes,
    downloadUrl,
    error: "",
  };
  publishUpdateState({ manifestUpdate });

  if (isPortable) {
    publishUpdateState({
      status: available
        ? downloadUrl
          ? "available"
          : "preparing"
        : "not-available",
      version: available ? releaseInfo.version : app.getVersion(),
      notes: available ? manifestUpdate.notes : "",
      downloadUrl: manifestUpdate.downloadUrl,
      error: "",
    });
  }
  return updateState;
}

function reportReleaseUpdateError(error) {
  publishUpdateState({
    manifestUpdate: {
      ...updateState.manifestUpdate,
      status: "error",
      error: error.message,
    },
  });
}

function initializeAutoUpdates() {
  if (isDev) return;

  checkLatestReleaseUpdate().catch(reportReleaseUpdateError);
  setInterval(() => {
    checkLatestReleaseUpdate().catch(reportReleaseUpdateError);
  }, 4 * 60 * 60 * 1000);

  if (isPortable) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => {
    publishUpdateState({ status: "checking", error: "", progress: 0 });
  });
  autoUpdater.on("update-available", (info) => {
    publishUpdateState({
      status: "available",
      version: info.version,
      notes: normalizeReleaseNotes(info.releaseNotes),
      error: "",
    });
  });
  autoUpdater.on("update-not-available", () => {
    publishUpdateState({
      status: "not-available",
      version: app.getVersion(),
      notes: "",
      error: "",
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    publishUpdateState({
      status: "downloading",
      progress: Math.round(progress.percent),
    });
  });
  autoUpdater.on("update-downloaded", (event) => {
    publishUpdateState({
      status: "downloaded",
      version: event.version,
      notes: normalizeReleaseNotes(event.releaseNotes),
      progress: 100,
    });
  });
  autoUpdater.on("error", (error) => {
    publishUpdateState({ status: "error", error: error.message });
  });

  autoUpdater.checkForUpdates().catch((error) => {
    publishUpdateState({ status: "error", error: error.message });
  });
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((error) => {
      publishUpdateState({ status: "error", error: error.message });
    });
  }, 4 * 60 * 60 * 1000);
}

function getPluginDirectory() {
  return isDev
    ? path.join(app.getAppPath(), "plugins")
    : path.join(process.resourcesPath, "plugins");
}

function getCommunityPluginDirectory() {
  return path.join(app.getPath("userData"), "community-plugins");
}

function getRemoteSettingsPath() {
  return path.join(app.getPath("userData"), "remote-settings.json");
}

async function readRemoteApprovals() {
  try {
    const settings = JSON.parse(
      await fs.readFile(getRemoteSettingsPath(), "utf8"),
    );
    return Array.isArray(settings.approvedPlugins)
      ? settings.approvedPlugins.filter(
          (id) => typeof id === "string" && pluginIdPattern.test(id),
        )
      : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeRemoteApprovals(approvedPlugins) {
  const filePath = getRemoteSettingsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(
    tempPath,
    JSON.stringify({ approvedPlugins }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.rename(tempPath, filePath);
}

async function loadPlugins() {
  const result = [];
  const seenIds = new Set();
  const approvedPlugins = new Set(await readRemoteApprovals());

  for (const directory of [getPluginDirectory(), getCommunityPluginDirectory()]) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;

      const manifestPath = path.join(directory, entry.name, "manifest.json");
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        const manifest = JSON.parse(raw);
        if (
          typeof manifest.id !== "string" ||
          !pluginIdPattern.test(manifest.id) ||
          manifest.id !== entry.name ||
          seenIds.has(manifest.id) ||
          typeof manifest.name !== "string" ||
          typeof manifest.version !== "string" ||
          typeof manifest.description !== "string"
        ) {
          continue;
        }

        const runtime =
          manifest.runtime === "python" &&
          typeof manifest.entry === "string" &&
          /^[^\\/]+\.py$/i.test(manifest.entry)
            ? "python"
            : manifest.runtime === "html" &&
                typeof manifest.entry === "string" &&
                /^[^\\/]+\.html?$/i.test(manifest.entry)
              ? "html"
              : null;
        result.push({
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          category: manifest.category || "Utility",
          runtime,
          remoteAllowed:
            ["python", "html"].includes(runtime) &&
            approvedPlugins.has(manifest.id),
          inputs: Array.isArray(manifest.inputs)
            ? manifest.inputs.filter(
                (input) =>
                  input &&
                  typeof input.name === "string" &&
                  /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(input.name) &&
                  typeof input.label === "string" &&
                  pluginInputTypes.has(input.type) &&
                  typeof input.required === "boolean",
              )
            : [],
        });
        seenIds.add(manifest.id);
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
          throw error;
        }
      }
    }
  }

  return result;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    title: "GHOSTMAN",
    icon: path.join(__dirname, "..", "assets", "icon.ico"),
    backgroundColor: "#0b0c0f",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));
}

ipcMain.handle("ghostman:get-app-version", () => app.getVersion());
ipcMain.handle("ghostman:get-update-state", () => updateState);
ipcMain.handle("ghostman:check-for-updates", async () => {
  if (isDev) {
    publishUpdateState({
      status: "error",
      error: "Il controllo aggiornamenti è disponibile nelle build installate.",
    });
    return updateState;
  }

  try {
    await checkLatestReleaseUpdate().catch(reportReleaseUpdateError);
    if (isPortable) return updateState;
    await autoUpdater.checkForUpdates();
    return updateState;
  } catch (error) {
    publishUpdateState({ status: "error", error: error.message });
    return updateState;
  }
});
ipcMain.handle("ghostman:install-update", () => {
  if (isDev || isPortable || updateState.status !== "downloaded") {
    throw new Error("Non c'è un aggiornamento installabile in questa sessione.");
  }
  autoUpdater.quitAndInstall();
});
ipcMain.handle("ghostman:download-update-installer", async () => {
  const downloadUrl = updateState.manifestUpdate.available &&
    updateState.manifestUpdate.ready
    ? updateState.manifestUpdate.downloadUrl
    : isPortable && updateState.status === "available"
      ? updateState.downloadUrl
      : "";
  if (
    !downloadUrl ||
    !isTrustedInstallerUrl(
      downloadUrl,
      updateRepository,
      updateState.manifestUpdate.version,
    )
  ) {
    throw new Error("URL del pacchetto di aggiornamento non attendibile.");
  }
  await shell.openExternal(downloadUrl);
});

ipcMain.handle("ghostman:get-plugins", loadPlugins);
ipcMain.handle("ghostman:open-plugin-page", (_event, id) =>
  pluginPages.openPage(id),
);
ipcMain.handle("ghostman:set-plugin-remote-approval", async (_event, request) => {
  if (
    !request ||
    typeof request.id !== "string" ||
    !pluginIdPattern.test(request.id) ||
    typeof request.approved !== "boolean"
  ) {
    throw new Error("Richiesta di autorizzazione plugin non valida.");
  }

  const plugin = (await loadPlugins()).find((item) => item.id === request.id);
  if (!plugin || !["python", "html"].includes(plugin.runtime)) {
    throw new Error("Solo i plugin Python o HTML validi possono essere approvati.");
  }

  const approved = new Set(await readRemoteApprovals());
  if (request.approved) approved.add(request.id);
  else approved.delete(request.id);
  await writeRemoteApprovals([...approved].sort());
  return request.approved;
});

async function executePlugin(request) {
  if (
    !request ||
    typeof request.id !== "string" ||
    !pluginIdPattern.test(request.id) ||
    !request.input ||
    typeof request.input !== "object" ||
    Array.isArray(request.input)
  ) {
    throw new Error("Richiesta plugin non valida.");
  }

  const bundledPluginDirectory = path.join(getPluginDirectory(), request.id);
  let pluginDirectory = path.join(getCommunityPluginDirectory(), request.id);
  try {
    const bundledStat = await fs.lstat(bundledPluginDirectory);
    if (bundledStat.isDirectory() && !bundledStat.isSymbolicLink()) {
      pluginDirectory = bundledPluginDirectory;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const manifestPath = path.join(pluginDirectory, "manifest.json");
  const pluginStat = await fs.lstat(pluginDirectory);
  if (!pluginStat.isDirectory() || pluginStat.isSymbolicLink()) {
    throw new Error("Cartella plugin non valida.");
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

  if (
    manifest.id !== request.id ||
    manifest.runtime !== "python" ||
    typeof manifest.entry !== "string" ||
    !/^[^\\/]+\.py$/i.test(manifest.entry)
  ) {
    throw new Error("Plugin Python non valido o non supportato.");
  }

  const entryPath = path.resolve(pluginDirectory, manifest.entry);
  const relativeEntryPath = path.relative(pluginDirectory, entryPath);
  if (
    relativeEntryPath.startsWith("..") ||
    path.isAbsolute(relativeEntryPath)
  ) {
    throw new Error("Il file di avvio deve trovarsi nella cartella del plugin.");
  }

  const entryStat = await fs.lstat(entryPath);
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
    throw new Error("File di avvio del plugin non trovato.");
  }

  const declaredInputs = Array.isArray(manifest.inputs)
    ? manifest.inputs.filter(
        (input) =>
          input &&
          typeof input.name === "string" &&
          /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(input.name) &&
          typeof input.label === "string" &&
          pluginInputTypes.has(input.type) &&
          typeof input.required === "boolean",
      )
    : [];

  for (const field of declaredInputs) {
    const value = request.input[field.name];
    if (field.required && (value === undefined || String(value).trim() === "")) {
      throw new Error(`Il campo "${field.label}" è obbligatorio.`);
    }
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`Valore non valido per il campo "${field.label}".`);
    }
  }

  if (
    Object.keys(request.input).some(
      (name) => !declaredInputs.some((field) => field.name === name),
    )
  ) {
    throw new Error("Il plugin ha ricevuto campi non dichiarati.");
  }

  const inputJson = JSON.stringify(request.input);
  if (Buffer.byteLength(inputJson, "utf8") > maxPluginInputBytes) {
    throw new Error("I dati inviati al plugin sono troppo grandi.");
  }

  const pythonCommand = process.env.GHOSTMAN_PYTHON || "python";
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand, [entryPath], {
      cwd: pluginDirectory,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const timeout = setTimeout(() => {
      child.kill();
      finishWithError(new Error("Il plugin ha superato il limite di 30 secondi."));
    }, pluginTimeoutMs);

    function finishWithError(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }

    child.on("error", (error) => {
      finishWithError(
        new Error(
          `Impossibile avviare Python (${pythonCommand}): ${error.message}. Installa Python o imposta GHOSTMAN_PYTHON.`,
        ),
      );
    });

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxPluginOutputBytes) {
        child.kill();
        finishWithError(new Error("Il plugin ha prodotto un output troppo grande."));
        return;
      }
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      if (settled) return;
      stderr += chunk.toString("utf8").slice(0, 16_384 - stderr.length);
    });

    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;

      if (code !== 0) {
        reject(
          new Error(
            `Il plugin è terminato con codice ${code}: ${stderr.trim() || "nessun dettaglio fornito"}`,
          ),
        );
        return;
      }

      resolve({
        title: manifest.name,
        data: stdout.trim() || "(il plugin non ha prodotto output)",
      });
    });

    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") {
        finishWithError(new Error(`Errore nell'invio dei dati al plugin: ${error.message}`));
      }
    });
    child.stdin.end(inputJson);
  });
}

const remoteAccess = createRemoteAccess({
  getApprovedPlugins: async () =>
    (await loadPlugins())
      .filter((plugin) => plugin.remoteAllowed && plugin.runtime === "python")
      .map(({ id, name, description, inputs }) => ({
        id,
        name,
        description,
        inputs,
      })),
  getApprovedFiles: async () => {
    const files = await communityFiles.list();
    const approvedCommunityFiles = files
      .filter((file) => file.remoteAllowed)
      .map(({ id, name, size, kind, entryPath, contents }) => ({
        id,
        name,
        size,
        kind: kind || "file",
        entryPath: entryPath || "",
        contents: contents || [],
      }));
    const approvedPluginSites = [];
    for (const plugin of await loadPlugins()) {
      if (plugin.runtime === "html" && plugin.remoteAllowed) {
        approvedPluginSites.push(await pluginPages.getRemoteSite(plugin.id));
      }
    }
    return [...approvedCommunityFiles, ...approvedPluginSites];
  },
  readLocalFile: (id) => communityFiles.readRemoteFile(id),
  readLocalSiteFile: (id, relativePath) =>
    typeof id === "string" && id.startsWith("plugin-site-")
      ? pluginPages.readRemoteSiteFile(id, relativePath)
      : communityFiles.readRemoteSiteFile(id, relativePath),
  runPlugin: executePlugin,
  openLocalFile: openCommunityFileRemotely,
  logRun: async (entry) => {
    const logPath = path.join(app.getPath("userData"), "remote-audit.jsonl");
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  },
});

const communityFiles = createCommunityFiles({
  userDataPath: app.getPath("userData"),
  selectItems: async () => {
    const choice = await dialog.showMessageBox({
      type: "question",
      title: "Aggiungi contenuti locali",
      message: "Cosa vuoi aggiungere al Plugin manager?",
      detail:
        "Importa file singoli, un'intera cartella o un archivio ZIP/RAR. I siti con index.html e i relativi asset restano insieme anche nell'anteprima mobile.",
      buttons: ["Annulla", "File", "Cartella", "Archivio"],
      defaultId: 3,
      cancelId: 0,
      noLink: true,
    });
    if (choice.response === 0) return [];

    const options = {
      title:
        choice.response === 2
          ? "Seleziona la cartella del sito o del progetto"
          : choice.response === 3
            ? "Seleziona gli archivi ZIP o RAR da estrarre"
            : "Seleziona i file da importare",
      properties:
        choice.response === 2
          ? ["openDirectory"]
          : ["openFile", "multiSelections"],
      ...(choice.response === 3
        ? { filters: [{ name: "Archivi ZIP o RAR", extensions: ["zip", "rar"] }] }
        : {}),
    };
    const owner = BrowserWindow.getFocusedWindow();
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    return result.filePaths.map((filePath) => ({
      kind:
        choice.response === 2
          ? "folder"
          : choice.response === 3 || /\.(zip|rar)$/i.test(filePath)
            ? /\.rar$/i.test(filePath)
              ? "rar"
              : "zip"
            : "file",
      path: filePath,
    }));
  },
  saveFileDialog: async (fileName) => {
    const options = {
      title: "Esporta file per condividerlo",
      defaultPath: fileName,
    };
    const owner = BrowserWindow.getFocusedWindow();
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);
    return result.canceled ? null : result.filePath;
  },
  selectExportDirectory: async (folderName) => {
    const options = {
      title: "Seleziona dove esportare la cartella",
      defaultPath: folderName,
      properties: ["openDirectory", "createDirectory"],
    };
    const owner = BrowserWindow.getFocusedWindow();
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0];
  },
  openPath: (filePath) => shell.openPath(filePath),
});

const communityPlugins = createCommunityPlugins({
  pluginsDirectory: getCommunityPluginDirectory(),
  selectPluginDirectory: async () => {
    const owner = BrowserWindow.getFocusedWindow();
    const options = {
      title: "Seleziona la cartella estratta del plugin GHOSTMAN",
      properties: ["openDirectory"],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0];
  },
  confirmInstall: async (manifest) => {
    const options = {
      type: "warning",
      title: "Installare plugin Python?",
      message: `Vuoi installare "${manifest.name}" v${manifest.version}?`,
      detail:
        "Un plugin Python può leggere o modificare i file e usare le risorse disponibili al tuo account Windows. GHOSTMAN non lo esegue in sandbox. Continua solo se hai controllato il codice e ti fidi dell'autore.",
      buttons: ["Annulla", "Installa plugin"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const owner = BrowserWindow.getAllWindows()[0];
    const result = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    return result.response === 1;
  },
  confirmReplace: async (manifest) => {
    const options = {
      type: "warning",
      title: "Sostituire il plugin installato?",
      message: `Vuoi aggiornare "${manifest.name}" alla versione ${manifest.version}?`,
      detail:
        "Il codice del plugin verrà sostituito. GHOSTMAN esegue i plugin Python con i permessi del tuo account Windows: procedi solo se hai verificato il pacchetto e ti fidi della fonte.",
      buttons: ["Annulla", "Sostituisci plugin"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const owner = BrowserWindow.getAllWindows()[0];
    const result = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    return result.response === 1;
  },
  getReservedPluginIds: async () => {
    let entries;
    try {
      entries = await fs.readdir(getPluginDirectory(), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          pluginIdPattern.test(entry.name),
      )
      .map((entry) => entry.name);
  },
});
const pluginPages = createPluginPages({
  pluginDirectories: [getPluginDirectory(), getCommunityPluginDirectory()],
  openPath: (filePath) => shell.openPath(filePath),
});

async function installCommunityPluginFromLink(rawUrl) {
  let downloaded;
  let importedFileId;
  try {
    const { pluginId, downloadUrl } = parseCommunityInstallUrl(rawUrl);
    downloaded = await downloadCommunityArchive(downloadUrl);
    const archiveKind = path.extname(downloaded.filePath).toLowerCase() === ".rar"
      ? "rar"
      : "zip";
    const imported = await communityFiles.importFiles([
      { kind: archiveKind, path: downloaded.filePath },
    ]);
    if (!imported.length) return;
    importedFileId = imported[0].id;

    let pluginDirectory = await communityFiles.getFolderPath(importedFileId);
    let manifestPath = path.join(pluginDirectory, "manifest.json");
    try {
      await fs.access(manifestPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const entries = await fs.readdir(pluginDirectory, { withFileTypes: true });
      const candidates = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidateManifest = path.join(
          pluginDirectory,
          entry.name,
          "manifest.json",
        );
        try {
          await fs.access(candidateManifest);
          candidates.push(candidateManifest);
        } catch (candidateError) {
          if (candidateError.code !== "ENOENT") throw candidateError;
        }
      }
      if (candidates.length !== 1) {
        throw new Error(
          "L'archivio deve contenere manifest.json nella cartella principale del plugin.",
        );
      }
      manifestPath = candidates[0];
      pluginDirectory = path.dirname(manifestPath);
    }

    const { manifest } = await communityPlugins.inspectPlugin(pluginDirectory);
    if (manifest.id !== pluginId) {
      throw new Error(
        "L'ID del plugin nell'archivio non corrisponde al plugin selezionato sul sito.",
      );
    }

    const installed = await communityPlugins.importPlugin(pluginDirectory);
    if (!installed) return;
    await dialog.showMessageBox({
      type: "info",
      title: "Plugin installato",
      message: `${installed.name} v${installed.version} è stato installato.`,
      detail: "Lo trovi nel Plugin manager di GHOSTMAN.",
      buttons: ["OK"],
      noLink: true,
    });
    const owner = BrowserWindow.getAllWindows()[0];
    if (owner && !owner.isDestroyed()) {
      if (owner.isMinimized()) owner.restore();
      owner.show();
      owner.focus();
    }
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "Installazione plugin non riuscita",
      message: error.message,
      buttons: ["OK"],
      noLink: true,
    });
  } finally {
    if (importedFileId) {
      await communityFiles.removeFile(importedFileId);
    }
    if (downloaded) {
      await fs.rm(downloaded.directory, { recursive: true, force: true });
    }
  }
}

function receiveCommunityInstallLink(rawUrl) {
  if (!rawUrl.startsWith("ghostman://")) return;
  if (!app.isReady()) {
    pendingInstallLinks.push(rawUrl);
    return;
  }
  void installCommunityPluginFromLink(rawUrl);
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  receiveCommunityInstallLink(url);
});
app.on("second-instance", (_event, commandLine) => {
  const installLink = commandLine.find((argument) =>
    argument.startsWith("ghostman://"),
  );
  if (installLink) receiveCommunityInstallLink(installLink);
  const owner = BrowserWindow.getAllWindows()[0];
  if (owner && !owner.isDestroyed()) {
    if (owner.isMinimized()) owner.restore();
    owner.show();
    owner.focus();
  }
});

ipcMain.handle("ghostman:community-files:list", () => communityFiles.list());
ipcMain.handle("ghostman:community-files:import", () =>
  communityFiles.importFiles(),
);
ipcMain.handle(
  "ghostman:community-plugins:install-imported-folder",
  async (_event, id) => {
    const pluginFolder = await communityFiles.getFolderPath(id);
    const result = await communityPlugins.importPlugin(pluginFolder);
    return { plugin: result, plugins: await loadPlugins() };
  },
);
ipcMain.handle("ghostman:community-files:open", (_event, id) =>
  communityFiles.openFile(id),
);
ipcMain.handle("ghostman:community-files:export", (_event, id) =>
  communityFiles.exportFile(id),
);
ipcMain.handle("ghostman:community-files:remove", (_event, id) =>
  communityFiles.removeFile(id),
);
ipcMain.handle(
  "ghostman:community-files:set-remote",
  (_event, { id, allowed }) => communityFiles.setRemoteAllowed(id, allowed),
);
ipcMain.handle("ghostman:community-plugins:import", async () => {
  const result = await communityPlugins.importPlugin();
  return { plugin: result, plugins: await loadPlugins() };
});
async function openCommunityFileRemotely(id) {
  const file = (await communityFiles.list()).find(
    (item) => item.id === id && item.remoteAllowed,
  );
  if (!file) {
    throw new Error("Il file non è autorizzato per l'accesso remoto.");
  }

  let owner = BrowserWindow.getAllWindows()[0];
  if (owner && !owner.isDestroyed()) {
    if (owner.isMinimized()) owner.restore();
    owner.show();
    owner.focus();
    owner.moveTop();
  } else {
    owner = null;
  }

  const options = {
    type: "warning",
    title: "Apertura file richiesta dal telefono",
    message: `Il dispositivo associato chiede di aprire "${file.name}" su questo PC.`,
    detail:
      "Il file verrà aperto con l'app predefinita di Windows. Se è un programma o uno script, potrebbe eseguire codice con i permessi del tuo account. Continua solo se riconosci la richiesta e ti fidi del file.",
    buttons: ["Annulla", "Apri sul PC"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const { response } = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options);
  if (response !== 1) {
    return { opened: false, cancelled: true };
  }

  await communityFiles.openFile(id);
  return { opened: true };
}

ipcMain.handle("ghostman:run-plugin", (_event, request) => executePlugin(request));
ipcMain.handle("ghostman:get-remote-status", () => remoteAccess.getStatus());
ipcMain.handle("ghostman:start-remote-access", () => remoteAccess.start());
ipcMain.handle("ghostman:stop-remote-access", () => remoteAccess.stop());

ipcMain.handle("ghostman:run-tool", async (_event, request) => {
  if (!request || typeof request.id !== "string") {
    throw new Error("Richiesta non valida.");
  }

  const input = request.input || {};

  switch (request.id) {
    case "discord-snowflake": {
      const snowflake = String(input.snowflake || "").trim();

      if (!/^\d{17,20}$/.test(snowflake)) {
        throw new Error("Inserisci un Discord ID numerico valido.");
      }

      const timestamp = Number((BigInt(snowflake) >> 22n) + 1420070400000n);

      const date = new Date(timestamp);

      if (!Number.isFinite(date.getTime())) {
        throw new Error("Timestamp non valido.");
      }

      return {
        title: "Discord Snowflake",
        data: {
          id: snowflake,
          createdAt: date.toISOString(),
          note: "La data è derivata dall'ID; non identifica il proprietario.",
        },
      };
    }

    case "osint-domain": {
      const domain = String(input.domain || "")
        .trim()
        .toLowerCase()
        .replace(/\.$/, "");

      if (
        domain.length > 253 ||
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
          domain,
        )
      ) {
        throw new Error("Inserisci un dominio valido, ad esempio example.com.");
      }

      const response = await fetch(
        "https://dns.google/resolve?name=" +
          encodeURIComponent(domain) +
          "&type=A",
        {
          headers: { Accept: "application/dns-json" },
          signal: AbortSignal.timeout(8000),
        },
      );

      if (!response.ok) {
        throw new Error("Il servizio DNS non è disponibile.");
      }

      const dns = await response.json();

      return {
        title: "Risultati DNS pubblici",
        data: {
          domain,
          status: dns.Status,
          addresses: (dns.Answer || [])
            .filter((record) => record.type === 1)
            .map((record) => record.data),
          source: "Google Public DNS",
          note: "Risultati pubblici DNS; non sono una scansione di sicurezza.",
        },
      };
    }

    case "network-url": {
      const rawUrl = String(input.url || "").trim();

      let parsed;

      try {
        parsed = new URL(rawUrl);
      } catch {
        throw new Error(
          "Inserisci un URL completo, ad esempio https://example.com.",
        );
      }

      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Sono consentiti soltanto URL HTTP e HTTPS.");
      }

      return {
        title: "Analisi struttura URL",
        data: {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || "(predefinita)",
          pathname: parsed.pathname,
          hasQuery: Boolean(parsed.search),
          hasFragment: Boolean(parsed.hash),
          note: "Analisi locale della struttura. Nessuna connessione al sito.",
        },
      };
    }

    default:
      throw new Error("Tool non riconosciuto o non autorizzato.");
  }
});

ipcMain.handle("ghostman:open-external", async (_event, rawUrl) => {
  if (typeof rawUrl !== "string") {
    throw new Error("URL non valido.");
  }

  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("URL non valido.");
  }

  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("Protocollo non consentito.");
  }

  await shell.openExternal(url.href);
  return true;
});

app.whenReady().then(() => {
  if (isDev) {
    app.setAsDefaultProtocolClient("ghostman", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient("ghostman");
  }
  createWindow();
  initializeAutoUpdates();
  for (const installLink of pendingInstallLinks) {
    receiveCommunityInstallLink(installLink);
  }
  pendingInstallLinks = [];

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let isCompletingQuit = false;
app.on("before-quit", (event) => {
  if (isCompletingQuit) return;
  event.preventDefault();
  isCompletingQuit = true;
  remoteAccess
    .stop()
    .catch((error) => {
      console.error("Impossibile arrestare completamente GHOSTMAN Remote:", error);
    })
    .finally(() => app.quit());
});
