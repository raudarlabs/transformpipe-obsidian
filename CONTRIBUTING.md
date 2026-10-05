# Contributing

Issues and pull requests are welcome at
[raudarlabs/transformpipe-obsidian](https://github.com/raudarlabs/transformpipe-obsidian).

**A bug.** Say what you ran, what you expected and what happened, with your Obsidian version and
platform. If a note did not publish as it looks in Obsidian, a short note that shows it helps
most — leave out anything private.

**A change.** Open an issue first for anything bigger than a fix, so we can agree on it before
you spend the time. Then:

```
npm install
npm run dev     # rebuilds main.js on every change
npm test        # the note pipeline and PKCE
npm run build   # type-check and a minified main.js
```

`npm run build` and `npm test` have to pass. Keep to what the code already does: no default
hotkeys, every network call through `requestUrl`, nothing sent until somebody runs a command, and
the sign-in kept in Obsidian's secret storage, never in `data.json`.

**A security problem.** Open an issue that says only that you have one, without the details, and
we will agree on a private way to send them.
