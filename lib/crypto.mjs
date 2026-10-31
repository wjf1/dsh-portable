/**
 * dsh-portable — optional passphrase encryption for .dshpkg files.
 *
 * A package is a gzip tar. Encryption wraps the *whole* compressed stream, so
 * the on-disk layout stays one file and every reader (panel, tools, bootstrap)
 * goes through the same three functions:
 *
 *   header  magic "DSHPKG-ENC1\n"
 *         | scrypt salt (32) | GCM iv (12)
 *         | key-check nonce (12) | key-check ciphertext | key-check tag (16)
 *   body    AES-256-GCM ciphertext of the gzip stream
 *   tail    the 16-byte GCM authentication tag
 *
 * The key-check block encrypts a constant under the derived key with its own
 * nonce, *before* any package data flows. It is what turns a wrong passphrase
 * into an immediate, readable error: without it the wrong key would still
 * "decrypt" the body, and the first complaint would come from zlib's
 * "incorrect header check" — pointing at the package instead of the password.
 *
 * The body tag lives at the end because GCM produces it only after the last
 * byte is ciphered; a decryptor streams everything except the last 16 bytes
 * through the decipher, then sets the tag and finalises. That keeps a 1 GB
 * package at O(64 KiB) memory, same as the rest of the pipeline.
 *
 * Detection is by magic, never by extension: an encrypted package keeps its
 * .dshpkg name, and a reader that does not know the format fails on the gzip
 * header exactly as it would on any other foreign file.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { open } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { longPath } from './paths.mjs';

export const ENCRYPTION_MAGIC = Buffer.from('DSHPKG-ENC1\n', 'utf8');
export const KEY_BYTES = 32;
export const SALT_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
/** A fixed plaintext the header proves knowledge of: key confirmation. */
export const KEY_CHECK_PLAINTEXT = Buffer.from('dsh-portable/key-check-v1', 'utf8');
export const KEY_CHECK_CT_BYTES = KEY_CHECK_PLAINTEXT.length;
/** magic + salt + iv + key-check nonce + key-check ciphertext + key-check tag. */
export const HEADER_BYTES = ENCRYPTION_MAGIC.length + SALT_BYTES + IV_BYTES + IV_BYTES + KEY_CHECK_CT_BYTES + TAG_BYTES;

/**
 * scrypt work factors. N=2^15 costs ~32 MiB and tens of milliseconds — enough
 * to make brute force over a wordlist unpleasant without making every export
 * feel slow. maxmem must cover N * r * 128 comfortably.
 */
export const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  return scryptSync(String(passphrase), salt, KEY_BYTES, SCRYPT_OPTIONS);
}

/** GCM auth failures must read as "wrong passphrase", not as raw OpenSSL noise. */
function wrapDecryptError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/auth|tag|decrypt|unsupported state|bad decrypt/i.test(message)) {
    const wrapped = new Error('wrong passphrase or corrupted package: decryption failed its authentication check');
    wrapped.cause = error;
    return wrapped;
  }
  return error;
}

