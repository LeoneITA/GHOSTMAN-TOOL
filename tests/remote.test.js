const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");
const { createRemoteAccess } = require("../src/remote");

const instances = [];

afterEach(async () => {
  await Promise.all(
    instances.splice(0).map((remote) => remote.stop().catch(() => {})),
  );
});

function sessionHeaders(token, login = "owner@example.com") {
  return {
    Authorization: ["Bearer ", token].join(""),
    "Tailscale-User-Login": login,
  };
}

async function createPairedRemote(options = {}) {
  const remote = createRemoteAccess({
    getApprovedPlugins: async () => [
      {
        id: "approved-tool",
        name: "Approved Tool",
        description: "A test plugin",
        inputs: [],
      },
    ],
    getApprovedFiles: async () => [],
    runPlugin: async () => ({ title: "Approved Tool", data: "ran on PC" }),
    openLocalFile: async () => ({ opened: true }),
    logRun: async () => {},
    tailscale: {
      findCommand: async () => "mock-tailscale",
      run: async (args) => {
        if (args[0] === "status") {
          return JSON.stringify({
            BackendState: "Running",
            Self: { DNSName: "ghostman.example.ts.net." },
          });
        }
        return "";
      },
    },
    ...options,
  });
  instances.push(remote);

  const pairing = await remote.start();
  const pairingUrl = new URL(pairing.link);
  const token = new URLSearchParams(pairingUrl.hash.slice(1)).get("token");
  const origin = pairingUrl.origin;
  const pathPrefix = pairingUrl.pathname;
  const port = remote.getStatus().port;

  const pairResponse = await fetch(`http://127.0.0.1:${port}${pathPrefix}api/pair`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Tailscale-User-Login": "owner@example.com",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token }),
  });
  assert.equal(pairResponse.status, 200);
  const session = await pairResponse.json();

  return {
    remote,
    pairing,
    port,
    pathPrefix,
    origin,
    token: session.token,
  };
}

test("pairing is one-use, tailnet-bound, and runs approved plugins", async () => {
  const commands = [];
  const audit = [];
  let pluginRuns = 0;
  const context = await createPairedRemote({
    getApprovedPlugins: async () => [
      {
        id: "approved-tool",
        name: "Approved Tool",
        description: "A test plugin",
        inputs: [],
      },
    ],
    runPlugin: async ({ id, input }) => {
      pluginRuns += 1;
      assert.equal(id, "approved-tool");
      assert.deepEqual(input, {});
      return { title: "Approved Tool", data: "ran on PC" };
    },
    logRun: async (entry) => audit.push(entry),
    tailscale: {
      findCommand: async () => "mock-tailscale",
      run: async (args) => {
        commands.push(args);
        if (args[0] === "status") {
          return JSON.stringify({
            BackendState: "Running",
            Self: { DNSName: "ghostman.example.ts.net." },
          });
        }
        return "";
      },
    },
  });
  const { remote, port, pathPrefix, origin, token } = context;
  assert.equal(context.pairing.expiresInSeconds, 60);
  assert.match(context.pairing.qrCode, /^data:image\/png;base64,/);

  const wrongOrigin = await fetch(
    `http://127.0.0.1:${port}${pathPrefix}api/pair`,
    {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Tailscale-User-Login": "owner@example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: "unused" }),
    },
  );
  assert.equal(wrongOrigin.status, 403);

  const repeatedPair = await fetch(
    `http://127.0.0.1:${port}${pathPrefix}api/pair`,
    {
      method: "POST",
      headers: {
        Origin: origin,
        "Tailscale-User-Login": "owner@example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
    },
  );
  assert.equal(repeatedPair.status, 401);

  const pluginsResponse = await fetch(
    `http://127.0.0.1:${port}${pathPrefix}api/plugins`,
    { headers: sessionHeaders(context.token) },
  );
  assert.equal(pluginsResponse.status, 200);
  assert.equal((await pluginsResponse.json()).plugins[0].id, "approved-tool");

  const wrongUser = await fetch(
    `http://127.0.0.1:${port}${pathPrefix}api/plugins`,
    { headers: sessionHeaders(context.token, "other@example.com") },
  );
  assert.equal(wrongUser.status, 401);

  const runResponse = await fetch(
    `http://127.0.0.1:${port}${pathPrefix}api/run`,
    {
      method: "POST",
      headers: {
        ...sessionHeaders(context.token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: "approved-tool", input: {} }),
    },
  );
  assert.equal(runResponse.status, 200);
  assert.equal((await runResponse.json()).result.data, "ran on PC");
  assert.equal(pluginRuns, 1);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].success, true);

  await remote.stop();
  assert.equal(remote.getStatus().active, false);
  assert.ok(
    commands.some(
      (args) =>
        args[0] === "serve" &&
        args.at(-1) === "off" &&
        args.some((argument) => argument.startsWith("--set-path=/ghostman-")),
    ),
  );
});

