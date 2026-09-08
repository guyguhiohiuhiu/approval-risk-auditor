import { z } from "zod";
import { createAgentApp } from "@lucid-dreams/agent-kit";

declare const process: { env: Record<string, string | undefined> };

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApprovalEntry {
  token: string;
  token_name: string;
  token_symbol: string;
  token_decimals: number;
  spender: string;
  spender_name: string;
  allowance: string;
  allowance_raw: string;
  is_unlimited: boolean;
  is_stale: boolean;
  last_approval_block: number | null;
  last_approval_timestamp: string | null;
  risk_level: "low" | "medium" | "high" | "critical";
  risk_flags: string[];
}

interface RevokeTxData {
  token: string;
  spender: string;
  to: string;
  data: string;
  chain_id: number;
  chain_name: string;
  description: string;
}

interface AuditResult {
  wallet: string;
  chains_scanned: string[];
  approvals: ApprovalEntry[];
  revoke_tx_data: RevokeTxData[];
  summary: {
    total_approvals: number;
    unlimited_approvals: number;
    stale_approvals: number;
    high_risk_count: number;
  };
}

// ─── Chain Config ─────────────────────────────────────────────────────────────

interface ChainConfig {
  name: string;
  chain_id: number;
  blockscout_api: string;
  rpc_url: string;
}

const CHAINS: Record<string, ChainConfig> = {
  ethereum: {
    name: "ethereum",
    chain_id: 1,
    blockscout_api: "https://eth.blockscout.com",
    rpc_url: "https://eth-mainnet.public.blastapi.io",
  },
  base: {
    name: "base",
    chain_id: 8453,
    blockscout_api: "https://base.blockscout.com",
    rpc_url: "https://mainnet.base.org",
  },
  polygon: {
    name: "polygon",
    chain_id: 137,
    blockscout_api: "https://polygon.blockscout.com",
    rpc_url: "https://polygon-rpc.com",
  },
  arbitrum: {
    name: "arbitrum",
    chain_id: 42161,
    blockscout_api: "https://arbitrum.blockscout.com",
    rpc_url: "https://arb1.arbitrum.io/rpc",
  },
  optimism: {
    name: "optimism",
    chain_id: 10,
    blockscout_api: "https://optimism.blockscout.com",
    rpc_url: "https://mainnet.optimism.io",
  },
};

const MAX_UINT256 = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

// ─── Known Spender Names ─────────────────────────────────────────────────────────

const SPENDER_NAMES: Record<string, { name: string; category: string; is_high_risk: boolean }> = {
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": { name: "Uniswap V3 Router 2", category: "DEX Router", is_high_risk: true },
  "0xe592427a0aece92de3edee1f18e0157c05861564": { name: "Uniswap V3 SwapRouter", category: "DEX Router", is_high_risk: true },
  "0x7a250d5630b4cf539739df2c5dac8c6e9e6c0a96": { name: "Uniswap V2 Router", category: "DEX Router", is_high_risk: true },
  "0x1111111254eeb25477b68fb85ed929f73a960582": { name: "1inch Router V5", category: "DEX Aggregator", is_high_risk: true },
  "0x881d40237659c251811cec9c364ef91dc08d300c": { name: "MetaMask Swap", category: "Wallet Swap", is_high_risk: true },
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff": { name: "0x Exchange Proxy", category: "DEX Aggregator", is_high_risk: true },
  "0x000000000022d473030f116ddee9f6b43ac78ba3": { name: "Permit2", category: "Approval Router", is_high_risk: true },
  "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f": { name: "Sushiswap Router", category: "DEX Router", is_high_risk: true },
  "0x99a58482bd75cbab83b27ec3ca6763af3b133af8": { name: "Curve Exchange Proxy", category: "DEX Router", is_high_risk: true },
  "0x87870bca3f3fd6335c3f4ce839ed4b9ba1c3e3b7": { name: "Aave Pool", category: "Lending", is_high_risk: false },
  "0x39e3b1fe478321a4f0c3bf9c5de095a03d80e4ba": { name: "Comet (Compound V3)", category: "Lending", is_high_risk: false },
  "0x00000000006c3852cbef3e08e8df289169ede581": { name: "OpenSea Seaport", category: "NFT Marketplace", is_high_risk: true },
  "0x0000000000000adc98e5e15d3c0b3b1bf15e3ba5": { name: "Blur Exchange", category: "NFT Marketplace", is_high_risk: true },
  "0x6131b5fae19ea4f9d964eac0408e4408b66337b5": { name: "Kyber Router", category: "DEX Router", is_high_risk: true },
  "0x0439e60f02a8900a951603950d8d4527f400c3f1": { name: "KyberSwap Router", category: "DEX Aggregator", is_high_risk: true },
};

