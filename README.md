# Vasp — Send crypto via a link

Vasp lets you send STRK to anyone on Starknet, even if they don't have a wallet yet. The sender locks funds in a smart contract and shares a link. The recipient claims it and a wallet is automatically created for them on the spot, no setup required.

Built with the [Starkzap SDK](https://starkzap.xyz).

---

## What it does

- Generate a Starknet wallet entirely in-browser (no backend, no custodian)
- Encrypt the private key locally with AES-GCM + PBKDF2 (310k iterations)
- Create a claim link that locks STRK in an escrow contract
- Optional password protection and expiry on links
- Recipients claim without any gas — a relayer handles the transaction
- Recipient's wallet deploys on-chain automatically on their first outgoing send
- Send directly to an existing Starknet address with a 0.12% protocol fee

---

## How Starkzap is used

Everything that touches the Starknet network goes through the Starkzap SDK.

**Wallet generation**

```
const sdk = new StarkZap({ network: "mainnet" });

const { wallet } = await sdk.onboard({
  strategy: OnboardStrategy.Signer,
  account: { signer: new StarkSigner(privateKey) },
  deploy: "never"
});
```

**Sending / creating a claim link (multicall)**

```
const { wallet } = await sdk.onboard({
  strategy: OnboardStrategy.Signer,
  account: { signer: new StarkSigner(privateKey) },
  deploy: "if_needed" // handles first-time wallet deployment automatically
});

await wallet.execute([
  {
    contractAddress: STRK_TOKEN,
    entrypoint: "approve",
    calldata: [ESCROW_ADDRESS, amtLow, amtHigh]
  },
  {
    contractAddress: ESCROW_ADDRESS,
    entrypoint: "create_claim",
    calldata: [claimId, amtLow, amtHigh, expiry, passwordHash]
  }
]);
```

The `deploy: "if_needed"` flag is what makes the first-transaction experience seamless, Starkzap handles counterfactual deployment transparently.

---

## Architecture

```
Sender (browser)
  └── Starkzap SDK
        └── wallet.execute([approve, create_claim])
              └── Escrow contract (Starknet)

Recipient (browser)
  └── No wallet needed
        └── POST /api/relay-claim
              └── Relayer wallet (server)
                    └── Starkzap SDK
                          └── escrow.claim(claimId, pwFelt, recipientAddress)
```

The relayer is a server-side wallet that pays gas on behalf of recipients. This is the key piece that makes claiming gasless. The relayer's private key never touches the client.

---

## Starkzap integration file

[`starkzap-integration.js`](./starkzap-integration.js) contains the isolated SDK integration — wallet generation, address derivation, multicall execution, and the relayer call pattern. It's the cleanest reference for how Vasp uses Starkzap end to end.

---

## Environment variables

```env
RELAYER_PRIVATE_KEY=        # starknet private key for the relayer wallet
STARKNET_RPC_MAINNET=       # mainnet RPC endpoint
STARKNET_RPC_TESTNET=       # sepolia RPC endpoint
ESCROW_ADDRESS_MAINNET=     # deployed escrow contract address
ESCROW_ADDRESS_TESTNET=     # testnet escrow contract address
```

---

## Running locally

```
npm install
npm run dev
```

The frontend is a single `index.html` + `app.js`. No framework. The only server-side piece is the relayer API (`/api/relay-claim`, `/api/relay-refund`) which needs a funded Starknet wallet to operate.

---

## Escrow contract

The escrow is a Cairo contract deployed on Starknet. It handles:
- `create_claim` — locks STRK with optional password hash and expiry
- `claim` — releases funds to recipient if password matches
- `refund` — returns funds to sender after expiry

Contract source is not included in this repo. The deployed addresses are in `.env.example`.
