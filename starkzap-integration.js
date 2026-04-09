// Vasp — Starkzap SDK integration showcase
// This file shows how Vasp uses Starkzap to power its wallet and claim link features.
// The full app has more moving parts (UI, encryption, tx history) but this is the core.

import { StarkZap, StarkSigner, OnboardStrategy } from "starkzap";

// one sdk instance per session, re-used across all operations
let sdk = null;

async function initStarkzap(network = "mainnet") {
  if (sdk) return sdk;
  const networkName = network === "testnet" ? "sepolia" : "mainnet";
  sdk = new StarkZap({ network: networkName });
  return sdk;
}


// WALLET GENERATION
// generates a fresh starknet wallet entirely in-browser, no server involved
// the private key never leaves the device — it gets encrypted before storage

async function generateWallet(network = "mainnet") {
  await initStarkzap(network);

  // starknet curve order — we reject keys outside this range
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
    deploy: "never", // don't deploy on creation, only when the user sends their first tx
  });

  return {
    address: wallet.address.toString(),
    privateKey,
  };
}


// ADDRESS DERIVATION
// given a private key, derive its starknet address
// used during the "import wallet" recovery flow

async function deriveAddress(privateKey, network = "mainnet") {
  await initStarkzap(network);

  const { wallet } = await sdk.onboard({
    strategy: OnboardStrategy.Signer,
    account: { signer: new StarkSigner(privateKey) },
    deploy: "never",
  });

  return wallet.address.toString();
}


// CLAIM LINK CREATION
// locks STRK in an escrow contract and returns a shareable link
// recipient can claim without having a wallet — the relayer handles deployment
//
// flow: approve escrow → create_claim (multicall) → share link
// the password is hashed client-side before going on-chain

async function createClaimLink({
  privateKey,
  amountSTRK,
  escrowAddress,
  strkTokenAddress,
  password = "",
  expiryHours = 0,
  network = "mainnet",
}) {
  await initStarkzap(network);

  const { wallet } = await sdk.onboard({
    strategy: OnboardStrategy.Signer,
    account: { signer: new StarkSigner(privateKey) },
    deploy: "if_needed", // deploys wallet on first tx if not already deployed
  });

  // generate a unique claim id from timestamp + random suffix
  const rawId =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const claimId =
    "0x" +
    Array.from(new TextEncoder().encode(rawId))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 62);

  // split amount into u256 low/high for cairo calldata
  const amtWei = BigInt(Math.round(amountSTRK * 1e18));
  const amtLow = (
    amtWei & BigInt("0xffffffffffffffffffffffffffffffff")
  ).toString();
  const amtHigh = (amtWei >> BigInt(128)).toString();

  // hash the password as a pedersen felt so it never travels in plaintext
  let passwordHash = "0x0";
  if (password) {
    const pwBytes = new TextEncoder().encode(password);
    const pwHex = Array.from(pwBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const pwFelt = "0x" + pwHex.slice(0, 62);

    const { ec } = await import("starknet");
    passwordHash = ec.starkCurve.pedersen(pwFelt, "0x0");
  }

  const expiryTimestamp =
    expiryHours > 0
      ? Math.floor(Date.now() / 1000) + Math.floor(expiryHours * 3600)
      : 0;

  // multicall: approve + create_claim in one transaction
  const tx = await wallet.execute([
    {
      contractAddress: strkTokenAddress,
      entrypoint: "approve",
      calldata: [escrowAddress, amtLow, amtHigh],
    },
    {
      contractAddress: escrowAddress,
      entrypoint: "create_claim",
      calldata: [
        claimId,
        amtLow,
        amtHigh,
        expiryTimestamp.toString(),
        passwordHash,
      ],
    },
  ]);

  const txHash =
    tx?.transaction_hash ||
    tx?.transactionHash ||
    tx?.hash ||
    tx?.result?.transaction_hash;

  if (!txHash) throw new Error("No transaction hash returned");

  // wait for confirmation before handing back the link
  if (typeof tx.wait === "function") {
    await tx.wait();
  } else {
    await new Promise((r) => setTimeout(r, 5000));
  }

  return { claimId, txHash };
}


// EXTERNAL TRANSFER
// sends STRK to another wallet via the escrow contract
// the contract takes a small protocol fee on-chain — nothing extra client-side
//
// same multicall pattern: approve → external_transfer

async function sendSTRK({
  privateKey,
  recipientAddress,
  amountSTRK,
  escrowAddress,
  strkTokenAddress,
  network = "mainnet",
}) {
  await initStarkzap(network);

  const { wallet } = await sdk.onboard({
    strategy: OnboardStrategy.Signer,
    account: { signer: new StarkSigner(privateKey) },
    deploy: "if_needed",
  });

  const amtWei = BigInt(Math.round(amountSTRK * 1e18));
  const amtLow = (
    amtWei & BigInt("0xffffffffffffffffffffffffffffffff")
  ).toString();
  const amtHigh = (amtWei >> BigInt(128)).toString();

  const tx = await wallet.execute([
    {
      contractAddress: strkTokenAddress,
      entrypoint: "approve",
      calldata: [escrowAddress, amtLow, amtHigh],
    },
    {
      contractAddress: escrowAddress,
      entrypoint: "external_transfer",
      calldata: [recipientAddress, amtLow, amtHigh],
    },
  ]);

  return tx?.transaction_hash || tx?.transactionHash || tx?.hash;
}


// GASLESS CLAIMING
// the claim step itself is handled server-side by a relayer wallet
// this is what makes Vasp work without the recipient having any STRK for gas
//
// client sends: claimId + password felt + recipient address
// relayer signs and broadcasts the claim transaction on behalf of the recipient
// recipient's wallet deploys automatically on their first outgoing send

async function claimFunds({
  claimId,
  providedPassword = "",
  recipientAddress,
  network = "mainnet",
  relayerEndpoint = "/api/relay-claim",
}) {
  // encode password as felt252 for the contract
  let pwFelt = "0x0";
  if (providedPassword) {
    pwFelt =
      "0x" +
      Array.from(new TextEncoder().encode(providedPassword))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 62);
  }

  // the actual starknet transaction is signed and broadcast by the relayer
  // client just sends the claim parameters
  const res = await fetch(relayerEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      claimId,
      pwFelt,
      recipientAddress,
      network,
    }),
  });

  const data = await res.json();

  if (!data.success) {
    throw new Error(data.error || "Relay failed");
  }

  return data.txHash;
}


export {
  initStarkzap,
  generateWallet,
  deriveAddress,
  createClaimLink,
  sendSTRK,
  claimFunds,
};
