import {
  type App,
  MarkdownView,
  Modal,
  normalizePath,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  type SettingDefinitionItem,
  TFile,
} from 'obsidian';
import { Api, ApiError, type RemoteDocument } from './api.ts';
import { Auth, PROTOCOL_ACTION } from './auth.ts';
import { DOCUMENT_BYTES, documentName, KEYS, prepareNote } from './note.ts';

interface Settings {
  /** Where TransformPipe is. Only somebody running their own copy changes this. */
  host: string;
}

const DEFAULTS: Settings = { host: 'https://transformpipe.com' };

export default class TransformPipePlugin extends Plugin {
  settings: Settings = DEFAULTS;
  auth!: Auth;
  private settingsTab: SettingsTab | null = null;
  api!: Api;

  async onload() {
    this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };

    const host = () => this.settings.host.replace(/\/+$/, '');

    this.auth = new Auth(this.app, host);
    this.api = new Api(this.auth, host);

    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, async (params) => {
      const result = await this.auth.handleRedirect(params);

      new Notice(result.message);

      // A sign-in finished by an Obsidian that was reloaded meanwhile has no settings tab waiting
      // on it; the one on screen, if any, is redrawn so it shows the account.
      if (result.ok) {
        this.settingsTab?.display();
      }
    });

    /*
     * No default hotkeys, on purpose: a plugin that claims a key can take one somebody already
     * uses. Each command asks for a note being open, so the palette only offers them then.
     */
    const onNote = (run: (file: TFile) => Promise<void>) => (checking: boolean) => {
      const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;

      if (!file) {
        return false;
      }

      if (!checking) {
        run(file).catch((cause) => {
          new Notice(messageOf(cause), 8000);
        });
      }

      return true;
    };

    this.addCommand({ id: 'publish', name: 'Publish note', checkCallback: onNote((file) => this.publish(file)) });
    this.addCommand({ id: 'copy-link', name: 'Copy link', checkCallback: onNote((file) => this.copyLink(file)) });
    this.addCommand({
      id: 'share-with-people',
      name: 'Share with people…',
      checkCallback: onNote(async (file) => new PeopleModal(this.app, (emails) => this.shareWith(file, emails)).open()),
    });
    this.addCommand({
      id: 'make-private',
      name: 'Make private',
      checkCallback: onNote(async (file) =>
        new ConfirmModal(
          this.app,
          'Stop sharing this note?',
          'Everyone who has the link loses access, for good. Publish again and you get a new link; this one does not come back.',
          'Make private',
          () => this.makePrivate(file)
        ).open()
      ),
    });
    this.addCommand({ id: 'open', name: 'Open in browser', checkCallback: onNote((file) => this.openRemote(file)) });
    this.addCommand({ id: 'export-word', name: 'Export as Word', checkCallback: onNote((file) => this.export(file, 'docx')) });
    this.addCommand({ id: 'export-pdf', name: 'Export as PDF', checkCallback: onNote((file) => this.export(file, 'pdf')) });

    this.settingsTab = new SettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** The id and link this note was published under, from its front matter. */
  private remoteOf(file: TFile): { id: string | null; url: string | null } {
    const front: Record<string, unknown> = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const id = front[KEYS.id];
    const url = front[KEYS.url];

    return {
      id: typeof id === 'string' ? id : null,
      url: typeof url === 'string' ? url : null,
    };
  }

  /** The note as TransformPipe should receive it — see note.ts. */
  private async prepared(file: TFile): Promise<string> {
    const raw = await this.app.vault.read(file);
    const result = await prepareNote(raw, {
      resolve: (link) => {
        const target = this.app.metadataCache.getFirstLinkpathDest(link, file.path);

        return target ? { path: target.path, extension: target.extension } : null;
      },
      read: (path) => {
        const target = this.app.vault.getFileByPath(path);

        return target ? this.app.vault.readBinary(target) : Promise.reject(new Error(`No file at ${path}`));
      },
    });

    if (result.skipped.length > 0) {
      new Notice(
        `${result.skipped.length} picture${result.skipped.length === 1 ? ' was' : 's were'} too big to carry inside and stayed as links: ${result.skipped.join(', ')}`,
        8000
      );
    }

    if (new TextEncoder().encode(result.markdown).length > DOCUMENT_BYTES) {
      throw new Error('This note, with its pictures, is over 4 MB — the limit for one document.');
    }

    return result.markdown;
  }

  private async remember(file: TFile, document: RemoteDocument) {
    await this.app.fileManager.processFrontMatter(file, (front: Record<string, unknown>) => {
      front[KEYS.id] = document.id;

      if (document.share.url) {
        front[KEYS.url] = document.share.url;
      } else {
        delete front[KEYS.url];
      }

      front[KEYS.share] = document.share.mode;
    });
  }

  /*
   * The first time, a new document shared by link. After that, the same document with the new
   * text, so the link already sent shows the edit. A document deleted on the site is published
   * afresh, under a new link, and the notice says so.
   */
  async publish(file: TFile) {
    const markdown = await this.prepared(file);
    const name = documentName(file.basename);
    const { id } = this.remoteOf(file);
    let document: RemoteDocument;
    let note = 'Published — the link is copied.';

    if (id) {
      try {
        const answer = await this.api.update(id, name, markdown);

        document = answer.document;
        note = answer.changed ? 'Updated — same link, copied again.' : 'Nothing changed since the last publish. The link is copied.';

        if (document.share.mode === 'private') {
          document = { ...document, share: { ...document.share, ...(await this.api.share(document.id, { mode: 'link' })) } };
          note = 'Updated and shared by link — the link is copied.';
        }
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 404) {
          throw cause;
        }

        document = await this.api.publish(name, markdown, 'link');
        note = 'The earlier copy was deleted on TransformPipe, so this is a new link. It is copied.';
      }
    } else {
      document = await this.api.publish(name, markdown, 'link');
    }

    await this.remember(file, document);

    if (document.share.url) {
      await navigator.clipboard.writeText(document.share.url);
    }

    new Notice(note);
  }

  async copyLink(file: TFile) {
    const { id, url } = this.remoteOf(file);

    if (!id) {
      throw new Error('This note is not published yet. Run “Publish note” first.');
    }

    const link = url ?? (await this.api.get(id)).share.url;

    if (!link) {
      throw new Error('This note is private on TransformPipe, so there is no link. Run “Publish note” to share it.');
    }

    await navigator.clipboard.writeText(link);
    new Notice('Link copied.');
  }

  async shareWith(file: TFile, emails: string[]) {
    let { id } = this.remoteOf(file);

    if (!id) {
      // Not on TransformPipe yet: saved privately first, then shared with the addresses only.
      const created = await this.api.publish(documentName(file.basename), await this.prepared(file), null);

      id = created.id;
    }

    const state = await this.api.share(id, { mode: 'people', emails });

    await this.remember(file, { ...(await this.api.get(id)), share: { ...state } });
    new Notice(
      state.notified && state.notified.length > 0
        ? `Shared. ${state.notified.join(', ')} ${state.notified.length === 1 ? 'was' : 'were'} emailed the link.`
        : 'Shared with the people on the list.'
    );
  }

  async makePrivate(file: TFile) {
    const { id } = this.remoteOf(file);

    if (!id) {
      throw new Error('This note is not on TransformPipe, so there is nothing to make private.');
    }

    await this.api.share(id, { mode: 'private' });
    await this.app.fileManager.processFrontMatter(file, (front: Record<string, unknown>) => {
      delete front[KEYS.url];
      front[KEYS.share] = 'private';
    });
    new Notice('Private. The old link no longer opens.');
  }

  async openRemote(file: TFile) {
    const { id } = this.remoteOf(file);

    if (!id) {
      throw new Error('This note is not published yet. Run “Publish note” first.');
    }

    window.open(`${this.settings.host.replace(/\/+$/, '')}/?doc=${encodeURIComponent(id)}`);
  }

  /*
   * Built on the server from the note's latest text: a published note is updated first, and one
   * that is not on TransformPipe yet is saved privately, so the file is the note as it is now.
   */
  async export(file: TFile, format: 'docx' | 'pdf') {
    const markdown = await this.prepared(file);
    const name = documentName(file.basename);
    let { id } = this.remoteOf(file);

    if (id) {
      await this.api.update(id, name, markdown);
    } else {
      const created = await this.api.publish(name, markdown, null);

      id = created.id;
      await this.remember(file, created);
    }

    const bytes = await this.api.download(id, format);
    const folder = file.parent?.path && file.parent.path !== '/' ? `${file.parent.path}/` : '';
    const path = normalizePath(`${folder}${file.basename}.${format}`);
    const existing = this.app.vault.getFileByPath(path);

    if (existing) {
      await this.app.vault.modifyBinary(existing, bytes);
    } else {
      await this.app.vault.createBinary(path, bytes);
    }

    new Notice(`Saved ${path}.`);
  }
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The one question asked before something that cannot be taken back. */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly body: string,
    private readonly action: string,
    private readonly onConfirm: () => Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    this.setTitle(this.heading);
    this.contentEl.createEl('p', { text: this.body, cls: 'transformpipe-warning' });

    const actions = this.contentEl.createDiv({ cls: 'transformpipe-modal-actions' });
    const keep = actions.createEl('button', { text: 'Keep sharing' });
    const go = actions.createEl('button', { text: this.action, cls: 'mod-warning' });

    keep.addEventListener('click', () => this.close());
    go.addEventListener('click', () => {
      this.close();
      this.onConfirm().catch((cause) => {
        new Notice(messageOf(cause), 8000);
      });
    });
    keep.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Addresses to share a note with. Each is emailed the link once, by TransformPipe. */