function getSpenderInfo(spender: string): { name: string; category: string; is_high_risk: boolean } {
  const known = SPENDER_NAMES[spender.toLowerCase()];
  if (known) return known;
  return {
    name: `Unknown (${spender.slice(0, 8)}...${spender.slice(-4)})`,
    category: "Unknown",
    is_high_risk: false,
  };
}

// ─── RPC Helpers ───────────────────────────────────────────────────────────────

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  const json = await res.json() as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result || "0x";
}

function decodeUint256(hex: string): string {
  const cleaned = hex.replace("0x", "").replace(/^0+/, "");
  if (!cleaned) return "0";
  return BigInt("0x" + cleaned).toString();
}

function hexToUtf8(hex: string): string {
  const cleaned = hex.replace("0x", "");
  if (!cleaned || cleaned === "0".repeat(128)) return "";
  const offset = parseInt(cleaned.slice(0, 64), 16);
  if (isNaN(offset)) return "";
  const length = parseInt(cleaned.slice(offset * 2, offset * 2 + 64), 16);
  if (isNaN(length) || length <= 0 || length > 1000) return "";
  const strHex = cleaned.slice(offset * 2 + 64, offset * 2 + 64 + length * 2);
  try {
    const bytes = new Uint8Array(strHex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(strHex.slice(i * 2, i * 2 + 2), 16);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function hexToBytes32String(hex: string): string {
  const cleaned = hex.replace("0x", "").slice(0, 64);
  try {
    const bytes = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    }
    return new TextDecoder().decode(bytes).replace(/\0/g, "").trim();
  } catch {
    return "";
  }
}

// ─── Blockscout Transaction Fetcher ──────────────────────────────────────────────

interface BlockscoutTx {
  hash: string;
  block_number: number;
  timestamp: string;
  raw_input: string;
  to: { hash: string } | null;
  value: string;
  success: boolean;
}

async function fetchTransactions(
  blockscoutApi: string,
  wallet: string,
  maxPages: number = 5
): Promise<BlockscoutTx[]> {
  const allTxs: BlockscoutTx[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    let url = `${blockscoutApi}/api/v2/addresses/${wallet}/transactions`;
    if (cursor) {
      url += `?cursor=${encodeURIComponent(cursor)}`;
    }
    
    const res = await fetch(url);
    if (!res.ok) break;
    
    const data = await res.json() as { items?: BlockscoutTx[]; next_page_params?: { cursor?: string } | null };
    if (!data.items || data.items.length === 0) break;
    
    allTxs.push(...data.items);
    
    if (data.next_page_params?.cursor) {
      cursor = data.next_page_params.cursor;
    } else {
      break;
    }
  }

  return allTxs;
}

// ─── Token Info ────────────────────────────────────────────────────────────────

const tokenInfoCache = new Map<string, { name: string; symbol: string; decimals: number }>();

async function getTokenInfo(
  rpcUrl: string,
  tokenAddress: string
): Promise<{ name: string; symbol: string; decimals: number }> {
  const key = `${rpcUrl}:${tokenAddress.toLowerCase()}`;
  if (tokenInfoCache.has(key)) return tokenInfoCache.get(key)!;

  let name = "Unknown";
  let symbol = "UNKNOWN";
  let decimals = 18;

  try {
    const nameResult = await ethCall(rpcUrl, tokenAddress, "0x06fdde03");
    name = hexToUtf8(nameResult) || hexToBytes32String(nameResult) || "Unknown";
  } catch { /* ignore */ }

  try {
    const symbolResult = await ethCall(rpcUrl, tokenAddress, "0x95d89b41");
    symbol = hexToUtf8(symbolResult) || hexToBytes32String(symbolResult) || "UNKNOWN";
  } catch { /* ignore */ }

  try {
    const decimalsResult = await ethCall(rpcUrl, tokenAddress, "0x313ce567");
    decimals = parseInt(decimalsResult, 16) || 18;
  } catch { /* ignore */ }

  const info = { name, symbol, decimals };
  tokenInfoCache.set(key, info);
  return info;
}

// ─── Risk Assessment ─────────────────────────────────────────────────────────────

function assessRisk(
  allowance: string,
  isStale: boolean,
  spenderInfo: { name: string; category: string; is_high_risk: boolean }
): { level: "low" | "medium" | "high" | "critical"; flags: string[] } {
  const flags: string[] = [];
  const isUnlimited = allowance === MAX_UINT256;
  const allowanceVal = BigInt(allowance);
  const oneMillion = BigInt("1000000000000000000000000");

  if (isUnlimited) flags.push("unlimited_approval");
  if (isStale) flags.push("stale_approval");
  if (allowanceVal > oneMillion && !isUnlimited) flags.push("very_large_allowance");
  if (spenderInfo.is_high_risk) flags.push("high_risk_spender");
  flags.push(`category:${spenderInfo.category}`);

  let level: "low" | "medium" | "high" | "critical" = "low";
  if (isUnlimited && isStale) level = "critical";
  else if (isUnlimited) level = "high";
  else if (isStale) level = "medium";
  else if (allowanceVal > oneMillion) level = "medium";
  if (spenderInfo.is_high_risk && level === "low") level = "medium";

  return { level, flags };
}

// ─── Revoke TX Builder ──────────────────────────────────────────────────────────

function buildRevokeTx(
  tokenAddress: string,
  spender: string,
  spenderName: string,
  chain: ChainConfig
): RevokeTxData {
  const spenderParam = spender.toLowerCase().replace("0x", "").padStart(64, "0");
  const zeroAmount = "0".repeat(64);
  const data = "0x095ea7b3" + spenderParam + zeroAmount;

  return {
    token: tokenAddress,
    spender,
    to: tokenAddress,
    data,
    chain_id: chain.chain_id,
    chain_name: chain.name,
    description: `Revoke ${spenderName} approval on ${chain.name}`,
  };
}

// ─── Main Audit Function ──────────────────────────────────────────────────────────

async function auditWalletApprovals(
  wallet: string,
  chainNames: string[]
): Promise<AuditResult> {
  const allApprovals: ApprovalEntry[] = [];
  const allRevokeTxs: RevokeTxData[] = [];
  const chainsScanned: string[] = [];
  const allowanceSelector = "0xdd62ed3e";
  const approveSelector = "0x095ea7b3";

  for (const chainName of chainNames) {
    const chain = CHAINS[chainName];
    if (!chain) continue;
    chainsScanned.push(chainName);

    try {
      // Step 1: Fetch transaction history from Blockscout
      const txs = await fetchTransactions(chain.blockscout_api, wallet);

      // Step 2: Parse approve() calls to find token:spender pairs
      const approvalPairs = new Map<string, { token: string; spender: string; block: number; timestamp: string }>();

      for (const tx of txs) {
        const input = tx.raw_input || "";
        if (input.startsWith(approveSelector) && input.length >= 138) {
          const spender = "0x" + input.slice(34, 74);
          const token = tx.to?.hash;
          if (token) {
            const key = `${token.toLowerCase()}:${spender.toLowerCase()}`;
            // Keep the most recent approval
            if (!approvalPairs.has(key) || tx.block_number > approvalPairs.get(key)!.block) {
              approvalPairs.set(key, {
                token,
                spender,
                block: tx.block_number,
                timestamp: tx.timestamp,
              });
            }
          }
        }
      }

      // Step 3: For each token:spender pair, check current allowance
      for (const [, pair] of approvalPairs) {
        try {
          const ownerParam = wallet.toLowerCase().replace("0x", "").padStart(64, "0");
          const spenderParam = pair.spender.toLowerCase().replace("0x", "").padStart(64, "0");
          const callData = allowanceSelector + ownerParam + spenderParam;

          const allowanceHex = await ethCall(chain.rpc_url, pair.token, callData);
          const allowanceRaw = decodeUint256(allowanceHex);

          // Skip if allowance is 0 (already revoked)
          if (allowanceRaw === "0") continue;

          const tokenInfo = await getTokenInfo(chain.rpc_url, pair.token);
          const isUnlimited = allowanceRaw === MAX_UINT256;

          // Format human-readable allowance
          let allowanceDisplay: string;
          if (isUnlimited) {
            allowanceDisplay = "Unlimited";
          } else {
            const decimals = tokenInfo.decimals || 18;
            const divisor = BigInt(10) ** BigInt(decimals);
            const wholePart = BigInt(allowanceRaw) / divisor;
            const fractional = BigInt(allowanceRaw) % divisor;
            if (fractional === 0n) {
              allowanceDisplay = `${wholePart.toString()} ${tokenInfo.symbol}`;
            } else {
              const fracStr = fractional.toString().padStart(decimals, "0").slice(0, 4);
              allowanceDisplay = `${wholePart.toString()}.${fracStr} ${tokenInfo.symbol}`;
            }
          }

          // Determine staleness (approval older than 90 days)
          const approvalTime = new Date(pair.timestamp).getTime();
          const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
          const isStale = Date.now() - approvalTime > ninetyDaysMs;

          const spenderInfo = getSpenderInfo(pair.spender);
          const { level, flags } = assessRisk(allowanceRaw, isStale, spenderInfo);

          allApprovals.push({
            token: pair.token,
            token_name: tokenInfo.name,
            token_symbol: tokenInfo.symbol,
            token_decimals: tokenInfo.decimals,
            spender: pair.spender,
            spender_name: spenderInfo.name,
            allowance: allowanceDisplay,
            allowance_raw: allowanceRaw,
            is_unlimited: isUnlimited,
            is_stale: isStale,
            last_approval_block: pair.block,
            last_approval_timestamp: pair.timestamp,
            risk_level: level,
            risk_flags: flags,
          });

          // Build revoke tx for medium and above
          if (level === "medium" || level === "high" || level === "critical") {
            allRevokeTxs.push(buildRevokeTx(pair.token, pair.spender, spenderInfo.name, chain));
          }
        } catch (err) {
          console.error(`Error checking approval for ${pair.token}/${pair.spender}:`, err);
        }
      }
    } catch (err) {
      console.error(`Error scanning chain ${chainName}:`, err);
    }
  }

  // Sort by risk level (critical first)
  const riskOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  allApprovals.sort((a, b) => riskOrder[a.risk_level] - riskOrder[b.risk_level]);

  return {
    wallet,
    chains_scanned: chainsScanned,
    approvals: allApprovals,
    revoke_tx_data: allRevokeTxs,
    summary: {
      total_approvals: allApprovals.length,
      unlimited_approvals: allApprovals.filter((a) => a.is_unlimited).length,
      stale_approvals: allApprovals.filter((a) => a.is_stale).length,
      high_risk_count: allApprovals.filter(
        (a) => a.risk_level === "high" || a.risk_level === "critical"
      ).length,
    },
  };
}

// ─── Agent App ──────────────────────────────────────────────────────────────────

const { app, addEntrypoint } = createAgentApp({
  name: "approval-risk-auditor",
  version: "1.0.0",
  description: "Flag unlimited or stale ERC-20 / NFT approvals and build revoke calls",
});

addEntrypoint({
  key: "audit",
  description: "Audit a wallet's ERC-20 token approvals across chains. Scans transaction history for approve() calls, checks current on-chain allowances, identifies unlimited and stale approvals, and generates revocation transaction data.",
  input: z.object({
    wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid Ethereum address"),
    chains: z.array(z.string()).optional().describe("Chains to scan (ethereum, base, polygon, arbitrum, optimism). Defaults to ethereum only."),
  }),
  price: "0.05",
  async handler({ input }) {
    const wallet = input.wallet as string;
    const chains = (input.chains as string[]) || ["ethereum"];

    const result = await auditWalletApprovals(wallet, chains);

    return {
      output: result,
      usage: {
        total_tokens: JSON.stringify(result).length,
      },
    };
  },
});

// Health check endpoint
app.get("/health", (c) => c.json({
  status: "ok",
  agent: "approval-risk-auditor",
  version: "1.0.0",
  supported_chains: Object.keys(CHAINS),
}));

export default app;
