import { Router } from "express";

const r = Router();

r.get("/health", (_req, res) => res.json({ ok: true }));

r.get("/net/info", (_req, res) =>
  res.json({ chainId: Number(process.env.CHAIN_ID) })
);

export default r;
