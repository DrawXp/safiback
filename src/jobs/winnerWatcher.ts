import { ethers, Contract, Interface, Log } from "ethers";
import { provider as baseProvider, requireSigner, ADDR, loadAbi } from "../config/env";

const vaultAbi  = loadAbi("SAFIVault");
const rewardAbi = loadAbi("VaultReward");

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const RUN_SELECTOR = ethers.id("run()").slice(0, 10);
const inFlight = new Set<string>();

type Phase =
  | "init" | "receipt.wait" | "receipt.got" | "tx.load"
  | "tx.valid.to" | "tx.valid.selector"
  | "day.read.tryBlockTag" | "day.read.latest"
  | "state.load" | "already.recorded"
  | "prechecks" | "gas.estimate" | "tx.send" | "tx.mined"
  | "postcheck" | "done" | "error";

function log(where: string, phase: Phase, data?: any) {
  const ts = new Date().toISOString();
  const fn = phase === "error" ? console.error : console.log;
  fn(`[${ts}] ${where} ${phase}`, data ?? "");
}

function getCtx() {
  if (!baseProvider) return { ok: false as const, code: "provider-missing" };
  let signer: ethers.Wallet | undefined;
  try { signer = requireSigner(); } catch { signer = undefined; }
  const provider  = baseProvider;
  const vaultRead = new Contract(ADDR.VAULT,       vaultAbi,  provider);
  const rewardR   = new Contract(ADDR.VAULTREWARD, rewardAbi, provider);
  const rewardW   = signer ? new Contract(ADDR.VAULTREWARD, rewardAbi, signer) : null;
  return { ok: true as const, provider, vaultRead, rewardR, rewardW, signer };
}

/**
 * Garante (idempotente) que o run() dado por txHash resulte em recordWinner(day, runner, uniq).
 * Retorna ok/already/recorded + detalhes.
 */
