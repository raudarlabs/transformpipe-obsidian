# TransformPipe for Obsidian

Publish a note as a page with a link — and keep the same link after every edit.

Run **Publish note** and the note becomes a clean, readable page on
[TransformPipe](https://transformpipe.com), with the link copied for you. Edit the note and run it
again: the page updates, and the link you already sent keeps working. Share a note with named
people instead of a public link, make it private again, or export it as Word or PDF into your
vault.

## Commands

All of them are in the command palette; none has a hotkey until you give it one.

| Command | What it does |
| --- | --- |
| Publish note | The first time, makes a page shared by link and copies the link. After that, updates the same page; the previous text is kept as a revision on TransformPipe (the newest ten). |
| Copy link | Copies the page's link. |
| Share with people… | Shares the note with the email addresses you give instead. Only they can open it, once signed in; each is emailed the link. |
| Make private | Stops sharing. The old link stops working for good; publishing again makes a new one. |
| Open in TransformPipe | Opens the document in TransformPipe in your browser. |
| Export as Word / Export as PDF | Saves `<note>.docx` or `<note>.pdf` next to the note. |

The plugin remembers where a note was published in three front-matter fields —
`transformpipe_id`, `transformpipe_url` and `transformpipe_share` — and leaves them out of what it
sends.

## What is published

The note's Markdown, as Obsidian writes it: wikilinks, callouts, highlights, tables, code,
footnotes and Mermaid diagrams are all understood by TransformPipe. Pictures from your vault
(`![[picture.png]]` or `![](attachments/picture.png)`) are carried inside the page, up to 1 MB each
and 2 MB per note; a bigger one stays a link and the plugin tells you which. A note can be up to
4 MB.

Not yet: an embedded note (`![[Another note]]`) is not inlined, and a link to another published
note does not point at its page. Both are planned.

## Sign-in

**This plugin needs a free TransformPipe account.** Open the plugin's settings and press **Sign
in**: TransformPipe's sign-in opens in your browser, and after you approve, the browser hands you
back to Obsidian. There is no API key to paste.

The sign-in is kept in Obsidian's secret storage — your system keychain — not in the plugin's
settings file, so it does not travel with your vault when the vault is synced. **Sign out** in the
same place hands it back, and it stops working on TransformPipe too. You can also disconnect
Obsidian from TransformPipe's account menu, under *MCP connector*.

Requires Obsidian 1.11.4 or later. Works on desktop and mobile.

## Network use and privacy

The plugin talks to one server, `https://transformpipe.com`, and only when you run a command:

- **Publish, Share and Export** send the note's text and the pictures it embeds.
- **Copy link** and **Open** read the document's details.
- **Settings** show the account's email and how much room is left.

TransformPipe keeps what you publish in your account until you delete it, and serves shared pages
to whoever has the link (or to the people you named). It does not read your documents or use them
to train any model. There is no telemetry and no analytics in this plugin. Details:
[privacy](https://transformpipe.com/privacy) · [terms](https://transformpipe.com/terms).

The text is not end-to-end encrypted: TransformPipe has to read a note to draw it as a page and to
build Word and PDF from it.

## Installing

From Obsidian: **Settings → Community plugins → Browse**, search for *TransformPipe*.

Before it is listed, you can install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat):
add `raudarlabs/transformpipe-obsidian` as a beta plugin.

## Development

```sh
npm install
npm run dev     # rebuilds main.js on every change
npm test        # the note pipeline and PKCE
npm run build   # type-check and a minified main.js
```

Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/transformpipe/`
and enable the plugin. Releases are built by GitHub Actions from a tag that matches the version in
`manifest.json`.

## License

MIT — see [LICENSE](LICENSE). Made by [Raudar Labs](https://transformpipe.com/about).
