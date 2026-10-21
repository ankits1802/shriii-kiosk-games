import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { concat, fromBase64, fromHex, toBase64, toHex, utf8 } from '../src/bytes.ts';
import {
  chunkAad,
  decryptChunk,
  decryptRecord,
  encryptChunk,
  encryptRecord,
} from '../src/chunk.ts';
import {
  boxSeal,
  generateDek,
  generateKek,
  openDek,
  parseSealedDek,
  sealDek,
  unwrapDekLocal,
  wrapDekLocal,
} from '../src/dek.ts';
import { DecryptionError } from '../src/hpke.ts';
import { generateRecipientKeyPair, NoActiveKeyError, RecipientKeyRing } from '../src/keys.ts';

const SID = '01928c6e-7d3a-7b2c-8f00-1234567890ab';
const OTHER_SID = '01928c6e-7d3a-7b2c-8f00-ffffffffffff';

function ev(seq: number, sessionId = SID): Record<string, unknown> {
  return { event_id: `e-${seq}`, session_id: sessionId, seq, event_type: 'x', payload: { seq } };
}

describe('sealed DEK', () => {
  const backend = generateRecipientKeyPair('backend-1');
  const lookup = (kid: string): Uint8Array | undefined =>
    kid === 'backend-1' ? backend.privateKey : undefined;

  it('round-trips and carries the kid in the header', () => {
    const dek = generateDek();
    const sealed = sealDek({ dek, sessionId: SID, recipient: backend });
    const parts = parseSealedDek(sealed);
    expect(parts.kid).toBe('backend-1');
    expect(parts.aead).toBe(2);
    expect(fromBase64(sealed).length).toBe(8 + 9 + 32 + 48);
    expect(toHex(openDek({ sealed, sessionId: SID, privateKeys: lookup }))).toBe(toHex(dek));
  });

  it('is bound to the session id', () => {
    const sealed = sealDek({ dek: generateDek(), sessionId: SID, recipient: backend });
    expect(() => openDek({ sealed, sessionId: OTHER_SID, privateKeys: lookup })).toThrow(
      DecryptionError,
    );
  });

  it('detects tampering with any byte, including the kid and suite header', () => {
    const sealed = fromBase64(sealDek({ dek: generateDek(), sessionId: SID, recipient: backend }));
    for (let i = 0; i < sealed.length; i += 1) {
      const t = sealed.slice();
      t[i] = (t[i] ?? 0) ^ 0x01;
      expect(() =>
        openDek({ sealed: toBase64(t), sessionId: SID, privateKeys: lookup }),
      ).toThrow();
    }
  });

  it('rejects truncated, extended and non-base64 input and unknown kids', () => {
    const sealed = sealDek({ dek: generateDek(), sessionId: SID, recipient: backend });
    const bytes = fromBase64(sealed);
    expect(() => parseSealedDek(toBase64(bytes.subarray(0, bytes.length - 1)))).toThrow(
      DecryptionError,
    );
    expect(() => parseSealedDek(toBase64(concat(bytes, new Uint8Array(1))))).toThrow(
      DecryptionError,
    );
    expect(() => parseSealedDek('not base64!')).toThrow(DecryptionError);
    expect(() => openDek({ sealed, sessionId: SID, privateKeys: () => undefined })).toThrow(
      /no private key/,
    );
  });

  it('is deterministic with a fixed ephemeral ikm (KAT for the wire format)', () => {
    const dek = fromHex('aa'.repeat(32));
    const recipient = { kid: 'k1', publicKey: backend.publicKey };
    const a = sealDek({ dek, sessionId: SID, recipient, ikmE: fromHex('01'.repeat(32)) });
    const b = sealDek({ dek, sessionId: SID, recipient, ikmE: fromHex('01'.repeat(32)) });
    expect(a).toBe(b);
    expect(fromBase64(a).subarray(0, 10)).toEqual(
      Uint8Array.from([1, 0x00, 0x20, 0x00, 0x01, 0x00, 0x02, 2, 0x6b, 0x31]),
    );
  });
});

