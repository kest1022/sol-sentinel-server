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

// Derive keypair using BIP39/BIP44 - tries all common paths
async function deriveKeypair(mnemonic, targetAddress) {
  const bip39 = require('bip39');
  const { derivePath } = require('ed25519-hd-key');
  const { Keypair } = require('@solana/web3.js');
  
  const seed = await bip39.mnemonicToSeed(mnemonic.trim());
  const seedHex = seed.toString('hex');
  
  // Try account indices 0-9 with both path formats
  for (let i = 0; i < 10; i++) {
    for (const path of [`m/44'/501'/${i}'/0'`, `m/44'/501'/${i}'`]) {
      try {
        const derived = derivePath(path, seedHex);
        const kp = Keypair.fromSeed(derived.key);
        const pubkey = kp.publicKey.toBase58();
        if (pubkey === targetAddress) {
          console.log('MATCH at path:', path, 'pubkey:', pubkey);
          return kp;
        }
      } catch(e) {}
    }
  }
  
  // Default fallback
  console.log('No match found, using default path');
  const derived = derivePath("m/44'/501'/0'/0'", seedHex);
  return Keypair.fromSeed(derived.key);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, cors());
    res.end();
    return;
  }

  // Quote proxy
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

  // Price proxy
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
    res.end(JSON.stringify({ status: 'SOL SENTINEL SERVER ONLINE', version: '6.0' }));
    return;
  }

  let body = '';
  req.on('data', d => body += d);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body || '{}');

      // Sign and broadcast using @solana/web3.js
      if (req.url === '/broadcast') {
        const { transaction, mnemonic, address } = data;
        if (!transaction) throw new Error('No transaction');
        if (!mnemonic) throw new Error('No mnemonic');

        const solanaWeb3 = require('@solana/web3.js');
        const { VersionedTransaction, Transaction, Connection } = solanaWeb3;
        
        // Get keypair
        const keypair = await deriveKeypair(mnemonic, address);
        console.log('Using pubkey:', keypair.publicKey.toBase58());
        console.log('Target address:', address);
        console.log('Match:', keypair.publicKey.toBase58() === address);

        // Decode transaction
        const txBytes = Buffer.from(transaction, 'base64');
        console.log('TX first byte:', txBytes[0].toString(16), 'length:', txBytes.length);

        let signature;
        console.log('TX bytes[0]:', txBytes[0], 'hex:', txBytes[0].toString(16));

        try {
          // Jupiter v1 uses versioned transactions
          const vTx = VersionedTransaction.deserialize(txBytes);
          console.log('Parsed as VersionedTransaction, version:', vTx.version);
          console.log('Num signatures needed:', vTx.message.header.numRequiredSignatures);
          
          // Sign the transaction
          vTx.sign([keypair]);
          console.log('Signed successfully');
          
          const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
          const serialized = vTx.serialize();
          console.log('Serialized length:', serialized.length);
          
          signature = await connection.sendRawTransaction(serialized, {
            skipPreflight: true,
            maxRetries: 5,
            preflightCommitment: 'confirmed'
          });
          console.log('TX sent! Signature:', signature);
          
        } catch(ve) {
          console.log('VersionedTx error:', ve.message);
          
          try {
            // Try legacy
            const legacyTx = Transaction.from(txBytes);
            console.log('Parsed as legacy Transaction');
            legacyTx.partialSign(keypair);
            
            const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
            signature = await connection.sendRawTransaction(legacyTx.serialize(), {
              skipPreflight: true,
              maxRetries: 5
            });
            console.log('Legacy TX sent:', signature);
          } catch(le) {
            console.log('Legacy TX error:', le.message);
            throw new Error('Both tx formats failed. Versioned: '+ve.message+' Legacy: '+le.message);
          }
        }

        res.writeHead(200, cors());
        res.end(JSON.stringify({ result: signature }));
        return;
      }

      // Swap proxy
      if (req.url === '/swap') {
        const result = await httpsPost('lite-api.jup.ag', '/swap/v1/swap', data);
        res.writeHead(200, cors());
        res.end(JSON.stringify(result));
        return;
      }

      // Token balance fetch
      if (req.url === '/tokenBalance') {
        const { address, mint } = data;
        if (!address || !mint) throw new Error('Need address and mint');
        const result = await httpsPost('api.mainnet-beta.solana.com', '/', {
          jsonrpc: '2.0', id: 1,
          method: 'getTokenAccountsByOwner',
          params: [address, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]
        });
        let amount = 0;
        if (result.result && result.result.value && result.result.value.length > 0) {
          const tokenAccount = result.result.value[0];
          amount = parseInt(tokenAccount.account.data.parsed.info.tokenAmount.amount) || 0;
        }
        console.log('Token balance for', mint.substring(0,8), ':', amount);
        res.writeHead(200, cors());
        res.end(JSON.stringify({ amount }));
        return;
      }

      // Balance fetch
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

      res.writeHead(404, cors());
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch(e) {
      console.error('Server error:', e.message);
      res.writeHead(500, cors());
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('SOL SENTINEL SERVER v6.0 on port ' + PORT);
});
