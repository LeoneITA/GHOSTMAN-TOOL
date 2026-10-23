const $ = (selector) => document.querySelector(selector);

const state = {
  plugins: [],
  communityFiles: [],
  activeTool: null,
  remoteTimer: null,
};

const toolDefinitions = [
  {
    id: "discord-snowflake",
    name: "Discord Toolkit",
    category: "DISCORD",
    icon: "◉",
    description: "Ricava la data di creazione da un Discord Snowflake ID.",
    label: "Discord ID / Snowflake",
    placeholder: "123456789012345678",
  },
  {
    id: "osint-domain",
    name: "OSINT pubblico",
    category: "OSINT",
    icon: "⌕",
    description:
      "Consulta i record DNS A pubblicamente disponibili per un dominio.",
    label: "Dominio",
    placeholder: "example.com",
  },
  {
    id: "network-url",
    name: "Network Toolkit",
    category: "NETWORK",
    icon: "⌘",
    description: "Analizza localmente la struttura di un URL HTTP o HTTPS.",
    label: "URL da analizzare",
    placeholder: "https://example.com",
  },
];

const pageNames = {
  dashboard: "Dashboard",
  tools: "Toolkit",
  plugins: "Plugin manager",
  remote: "Accesso mobile",
  updates: "Aggiornamenti",
  settings: "Impostazioni",
};

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function showPage(name) {
  if (!pageNames[name]) return;

  document.querySelectorAll(".page").forEach((page) => {
    page.classList.toggle("hidden", page.id !== `page-${name}`);
  });

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === name);
  });

  $("#page-name").textContent = pageNames[name];
  closeRunner();
}

function renderToolCard(tool) {
  return `
    <article class="tool-card">
      <div class="tool-card-top">
        <div class="tool-icon">${escapeHtml(tool.icon || "◇")}</div>
        <span class="pill">${escapeHtml(tool.category || "PLUGIN")}</span>
      </div>
      <h3>${escapeHtml(tool.name)}</h3>
      <p>${escapeHtml(tool.description)}</p>
      <button class="tool-open" data-run-tool="${escapeHtml(tool.id)}">
        Apri strumento <span>↗</span>
      </button>
    </article>
  `;
}

function renderPluginField(field) {
  return `
    <label class="runner-field">
      <span>${escapeHtml(field.label)}</span>
      <input
        name="${escapeHtml(field.name)}"
        type="${escapeHtml(field.type)}"
        placeholder="${escapeHtml(field.placeholder || "")}"
        autocomplete="off"
        ${field.required ? "required" : ""}
      />
    </label>
  `;
}

function renderTools() {
  const query = ($("#tool-search")?.value || "").trim().toLowerCase();

  const filtered = toolDefinitions.filter((tool) => {
    const searchable = `${tool.name} ${tool.description} ${tool.category}`;
    return searchable.toLowerCase().includes(query);
  });

  $("#all-tools").innerHTML = filtered.length
    ? filtered.map(renderToolCard).join("")
    : '<p class="notice">Nessuno strumento corrispondente.</p>';

  $("#quick-tools").innerHTML = toolDefinitions
    .slice(0, 3)
    .map(renderToolCard)
    .join("");

  $("#stat-tools").textContent = String(toolDefinitions.length);
}

