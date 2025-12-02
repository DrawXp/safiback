import { Router } from "express";
import { scanHintRpc } from "../jobs/winnerWatcher";

const router = Router();

function pickHash(req: any): string {
  const raw = String(
    req.body?.hash ?? req.body?.txHash ?? req.query?.hash ?? ""
  ).trim();
  return raw;
}

const isHash = (h: string) => /^0x[0-9a-fA-F]{64}$/.test(h);
const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

router.post("/hint", async (req, res) => {
  try {
    const txHash = pickHash(req);
    if (!isHash(txHash)) {
      return res.status(400).json({ ok: false, error: "invalid txHash" });
    }
    const out = await scanHintRpc(txHash);
    if (!out) return res.json({ ok: false, pending: true });
    return res.json(out);
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

router.get("/hint", async (req, res) => {
  try {
    const txHash = pickHash(req);
    if (!isHash(txHash)) {
      return res.status(400).json({ ok: false, error: "invalid txHash" });
    }
    const out = await scanHintRpc(txHash);
    if (!out) return res.json({ ok: false, pending: true });
    return res.json(out);
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

export default router;