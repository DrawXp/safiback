import { Contract, Interface, Log } from "ethers";
import * as fs from "node:fs";
import * as path from "node:path";

import { provider as baseProvider, ADDR, loadAbi } from "../config/env";
import { log as baseLog } from "../libs/logger";

const PairAbi = loadAbi("Pair");
const FactoryAbi = loadAbi("Factory");

const ENABLE = (process.env.ENABLE_APR_WATCHER || "1") !== "0";

type Bucket = {
  t: number;
  fee0: bigint;
  fee1: bigint;
  txCount: number;
};

type FeeState = {
  txCount: number;
  buckets: Bucket[];
};

type BucketStored = {
  t: number;
  fee0: string;
  fee1: string;
  txCount: number;
};

type StoredFeeState = {
  buckets: BucketStored[];
};

type PairRuntime = {
  feeBps: bigint | null;
  swapTopic: string;
};

const state: Record<string, FeeState | undefined> = {};
const pairs: Record<string, PairRuntime | undefined> = {};
const watchedPairs = new Set<string>();

const dataDir = path.join(__dirname, "..", "data");
const FILE_PREFIX = "apr-";
const FLUSH_INTERVAL_MS = 150_000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const BUCKET_MS = 10 * 60 * 1000;

let currentDay = currentDayString();
let lastFlush = 0;
let lastBlockScanned: bigint = 0n;
let blockListenerAttached = false;

const pairIface = new Interface(PairAbi as any);
const factory = new Contract(ADDR.FACTORY, FactoryAbi as any, baseProvider) as any;

function log(where: string, phase: string, data?: any) {
  baseLog("[aprWatcher]", where, phase, data ?? "");
}

function currentDayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function fileForDay(day: string) {
  return path.join(dataDir, `${FILE_PREFIX}${day}.json`);
}

function stepFor(txCount: number): number {
  if (txCount > 50_000) return 10;
  if (txCount > 5_000) return 5;
  if (txCount > 500) return 3;
  return 1;
}

function cleanupOldFiles(dayKeep: string) {
  ensureDir();
  const keepName = `${FILE_PREFIX}${dayKeep}.json`;
  try {
    for (const name of fs.readdirSync(dataDir)) {
      if (!name.startsWith(FILE_PREFIX)) continue;
      if (name === keepName) continue;
      const full = path.join(dataDir, name);
      try {
        fs.unlinkSync(full);
        log("cleanup", "deleted", { file: name });
      } catch (e: any) {
        log("cleanup", "unlinkError", { file: name, error: String(e?.message || e) });
      }
    }
  } catch (e: any) {
    log("cleanup", "error", { dayKeep, error: String(e?.message || e) });
  }
}

function loadDay(day: string) {
  ensureDir();
  const f = fileForDay(day);
  if (!fs.existsSync(f)) return;
  try {
    const raw = fs.readFileSync(f, "utf8");
    const json = JSON.parse(raw) as Record<string, StoredFeeState>;
    for (const [pair, v] of Object.entries(json)) {
      if (!v || !Array.isArray(v.buckets)) continue;
      const buckets: Bucket[] = [];
      for (const b of v.buckets) {
        if (typeof b.t !== "number") continue;
        buckets.push({
          t: b.t,
          fee0: BigInt(b.fee0 || "0"),
          fee1: BigInt(b.fee1 || "0"),
          txCount: typeof b.txCount === "number" ? b.txCount : 0,
        });
      }
      state[pair.toLowerCase()] = {
        txCount: buckets.reduce((acc, b) => acc + b.txCount, 0),
        buckets,
      };
    }
    log("loadDay", "ok", { day, pairs: Object.keys(state).length });
  } catch (e: any) {
    log("loadDay", "error", { day, error: String(e?.message || e) });
  }
}

function pruneOldBuckets(s: FeeState, nowMs: number) {
  const cutoff = nowMs - WINDOW_MS;
  const kept: Bucket[] = [];
  for (const b of s.buckets) {
    if (b.t >= cutoff) kept.push(b);
  }
  s.buckets = kept;
}

function flush() {
  const dayNow = currentDayString();
  if (dayNow !== currentDay) {
    cleanupOldFiles(dayNow);
    currentDay = dayNow;
  }

  ensureDir();
  const out: Record<string, StoredFeeState> = {};
  for (const [pair, sRaw] of Object.entries(state)) {
    const s = sRaw;
    if (!s) continue;
    const buckets: BucketStored[] = s.buckets.map((b) => ({
      t: b.t,
      fee0: b.fee0.toString(),
      fee1: b.fee1.toString(),
      txCount: b.txCount,
    }));
    out[pair] = { buckets };
  }
  const f = fileForDay(currentDay);
  try {
    fs.writeFileSync(f, JSON.stringify(out, null, 2), "utf8");
    lastFlush = Date.now();
    log("flush", "ok", { day: currentDay, pairs: Object.keys(out).length });
  } catch (e: any) {
    log("flush", "error", { day: currentDay, error: String(e?.message || e) });
  }
}