async function renderPlugins() {
  const container = $("#plugin-list");
  container.innerHTML = "<p>Caricamento registro...</p>";

  try {
    state.plugins = await window.ghostman.getPlugins();

    if (!state.plugins.length) {
      container.innerHTML =
        "<p>Nessun manifest valido trovato nella cartella plugins.</p>";
    } else {
      container.innerHTML = state.plugins
        .map(
          (plugin) => `
      <div class="plugin-row">
        <div class="tool-icon">◇</div>
        <div class="plugin-info">
          <strong>${escapeHtml(plugin.name)}</strong>
          <p>${escapeHtml(plugin.description)}</p>
        </div>
        <span class="pill">v${escapeHtml(plugin.version)}</span>
        ${
          plugin.runtime === "python"
            ? `<div class="plugin-actions"><button class="tool-open remote-approval" data-remote-plugin="${escapeHtml(plugin.id)}" type="button">${plugin.remoteAllowed ? "Revoca remoto" : "Consenti remoto"}</button><button class="tool-open plugin-run" data-run-plugin="${escapeHtml(plugin.id)}" type="button">Esegui <span>↗</span></button></div>`
            : plugin.runtime === "html"
              ? `<div class="plugin-actions"><button class="tool-open remote-approval" data-remote-plugin="${escapeHtml(plugin.id)}" type="button">${plugin.remoteAllowed ? "Revoca remoto" : "Consenti remoto"}</button><button class="tool-open plugin-page-open" data-open-plugin-page="${escapeHtml(plugin.id)}" type="button">Apri sito</button></div>`
              : ""
        }
      </div>
    `,
        )
        .join("");
    }
  } catch (error) {
    container.innerHTML = `<p>Errore nel registro: ${escapeHtml(error.message)}</p>`;
  }

  await renderCommunityFiles();
}

function formatFileSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function renderCommunityFiles() {
  const container = $("#community-file-list");
  try {
    state.communityFiles = await window.ghostman.getCommunityFiles();
    if (!state.communityFiles.length) {
      container.innerHTML =
        "<p>Nessun contenuto importato. Aggiungi file, cartelle di progetto/sito o archivi ZIP.</p>";
      return;
    }

    container.innerHTML = state.communityFiles
      .map(
        (file) => `
          <div class="plugin-row community-file-row">
            <div class="tool-icon">◇</div>
            <div class="plugin-info">
              <strong>${escapeHtml(file.name)}</strong>
              <p>${formatFileSize(file.size)} · ${
                file.kind === "folder"
                  ? file.entryPath
                    ? "cartella sito con pagina iniziale"
                    : "cartella locale"
                  : "file importato localmente"
              }</p>
              ${
                file.kind === "folder"
                  ? `<details class="community-folder-contents">
                      <summary>Contenuto cartella (${file.contents?.length || 0} file)</summary>
                      <ul>${(file.contents || [])
                        .map(
                          (item) =>
                            `<li><span>${escapeHtml(item.path)}</span><small>${formatFileSize(item.size)}</small></li>`,
                        )
                        .join("") || "<li>Cartella vuota</li>"}</ul>
                    </details>`
                  : ""
              }
            </div>
            <div class="community-file-actions">
              ${
                file.kind === "folder" &&
                file.contents?.some((item) => item.path === "manifest.json")
                  ? `<button class="tool-open" data-community-install-plugin="${escapeHtml(file.id)}" type="button">Installa plugin Python</button>`
                  : ""
              }
              <button class="tool-open" data-community-open="${escapeHtml(file.id)}" type="button">${
                file.kind === "folder"
                  ? file.entryPath
                    ? "Prova sito"
                    : "Apri cartella"
                  : /\.html?$/i.test(file.name)
                    ? "Prova HTML"
                    : "Apri con Windows"
              }</button>
              ${
                file.kind === "folder" && !file.entryPath
                  ? '<button class="tool-open" type="button" disabled title="Aggiungi index.html o index.htm per abilitarla da remoto">Nessun sito HTML</button>'
                  : `<button class="tool-open" data-community-remote="${escapeHtml(file.id)}" type="button">${file.remoteAllowed ? "Revoca remoto" : "Abilita remoto"}</button>`
              }
              <button class="tool-open" data-community-export="${escapeHtml(file.id)}" type="button">Esporta</button>
              <button class="tool-open" data-community-remove="${escapeHtml(file.id)}" type="button">Rimuovi</button>
            </div>
          </div>
        `,
      )
      .join("");
  } catch (error) {
    container.innerHTML = `<p>Errore nella libreria locale: ${escapeHtml(error.message)}</p>`;
  }
}

