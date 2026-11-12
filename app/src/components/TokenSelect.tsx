import { type Address } from 'viem'
import { type Token } from '../config'
import { fmtAmount } from '../lib/format'
import { Picker } from './Picker'

type TokenSelectProps = {
  tokens: Token[]
  value: Token
  onChange: (t: Token) => void
  exclude: Token
  label: string
  /** wallet balances, shown beside each token when a wallet is connected */
  balances?: Map<Address, bigint>
}

export function TokenSelect({ tokens, value, onChange, exclude, label, balances }: TokenSelectProps) {
  const withBalances = !!balances && balances.size > 0
  return (
    <Picker
      label={label}
      value={value.address}
      onChange={(a) => onChange(tokens.find((t) => t.address === a)!)}
      columns={withBalances ? ['Solde'] : undefined}
      // tokens the wallet holds first
      options={[...tokens]
        .sort((a, b) => Number((balances?.get(b.address) ?? 0n) > 0n) - Number((balances?.get(a.address) ?? 0n) > 0n))
        .map((t) => {
          const b = balances?.get(t.address)
          return {
            value: t.address,
            label: t.symbol,
            disabled: t.address === exclude.address,
            sub: t.address === exclude.address ? 'déjà de l’autre côté de la paire' : undefined,
            cells: withBalances ? [b ? fmtAmount(b, t.decimals) : <span className="na">—</span>] : undefined,
          }
        })}
    />
  )
}