async function setupPairs() {
  if (!baseProvider) throw new Error("aprWatcher: provider ausente");

  const len: bigint = await factory.allPairsLength();
  const n = Number(len);
  log("setupPairs", "start", { total: n });

  for (let i = 0; i < n; i++) {
    const pairAddr: string = await factory.allPairs(i);
    await registerPair(pairAddr as `0x${string}`);
  }

  log("setupPairs", "done", { total: n });
}

async function registerPair(pairAddr: `0x${string}`) {
  const key = pairAddr.toLowerCase();
  if (watchedPairs.has(key)) return;
  watchedPairs.add(key);

  const swapFragment = pairIface.getEvent("Swap");
  const topic = (swapFragment as any).topicHash as string;

  pairs[key] = { feeBps: null, swapTopic: topic };

  log("pair", "registered", { pair: pairAddr });
}

async function ensureFeeBpsFor(key: string, pairAddr: `0x${string}`): Promise<bigint> {
  const pr = pairs[key];
  if (!pr) return 30n;
  if (pr.feeBps !== null) return pr.feeBps;
  try {
    const override = await factory.pairFeeOverride(pairAddr);
    const defFee = await factory.lpFeeBps();
    const bps: bigint =
      override && override.enabled
        ? BigInt(override.lpFeeBps)
        : BigInt(defFee);
    pr.feeBps = bps;
    log("pair", "feeBps", { pair: pairAddr, lpFeeBps: bps.toString() });
    return bps;
  } catch (e: any) {
    log("pair", "feeError", { pair: pairAddr, error: String(e?.message || e) });
    pr.feeBps = 30n;
    return 30n;
  }
}

async function processLogForPair(key: string, pairAddr: `0x${string}`, logEntry: Log) {
  try {
    const parsed = pairIface.parseLog(logEntry);
    if (!parsed) return;
    const args: any = parsed.args as any;

    const amt0InRaw = args.amount0In ?? args.amountIn0 ?? 0;
    const amt1InRaw = args.amount1In ?? args.amountIn1 ?? 0;

    const amount0In = BigInt(amt0InRaw.toString());
    const amount1In = BigInt(amt1InRaw.toString());

    if (amount0In === 0n && amount1In === 0n) return;

    const nowMs = Date.now();

    let s = state[key];
    if (!s) {
      s = { txCount: 0, buckets: [] };
      state[key] = s;
    }

    pruneOldBuckets(s, nowMs);

    s.txCount += 1;
    const step = stepFor(s.txCount);
    if (step > 1 && (s.txCount % step) !== 0) {
      return;
    }

    const bps = await ensureFeeBpsFor(key, pairAddr);
    const scaled = BigInt(step);

    let add0 = 0n;
    let add1 = 0n;
    if (amount0In > 0n) add0 = (amount0In * bps) / 10_000n;
    if (amount1In > 0n) add1 = (amount1In * bps) / 10_000n;

    const bucketId = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS;

    let bucket = s.buckets.find((b) => b.t === bucketId);
    if (!bucket) {
      bucket = { t: bucketId, fee0: 0n, fee1: 0n, txCount: 0 };
      s.buckets.push(bucket);
    }

    bucket.fee0 += add0 * scaled;
    bucket.fee1 += add1 * scaled;
    bucket.txCount += step;

    const now = Date.now();
    if (now - lastFlush > FLUSH_INTERVAL_MS) {
      flush();
    }
  } catch (e: any) {
    log("process", "error", { pair: pairAddr, error: String(e?.message || e) });
  }
}

async function handleBlock(n: bigint) {
  if (lastBlockScanned === 0n) {
    lastBlockScanned = n;
    return;
  }
  if (n <= lastBlockScanned) return;

  const from = lastBlockScanned + 1n;
  const to = n;
  lastBlockScanned = n;

  const keys = Object.keys(pairs);
  if (keys.length) {
    for (const key of keys) {
      const pr = pairs[key];
      if (!pr) continue;
      const pairAddr = key as `0x${string}`;
      try {
        const logs = await baseProvider.getLogs({
          address: pairAddr,
          topics: [pr.swapTopic],
          fromBlock: Number(from),
          toBlock: Number(to),
        });
        for (const lg of logs as Log[]) {
          await processLogForPair(key, pairAddr, lg);
        }
      } catch (e: any) {
        log("getLogs", "error", { pair: pairAddr, error: String(e?.message || e) });
      }
    }
  }

  const now = Date.now();
  if (now - lastFlush > FLUSH_INTERVAL_MS) {
    flush();
  }
}

function attachBlockListener() {
  if (blockListenerAttached) return;
  blockListenerAttached = true;
  baseProvider.on("block", (num: number) => {
    const n = BigInt(num);
    void handleBlock(n);
  });
}

export async function startAprWatcher() {
  if (!ENABLE) {
    log("init", "disabled", { env: process.env.ENABLE_APR_WATCHER });
    return;
  }

  if (!baseProvider) throw new Error("aprWatcher: provider ausente");

  currentDay = currentDayString();
  loadDay(currentDay);

  const startBlock = await baseProvider.getBlockNumber();
  lastBlockScanned = BigInt(startBlock);

  await setupPairs();
  attachBlockListener();

  log("init", "ok", { day: currentDay, startBlock });
}