function openRunner(id) {
  const tool = toolDefinitions.find((item) => item.id === id);

  if (!tool) return;

  state.activeTool = tool;
  $("#runner-title").textContent = tool.name;
  $("#runner-fields").innerHTML = renderPluginField({
    name: "value",
    label: tool.label,
    type: "text",
    placeholder: tool.placeholder,
    required: true,
  });
  $("#runner-output").textContent =
    "Pronto. Inserisci un valore e avvia il tool.";
  $("#tool-runner").classList.remove("hidden");
  $("#runner-fields input").focus();
}

function openPluginRunner(id) {
  const plugin = state.plugins.find(
    (item) => item.id === id && item.runtime === "python",
  );

  if (!plugin) return;

  state.activeTool = { ...plugin, isPlugin: true };
  $("#runner-title").textContent = plugin.name;
  $("#runner-fields").innerHTML = plugin.inputs.map(renderPluginField).join("");
  $("#runner-output").textContent =
    "Pronto. Inserisci i dati richiesti e avvia il plugin.";
  $("#tool-runner").classList.remove("hidden");
  $("#runner-fields input")?.focus();
}

function closeRunner() {
  $("#tool-runner").classList.add("hidden");
  state.activeTool = null;
}

document.addEventListener("click", (event) => {
  const navButton = event.target.closest("[data-page]");
  if (navButton) {
    showPage(navButton.dataset.page);
    return;
  }

  const gotoButton = event.target.closest("[data-goto]");
  if (gotoButton) {
    showPage(gotoButton.dataset.goto);
    return;
  }

  const toolButton = event.target.closest("[data-run-tool]");
  if (toolButton) {
    openRunner(toolButton.dataset.runTool);
    return;
  }

  const pluginButton = event.target.closest("[data-run-plugin]");
  if (pluginButton) {
    openPluginRunner(pluginButton.dataset.runPlugin);
    return;
  }

  const pluginPageButton = event.target.closest("[data-open-plugin-page]");
  if (pluginPageButton) {
    openPluginPage(pluginPageButton.dataset.openPluginPage, pluginPageButton);
    return;
  }

  const approvalButton = event.target.closest("[data-remote-plugin]");
  if (approvalButton) {
    setPluginRemoteApproval(approvalButton);
    return;
  }

  const communityOpenButton = event.target.closest("[data-community-open]");
  if (communityOpenButton) {
    openCommunityFile(communityOpenButton.dataset.communityOpen);
    return;
  }

  const communityInstallPluginButton = event.target.closest(
    "[data-community-install-plugin]",
  );
  if (communityInstallPluginButton) {
    installCommunityPlugin(
      communityInstallPluginButton.dataset.communityInstallPlugin,
      communityInstallPluginButton,
    );
    return;
  }

  const communityRemoteButton = event.target.closest("[data-community-remote]");
  if (communityRemoteButton) {
    setCommunityFileRemoteAccess(communityRemoteButton);
    return;
  }

  const communityExportButton = event.target.closest("[data-community-export]");
  if (communityExportButton) {
    exportCommunityFile(communityExportButton.dataset.communityExport);
    return;
  }

  const communityRemoveButton = event.target.closest("[data-community-remove]");
  if (communityRemoveButton) {
    removeCommunityFile(communityRemoveButton.dataset.communityRemove);
  }
});

