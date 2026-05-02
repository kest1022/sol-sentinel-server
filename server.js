const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

function httpsPost(hostname, path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname, path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { resolve({ error: raw }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname, path,
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { resolve({ error: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

function toBase58(bytes) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let result = '';
  for (let k = 0; k < bytes.length && bytes[k] === 0; k++) result += '1';
  for (let m = digits.length - 1; m >= 0; m--) result += ALPHABET[digits[m]];
  return result;
}

async function findKeypair(mnemonic, targetAddress) {
  const bip39 = require('bip39');
  const { derivePath } = require('ed25519-hd-key');
  const nacl = require('tweetnacl');
  
  const seed = await bip39.mnemonicToSeed(mnemonic.trim());
  const seedHex = seed.toString('hex');
  
  // Try many account indices
  const paths = [];
  for (let i = 0; i < 10; i++) {
    paths.push(`m/44'/501'/${i}'/0'`);
    paths.push(`m/44'/501'/${i}'`);
  }
  
  for (const path of paths) {
    try {
      const derived = derivePath(path, seedHex);
      const kp = nacl.sign.keyPair.fromSeed(derived.key);
      const pubkey = toBase58(kp.publicKey);
      
      if (pubkey === targetAddress) {
        console.log('MATCH at path:', path);
        return { keypair: kp, path };
      }
    } catch(e) {}
  }
  
  console.log('No match found for', targetAddress);
  // Return default
  const derived = derivePath("m/44'/501'/0'/0'", seedHex);
  const kp = nacl.sign.keyPair.fromSeed(derived.key);
  return { keypair: kp, path: "m/44'/501'/0'/0'" };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, cors());
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/quote')) {
    try {
      const params = req.url.replace('/quote', '');
      const result = await httpsGet('lite-api.jup.ag', '/swap/v1/quote' + params);
      res.writeHead(200, cors());
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500, cors());
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/price')) {
    try {
      const params = req.url.replace('/price', '');
      const result = await httpsGet('lite-api.jup.ag', '/price/v2' + params);
      res.writeHead(200, cors());
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500, cors());
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET') {
    res.writeHead(200, cors());
    res.end(JSON.stringify({ status: 'SOL SENTINEL SERVER ONLINE', version: '5.0' }));
    return;
  }

  let body = '';
  req.on('data', d => body += d);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body || '{}');

      if (req.url === '/broadcast') {
        const { transaction, mnemonic, address } = data;
        if (!transaction) throw new Error('No transaction');
        if (!mnemonic) throw new Error('No mnemonic');

        const nacl = require('tweetnacl');
        const { keypair, path } = await findKeypair(mnemonic, address);
        const pubkey = toBase58(keypair.publicKey);
        console.log('Path:', path, 'match:', pubkey === address);

        const txBytes = Buffer.from(transaction, 'base64');
        let signed;
        const firstByte = txBytes[0];
        
        if (firstByte === 0x80) {
          const numSigs = txBytes[1];
          const sigStart = 2;
          const msgStart = sigStart + (64 * numSigs);
          const message = txBytes.slice(msgStart);
          const sig = nacl.sign.detached(new Uint8Array(message), keypair.secretKey);
          signed = Buffer.from(txBytes);
          Buffer.from(sig).copy(signed, sigStart);
        } else {
          const numSigs = firstByte;
          const sigStart = 1;
          const msgStart = sigStart + (64 * numSigs);
          const message = txBytes.slice(msgStart);
          const sig = nacl.sign.detached(new Uint8Array(message), keypair.secretKey);
          signed = Buffer.from(txBytes);
          Buffer.from(sig).copy(signed, sigStart);
        }

        const result = await httpsPost('api.mainnet-beta.solana.com', '/', {
          jsonrpc: '2.0', id: 1,
          method: 'sendTransaction',
          params: [signed.toString('base64'), {
            encoding: 'base64',
            skipPreflight: true,
            maxRetries: 3
          }]
        });

        console.log('RPC:', JSON.stringify(result).substring(0, 100));
        res.writeHead(200, cors());
        res.end(JSON.stringify(result));
        return;
      }

      if (req.url === '/swap') {
        const result = await httpsPost('lite-api.jup.ag', '/swap/v1/swap', data);
        res.writeHead(200, cors());
        res.end(JSON.stringify(result));
        return;
      }

      if (req.url === '/balance') {
        const { address } = data;
        const result = await httpsPost('api.mainnet-beta.solana.com', '/', {
          jsonrpc: '2.0', id: 1,
          method: 'getBalance',
          params: [address, { commitment: 'confirmed' }]
        });
        res.writeHead(200, cors());
        res.end(JSON.stringify(result));
        return;
      }

      // Find which path matches address
      if (req.url === '/findPath') {
        const { mnemonic, address } = data;
        const { keypair, path } = await findKeypair(mnemonic, address);
        const pubkey = toBase58(keypair.publicKey);
        res.writeHead(200, cors());
        res.end(JSON.stringify({ pubkey, path, match: pubkey === address }));
        return;
      }

      res.writeHead(404, cors());
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch(e) {
      console.error('Error:', e.message);
      res.writeHead(500, cors());
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('SOL SENTINEL SERVER v5.0 on port ' + PORT);
});
