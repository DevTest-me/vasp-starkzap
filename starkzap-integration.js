// Vasp — Starkzap SDK integration showcase
// This file shows how Vasp uses Starkzap across all features:
//   - Wallet generation & address derivation
//   - Single-token claim links (STRK + any ERC-20 on Starknet)
//   - Batch claim links (normal FCFS + advanced whitelisted)
//   - Direct transfers (STRK + any token)
//   - Token swaps via AVNU DEX aggregator
//   - Gasless claiming via server-side relayer
//
// The full app has more moving parts (UI, encryption, tx history) but this
// file covers every on-chain interaction end-to-end.

import { StarkZap, StarkSigner, OnboardStrategy } from "starkzap";

//  SDK SINGLETON 

let sdk = null;

async function initStarkzap(network = "mainnet") {
  if (sdk) return sdk;
  const networkName = network === "testnet" ? "sepolia" : "mainnet";

  // Force our own RPC proxy so the SDK never routes through third-party nodes
  const rpcUrl = `${window.location.origin}/api/rpc?network=${network}`;

  sdk = new StarkZap({ network: networkName, rpcUrl });
  return sdk;
}

//  WALLET GENERATION 

// Generates a fresh Starknet wallet entirely in-browser.
// The private key is never sent to any server — it gets AES-GCM encrypted
// before being written to localStorage.

async function generateWallet(network = "mainnet") {
  await initStarkzap(network);

  // Starknet curve order — reject keys outside this range
  const CURVE_ORDER = BigInt(
    "3618502788666131213697322783095070105526743751716087489154079457884512865583"
  );

  let privateKey;
  do {
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    privateKey =
      "0x" +
      Array.from(randomBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
  } while (BigInt(privateKey) >= CURVE_ORDER || BigInt(privateKey) === 0n);

  const { wallet } = await sdk.onboard({
    strategy: OnboardStrategy.Signer,
    account: { signer: new StarkSigner(privateKey) },
    deploy: "never", // deploy only on first outgoing tx, not at creation time
  });

  return { address: wallet.address.toString(), privateKey };
}

//  ADDRESS DERIVATION 

// Given a private key, derive its deterministic Starknet address.
// Used during the "import wallet" recovery flow.

async function deriveAddress(privateKey, network = "mainnet") {
  await initStarkzap(network);

  const { wallet } = await sdk.onboard({
    strategy: OnboardStrategy.Signer,
    account: { signer: new StarkSigner(privateKey) },
    deploy: "never",
  });

  return wallet.address.toString();
}

//  HELPERS 

// Split a BigInt amount into Cairo u256 { low, high } calldata parts.
function toU256Calldata(amountWei) {
  const low  = (amountWei & BigInt("0xffffffffffffffffffffffffffffffff")).toString(16);
  const high = (amountWei >> BigInt(128)).toString(16);
  return { low, high };
}

// Hash a plaintext password into a Pedersen felt for on-chain storage.
// The hash is computed client-side so the plaintext never travels anywhere.
async function hashPassword(password) {
  if (!password) return "0x0";
  const { ec } = await import("starknet");
  const pwHex =
    "0x" +
    Array.from(new TextEncoder().encode(password))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 62);
  return ec.starkCurve.pedersen(pwHex, "0x0");
}

