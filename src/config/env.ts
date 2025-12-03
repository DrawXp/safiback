import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');
import * as dotenv from "dotenv";
import { ethers } from "ethers";
import { Pool } from "pg";
dotenv.config({ override: true });

export const env = process.env;

export const DATABASE_URL = String(env.DATABASE_URL || "");
if (!DATABASE_URL) throw new Error("DATABASE_URL missing");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function dbQuery<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }> {
  return pool.query(text, params) as any;
}

export const RPC_PHAROS = String(env.RPC_PHAROS);
export const CHAIN_ID   = Number(env.CHAIN_ID || 0);
if (!RPC_PHAROS || !CHAIN_ID) throw new Error("RPC_PHAROS/CHAIN_ID missing");

export const provider = new ethers.JsonRpcProvider(RPC_PHAROS, CHAIN_ID);

function normalizePk(raw: string) {
  const s  = (raw || '').replace(/^['"]|['"]$/g, '').replace(/\u200B/g, '').trim();
  const pk = s.startsWith('0x') ? s : ('0x' + s);
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('Bad OWNER_PK format');
  return pk;
}
export function requireSigner() {
  const raw = String(env.OWNER_PK || '');
  if (!raw) throw new Error('Backend signer missing. Define OWNER_PK in .env');
  const pk = normalizePk(raw);
  return new ethers.Wallet(pk, provider);
}

export const ADDR = {
  TOKEN:          String(env.TOKEN)         as `0x${string}`,
  STAKING:        String(env.STAKING)       as `0x${string}`,
  FAUCET:         String(env.FAUCET)        as `0x${string}`,
  VAULT:          String(env.VAULT)         as `0x${string}`,
  VAULTREWARD:    String(env.VAULTREWARD)   as `0x${string}`,
  ROUTER:         String(env.ROUTER)        as `0x${string}`,
  FACTORY:        String(env.FACTORY)       as `0x${string}`,
  WPHRS:          String(env.WPHRS)         as `0x${string}`,
  PAIR_SAFI_WPHRS:String(env.PAIR_SAFI_WPHRS) as `0x${string}`,
  SWAPVAULT:      String(env.SWAPVAULT)     as `0x${string}`,
  SAFILUCK:       String(env.SAFILUCK)      as `0x${string}`,
  OWNER_ADDR:     String(env.OWNER_ADDR || "") as `0x${string}`,
} as const;

export function loadAbi(name: string) {
  const j = require(`../abis/${name}.json`);
  return (j as any).abi ?? j;
}