test("local files are listed and opened only after per-file approval", async () => {
  const audit = [];
  let remoteFileAllowed = false;
  let remoteFileOpens = 0;
  const context = await createPairedRemote({
    getApprovedFiles: async () =>
      remoteFileAllowed
        ? [{ id: "local-file-1", name: "sample.png", size: 128 }]
        : [],
    readLocalFile: async (id) => ({
      file: { id, name: "sample.png", size: 4 },
      contents: Buffer.from("PNG!"),
    }),
    openLocalFile: async ({ id, user }) => {
      assert.equal(id, "local-file-1");
      assert.equal(user, "owner@example.com");
      remoteFileOpens += 1;
      return { opened: true };
    },
    logRun: async (entry) => audit.push(entry),
  });
  const { port, pathPrefix, token } = context;
  const headers = sessionHeaders(token);

  const initiallyEmpty = await fetch(
    `http://127.0.0.1:${port}${pathPrefix}api/files`,
    { headers },
  );
  assert.deepEqual((await initiallyEmpty.json()).files, []);

  const deniedOpen = await fetch(
    `http://127.0.0.1:${port}${pathPrefix}api/files/open`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "local-file-1" }),
    },
  );
  assert.equal(deniedOpen.status, 403);
  assert.equal(remoteFileOpens, 0);

  const deniedContent = await fetch(
    `http://127.0.0.1:${port}${pathPrefix}api/files/content?id=local-file-1`,
    { headers },
  );
  assert.equal(deniedContent.status, 403);
  const deniedDownload = await fetch(
    `http://127.0.0.1:${port}${pathPrefix}api/files/content?id=local-file-1&download=1`,
    { headers },
  );
  assert.equal(deniedDownload.status, 403);

  remoteFileAllowed = true;
  const listedFiles = await fetch(
    `http://127.0.0.1:${port}${pathPrefix}api/files`,
    { headers },
  );
  assert.deepEqual((await listedFiles.json()).files, [
    { id: "local-file-1", name: "sample.png", size: 128 },
  ]);

  const mobileContent = await fetch(
    `http://127.0.0.1:${port}${pathPrefix}api/files/content?id=local-file-1`,
    { headers },
  );
  assert.equal(mobileContent.status, 200);
  assert.equal(mobileContent.headers.get("content-type"), "image/png");
  assert.equal(await mobileContent.text(), "PNG!");

  const fileDownload = await fetch(
    `http://127.0.0.1:${port}${pathPrefix}api/files/content?id=local-file-1&download=1`,
    { headers },
  );
  assert.equal(fileDownload.status, 200);
  assert.match(
    fileDownload.headers.get("content-disposition"),
    /^attachment; filename\*=UTF-8''sample\.png$/,
  );
  assert.equal(await fileDownload.text(), "PNG!");

  const opened = await fetch(
    `http://127.0.0.1:${port}${pathPrefix}api/files/open`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "local-file-1" }),
    },
  );
  assert.equal(opened.status, 200);
  assert.equal(remoteFileOpens, 1);
  assert.equal(audit[0].fileId, "local-file-1");
  assert.equal(audit[0].success, true);
});

