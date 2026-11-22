import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from './lib/supabase';

const MAX_KEY = (1n << 256n) - 1n;
const PAGE_SIZE = 50n;
const MAX_PAGE = MAX_KEY / PAGE_SIZE;

// Replace with your Solana donation address and ad network direct link
const DONATE_ADDRESS = '7ALEjJAikbPcRcTRT6722UEa18tHLf5cnz72SABy5NUg';
const SPONSOR_AD_URL = 'https://a-ads.com';

function randomBigInt256() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return BigInt('0x' + hex) % (MAX_PAGE + 1n);
}

export default function App() {
  const [activeTab, setActiveTab] = useState('explorer');
  const [pageIndex, setPageIndex] = useState(0n);
  const [jumpInput, setJumpInput] = useState('1');
  const [keys, setKeys] = useState([]);
  const [balances, setBalances] = useState({});
  const [weakMap, setWeakMap] = useState({});
  const [loadingPage, setLoadingPage] = useState(false);
  const [rpcError, setRpcError] = useState('');
  const [revealed, setRevealed] = useState({});
  const [copiedId, setCopiedId] = useState('');
  const [showDonate, setShowDonate] = useState(false);

  // Global stats & sweeper
  const [globalScanned, setGlobalScanned] = useState(0);
  const [sessionScanned, setSessionScanned] = useState(0);
  const [isSweeping, setIsSweeping] = useState(false);

  // Brainwallet state
  const [phrase, setPhrase] = useState('solana');
  const [brainResult, setBrainResult] = useState(null);
  const [brainStatus, setBrainStatus] = useState('');

  // Wallet & Key Check state
  const [walletQuery, setWalletQuery] = useState('');
  const [walletCheckResult, setWalletCheckResult] = useState(null);
  const [walletCheckStatus, setWalletCheckStatus] = useState('');

  // Weak keys directory state
  const [weakDirectory, setWeakDirectory] = useState([]);
  const [loadingWeakDir, setLoadingWeakDir] = useState(false);

  const workerRef = useRef(null);
  const reqIdRef = useRef(0);
  const pendingRef = useRef({});

  // Fetch initial global scan counter from Supabase
  useEffect(() => {
    if (!supabase) return;
    supabase
      .from('global_stats')
      .select('total_scanned')
      .eq('id', 1)
      .single()
      .then(({ data }) => {
        if (data?.total_scanned != null) {
          setGlobalScanned(Number(data.total_scanned));
        }
      });
  }, []);

  // Initialize Ed25519 Web Worker
  useEffect(() => {
    const worker = new Worker(
      new URL('./workers/keyWorker.js', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (e) => {
      const { type, requestId, keys: pageKeys, key, result } = e.data;
      const resolver = pendingRef.current[requestId];
      if (!resolver) return;
      delete pendingRef.current[requestId];

      if (type === 'PAGE_READY') resolver(pageKeys);
      if (type === 'BRAINWALLET_READY') resolver(key);
      if (type === 'PARSE_KEY_READY') resolver(result);
    };

    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  const callWorker = useCallback((type, payload) => {
    return new Promise((resolve) => {
      const requestId = ++reqIdRef.current;
      pendingRef.current[requestId] = resolve;
      workerRef.current.postMessage({ type, payload, requestId });
    });
  }, []);

  const checkBalancesBatch = async (addresses) => {
    try {
      const res = await fetch('/api/check-balances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'RPC check failed');

      const map = {};
      for (const item of data.results || []) {
        map[item.address] = item;
      }
      setRpcError('');
      return map;
    } catch (err) {
      setRpcError(err.message);
      return {};
    }
  };

  const loadPage = useCallback(
    async (targetPage) => {
      if (!workerRef.current) return;
      const safePage =
        targetPage < 0n ? 0n : targetPage > MAX_PAGE ? MAX_PAGE : targetPage;

      setLoadingPage(true);
      setPageIndex(safePage);
      setJumpInput((safePage + 1n).toString());

      const startIndex = safePage * PAGE_SIZE;
      const remaining = MAX_KEY - startIndex + 1n;
      const count = remaining < PAGE_SIZE ? Number(remaining) : Number(PAGE_SIZE);

      const generated = await callWorker('GENERATE_PAGE', {
        startIndex: startIndex.toString(),
        count,
      });

      setKeys(generated);
      const addresses = generated.map((k) => k.publicKey);

      // Parallel check: Supabase known weak keys + batched RPC balances
      const weakPromise = supabase
        ? supabase
            .from('weak_keys')
            .select('address, source, note')
            .in('address', addresses)
        : Promise.resolve({ data: [] });

      const [weakRes, balanceMap] = await Promise.all([
        weakPromise,
        checkBalancesBatch(addresses),
      ]);

      const nextWeak = {};
      for (const row of weakRes?.data || []) {
        nextWeak[row.address] = row;
      }

      setWeakMap(nextWeak);
      setBalances(balanceMap);
      setSessionScanned((s) => s + addresses.length);
      setLoadingPage(false);

      if (supabase && addresses.length > 0) {
        supabase
          .rpc('increment_scanned', { delta: addresses.length })
          .then(({ data }) => {
            if (typeof data === 'number') setGlobalScanned(data);
          });
      }
    },
    [callWorker]
  );

  // Load Page 1 on mount
  useEffect(() => {
    const timer = setTimeout(() => loadPage(0n), 60);
    return () => clearTimeout(timer);
  }, [loadPage]);

  // Sequential Auto-Sweeper loop (1 page every 2.2s to protect RPC credits)
  useEffect(() => {
    if (!isSweeping) return;
    const id = setInterval(() => {
      if (!loadingPage) {
        loadPage(pageIndex >= MAX_PAGE ? 0n : pageIndex + 1n);
      }
    }, 2200);
    return () => clearInterval(id);
  }, [isSweeping, loadingPage, pageIndex, loadPage]);

  const handleJumpSubmit = (e) => {
    e.preventDefault();
    setIsSweeping(false);
    try {
      const cleaned = jumpInput.trim().replace(/[^0-9]/g, '');
      if (!cleaned) return;
      const userPage = BigInt(cleaned);
      const zeroBased = userPage <= 1n ? 0n : userPage - 1n;
      loadPage(zeroBased);
    } catch {
      // ignore invalid BigInt input
    }
  };

  const handleWalletCheck = async (e) => {
    e.preventDefault();
    const input = walletQuery.trim();
    if (!input || !workerRef.current) return;
    setWalletCheckStatus('Inspecting address / key entropy...');

    const isPublicAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input);
    let parsedKey = null;
    let targetAddress = isPublicAddress ? input : null;

    if (!isPublicAddress) {
      parsedKey = await callWorker('PARSE_KEY', { input });
      if (!parsedKey) {
        setWalletCheckStatus(
          'Enter a valid Solana public address, 64-char hex seed, or Base58 secret key.'
        );
        setWalletCheckResult(null);
        return;
      }
      targetAddress = parsedKey.publicKey;
    }

    const [balMap, weakRes] = await Promise.all([
      checkBalancesBatch([targetAddress]),
      supabase
        ? supabase
            .from('weak_keys')
            .select('address, source, note')
            .eq('address', targetAddress)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const exactPage = parsedKey ? BigInt(parsedKey.index) / PAGE_SIZE : null;

    setWalletCheckResult({
      publicKey: targetAddress,
      parsedKey,
      exactPage,
      balance: balMap[targetAddress] || { sol: 0, lamports: 0, exists: false },
      weakRecord: weakRes?.data || null,
    });
    setWalletCheckStatus('');
  };

  const handleTestBrainwallet = async (e) => {
    e.preventDefault();
    if (!phrase.trim() || !workerRef.current) return;
    setBrainStatus('Deriving SHA-256 → Ed25519 keypair...');

    const derived = await callWorker('BRAINWALLET', { phrase });
    const [balMap, weakRes] = await Promise.all([
      checkBalancesBatch([derived.publicKey]),
      supabase
        ? supabase
            .from('weak_keys')
            .select('address, source, note')
            .eq('address', derived.publicKey)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    setBrainResult({
      ...derived,
      balance: balMap[derived.publicKey] || { sol: 0, exists: false },
      weakRecord: weakRes?.data || null,
    });
    setBrainStatus('');
  };

  const handleReportBrainwallet = async () => {
    if (!supabase || !brainResult) return;
    setBrainStatus('Saving to public weak-key warning registry...');
    const { error } = await supabase.from('weak_keys').upsert(
      {
        address: brainResult.publicKey,
        private_key_hex: brainResult.privateKeyHex,
        source: 'brainwallet',
        note: `SHA-256("${brainResult.phrase.slice(0, 64)}")`,
      },
      { onConflict: 'address', ignoreDuplicates: true }
    );

    if (!error) {
      setBrainResult((prev) => ({
        ...prev,
        weakRecord: {
          address: prev.publicKey,
          source: 'brainwallet',
          note: `SHA-256("${prev.phrase}")`,
        },
      }));
      setBrainStatus('Logged to weak_keys registry.');
    } else {
      setBrainStatus(`Could not log: ${error.message}`);
    }
  };

  const loadWeakDirectory = async () => {
    setActiveTab('weak');
    if (!supabase) return;
    setLoadingWeakDir(true);
    const { data } = await supabase
      .from('weak_keys')
      .select('address, private_key_hex, source, note')
      .limit(50);

    const rows = data || [];
    setWeakDirectory(rows);

    if (rows.length > 0) {
      const balMap = await checkBalancesBatch(rows.map((r) => r.address));
      setBalances((prev) => ({ ...prev, ...balMap }));
    }
    setLoadingWeakDir(false);
  };

  const copyText = (id, value) => {
    navigator.clipboard.writeText(value);
    setCopiedId(id);
    setTimeout(() => setCopiedId(''), 1400);
  };

  const toggleReveal = (idx) => {
    setRevealed((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  return (
    <>
      <div className="promo-bar">
        <span className="promo-badge">SOLANAKEYS.SPACE</span>
        <span>
          Open-source 2²⁵⁶ Ed25519 keyspace visualizer &amp; entropy checker •
          Built for the Solana ecosystem
        </span>
      </div>

      <div className="container">
        <header className="header">
          <div
            className="brand"
            style={{ display: 'flex', alignItems: 'center', gap: 14 }}
          >
            <svg
              width="44"
              height="44"
              viewBox="0 0 44 44"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              style={{ flexShrink: 0 }}
            >
              <defs>
                <linearGradient
                  id="solGrad"
                  x1="0"
                  y1="0"
                  x2="44"
                  y2="44"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0%" stopColor="#9945FF" />
                  <stop offset="100%" stopColor="#14F195" />
                </linearGradient>
              </defs>
              <rect
                width="44"
                height="44"
                rx="11"
                fill="url(#solGrad)"
                fillOpacity="0.14"
                stroke="url(#solGrad)"
                strokeWidth="1.5"
              />
              <circle cx="16" cy="22" r="5.5" stroke="#14F195" strokeWidth="2.2" />
              <path
                d="M21.5 22H33M29 22V26M32.5 22V25"
                stroke="#9945FF"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>

            <div>
              <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>SolanaKeys</span>
                <span
                  style={{
                    fontSize: '0.95rem',
                    fontWeight: 500,
                    color: 'var(--muted)',
                  }}
                >
                  .space
                </span>
                <span className="promo-badge" style={{ fontSize: '0.68rem' }}>
                  2²⁵⁶
                </span>
              </h1>
              <p>
                Every possible 32-byte Solana Ed25519 private key arranged across{' '}
                <strong>2.31 × 10⁷⁵</strong> pages. Real-time client-side
                derivation with live mainnet balance &amp; weak-entropy checks.
              </p>
            </div>
          </div>

          <div className="nav-group" style={{ marginTop: 12 }}>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => setShowDonate((v) => !v)}
            >
              ♥ Donate SOL
            </button>
            <a
              className="btn"
              href={SPONSOR_AD_URL}
              target="_blank"
              rel="noreferrer"
              title="Support free Helius RPC scans by viewing a sponsor"
            >
              ▶ Watch Ad (Support RPC)
            </a>
          </div>

          {showDonate && (
            <div className="brain-result" style={{ marginTop: 12 }}>
              <div style={{ fontSize: '0.88rem', color: 'var(--muted)' }}>
                Support server &amp; Helius RPC costs by sending SOL to:
              </div>
              <div className="key-cell">
                <span className="mono-trim" style={{ color: 'var(--sol-green)' }}>
                  {DONATE_ADDRESS}
                </span>
                <button
                  className="mini-btn"
                  type="button"
                  onClick={() => copyText('donate-addr', DONATE_ADDRESS)}
                >
                  {copiedId === 'donate-addr' ? 'Copied!' : 'Copy Address'}
                </button>
              </div>
            </div>
          )}

          {/* Ad Network Banner Slot (728x90 / Responsive for A-Ads, Coinzilla, or Bitmedia) */}
          <div
            id="ad-banner-slot"
            style={{
              marginTop: 14,
              padding: '10px 14px',
              borderRadius: 10,
              border: '1px dashed rgba(255,255,255,0.14)',
              background: 'rgba(255,255,255,0.02)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 10,
              fontSize: '0.82rem',
              color: 'var(--muted)',
            }}
          >
            <span>
              <strong style={{ color: '#fff' }}>SPONSORED:</strong> Keep 2²⁵⁶
              RPC balance checks free —{' '}
              <a href={SPONSOR_AD_URL} target="_blank" rel="noreferrer">
                view partner offer
              </a>{' '}
              or paste your A-Ads / Bitmedia iframe tag inside{' '}
              <code>#ad-banner-slot</code>.
            </span>
          </div>
        </header>

        <section className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">Total Keyspace (2²⁵⁶)</div>
            <div className="stat-value">1.1579 × 10⁷⁷ Keys</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Global Keys Scanned</div>
            <div className="stat-value accent">
              {globalScanned.toLocaleString()}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Your Session Scanned</div>
            <div className="stat-value">{sessionScanned.toLocaleString()}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">RPC Batch Efficiency</div>
            <div className="stat-value">50 Keys / 1 Call</div>
          </div>
        </section>

        <nav className="tabs">
          <button
            className={`tab-btn ${activeTab === 'explorer' ? 'active' : ''}`}
            onClick={() => setActiveTab('explorer')}
          >
            Keyspace Explorer
          </button>
          <button
            className={`tab-btn ${activeTab === 'wallet' ? 'active' : ''}`}
            onClick={() => setActiveTab('wallet')}
          >
            Wallet &amp; Key Check
          </button>
          <button
            className={`tab-btn ${activeTab === 'brainwallet' ? 'active' : ''}`}
            onClick={() => setActiveTab('brainwallet')}
          >
            Brainwallet &amp; Entropy Tester
          </button>
          <button
            className={`tab-btn ${activeTab === 'weak' ? 'active' : ''}`}
            onClick={loadWeakDirectory}
          >
            Known Weak Keys (10,051)
          </button>
        </nav>

        {activeTab === 'explorer' && (
          <section className="panel">
            <div className="controls-bar">
              <div className="nav-group">
                <button
                  className="btn"
                  disabled={loadingPage || pageIndex === 0n}
                  onClick={() => {
                    setIsSweeping(false);
                    loadPage(0n);
                  }}
                >
                  First
                </button>
                <button
                  className="btn"
                  disabled={loadingPage || pageIndex === 0n}
                  onClick={() => {
                    setIsSweeping(false);
                    loadPage(pageIndex - 1n);
                  }}
                >
                  ← Prev
                </button>
                <button
                  className="btn btn-primary"
                  disabled={loadingPage}
                  onClick={() => {
                    setIsSweeping(false);
                    loadPage(randomBigInt256());
                  }}
                >
                  Random 256-Bit Page
                </button>
                <button
                  className="btn"
                  disabled={loadingPage || pageIndex >= MAX_PAGE}
                  onClick={() => {
                    setIsSweeping(false);
                    loadPage(pageIndex + 1n);
                  }}
                >
                  Next →
                </button>
                <button
                  className="btn"
                  disabled={loadingPage || pageIndex >= MAX_PAGE}
                  onClick={() => {
                    setIsSweeping(false);
                    loadPage(MAX_PAGE);
                  }}
                >
                  Last
                </button>
                <button
                  className={`btn ${isSweeping ? 'btn-sweep-active' : ''}`}
                  onClick={() => setIsSweeping((s) => !s)}
                >
                  {isSweeping ? 'Stop Sweeper' : 'Auto-Sweep'}
                </button>
              </div>

              <form className="jump-group" onSubmit={handleJumpSubmit}>
                <input
                  className="input"
                  type="text"
                  value={jumpInput}
                  onChange={(e) => setJumpInput(e.target.value)}
                  placeholder="Enter page number (1 to 2.31e75)"
                />
                <button className="btn" type="submit" disabled={loadingPage}>
                  Go
                </button>
              </form>
            </div>

            <div className="page-banner">
              <strong>Page:</strong> {(pageIndex + 1n).toString()} /{' '}
              {(MAX_PAGE + 1n).toString()}
              {rpcError && (
                <span style={{ color: 'var(--danger)', marginLeft: 12 }}>
                  • RPC Notice: {rpcError}
                </span>
              )}
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Solana Public Address</th>
                    <th>32-Byte Seed (Hex)</th>
                    <th>Wallet Secret (Base58)</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => {
                    const bal = balances[k.publicKey];
                    const weak = weakMap[k.publicKey];
                    const isFunded = bal && bal.lamports > 0;
                    const isShown = !!revealed[k.index];

                    return (
                      <tr
                        key={k.index}
                        className={
                          isFunded
                            ? 'row-funded'
                            : weak
                            ? 'row-weak'
                            : undefined
                        }
                      >
                        <td>
                          {isFunded ? (
                            <span className="badge badge-funded">
                              {bal.sol.toFixed(4)} SOL
                            </span>
                          ) : weak ? (
                            <span
                              className="badge badge-weak"
                              title={weak.note}
                            >
                              WEAK KEY
                            </span>
                          ) : (
                            <span className="badge badge-empty">
                              {bal ? '0 SOL' : '...'}
                            </span>
                          )}
                        </td>

                        <td>
                          <div className="key-cell">
                            <a
                              href={`https://solscan.io/account/${k.publicKey}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {k.publicKey}
                            </a>
                            <button
                              className="mini-btn"
                              onClick={() => copyText(`pub-${k.index}`, k.publicKey)}
                            >
                              {copiedId === `pub-${k.index}` ? 'Copied' : 'Copy'}
                            </button>
                          </div>
                        </td>

                        <td>
                          <div className="key-cell">
                            <span className="mono-trim">
                              {isShown
                                ? k.privateKeyHex
                                : `${k.privateKeyHex.slice(0, 10)}••••••••••••••••••••${k.privateKeyHex.slice(-6)}`}
                            </span>
                            <button
                              className="mini-btn"
                              onClick={() => toggleReveal(k.index)}
                            >
                              {isShown ? 'Hide' : 'Show'}
                            </button>
                            <button
                              className="mini-btn"
                              onClick={() =>
                                copyText(`hex-${k.index}`, k.privateKeyHex)
                              }
                            >
                              {copiedId === `hex-${k.index}` ? 'Copied' : 'Copy'}
                            </button>
                          </div>
                        </td>

                        <td>
                          <div className="key-cell">
                            <span className="mono-trim">
                              {isShown
                                ? k.secretKeyBase58
                                : `${k.secretKeyBase58.slice(0, 8)}••••••••••••••••`}
                            </span>
                            <button
                              className="mini-btn"
                              onClick={() =>
                                copyText(`b58-${k.index}`, k.secretKeyBase58)
                              }
                            >
                              {copiedId === `b58-${k.index}` ? 'Copied' : 'Copy'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeTab === 'wallet' && (
          <section className="panel">
            <h3 style={{ marginBottom: 8 }}>
              Wallet Address &amp; Private Key Audit
            </h3>
            <p
              style={{
                color: 'var(--muted)',
                fontSize: '0.88rem',
                marginBottom: 14,
              }}
            >
              Paste any Solana public address to check against known compromised
              keys, or paste a 64-char hex seed / Base58 secret key (processed
              100% locally in your browser) to find its exact page in the 2²⁵⁶
              keyspace.
            </p>

            <form className="jump-group" onSubmit={handleWalletCheck}>
              <input
                className="input"
                style={{ minWidth: 360 }}
                type="text"
                value={walletQuery}
                onChange={(e) => setWalletQuery(e.target.value)}
                placeholder="Solana address, 64-char hex seed, or Base58 secret key"
              />
              <button className="btn btn-primary" type="submit">
                Check Wallet
              </button>
            </form>

            {walletCheckStatus && (
              <p
                style={{
                  marginTop: 10,
                  color: 'var(--warn)',
                  fontSize: '0.85rem',
                }}
              >
                {walletCheckStatus}
              </p>
            )}

            {walletCheckResult && (
              <div className="brain-result">
                <div>
                  <strong>Public Address:</strong>{' '}
                  <a
                    href={`https://solscan.io/account/${walletCheckResult.publicKey}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {walletCheckResult.publicKey}
                  </a>
                </div>
                <div>
                  <strong>Security Audit:</strong>{' '}
                  {walletCheckResult.weakRecord ? (
                    <>
                      <span className="badge badge-weak">
                        COMPROMISED / WEAK ENTROPY (
                        {walletCheckResult.weakRecord.note})
                      </span>
                      <p
                        style={{
                          color: 'var(--danger)',
                          fontSize: '0.84rem',
                          marginTop: 6,
                        }}
                      >
                        This key comes from predictable low-entropy input and is
                        actively monitored by sweeper bots. Never send funds
                        here.
                      </p>
                    </>
                  ) : walletCheckResult.balance.lamports === 0 &&
                    walletCheckResult.balance.hasHistory ? (
                    <>
                      <span className="badge badge-weak">
                        EMPTIED / PRIOR ON-CHAIN ACTIVITY (0 SOL)
                      </span>
                      <p
                        style={{
                          color: 'var(--warn)',
                          fontSize: '0.84rem',
                          marginTop: 6,
                        }}
                      >
                        This wallet previously held funds on mainnet and now
                        has 0 SOL (either drained by a sweeper/exploit or
                        emptied by its owner). If you did not empty it yourself,
                        treat the address as compromised and do not reuse it.
                      </p>
                    </>
                  ) : (
                    <>
                      <span className="badge badge-funded">
                        NO WEAK-KEY MATCH OR PRIOR DRAIN DETECTED
                      </span>
                      <p
                        style={{
                          color: 'var(--muted)',
                          fontSize: '0.84rem',
                          marginTop: 6,
                        }}
                      >
                        Not found in the known weak-entropy registry and shows
                        no emptied transaction history.
                      </p>
                    </>
                  )}
                </div>
                <div>
                  <strong>Live Mainnet Balance:</strong>{' '}
                  <span className="badge badge-empty">
                    {walletCheckResult.balance.sol} SOL
                  </span>
                </div>
                {walletCheckResult.exactPage !== null && (
                  <div>
                    <strong>Keyspace Location:</strong> Page{' '}
                    {(walletCheckResult.exactPage + 1n).toString()}{' '}
                    <button
                      className="mini-btn"
                      style={{ marginLeft: 8 }}
                      onClick={() => {
                        setActiveTab('explorer');
                        loadPage(walletCheckResult.exactPage);
                      }}
                    >
                      Jump to Page
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {activeTab === 'brainwallet' && (
          <section className="panel">
            <h3 style={{ marginBottom: 8 }}>
              SHA-256 Brainwallet Entropy Tester
            </h3>
            <p
              style={{
                color: 'var(--muted)',
                fontSize: '0.88rem',
                marginBottom: 14,
              }}
            >
              See how fast human-chosen phrases map to predictable Ed25519
              keypairs. Never store real funds in a brainwallet.
            </p>

            <form className="jump-group" onSubmit={handleTestBrainwallet}>
              <input
                className="input"
                style={{ minWidth: 320 }}
                type="text"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                placeholder="Type any passphrase (e.g. solana, password, 123456)"
              />
              <button className="btn btn-primary" type="submit">
                Derive &amp; Check Mainnet
              </button>
            </form>

            {brainStatus && (
              <p
                style={{
                  marginTop: 10,
                  color: 'var(--sol-green)',
                  fontSize: '0.85rem',
                }}
              >
                {brainStatus}
              </p>
            )}

            {brainResult && (
              <div className="brain-result">
                <div>
                  <strong>Public Address:</strong>{' '}
                  <a
                    href={`https://solscan.io/account/${brainResult.publicKey}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {brainResult.publicKey}
                  </a>
                </div>
                <div>
                  <strong>SHA-256 Private Seed (Hex):</strong>{' '}
                  {brainResult.privateKeyHex}
                </div>
                <div>
                  <strong>Base58 Secret Key:</strong>{' '}
                  {brainResult.secretKeyBase58}
                </div>
                <div>
                  <strong>Live Balance:</strong>{' '}
                  <span
                    className={
                      brainResult.balance.lamports > 0
                        ? 'badge badge-funded'
                        : 'badge badge-empty'
                    }
                  >
                    {brainResult.balance.sol} SOL
                  </span>
                  {brainResult.weakRecord && (
                    <span
                      className="badge badge-weak"
                      style={{ marginLeft: 8 }}
                    >
                      KNOWN COMPROMISED ENTROPY
                    </span>
                  )}
                </div>

                {!brainResult.weakRecord && supabase && (
                  <div>
                    <button
                      className="btn"
                      type="button"
                      onClick={handleReportBrainwallet}
                    >
                      Add to Public Weak-Key Registry
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {activeTab === 'weak' && (
          <section className="panel">
            <h3 style={{ marginBottom: 8 }}>
              Seeded Weak &amp; Sequential Keys Sample
            </h3>
            <p
              style={{
                color: 'var(--muted)',
                fontSize: '0.88rem',
                marginBottom: 14,
              }}
            >
              Low-integer seeds and common SHA-256 dictionary hashes are
              continuously monitored by automated bots on Solana mainnet.
            </p>

            {loadingWeakDir ? (
              <p style={{ color: 'var(--muted)' }}>Loading weak keys...</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Origin</th>
                      <th>Solana Public Address</th>
                      <th>Live Balance</th>
                      <th>Seed Hex</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weakDirectory.map((row) => {
                      const bal = balances[row.address];
                      return (
                        <tr key={row.address} className="row-weak">
                          <td>
                            <span className="badge badge-weak">{row.note}</span>
                          </td>
                          <td>
                            <a
                              href={`https://solscan.io/account/${row.address}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {row.address}
                            </a>
                          </td>
                          <td>
                            <span className="badge badge-empty">
                              {bal ? `${bal.sol} SOL` : '...'}
                            </span>
                          </td>
                          <td className="mono-trim">{row.private_key_hex}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        <footer className="disclaimer">
          <strong>Cryptographic Security Notice:</strong> Solana uses 256-bit
          Ed25519 keys (2²⁵⁶ ≈ 1.15 × 10⁷⁷ combinations). Finding an active,
          randomly generated wallet by browsing pages is mathematically
          impossible. Only keys created from weak entropy (such as sequential
          numbers or dictionary brainwallets) appear with historical activity.
        </footer>
      </div>
    </>
  );
}