import { createPublicClient, http } from 'viem'
import { defineChain } from 'viem'
import LuckAbi from '../frontend/src/abis/SAFILuck.json' assert { type: 'json' }

const chain = defineChain({ id: 1337, name: 'Local', nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18}, rpcUrls:{default:{http:['http://127.0.0.1:8545']}} })
const client = createPublicClient({ chain, transport: http() })

const luck  = '0xE361F185B33640EBdcA5c3BE627877d9495E0921' as `0x${string}`
const vault = '0x...' as `0x${string}`
const rid   = 80n
const winner= '0x...' as `0x${string}`

const SwapVaultDiagAbi = [
  { inputs: [], name: 'safiLuck', outputs: [{type:'address'}], stateMutability:'view', type:'function' },
  { inputs: [], name: 'wNative',  outputs: [{type:'address'}], stateMutability:'view', type:'function' },
  { inputs: [{type:'address',name:'token'}], name:'lotteryBalanceOf', outputs:[{type:'uint256'}], stateMutability:'view', type:'function' },
] as const

async function main() {
  console.log('safiLuck:', await client.readContract({ address: vault, abi: SwapVaultDiagAbi, functionName: 'safiLuck' }))
  console.log('vault:',    await client.readContract({ address: luck,  abi: LuckAbi.abi,     functionName: 'vault' }))
  // simulação
  try {
    await client.simulateContract({ account: winner, address: luck, abi: LuckAbi.abi, functionName: 'claim', args:[rid] })
    console.log('simulate claim OK')
  } catch (e:any) { console.log('simulate claim FAIL', e.shortMessage || e.message) }
}
main()
