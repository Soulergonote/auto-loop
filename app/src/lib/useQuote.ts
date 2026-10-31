import { useQuery } from '@tanstack/react-query'
import { getQuote, type QuoteRequest } from './quotes'

/** Keeps a fresh aggregator quote for the current inputs (quotes expire after a few blocks). */
export function useQuote(req: QuoteRequest | undefined) {
  return useQuery({
    queryKey: [
      'quote',
      req?.aggregator,
      req?.chainId,
      req?.sell.address,
      req?.buy.address,
      req?.sellAmount.toString(),
      req?.taker,
      req?.slippageBps.toString(),
    ],
    queryFn: ({ signal }) => getQuote(req!, signal),
    enabled: !!req && req.sellAmount > 0n,
    staleTime: 10_000,
    refetchInterval: 20_000,
    retry: false,
  })
}
