# Auto-loop : interface

Petite application web pour ouvrir ou fermer une position à levier sur Aave v3 en **une transaction**, sur Ethereum (marchés Core et Prime), Arbitrum, Base, Avalanche, Optimism, Polygon, BNB Chain, Mantle, Plasma, Linea, Sonic et Monad, via le contrat `LeverageExecutor` (`../contracts`). On choisit la plateforme, la paire collatéral / dette et le levier ; le swap passe par Velora ou KyberSwap, au choix selon la chaîne (0x et 1inch sont codés mais affichés « bientôt ») ; l’interface calcule l’emprunt, demande un devis avec le contrat comme taker, affiche le health factor projeté, puis fait signer.

Stack : Vite + React + TypeScript, wagmi 2 / viem 2.

## Lancer

```bash
npm install
cp .env.example .env.local     # puis remplir
npm run dev                    # http://localhost:5173
npm test                       # tests des calculs
VITE_DEMO=true npm run dev     # données de marché fictives, sans RPC
npm run build                  # site 100 % statique dans dist/, à servir depuis n'importe quel dossier
```

Le build ne dépend d'aucun serveur : le navigateur appelle directement l'API Velora (`api.paraswap.io`, CORS ouvert) et le RPC public de Base. `dist/` peut donc être hébergé tel quel (GitHub Pages, IPFS…). Les variables `VITE_*` sont figées au moment du build.

| Variable | Rôle |
|---|---|
| `VITE_EXECUTORS` | Adresse du contrat déployé pour chaque marché, en JSON (`{"base":"0x…"}`) : un contrat par pool Aave. Marché absent : l'app propose de **déployer le contrat depuis le portefeuille connecté** (bouton « Déployer le contrat », routeurs = agrégateurs qui cotent sur la chaîne), ou de coller l'adresse d'un contrat déjà déployé ; l'adresse est retenue dans le navigateur. Toute adresse, d'ici ou du navigateur, n'est utilisée qu'après vérification on-chain que son code est exactement celui du contrat pour ce Pool. `VITE_EXECUTOR_ADDRESS` reste lue pour Base. |
| `VITE_RPC_URL_<chainId>` | RPC d'une chaîne pour les lectures et simulations (vide = PublicNode, puis le RPC public de la chaîne). `VITE_RPC_URL` vaut pour Base. Pour un fork local : `anvil --fork-url https://mainnet.base.org --chain-id 8453` puis `http://127.0.0.1:8545`. |
| `VITE_QUOTE_MODE` | `auto` (API réelles, repli sur un devis simulé si elles ne répondent pas), `live` ou `mock`. Un devis simulé n’est jamais exécutable. |
| `ZEROX_API_KEY`, `ONEINCH_API_KEY` | Lues uniquement par le serveur de dev (proxy `/api/0x` et `/api/1inch` dans `vite.config.ts`), jamais envoyées au navigateur : 0x et 1inch ne marchent donc pas dans le build statique. Inutiles tant que 0x et 1inch sont désactivés ; Velora n’en demande pas. |
| `VITE_VELORA_INCLUDE_DEXS`, `VITE_VELORA_EXCLUDE_DEXS` | Listes de DEX (noms Velora, séparés par des virgules) autorisés ou exclus des routes. Vide = toutes les routes. Sert surtout au test sur fork (voir plus bas). |
| `VITE_DEMO` | `true` : prix et paramètres fictifs, pour voir l’interface sans réseau. |

## Marchés

Liste dans `src/config.ts` (`MARKETS`), adresses des pools tirées de `@bgd-labs/aave-address-book`. Les actifs de chaque marché sont lus sur la chaîne (`getReservesList`), donc un nouvel actif listé par Aave apparaît sans changer le code. Chaque agrégateur n'est proposé que sur ses chaînes (`chains` dans `AGGREGATORS`) : Velora ne couvre ni Mantle, ni Plasma, ni Linea, ni Monad, KyberSwap prend alors le relais. KyberSwap est appelé sans clé (en-tête `x-client-id: auto-loop`) ; un devis qui contient des frais (`extraFee`) est refusé.

