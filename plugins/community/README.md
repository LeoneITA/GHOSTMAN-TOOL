# GHOSTMAN Community Plugins

`index.html` is a static, responsive catalog suitable for Netlify. It reads
`plugins.json` from the same folder. The catalog starts empty; no fake Discord
message or unreviewed download is shown.

When this catalog is bundled with GHOSTMAN, the Plugin manager opens its HTML
page with the **Apri sito** button. The website itself is a catalog: installing
a Python plugin and granting it remote access are separate, user-confirmed
actions in the desktop app.

To open the bundled catalog on a paired phone, choose **Consenti remoto** for
the HTML plugin in the Plugin manager, then start **Accesso mobile**. The
catalog appears in the phone's local-sites list and is served only to the
authenticated Tailscale session in a sandboxed preview. Revoke access from the
same button when it is no longer needed.

To publish a plugin, add an object to the `plugins` array:

```json
{
  "id": "mio-plugin",
  "name": "Mio plugin",
  "version": "1.0.0",
  "category": "Community",
  "description": "Descrizione di cosa fa il plugin.",
  "minAppVersion": "0.3.3",
  "authorName": "NomeDiscord",
  "authorDiscordId": "123456789012345678",
  "discordMessage": "https://discord.com/channels/ID_SERVER/ID_CANALE/ID_MESSAGGIO",
  "videoUrl": "https://cdn.discordapp.com/attachments/.../anteprima.mp4",
  "downloadUrl": "https://github.com/OWNER/REPOSITORY/releases/download/v1.0.0/mio-plugin.zip"
}
```

`authorName` shows the plugin author's Discord name; when `authorDiscordId` is
provided, the name links to that Discord profile. `discordMessage` must be the
permalink to the post (use **Copy Message Link** in Discord). The website does
not read the post automatically, so copy the direct video attachment URL into
`videoUrl` and the direct ZIP/RAR attachment URL into `downloadUrl` yourself.
Only direct MP4, WebM, or MOV links are shown as video previews. Discord CDN
attachment URLs are signed and can expire; a GitHub Release asset is a more
reliable long-term download link.

The **Installa con GHOSTMAN** button opens the Windows app using the
`ghostman://install` link. GHOSTMAN downloads the ZIP/RAR, checks that its
manifest ID matches the catalog entry, and asks for confirmation before
installing. The protocol is registered by the GHOSTMAN installer; after adding
it, rebuild and reinstall the Windows app. If GHOSTMAN is not installed or the
protocol is not registered on that PC, use **Scarica archivio** and install
from the Plugin manager instead. The app accepts archives up to 100 MiB and
extracts at most 2,000 files / 100 MiB of content.

Catalog URLs are restricted to HTTPS Discord/GitHub hosts. Rendered text is
never treated as HTML. To show an invite at the top of the page, set
`discordInvite` to the community invite URL.

Package each Python plugin as a ZIP or RAR whose top-level extracted folder contains
`manifest.json` and the Python entry file declared by `entry`. The manifest
must use a unique lowercase `id` and a three-part version such as `1.0.0`.
GHOSTMAN currently installs Python plugins only. The app's **Plugin manager →
Installa plugin da cartella** button asks the user to select the extracted
plugin directory. The website's **Installa con GHOSTMAN** button can download
the linked ZIP/RAR, validate the package and manifest ID, ask for confirmation,
then install it. Replacing an already installed community plugin also requires
confirmation.

Python plugins run with the user's Windows account permissions and are not
sandboxed. Review the source and trust the author before approving a plugin.
After installation, restart GHOSTMAN if the plugin list has not refreshed.
