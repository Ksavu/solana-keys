import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SEQUENTIAL_COUNT = 10000;
const BATCH_SIZE = 500;

const COMMON_PHRASES = [
  'solana', 'Solana', 'SOLANA', 'sol', 'bitcoin', 'ethereum', 'crypto',
  'phantom', 'wallet', 'password', '123456', '12345678', '123456789',
  'qwerty', 'admin', 'root', 'test', 'hello', 'world', 'hello world',
  'satoshi', 'nakamoto', 'anatoly', 'toly', 'wagmi', 'ngmi', 'gm',
  'degen', 'moon', 'lambo', 'bonk', 'wif', 'pepe', 'pump', 'memes',
  '0', '1', '42', '69', '420', '1337', '2024', '2025', '2026',
  'secret', 'private', 'key', 'seed', 'phrase', 'recovery', 'mnemonic'
];

function bigIntTo32Bytes(n) {
  const hex = n.toString(16).padStart(64, '0');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return { bytes, hex };
}

async function flush(rows) {
  const { error } = await supabase
    .from('weak_keys')
    .upsert(rows, { onConflict: 'address', ignoreDuplicates: true });
  if (error) throw error;
}

async function main() {
  console.log(`Seeding ${SEQUENTIAL_COUNT} sequential keys...`);
  let batch = [];

  for (let i = 0n; i < BigInt(SEQUENTIAL_COUNT); i++) {
    const { bytes, hex } = bigIntTo32Bytes(i);
    const kp = nacl.sign.keyPair.fromSeed(bytes);
    batch.push({
      address: bs58.encode(kp.publicKey),
      private_key_hex: hex,
      source: 'sequential',
      note: `Key #${i.toString()}`,
    });

    if (batch.length >= BATCH_SIZE) {
      await flush(batch);
      batch = [];
      process.stdout.write(`\rSeeded ${Number(i) + 1} / ${SEQUENTIAL_COUNT}`);
    }
  }
  if (batch.length) await flush(batch);
  console.log('\nSequential keys done.');

  console.log(`Seeding ${COMMON_PHRASES.length} brainwallets...`);
  const brainRows = COMMON_PHRASES.map((phrase) => {
    const hash = crypto.createHash('sha256').update(phrase).digest();
    const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(hash));
    return {
      address: bs58.encode(kp.publicKey),
      private_key_hex: hash.toString('hex'),
      source: 'brainwallet',
      note: `SHA-256("${phrase}")`,
    };
  });

  await flush(brainRows);
  console.log('Brainwallets done!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});