## Rewards Merkl

Les APY ajoutent les campagnes Merkl en cours sur Aave (`api.merkl.xyz/v4/opportunities`, sans clé) : rewards de dépôt sur l'aToken du collatéral, rewards d'emprunt sur le jeton de dette. Une campagne n'est comptée que si elle nomme l'adresse de l'aToken ou du jeton de dette ; sinon elle est ignorée. Les conditions d'éligibilité propres à certaines campagnes ne sont pas vérifiées. Si l'API ne répond pas, l'interface le dit et affiche les APY sans bonus.

## eMode

Les catégories eMode du marché sont lues sur le pool (getters Aave v3.2+ : configuration, bitmaps collatéral, empruntable et LTV nulle). Pour une paire, l'interface propose les catégories où le collatéral compte avec la LTV de la catégorie et où la dette est empruntable, la meilleure LTV par défaut (ou la catégorie actuelle du compte si elle convient). Les calculs utilisent alors la LTV et le seuil de liquidation de la catégorie. L'eMode est un réglage du compte Aave que seul l'utilisateur peut changer : si besoin, une transaction `setUserEMode` part avant l'ouverture, le contrat ne change pas. La fermeture calcule avec l'eMode actuel du compte.

## Ce que fait l’interface

**Ouvrir** : emprunt `D = capital × (levier − 1)` au prix de l’oracle Aave, devis D → collatéral chez l’agrégateur choisi (taker = contrat), `minOut` = devis − slippage. Affiche collatéral déposé, levier effectif, health factor (attendu et pire cas), prix de liquidation, LTV face au maximum d’Aave, APY net. Bloque si la LTV dépasse le maximum, si l’actif est isolé, gelé, sans flash loan, ou si le solde manque.
Signature : `approve` du collatéral si besoin (une transaction, une fois), délégation de crédit signée en EIP-712 si besoin (sans gas), puis `openWithSig` ou `open`.

**Fermer / réduire** (25, 50, 75 % ou tout) : calcule le collatéral à vendre pour couvrir dette + prime de flash loan + slippage, vérifie que le minimum garanti du devis couvre le remboursement, affiche ce qui revient. Permit d’aToken signé si besoin, puis `closeWithSig` ou `close`.

Avant chaque signature : nouvelle cotation (un devis expire en quelques blocs), simulation `eth_call` de la transaction, erreurs du contrat traduites. Le domaine EIP-712 est recalculé et comparé au `DOMAIN_SEPARATOR` du token avant de signer.

## Velora

Seul agrégateur actif pour l’instant. Chaque appel (`/prices` et `/transactions`) passe `partner=auto-loop` : sans ce paramètre, l’API publique ajoute 1 bp de frais « anon ». L’interface refuse un devis si `partnerFee` n’est pas nul ou si le calldata Augustus v6.2 encode des frais (champ `partnerAndFee`, vérifié sur de vrais devis : 1 bp sans `partner`, 0 avec). Le montant affiché est `destAmountAfterFee` quand Velora le fournit.

## Test de bout en bout sur fork de Base

Testé le 01/11/2026 avec le contrat sans owner : déploiement par le bouton de l'app (`NO_DEPLOY=1 bash e2e/fork.sh`, puis `node e2e/run.cjs deploy d`), puis ouverture 3x et fermeture totale avec ce contrat (`EXECUTOR=0x… node e2e/run.cjs open o`). Une adresse qui n'est pas le contrat (ex. WETH) est refusée.

Testé le 18/10/2026 : anvil sur fork de Base, contrat déployé sur le fork avec seulement le routeur Velora en liste blanche, interface dans Chromium avec un portefeuille de test (compte anvil 1), vraies lectures Aave v3 et vrais devis Velora.

