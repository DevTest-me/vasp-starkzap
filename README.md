# Vasp — Send crypto via a link

Vasp lets you send any Starknet token to anyone, even if they don't have a wallet yet. The sender locks funds in a smart contract and shares a link. The recipient claims it and a wallet is automatically created for them on the spot — no setup, no gas required.

Built with the [Starkzap SDK](https://starkzap.xyz).

---

## What it does

- Generate a Starknet wallet entirely in-browser (no backend, no custodian)
- Encrypt the private key locally with AES-GCM + PBKDF2 (310k iterations)
- Create a claim link that locks **any ERC-20 token** (STRK, ETH, USDC, …) in an escrow contract
- **Batch claim links** — lock funds for multiple recipients in a single transaction (FCFS or whitelisted)
- Optional password protection and expiry on all link types
- Recipients claim without any gas — a relayer handles the transaction
- Recipient's wallet deploys on-chain automatically on their first outgoing send
- Send any token directly to an existing Starknet address with a 0.12% protocol fee
- **Token swaps** via AVNU DEX aggregator — swap any held token into any other

---

## How Starkzap is used

Every on-chain interaction goes through the Starkzap SDK. The pattern is always the same: `sdk.onboard()` to get a wallet object, then `wallet.execute()` for transactions and `wallet.signMessage()` for signing.

### Wallet generation

```js
const sdk = new StarkZap({ network: "mainnet", rpcUrl: "/api/rpc?network=mainnet" });

const { wallet } = await sdk.onboard({
  strategy: OnboardStrategy.Signer,
  account: { signer: new StarkSigner(privateKey) },
  deploy: "never"  // deploy only on first outgoing tx, not at creation time
});
```

### Single claim link — any token

The token address is passed as a parameter so any registered Starknet ERC-20 works, not just STRK.

```js
const { wallet } = await sdk.onboard({
  strategy: OnboardStrategy.Signer,
  account: { signer: new StarkSigner(privateKey) },
  deploy: "if_needed"  // handles first-time counterfactual deployment
});

await wallet.execute([
  {
    contractAddress: tokenAddress,   // STRK, ETH, USDC, or any ERC-20
    entrypoint: "approve",
    calldata: [escrowAddress, amtLow, amtHigh]
  },
  {
    contractAddress: escrowAddress,
    entrypoint: "create_claim",
    calldata: [claimId, amtLow, amtHigh, expiryTime, passwordHash, tokenAddress]
  }
]);
```

`deploy: "if_needed"` is what makes the first-transaction experience seamless — Starkzap handles counterfactual deployment transparently so the sender never has to think about it.

### Batch claim links — normal (FCFS)

Creates N independent claim IDs in a single multicall. All N+1 calls go in one `wallet.execute()` so gas is paid once.

```js
const claimIds = Array.from({ length: slots }, () => generateClaimId());

await wallet.execute([
  {
    // Approve the full total in one go
    contractAddress: tokenAddress,
    entrypoint: "approve",
    calldata: [escrowAddress, totalLow, totalHigh]
  },
  // One create_claim per slot
  ...claimIds.map(id => ({
    contractAddress: escrowAddress,
    entrypoint: "create_claim",
    calldata: [id, slotLow, slotHigh, expiryTime, passwordHash, tokenAddress]
  }))
]);
```

The backend assigns slots atomically (PostgreSQL row-level locking) to prevent double-claims. One wallet cannot claim twice from the same batch.

### Batch claim links — advanced (whitelisted)

Creates one claim ID per whitelisted wallet, each with its own allocation. Only the exact wallet listed can claim its slot, enforced via server-side Merkle proof and signature verification.

```js
// One create_claim per whitelisted wallet
await wallet.execute([
  { contractAddress: tokenAddress, entrypoint: "approve", calldata: [escrowAddress, totalLow, totalHigh] },
  ...entries.map((entry, i) => ({
    contractAddress: escrowAddress,
    entrypoint: "create_claim",
    calldata: [perWalletIds[i], entryLow, entryHigh, expiryTime, passwordHash, tokenAddress]
  }))
]);
```

A $2 USD platform fee (paid in STRK) is charged on mainnet for advanced batches to cover the higher verification cost.

### Direct token transfer

Sends any ERC-20 token through the escrow's `external_transfer` entrypoint, which deducts the protocol fee on-chain.

```js
await wallet.execute([
  {
    contractAddress: tokenAddress,
    entrypoint: "approve",
    calldata: [escrowAddress, amtLow, amtHigh]
  },
  {
    contractAddress: escrowAddress,
    entrypoint: "external_transfer",
    calldata: [recipientAddress, amtLow, amtHigh, tokenAddress]
  }
]);
```

### Token swaps via AVNU

Swaps between any two Starknet tokens using the AVNU DEX aggregator. Quote → Build → Execute:

```js
// Step 1 — get best route (sellAmount must be hex, not decimal)
const amtHex = "0x" + amtWei.toString(16);
const params = new URLSearchParams({
  sellTokenAddress, buyTokenAddress,
  sellAmount: amtHex,                  // ← hex required by AVNU v2
  takerAddress,
  integratorFeesBps: "12",
  integratorName: "Vasp",
  integratorFeeRecipient: VASP_FEE_RECIPIENT,
});
const [quote] = await fetch(`https://starknet.api.avnu.fi/swap/v2/quotes?${params}`).then(r => r.json());

// Step 2 — build calldata
const { calls } = await fetch("https://starknet.api.avnu.fi/swap/v2/build", {
  method: "POST",
  body: JSON.stringify({ quoteId: quote.quoteId, takerAddress, slippage: 0.005,
                         integratorFeesBps: 12, integratorName: "Vasp",
                         integratorFeeRecipient: VASP_FEE_RECIPIENT })
}).then(r => r.json());

// Step 3 — execute via Starkzap
await wallet.execute(calls);
```

Key AVNU v2 response fields (confirmed against live API): `quoteId`, `buyAmount` (hex wei), `buyAmountInUsd`, `estimatedSlippage`, `priceRatioUsd`, `gasFees`, `estimatedAmount` (bool — `true` means estimate, not firm quote).

### Advanced batch claiming — signature verification

For whitelisted batches, recipients prove wallet ownership by signing a server-issued nonce. This works even for undeployed (counterfactual) wallets because verification is done off-chain on the Stark curve.

```js
const { wallet } = await sdk.onboard({
  strategy: OnboardStrategy.Signer,
  account: { signer: new StarkSigner(privateKey) },
  deploy: "never"  // claimant may not be deployed yet — that's fine
});

const signature = await wallet.signMessage({
  types: { StarkNetDomain: [...], BatchClaim: [{ name: "nonce", type: "felt" }] },
  primaryType: "BatchClaim",
  domain: { name: "Vasp", version: "2", chainId: "SN_MAIN" },
  message: { nonce }
});

// Derive public key for off-chain server verification
const { ec } = await import("starknet");
const fullPub  = ec.starkCurve.getPublicKey(privateKey.replace("0x", ""), false);
const publicKey = Array.from(fullPub).map(b => b.toString(16).padStart(2, "0")).join("");
```

---

## Architecture

```
Sender (browser)
  └── Starkzap SDK
        └── wallet.execute([approve, create_claim × N])
              └── Escrow contract (Starknet)
                    └── Stores: claimId → { sender, amount, expiry, pwHash, tokenAddress }

Recipient (browser)
  └── No wallet or gas needed
        └── POST /api/verify-claim   (read-only pre-check — no gas spent)
              └── POST /api/relay-claim
                    └── Relayer wallet (server)
                          └── escrow.claim(claimId, pwFelt, recipientAddress)
                                └── Token released to recipient

Advanced batch recipient
  └── POST /api/batch-whitelist-check  (eligibility + nonce)
        └── wallet.signMessage(nonce)  via Starkzap
              └── POST /api/batch-claim-advanced
                    └── Off-chain sig verify → relayer.execute(claim)
```

The relayer is a server-side Starknet wallet funded with STRK. It pays gas on behalf of all recipients — this is the core mechanism that makes claiming gasless. The relayer's private key never touches the client.

---

## Starkzap integration file

[`starkzap-integration.js`](./starkzap-integration.js) contains the complete SDK integration — wallet generation, address derivation, single and batch claim links, direct token transfers, AVNU swaps, and the relayer claim + signature patterns. It's the cleanest reference for how Vasp uses Starkzap end to end.

---

## Environment variables

```env
RELAYER_PRIVKEY=           # Starknet private key for the relayer wallet
RELAYER_ADDRESS=           # Relayer wallet address
RPC_MAINNET=               # Mainnet RPC endpoint
RPC_MAINNET_BACKUP=        # Backup mainnet RPC
RPC_MAINNET_BACKUP2=       # Second backup mainnet RPC
RPC_TESTNET=               # Sepolia RPC endpoint
RPC_TESTNET_BACKUP=        # Backup testnet RPC
RPC_TESTNET_BACKUP2=       # Second backup testnet RPC
RPC_TESTNET_BACKUP3=       # Third backup testnet RPC
ESCROW_MAINNET=            # Deployed escrow contract address (mainnet)
ESCROW_TESTNET=            # Deployed escrow contract address (Sepolia)
DATABASE_URL=              # PostgreSQL connection string (for batch state)
ADMIN_KEY=                 # Secret for /admin dashboard access
```

---

## Running locally

```bash
npm install
npm run dev
```

The frontend is a single `index.html` + `app.js` + `tokens.js`. No framework. The server (`server.js`) handles RPC proxying, the relayer API, and batch state via PostgreSQL.

---

## Escrow contract

The escrow is a Cairo contract deployed on Starknet. It handles:

- `create_claim` — locks any ERC-20 token with optional password hash, expiry, and token address
- `claim` — releases funds to recipient if password matches and claim is unclaimed
- `refund` — returns funds to sender after expiry (callable by relayer sweep)
- `external_transfer` — direct send with protocol fee deducted on-chain
- `get_claim` — read-only view for pre-claim verification

Contract source is not included in this repo. Deployed addresses are in `.env.example`.
