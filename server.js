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

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, cors());
    res.end();
    return;
  }

  // Quote proxy (GET)
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

  // Price proxy (GET)
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

  // Health check
  if (req.method === 'GET') {
    res.writeHead(200, cors());
    res.end(JSON.stringify({ status: 'SOL SENTINEL SERVER ONLINE', version: '2.0' }));
    return;
  }

  let body = '';
  req.on('data', d => body += d);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body || '{}');

      // Broadcast - sign and send transaction
      if (req.url === '/broadcast') {
        const { transaction, seed } = data;
        if (!transaction) throw new Error('No transaction');
        if (!seed) throw new Error('No seed');

        const nacl = require('tweetnacl');
        const seedBytes = Buffer.from(seed, 'hex');
        if (seedBytes.length !== 32) throw new Error('Seed must be 32 bytes');
        
        const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(seedBytes));
        const txBytes = Buffer.from(transaction, 'base64');
        
        console.log('TX first bytes:', txBytes.slice(0, 5).toString('hex'));
        console.log('TX length:', txBytes.length);

        // Parse and sign the transaction properly
        // Solana versioned transaction format:
        // [version_prefix(1)] [num_signatures(compact)] [signatures] [message]
        // We need to sign the message portion and replace the first signature
        
        let signed;
        const firstByte = txBytes[0];
        
        if (firstByte === 0x80) {
          // Versioned transaction v0
          // Format: 0x80 | num_sigs | sig1(64) | sig2... | message
          const numSigs = txBytes[1];
          const sigStart = 2;
          const msgStart = sigStart + (64 * numSigs);
          const message = txBytes.slice(msgStart);
          
          console.log('Versioned tx: numSigs='+numSigs+' msgStart='+msgStart+' msgLen='+message.length);
          
          const sig = nacl.sign.detached(new Uint8Array(message), keypair.secretKey);
          signed = Buffer.from(txBytes);
          Buffer.from(sig).copy(signed, sigStart);
          
        } else {
          // Legacy transaction
          // Format: [num_sigs(1)] [sig1(64)]... [message]
          const numSigs = firstByte;
          const sigStart = 1;
          const msgStart = sigStart + (64 * numSigs);
          const message = txBytes.slice(msgStart);
          
          console.log('Legacy tx: numSigs='+numSigs+' msgStart='+msgStart+' msgLen='+message.length);
          
          const sig = nacl.sign.detached(new Uint8Array(message), keypair.secretKey);
          signed = Buffer.from(txBytes);
          Buffer.from(sig).copy(signed, sigStart);
        }

        const signedB64 = signed.toString('base64');
        
        // Try multiple RPC endpoints
        const rpcs = [
          'api.mainnet-beta.solana.com',
          'mainnet.helius-rpc.com'
        ];
        
        let lastError = '';
        for (const rpc of rpcs) {
          try {
            const result = await httpsPost(rpc, '/', {
              jsonrpc: '2.0', id: 1,
              method: 'sendTransaction',
              params: [signedB64, {
                encoding: 'base64',
                skipPreflight: true,
                maxRetries: 3,
                preflightCommitment: 'confirmed'
              }]
            });
            
            console.log('RPC result:', JSON.stringify(result).substring(0, 100));
            
            if (result.result) {
              res.writeHead(200, cors());
              res.end(JSON.stringify(result));
              return;
            }
            lastError = result.error ? JSON.stringify(result.error) : 'no result';
          } catch(e) {
            lastError = e.message;
          }
        }
        
        res.writeHead(200, cors());
        res.end(JSON.stringify({ error: lastError }));
        return;
      }

      // Swap proxy
      if (req.url === '/swap') {
        const result = await httpsPost('lite-api.jup.ag', '/swap/v1/swap', data);
        res.writeHead(200, cors());
        res.end(JSON.stringify(result));
        return;
      }

      // Balance fetch
      if (req.url === '/balance') {
        const { address } = data;
        if (!address) throw new Error('No address');
        const result = await httpsPost('api.mainnet-beta.solana.com', '/', {
          jsonrpc: '2.0', id: 1,
          method: 'getBalance',
          params: [address, { commitment: 'confirmed' }]
        });
        res.writeHead(200, cors());
        res.end(JSON.stringify(result));
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
  console.log('SOL SENTINEL SERVER v2.0 on port ' + PORT);
});
