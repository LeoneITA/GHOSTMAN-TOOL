const { randomUUID } = require("node:crypto");
const { createWriteStream } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const yauzl = require("yauzl");
const { createExtractorFromData } = require("node-unrar-js");

const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxRemoteFileBytes = 25 * 1024 * 1024;
const maxFolderFiles = 2000;
const maxFolderBytes = 100 * 1024 * 1024;

function createCommunityFiles({
  userDataPath,
  selectItems,
  saveFileDialog,
  selectExportDirectory,
  openPath,
}) {
  const filesDirectory = path.join(userDataPath, "community-files");
  const indexPath = path.join(filesDirectory, "index.json");

  async function readIndex() {
    let contents;
    try {
      contents = await fs.readFile(indexPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }

    const records = JSON.parse(contents);
    if (
      !Array.isArray(records) ||
      records.some(
        (record) =>
          !record ||
          typeof record.id !== "string" ||
          !idPattern.test(record.id) ||
          typeof record.name !== "string" ||
          path.basename(record.name) !== record.name ||
          typeof record.size !== "number" ||
          !Number.isFinite(record.size) ||
          typeof record.importedAt !== "string" ||
          (record.kind !== undefined &&
            !["file", "folder"].includes(record.kind)) ||
          (record.entryPath !== undefined &&
            (typeof record.entryPath !== "string" ||
              (record.entryPath !== "" &&
                (record.entryPath.includes("\\") ||
                  record.entryPath
                    .split("/")
                    .some(
                      (part) =>
                        !part || part === "." || part === "..",
                    ))))) ||
          (record.remoteAllowed !== undefined &&
            typeof record.remoteAllowed !== "boolean"),
      )
    ) {
      throw new Error("L'indice dei file community è danneggiato.");
    }
    return records.map((record) => ({
      ...record,
      remoteAllowed: record.remoteAllowed === true,
    }));
  }

  async function writeIndex(records) {
    await fs.mkdir(filesDirectory, { recursive: true });
    const temporaryPath = `${indexPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(records, null, 2), "utf8");
    await fs.rename(temporaryPath, indexPath);
  }

  function findRecord(records, id) {
    if (typeof id !== "string" || !idPattern.test(id)) {
      throw new Error("Identificativo file non valido.");
    }
    const record = records.find((item) => item.id === id);
    if (!record) throw new Error("File importato non trovato.");
    return record;
  }

  function getStoredPath(record) {
    const filePath = path.join(filesDirectory, record.id, record.name);
    const relativePath = path.relative(filesDirectory, filePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error("Percorso del file importato non valido.");
    }
    return filePath;
  }

  async function copyFolderContents(sourceDirectory, destinationDirectory) {
    let fileCount = 0;
    let totalBytes = 0;

    async function copyDirectory(source, destination) {
      const entries = await fs.readdir(source, { withFileTypes: true });

      for (const entry of entries) {
        const sourcePath = path.join(source, entry.name);
        const destinationPath = path.join(destination, entry.name);
        const stat = await fs.lstat(sourcePath);
        if (stat.isSymbolicLink()) {
          throw new Error(
            `La cartella contiene un collegamento non supportato: ${entry.name}`,
          );
        }
        if (stat.isDirectory()) {
          await fs.mkdir(destinationPath);
          await copyDirectory(sourcePath, destinationPath);
          continue;
        }
        if (!stat.isFile()) {
          throw new Error(`Tipo di file non supportato nella cartella: ${entry.name}`);
        }

        fileCount += 1;
        totalBytes += stat.size;
        if (fileCount > maxFolderFiles || totalBytes > maxFolderBytes) {
          throw new Error(
            "La cartella supera il limite di 2.000 file o 100 MiB.",
          );
        }
        await fs.copyFile(sourcePath, destinationPath);
      }
    }

    let destinationCreated = false;
    try {
      await fs.mkdir(destinationDirectory);
      destinationCreated = true;
      await copyDirectory(sourceDirectory, destinationDirectory);
      return { fileCount, totalBytes };
    } catch (error) {
      if (destinationCreated) {
        await fs.rm(destinationDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async function findSiteEntry(rootDirectory) {
    for (const name of ["index.html", "index.htm"]) {
      const entryPath = path.join(rootDirectory, name);
      try {
        const stat = await fs.lstat(entryPath);
        if (stat.isFile() && !stat.isSymbolicLink()) return name;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }

    const entries = await fs.readdir(rootDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const nestedEntry = await findSiteEntry(
        path.join(rootDirectory, entry.name),
      );
      if (nestedEntry) return `${entry.name}/${nestedEntry}`;
    }
    return "";
  }

  async function extractZip(sourcePath, destinationDirectory) {
    return new Promise((resolve, reject) => {
      yauzl.open(
        sourcePath,
        { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
        (openError, zipFile) => {
          if (openError) {
            reject(new Error(`Impossibile leggere il file ZIP: ${openError.message}`));
            return;
          }

          let settled = false;
          let entryCount = 0;
          let fileCount = 0;
          let totalBytes = 0;
          const archivePaths = new Map();

          const fail = (error) => {
            if (settled) return;
            settled = true;
            zipFile.close();
            reject(error);
          };

          zipFile.on("error", fail);
          zipFile.on("end", () => {
            if (settled) return;
            settled = true;
            if (fileCount === 0) {
              reject(new Error("Il file ZIP non contiene file da importare."));
              return;
            }
            resolve({ fileCount, totalBytes });
          });
          zipFile.on("entry", (entry) => {
            if (settled) return;
            void (async () => {
              entryCount += 1;
              if (entryCount > maxFolderFiles * 2) {
                throw new Error("Il ZIP contiene troppi elementi.");
              }
              if (
                !Number.isSafeInteger(entry.uncompressedSize) ||
                entry.uncompressedSize < 0 ||
                (entry.generalPurposeBitFlag & 1) !== 0 ||
                ![0, 8].includes(entry.compressionMethod)
              ) {
                throw new Error(
                  "Il ZIP è cifrato o usa un formato di compressione non supportato.",
                );
              }

              const isDirectory = entry.fileName.endsWith("/");
              const entryName = isDirectory
                ? entry.fileName.slice(0, -1)
                : entry.fileName;
              const segments = entryName.split("/");
              if (
                !entryName ||
                entryName.startsWith("/") ||
                entryName.includes("\\") ||
                segments.some(
                  (segment) =>
                    !segment ||
                    segment === "." ||
                    segment === ".." ||
                    /[<>:"|?*\u0000-\u001f]/.test(segment) ||
                    /[. ]$/.test(segment) ||
                    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(
                      segment,
                    ),
                )
              ) {
                throw new Error("Il ZIP contiene un percorso non sicuro.");
              }

              const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
              const fileType = unixMode & 0o170000;
              if (fileType && ![0o040000, 0o100000].includes(fileType)) {
                throw new Error(
                  "Il ZIP contiene collegamenti o tipi di file non supportati.",
                );
              }
              if (entryName.includes("\0")) {
                throw new Error("Il ZIP contiene un nome di file non valido.");
              }

              const normalizedName = segments.join("/");
              const key = normalizedName.toLocaleLowerCase("en-US");
              if (archivePaths.has(key)) {
                throw new Error("Il ZIP contiene percorsi duplicati.");
              }
              if (
                !isDirectory &&
                [...archivePaths.keys()].some((existingPath) =>
                  existingPath.startsWith(`${key}/`),
                )
              ) {
                throw new Error("Il ZIP contiene percorsi in conflitto.");
              }
              for (let index = 1; index < segments.length; index += 1) {
                const parentKey = segments
                  .slice(0, index)
                  .join("/")
                  .toLocaleLowerCase("en-US");
                if (archivePaths.get(parentKey) === "file") {
                  throw new Error("Il ZIP contiene percorsi in conflitto.");
                }
              }

              const targetPath = path.resolve(
                destinationDirectory,
                ...segments,
              );
              const relativePath = path.relative(
                destinationDirectory,
                targetPath,
              );
              if (
                relativePath.startsWith("..") ||
                path.isAbsolute(relativePath)
              ) {
                throw new Error("Il ZIP contiene un percorso fuori dalla cartella.");
              }
              archivePaths.set(key, isDirectory ? "directory" : "file");

              if (isDirectory) {
                if (entry.uncompressedSize !== 0) {
                  throw new Error("Il ZIP contiene una directory non valida.");
                }
                await fs.mkdir(targetPath, { recursive: true });
                return;
              }

              fileCount += 1;
              totalBytes += entry.uncompressedSize;
              if (fileCount > maxFolderFiles || totalBytes > maxFolderBytes) {
                throw new Error("Il ZIP supera il limite di 2.000 file o 100 MiB.");
              }
              await fs.mkdir(path.dirname(targetPath), { recursive: true });
              await new Promise((streamResolve, streamReject) => {
                zipFile.openReadStream(entry, (streamError, readStream) => {
                  if (streamError) {
                    streamReject(streamError);
                    return;
                  }
                  pipeline(
                    readStream,
                    createWriteStream(targetPath, { flags: "wx" }),
                  ).then(streamResolve, streamReject);
                });
              });
            })()
              .then(() => {
                if (!settled) zipFile.readEntry();
              })
              .catch(fail);
          });
          zipFile.readEntry();
        },
      );
    });
  }

  async function extractRar(sourcePath, destinationDirectory) {
    const archiveStat = await fs.lstat(sourcePath);
    if (
      !archiveStat.isFile() ||
      archiveStat.isSymbolicLink() ||
      archiveStat.size > maxFolderBytes
    ) {
      throw new Error("Il RAR supera il limite di 100 MiB o non è un file valido.");
    }

    let extractor;
    try {
      extractor = await createExtractorFromData({
        data: new Uint8Array(await fs.readFile(sourcePath)),
      });
    } catch (error) {
      throw new Error(`Impossibile leggere il file RAR: ${error.message}`);
    }

    let archiveList;
    try {
      archiveList = extractor.getFileList();
    } catch (error) {
      throw new Error(`Impossibile leggere il file RAR: ${error.message}`);
    }
    const { arcHeader, fileHeaders } = archiveList;
    if (arcHeader.flags.volume || arcHeader.flags.headerEncrypted) {
      throw new Error("I RAR multi-volume o protetti da password non sono supportati.");
    }

    const headers = [...fileHeaders];
    if (!headers.length || headers.length > maxFolderFiles * 2) {
      throw new Error("Il RAR è vuoto o contiene troppi elementi.");
    }

    const paths = new Map();
    let fileCount = 0;
    let totalBytes = 0;
    const entries = headers.map((header) => {
      const normalizedName = header.name.replace(/\\/g, "/");
      const isDirectory = header.flags.directory;
      const entryName = isDirectory
        ? normalizedName.replace(/\/+$/, "")
        : normalizedName;
      const segments = entryName.split("/");
      if (
        !entryName ||
        normalizedName.startsWith("/") ||
        /^[a-z]:/i.test(normalizedName) ||
        segments.some(
          (segment) =>
            !segment ||
            segment === "." ||
            segment === ".." ||
            /[<>:"|?*\u0000-\u001f]/.test(segment) ||
            /[. ]$/.test(segment) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment),
        )
      ) {
        throw new Error("Il RAR contiene un percorso non sicuro.");
      }
      if (!isDirectory && header.flags.encrypted) {
        throw new Error("I file RAR protetti da password non sono supportati.");
      }

      const key = segments.join("/").toLocaleLowerCase("en-US");
      if (
        paths.has(key) ||
        (!isDirectory &&
          [...paths.keys()].some((existingPath) =>
            existingPath.startsWith(`${key}/`),
          ))
      ) {
        throw new Error("Il RAR contiene percorsi duplicati o in conflitto.");
      }
      paths.set(key, isDirectory ? "directory" : "file");
      for (let index = 1; index < segments.length; index += 1) {
        const parent = segments
          .slice(0, index)
          .join("/")
          .toLocaleLowerCase("en-US");
        if (paths.get(parent) === "file") {
          throw new Error("Il RAR contiene percorsi in conflitto.");
        }
      }
      if (!isDirectory) {
        if (!Number.isSafeInteger(header.unpSize) || header.unpSize < 0) {
          throw new Error("Il RAR contiene una dimensione file non valida.");
        }
        fileCount += 1;
        totalBytes += header.unpSize;
        if (fileCount > maxFolderFiles || totalBytes > maxFolderBytes) {
          throw new Error("Il RAR supera il limite di 2.000 file o 100 MiB.");
        }
      }
      return { header, segments, isDirectory };
    });

    if (fileCount === 0) {
      throw new Error("Il file RAR non contiene file da importare.");
    }

    let extracted;
    try {
      extracted = extractor.extract({
        files: entries
          .filter((entry) => !entry.isDirectory)
          .map((entry) => entry.header.name),
      });
    } catch (error) {
      throw new Error(`Impossibile estrarre il RAR: ${error.message}`);
    }

    let extractedFiles;
    try {
      extractedFiles = [...extracted.files];
    } catch (error) {
      throw new Error(`Impossibile estrarre il RAR: ${error.message}`);
    }
    if (extractedFiles.length !== fileCount) {
      throw new Error("Il RAR non è stato estratto completamente.");
    }
    const extractedByName = new Map(
      extractedFiles.map((file) => [file.fileHeader.name, file]),
    );
    for (const entry of entries) {
      const targetPath = path.resolve(destinationDirectory, ...entry.segments);
      const relativePath = path.relative(destinationDirectory, targetPath);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error("Il RAR contiene un percorso fuori dalla cartella.");
      }
      if (entry.isDirectory) {
        await fs.mkdir(targetPath, { recursive: true });
        continue;
      }
      const extractedFile = extractedByName.get(entry.header.name);
      if (!extractedFile || !(extractedFile.extraction instanceof Uint8Array)) {
        throw new Error(`Impossibile estrarre il file RAR: ${entry.header.name}`);
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, extractedFile.extraction, { flag: "wx" });
    }
    return { fileCount, totalBytes };
  }

  async function getFolderContents(rootDirectory) {
    const contents = [];
    async function visit(directory) {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        const stat = await fs.lstat(entryPath);
        if (stat.isSymbolicLink()) {
          throw new Error("La cartella importata contiene un collegamento non valido.");
        }
        if (stat.isDirectory()) {
          await visit(entryPath);
        } else if (stat.isFile()) {
          contents.push({
            path: path.relative(rootDirectory, entryPath).split(path.sep).join("/"),
            size: stat.size,
          });
          if (contents.length > maxFolderFiles) {
            throw new Error("La cartella supera il limite di 2.000 file.");
          }
        } else {
          throw new Error("La cartella contiene un tipo di file non supportato.");
        }
      }
    }
    await visit(rootDirectory);
    return contents;
  }

  async function list() {
    const records = await readIndex();
    return Promise.all(
      records.map(async (record) => {
        if ((record.kind || "file") !== "folder") return record;
        return {
          ...record,
          contents: await getFolderContents(getStoredPath(record)),
        };
      }),
    );
  }

  async function getFolderPath(id) {
    const record = findRecord(await readIndex(), id);
    if ((record.kind || "file") !== "folder") {
      throw new Error("Seleziona una cartella importata.");
    }

    const directory = getStoredPath(record);
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("La cartella importata non è disponibile.");
    }
    return directory;
  }

  async function importFiles(selectedItems) {
    const items = selectedItems || (await selectItems());
    if (!items.length) return [];

    const records = await readIndex();
    const imported = [];
    const createdDirectories = [];

    try {
      for (const item of items) {
        const sourcePath = item.path;
        const sourceStat = await fs.lstat(sourcePath);
        const archiveType =
          item.kind === "zip" || /\.zip$/i.test(sourcePath)
            ? "zip"
            : item.kind === "rar" || /\.rar$/i.test(sourcePath)
              ? "rar"
              : "";
        const isArchive = Boolean(archiveType);
        const name = isArchive
          ? path.basename(sourcePath, path.extname(sourcePath))
          : path.basename(sourcePath);
        if (!name || name === "." || name === "..") {
          throw new Error("Nome file non valido.");
        }

        const kind =
          item.kind === "folder" && sourceStat.isDirectory()
            ? "folder"
            : isArchive && sourceStat.isFile()
              ? "folder"
              : item.kind === "file" && sourceStat.isFile()
              ? "file"
              : null;
        if (!kind || sourceStat.isSymbolicLink()) {
          throw new Error("Seleziona file o cartelle normali, non collegamenti.");
        }

        const record = {
          id: randomUUID(),
          name,
          size: 0,
          importedAt: new Date().toISOString(),
          kind,
          remoteAllowed: false,
        };
        const itemDirectory = path.join(filesDirectory, record.id);
        await fs.mkdir(itemDirectory, { recursive: true });
        createdDirectories.push(itemDirectory);
        const destinationPath = path.join(itemDirectory, name);

        if (kind === "folder") {
          const { totalBytes } = isArchive
            ? archiveType === "zip"
              ? await extractZip(sourcePath, destinationPath)
              : await extractRar(sourcePath, destinationPath)
            : await copyFolderContents(sourcePath, destinationPath);
          record.size = totalBytes;
          record.entryPath = await findSiteEntry(destinationPath);
        } else {
          await fs.copyFile(sourcePath, destinationPath);
          record.size = sourceStat.size;
        }
        imported.push(record);
      }

      await writeIndex([...records, ...imported]);
      return imported;
    } catch (error) {
      await Promise.all(
        createdDirectories.map((directory) =>
          fs.rm(directory, { recursive: true, force: true }),
        ),
      );
      throw error;
    }
  }

  async function openFile(id) {
    const record = findRecord(await readIndex(), id);
    let filePath = getStoredPath(record);
    if ((record.kind || "file") === "folder") {
      const entryPath = await findSiteEntry(filePath);
      if (!entryPath) {
        throw new Error("La cartella non contiene index.html o index.htm.");
      }
      filePath = path.join(filePath, entryPath);
    }
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Il file importato non è disponibile.");
    }

    const error = await openPath(filePath);
    if (error) throw new Error(`Impossibile aprire il file: ${error}`);
  }

  async function exportFile(id) {
    const record = findRecord(await readIndex(), id);
    if ((record.kind || "file") === "folder") {
      if (!selectExportDirectory) {
        throw new Error("Esportazione delle cartelle non disponibile.");
      }
      const destinationRoot = await selectExportDirectory(record.name);
      if (!destinationRoot) return false;
      const destination = path.join(destinationRoot, record.name);
      try {
        await copyFolderContents(getStoredPath(record), destination);
        return true;
      } catch (error) {
        if (error.code === "EEXIST") {
          throw new Error("Esiste già una cartella con questo nome.");
        }
        throw error;
      }
    }

    const destination = await saveFileDialog(record.name);
    if (!destination) return false;

    const filePath = getStoredPath(record);
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Il file importato non è disponibile.");
    }
    await fs.copyFile(filePath, destination);
    return true;
  }

  async function removeFile(id) {
    const records = await readIndex();
    const record = findRecord(records, id);
    await writeIndex(records.filter((item) => item.id !== id));
    await fs.rm(path.join(filesDirectory, record.id), {
      recursive: true,
      force: false,
    });
  }

  async function setRemoteAllowed(id, allowed) {
    if (typeof allowed !== "boolean") {
      throw new Error("Permesso remoto non valido.");
    }
    const records = await readIndex();
    const record = findRecord(records, id);
    if (
      allowed &&
      (record.kind || "file") === "folder" &&
      !record.entryPath
    ) {
      throw new Error(
        "Per l'accesso remoto la cartella deve contenere index.html o index.htm.",
      );
    }
    const updated = records.map((item) =>
      item.id === id ? { ...item, remoteAllowed: allowed } : item,
    );
    await writeIndex(updated);
    return { ...record, remoteAllowed: allowed };
  }

  async function readRemoteFile(id) {
    const record = findRecord(await readIndex(), id);
    if (!record.remoteAllowed) {
      throw Object.assign(
        new Error("Il file non è abilitato per l'accesso remoto."),
        { statusCode: 403 },
      );
    }
    if ((record.kind || "file") === "folder") {
      throw new Error("Usa la lettura dei file del sito per una cartella.");
    }

    const filePath = getStoredPath(record);
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Il file importato non è disponibile.");
    }
    if (stat.size > maxRemoteFileBytes) {
      throw Object.assign(
        new Error("Il file supera il limite di 25 MiB per l'accesso mobile."),
        { statusCode: 413 },
      );
    }

    return { file: record, contents: await fs.readFile(filePath) };
  }

  async function readRemoteSiteFile(id, relativePath) {
    const record = findRecord(await readIndex(), id);
    if (
      !record.remoteAllowed ||
      (record.kind || "file") !== "folder" ||
      !record.entryPath
    ) {
      throw Object.assign(
        new Error("La cartella non è abilitata o non contiene un sito HTML."),
        { statusCode: 403 },
      );
    }
    if (
      typeof relativePath !== "string" ||
      relativePath.includes("\\") ||
      relativePath.includes("\0")
    ) {
      throw Object.assign(new Error("Percorso del sito non valido."), {
        statusCode: 400,
      });
    }

    const segments = relativePath.split("/");
    if (
      !segments.length ||
      segments.some((part) => !part || part === "." || part === "..")
    ) {
      throw Object.assign(new Error("Percorso del sito non valido."), {
        statusCode: 400,
      });
    }

    const rootDirectory = getStoredPath(record);
    let rootStat;
    try {
      rootStat = await fs.lstat(rootDirectory);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        throw Object.assign(new Error("Cartella del sito non disponibile."), {
          statusCode: 404,
        });
      }
      throw error;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw Object.assign(new Error("Cartella del sito non disponibile."), {
        statusCode: 404,
      });
    }
    let currentPath = rootDirectory;
    for (const segment of segments) {
      currentPath = path.join(currentPath, segment);
      let stat;
      try {
        stat = await fs.lstat(currentPath);
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") {
          throw Object.assign(new Error("Risorsa del sito non trovata."), {
            statusCode: 404,
          });
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw Object.assign(new Error("Collegamento non consentito nel sito."), {
          statusCode: 403,
        });
      }
      if (currentPath !== path.join(rootDirectory, ...segments) && !stat.isDirectory()) {
        throw Object.assign(new Error("Percorso del sito non valido."), {
          statusCode: 400,
        });
      }
    }

    const stat = await fs.lstat(currentPath);
    if (!stat.isFile()) {
      throw Object.assign(new Error("Risorsa del sito non trovata."), {
        statusCode: 404,
      });
    }
    if (stat.size > maxRemoteFileBytes) {
      throw Object.assign(
        new Error("La risorsa supera il limite mobile di 25 MiB."),
        { statusCode: 413 },
      );
    }

    const expectedRoot = path.resolve(rootDirectory);
    const resolvedPath = path.resolve(currentPath);
    const relativeToRoot = path.relative(expectedRoot, resolvedPath);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw Object.assign(new Error("Percorso fuori dalla cartella del sito."), {
        statusCode: 403,
      });
    }
    return {
      file: { ...record, name: segments[segments.length - 1] },
      contents: await fs.readFile(currentPath),
    };
  }

  return {
    list,
    getFolderPath,
    importFiles,
    openFile,
    exportFile,
    removeFile,
    setRemoteAllowed,
    readRemoteFile,
    readRemoteSiteFile,
  };
}

module.exports = { createCommunityFiles };
