import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../src/bytes.ts';
import {
  type AeadId,
  DecryptionError,
  decap,
  deriveKeyPair,
  encap,
  generateKeyPair,
  hkdfExpand,
  hkdfExtract,
  keySchedule,
  openBase,
  publicFromPrivate,
  sealBase,
  setupBaseR,
  setupBaseS,
} from '../src/hpke.ts';

interface Vector {
  aead_id: number;
  info: string;
  ikmE: string;
  skEm: string;
  pkEm: string;
  ikmR: string;
  skRm: string;
  pkRm: string;
  enc: string;
  shared_secret: string;
  key_schedule_context: string;
  secret: string;
  key: string;
  base_nonce: string;
  exporter_secret: string;
  encryptions: { aad: string; ct: string; nonce: string; pt: string }[];
}

const vectors = (
  JSON.parse(
    readFileSync(new URL('../test-vectors/hpke-rfc9180.json', import.meta.url), 'utf8'),
  ) as { vectors: Vector[] }
).vectors;

describe('HKDF-SHA256 (RFC 5869 test case 1)', () => {
  it('matches the RFC output', () => {
    const prk = hkdfExtract(fromHex('000102030405060708090a0b0c'), fromHex('0b'.repeat(22)));
    expect(toHex(prk)).toBe('077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5');
    const okm = hkdfExpand(prk, fromHex('f0f1f2f3f4f5f6f7f8f9'), 42);
    expect(toHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });
});

describe('RFC 9180 known-answer vectors (mode_base, X25519, HKDF-SHA256)', () => {
  it('has both AES-128-GCM and AES-256-GCM vectors', () => {
    expect(vectors.map((v) => v.aead_id).sort()).toEqual([1, 2]);
  });

  for (const v of vectors) {
    const aead = v.aead_id as AeadId;
    describe(`aead_id=${aead}`, () => {
      it('DeriveKeyPair reproduces skEm/pkEm and skRm/pkRm', () => {
        const e = deriveKeyPair(fromHex(v.ikmE));
        expect(toHex(e.sk)).toBe(v.skEm);
        expect(toHex(e.pk)).toBe(v.pkEm);
        const r = deriveKeyPair(fromHex(v.ikmR));
        expect(toHex(r.sk)).toBe(v.skRm);
        expect(toHex(r.pk)).toBe(v.pkRm);
        expect(toHex(publicFromPrivate(fromHex(v.skRm)))).toBe(v.pkRm);
      });

      it('Encap/Decap produce enc and shared_secret', () => {
        const { enc, sharedSecret } = encap(fromHex(v.pkRm), fromHex(v.ikmE));
        expect(toHex(enc)).toBe(v.enc);
        expect(toHex(sharedSecret)).toBe(v.shared_secret);
        expect(toHex(decap(fromHex(v.enc), fromHex(v.skRm)))).toBe(v.shared_secret);
      });

      it('key schedule matches', () => {
        const ks = keySchedule(aead, fromHex(v.shared_secret), fromHex(v.info));
        expect(toHex(ks.keyScheduleContext)).toBe(v.key_schedule_context);
        expect(toHex(ks.secret)).toBe(v.secret);
        expect(toHex(ks.key)).toBe(v.key);
        expect(toHex(ks.baseNonce)).toBe(v.base_nonce);
        expect(toHex(ks.exporterSecret)).toBe(v.exporter_secret);
      });

      it('sequential encryptions match and decrypt', () => {
        const { context } = setupBaseS(aead, fromHex(v.pkRm), fromHex(v.info), fromHex(v.ikmE));
        const receiver = setupBaseR(aead, fromHex(v.enc), fromHex(v.skRm), fromHex(v.info));
        for (const e of v.encryptions) {
          const ct = context.seal(fromHex(e.aad), fromHex(e.pt));
          expect(toHex(ct)).toBe(e.ct);
          expect(toHex(receiver.open(fromHex(e.aad), ct))).toBe(e.pt);
        }
      });

      it('single-shot seal equals the seq-0 vector', () => {
        const e0 = v.encryptions[0];
        if (!e0) throw new Error('missing vector');
        const out = sealBase(
          aead,
          fromHex(v.pkRm),
          fromHex(v.info),
          fromHex(e0.aad),
          fromHex(e0.pt),
          fromHex(v.ikmE),
        );
        expect(toHex(out.ciphertext)).toBe(e0.ct);
      });
    });
  }
});

describe('HPKE failure modes', () => {
  const r = generateKeyPair();
  const info = new TextEncoder().encode('info');
  const aad = new TextEncoder().encode('aad');
  const pt = new TextEncoder().encode('secret payload');

  it('round-trips with random ephemeral keys and never reuses enc', () => {
    const a = sealBase(2, r.pk, info, aad, pt);
    const b = sealBase(2, r.pk, info, aad, pt);
    expect(toHex(a.enc)).not.toBe(toHex(b.enc));
    expect(new TextDecoder().decode(openBase(2, a.enc, r.sk, info, aad, a.ciphertext))).toBe(
      'secret payload',
    );
  });

  it('rejects a flipped ciphertext bit, wrong aad, wrong info and wrong key', () => {
    const { enc, ciphertext } = sealBase(2, r.pk, info, aad, pt);
    const flipped = ciphertext.slice();
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => openBase(2, enc, r.sk, info, aad, flipped)).toThrow(DecryptionError);
    expect(() => openBase(2, enc, r.sk, info, new Uint8Array(1), ciphertext)).toThrow(
      DecryptionError,
    );
    expect(() => openBase(2, enc, r.sk, new Uint8Array(0), aad, ciphertext)).toThrow(
      DecryptionError,
    );
    expect(() => openBase(2, enc, generateKeyPair().sk, info, aad, ciphertext)).toThrow(
      DecryptionError,
    );
  });

  it('rejects a low-order (all-zero) encapsulated key', () => {
    const { ciphertext } = sealBase(2, r.pk, info, aad, pt);
    expect(() => openBase(2, new Uint8Array(32), r.sk, info, aad, ciphertext)).toThrow(
      DecryptionError,
    );
  });
});
