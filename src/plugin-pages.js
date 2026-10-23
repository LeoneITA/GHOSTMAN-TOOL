const fs = require("node:fs/promises");
const path = require("node:path");

const pluginIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const htmlEntryPattern = /^[^\\/]+\.html?$/i;
const remoteSiteIdPrefix = "plugin-site-";
const maxRemoteSiteFiles = 2000;
const maxRemoteSiteBytes = 100 * 1024 * 1024;

function createPluginPages({ pluginDirectories, openPath }) {
  async function findHtmlPlugin(id) {
    if (typeof id !== "string" || !pluginIdPattern.test(id)) {
      throw new Error("Identificativo plugin non valido.");
    }

    for (const directory of pluginDirectories) {
      const pluginDirectory = path.join(directory, id);
      let directoryStat;
      try {
        directoryStat = await fs.lstat(pluginDirectory);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        continue;
      }

      let manifest;
      try {
        const contents = await fs.readFile(
          path.join(pluginDirectory, "manifest.json"),
          "utf8",
        );
        if (Buffer.byteLength(contents, "utf8") > 64 * 1024) {
          throw new Error("Il manifest del plugin supera il limite di 64 KiB.");
        }
        manifest = JSON.parse(contents);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        if (error instanceof SyntaxError) {
          throw new Error("Il manifest del plugin non contiene JSON valido.");
        }
        throw error;
      }

      if (
        !manifest ||
        manifest.id !== id ||
        manifest.runtime !== "html" ||
        typeof manifest.entry !== "string" ||
        !htmlEntryPattern.test(manifest.entry)
      ) {
        throw new Error("Il plugin non contiene una pagina HTML apribile.");
      }

      return { pluginDirectory, manifest };
    }

    throw new Error("Plugin HTML non trovato.");
  }

  async function openPage(id) {
    const { pluginDirectory, manifest } = await findHtmlPlugin(id);
    const entryPath = path.join(pluginDirectory, manifest.entry);
    const entryStat = await fs.lstat(entryPath);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      throw new Error("La pagina HTML del plugin non è disponibile.");
    }

    const error = await openPath(entryPath);
    if (error) throw new Error(`Impossibile aprire il sito: ${error}`);
    return true;
  }

  async function getRemoteSite(id) {
    const { pluginDirectory, manifest } = await findHtmlPlugin(id);
    let fileCount = 0;
    let totalBytes = 0;
    const contents = [];

    async function collectFiles(directory, relativeDirectory = "") {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        const filePath = path.join(directory, entry.name);
        const stat = await fs.lstat(filePath);
        if (stat.isSymbolicLink()) {
          throw new Error("Il sito del plugin contiene un collegamento non consentito.");
        }
        if (stat.isDirectory()) {
          await collectFiles(filePath, relativePath);
          continue;
        }
        if (!stat.isFile()) {
          throw new Error("Il sito del plugin contiene un tipo di file non supportato.");
        }
        fileCount += 1;
        totalBytes += stat.size;
        if (fileCount > maxRemoteSiteFiles || totalBytes > maxRemoteSiteBytes) {
          throw new Error("Il sito del plugin supera il limite di 2.000 file o 100 MiB.");
        }
        contents.push({ path: relativePath, size: stat.size });
      }
    }

    await collectFiles(pluginDirectory);
    const entryStat = await fs.lstat(path.join(pluginDirectory, manifest.entry));
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      throw new Error("La pagina HTML del plugin non è disponibile.");
    }

    return {
      id: `${remoteSiteIdPrefix}${id}`,
      name: manifest.name,
      size: totalBytes,
      kind: "folder",
      entryPath: manifest.entry,
      contents,
    };
  }

  async function readRemoteSiteFile(remoteId, relativePath) {
    if (
      typeof remoteId !== "string" ||
      !remoteId.startsWith(remoteSiteIdPrefix)
    ) {
      throw new Error("Identificativo sito plugin non valido.");
    }
    const id = remoteId.slice(remoteSiteIdPrefix.length);
    const { pluginDirectory } = await findHtmlPlugin(id);
    if (
      typeof relativePath !== "string" ||
      !relativePath ||
      relativePath.includes("\\") ||
      relativePath
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    ) {
      throw Object.assign(new Error("Percorso del sito non valido."), {
        statusCode: 400,
      });
    }

    const segments = relativePath.split("/");
    let filePath = pluginDirectory;
    for (const [index, part] of segments.entries()) {
      filePath = path.join(filePath, part);
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink()) {
        throw new Error("Il sito del plugin contiene un collegamento non consentito.");
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new Error("Percorso del sito non valido.");
      }
    }

    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) {
      throw Object.assign(new Error("Risorsa del sito non trovata."), {
        statusCode: 404,
      });
    }
    return {
      file: { name: path.basename(filePath), size: stat.size },
      contents: await fs.readFile(filePath),
    };
  }

  return { openPage, getRemoteSite, readRemoteSiteFile };
}

module.exports = { createPluginPages };
