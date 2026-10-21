/**
 * Regenerates `test-vectors/session-chunk-fixture.json`: a cross-language fixture sealed by this
 * TypeScript implementation and opened by the Python reference decryptor (and by the TS tests).
 * Recipient key, DEK and HPKE ephemeral key are derived deterministically; the chunk nonce is
 * random, so the committed file only changes when this script is run.
 *
 *   node scripts/make-fixtures.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromHex, toHex, utf8 } from '../src/bytes.ts';
import { encryptChunk } from '../src/chunk.ts';
import { sealDek } from '../src/dek.ts';
import { deriveKeyPair, hkdfExpand, hkdfExtract } from '../src/hpke.ts';

const recipient = deriveKeyPair(fromHex('11'.repeat(32)));
const rotated = deriveKeyPair(fromHex('22'.repeat(32)));
const dek = hkdfExpand(hkdfExtract(new Uint8Array(0), utf8('fixture-dek')), utf8('dek'), 32);
const sessionId = '01928c6e-7d3a-7b2c-8f00-1234567890ab';
const kid = 'backend-2026-10';

const events = [0, 1, 2].map((seq) => ({
  event_id: `01928c6e-7d3a-7b2c-8f00-00000000000${seq}`,
  session_id: sessionId,
  seq,
  event_type: seq === 1 ? 'consent.granted' : 'session.state_changed',
  payload: seq === 1 ? { consent_kind: 'core', tap_confirmed: true } : { to: `state_${seq}` },
  note: 'Unicode check: नमस्ते',
}));

const sealed = sealDek({
  dek,
  sessionId,
  recipient: { kid, publicKey: recipient.pk },
  ikmE: fromHex('33'.repeat(32)),
});
const header = { sessionId, firstSeq: 0, lastSeq: 2, eventCount: 3 };
const body = encryptChunk(dek, header, events);

const fixture = {
  description:
    'Cross-language fixture: sealed by @shriii/session-crypto (TS), opened by the Python reference.',
  recipients: [
    { kid, private_key_hex: toHex(recipient.sk), public_key_hex: toHex(recipient.pk) },
    {
      kid: 'backend-2027-01',
      private_key_hex: toHex(rotated.sk),
      public_key_hex: toHex(rotated.pk),
    },
  ],
  dek_hex: toHex(dek),
  chunk: {
    encryption: 'x25519_sealed_aes256gcm',
    session_id: sessionId,
    sealed_dek: sealed,
    nonce: body.nonce,
    ciphertext: body.ciphertext,
    first_seq: 0,
    last_seq: 2,
    event_count: 3,
  },
  events,
};

const out = fileURLToPath(new URL('../test-vectors/session-chunk-fixture.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${out}`);