export async function scanHintRpc(txHash: string) {
  const ctx = getCtx();
  if (!ctx.ok) {
    log("scanHintRpc", "error", { code: "provider-missing" });
    return { ok: false, code: "provider-missing" };
  }
  const { provider, vaultRead, rewardR, rewardW, signer } = ctx;

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    log("scanHintRpc", "error", { code: "invalid-hash" });
    return { ok: false, code: "invalid-hash" };
  }
  if (inFlight.has(txHash)) {
    log("scanHintRpc", "receipt.wait", { dedup: true, txHash });
    return { ok: false, pending: true, code: "dedup" };
  }

  inFlight.add(txHash);
  let phase: Phase = "init";
  try {
    phase = "receipt.wait";
    let rc = await provider.getTransactionReceipt(txHash);
    for (let i = 0; i < 18 && !rc; i++) {
      await new Promise(r => setTimeout(r, 5000));
      rc = await provider.getTransactionReceipt(txHash);
    }
    if (!rc) {
      log("scanHintRpc", "error", { code: "no-receipt" });
      return { ok: false, pending: true, code: "no-receipt" };
    }
    log("scanHintRpc", "receipt.got", { blockNumber: rc.blockNumber, status: rc.status });
    if (rc.status !== 1) {
      log("scanHintRpc", "error", { code: "tx-failed", status: rc.status });
      return { ok: false, code: "tx-failed", status: rc.status };
    }

    phase = "tx.load";
    const tx = await provider.getTransaction(txHash);
    if (!tx || !tx.to) {
      log("scanHintRpc", "error", { code: "tx-not-found" });
      return { ok: false, code: "tx-not-found" };
    }

    phase = "tx.valid.to";
    if (tx.to.toLowerCase() !== ADDR.VAULT.toLowerCase()) {
      log("scanHintRpc", "error", { code: "not-vault", to: tx.to, want: ADDR.VAULT });
      return { ok: false, code: "not-vault" };
    }

    phase = "tx.valid.selector";
    if (!tx.data || !tx.data.startsWith(RUN_SELECTOR)) {
      log("scanHintRpc", "error", { code: "not-run" });
      return { ok: false, code: "not-run" };
    }

    let day: bigint;
    try {
      phase = "day.read.tryBlockTag";
      const fn = (vaultRead as any).getFunction?.("lastStakeDay");
      day = await fn.staticCall({ blockTag: rc.blockNumber });
    } catch {
      phase = "day.read.latest";
      day = await (vaultRead as any).lastStakeDay();
    }

    phase = "state.load";
    const [owner, units, safiAddr] = await Promise.all([
      (rewardR as any).owner?.(),
      (rewardR as any).rewardUnits?.(),
      (rewardR as any).safi?.(),
    ]);
    const winnerNow = await (rewardR as any).winnerOfDay?.(day).catch(()=> "0x0000000000000000000000000000000000000000");
    const runner    = tx.from as `0x${string}`;

    log("scanHintRpc", "state.load", {
      day: day.toString(),
      owner, signer: signer?.address,
      units: units?.toString?.(),
      safi: safiAddr,
      winnerNow,
      runner,
    });

    if (winnerNow && winnerNow !== "0x0000000000000000000000000000000000000000") {
      const pend = await (rewardR as any).pending?.(winnerNow).catch(()=> null);
      log("scanHintRpc", "already.recorded", {
        day: day.toString(),
        winner: winnerNow,
        pending: pend?.toString?.() ?? null,
      });
      return { ok: true, already: true, day: day.toString(), winner: winnerNow, pending: pend?.toString?.() ?? null };
    }

    if (!rewardW) {
      log("scanHintRpc", "error", { code: "no-signer" });
      return { ok: false, code: "no-signer" };
    }
    if (String(owner).toLowerCase() !== String(signer?.address).toLowerCase()) {
      log("scanHintRpc", "error", { code: "signer-not-owner", owner, signer: signer?.address });
      return { ok: false, code: "signer-not-owner", owner, signer: signer?.address };
    }

    phase = "prechecks";
    let safiBal: bigint | null = null;
    try {
      const safi = new Contract(safiAddr, erc20Abi, provider);
      safiBal = await (safi as any).balanceOf?.(ADDR.VAULTREWARD);
    } catch {}
    if (safiBal !== null && units && safiBal < units) {
      log("scanHintRpc", "error", { code: "insufficient-funds", safiBal: safiBal.toString(), units: units.toString() });
      return { ok: false, code: "insufficient-funds", safiBal: safiBal?.toString?.(), units: units?.toString?.() };
    }

    const uniq = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint256"], [txHash as `0x${string}`, BigInt(rc.blockNumber)]
      )
    );

    phase = "gas.estimate";
    let gas: bigint | null = null;
    try {
      gas = await (rewardW as any).estimateGas.recordWinner(day, runner, uniq);
    } catch (e: any) {
      log("scanHintRpc", "gas.estimate", { warn: String(e?.message || e) });
    }

    phase = "tx.send";
    const sent = await (rewardW as any).recordWinner(day, runner, uniq, { gasLimit: gas ?? 300000n });
    log("scanHintRpc", "tx.mined", { hash: sent.hash });
    const mined = await sent.wait();

    phase = "postcheck";
    let pendAfter: bigint | null = null;
    try {
      pendAfter = await (rewardR as any).pending?.(runner);
    } catch {}
    log("scanHintRpc", "done", {
      day: day.toString(),
      tx: mined?.hash,
      pendingAfter: pendAfter?.toString?.() ?? null,
    });

    return {
      ok: true,
      recorded: true,
      day: day.toString(),
      tx: mined?.hash as string,
      pendingAfter: pendAfter?.toString?.() ?? null,
    };
  } catch (e: any) {
    log("scanHintRpc", "error", { phase, error: String(e?.message || e) });
    return { ok: false, code: "exception", phase, error: String(e?.message || e) };
  } finally {
    inFlight.delete(txHash);
  }
}

/**
 * Watcher: detecta txs run() e chama scanHintRpc(txHash).
 */
export function startWinnerWatcher() {
  const ctx = getCtx();
  if (!ctx.ok) throw new Error("winnerWatcher: provider ausente");
  const { provider } = ctx;

  provider.on("block", async (n: number) => {
    try {
      const b = await provider.getBlock(n, true);
      if (!b) return;
      for (const t of b.transactions as any[]) {
        if (typeof t === "string") continue;
        if (!t.to) continue;
        if (t.to.toLowerCase() !== ADDR.VAULT.toLowerCase()) continue;
        if (!t.input?.startsWith?.(RUN_SELECTOR) && !t.data?.startsWith?.(RUN_SELECTOR)) continue;
        log("watcher", "tx.load", { detect: "run()", tx: t.hash, block: n });
        void scanHintRpc(t.hash);
      }
    } catch (e: any) {
      log("watcher", "error", { error: String(e?.message || e) });
    }
  });
}
