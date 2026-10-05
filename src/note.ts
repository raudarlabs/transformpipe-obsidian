/*
 * A note as TransformPipe should receive it.
 *
 * Three things change on the way out, and nothing else. The plugin's own front-matter fields come
 * out — they say where the note was published, which is not part of the note. Pictures from the
 * vault go in, as data: URIs, because the server has no other way to reach a file on this device.
 * And that is all: wikilinks, callouts, highlights and the rest are read by TransformPipe's
 * converter as Obsidian writes them.
 *
 * Pure functions with the vault passed in, so they can be tested without Obsidian.
 */

/** The front-matter keys this plugin writes, and strips before sending. */
export const KEYS = {
  id: 'transformpipe_id',
  url: 'transformpipe_url',
  share: 'transformpipe_share',
} as const;

/** The server's limits for pictures carried inside a document (shared/limits.ts). */
export const PICTURE_BYTES = 1024 * 1024;
export const PICTURES_BYTES = 2 * 1024 * 1024;
/** And for the document itself. */
export const DOCUMENT_BYTES = 4 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

/** What the pipeline needs from the vault, so a test can hand in a map instead. */
export interface VaultReader {
  /** The file a link resolves to from this note, as Obsidian resolves it; null if none. */
  resolve(link: string): { path: string; extension: string } | null;
  read(path: string): Promise<ArrayBuffer>;
}

export interface Prepared {
  markdown: string;
  /** Pictures that were too big, or over the document's budget, and stayed as they were. */
  skipped: string[];
  embedded: number;
}

/** Removes this plugin's keys from a leading YAML block, and the block itself if nothing is left. */
export function stripOwnKeys(markdown: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(markdown);

  if (!match) {
    return markdown;
  }

  const own = new Set<string>(Object.values(KEYS));
  const kept = match[1]!
    .split(/\r?\n/)
    .filter((line) => !own.has(line.split(':')[0]!.trim()));
  const rest = markdown.slice(match[0].length);

  if (kept.every((line) => line.trim() === '')) {
    return rest.replace(/^\r?\n/, '');
  }

  return `---\n${kept.join('\n')}\n---\n${rest}`;
}

const toBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let text = '';

  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(text);
};

/*
 * `![[picture.png]]`, `![[picture.png|300]]` and `![alt](attachments/picture.png)` — the three ways
 * a vault picture is written. Remote pictures (`http…`) and data: URIs are left alone; a note
 * embed (`![[Other note]]`) is too, since it is not a picture.
 */
const WIKI_EMBED = /!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
const MD_IMAGE = /!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;

export async function prepareNote(markdown: string, vault: VaultReader): Promise<Prepared> {
  const skipped: string[] = [];
  let budget = PICTURES_BYTES;
  let embedded = 0;

  const embed = async (link: string, alt: string): Promise<string | null> => {
    const target = vault.resolve(link);
    const type = target ? IMAGE_TYPES[target.extension.toLowerCase()] : undefined;

    if (!target || !type) {
      return null;
    }

    const bytes = await vault.read(target.path);

    if (bytes.byteLength > PICTURE_BYTES || bytes.byteLength > budget) {
      skipped.push(target.path);

      return null;
    }

    budget -= bytes.byteLength;
    embedded += 1;

    return `![${alt.replace(/[[\]]/g, '')}](data:${type};base64,${toBase64(bytes)})`;
  };

  let text = stripOwnKeys(markdown);

  text = await replaceAsync(text, WIKI_EMBED, async (whole, link: string, size?: string) => {
    // `|300` is a width, not alt text; anything else after the bar is a caption.
    const alt = size && !/^\d+(x\d+)?$/.test(size.trim()) ? size.trim() : link.split('/').pop()!;

    return (await embed(link.trim(), alt)) ?? whole;
  });

  text = await replaceAsync(text, MD_IMAGE, async (whole, alt: string, src: string) => {
    if (/^(https?:|data:)/i.test(src)) {
      return whole;
    }

    let link = src;

    try {
      link = decodeURIComponent(src);
    } catch {
      // A path with a stray % is still a path.
    }

    return (await embed(link, alt)) ?? whole;
  });

  return { markdown: text, skipped, embedded };
}

/** String.replace with an async replacer, applied in order. */
async function replaceAsync(
  text: string,
  pattern: RegExp,
  replacer: (whole: string, ...groups: string[]) => Promise<string>
): Promise<string> {
  const parts: string[] = [];
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(last, match.index));
    const [whole, ...groups] = match;

    parts.push(await replacer(whole, ...groups));
    last = match.index + match[0].length;
  }

  parts.push(text.slice(last));

  return parts.join('');
}

/** A note's name as a document name: the file's basename, with .md. */
export const documentName = (basename: string): string => `${basename}.md`.slice(0, 200);
