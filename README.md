# Gloryhole

Branded for Wookey Films, using the logo, monochrome palette, and condensed typography from [wookeyfilms.com](https://www.wookeyfilms.com). Browser fonts and the logo are served locally; visitors do not contact a font service.

## Transfer reports

Every new sending session generates a text report covering successful, failed, cancelled, and interrupted files. It contains byte counts, UTC timestamps, confirmed SHA-256 checksums, and average rates for completed files. Senders can optionally add a name; names are self-reported rather than verified identities.

On the sender page, scroll to the report area below the main upload controls. By default the browser is asked to download the report after the session finishes. **Download latest report** is always available after generation in case the browser blocks the automatic download. **Choose report folder** lets supported browsers save to a folder you grant access to; choose the originals’ folder to save the report beside them. Browsers do not reveal an original file’s parent directory automatically.

On the receiver, reports are saved in the session’s selected destination, with a separate report per sender session. The control panel lists reports under the history area and provides private report downloads. If a destination is unavailable, a private local record is kept for retrying delivery. Reconnect and reselect the original destination if its mount identity changed.

Reports begin before any file upload so a rejected file still appears. An abandoned session is marked interrupted after ten minutes without an active transfer, or when the receiver restarts. A sender attempt that cannot contact the receiver can only generate a local report. Closing a browser abruptly cannot force it to download a report, and a disconnected drive cannot receive a report until it is writable again.

Current invitation links are unchanged; no third-party shortening service is enabled. See [Going live](GOING-LIVE.md) for production hosting, performance, and end-to-end encryption recommendations. End-to-end encryption has not been added in this update.

## Transfer speed and destination

The sender and receiver show live transfer speed and estimated time remaining. Speed is a rolling measurement of transferred bytes, shown in decimal MB/s or KB/s; the estimate changes as the connection speed changes. The receiver shows a separate verification/saving phase while the file is written to its final destination.

In **Receive here**, click the destination card or its path to open the native macOS folder picker. Select a folder on your Mac or a mounted drive and choose **Receive here**. The selection is saved automatically and remembered across launches. Cancelling leaves the current destination unchanged. **Enter a path manually** remains available as a fallback; expand it, enter a full folder path, and choose **Save path**. Changes apply to future transfers and are blocked while files are pending.

The receive panel is visually separate from the request form. Its status indicator, border, and live progress turn green while files are receiving or saving. The sender also sees green progress while an upload is in process.

## Shorter invitations

New links use a 22-character, randomly generated 128-bit private code with no extra `request=` text. Earlier 43-character codes are still accepted. Only code hashes are persisted. Expiry, revocation, and size limits apply to both formats.

**Copy link** includes a readable “Send files to Wookey Films” hyperlink when pasted into an email editor that supports formatted text, and the short URL when pasted into a plain-text message. The temporary `trycloudflare.com` hostname is assigned by the connection service and remains unchanged by this shortening. A stable branded hostname requires separate domain/tunnel configuration.

Mounted network drives are supported, for example `/Volumes/Studio/Incoming`. Connect the share in Finder first and use a folder your Mac can write to. The app does not mount shares or store network credentials. If a destination disappears or changes during an upload, the receiver refuses to confirm delivery; it does not create a replacement folder or fall back to the original inbox. Network-drive performance and availability depend on that drive and connection.

Incoming data is still staged on the Mac before being copied to the selected destination. Keep enough local free space for pending files, even when using a network drive. Large files may spend additional time in “Verifying & saving”; leave the sender page open until it says “Received”. Existing received files are not moved when the destination changes.

The main controls and active transfers are arranged for a 16:9 laptop screen. Request and received-file history appear below the first screen; on phones, controls stack vertically.

A personal file-request inbox: send someone a link, they drag files into a browser page, and the files land on your Mac. Senders do not install an app or create an account. This is a separate receiver; it does not modify Blip or add entries to Blip’s history.

## Open it

Double-click **Open Gloryhole.command**. It starts the receiver, keeps your Mac awake against idle sleep, opens the local control panel, and makes an outbound Cloudflare Quick Tunnel to the upload listener. Keep its Terminal window open. Closing the lid, manually sleeping, shutting down, or losing internet can interrupt uploads.

In the control panel:

1. Wait for the public address to appear.
2. Give a request a label, expiry, and size limits.
3. Create the link and copy it to the sender. The complete link is displayed once; create another if you lose it.
4. Files appear in `data/Received` beside this README. Their names have a unique prefix to avoid collisions.
5. Close a link any time to stop further uploads, including uploads in progress.

The upload link is a permission to send files, so share it only with intended senders. Refreshing the sender page after it removes the secret from the address bar requires opening the original link again.

## Connection and privacy

The control panel listens only on `127.0.0.1:48731`. The upload listener is separate, on `127.0.0.1:48732`. Only the upload listener is passed to the tunnel. No router port forwarding is required. Public routes provide no file listing, downloads, or administration.

Browser-to-Cloudflare traffic uses HTTPS; the connection helper creates an outbound tunnel to Cloudflare. Cloudflare terminates HTTPS and is a trusted intermediary: this version does **not** provide application-level end-to-end encryption that hides file contents from Cloudflare. Files are written to your Mac without application-level encryption at rest; Mac FileVault can protect the disk. There is no intentional cloud file storage in this app.

Quick Tunnels are for testing and have no production availability guarantee. Their address changes each run; make fresh links after restarting. For ongoing use, configure a stable HTTPS tunnel/domain. See [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/). Uploads use 8 MiB chunks to stay below [per-request upload limits](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/).

The first version requires the Mac to be online. It does not queue files in cloud storage. Interrupted files are not shown as received; retry from the beginning. A lost confirmation can mean a file arrived despite a sender error, so check the receiver before retrying.

## Protections and defaults

- Random 128-bit upload capabilities for new links; legacy 256-bit capabilities remain accepted. Only token hashes are persisted. Tokens start in URL fragments, then stay in sender-page memory and Authorization headers.
- Expiry up to seven days, immediate revocation, default 10 GiB per file / 25 GiB per link / 100 files per link.
- A maximum of four pending file sessions globally, two per link; idle sessions expire after ten minutes. Size allowances are reserved while files are pending.
- 1 GiB free-disk headroom, private temporary files, filename normalization, unique stored names, no overwrite of existing files, SHA-256 receipts.
- Session-authenticated local administration, same-origin checks, host validation, CSP, no third-party browser scripts, no referrer disclosure.
- Files are never opened or executed automatically. This is not a malware scanner.
- A single receiver process can use an inbox folder. Interrupted partial files are removed on the next start.

This is a tested prototype, not a security-audited product. Do not expose the administration port through a tunnel. Treat the local control-panel URL as private.

## Runtime and development

Requires Node.js 22+. No npm packages are required. The Mac launcher can use the Node runtime already bundled on this computer. The connection helper is downloaded from Cloudflare’s official GitHub releases and verified against the published SHA-256 asset digest; it is kept inside this folder, not installed system-wide.

Run `node setup.mjs` to fetch the helper, `node online.mjs --open` to run online, or `node server.mjs` for local-only operation. `node --test test/receiver.test.mjs` runs integration checks against temporary inbox folders.

Optional environment variables: `INBOX_DATA` (absolute inbox directory), `INBOX_ADMIN_PORT`, `INBOX_UPLOAD_PORT`, `INBOX_PUBLIC_URL` (existing HTTPS tunnel origin). These are inherited by the launcher. Do not run this app as an administrator.
