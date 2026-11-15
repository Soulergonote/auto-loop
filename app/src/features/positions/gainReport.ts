import { createContext } from 'react'
import type { GainState } from '../../domain/portfolio'

/** Lets each « Gain réel » fold report its gain to the overview at the top of Positions (J5), keyed by position. */
export const GainReport = createContext<((key: string, state: GainState | undefined) => void) | undefined>(undefined)