$("#add-community-files").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const status = $("#community-file-status");
  button.disabled = true;
  status.textContent = "";
  try {
    const files = await window.ghostman.importCommunityFiles();
    if (files.length) {
      const importedFiles = files.filter((file) => file.kind !== "folder").length;
      const importedFolders = files.length - importedFiles;
      status.textContent = `Importati ${importedFiles} file e ${importedFolders} cartelle sul PC.`;
      await renderCommunityFiles();
    }
  } catch (error) {
    status.textContent = `Importazione non riuscita: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$("#import-community-plugin").addEventListener("click", (event) => {
  installCommunityPlugin(undefined, event.currentTarget);
});

async function installCommunityPlugin(communityFolderId, button) {
  const status = $("#community-file-status");
  button.disabled = true;
  status.textContent = "";
  try {
    const result = communityFolderId
      ? await window.ghostman.installImportedCommunityPlugin(communityFolderId)
      : await window.ghostman.importCommunityPlugin();
    if (!result.plugin) return;
    state.plugins = result.plugins;
    status.textContent = `Plugin "${result.plugin.name}" v${result.plugin.version} installato. È disponibile nel Plugin manager.`;
    await renderPlugins();
  } catch (error) {
    status.textContent = `Installazione plugin non riuscita: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function openCommunityFile(id) {
  const file = state.communityFiles.find((item) => item.id === id);
  if (!file) return;

  const executableExtensions = new Set([
    ".bat",
    ".cmd",
    ".com",
    ".cjs",
    ".docm",
    ".exe",
    ".hta",
    ".jar",
    ".js",
    ".mjs",
    ".msi",
    ".ps1",
    ".py",
    ".reg",
    ".scr",
    ".vbs",
    ".wsf",
    ".xlsm",
  ]);
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (
    executableExtensions.has(extension) &&
    !window.confirm(
      `"${file.name}" può eseguire codice o modificare il PC. Aprilo solo se hai verificato il file e ti fidi della fonte. Vuoi continuare?`,
    )
  ) {
    return;
  }

  try {
    await window.ghostman.openCommunityFile(id);
  } catch (error) {
    $("#community-file-status").textContent = `Impossibile aprire il file: ${error.message}`;
  }
}

async function exportCommunityFile(id) {
  try {
    const exported = await window.ghostman.exportCommunityFile(id);
    if (exported) {
      $("#community-file-status").textContent =
        "File esportato: ora puoi condividerlo, per esempio su Discord.";
    }
  } catch (error) {
    $("#community-file-status").textContent = `Esportazione non riuscita: ${error.message}`;
  }
}

async function setCommunityFileRemoteAccess(button) {
  const file = state.communityFiles.find(
    (item) => item.id === button.dataset.communityRemote,
  );
  if (!file) return;

  const allow = !file.remoteAllowed;
  if (
    allow &&
    !window.confirm(
      `Consenti al dispositivo Tailscale associato di richiedere l'apertura di "${file.name}" su questo PC? Ogni richiesta dovrà comunque essere confermata qui sul PC.`,
    )
  ) {
    return;
  }

  button.disabled = true;
  try {
    await window.ghostman.setCommunityFileRemoteAccess(file.id, allow);
    $("#community-file-status").textContent = allow
      ? `Accesso remoto abilitato per "${file.name}".`
      : `Accesso remoto revocato per "${file.name}".`;
    await renderCommunityFiles();
  } catch (error) {
    $("#community-file-status").textContent = `Impossibile aggiornare il permesso remoto: ${error.message}`;
    button.disabled = false;
  }
}

async function removeCommunityFile(id) {
  const file = state.communityFiles.find((item) => item.id === id);
  if (
    !file ||
    !window.confirm(`Rimuovere "${file.name}" dalla libreria locale?`)
  ) {
    return;
  }

  try {
    await window.ghostman.removeCommunityFile(id);
    $("#community-file-status").textContent = "File rimosso dalla libreria.";
    await renderCommunityFiles();
  } catch (error) {
    $("#community-file-status").textContent = `Rimozione non riuscita: ${error.message}`;
  }
}

$("#tool-search").addEventListener("input", renderTools);
$("#runner-close").addEventListener("click", closeRunner);

$("#runner-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!state.activeTool) return;

  const tool = state.activeTool;
  const fields = $("#runner-fields");
  const values = Object.fromEntries(
    Array.from(fields.querySelectorAll("input")).map((input) => [
      input.name,
      input.value.trim(),
    ]),
  );

  if (
    Array.from(fields.querySelectorAll("input")).some(
      (input) => !input.reportValidity(),
    )
  ) {
    return;
  }

  $("#runner-output").textContent = "Esecuzione...";
  const submitButton = $("#runner-form button[type=submit]");
  submitButton.disabled = true;

  try {
    if (tool.isPlugin) {
      const result = await window.ghostman.runPlugin(tool.id, values);
      $("#runner-output").textContent = JSON.stringify(result, null, 2);
      return;
    }

    let input;

    switch (tool.id) {
      case "discord-snowflake":
        input = { snowflake: values.value };
        break;
      case "osint-domain":
        input = { domain: values.value };
        break;
      case "network-url":
        input = { url: values.value };
        break;
      default:
        throw new Error("Tool non supportato.");
    }

    const result = await window.ghostman.runTool(tool.id, input);
    $("#runner-output").textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    $("#runner-output").textContent = `Errore: ${error.message}`;
  } finally {
    submitButton.disabled = false;
  }
});

