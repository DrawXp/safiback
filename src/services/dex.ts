import { JsonRpcProvider, Contract } from "ethers"
import FactoryAbi from "../abis/Factory.json"
import PairAbi from "../abis/Pair.json"
import ERC20Abi from "../abis/ERC20.json"
import { dbQuery } from "../config/env"

const RPC = process.env.RPC_PHAROS!
const CHAIN_ID = Number(process.env.CHAIN_ID || 0)
if (!RPC) throw new Error("RPC_PHAROS missing")

const provider = new JsonRpcProvider(RPC, CHAIN_ID)

const FACTORY = process.env.FACTORY as `0x${string}`

const fct = new Contract(FACTORY, FactoryAbi as any, provider) as any

const APR_CACHE_TTL_MS = 10 * 60 * 1000
type AprCacheEntry = { updatedAt: number; data: any }
const aprCache = new Map<string, AprCacheEntry>()

type AprBucketStored = {
  t: number
  fee0: string
  fee1: string
  txCount: number
}

type AprStoredState = {
  buckets: AprBucketStored[]
}

const WINDOW_MS = 24 * 60 * 60 * 1000

function currentDayString(): string {
  return new Date().toISOString().slice(0, 10)
}

async function loadAprStateForDay(day: string): Promise<Record<string, AprStoredState>> {
  try {
    const { rows } = await dbQuery<{ snapshot: Record<string, AprStoredState> }>(
      "select snapshot from apr_daily_snapshots where day = $1 limit 1",
      [day],
    )
    if (!rows.length || !rows[0]?.snapshot) return {}
    return rows[0].snapshot
  } catch {
    return {}
  }
}

async function computeLpApr(pairAddr: string) {
  const pair = pairAddr as `0x${string}`
  const day = currentDayString()
  const data = await loadAprStateForDay(day)
  const key = pair.toLowerCase()
  const entry = data[key]

  let fee0 = 0n
  let fee1 = 0n
  let txCount = 0

  if (entry && Array.isArray(entry.buckets)) {
    const nowMs = Date.now()
    const cutoff = nowMs - WINDOW_MS
    for (const b of entry.buckets) {
      if (typeof b.t !== "number") continue
      if (b.t < cutoff) continue
      fee0 += BigInt(b.fee0 || "0")
      fee1 += BigInt(b.fee1 || "0")
      if (typeof b.txCount === "number") txCount += b.txCount
    }
  }

  const p = new Contract(pair, PairAbi as any, provider) as any

  const [reserves, overrideInfo, defLpFee] = await Promise.all([
    p.getReserves(),
    fct.pairFeeOverride(pair),
    fct.lpFeeBps(),
  ])

  const r0 = BigInt(reserves[0].toString())
  const r1 = BigInt(reserves[1].toString())

  const dailyToApr = (fee: bigint, reserve: bigint) => {
    if (reserve === 0n) return 0
    const scaled = (fee * 365n * 10000n) / reserve
    return Number(scaled) / 100
  }

  const apr0 = dailyToApr(fee0, r0)
  const apr1 = dailyToApr(fee1, r1)
  const apr = (apr0 + apr1) / 2

  const lpFeeBps =
    overrideInfo && overrideInfo.enabled
      ? Number(overrideInfo.lpFeeBps)
      : Number(defLpFee)

  return {
    pair,
    day,
    lpFeeBps,
    apr,
    fee0: fee0.toString(),
    fee1: fee1.toString(),
    reserve0: r0.toString(),
    reserve1: r1.toString(),
    txCount,
  }
}

export async function lpApr(pairAddr: string) {
  const key = pairAddr.toLowerCase()
  const now = Date.now()
  const hit = aprCache.get(key)
  if (hit && now - hit.updatedAt < APR_CACHE_TTL_MS) return hit.data
  const data = await computeLpApr(pairAddr)
  aprCache.set(key, { updatedAt: now, data })
  return data
}

const PAIRS_CACHE_TTL_MS = 60_000

export type DexPairSnapshot = {
  pair: string
  token0: string
  token1: string
  reserve0: string
  reserve1: string
  totalSupply: string
  symbol0?: string
  symbol1?: string
  decimals0?: number
  decimals1?: number
  apr?: number
}

let cachedPairs: DexPairSnapshot[] | null = null
let cachedPairsTs = 0

export async function getPairsSnapshot(
  force = false,
): Promise<DexPairSnapshot[]> {
  const now = Date.now()
  if (!force && cachedPairs && now - cachedPairsTs < PAIRS_CACHE_TTL_MS) {
    return cachedPairs
  }

  if (!FACTORY) {
    cachedPairs = []
    cachedPairsTs = now
    return cachedPairs
  }

  const total: bigint = await fct.allPairsLength()
  if (total === 0n) {
    cachedPairs = []
    cachedPairsTs = now
    return cachedPairs
  }

  const [pairs, t0s, t1s] = (await fct.getPairsWithTokens(
    0n,
    total,
  )) as [string[], string[], string[]]

  const snapshots = await Promise.all(
    pairs.map(async (pairAddr: string, i: number) => {
      const t0 = t0s[i]
      const t1 = t1s[i]
      if (!t0 || !t1) return null

      const pair = new Contract(pairAddr, PairAbi as any, provider) as any
      const erc0 = new Contract(t0, ERC20Abi as any, provider) as any
      const erc1 = new Contract(t1, ERC20Abi as any, provider) as any

      try {
        const [reserves, ts, s0, s1, d0, d1] = await Promise.all([
          pair.getReserves(),
          pair.totalSupply(),
          erc0.symbol().catch(() => null),
          erc1.symbol().catch(() => null),
          erc0.decimals().catch(() => null),
          erc1.decimals().catch(() => null),
        ])
        const aprInfo = await lpApr(pairAddr).catch(() => null)

        const [r0, r1] = reserves as [any, any, any]
        return {
          pair: pairAddr,
          token0: t0,
          token1: t1,
          reserve0: r0.toString(),
          reserve1: r1.toString(),
          totalSupply: (ts as bigint).toString(),
          symbol0: s0 ? String(s0) : undefined,
          symbol1: s1 ? String(s1) : undefined,
          decimals0: d0 != null ? Number(d0) : undefined,
          decimals1: d1 != null ? Number(d1) : undefined,
          apr: typeof (aprInfo as any)?.apr === "number" ? (aprInfo as any).apr : undefined,
        } as DexPairSnapshot
      } catch {
        return null
      }
    }),
  )

  const filtered = snapshots.filter(
    (x): x is DexPairSnapshot => x !== null,
  )

  cachedPairs = filtered
  cachedPairsTs = now
  return filtered
}
