import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const rpcUrl = (env.SOLANA_RPC_URL || process.env.SOLANA_RPC_URL || '').trim();

  return {
    plugins: [
      react(),
      {
        name: 'local-api-proxy',
        configureServer(server) {
          server.middlewares.use('/api/check-balances', (req, res) => {
            if (req.method !== 'POST') {
              res.writeHead(405, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            if (!rpcUrl) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'SOLANA_RPC_URL is empty in .env.local' }));
              return;
            }

            let raw = '';
            req.on('data', (chunk) => {
              raw += chunk;
            });
            req.on('end', async () => {
              try {
                const parsed = raw ? JSON.parse(raw) : {};
                const addresses = parsed.addresses || [];

                const rpcRes = await fetch(rpcUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getMultipleAccounts',
                    params: [addresses, { encoding: 'base64' }],
                  }),
                });

                const text = await rpcRes.text();
                if (!text) {
                  res.writeHead(502, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: `Empty RPC response (HTTP ${rpcRes.status})` }));
                  return;
                }

                const data = JSON.parse(text);
                if (data.error) {
                  res.writeHead(502, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: data.error.message || 'RPC error' }));
                  return;
                }

                const accounts = data?.result?.value || [];
                const results = addresses.map((address, i) => {
                  const lamports = accounts[i]?.lamports || 0;
                  return { address, lamports, sol: lamports / 1e9, exists: !!accounts[i] };
                });

                if (addresses.length === 1) {
                  const sigRes = await fetch(rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      jsonrpc: '2.0',
                      id: 2,
                      method: 'getSignaturesForAddress',
                      params: [addresses[0], { limit: 1 }],
                    }),
                  });
                  const sigData = await sigRes.json();
                  results[0].hasHistory =
                    Array.isArray(sigData?.result) && sigData.result.length > 0;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ results }));
              } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message || 'Proxy failure' }));
              }
            });
          });
        },
      },
    ],
  };
});