import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOCUMENT_BYTES, prepareNote, stripOwnKeys, type VaultReader } from './note.ts';
import { challengeFor } from './pkce.ts';

const png = (size: number) => new Uint8Array(size).fill(7).buffer;

function vault(files: Record<string, ArrayBuffer>): VaultReader {
  return {
    resolve(link) {
      const path = Object.keys(files).find((one) => one === link || one.endsWith(`/${link}`));

      return path ? { path, extension: path.split('.').pop()! } : null;
    },
    async read(path) {
      return files[path]!;
    },
  };
}

test('its own keys come out of the front matter, and the rest stays', () => {
  const note = '---\ntags: [a]\ntransformpipe_id: 123\ntransformpipe_url: https://x/s/1\n---\n# Title\n';

  assert.equal(stripOwnKeys(note), '---\ntags: [a]\n---\n# Title\n');
});

test('a front matter that held only its keys goes altogether', () => {
  assert.equal(stripOwnKeys('---\ntransformpipe_id: 1\n---\n# Title\n'), '# Title\n');
});

test('a note without front matter is untouched', () => {
  assert.equal(stripOwnKeys('# Title\n\n---\n\ntext'), '# Title\n\n---\n\ntext');
});

test('a vault picture is carried inside, both ways of writing it', async () => {
  const out = await prepareNote('![[pic.png]]\n\n![A chart](attachments/chart.png)', vault({
    'attachments/pic.png': png(10),
    'attachments/chart.png': png(10),
  }));

  assert.equal(out.embedded, 2);
  assert.match(out.markdown, /^!\[pic\.png\]\(data:image\/png;base64,/);
  assert.match(out.markdown, /!\[A chart\]\(data:image\/png;base64,/);
});

test('a width after the bar is not alt text, a caption is', async () => {
  const files = { 'a.png': png(4) };
  const sized = await prepareNote('![[a.png|300]]', vault(files));
  const captioned = await prepareNote('![[a.png|The view]]', vault(files));

  assert.match(sized.markdown, /^!\[a\.png\]/);
  assert.match(captioned.markdown, /^!\[The view\]/);
});

test('a picture over a megabyte stays as it was, and is reported', async () => {
  const out = await prepareNote('![[big.png]]', vault({ 'big.png': png(1024 * 1024 + 1) }));

  assert.equal(out.markdown, '![[big.png]]');
  assert.deepEqual(out.skipped, ['big.png']);
});

test('pictures stop at two megabytes for the note', async () => {
  const files = { 'a.png': png(900_000), 'b.png': png(900_000), 'c.png': png(900_000) };
  const out = await prepareNote('![[a.png]] ![[b.png]] ![[c.png]]', vault(files));

  assert.equal(out.embedded, 2);
  assert.deepEqual(out.skipped, ['c.png']);
});

test('remote pictures, data URIs and note embeds are left alone', async () => {
  const note = '![x](https://example.com/a.png) ![y](data:image/png;base64,AA==) ![[Other note]]';

  assert.equal((await prepareNote(note, vault({}))).markdown, note);
});

test('the document limit is the server’s', () => {
  assert.equal(DOCUMENT_BYTES, 4 * 1024 * 1024);
});

test('the PKCE challenge is RFC 7636’s worked example', async () => {
  assert.equal(
    await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  );
});