/** True when the file starts with the encryption magic. Missing files are not encrypted. */
export async function isEncryptedPackage(filePath) {
  let handle;
  try {
    handle = await open(longPath(filePath), 'r');
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.alloc(ENCRYPTION_MAGIC.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === buffer.length && buffer.equals(ENCRYPTION_MAGIC);
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Streaming encryptor for the gzip pipeline.
 *
 * The header (with the key-check block) is emitted before the first ciphertext
 * byte and the body auth tag is pushed in `_final`, so the output is exactly
 * one encrypted container with no length fields beyond the fixed header.
 */
export function createEncryptTransform(passphrase) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);

  // Key confirmation: a GCM box over a constant, under its own nonce. A reader
  // opens this box first; a wrong passphrase fails here, loudly and early.
  const checkNonce = randomBytes(IV_BYTES);
  const checkCipher = createCipheriv('aes-256-gcm', key, checkNonce);
  const checkCt = Buffer.concat([checkCipher.update(KEY_CHECK_PLAINTEXT), checkCipher.final()]);
  const checkTag = checkCipher.getAuthTag();
  const header = Buffer.concat([ENCRYPTION_MAGIC, salt, iv, checkNonce, checkCt, checkTag]);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let started = false;
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        if (!started) {
          started = true;
          this.push(header);
        }
        this.push(cipher.update(chunk));
        callback();
      } catch (error) {
        callback(error);
      }
    },
    final(callback) {
      try {
        if (!started) {
          // An empty stream still gets a header, so the file stays recognisable.
          this.push(header);
        }
        this.push(cipher.final());
        this.push(cipher.getAuthTag());
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

/**
 * Streaming decryptor. `totalBytes` is the encrypted file's size; the last
 * TAG_BYTES bytes of it are the body auth tag. Bytes are addressed by absolute
 * position, so the ciphertext region is simply
 * `[HEADER_BYTES, totalBytes - TAG_BYTES)` and whatever a chunk contributes
 * beyond that boundary is held in a small pending buffer until `final` can
 * prove it was exactly the tag.
 */
export function createDecryptTransform(passphrase, totalBytes) {
  if (!Number.isFinite(totalBytes) || totalBytes < HEADER_BYTES + TAG_BYTES) {
    throw new Error('encrypted package is too small to be valid');
  }
  const ciphertextEnd = totalBytes - TAG_BYTES;
  const state = {
    /** @type {import('node:crypto').DecipherGCM | null} */
    decipher: null,
    /** Bytes held back: the incomplete header, or the possible tag tail. */
    pending: Buffer.alloc(0),
    /** Absolute file position of the first byte not yet consumed. */
    position: 0,
    failed: false,
  };

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        if (state.failed) { callback(); return; }
        let buffer = state.pending.length > 0 ? Buffer.concat([state.pending, chunk]) : chunk;

        if (state.decipher === null) {
          if (buffer.length < HEADER_BYTES) {
            state.pending = buffer;
            return callback();
          }
          const magic = buffer.subarray(0, ENCRYPTION_MAGIC.length);
          if (!magic.equals(ENCRYPTION_MAGIC)) {
            state.failed = true;
            return callback(new Error('not an encrypted dsh-portable package (bad magic)'));
          }
          const salt = buffer.subarray(ENCRYPTION_MAGIC.length, ENCRYPTION_MAGIC.length + SALT_BYTES);
          const iv = buffer.subarray(ENCRYPTION_MAGIC.length + SALT_BYTES, ENCRYPTION_MAGIC.length + SALT_BYTES + IV_BYTES);
          const key = deriveKey(passphrase, salt);

          // Open the key-check box before anything else. A wrong passphrase or
          // a modified header fails here with a message that names the cause.
          let at = ENCRYPTION_MAGIC.length + SALT_BYTES + IV_BYTES;
          const checkNonce = buffer.subarray(at, at + IV_BYTES);
          at += IV_BYTES;
          const checkCt = buffer.subarray(at, at + KEY_CHECK_CT_BYTES);
          at += KEY_CHECK_CT_BYTES;
          const checkTag = buffer.subarray(at, at + TAG_BYTES);
          try {
            const check = createDecipheriv('aes-256-gcm', key, checkNonce);
            check.setAuthTag(checkTag);
            const plain = Buffer.concat([check.update(checkCt), check.final()]);
            if (!plain.equals(KEY_CHECK_PLAINTEXT)) throw new Error('key check mismatch');
          } catch (error) {
            state.failed = true;
            return callback(wrapDecryptError(error));
          }

          state.decipher = createDecipheriv('aes-256-gcm', key, iv);
          buffer = buffer.subarray(HEADER_BYTES);
          state.position = HEADER_BYTES;
        }

        const feed = Math.max(0, Math.min(buffer.length, ciphertextEnd - state.position));
        if (feed > 0) {
          const plain = state.decipher.update(buffer.subarray(0, feed));
          if (plain.length > 0) this.push(plain);
        }
        const held = buffer.length - feed;
        state.pending = held > 0 ? Buffer.from(buffer.subarray(feed)) : Buffer.alloc(0);
        state.position += buffer.length;
        callback();
      } catch (error) {
        state.failed = true;
        callback(error);
      }
    },
    final(callback) {
      try {
        if (state.decipher === null) {
          callback(new Error('not an encrypted dsh-portable package (truncated header)'));
          return;
        }
        if (state.position !== totalBytes) {
          callback(new Error('encrypted package is truncated (got ' + state.position + ' of ' + totalBytes + ' bytes)'));
          return;
        }
        if (state.pending.length !== TAG_BYTES) {
          callback(new Error('encrypted package is malformed (bad tag position)'));
          return;
        }
        state.decipher.setAuthTag(state.pending);
        const last = state.decipher.final(); // throws on tampered body bytes
        if (last.length > 0) this.push(last);
        callback();
      } catch (error) {
        callback(wrapDecryptError(error));
      }
    },
  });
}