test("approved HTML files are served in a script sandbox without network access", async () => {
  const html = "<!doctype html><script>document.title='local test'</script>";
  const context = await createPairedRemote({
    getApprovedFiles: async () => [
      { id: "html-file-1", name: "index.html", size: Buffer.byteLength(html) },
    ],
    readLocalFile: async () => ({
      file: { id: "html-file-1", name: "index.html", size: Buffer.byteLength(html) },
      contents: Buffer.from(html),
    }),
  });

  const ticketResponse = await fetch(
    `http://127.0.0.1:${context.port}${context.pathPrefix}api/files/preview-ticket`,
    {
      method: "POST",
      headers: {
        ...sessionHeaders(context.token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: "html-file-1" }),
    },
  );
  assert.equal(ticketResponse.status, 200);
  const previewUrl = new URL((await ticketResponse.json()).url);
  const previewPath = `${previewUrl.pathname}${previewUrl.search}`;
  const response = await fetch(
    `http://127.0.0.1:${context.port}${previewPath}`,
    { headers: { "Tailscale-User-Login": "owner@example.com" } },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /sandbox allow-scripts/);
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(await response.text(), html);

  const secondTicket = await fetch(
    `http://127.0.0.1:${context.port}${context.pathPrefix}api/files/preview-ticket`,
    {
      method: "POST",
      headers: {
        ...sessionHeaders(context.token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: "html-file-1" }),
    },
  );
  assert.equal(secondTicket.status, 200);

  const replayedTicket = await fetch(
    `http://127.0.0.1:${context.port}${previewPath}`,
    { headers: { "Tailscale-User-Login": "owner@example.com" } },
  );
  assert.equal(replayedTicket.status, 401);
});