async function initialize() {
  renderTools();
  await renderPlugins();

  const version = await window.ghostman.getAppVersion();
  $("#sidebar-version").textContent = `GHOSTMAN v${version}`;
  $("#dashboard-version").textContent = version;
  $("#current-version").textContent = `BUILD LOCALE · v${version}`;
  $("#settings-version").textContent = version;

  renderUpdateState(await window.ghostman.getUpdateState());
  renderRemoteStatus(await window.ghostman.getRemoteStatus());
}

const intro = $("#startup-intro");
const introSkip = $("#intro-skip");
let introDismissTimer;

function dismissIntro() {
  if (intro.classList.contains("is-leaving")) return;

  window.clearTimeout(introDismissTimer);
  intro.classList.add("is-leaving");
  window.setTimeout(() => {
    intro.classList.add("hidden");
    intro.setAttribute("aria-hidden", "true");
  }, 450);
}

introSkip.addEventListener("click", dismissIntro);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") dismissIntro();
});
introDismissTimer = window.setTimeout(dismissIntro, 2800);

function renderUpdateState(update) {
  const indicator = $("#updates-indicator");
  const manifestUpdate = update.manifestUpdate || {};
  const hasUpdate =
    manifestUpdate.available ||
    ["available", "downloading", "downloaded"].includes(update.status);
  indicator.classList.toggle("hidden", !hasUpdate);

  const titles = {
    idle: "Controllo aggiornamenti",
    checking: "Controllo aggiornamenti",
    available: `Aggiornamento disponibile: v${update.version}`,
    downloading: `Scaricamento aggiornamento: ${update.progress}%`,
    downloaded: `Aggiornamento v${update.version} pronto`,
    "not-available": "GHOSTMAN è aggiornato",
    error: "Controllo aggiornamenti non riuscito",
  };
  $("#update-title").textContent = manifestUpdate.available
    ? manifestUpdate.ready
      ? `Aggiornamento disponibile: v${manifestUpdate.version}`
      : `Preparazione aggiornamento v${manifestUpdate.version}`
    : titles[update.status] || titles.idle;

  const messages = {
    idle: "Controllo automatico delle release GitHub.",
    checking: "Controllo delle release GitHub...",
    available: update.portable
      ? "Scarica l'installer e avvialo per passare dalla vecchia versione portatile all'app installata."
      : "L'aggiornamento si sta scaricando in background.",
    downloading: `Scaricamento in corso: ${update.progress}%.`,
    downloaded:
      "Il pacchetto è pronto. Puoi installarlo ora oppure verrà installato alla chiusura dell'app.",
    "not-available": `Hai già l'ultima versione disponibile (v${update.version}).`,
    error: update.error || "Riprova più tardi.",
  };
  $("#update-status").textContent = manifestUpdate.available
    ? manifestUpdate.ready
      ? update.portable
        ? `È disponibile la versione ${manifestUpdate.version}. Scarica l'installer per installarla.`
        : update.status === "downloaded"
          ? `L'aggiornamento ${manifestUpdate.version} è pronto per l'installazione.`
          : `È disponibile la versione ${manifestUpdate.version}. L'installer si scarica in background e sarà installato alla chiusura dell'app.`
      : `La versione ${manifestUpdate.version} è pubblicata ma l'installer non è ancora disponibile. Attendi il completamento di Actions e ricontrolla.`
    : manifestUpdate.status === "error" &&
        !["available", "downloading", "downloaded"].includes(update.status)
      ? `Controllo della release non riuscito: ${manifestUpdate.error}`
      : messages[update.status] || messages.idle;

  const notes = $("#update-notes");
  const releaseNotes = manifestUpdate.available
    ? manifestUpdate.notes
    : update.notes;
  notes.textContent = releaseNotes || "";
  notes.classList.toggle("hidden", !releaseNotes);

  $("#download-update-installer").classList.toggle(
    "hidden",
    !(update.portable && manifestUpdate.available && manifestUpdate.ready),
  );
  $("#download-update-installer").textContent = manifestUpdate.available
    ? `Scarica installer GHOSTMAN ${manifestUpdate.version}`
    : "Scarica installer aggiornamento";
  $("#install-update").classList.toggle(
    "hidden",
    !(update.status === "downloaded" && !update.portable),
  );
}

