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

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, cors());
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET') {
    res.writeHead(200, cors());
    res.end(JSON.stringify({ status: 'SOL SENTINEL SERVER ONLINE', version: '1.0' }));
    return;
  }

  let body = '';
  req.on('data', d => body += d);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body || '{}');

      // Broadcast signed transaction
      if (req.url === '/broadcast') {
        const { transaction, seed } = data;
        if (!transaction) throw new Error('No transaction');
        if (!seed) throw new Error('No seed');

        const nacl = require('tweetnacl');
        const seedBytes = Buffer.from(seed, 'hex');
        if (seedBytes.length !== 32) throw new Error('Seed must be 32 bytes');
        const keypair = nacl.sign.keyPair.fromSeed(seedBytes);
        const txBytes = Buffer.from(transaction, 'base64');

        // Sign the transaction
        let signed;
        if (txBytes[0] >= 0x80) {
          // Versioned transaction
          const numSigs = txBytes[1];
          const msgStart = 1 + 1 + (64 * numSigs);
          const message = txBytes.slice(msgStart);
          const sig = nacl.sign.detached(message, keypair.secretKey);
          signed = Buffer.from(txBytes);
          sig.copy(signed, 2);
        } else {
          // Legacy transaction
          const numSigs = txBytes[0];
          const msgStart = 1 + (64 * numSigs);
          const message = txBytes.slice(msgStart);
          const sig = nacl.sign.detached(message, keypair.secretKey);
          signed = Buffer.from(txBytes);
          sig.copy(signed, 1);
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

        res.writeHead(200, cors());
        res.end(JSON.stringify(result));
        return;
      }

      // Jupiter quote proxy
      if (req.url.startsWith('/quote')) {
        const params = req.url.replace('/quote', '');
        const result = await new Promise((resolve, reject) => {
          https.get('https://lite-api.jup.ag/swap/v1/quote' + params, (r) => {
            let raw = '';
            r.on('data', d => raw += d);
            r.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({error: raw}); } });
          }).on('error', reject);
        });
        res.writeHead(200, cors());
        res.end(JSON.stringify(result));
        return;
      }

      // Jupiter swap proxy
      if (req.url === '/swap') {
        const result = await httpsPost('lite-api.jup.ag', '/swap/v1/swap', data);
        res.writeHead(200, cors());
        res.end(JSON.stringify(result));
        return;
      }

      res.writeHead(404, cors());
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch(e) {
      res.writeHead(500, cors());
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('SOL SENTINEL SERVER running on port ' + PORT);
});
