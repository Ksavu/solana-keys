const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    return res.status(500).json({ error: 'SOLANA_RPC_URL not configured' });
  }

  const { addresses } = req.body || {};
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 100) {
    return res.status(400).json({ error: 'Provide 1 to 100 addresses' });
  }

  for (const addr of addresses) {
    if (typeof addr !== 'string' || !BASE58_REGEX.test(addr)) {
      return res.status(400).json({ error: 'Invalid Solana address in batch' });
    }
  }

  try {
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

    const data = await rpcRes.json();
    if (data.error) {
      return res.status(502).json({ error: data.error.message || 'RPC error' });
    }

    const accounts = data?.result?.value || [];
    const results = addresses.map((address, i) => {
      const acct = accounts[i];
      const lamports = acct ? acct.lamports : 0;
      return {
        address,
        lamports,
        sol: lamports / 1e9,
        exists: acct !== null,
      };
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

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to query Solana RPC' });
  }
}