describe('local DEK wrap', () => {
  it('round-trips and is bound to the session and the KEK', () => {
    const kek = generateKek();
    const dek = generateDek();
    const wrapped = wrapDekLocal(kek, SID, dek);
    expect(unwrapDekLocal(kek, SID, wrapped)).toEqual(dek);
    expect(() => unwrapDekLocal(kek, OTHER_SID, wrapped)).toThrow(DecryptionError);
    expect(() => unwrapDekLocal(generateKek(), SID, wrapped)).toThrow(DecryptionError);
  });
});

describe('chunk encryption', () => {
  const dek = generateDek();
  const header = { sessionId: SID, firstSeq: 5, lastSeq: 7, eventCount: 3 };
  const events = [ev(5), ev(6), ev(7)];

  it('round-trips gzip NDJSON with unicode', () => {
    const withUnicode = events.map((e) => ({ ...e, text: 'நன்றி 🙏' }));
    const body = encryptChunk(dek, header, withUnicode);
    expect(fromBase64(body.nonce).length).toBe(12);
    expect(decryptChunk(dek, header, body)).toEqual(withUnicode);
  });

  it('uses a fresh nonce per chunk', () => {
    const a = encryptChunk(dek, header, events);
    const b = encryptChunk(dek, header, events);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('detects edits to the clear header fields (AAD binding)', () => {
    const body = encryptChunk(dek, header, events);
    for (const h of [
      { ...header, sessionId: OTHER_SID },
      { ...header, firstSeq: 4 },
      { ...header, lastSeq: 8 },
      { ...header, eventCount: 2 },
    ]) {
      expect(() => decryptChunk(dek, h, body)).toThrow(DecryptionError);
    }
  });

  it('detects ciphertext, tag and nonce tampering and a wrong DEK', () => {
    const body = encryptChunk(dek, header, events);
    const ct = fromBase64(body.ciphertext);
    for (const i of [0, Math.floor(ct.length / 2), ct.length - 1]) {
      const t = ct.slice();
      t[i] = (t[i] ?? 0) ^ 0x80;
      expect(() => decryptChunk(dek, header, { ...body, ciphertext: toBase64(t) })).toThrow(
        DecryptionError,
      );
    }
    const n = fromBase64(body.nonce);
    n[0] = (n[0] ?? 0) ^ 1;
    expect(() => decryptChunk(dek, header, { ...body, nonce: toBase64(n) })).toThrow(
      DecryptionError,
    );
    expect(() => decryptChunk(generateDek(), header, body)).toThrow(DecryptionError);
  });

  it('refuses inconsistent headers on encryption', () => {
    expect(() => encryptChunk(dek, { ...header, eventCount: 2 }, events)).toThrow(RangeError);
    expect(() => encryptChunk(dek, { ...header, lastSeq: 9, eventCount: 3 }, events)).toThrow(
      RangeError,
    );
  });

  it('rejects authenticated payloads whose events disagree with the header', () => {
    // An insider holding the DEK could still forge; this checks the decryptor's own consistency gate.
    const bad = [ev(5), ev(7), ev(6)];
    const body = encryptChunk(dek, header, bad);
    expect(() => decryptChunk(dek, header, body)).toThrow(/not contiguous/);
    const wrongSession = [ev(5), ev(6, OTHER_SID), ev(7)];
    expect(() => decryptChunk(dek, header, encryptChunk(dek, header, wrongSession))).toThrow(
      /session_id/,
    );
  });

  it('guards against decompression bombs', () => {
    const bomb = new Uint8Array(gzipSync(new Uint8Array(20 * 1024 * 1024)));
    const box = boxSeal(dek, chunkAad(header), bomb);
    expect(() =>
      decryptChunk(dek, header, {
        nonce: toBase64(box.subarray(0, 12)),
        ciphertext: toBase64(box.subarray(12)),
      }),
    ).toThrow(/too large/);
  });
});

describe('at-rest records', () => {
  it('round-trip and are bound to session and seq', () => {
    const dek = generateDek();
    const box = encryptRecord(dek, SID, 3, '{"a":1}');
    expect(decryptRecord(dek, SID, 3, box)).toBe('{"a":1}');
    expect(() => decryptRecord(dek, SID, 4, box)).toThrow(DecryptionError);
    expect(() => decryptRecord(dek, OTHER_SID, 3, box)).toThrow(DecryptionError);
  });
});

describe('recipient key rotation', () => {
  const k1 = generateRecipientKeyPair('k-2026-10');
  const k2 = generateRecipientKeyPair('k-2027-01');
  const t0 = Date.parse('2026-10-01T00:00:00Z');
  const t1 = Date.parse('2027-01-01T00:00:00Z');
  const t2 = Date.parse('2027-02-01T00:00:00Z');
  const ring = new RecipientKeyRing([
    { kid: k1.kid, publicKey: k1.publicKey, notBefore: t0, notAfter: t2 },
    { kid: k2.kid, publicKey: k2.publicKey, notBefore: t1, notAfter: null },
  ]);

  it('selects the newest valid key', () => {
    expect(ring.current(t0 + 1).kid).toBe('k-2026-10');
    expect(ring.current(t1 + 1).kid).toBe('k-2027-01');
    expect(ring.isSealable('k-2026-10', t1 + 1)).toBe(true);
    expect(ring.isSealable('k-2026-10', t2)).toBe(false);
    expect(ring.isSealable('missing', t1)).toBe(false);
  });

  it('throws when no key is valid yet', () => {
    expect(() => ring.current(t0 - 1)).toThrow(NoActiveKeyError);
  });

  it('round-trips through JSON', () => {
    const copy = RecipientKeyRing.fromJson(ring.toJson());
    expect(copy.current(t1 + 1).kid).toBe('k-2027-01');
    expect(copy.get('k-2026-10')?.publicKey).toEqual(k1.publicKey);
  });

  it('validates keys', () => {
    expect(() => new RecipientKeyRing([])).toThrow();
    expect(
      () =>
        new RecipientKeyRing([
          { kid: 'bad kid', publicKey: k1.publicKey, notBefore: t0, notAfter: null },
        ]),
    ).toThrow(/kid/);
    expect(
      () =>
        new RecipientKeyRing([
          { kid: 'a', publicKey: k1.publicKey, notBefore: t0, notAfter: null },
          { kid: 'a', publicKey: k2.publicKey, notBefore: t1, notAfter: null },
        ]),
    ).toThrow(/duplicate/);
    expect(
      () =>
        new RecipientKeyRing([{ kid: 'a', publicKey: new Uint8Array(31), notBefore: t0, notAfter: null }]),
    ).toThrow(/length/);
  });

  it('a DEK sealed to a retired key is re-sealed to the current key without re-encrypting data', () => {
    const dek = generateDek();
    const oldSealed = sealDek({ dek, sessionId: SID, recipient: k1 });
    const lookup = (kid: string): Uint8Array | undefined =>
      kid === k1.kid ? k1.privateKey : kid === k2.kid ? k2.privateKey : undefined;
    const now = t2 + 1;
    expect(ring.isSealable(parseSealedDek(oldSealed).kid, now)).toBe(false);
    const resealed = sealDek({ dek, sessionId: SID, recipient: ring.current(now) });
    expect(parseSealedDek(resealed).kid).toBe('k-2027-01');
    expect(openDek({ sealed: resealed, sessionId: SID, privateKeys: lookup })).toEqual(dek);
  });
});

describe('cross-language fixture', () => {
  it('decrypts the committed fixture', () => {
    const f = JSON.parse(
      readFileSync(new URL('../test-vectors/session-chunk-fixture.json', import.meta.url), 'utf8'),
    ) as {
      recipients: { kid: string; private_key_hex: string }[];
      dek_hex: string;
      chunk: {
        session_id: string;
        sealed_dek: string;
        nonce: string;
        ciphertext: string;
        first_seq: number;
        last_seq: number;
        event_count: number;
      };
      events: unknown[];
    };
    const keys = new Map(f.recipients.map((r) => [r.kid, fromHex(r.private_key_hex)]));
    const dek = openDek({
      sealed: f.chunk.sealed_dek,
      sessionId: f.chunk.session_id,
      privateKeys: (kid) => keys.get(kid),
    });
    expect(toHex(dek)).toBe(f.dek_hex);
    const events = decryptChunk(
      dek,
      {
        sessionId: f.chunk.session_id,
        firstSeq: f.chunk.first_seq,
        lastSeq: f.chunk.last_seq,
        eventCount: f.chunk.event_count,
      },
      f.chunk,
    );
    expect(events).toEqual(f.events);
    expect(utf8(JSON.stringify(events)).length).toBeGreaterThan(0);
  });
});
