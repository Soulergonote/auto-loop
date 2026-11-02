import type { Campaign } from '../lib/merkl'
import { daysLeft } from '../lib/merkl'
import { fmtPct } from '../lib/format'

const fmtDate = (s: number) => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(s * 1000))

type Props = {
  campaigns: Campaign[]
  yields: { campaign: Campaign; apy: number }[]
  excluded: { campaign: Campaign; reasons: string[] }[]
  borrowed: { token: { symbol: string }; variableDebtToken: string }
}

/** Merkl campaigns of the pair: what each one adds to this loop, until when, and under which rules. */
export function CampaignTable({ campaigns, yields, excluded, borrowed }: Props) {
  if (campaigns.length === 0) return null
  const rules = (c: Campaign) => {
    const out: string[] = []
    if (c.maxHealthFactor !== undefined) out.push(`health factor ≤ ${c.maxHealthFactor}`)
    if (c.forbiddenBorrows.length)
      out.push(c.forbiddenBorrows.includes(borrowed.variableDebtToken.toLowerCase()) ? `pas d’emprunt de ${borrowed.token.symbol}` : 'certains emprunts exclus')
    if (c.kind === 'netLending' || c.kind === 'netBorrowing') out.push('calculé en net')
    if (c.conditional) out.push('à vérifier sur Merkl')
    return out.join(', ') || 'aucune'
  }
  return (
    <table className="reserves campaigns">
      <thead>
        <tr>
          <th>Bonus Merkl</th>
          <th>APR affiché</th>
          <th>Sur ta loop</th>
          <th>Fin</th>
          <th>Conditions</th>
        </tr>
      </thead>
      <tbody>
        {campaigns.map((c) => {
          const y = yields.find((x) => x.campaign === c)
          const out = excluded.find((x) => x.campaign === c)
          const left = daysLeft(c)
          return (
            <tr key={c.name + c.token}>
              <td>{c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : c.name}</td>
              <td>{fmtPct(c.apr)}</td>
              <td className={out ? 'bad' : undefined}>{out ? 'non compté' : y ? fmtPct(y.apy) : '…'}</td>
              <td className={left < 7 ? 'warn' : undefined}>
                {c.endsAt ? `${fmtDate(c.endsAt)} (${left < 1 ? 'aujourd’hui' : `dans ${Math.floor(left)} j`})` : 'non indiquée'}
              </td>
              <td title={c.description}>{rules(c)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
