import { Contract, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { ADDR, requireSigner, loadAbi, dbQuery } from "../config/env";
import { log } from "../libs/logger";
import crypto from "crypto";

const raw = loadAbi("SAFILuck");
const abi: any[] = (raw as any).abi ?? (raw as any);

const LUCK_ADDR = ADDR.SAFILUCK;

const linfo = (...a: any[]) => log("[luckWatcher][info]", ...a);
const lwarn = (...a: any[]) => log("[luckWatcher][warn]", ...a);
const lerror = (...a: any[]) => log("[luckWatcher][error]", ...a);

async function storeSecret(roundId: number, secret: string) {
  await dbQuery(
    "insert into luck_secrets (round_id, secret) values ($1, $2) on conflict (round_id) do update set secret = excluded.secret",
    [roundId, secret],
  );
}

async function loadSecret(roundId: number): Promise<string | null> {
  const { rows } = await dbQuery<{ secret: string }>(
    "select secret from luck_secrets where round_id = $1 limit 1",
    [roundId],
  );
  if (!rows.length) return null;
  return rows[0]?.secret ?? null;
}

async function deleteSecret(roundId: number) {
  await dbQuery("delete from luck_secrets where round_id = $1", [roundId]);
}

export function startLuckWatcher() {
  if (!LUCK_ADDR) {
    lwarn("SAFILUCK vazio; watcher desativado");
    return;
  }

  const signer: Wallet = requireSigner();
  const luck = new Contract(LUCK_ADDR, abi, signer) as any;

  const getClaimWindowSec = async (): Promise<number> => {
    try {
      if (typeof luck.claimWindowSec === "function") return Number(await luck.claimWindowSec());
      if (typeof luck.claimWindow === "function") return Number(await luck.claimWindow());
      if (typeof luck.getClaimWindow === "function") return Number(await luck.getClaimWindow());
    } catch {}
    return 3 * 24 * 3600;
  };

  const loop = async () => {
    try {
      const keeper: string = await luck.keeper();
      if (!keeper || keeper.toLowerCase() !== signer.address.toLowerCase()) {
        lerror("keeper != signer. keeper=%s signer=%s", keeper, signer.address);
        return setTimeout(loop, 15000);
      }

      const r = await luck.currentRound();
      const now = Math.floor(Date.now() / 1000);
      const id = Number(await luck.currentRoundId());

      if (!r.commitHash || r.commitHash === "0x".padEnd(66, "0")) {
        const secret = crypto.randomBytes(32).toString("hex");
        const hash = keccak256(toUtf8Bytes(secret));

        await storeSecret(id, secret);

        try {
          const tx = await luck.commit(hash);
          linfo("[commit] round=%d hash=%s tx=%s", id, hash, tx.hash);
          await tx.wait();
        } catch (e: any) {
          lerror("[commit] erro: %s", String(e?.message || e));
        }
      }

      if (!r.finalized && now > Number(r.endTs)) {
        const secret = await loadSecret(id);

        if (secret) {
          try {
            const tx = await luck.finalize(toUtf8Bytes(secret));
            linfo("[finalize] tx=%s", tx.hash);
            await tx.wait();
            await deleteSecret(id);
          } catch (e: any) {
            const msg = String(e?.message || e);
            if (!/FIN|TIME|KEEP|execution reverted/.test(msg)) lerror("[finalize] %s", msg);
          }
        } else {
          lwarn("[finalize] segredo do round %d não encontrado", id);
        }
      }
	  
      const lastId = id - 1;
      if (lastId > 0) {
        const lr = await luck.rounds(BigInt(lastId));
        const cw = await getClaimWindowSec();
        const expired =
          (lr.finalized && !lr.claimed && now > Number(lr.claimDeadline)) ||
          (!lr.finalized && now > Number(lr.endTs) + cw);

        if (expired) {
          try {
            const tx = await luck.rolloverIfExpired(BigInt(lastId));
            linfo("[rollover] id=%d tx=%s", lastId, tx.hash);
            await tx.wait();
          } catch (e: any) {
            const msg = String(e?.message || e);
            if (!/CLAIMED|NOT_EXP/.test(msg)) lwarn("[rollover] %s", msg);
          }
        }
      }
    } catch (e: any) {
      lerror("%s", String(e?.message || e));
    } finally {
      setTimeout(loop, 15000);
    }
  };

  setTimeout(loop, 3000);
}