```bash
anvil --fork-url https://mainnet.base.org --chain-id 8453     # terminal 1
bash e2e/fork.sh                                              # re-fork, déploiement, 1,5 WETH au compte de test
cat > .env.local <<'ENV'
VITE_EXECUTOR_ADDRESS=0x33dd750d10F53475A1FbF5e079a02BF0F74C3646
VITE_RPC_URL=http://127.0.0.1:8545
VITE_QUOTE_MODE=live
VITE_VELORA_INCLUDE_DEXS=UniswapV3,UniswapV4,AerodromeSlipstream,AerodromeSlipstreamFactory3,PancakeswapV3
ENV
npm run dev                                                   # terminal 2
NODE_PATH=$(npm root -g) node e2e/run.cjs open ouvrir         # puis close50 / close
```

Résultats (1 WETH de capital, levier 3x, dette USDC, slippage 0,5 %) :
- ouverture : approve, délégation de crédit signée en EIP-712, `openWithSig`. 4 750 USDC empruntés, 3,0 WETH déposés, HF 1,24 comme affiché, ~733k gas ;
- fermeture à 50 % puis totale : permit d’aWETH signé, `closeWithSig`. Dette à 0, ~1,7M gas pour la fermeture totale ; il revient 0,9835 WETH + 33,6 USDC, soit ~0,25 % de coût aller-retour sur le capital (swaps sur 3x le capital + prime de flash loan) ;
- après chaque transaction, le contrat ne garde ni token ni approval ;
- avec le filtre AMM, 3 tours complets sur 4 ont réussi (dont un avec fermeture à 50 %) ; l’échec est remonté comme une erreur dans l’interface, sans perte.

Limite propre au fork : le fork est figé au bloc du `fork.sh`, alors que Velora cote sur l’état réel du moment. Les DEX à prix d’oracle (Kipseli, Tessera, WooFiV2, metric-v1…) revertent alors systématiquement, d’où `VITE_VELORA_INCLUDE_DEXS` limité aux AMM classiques. Même ainsi, une route peut encore échouer à la simulation si le fork a trop vieilli : relancer `fork.sh`. Sur le vrai réseau ce décalage n’existe pas, et de toute façon la simulation avant signature bloque une transaction qui échouerait.

## Fichiers

| Fichier | Rôle |
|---|---|
| `src/config.ts` | Adresses (Pool Aave, tokens, routeurs des agrégateurs), variables d’environnement. |
| `src/abi.ts` | ABI du contrat (vérifiée contre les signatures Solidity dans les tests) et d’Aave. |
| `src/lib/math.ts` | Calculs de levier, health factor, montant à vendre à la fermeture. |
| `src/lib/quotes.ts` | Devis Velora v6.2 (contrôle des frais), 0x (AllowanceHolder) et 1inch v6 désactivés, devis simulé. |
| `e2e/` | Test de bout en bout sur fork : `fork.sh` (re-fork, déploiement, fonds de test), `run.cjs` (Chromium + portefeuille de test). |
| `src/lib/signatures.ts` | Délégation de crédit et permit d’aToken en EIP-712. |
| `src/lib/execute.ts` | Enchaînement approve → signature → simulation → transaction. |
| `src/lib/useMarket.ts` | Lectures on-chain : réserves, prix oracle, prime, position de l’utilisateur. |
| `src/components/` | Écrans Ouvrir et Fermer. |

## Pas encore testé

- Un vrai portefeuille (MetaMask, Rabby) : le test utilise un portefeuille injecté qui relaie vers anvil, les mêmes appels (`eth_sendTransaction`, `eth_signTypedData_v4`) mais sans l’écran de confirmation.
- Devis 0x et 1inch (désactivés, clés API absentes).
- Autres paires que WETH / USDC.

## Limites v1

Une seule plateforme (Aave v3, Base). Les paramètres affichés ignorent l’eMode (un avertissement s’affiche s’il est actif). Le calcul du prix de liquidation suppose que le collatéral de la paire est le seul du compte. Les clés API passent par le serveur de dev de Vite : pour un déploiement, il faudra un petit backend ou des fonctions serverless.
