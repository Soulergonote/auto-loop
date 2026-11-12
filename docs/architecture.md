# Auto-loop : architecture et choix techniques

*Thread 1, recherche. 18 octobre 2026. Rien n'est encore codé.*

## TL;DR

| Choix | Recommandation |
|---|---|
| Mécanique | **Flash loan Aave v3 en mode « dette »** (`flashLoan` avec `interestRateModes = [2]`) : pas de remboursement, la dette variable est ouverte directement au nom de l'utilisateur, **0 % de prime**. |
| Plateforme v1 | **Aave v3** (plus liquide, la plus documentée, même interface sur toutes les chaînes). Morpho Blue en v2. Aave v4 plus tard. |
| Chaîne | Dev et tests sur **fork de Base ou Arbitrum** (gas faible, Aave v3 + les 3 agrégateurs présents). Ethereum mainnet ensuite. |
| Agrégateurs | **0x (Swap API v2)**, **1inch (Swap API v6)**, **Velora/ex-ParaSwap (v6.2)**, éventuellement KyberSwap/Odos. Pas CoW Swap (pas atomique). |
| Contrat | Un contrat « LeverageExecutor » sans état, qui n'agit que pour `msg.sender`, avec une liste blanche de routeurs et un contrôle `minOut` après le swap. |

## 1. Flash loan ou boucle supply/borrow ?

**Boucle itérative** (supply → borrow → swap → supply… N fois) : simple, aucun flash loan, mais N swaps (N fois les frais et le slippage), beaucoup de gas, et on n'atteint jamais exactement le levier cible (convergence géométrique). Utile seulement comme fallback.

**Flash loan** : un seul swap, levier exact, une seule transaction. Trois variantes sur Aave v3 :

1. `flashLoanSimple` : on emprunte, on doit rembourser montant + prime (0,05 % par défaut, `FLASHLOAN_PREMIUM_TOTAL`, à lire on-chain). Il faut donc emprunter sur Aave à l'intérieur du callback pour rembourser. Ça marche mais on paie la prime.
2. **`flashLoan` avec `interestRateModes[i] = 2` et `onBehalfOf = user`** : à la fin du callback, Aave ne réclame pas le remboursement, il **ouvre une dette variable au nom de `user`** et ne prend **aucune prime**. Il faut que l'utilisateur ait délégué du crédit au contrat (`approveDelegation` sur le `VariableDebtToken` de l'actif emprunté). C'est la variante recommandée.
3. Flash loan gratuit ailleurs (Balancer Vault, Morpho Blue) puis borrow sur Aave pour rembourser : utile si on vise un protocole sans flash loan natif.

### Flux recommandé (ouverture)

Exemple : 1 ETH de capital, levier 3x, collatéral WETH, dette USDC.

```
Utilisateur (1 tx, après 2 approvals ponctuelles)
 └─ LeverageExecutor.open(collat=WETH, debt=USDC, initial=1 WETH, flashAmount=X USDC,
                          router, swapCalldata, minCollatOut)
     1. transferFrom(user → contrat, 1 WETH)
     2. Pool.flashLoan(receiver=contrat, [USDC], [X], modes=[2], onBehalfOf=user, data)
        └─ executeOperation(...)                     // callback Aave
             a. approve(router, X USDC)
             b. router.call(swapCalldata)            // USDC → WETH via l'agrégateur
             c. require(WETH reçu ≥ minCollatOut)
             d. Pool.supply(WETH, 1 + reçu, onBehalfOf=user)
             e. return true                          // pas de remboursement : Aave mint la dette USDC à user
     3. Aave vérifie le health factor de user : si < 1, toute la tx revert.
```

Pré-requis côté utilisateur, une fois par paire : `WETH.approve(executor)` et `variableDebtUSDC.approveDelegation(executor, montant)` (ou la signature EIP-712 `delegationWithSig` pour tout faire dans la même tx).

### Fermeture / désendettement

Indispensable dans la v1 (sinon l'utilisateur est coincé) : flash loan de l'actif de dette en mode 0 (prime 0,05 %) → `repay` au nom de l'utilisateur → `withdraw` du collatéral (nécessite que l'utilisateur ait approuvé ses aTokens au contrat) → swap collatéral → dette → rembourser le flash loan → renvoyer le reste à l'utilisateur.

## 2. Plateformes de prêt

- **Aave v3** : cible v1. Même `Pool` sur Ethereum, Arbitrum, Base, Optimism, Polygon, etc. Adresses dans le package `@bgd-labs/aave-address-book`. Penser aux contraintes de marché : supply/borrow caps, isolation mode, siloed borrowing, eMode.
- **Aave v4** : lancé sur Ethereum le 30 mars 2026 (architecture hub/spoke), interface différente de v3 et déploiements multi-chaînes plus prudents. Une proposition évoque la dépréciation de v3, non adoptée à ma connaissance. À ajouter via un adaptateur quand l'API (flash loans, délégation) sera stabilisée ; à revérifier au moment du thread 2.
- **Morpho Blue** : flash loans gratuits et callbacks (`onMorphoSupplyCollateral`, `onMorphoRepay`) qui permettent le levier sans flash loan. Excellent second adaptateur.
- **Spark, Compound v3** : possibles plus tard via le même modèle d'adaptateur.

Architecture conseillée : un contrat cœur + un adaptateur par protocole (`ILendingAdapter` : `supply`, `borrow`, `repay`, `withdraw`, `flashLoan`), pour que l'UI liste « plateforme × paire × agrégateur ».