class PeopleModal extends Modal {
  constructor(
    app: App,
    private readonly onShare: (emails: string[]) => Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    this.setTitle('Share with people');
    this.contentEl.createEl('p', {
      text: 'Only these addresses can open it, once signed in. Each is emailed the link.',
      cls: 'transformpipe-muted',
    });

    let value = '';

    new Setting(this.contentEl).setName('Email addresses').setDesc('Separated by commas or spaces').addText((text) =>
      text.setPlaceholder('anna@example.com, ben@example.com').onChange((next) => {
        value = next;
      })
    );

    const actions = this.contentEl.createDiv({ cls: 'transformpipe-modal-actions' });
    const cancel = actions.createEl('button', { text: 'Cancel' });
    const share = actions.createEl('button', { text: 'Share', cls: 'mod-cta' });

    cancel.addEventListener('click', () => this.close());
    share.addEventListener('click', () => {
      const emails = value.split(/[\s,;]+/).map((one) => one.trim()).filter((one) => one.includes('@'));

      if (emails.length === 0) {
        new Notice('Add at least one email address.');

        return;
      }

      this.close();
      this.onShare(emails).catch((cause) => {
        new Notice(messageOf(cause), 8000);
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

const WHAT_IS_SENT =
  'Publishing sends the note’s text and the pictures it embeds from the vault to TransformPipe, which keeps them in your account. Nothing is sent until you run a command.';
const SERVER_NOTE = 'Only change this if you run your own TransformPipe.';

/*
 * Two ways of drawing the same three rows. Obsidian 1.13 reads `getSettingDefinitions()`, which is
 * what puts these settings in its settings search; anything older never calls it and draws the tab
 * through `display()` instead. The account row is the same code either way.
 */
class SettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: TransformPipePlugin
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { name: 'Account', aliases: ['sign in', 'sign out'], render: (setting) => this.account(setting) },
      { name: 'What is sent', desc: WHAT_IS_SENT },
      {
        name: 'Server',
        desc: SERVER_NOTE,
        control: { type: 'text', key: 'host', defaultValue: DEFAULTS.host, placeholder: DEFAULTS.host },
      },
    ];
  }

  async setControlValue(key: string, value: unknown) {
    if (key === 'host') {
      this.plugin.settings.host = (typeof value === 'string' && value.trim()) || DEFAULTS.host;
      await this.plugin.saveSettings();
    }
  }

  /** Obsidian before 1.13. */
  display() {
    this.drawByHand();
  }

  private drawByHand() {
    const { containerEl } = this;

    containerEl.empty();
    this.account(new Setting(containerEl));
    new Setting(containerEl).setName('What is sent').setDesc(WHAT_IS_SENT);
    new Setting(containerEl)
      .setName('Server')
      .setDesc(SERVER_NOTE)
      .addText((text) =>
        text.setValue(this.plugin.settings.host).onChange(async (value) => {
          await this.setControlValue('host', value);
        })
      );
  }

  /*
   * The account row draws itself again after a sign-in or sign-out — on the row it already is, so
   * the same code works under either way of drawing the tab.
   */
  private account(account: Setting) {
    account.clear().setName('Account');

    if (!this.plugin.auth.supported) {
      account.setDesc('Signing in needs Obsidian 1.11.4 or later, which keeps the sign-in in the system keychain.');
    } else if (this.plugin.auth.signedIn) {
      account.setDesc('Signed in.');
      /*
       * Braces, not an arrow's value: Obsidian's Setting has a `then` method, so a promise handed
       * one back takes it for another promise and calls that `then`, which hands the Setting back,
       * for ever. Returning `account.setDesc(...)` here froze Obsidian the moment this tab opened.
       */
      this.plugin.api
        .usage()
        .then((usage) => {
          account.setDesc(
            `Signed in as ${usage.email ?? 'your account'} · ${usage.documents} of ${usage.limits.documents} documents · ${(usage.bytes / 1048576).toFixed(1)} of ${(usage.limits.bytes / 1048576).toFixed(0)} MB`
          );
        })
        .catch((cause) => {
          account.setDesc(messageOf(cause));
        });
      account.addButton((button) =>
        button.setButtonText('Sign out').onClick(async () => {
          await this.plugin.auth.signOut();
          this.account(account);
        })
      );
    } else {
      account.setDesc('Publishing needs a free TransformPipe account. Sign in opens it in your browser.');
      account.addButton((button) =>
        button
          .setButtonText('Sign in')
          .setCta()
          .onClick(async () => {
            const ok = await this.plugin.auth.signIn().catch((cause) => {
              new Notice(messageOf(cause), 8000);

              return false;
            });

            if (ok) {
              this.account(account);
            }
          })
      );
    }
  }
}