test("approved site folders serve relative assets only while remote access is enabled", async () => {
  let approved = true;
  const resources = {
    "site/index.html": Buffer.from(
      "<!doctype html><link rel='stylesheet' href='css/site.css'><script src='js/app.js'></script>",
    ),
    "site/css/site.css": Buffer.from("body { color: white; }"),
    "site/js/app.js": Buffer.from("document.title = 'site';"),
    "site/assets/logo.svg": Buffer.from("<svg></svg>"),
  };
  const context = await createPairedRemote({
    getApprovedFiles: async () =>
      approved
        ? [
            {
              id: "local-site-1",
              name: "sample-site",
              size: Object.values(resources).reduce(
                (total, contents) => total + contents.length,
                0,
              ),
              kind: "folder",
              entryPath: "site/index.html",
              contents: Object.entries(resources).map(([filePath, contents]) => ({
                path: filePath,
                size: contents.length,
              })),
            },
          ]
        : [],
    readLocalSiteFile: async (id, relativePath) => {
      assert.equal(id, "local-site-1");
      if (relativePath.includes("..")) {
        throw Object.assign(new Error("Percorso del sito non valido."), {
          statusCode: 400,
        });
      }
      const contents = resources[relativePath];
      if (!contents) {
        throw Object.assign(new Error("Risorsa del sito non trovata."), {
          statusCode: 404,
        });
      }
      return {
        file: { id, name: relativePath.split("/").at(-1) },
        contents,
      };
    },
  });
  const headers = sessionHeaders(context.token);
  const approvedFilesResponse = await fetch(
    `http://127.0.0.1:${context.port}${context.pathPrefix}api/files`,
    { headers },
  );
  const { files } = await approvedFilesResponse.json();
  assert.equal(files[0].contents.length, Object.keys(resources).length);
  const ticketResponse = await fetch(
    `http://127.0.0.1:${context.port}${context.pathPrefix}api/files/preview-ticket`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "local-site-1" }),
    },
  );
  assert.equal(ticketResponse.status, 200);
  const siteUrl = new URL((await ticketResponse.json()).url);
  assert.match(
    siteUrl.pathname,
    /\/api\/files\/site\/[a-f0-9]{64}\/site\/index\.html$/,
  );

  const siteResponse = await fetch(
    `http://127.0.0.1:${context.port}${siteUrl.pathname}`,
    { headers: { "Tailscale-User-Login": "owner@example.com" } },
  );
  assert.equal(siteResponse.status, 200);
  assert.match(siteResponse.headers.get("content-type"), /text\/html/);
  assert.match(
    siteResponse.headers.get("content-security-policy"),
    /sandbox allow-scripts/,
  );
  assert.match(
    siteResponse.headers.get("content-security-policy"),
    /connect-src 'self'/,
  );
  assert.match(
    siteResponse.headers.get("content-security-policy"),
    /media-src 'self' https:\/\/cdn\.discordapp\.com/,
  );
  assert.equal((await siteResponse.text()).includes("css/site.css"), true);

  const assetPrefix = siteUrl.pathname.slice(
    0,
    siteUrl.pathname.lastIndexOf("/") + 1,
  );
  const cssResponse = await fetch(
    `http://127.0.0.1:${context.port}${assetPrefix}css/site.css`,
    { headers: { "Tailscale-User-Login": "owner@example.com" } },
  );
  assert.equal(cssResponse.status, 200);
  assert.equal(cssResponse.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(await cssResponse.text(), "body { color: white; }");

  const cssDownload = await fetch(
    `http://127.0.0.1:${context.port}${context.pathPrefix}api/files/site-content?id=local-site-1&path=${encodeURIComponent("site/css/site.css")}`,
    { headers },
  );
  assert.equal(cssDownload.status, 200);
  assert.equal(
    cssDownload.headers.get("content-type"),
    "application/octet-stream",
  );
  assert.match(
    cssDownload.headers.get("content-disposition"),
    /^attachment; filename\*=UTF-8''site\.css$/,
  );
  assert.equal(await cssDownload.text(), "body { color: white; }");

  const traversalDownload = await fetch(
    `http://127.0.0.1:${context.port}${context.pathPrefix}api/files/site-content?id=local-site-1&path=${encodeURIComponent("../outside.txt")}`,
    { headers },
  );
  assert.equal(traversalDownload.status, 400);

  const scriptResponse = await fetch(
    `http://127.0.0.1:${context.port}${assetPrefix}js/app.js`,
    { headers: { "Tailscale-User-Login": "owner@example.com" } },
  );
  assert.equal(scriptResponse.status, 200);
  assert.equal(
    scriptResponse.headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );

  const otherTailnetUser = await fetch(
    `http://127.0.0.1:${context.port}${assetPrefix}assets/logo.svg`,
    { headers: { "Tailscale-User-Login": "other@example.com" } },
  );
  assert.equal(otherTailnetUser.status, 401);

  approved = false;
  const revokedAsset = await fetch(
    `http://127.0.0.1:${context.port}${assetPrefix}css/site.css`,
    { headers: { "Tailscale-User-Login": "owner@example.com" } },
  );
  assert.equal(revokedAsset.status, 403);
});

test("Serve disabled errors expose the exact Tailscale setup link", async () => {
  const settingsUrl =
    "https://login.tailscale.com/f/serve?node=nwzzPtdKfG11CNTRL";
  const remote = createRemoteAccess({
    getApprovedPlugins: async () => [],
    runPlugin: async () => ({}),
    logRun: async () => {},
    tailscale: {
      findCommand: async () => "mock-tailscale",
      run: async (args) => {
        if (args[0] === "status") {
          return JSON.stringify({
            BackendState: "Running",
            Self: { DNSName: "ghostman.example.ts.net." },
          });
        }
        throw Object.assign(new Error("Tailscale command failed"), {
          stdout: `Serve is not enabled on your tailnet.\nTo enable, visit:\n${settingsUrl}`,
          stderr: "",
        });
      },
    },
  });
  instances.push(remote);

  await assert.rejects(
    remote.start(),
    (error) =>
      error.message.includes("Tailscale Serve non è abilitato") &&
      error.message.includes(settingsUrl),
  );
  assert.equal(remote.getStatus().active, false);
});
