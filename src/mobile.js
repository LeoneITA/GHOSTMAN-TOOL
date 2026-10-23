const $ = (selector) => document.querySelector(selector);
const tokenStorageKey = "ghostman.remote.session";
let pairingToken = new URLSearchParams(location.hash.slice(1)).get("token");
const pairingView = $("#pairing-view");
const toolsView = $("#tools-view");
const message = $("#mobile-message");
const localFileUrls = [];

if (pairingToken) {
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  $("#pair-button").classList.remove("hidden");
  message.textContent =
    "Link ricevuto. Premi Associa dispositivo per confermare questa sessione.";
} else if (sessionStorage.getItem(tokenStorageKey)) {
  connectSession().catch(showError);
} else {
  message.textContent =
    "Apri il link temporaneo generato da GHOSTMAN sul PC e assicurati che Tailscale sia connesso.";
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("Content-Type", "application/json");
  const token = sessionStorage.getItem(tokenStorageKey);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`api/${path}`, {
    ...options,
    headers,
    cache: "no-store",
    credentials: "omit",
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || `Errore HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function associateDevice() {
  const button = $("#pair-button");
  button.disabled = true;
  message.textContent = "Verifica del link e associazione del dispositivo...";
  try {
    const session = await api("pair", {
      method: "POST",
      body: JSON.stringify({ token: pairingToken }),
    });
    pairingToken = null;
    sessionStorage.setItem(tokenStorageKey, session.token);
    await connectSession();
  } catch (error) {
    showError(error);
    button.disabled = false;
  }
}

async function connectSession() {
  try {
    const [{ plugins }, { files }] = await Promise.all([
      api("plugins"),
      api("files"),
    ]);
    pairingView.classList.add("hidden");
    toolsView.classList.remove("hidden");
    $("#logout-button").classList.remove("hidden");
    renderPlugins(plugins);
    renderLocalFiles(files);
    message.textContent = "";
  } catch (error) {
    if (error.status === 401) {
      sessionStorage.removeItem(tokenStorageKey);
      pairingView.classList.remove("hidden");
      toolsView.classList.add("hidden");
      $("#logout-button").classList.add("hidden");
    }
    showError(error);
  }
}

function renderLocalFiles(files) {
  const container = $("#mobile-local-files");
  for (const objectUrl of localFileUrls) URL.revokeObjectURL(objectUrl);
  localFileUrls.length = 0;
  container.replaceChildren();

  if (!files.length) {
    const empty = document.createElement("section");
    empty.className = "panel";
    empty.textContent =
      "Nessun file abilitato. Dal Plugin manager sul PC, importa i file e attiva “Abilita remoto” solo per quelli che vuoi controllare.";
    container.append(empty);
    return;
  }

  for (const file of files) {
    const card = document.createElement("section");
    card.className = "plugin-card";

    const title = document.createElement("h2");
    title.textContent = file.name;
    card.append(title);

    const details = document.createElement("p");
    details.className = "file-meta";
    details.textContent = `${formatFileSize(file.size)} · ${
      file.kind === "folder" ? "sito locale del PC associato" : "file locale del PC associato"
    }`;
    card.append(details);

    if (file.kind === "folder" && Array.isArray(file.contents)) {
      const contents = document.createElement("details");
      contents.className = "mobile-folder-contents";
      const summary = document.createElement("summary");
      summary.textContent = `File della cartella (${file.contents.length})`;
      contents.append(summary);
      const fileList = document.createElement("ul");
      for (const item of file.contents) {
        const row = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = item.path;
        const downloadButton = document.createElement("button");
        downloadButton.className = "quiet-button";
        downloadButton.type = "button";
        downloadButton.textContent = "Scarica";
        downloadButton.addEventListener("click", () =>
          downloadLocalFile(file, item.path, downloadButton),
        );
        row.append(name, downloadButton);
        fileList.append(row);
      }
      contents.append(fileList);
      card.append(contents);
    }

    const button = document.createElement("button");
    button.className = "primary-button";
    button.type = "button";
    button.textContent =
      file.kind === "folder" && file.entryPath
        ? "Prova sito sul telefono"
        : "Apri sul telefono";
    button.addEventListener("click", () => previewLocalFile(file, button));
    card.append(button);

    if (file.kind !== "folder") {
      const downloadButton = document.createElement("button");
      downloadButton.className = "quiet-button download-file-button";
      downloadButton.type = "button";
      downloadButton.textContent = "Scarica sul telefono";
      downloadButton.addEventListener("click", () =>
        downloadLocalFile(file, "", downloadButton),
      );
      card.append(downloadButton);
    }

    const preview = document.createElement("div");
    preview.className = "local-file-preview";
    preview.setAttribute("aria-live", "polite");
    card.append(preview);

    const pcButton = document.createElement("button");
    pcButton.className = "quiet-button local-file-pc-button";
    pcButton.type = "button";
    pcButton.textContent = "Chiedi apertura sul PC";
    pcButton.addEventListener("click", () =>
      openLocalFileOnPc(file, pcButton),
    );
    card.append(pcButton);

    container.append(card);
  }
}

function formatFileSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function previewLocalFile(file, button) {
  button.disabled = true;
  const preview = button.parentElement.querySelector(".local-file-preview");
  preview.textContent = "Caricamento del file dal PC...";
  try {
    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (
      (file.kind === "folder" && file.entryPath) ||
      (file.kind !== "folder" && [".html", ".htm"].includes(extension))
    ) {
      const { url } = await api("files/preview-ticket", {
        method: "POST",
        body: JSON.stringify({ id: file.id }),
      });
      const frame = document.createElement("iframe");
      frame.className = "html-preview";
      frame.title =
        file.kind === "folder"
          ? `Anteprima sicura del sito ${file.name}`
          : `Anteprima sicura di ${file.name}`;
      frame.setAttribute("sandbox", "allow-scripts");
      frame.src = url;
      preview.replaceChildren(frame);
      return;
    }

    const token = sessionStorage.getItem(tokenStorageKey);
    const response = await fetch(
      `api/files/content?id=${encodeURIComponent(file.id)}`,
      {
        headers: { Authorization: ["Bearer ", token].join("") },
        cache: "no-store",
        credentials: "omit",
      },
    );
    if (!response.ok) {
      let errorMessage = `Errore HTTP ${response.status}.`;
      try {
        errorMessage = (await response.json()).error || errorMessage;
      } catch {
        // Keep the HTTP status message when the server did not return JSON.
      }
      throw new Error(errorMessage);
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    localFileUrls.push(objectUrl);
    preview.replaceChildren();

    if (blob.type.startsWith("image/")) {
      const image = document.createElement("img");
      image.className = "image-preview";
      image.alt = file.name;
      image.src = objectUrl;
      preview.append(image);
      return;
    }

    if (blob.type === "application/pdf") {
      const frame = document.createElement("iframe");
      frame.className = "document-preview";
      frame.title = file.name;
      frame.src = objectUrl;
      preview.append(frame);
      return;
    }

    if (blob.type.startsWith("text/")) {
      const text = document.createElement("pre");
      text.className = "text-preview";
      text.textContent = await blob.text();
      preview.append(text);
      return;
    }

    const download = document.createElement("a");
    download.className = "primary-button download-file-button";
    download.href = objectUrl;
    download.download = file.name;
    download.textContent = "Scarica il file sul telefono";
    preview.append(download);
  } catch (error) {
    preview.textContent = `Impossibile aprire il file: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function downloadLocalFile(file, relativePath, button) {
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Download...";
  try {
    const query = new URLSearchParams({ id: file.id });
    const endpoint =
      file.kind === "folder"
        ? "files/site-content"
        : "files/content";
    if (file.kind === "folder") {
      query.set("path", relativePath);
    } else {
      query.set("download", "1");
    }
    const token = sessionStorage.getItem(tokenStorageKey);
    const response = await fetch(`api/${endpoint}?${query.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) {
      let errorMessage = `Errore HTTP ${response.status}.`;
      try {
        errorMessage = (await response.json()).error || errorMessage;
      } catch {
        // Keep the HTTP status message when the server did not return JSON.
      }
      throw new Error(errorMessage);
    }

    const objectUrl = URL.createObjectURL(await response.blob());
    localFileUrls.push(objectUrl);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = relativePath
      ? relativePath.split("/").at(-1)
      : file.name;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
      const index = localFileUrls.indexOf(objectUrl);
      if (index !== -1) localFileUrls.splice(index, 1);
    }, 60_000);
    button.textContent = "Scaricamento avviato";
  } catch (error) {
    button.textContent = `Errore: ${error.message}`;
  } finally {
    window.setTimeout(() => {
      button.disabled = false;
      if (button.isConnected && button.textContent === "Scaricamento avviato") {
        button.textContent = originalText;
      }
    }, 2500);
  }
}

async function openLocalFileOnPc(file, button) {
  button.disabled = true;
  message.classList.remove("error");
  message.textContent =
    "Richiesta inviata: l'apertura sul PC deve essere confermata lì.";
  try {
    await api("files/open", {
      method: "POST",
      body: JSON.stringify({ id: file.id }),
      signal: AbortSignal.timeout(30_000),
    });
    message.textContent = `Richiesta approvata: "${file.name}" si apre sul PC.`;
  } catch (error) {
    message.textContent =
      error.name === "TimeoutError"
        ? "Nessuna conferma ricevuta dal PC. Se sei lontano, usa “Apri sul telefono” per i file supportati."
        : error.message;
    if (error.status === 401) await connectSession();
  } finally {
    button.disabled = false;
  }
}

function renderPlugins(plugins) {
  const container = $("#mobile-plugins");
  container.replaceChildren();

  if (!plugins.length) {
    const empty = document.createElement("section");
    empty.className = "panel";
    empty.textContent =
      "Non ci sono plugin Python autorizzati per l'accesso remoto. Approva un plugin dal Plugin manager sul PC.";
    container.append(empty);
    return;
  }

  for (const plugin of plugins) {
    const card = document.createElement("section");
    card.className = "plugin-card";

    const title = document.createElement("h2");
    title.textContent = plugin.name;
    card.append(title);

    const description = document.createElement("p");
    description.textContent = plugin.description;
    card.append(description);

    const form = document.createElement("form");
    form.className = "plugin-form";
    form.dataset.pluginId = plugin.id;

    for (const field of plugin.inputs) {
      const label = document.createElement("label");
      label.className = "plugin-field";
      label.textContent = field.label;

      const input = document.createElement("input");
      input.name = field.name;
      input.type = ["text", "number", "url"].includes(field.type)
        ? field.type
        : "text";
      input.placeholder = field.placeholder || "";
      input.required = field.required;
      input.autocomplete = "off";
      label.append(input);
      form.append(label);
    }

    const runButton = document.createElement("button");
    runButton.className = "primary-button";
    runButton.type = "submit";
    runButton.textContent = "Esegui sul PC";
    form.append(runButton);

    const output = document.createElement("pre");
    output.className = "output hidden";
    output.setAttribute("aria-live", "polite");
    form.append(output);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      runPlugin(form, output, runButton);
    });

    card.append(form);
    container.append(card);
  }
}

async function runPlugin(form, output, button) {
  button.disabled = true;
  output.classList.remove("hidden");
  output.textContent = "Invio richiesta al PC...";
  message.textContent = "";

  const input = Object.fromEntries(
    Array.from(form.querySelectorAll("input")).map((field) => [
      field.name,
      field.value.trim(),
    ]),
  );

  try {
    const { result } = await api("run", {
      method: "POST",
      body: JSON.stringify({ id: form.dataset.pluginId, input }),
    });
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    output.textContent = error.message;
    if (error.status === 401) await connectSession();
  } finally {
    button.disabled = false;
  }
}

function showError(error) {
  message.textContent = error.message;
  message.classList.add("error");
}

$("#pair-button").addEventListener("click", associateDevice);
$("#logout-button").addEventListener("click", async () => {
  try {
    await api("logout", { method: "POST", body: "{}" });
  } catch (error) {
    if (error.status !== 401) showError(error);
  } finally {
    sessionStorage.removeItem(tokenStorageKey);
    toolsView.classList.add("hidden");
    pairingView.classList.remove("hidden");
    $("#logout-button").classList.add("hidden");
    message.textContent = "Sessione terminata.";
  }
});