window.ghostman.onUpdateState(renderUpdateState);
$("#check-for-updates").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    renderUpdateState(await window.ghostman.checkForUpdates());
  } finally {
    button.disabled = false;
  }
});
$("#install-update").addEventListener("click", async () => {
  try {
    await window.ghostman.installUpdate();
  } catch (error) {
    $("#update-status").textContent = `Errore installazione: ${error.message}`;
  }
});
$("#download-update-installer").addEventListener("click", async () => {
  try {
    await window.ghostman.downloadUpdateInstaller();
  } catch (error) {
    $("#update-status").textContent = `Errore download: ${error.message}`;
  }
});

async function setPluginRemoteApproval(button) {
  button.disabled = true;
  try {
    const plugin = state.plugins.find(
      (item) => item.id === button.dataset.remotePlugin,
    );
    if (!plugin || plugin.runtime !== "python") {
      throw new Error("Il plugin Python non è più disponibile.");
    }
    const approved = await window.ghostman.setPluginRemoteApproval(
      button.dataset.remotePlugin,
      !plugin.remoteAllowed,
    );
    plugin.remoteAllowed = approved;
    button.textContent = approved ? "Revoca remoto" : "Consenti remoto";
    $("#community-file-status").textContent = approved
      ? "Accesso remoto abilitato per il plugin."
      : "Accesso remoto revocato per il plugin.";
  } catch (error) {
    $("#community-file-status").textContent =
      `Impossibile aggiornare il permesso remoto: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function openPluginPage(id, button) {
  button.disabled = true;
  try {
    await window.ghostman.openPluginPage(id);
    $("#community-file-status").textContent =
      "Sito del plugin aperto nel browser.";
  } catch (error) {
    $("#community-file-status").textContent =
      `Impossibile aprire il sito del plugin: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function renderRemoteStatus(status) {
  const active = Boolean(status.active);
  $("#remote-title").textContent = active
    ? "Accesso remoto attivo"
    : "Accesso remoto spento";
  $("#remote-status-pill").textContent = active ? "TAILNET" : "OFFLINE";
  $("#remote-status").textContent = active
    ? `Il servizio è disponibile solo nella rete Tailscale. ${status.connectedDevices} sessioni associate.`
    : "Installa Tailscale su questo PC e sul telefono e accedi allo stesso tailnet. Non vengono aperte porte del router.";
  $("#start-remote").classList.toggle("hidden", active);
  $("#stop-remote").classList.toggle("hidden", !active);
}

function showPairing(pairing) {
  const container = $("#remote-pairing");
  container.classList.remove("hidden");
  $("#remote-qr").src = pairing.qrCode;
  $("#remote-link").value = pairing.link;

  window.clearInterval(state.remoteTimer);
  const updateCountdown = () => {
    const remaining = Math.max(
      0,
      Math.ceil((pairing.expiresAt - Date.now()) / 1000),
    );
    $("#pairing-countdown").textContent =
      remaining > 0 ? String(remaining) : "scaduto";
    if (remaining === 0) {
      $("#remote-qr").removeAttribute("src");
      $("#remote-link").value = "";
      window.clearInterval(state.remoteTimer);
      state.remoteTimer = null;
    }
  };
  updateCountdown();
  state.remoteTimer = window.setInterval(updateCountdown, 1000);
}

async function createRemotePairing() {
  const button = $("#start-remote");
  const newLinkButton = $("#new-remote-link");
  button.disabled = true;
  newLinkButton.disabled = true;
  $("#remote-error").classList.add("hidden");
  $("#open-serve-settings").classList.add("hidden");
  try {
    const pairing = await window.ghostman.startRemoteAccess();
    renderRemoteStatus(await window.ghostman.getRemoteStatus());
    showPairing(pairing);
  } catch (error) {
    $("#remote-error").textContent = error.message;
    $("#remote-error").classList.remove("hidden");
    const settingsUrl = error.message.match(
      /https:\/\/login\.tailscale\.com\/f\/serve\?node=[A-Za-z0-9_-]+/,
    )?.[0];
    if (settingsUrl) {
      $("#open-serve-settings").dataset.url = settingsUrl;
      $("#open-serve-settings").classList.remove("hidden");
    }
  } finally {
    button.disabled = false;
    newLinkButton.disabled = false;
  }
}

$("#start-remote").addEventListener("click", createRemotePairing);
$("#open-serve-settings").addEventListener("click", async (event) => {
  const settingsUrl = event.currentTarget.dataset.url;
  if (!settingsUrl) return;
  try {
    const parsedUrl = new URL(settingsUrl);
    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.hostname !== "login.tailscale.com" ||
      parsedUrl.pathname !== "/f/serve"
    ) {
      throw new Error("Link impostazioni Tailscale non valido.");
    }
    await window.ghostman.openExternal(parsedUrl.href);
  } catch (error) {
    $("#remote-error").textContent = `Impossibile aprire le impostazioni: ${error.message}`;
    $("#remote-error").classList.remove("hidden");
  }
});
$("#new-remote-link").addEventListener("click", createRemotePairing);
$("#stop-remote").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await window.ghostman.stopRemoteAccess();
    window.clearInterval(state.remoteTimer);
    state.remoteTimer = null;
    $("#remote-pairing").classList.add("hidden");
    $("#remote-qr").removeAttribute("src");
    $("#remote-link").value = "";
    renderRemoteStatus(await window.ghostman.getRemoteStatus());
  } catch (error) {
    $("#remote-error").textContent = error.message;
    $("#remote-error").classList.remove("hidden");
  } finally {
    button.disabled = false;
  }
});
$("#copy-remote-link").addEventListener("click", async () => {
  const link = $("#remote-link").value;
  if (!link) return;
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(link);
    } else {
      $("#remote-link").select();
      document.execCommand("copy");
    }
    $("#remote-status").textContent = "Link copiato: aprilo dal telefono entro 60 secondi.";
  } catch (error) {
    $("#remote-error").textContent = `Impossibile copiare il link: ${error.message}`;
    $("#remote-error").classList.remove("hidden");
  }
});
$("#open-tailscale").addEventListener("click", () => {
  window.ghostman.openExternal("https://tailscale.com/download");
});

initialize();
