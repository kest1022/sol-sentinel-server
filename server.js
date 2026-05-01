const http = require('http');
const https = require('https');

// ── SOL SENTINEL TRADING SERVER ──────────────────────
// Signs and broadcasts Solana transactions server-side
// Deploy on Railway.app - $5/month

const PORT = process.env.PORT || 3000;

// Helper: make HTTPS request
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

// Helper: CORS headers
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

// Main server
const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, corsHeaders());
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ 
      status: 'SOL SENTINEL SERVER ONLINE',
      version: '1.0',
      time: new Date().toISOString()
    }));
    return;
  }

  // Sign and broadcast transaction
  if (req.method === 'POST' && req.url === '/broadcast') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { transaction, seed } = JSON.parse(body);
        
        if (!transaction) throw new Error('No transaction provided');
        if (!seed) throw new Error('No seed provided');

        // Load nacl
        const nacl = require('tweetnacl');
        
        // Decode seed from hex
        const seedBytes = Buffer.from(seed, 'hex');
        if (seedBytes.length !== 32) throw new Error('Seed must be 32 bytes');
        
        // Generate keypair
        const keypair = nacl.sign.keyPair.fromSeed(seedBytes);
        
        // Decode transaction
        const txBytes = Buffer.from(transaction, 'base64');
        
        // Determine transaction format and sign
        let signed;
        const firstByte = txBytes[0];
        
        if (firstByte === 0x80 || firstByte >= 0x80) {
          // Versioned transaction (v0)
          // Format: [version(1)][numSigs(1)][sig1(64)...][message...]
          const numSigs = txBytes[1];
          const messageOffset = 1 + 1 + (64 * numSigs);
          const message = txBytes.slice(messageOffset);
          const sig = nacl.sign.detached(message, keypair.secretKey);
          signed = Buffer.from(txBytes);
          sig.copy(signed, 2); // write first signature after version+numSigs
        } else {
          // Legacy transaction
          // Format: [numSigs(1)][sig1(64)...][message...]
          const numSigs = txBytes[0];
          const messageOffset = 1 + (64 * numSigs);
          const message = txBytes.slice(messageOffset);
          const sig = nacl.sign.detached(message, keypair.secretKey);
          signed = Buffer.from(txBytes);
          sig.copy(signed, 1);
        }
        
        const signedB64 = signed.toString('base64');
        
        // Broadcast to Solana mainnet
        const result = await httpsPost('api.mainnet-beta.solana.com', '/', {
          jsonrpc: '2.0',
          id: 1,
          method: 'sendTransaction',
          params: [signedB64, {
            encoding: 'base64',
            skipPreflight: true,
            maxRetries: 3,
            preflightCommitment: 'confirmed'
          }]
        });
        
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify(result));
        
      } catch(e) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Jupiter quote proxy
  if (req.method === 'GET' && req.url.startsWith('/quote')) {
    try {
      const params = req.url.replace('/quote', '');
      const result = await new Promise((resolve, reject) => {
        https.get('https://lite-api.jup.ag/swap/v1/quote' + params, (r) => {
          let raw = '';
          r.on('data', d => raw += d);
          r.on('end', () => resolve(JSON.parse(raw)));
        }).on('error', reject);
      });
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500, corsHeaders());
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Jupiter swap proxy  
  if (req.method === 'POST' && req.url === '/swap') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const result = await httpsPost('lite-api.jup.ag', '/swap/v1/swap', JSON.parse(body));
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify(result));
      } catch(e) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, corsHeaders());
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log('SOL SENTINEL SERVER running on port ' + PORT);
});
