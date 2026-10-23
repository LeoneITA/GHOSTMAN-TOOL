const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const pluginIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const maxPluginFiles = 2000;
const maxPluginBytes = 100 * 1024 * 1024;

function createCommunityPlugins({
  pluginsDirectory,
  selectPluginDirectory,
  confirmInstall = async () => false,
  confirmReplace = async () => false,
  getReservedPluginIds = async () => [],
}) {
  async function inspectPlugin(sourceDirectory) {
    const rootStat = await fs.lstat(sourceDirectory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Seleziona una cartella plugin normale, non un collegamento.");
    }

    const manifestPath = path.join(sourceDirectory, "manifest.json");
    let manifest;
    try {
      const manifestContents = await fs.readFile(manifestPath, "utf8");
      if (Buffer.byteLength(manifestContents, "utf8") > 64 * 1024) {
        throw new Error("Il manifest del plugin supera il limite di 64 KiB.");
      }
      manifest = JSON.parse(manifestContents);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("Il manifest del plugin non contiene JSON valido.");
      }
      if (error.code === "ENOENT") {
        throw new Error("Nella cartella selezionata manca manifest.json.");
      }
      throw error;
    }

    if (
      !manifest ||
      typeof manifest !== "object" ||
      Array.isArray(manifest) ||
      typeof manifest.id !== "string" ||
      !pluginIdPattern.test(manifest.id) ||
      typeof manifest.name !== "string" ||
      !manifest.name.trim() ||
      manifest.name.length > 100 ||
      typeof manifest.version !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
      typeof manifest.description !== "string" ||
      manifest.description.length > 1000 ||
      manifest.runtime !== "python" ||
      typeof manifest.entry !== "string" ||
      !/^[^\\/]+\.py$/i.test(manifest.entry)
    ) {
      throw new Error(
        "Plugin non valido. Sono supportati solo plugin Python con manifest e file entry validi.",
      );
    }

    const inputNames = new Set();
    if (
      manifest.inputs !== undefined &&
      (!Array.isArray(manifest.inputs) ||
        manifest.inputs.length > 20 ||
        manifest.inputs.some(
          (input) =>
            !input ||
            typeof input.name !== "string" ||
            !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(input.name) ||
            typeof input.label !== "string" ||
            !["text", "number", "url"].includes(input.type) ||
            typeof input.required !== "boolean" ||
            inputNames.has(input.name) ||
            !inputNames.add(input.name),
        ))
    ) {
      throw new Error("I campi input dichiarati nel manifest non sono validi.");
    }

    const entryPath = path.join(sourceDirectory, manifest.entry);
    const entryStat = await fs.lstat(entryPath);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      throw new Error("Il file Python indicato da entry non è presente.");
    }

    let fileCount = 0;
    let totalBytes = 0;
    async function inspectDirectory(directory) {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryStat = await fs.lstat(path.join(directory, entry.name));
        if (entryStat.isSymbolicLink()) {
          throw new Error("Il pacchetto plugin contiene un collegamento non consentito.");
        }
        if (entryStat.isDirectory()) {
          await inspectDirectory(path.join(directory, entry.name));
        } else if (entryStat.isFile()) {
          fileCount += 1;
          totalBytes += entryStat.size;
          if (fileCount > maxPluginFiles || totalBytes > maxPluginBytes) {
            throw new Error(
              "Il plugin supera il limite di 2.000 file o 100 MiB.",
            );
          }
        } else {
          throw new Error("Il pacchetto contiene un tipo di file non supportato.");
        }
      }
    }
    await inspectDirectory(sourceDirectory);

    return { manifest, fileCount, totalBytes };
  }

  async function copyPlugin(sourceDirectory, destinationDirectory) {
    async function copyDirectory(source, destination) {
      await fs.mkdir(destination);
      const entries = await fs.readdir(source, { withFileTypes: true });
      for (const entry of entries) {
        const sourcePath = path.join(source, entry.name);
        const destinationPath = path.join(destination, entry.name);
        const stat = await fs.lstat(sourcePath);
        if (stat.isSymbolicLink()) {
          throw new Error("Il pacchetto plugin contiene un collegamento non consentito.");
        }
        if (stat.isDirectory()) {
          await copyDirectory(sourcePath, destinationPath);
        } else if (stat.isFile()) {
          await fs.copyFile(sourcePath, destinationPath);
        } else {
          throw new Error("Il pacchetto contiene un tipo di file non supportato.");
        }
      }
    }
    await copyDirectory(sourceDirectory, destinationDirectory);
  }

  async function importPlugin(sourceDirectory) {
    const selectedDirectory = sourceDirectory || (await selectPluginDirectory());
    if (!selectedDirectory) return null;

    const { manifest, fileCount, totalBytes } = await inspectPlugin(
      selectedDirectory,
    );
    if ((await getReservedPluginIds()).includes(manifest.id)) {
      throw new Error(
        "Questo ID è già usato da un plugin incluso in GHOSTMAN. Modifica l'ID nel manifest.",
      );
    }
    if (!(await confirmInstall(manifest))) return null;

    await fs.mkdir(pluginsDirectory, { recursive: true });
    const destination = path.join(pluginsDirectory, manifest.id);
    let destinationExists = false;
    try {
      const stat = await fs.lstat(destination);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("La destinazione del plugin non è una cartella valida.");
      }
      destinationExists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (destinationExists && !(await confirmReplace(manifest))) return null;

    const stagingDirectory = path.join(
      pluginsDirectory,
      `.${manifest.id}.${randomUUID()}.tmp`,
    );
    const backupDirectory = path.join(
      pluginsDirectory,
      `.${manifest.id}.${randomUUID()}.bak`,
    );
    let backedUp = false;
    try {
      await copyPlugin(selectedDirectory, stagingDirectory);
      if (destinationExists) {
        await fs.rename(destination, backupDirectory);
        backedUp = true;
      }
      await fs.rename(stagingDirectory, destination);
      if (backedUp) {
        await fs.rm(backupDirectory, { recursive: true, force: false });
      }
    } catch (error) {
      await fs.rm(stagingDirectory, { recursive: true, force: true });
      if (backedUp) {
        await fs.rm(destination, { recursive: true, force: true });
        await fs.rename(backupDirectory, destination);
      }
      throw error;
    }

    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      fileCount,
      size: totalBytes,
    };
  }

  return { importPlugin, inspectPlugin };
}

module.exports = { createCommunityPlugins };