// Generate a random claim ID valid as a felt252.
function generateClaimId() {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  bytes[0] &= 0x07; // keep within felt252 range
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

//  SINGLE CLAIM LINK — ANY TOKEN 

// Locks any Starknet ERC-20 token (STRK, ETH, USDC, …) in an escrow contract
// and returns a shareable claim link. The original feature only supported STRK;
// the token address is now passed as a parameter so any registered token works.
//
// Flow: approve(escrow, amount) → create_claim(claimId, amount, expiry, pwHash, tokenAddress)
// Both calls are bundled in a single multicall so they succeed or fail together.

async function createClaimLink({
  privateKey,
  tokenAddress,      // ERC-20 contract address (STRK, ETH, USDC, …)
  tokenDecimals = 18,
  amount,            // human-readable amount (e.g. 1.5)
  escrowAddress,
  password = "",
  expiryHours = 0,
  network = "mainnet",
}) {
  await initStarkzap(network);

  const { wallet } = await sdk.onboard({
    strategy: OnboardStrategy.Signer,
    account: { signer: new StarkSigner(privateKey) },
    deploy: "if_needed", // handles first-time counterfactual deployment
  });

  const claimId    = generateClaimId();
  const amtWei     = BigInt(Math.round(amount * Math.pow(10, tokenDecimals)));
  const { low, high } = toU256Calldata(amtWei);
  const pwHash     = await hashPassword(password);
  const expiryTime = expiryHours > 0
    ? Math.floor(Date.now() / 1000) + Math.floor(expiryHours * 3600)
    : 0;

  const tx = await wallet.execute([
    {
      // Step 1 — approve escrow to pull the tokens
      contractAddress: tokenAddress,
      entrypoint: "approve",
      calldata: [escrowAddress, low, high],
    },
    {
      // Step 2 — lock funds and register claim parameters on-chain
      contractAddress: escrowAddress,
      entrypoint: "create_claim",
      calldata: [claimId, low, high, expiryTime.toString(), pwHash, tokenAddress],
    },
  ]);

  const txHash = tx?.transaction_hash || tx?.transactionHash || tx?.hash;
  if (!txHash) throw new Error("No transaction hash returned");

  if (typeof tx.wait === "function") await tx.wait();
  else await new Promise((r) => setTimeout(r, 5000));

  return { claimId, txHash };
}

//  BATCH CLAIM LINKS — NORMAL (FCFS) 

// Creates N independent claim IDs in a single multicall.
// All slots share the same per-person amount and optional password.
// Anyone with the batch link can claim a slot until they're gone (first-come,
// first-served). The backend assigns slots atomically to prevent double-claims.
//
// Flow: approve(escrow, total) → create_claim × N
// All N+1 calls go in one wallet.execute() so gas is paid once.

async function createBatchClaimLinks({
  privateKey,
  tokenAddress,
  tokenDecimals = 18,
  amountPerSlot,     // human-readable, per person
  slots,             // number of claim slots (2–10)
  escrowAddress,
  password = "",
  expiryHours = 0,
  network = "mainnet",
}) {
  await initStarkzap(network);

  const { wallet } = await sdk.onboard({
    strategy: OnboardStrategy.Signer,
    account: { signer: new StarkSigner(privateKey) },
    deploy: "if_needed",
  });

  const claimIds   = Array.from({ length: slots }, () => generateClaimId());
  const slotWei    = BigInt(Math.round(amountPerSlot * Math.pow(10, tokenDecimals)));
  const totalWei   = slotWei * BigInt(slots);
  const slot256    = toU256Calldata(slotWei);
  const total256   = toU256Calldata(totalWei);
  const pwHash     = await hashPassword(password);
  const expiryTime = expiryHours > 0
    ? Math.floor(Date.now() / 1000) + Math.floor(expiryHours * 3600)
    : 0;

  const tx = await wallet.execute([
    {
      // Approve the full total in one go
      contractAddress: tokenAddress,
      entrypoint: "approve",
      calldata: [escrowAddress, total256.low, total256.high],
    },
    // One create_claim per slot
    ...claimIds.map((id) => ({
      contractAddress: escrowAddress,
      entrypoint: "create_claim",
      calldata: [id, slot256.low, slot256.high, expiryTime.toString(), pwHash, tokenAddress],
    })),
  ]);

  const txHash = tx?.transaction_hash || tx?.transactionHash || tx?.hash;
  if (!txHash) throw new Error("No transaction hash returned");

  if (typeof tx.wait === "function") await tx.wait();
  else await new Promise((r) => setTimeout(r, 6000));

  return { claimIds, txHash };
}

//  BATCH CLAIM LINKS — ADVANCED (WHITELISTED) 

// Creates one claim ID per whitelisted address, each with its own allocation.
// Only the exact wallet listed can claim its slot — enforced via a server-side
// Merkle proof + signature verification flow.
//
// For the Merkle-root-only variant (DAOs with pre-computed trees), a single
// claim ID covers the full pool and the project manages proof distribution.
//
// A $2 USD platform fee (paid in STRK) is charged on mainnet to cover
// the higher gas cost of verifying proofs at claim time.

async function createAdvancedBatchLinks({
  privateKey,
  tokenAddress,
  tokenDecimals = 18,
  entries,           // [{ address, amount }] — one per whitelisted wallet
  escrowAddress,
  password = "",
  expiryHours = 0,
  platformFeeSTRK = 0,  // computed by caller based on live STRK/USD price
  strkTokenAddress,     // needed for platform fee transfer (mainnet only)
  vaspFeeWallet,
  network = "mainnet",
}) {
  await initStarkzap(network);

  const { wallet } = await sdk.onboard({
    strategy: OnboardStrategy.Signer,
    account: { signer: new StarkSigner(privateKey) },
    deploy: "if_needed",
  });

  // One claim ID per whitelisted wallet
  const perWalletIds = entries.map(() => generateClaimId());

  // Compute per-entry amounts as BigInt to avoid floating-point drift
  const perEntryWeis = entries.map((e) =>
    BigInt(Math.round(e.amount * Math.pow(10, tokenDecimals)))
  );
  const totalWei  = perEntryWeis.reduce((s, w) => s + w, 0n);
  const total256  = toU256Calldata(totalWei);
  const pwHash    = await hashPassword(password);
  const expiryTime = expiryHours > 0
    ? Math.floor(Date.now() / 1000) + Math.floor(expiryHours * 3600)
    : 0;

  const feeWei  = platformFeeSTRK > 0 ? BigInt(Math.round(platformFeeSTRK * 1e18)) : 0n;
  const fee256  = feeWei > 0n ? toU256Calldata(feeWei) : null;

  const tx = await wallet.execute([
    // Optional $2 platform fee — STRK transfer to Vasp fee wallet (mainnet only)
    ...(fee256 ? [{
      contractAddress: strkTokenAddress,
      entrypoint: "transfer",
      calldata: [vaspFeeWallet, fee256.low, fee256.high],
    }] : []),
    // Approve exact total
    {
      contractAddress: tokenAddress,
      entrypoint: "approve",
      calldata: [escrowAddress, total256.low, total256.high],
    },
    // One create_claim per whitelisted wallet
    ...entries.map((entry, i) => {
      const entryWei = perEntryWeis[i];
      const e256 = toU256Calldata(entryWei);
      return {
        contractAddress: escrowAddress,
        entrypoint: "create_claim",
        calldata: [
          perWalletIds[i],
          e256.low,
          e256.high,
          expiryTime.toString(),
          pwHash,
          tokenAddress,
        ],
      };
    }),
  ]);

  const txHash = tx?.transaction_hash || tx?.transactionHash || tx?.hash;
  if (!txHash) throw new Error("No transaction hash returned");

  if (typeof tx.wait === "function") await tx.wait();
  else await new Promise((r) => setTimeout(r, 6000));

  // Map each whitelisted address to its dedicated claim ID
  const claimIdMap = Object.fromEntries(
    entries.map((e, i) => [e.address.toLowerCase(), perWalletIds[i]])
  );

  return { perWalletIds, claimIdMap, txHash };
}

//  DIRECT TOKEN TRANSFER 

// Sends any Starknet ERC-20 token directly to a recipient address via the
// escrow's external_transfer entrypoint, which deducts the 0.12% protocol
// fee on-chain. Works for STRK, ETH, USDC, and any other registered token.
//
// The original feature only supported STRK; passing tokenAddress makes it
// work for the entire token list discovered by discoverWalletTokens().

async function sendToken({
  privateKey,
  recipientAddress,
  tokenAddress,
  tokenDecimals = 18,
  amount,            // human-readable
  escrowAddress,
  network = "mainnet",
}) {
  await initStarkzap(network);

  const { wallet } = await sdk.onboard({
    strategy: OnboardStrategy.Signer,
    account: { signer: new StarkSigner(privateKey) },
    deploy: "if_needed",
  });

  const amtWei = BigInt(Math.round(amount * Math.pow(10, tokenDecimals)));
  const { low, high } = toU256Calldata(amtWei);

  // approve → external_transfer (fee deducted by contract, not client)
  const tx = await wallet.execute([
    {
      contractAddress: tokenAddress,
      entrypoint: "approve",
      calldata: [escrowAddress, low, high],
    },
    {
      contractAddress: escrowAddress,
      entrypoint: "external_transfer",
      calldata: [recipientAddress, low, high, tokenAddress],
    },
  ]);

  return tx?.transaction_hash || tx?.transactionHash || tx?.hash;
}

//  TOKEN SWAP VIA AVNU 

// Executes a swap between any two Starknet tokens using the AVNU DEX
// aggregator. Quote → Build → Execute is a three-step flow:
//
//   1. GET /swap/v2/quotes  — find best route (sellAmount must be hex)
//   2. POST /swap/v2/build  — compile calldata for the chosen quote
//   3. wallet.execute(calls) — sign and broadcast via Starkzap
//
// A 0.12% integrator fee is collected by Vasp through AVNU's fee-split system.

const AVNU_SWAP_URL      = "https://starknet.api.avnu.fi/swap/v2";
const VASP_FEE_BPS       = 12;
const VASP_FEE_RECIPIENT = "0x0522b63feaf605f43eeb2084b83b0b552c2dcd52b031474c0e35bf3c9c4e2710";

async function getSwapQuote({
  sellTokenAddress,
  buyTokenAddress,
  sellAmount,        // human-readable (e.g. 1.5)
  sellDecimals = 18,
  takerAddress,
}) {
  // AVNU requires sellAmount as a hex string — not decimal
  const amtWei = BigInt(Math.round(sellAmount * Math.pow(10, sellDecimals)));
  const amtHex = "0x" + amtWei.toString(16);

  const params = new URLSearchParams({
    sellTokenAddress,
    buyTokenAddress,
    sellAmount:             amtHex,          // ← hex, not decimal
    takerAddress,
    integratorFeesBps:      VASP_FEE_BPS.toString(),
    integratorName:         "Vasp",
    integratorFeeRecipient: VASP_FEE_RECIPIENT,
  });

  const res = await fetch(`${AVNU_SWAP_URL}/quotes?${params}`);
  if (!res.ok) throw new Error(`Quote failed: ${res.status}`);
  const data   = await res.json();
  const quotes = Array.isArray(data) ? data : (data.quotes || [data]);
  if (!quotes.length) throw new Error("No route found");

  // Key fields returned by AVNU v2 (confirmed against live API):
  //   quoteId, buyAmount (hex wei), buyAmountInUsd, estimatedSlippage,
  //   priceRatioUsd, gasFees, gasFeesInUsd, estimatedAmount (bool),
  //   integratorFees, integratorFeesInUsd, routes, gasless, exactTokenTo
  return quotes[0];
}

async function executeSwap({
  privateKey,
  quote,             // object returned by getSwapQuote()
  takerAddress,
  slippage = 0.005,  // 0.5% default
  network = "mainnet",
}) {
  // Step 1 — build calldata from the accepted quote
  const buildRes = await fetch(`${AVNU_SWAP_URL}/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteId:                quote.quoteId,
      takerAddress,
      slippage,
      integratorFeesBps:      VASP_FEE_BPS,
      integratorName:         "Vasp",
      integratorFeeRecipient: VASP_FEE_RECIPIENT,
    }),
  });
  if (!buildRes.ok) throw new Error("Build failed");
  const buildData = await buildRes.json();

  // Step 2 — execute via Starkzap
  await initStarkzap(network);

  const { wallet } = await sdk.onboard({
    strategy: OnboardStrategy.Signer,
    account: { signer: new StarkSigner(privateKey) },
    deploy: "if_needed",
  });

  // AVNU /build returns a ready-to-execute calls array
  const calls = buildData.calls || [buildData];
  const tx    = await wallet.execute(calls);

  return tx?.transaction_hash || tx?.transactionHash || tx?.hash;
}

//  GASLESS CLAIMING 

// The claim step itself is handled server-side by a funded relayer wallet.
// This is what makes Vasp work without the recipient having any STRK for gas —
// the relayer signs and broadcasts the claim transaction on their behalf.
//
// Before calling the relayer, /api/verify-claim performs a read-only pre-check
// (claim state + password hash) so we never waste gas on invalid claims.
//
// Works for all token types — the escrow stores the token address on-chain
// and the relayer resolves it automatically.

async function claimFunds({
  claimId,
  providedPassword = "",
  recipientAddress,
  network = "mainnet",
  relayerEndpoint = "/api/relay-claim",
}) {
  // Encode password as felt252 (same encoding used at link-creation time)
  let pwFelt = "0x0";
  if (providedPassword) {
    pwFelt =
      "0x" +
      Array.from(new TextEncoder().encode(providedPassword))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 62);
  }

  // Pre-check: verify claim state + password before spending relayer gas
  const verifyRes = await fetch("/api/verify-claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claimId, pwFelt, network }),
  });
  const verifyData = await verifyRes.json();
  if (verifyData.alreadyClaimed) throw new Error("Already claimed");
  if (verifyData.wrongPassword)  throw new Error("Wrong password");
  if (!verifyData.ok)            throw new Error(verifyData.error || "Verification failed");

  // Relay: the server signs and broadcasts the actual claim transaction
  const res = await fetch(relayerEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claimId, pwFelt, recipientAddress, network }),
  });
  const data = await res.json();

  if (!data.success) throw new Error(data.error || "Relay failed");
  return data.txHash;
}

//  ADVANCED BATCH CLAIMING — SIGNATURE VERIFICATION 

// For whitelisted batches, the recipient proves ownership of their wallet by
// signing a server-issued nonce with their Starknet private key. This works
// even for undeployed (counterfactual) wallets because we verify off-chain
// using the raw ECDSA signature on the Stark curve — no on-chain call needed.
//
// Flow:
//   1. POST /api/batch-whitelist-check  — server checks eligibility, issues nonce
//   2. wallet.signMessage(typedData)    — sign nonce with Starkzap
//   3. POST /api/batch-claim-advanced   — server verifies sig, relays claim tx

async function signBatchClaimNonce({
  privateKey,
  nonce,
  walletAddress,
  network = "mainnet",
}) {
  await initStarkzap(network);

  const { wallet } = await sdk.onboard({
    strategy: OnboardStrategy.Signer,
    account: { signer: new StarkSigner(privateKey) },
    deploy: "never", // claimant may not be deployed yet — that's fine
  });

  const msgData = {
    types: {
      StarkNetDomain: [
        { name: "name",    type: "felt" },
        { name: "version", type: "felt" },
        { name: "chainId", type: "felt" },
      ],
      BatchClaim: [{ name: "nonce", type: "felt" }],
    },
    primaryType: "BatchClaim",
    domain: {
      name:    "Vasp",
      version: "2",
      chainId: network === "mainnet" ? "SN_MAIN" : "SN_SEPOLIA",
    },
    message: { nonce },
  };

  const signature = await wallet.signMessage(msgData);

  // Extract r, s from the signature object
  const r = Array.isArray(signature) ? signature[0] : signature.r;
  const s = Array.isArray(signature) ? signature[1] : signature.s;

  // Derive the public key (x-coordinate) for server-side off-chain verification
  const { ec } = await import("starknet");
  const rawPriv  = privateKey.replace(/^0x/i, "");
  const fullPub  = ec.starkCurve.getPublicKey(rawPriv, false); // uncompressed point
  const publicKey = Array.from(fullPub).map((b) => b.toString(16).padStart(2, "0")).join("");

  return { r: r.toString(), s: s.toString(), publicKey };
}

//  EXPORTS 

export {
  initStarkzap,
  generateWallet,
  deriveAddress,
  createClaimLink,
  createBatchClaimLinks,
  createAdvancedBatchLinks,
  sendToken,
  getSwapQuote,
  executeSwap,
  claimFunds,
  signBatchClaimNonce,
};
