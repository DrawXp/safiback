import { Router } from "express"
import { lpApr, getPairsSnapshot } from "../services/dex"
import { isAddress } from "ethers"

const r = Router()

r.get("/apr", async (req, res, next) => {
  try {
    const pair = String(req.query.pair || "")
    if (!pair) return res.status(400).json({ error: "pair required" })

    if (!isAddress(pair)) {
      return res.status(400).json({ error: "Invalid address format for pair" })
    }

    const data = await lpApr(pair)
    res.json(data)
  } catch (e) {
    next(e)
  }
})

r.get("/pairs", async (_req, res, next) => {
  try {
    const pairs = await getPairsSnapshot(false)
    res.json({ pairs })
  } catch (e) {
    next(e)
  }
})

export default r