## 3. Agrégateurs : récupération et exécution du calldata

Principe commun : l'UI appelle l'API **hors chaîne** avec `taker/from = adresse du contrat` (c'est lui qui détient les tokens au moment du swap), récupère `to` + `data`, et passe ce calldata au contrat qui fait un `call` brut vers le routeur.

| Agrégateur | Endpoint | Cible à approuver / appeler | Notes |
|---|---|---|---|
| 0x Swap API v2 | `GET /swap/allowance-holder/quote` | Approver `allowanceTarget` (AllowanceHolder), appeler `transaction.to`. **Ne jamais approuver Settler.** | Clé API requise. `taker` = contrat. |
| 1inch Swap API v6 | `GET /swap/v6.0/{chainId}/swap` | AggregationRouterV6 (`tx.to`) | Clé API requise. `from` = contrat, `disableEstimate=true` (le contrat n'a pas encore les fonds au moment du devis). |
| Velora (ParaSwap) v6.2 | `/prices` puis `POST /transactions/{chainId}` | Augustus v6.2 | `userAddress` = contrat, `ignoreChecks=true`. Déjà utilisé par les adaptateurs officiels d'Aave. |
| KyberSwap / Odos | routes + build | leur routeur | Options supplémentaires. |
| CoW Swap / 1inch Fusion / UniswapX | — | — | **Exclus** : ordres par intention, exécutés plus tard par un solveur, donc pas atomiques. |

Points délicats :
- **Montant exact** : le devis porte sur un montant d'entrée exact (`sellAmount`). Le flash loan doit être exactement ce montant ; sinon il reste des miettes ou le swap échoue.
- **Expiration** : un devis est valable quelques blocs. L'UI doit re-coter juste avant la signature et mettre un `minOut` (slippage de 0,3 à 1 %).
- **Sécurité** : le `call` arbitraire vers un routeur est le point d'attaque classique. Liste blanche des routeurs par chaîne, vérification `balanceAfter - balanceBefore ≥ minOut`, approval exacte puis remise à 0, aucun fonds ni approbation laissé dans le contrat, et `onBehalfOf` forcé à `msg.sender` (sinon n'importe qui peut emprunter avec la délégation de crédit d'un autre).

## 4. Calcul du levier

Avec un capital `C0` (en valeur), un levier cible `L` :
- dette à flash-emprunter : `D = C0 × (L − 1)` (en valeur, convertie en unités de l'actif de dette au prix oracle) ;
- collatéral final ≈ `C0 × L` moins slippage et frais ;
- `HF = (collatéral × liquidationThreshold) / dette` ;
- levier max théorique `1 / (1 − LTV)` : ~5x pour WETH/USDC (LTV ~80 %), ~10-14x en eMode corrélé (wstETH/WETH, LTV 90-93 %).

L'UI doit afficher HF projeté, prix de liquidation, et le coût de portage net (APY supply × L − APY borrow × (L−1)). Viser HF ≥ 1,3 par défaut sur paires non corrélées.

## 5. Risques et coûts

- **Liquidation** : une baisse de `(1 − 1/HF)` du collatéral face à la dette suffit. À 3x sur ETH/USDC avec LT 83 %, HF ≈ 1,24, donc liquidation après ~19 % de baisse. Pénalité de liquidation 5 à 10 %.
- **Slippage et MEV** : un gros swap est sandwichable. `minOut` strict + RPC privé (Flashbots Protect, MEV Blocker) sur mainnet.
- **Taux variables** : le taux d'emprunt peut monter brutalement (utilisation élevée) et rendre le portage négatif.
- **eMode / dépeg** : en paires corrélées le levier est haut, un dépeg (stETH, stablecoin) liquide vite. Le risque d'oracle aussi.
- **Caps et paramètres** : supply/borrow caps atteints, gel d'un marché, changement de LTV par la gouvernance.
- **Frais** : prime de flash loan (0 % en mode dette, 0,05 % sinon), frais d'agrégateur éventuels, gas (quelques centimes sur L2, 10-40 $ sur mainnet), écart prix oracle / prix de marché.
- **Contrat** : délégation de crédit et approvals rendent le contrat critique. Tests en fork, fuzzing, et plafonds de montants avant tout usage réel.

## 6. Proposition pour la suite

- **Thread 2 (contrat)** : Foundry, fork de Base, `LeverageExecutor` + adaptateur Aave v3, ouverture et fermeture, tests avec calldata réel de 0x et 1inch (récupéré via l'API puis rejoué sur le fork).
- **Thread 3 (UI)** : Next.js + wagmi/viem, sélection plateforme / paire / agrégateur / levier, appels API agrégateurs côté serveur (clés API cachées), signature de la délégation en EIP-712.

## Sources

- [Aave v3 – Flash Loans](https://aave.com/docs/developers/flash-loans)
- [Aave v4 lancé sur Ethereum (The Block)](https://www.theblock.co/post/395617/aave-v4-launches-ethereum-mainnet)
- [0x – Onchain swaps (AllowanceHolder)](https://docs.0x.org/evm/0x-swap-api/guides/onchain-swaps-for-exchanges)
- [0x – Set token allowances](https://docs.0x.org/evm/0x-swap-api/additional-topics/how-to-set-your-token-allowances)
- Docs 1inch Swap API v6 et Velora/ParaSwap API : d'après mes connaissances, à revérifier au moment de coder.
