import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import * as dotenv from "dotenv";

import routes from "./routes";
import bountyRouter from "./routes/bounty";
import dexRouter from "./routes/dex";

import { errorHandler } from "./middlewares/errors";
import { log } from "./libs/logger";

import { startWinnerWatcher } from "./jobs/winnerWatcher";
import { startLuckWatcher } from "./jobs/luckWatcher";
import { startAprWatcher } from "./jobs/aprWatcher";
import { requireSigner } from "./config/env";

dotenv.config();

const signer = (() => {
  try {
    return requireSigner();
  } catch {
    return undefined as any;
  }
})();

const must = [
  "RPC_PHAROS",
  "CHAIN_ID",
  "TOKEN",
  "STAKING",
  "FAUCET",
  "VAULT",
  "VAULTREWARD",
  "ROUTER",
  "FACTORY",
  "WPHRS",
  "PAIR_SAFI_WPHRS",
  "SWAPVAULT",
  "SAFILUCK",
] as const;

for (const k of must) {
  if (!process.env[k] || !String(process.env[k]).trim()) {
    log("ENV missing", k);
  }
}

log("ENV loaded", {
  CHAIN_ID: process.env.CHAIN_ID,
  RPC_PHAROS: process.env.RPC_PHAROS,
  TOKEN: process.env.TOKEN,
  STAKING: process.env.STAKING,
  FAUCET: process.env.FAUCET,
  VAULT: process.env.VAULT,
  VAULTREWARD: process.env.VAULTREWARD,
  ROUTER: process.env.ROUTER,
  FACTORY: process.env.FACTORY,
  WPHRS: process.env.WPHRS,
  PAIR_SAFI_WPHRS: process.env.PAIR_SAFI_WPHRS,
  SWAPVAULT: process.env.SWAPVAULT,
  SAFILUCK: process.env.SAFILUCK,
  KEEPER: signer ? signer.address : "(no signer)",
});

const app = express();
app.use(cors());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP. Please, try again later.",
});

app.use(limiter);
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use(routes);
app.use("/bounty", bountyRouter);
app.use("/dex", dexRouter);

app.use(errorHandler);

const port = Number(process.env.PORT || 3001);
const server = app.listen(port, () => {
  log("API listening", { port });

  try {
    requireSigner();
  } catch (e) {
    log("index", { signer_error: String(e) });
  }

  try {
    startWinnerWatcher();
    startLuckWatcher();
    startAprWatcher();
    log("watchers started");
  } catch (e) {
    log("watchers error", String(e));
  }
});

export default app;
