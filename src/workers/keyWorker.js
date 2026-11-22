import * as naclModule from 'tweetnacl';
import bs58 from 'bs58';

const nacl = naclModule.default || naclModule;

function bigIntTo32Bytes(n) {
  const hex = n.toString(16).padStart(64, '0');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return { bytes, hex };
}

function sha256Bytes(text) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
}

self.onmessage = async (e) => {
  const { type, payload, requestId } = e.data;

  if (type === 'GENERATE_PAGE') {
    const startIndex = BigInt(payload.startIndex);
    const count = Math.min(Number(payload.count) || 50, 100);
    const keys = [];

    for (let i = 0n; i < BigInt(count); i++) {
      const index = startIndex + i;
      const { bytes, hex } = bigIntTo32Bytes(index);
      const kp = nacl.sign.keyPair.fromSeed(bytes);
      keys.push({
        index: index.toString(),
        privateKeyHex: hex,
        secretKeyBase58: bs58.encode(kp.secretKey),
        publicKey: bs58.encode(kp.publicKey),
      });
    }

    self.postMessage({ type: 'PAGE_READY', requestId, keys });
  }

  if (type === 'BRAINWALLET') {
    const phrase = String(payload.phrase || '');
    const digest = await sha256Bytes(phrase);
    const bytes = new Uint8Array(digest);
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const kp = nacl.sign.keyPair.fromSeed(bytes);

    self.postMessage({
      type: 'BRAINWALLET_READY',
      requestId,
      key: {
        phrase,
        privateKeyHex: hex,
        secretKeyBase58: bs58.encode(kp.secretKey),
        publicKey: bs58.encode(kp.publicKey),
      },
    });
  }

  if (type === 'PARSE_KEY') {
    const raw = String(payload.input || '').trim();
    let seedBytes = null;

    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      seedBytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        seedBytes[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
      }
    } else {
      try {
        const decoded = bs58.decode(raw);
        if (decoded.length === 64) seedBytes = decoded.slice(0, 32);
        else if (decoded.length === 32) seedBytes = decoded;
      } catch {
        // not valid base58
      }
    }

    if (!seedBytes) {
      self.postMessage({ type: 'PARSE_KEY_READY', requestId, result: null });
      return;
    }

    const hex = Array.from(seedBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const kp = nacl.sign.keyPair.fromSeed(seedBytes);

    self.postMessage({
      type: 'PARSE_KEY_READY',
      requestId,
      result: {
        index: BigInt('0x' + hex).toString(),
        privateKeyHex: hex,
        secretKeyBase58: bs58.encode(kp.secretKey),
        publicKey: bs58.encode(kp.publicKey),
      },
    });
  }
};