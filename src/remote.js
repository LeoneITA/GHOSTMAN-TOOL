const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");
const { createServer } = require("node:http");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const QRCode = require("qrcode");

const execFileAsync = promisify(execFile);
const pairingLifetimeMs = 60_000;
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const sessionIdleMs = 30 * 60 * 1000;
const maxRequestBytes = 64 * 1024;
const maxPairAttemptsPerMinute = 5;
const contentTypes = {
  "/": "text/html; charset=utf-8",
  "/mobile.js": "text/javascript; charset=utf-8",
  "/mobile.css": "text/css; charset=utf-8",
};
const mobileFileTypes = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".eot": "application/vnd.ms-fontobject",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".ttf": "font/ttf",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function hashToken(token) {
  return createHash("sha256").update(token).digest();
}

function safeTokenEqual(candidate, expectedHash) {
  if (typeof candidate !== "string" || !/^[a-f0-9]{64}$/.test(candidate)) {
    return false;
  }
  return timingSafeEqual(hashToken(candidate), expectedHash);
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(JSON.stringify(data));
}

function createRemoteAccess({
  getApprovedPlugins,
  runPlugin,
  getApprovedFiles = async () => [],
  readLocalFile = async () => {
    throw new Error("Lettura remota dei file non configurata.");
  },
  readLocalSiteFile = async () => {
    throw new Error("Lettura remota delle cartelle non configurata.");
  },
  openLocalFile = async () => {
    throw new Error("Apertura remota dei file non configurata.");
  },
  logRun,
  tailscale: tailscaleOverride,
}) {
  let server = null;
  let command = null;
  let servePath = "";
  let baseUrl = "";
  let expectedOrigin = "";
  let pairingHash = null;
  let pairingExpiresAt = 0;
  let pairingUsed = false;
  let port = 0;
  const sessions = new Map();
  const pairingAttempts = new Map();
  const previewTickets = new Map();

  async function runTailscale(args, timeout = 10_000) {
    if (!command) throw new Error("Tailscale non è installato o non è disponibile.");
    let stdout;
    try {
      if (tailscaleOverride) {
        stdout = await tailscaleOverride.run(args, timeout);
      } else {
        ({ stdout } = await execFileAsync(command, args, {
          timeout,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        }));
      }
    } catch (error) {
      const output = [error.stdout, error.stderr]
        .filter(Boolean)
        .map((value) => String(value).trim())
        .filter(Boolean)
        .join("\n");
      if (output.includes("Serve is not enabled on your tailnet.")) {
        const settingsUrl = output.match(
          /https:\/\/login\.tailscale\.com\/f\/serve\?node=[A-Za-z0-9_-]+/,
        )?.[0];
        throw new Error(
          `Tailscale Serve non è abilitato per questo tailnet. Abilitalo nel pannello Tailscale e poi riprova.${settingsUrl ? ` Apri: ${settingsUrl}` : ""}`,
        );
      }
      throw new Error(output || error.message);
    }
    return stdout.trim();
  }

  async function findTailscale() {
    if (tailscaleOverride) return tailscaleOverride.findCommand();

    const candidates = [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe"),
      path.join(
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "Tailscale",
        "tailscale.exe",
      ),
      path.join(process.env.LOCALAPPDATA || "", "Tailscale", "tailscale.exe"),
    ];

    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate)) continue;
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      }
    }

    try {
      const { stdout } = await execFileAsync("where.exe", ["tailscale.exe"], {
        timeout: 5000,
        windowsHide: true,
        maxBuffer: 16 * 1024,
      });
      const firstPath = stdout.split(/\r?\n/).find(Boolean);
      if (firstPath) return firstPath.trim();
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== 1) throw error;
    }

    throw new Error(
      "Tailscale CLI non trovato. Installa Tailscale su questo PC, accedi al tuo account e riavvia GHOSTMAN. Installa e collega Tailscale anche sul telefono.",
    );
  }

  async function readTailscaleIdentity() {
    const status = JSON.parse(await runTailscale(["status", "--json"]));
    if (status.BackendState !== "Running") {
      throw new Error("Tailscale non è connesso. Accedi e riprova.");
    }

    const dnsName = String(status.Self?.DNSName || "")
      .replace(/\.$/, "")
      .toLowerCase();
    if (!/^[a-z0-9.-]+\.ts\.net$/.test(dnsName)) {
      throw new Error(
        "Nome DNS Tailscale non disponibile. Abilita MagicDNS e HTTPS nelle impostazioni del tailnet.",
      );
    }
    return dnsName;
  }

  function setSecurityHeaders(response, contentType) {
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
  }

  async function readJsonBody(request) {
    const chunks = [];
    let byteLength = 0;
    for await (const chunk of request) {
      byteLength += chunk.length;
      if (byteLength > maxRequestBytes) {
        throw Object.assign(new Error("Richiesta troppo grande."), {
          statusCode: 413,
        });
      }
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Object.assign(new Error("Corpo JSON non valido."), {
        statusCode: 400,
      });
    }
  }

  function getTailnetLogin(request) {
    const login = request.headers["tailscale-user-login"];
    return typeof login === "string" && login.length <= 254 ? login : "";
  }

  function checkOrigin(request) {
    const origin = request.headers.origin;
    return typeof origin === "string" && origin === expectedOrigin;
  }

  function getAuthenticatedSession(request) {
    const authorization = request.headers.authorization || "";
    const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
    const login = getTailnetLogin(request);
    if (!match || !login) return null;

    const sessionHash = hashToken(match[1]).toString("hex");
    const session = sessions.get(sessionHash);
    if (!session || session.login !== login) return null;
    if (
      session.expiresAt <= Date.now() ||
      session.lastSeenAt + sessionIdleMs <= Date.now()
    ) {
      sessions.delete(sessionHash);
      return null;
    }

    session.lastSeenAt = Date.now();
    return { sessionHash, ...session };
  }

  async function serveStaticFile(response, pathname) {
    const suffix = Object.keys(contentTypes).find((route) =>
      route === "/"
        ? pathname === "/" ||
          pathname.endsWith(servePath) ||
          pathname.endsWith(`${servePath}/`)
        : pathname.endsWith(route),
    );
    if (!suffix) return false;

    const fileName = suffix === "/" ? "mobile.html" : suffix.slice(1);
    const filePath = path.join(__dirname, fileName);
    const contents = await fs.readFile(filePath);
    setSecurityHeaders(response, contentTypes[suffix]);
    response.end(contents);
    return true;
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    const pathname = url.pathname;

    if (request.method === "GET" && (await serveStaticFile(response, pathname))) {
      return;
    }

    const siteRoutePrefix = `${servePath}/api/files/site/`;
    if (request.method === "GET" && pathname.startsWith(siteRoutePrefix)) {
      const parts = pathname.slice(siteRoutePrefix.length).split("/");
      const candidate = parts.shift() || "";
      let relativeParts;
      try {
        relativeParts = parts.map((part) => decodeURIComponent(part));
      } catch {
        sendJson(response, 400, { error: "Percorso del sito non valido." });
        return;
      }
      const ticketHash = /^[a-f0-9]{64}$/.test(candidate)
        ? hashToken(candidate).toString("hex")
        : "";
      const ticket = previewTickets.get(ticketHash);
      const login = getTailnetLogin(request);
      const ticketSession = ticket && sessions.get(ticket.sessionHash);
      if (
        !ticket ||
        ticket.kind !== "folder" ||
        ticket.expiresAt <= Date.now() ||
        ticket.login !== login ||
        !ticketSession ||
        ticketSession.login !== login ||
        ticketSession.expiresAt <= Date.now() ||
        ticketSession.lastSeenAt + sessionIdleMs <= Date.now()
      ) {
        sendJson(response, 401, {
          error: "Link del sito scaduto. Riaprilo dal pannello mobile.",
        });
        return;
      }
      if (
        !relativeParts.length ||
        relativeParts.some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part.includes("/") ||
            part.includes("\\") ||
            part.includes("\0"),
        )
      ) {
        sendJson(response, 400, { error: "Percorso del sito non valido." });
        return;
      }

      const approvedFolder = (await getApprovedFiles()).find(
        (item) =>
          item.id === ticket.fileId &&
          item.kind === "folder" &&
          item.entryPath,
      );
      if (!approvedFolder) {
        previewTickets.delete(ticketHash);
        sendJson(response, 403, {
          error: "La cartella non è più abilitata come sito remoto.",
        });
        return;
      }

      let siteResource;
      try {
        siteResource = await readLocalSiteFile(
          ticket.fileId,
          relativeParts.join("/"),
        );
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error.message });
        return;
      }

      ticketSession.lastSeenAt = Date.now();
      ticket.requestCount += 1;
      if (ticket.requestCount > 5000) {
        previewTickets.delete(ticketHash);
        sendJson(response, 429, { error: "Limite richieste del sito raggiunto." });
        return;
      }

      const extension = path.extname(siteResource.file.name).toLowerCase();
      const contentType = mobileFileTypes[extension] || "application/octet-stream";
      const isHtml = extension === ".html" || extension === ".htm";
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": siteResource.contents.length,
        "Content-Disposition": "inline",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": isHtml
          ? "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' https://cdn.discordapp.com data: blob:; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'"
          : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      });
      response.end(siteResource.contents);
      return;
    }

    if (request.method === "POST" && pathname.endsWith("/api/pair")) {
      if (!checkOrigin(request)) {
        sendJson(response, 403, { error: "Origine non autorizzata." });
        return;
      }

      const body = await readJsonBody(request);
      const login = getTailnetLogin(request);
      const now = Date.now();
      const attempt = pairingAttempts.get(login || "unknown");
      if (
        attempt &&
        attempt.startedAt + 60_000 > now &&
        attempt.count >= maxPairAttemptsPerMinute
      ) {
        sendJson(response, 429, { error: "Troppi tentativi. Attendi un minuto." });
        return;
      }
      if (!login) {
        sendJson(
          response,
          403,
          { error: "Apri il link da un dispositivo connesso al tuo tailnet Tailscale." },
        );
        return;
      }

      if (
        pairingUsed ||
        !pairingHash ||
        pairingExpiresAt <= now ||
        !safeTokenEqual(body?.token, pairingHash)
      ) {
        const nextAttempt =
          attempt && attempt.startedAt + 60_000 > now
            ? { ...attempt, count: attempt.count + 1 }
            : { startedAt: now, count: 1 };
        pairingAttempts.set(login || "unknown", nextAttempt);
        sendJson(response, 401, {
          error: "Link scaduto o già utilizzato. Generane uno nuovo dal PC.",
        });
        return;
      }

      pairingUsed = true;
      pairingHash = null;
      const sessionToken = randomBytes(32).toString("hex");
      const sessionHash = hashToken(sessionToken).toString("hex");
      const createdAt = Date.now();
      sessions.set(sessionHash, {
        login,
        createdAt,
        lastSeenAt: createdAt,
        expiresAt: createdAt + sessionLifetimeMs,
      });
      sendJson(response, 200, {
        token: sessionToken,
        expiresAt: createdAt + sessionLifetimeMs,
      });
      return;
    }

    const isPreviewRequest =
      request.method === "GET" && pathname.endsWith("/api/files/preview");
    const session = isPreviewRequest ? null : getAuthenticatedSession(request);
    if (!session && !isPreviewRequest) {
      sendJson(response, 401, { error: "Sessione scaduta. Associa di nuovo il telefono." });
      return;
    }

    if (request.method === "GET" && pathname.endsWith("/api/plugins")) {
      sendJson(response, 200, { plugins: await getApprovedPlugins() });
      return;
    }

    if (request.method === "GET" && pathname.endsWith("/api/files")) {
      sendJson(response, 200, { files: await getApprovedFiles() });
      return;
    }

    if (request.method === "GET" && pathname.endsWith("/api/files/content")) {
      const id = url.searchParams.get("id");
      const approvedFiles = await getApprovedFiles();
      const approvedFile = approvedFiles.find((item) => item.id === id);
      if (!approvedFile) {
        sendJson(response, 403, {
          error: "Questo file non è abilitato per l'accesso remoto sul PC.",
        });
        return;
      }

      let remoteFile;
      try {
        remoteFile = await readLocalFile(approvedFile.id);
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error.message });
        return;
      }
      const { file, contents } = remoteFile;
      const extension = path.extname(file.name).toLowerCase();
      const contentType = mobileFileTypes[extension] || "application/octet-stream";
      const safeName = encodeURIComponent(file.name).replace(
        /['()*]/g,
        (character) =>
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": contents.length,
        "Content-Disposition": url.searchParams.get("download") === "1"
          ? `attachment; filename*=UTF-8''${safeName}`
          : `inline; filename*=UTF-8''${safeName}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          extension === ".html" || extension === ".htm"
            ? "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
            : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      });
      response.end(contents);
      return;
    }

    if (
      request.method === "GET" &&
      pathname.endsWith("/api/files/site-content")
    ) {
      const id = url.searchParams.get("id");
      const relativePath = url.searchParams.get("path");
      const approvedFile = (await getApprovedFiles()).find(
        (item) => item.id === id && item.kind === "folder" && item.entryPath,
      );
      if (!approvedFile || !relativePath) {
        sendJson(response, 403, {
          error: "La cartella non è abilitata per l'accesso remoto.",
        });
        return;
      }

      let remoteFile;
      try {
        remoteFile = await readLocalSiteFile(approvedFile.id, relativePath);
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error.message });
        return;
      }

      const safeName = encodeURIComponent(remoteFile.file.name).replace(
        /['()*]/g,
        (character) =>
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": remoteFile.contents.length,
        "Content-Disposition": `attachment; filename*=UTF-8''${safeName}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      });
      response.end(remoteFile.contents);
      return;
    }

    if (
      request.method === "POST" &&
      pathname.endsWith("/api/files/preview-ticket")
    ) {
      const body = await readJsonBody(request);
      const approvedFile = (await getApprovedFiles()).find(
        (item) => item.id === body?.id,
      );
      if (
        !approvedFile ||
        !(
          approvedFile.kind === "folder" && approvedFile.entryPath
              ? /\.html?$/i.test(approvedFile.entryPath) &&
                !approvedFile.entryPath.includes("\\") &&
                approvedFile.entryPath
                  .split("/")
                  .every((part) => part && part !== "." && part !== "..")
            : ["file", undefined].includes(approvedFile.kind) &&
              [".html", ".htm"].includes(
                path.extname(approvedFile.name).toLowerCase(),
              )
        )
      ) {
        sendJson(response, 403, {
          error: "È possibile aprire solo siti o file HTML abilitati.",
        });
        return;
      }

      const token = randomBytes(32).toString("hex");
      for (const [key, ticket] of previewTickets) {
        if (ticket.expiresAt <= Date.now()) previewTickets.delete(key);
      }
      while (previewTickets.size >= 100) {
        previewTickets.delete(previewTickets.keys().next().value);
      }
      const ticketKey = hashToken(token).toString("hex");
      previewTickets.set(ticketKey, {
        fileId: approvedFile.id,
        kind: approvedFile.kind === "folder" ? "folder" : "file",
        login: session.login,
        sessionHash: session.sessionHash,
        expiresAt: Date.now() + (approvedFile.kind === "folder" ? 15 : 2) * 60 * 1000,
        requestCount: 0,
      });
      sendJson(response, 200, {
        url:
          approvedFile.kind === "folder"
            ? `${baseUrl}api/files/site/${token}/${approvedFile.entryPath
                .split("/")
                .map(encodeURIComponent)
                .join("/")}`
            : `${baseUrl}api/files/preview?ticket=${token}`,
      });
      return;
    }

    if (request.method === "GET" && pathname.endsWith("/api/files/preview")) {
      const candidate = url.searchParams.get("ticket");
      const ticketHash =
        typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate)
          ? hashToken(candidate).toString("hex")
          : "";
      const ticket = previewTickets.get(ticketHash);
      const login = getTailnetLogin(request);
      const ticketSession = ticket && sessions.get(ticket.sessionHash);
      if (
        !ticket ||
        ticket.kind !== "file" ||
        ticket.expiresAt <= Date.now() ||
        ticket.login !== login ||
        !ticketSession ||
        ticketSession.login !== login ||
        ticketSession.expiresAt <= Date.now() ||
        ticketSession.lastSeenAt + sessionIdleMs <= Date.now()
      ) {
        if (ticketHash) previewTickets.delete(ticketHash);
        sendJson(response, 401, {
          error: "Link di anteprima scaduto. Riprova dal telefono.",
        });
        return;
      }
      previewTickets.delete(ticketHash);
      ticketSession.lastSeenAt = Date.now();

      const approvedFile = (await getApprovedFiles()).find(
        (item) => item.id === ticket.fileId,
      );
      if (!approvedFile) {
        sendJson(response, 403, {
          error: "Il file non è più abilitato per l'accesso remoto.",
        });
        return;
      }

      let remoteFile;
      try {
        remoteFile = await readLocalFile(approvedFile.id);
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error.message });
        return;
      }
      const extension = path.extname(remoteFile.file.name).toLowerCase();
      if (![".html", ".htm"].includes(extension)) {
        sendJson(response, 403, { error: "Il file non è HTML." });
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": remoteFile.contents.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      });
      response.end(remoteFile.contents);
      return;
    }

    if (request.method === "POST" && pathname.endsWith("/api/files/open")) {
      const body = await readJsonBody(request);
      if (!body || typeof body.id !== "string") {
        sendJson(response, 400, { error: "Richiesta file non valida." });
        return;
      }

      const approvedFiles = await getApprovedFiles();
      const file = approvedFiles.find((item) => item.id === body.id);
      if (!file) {
        sendJson(response, 403, {
          error: "Questo file non è abilitato per l'accesso remoto sul PC.",
        });
        return;
      }

      try {
        const result = await openLocalFile({ id: file.id, user: session.login });
        await logRun({
          timestamp: new Date().toISOString(),
          user: session.login,
          fileId: file.id,
          success: result.opened,
          cancelled: result.cancelled === true,
        });
        if (result.cancelled) {
          sendJson(response, 409, {
            error: "La richiesta è stata annullata sul PC.",
          });
        } else {
          sendJson(response, 200, { opened: true });
        }
      } catch (error) {
        await logRun({
          timestamp: new Date().toISOString(),
          user: session.login,
          fileId: file.id,
          success: false,
        });
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && pathname.endsWith("/api/run")) {
      const body = await readJsonBody(request);
      if (
        !body ||
        typeof body.id !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(body.id) ||
        !body.input ||
        typeof body.input !== "object" ||
        Array.isArray(body.input)
      ) {
        sendJson(response, 400, { error: "Richiesta plugin non valida." });
        return;
      }

      const approvedPlugins = await getApprovedPlugins();
      if (!approvedPlugins.some((plugin) => plugin.id === body.id)) {
        sendJson(response, 403, { error: "Questo plugin non è approvato per l'accesso remoto." });
        return;
      }

      try {
        const result = await runPlugin({ id: body.id, input: body.input });
        await logRun({
          timestamp: new Date().toISOString(),
          user: session.login,
          pluginId: body.id,
          success: true,
        });
        sendJson(response, 200, { result });
      } catch (error) {
        await logRun({
          timestamp: new Date().toISOString(),
          user: session.login,
          pluginId: body.id,
          success: false,
        });
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && pathname.endsWith("/api/logout")) {
      sessions.delete(session.sessionHash);
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, 404, { error: "Percorso non trovato." });
  }

  async function issuePairing() {
    const token = randomBytes(32).toString("hex");
    pairingHash = hashToken(token);
    pairingExpiresAt = Date.now() + pairingLifetimeMs;
    pairingUsed = false;
    pairingAttempts.clear();
    const link = `${baseUrl}#token=${token}`;
    const qrCode = await QRCode.toDataURL(link, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280,
    });

    return {
      active: true,
      link,
      qrCode,
      expiresAt: pairingExpiresAt,
      expiresInSeconds: pairingLifetimeMs / 1000,
    };
  }

  async function start() {
    if (server) return issuePairing();

    command = await findTailscale();
    const dnsName = await readTailscaleIdentity();
    servePath = `/ghostman-${randomBytes(6).toString("hex")}`;

    server = createServer((request, response) => {
      handleRequest(request, response).catch((error) => {
        if (response.headersSent) {
          response.destroy(error);
          return;
        }
        sendJson(response, error.statusCode || 500, { error: error.message });
      });
    });
    server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;

    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    } catch (error) {
      server = null;
      throw error;
    }
    port = server.address().port;

    try {
      await runTailscale([
        "serve",
        "--bg",
        "--https=443",
        `--set-path=${servePath}`,
        `http://127.0.0.1:${port}`,
      ]);
    } catch (error) {
      await closeLocalServer();
      throw new Error(
        `Avvio di Tailscale Serve non riuscito: ${error.message}`,
      );
    }

    baseUrl = `https://${dnsName}${servePath}/`;
    expectedOrigin = `https://${dnsName}`;
    try {
      return await issuePairing();
    } catch (error) {
      await stop();
      throw error;
    }
  }

  async function closeLocalServer() {
    if (!server) return;
    const activeServer = server;
    server = null;
    await new Promise((resolve) =>
      activeServer.close(() => resolve()),
    );
    port = 0;
  }

  async function stop() {
    const currentPath = servePath;
    pairingHash = null;
    pairingExpiresAt = 0;
    pairingUsed = true;
    baseUrl = "";
    expectedOrigin = "";
    sessions.clear();
    pairingAttempts.clear();
    previewTickets.clear();

    let stopError = null;
    if (server && command && currentPath) {
      try {
        await runTailscale([
          "serve",
          "--https=443",
          `--set-path=${currentPath}`,
          "off",
        ]);
      } catch (error) {
        stopError = error;
      }
    }

    await closeLocalServer();
    servePath = "";
    if (stopError) throw stopError;
    return { active: false };
  }

  return {
    start,
    stop,
    getStatus: () => ({
      active: Boolean(server),
      url: server ? baseUrl : "",
      port,
      pairingExpiresAt,
      connectedDevices: sessions.size,
    }),
  };
}

module.exports = { createRemoteAccess };
