# Auto-loop : interface

Petite application web pour ouvrir ou fermer une position à levier sur Aave v3 en **une transaction**, sur Ethereum (marchés Core et Prime), Arbitrum, Base, Avalanche, Optimism, Polygon, BNB Chain, Mantle, Plasma, Linea, Sonic et Monad, via le contrat `LeverageExecutorV2` (`../contracts` ; un contrat v1 déjà déployé reste reconnu et utilisé). On choisit la paire collatéral / dette et le levier ; le swap passe par Velora ou KyberSwap selon la chaîne (0x et 1inch sont codés mais pas proposés) ; l’interface calcule l’emprunt, demande un devis avec le contrat comme taker, affiche le health factor projeté, puis fait signer.

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
| `VITE_EXECUTORS` | Adresse du contrat déployé pour chaque marché, en JSON (`{"base":"0x…"}`) : un contrat par pool Aave. Marché absent : l'app propose de **déployer le contrat v2 depuis le portefeuille connecté** (bouton « Déployer le contrat », routeurs = agrégateurs qui cotent sur la chaîne, prêteur gratuit = Morpho Blue là où il existe), ou de coller l'adresse d'un contrat déjà déployé ; l'adresse est retenue dans le navigateur. Toute adresse, d'ici ou du navigateur, n'est utilisée qu'après vérification on-chain que son code est exactement celui du contrat (v2, ou v1 pour un contrat déjà déployé) pour ce Pool. Avec un contrat v1 enregistré dans le navigateur, un bandeau propose de déployer la v2. `VITE_EXECUTOR_ADDRESS` reste lue pour Base. |
| `VITE_RPC_URL_<chainId>` | RPC d'une chaîne pour les lectures et simulations (vide = PublicNode, puis le RPC public de la chaîne). `VITE_RPC_URL` vaut pour Base. Pour un fork local : `anvil --fork-url https://mainnet.base.org --chain-id 8453` puis `http://127.0.0.1:8545`. |
| `VITE_QUOTE_MODE` | `auto` (API réelles, repli sur un devis simulé si elles ne répondent pas), `live` ou `mock`. Un devis simulé n’est jamais exécutable. |
| `ZEROX_API_KEY`, `ONEINCH_API_KEY` | Lues uniquement par le serveur de dev (proxy `/api/0x` et `/api/1inch` dans `vite.config.ts`), jamais envoyées au navigateur : 0x et 1inch ne marchent donc pas dans le build statique. Inutiles tant que 0x et 1inch sont désactivés ; Velora n’en demande pas. |
| `VITE_VELORA_INCLUDE_DEXS`, `VITE_VELORA_EXCLUDE_DEXS` | Listes de DEX (noms Velora, séparés par des virgules) autorisés ou exclus des routes. Vide = toutes les routes. Sert surtout au test sur fork (voir plus bas). |
| `VITE_DEMO` | `true` : prix et paramètres fictifs, pour voir l’interface sans réseau. |

## Interface

Les règles d’interface (agencement, couleurs, typographie, composants, ton, formats des nombres) sont fixées dans la charte UI/UX du projet ; tout écran la suit. En pratique : l’écran Boucle a les choix à gauche et un résumé fixe à droite avec l’unique bouton principal (barre collée en bas sur mobile) ; les réglages rares (agrégateur, slippage, durée, eMode) sont dans un bloc « Réglages » replié ; les formats passent tous par `src/lib/format.ts` et les couleurs des valeurs par `src/lib/tone.ts` (seuils du health factor propres aux paires corrélées : rouge sous 1,03, ambre sous 1,08, contre 1,1 et 1,3 sinon).

## Marchés

Liste dans `src/config.ts` (`MARKETS`), adresses des pools tirées de `@bgd-labs/aave-address-book`. Les actifs de chaque marché sont lus sur la chaîne (`getReservesList`), donc un nouvel actif listé par Aave apparaît sans changer le code. Chaque agrégateur n'est proposé que sur ses chaînes (`chains` dans `AGGREGATORS`) : Velora ne couvre ni Mantle, ni Plasma, ni Linea, ni Monad, KyberSwap prend alors le relais. KyberSwap est appelé sans clé (en-tête `x-client-id: auto-loop`) ; un devis qui contient des frais (`extraFee`) est refusé.

## Rewards Merkl

Les APY ajoutent les campagnes Merkl en cours sur Aave (`api.merkl.xyz/v4/opportunities`, sans clé) : rewards de dépôt sur l'aToken du collatéral, rewards d'emprunt sur le jeton de dette. Une campagne n'est comptée que si elle nomme l'adresse de l'aToken ou du jeton de dette ; sinon elle est ignorée. Les conditions d'éligibilité propres à certaines campagnes ne sont pas vérifiées. Si l'API ne répond pas, l'interface le dit et affiche les APY sans bonus.

## Rendement propre des tokens

Les APY comptent aussi le rendement propre des tokens à rendement (wstETH, weETH, cbETH, rETH, sUSDe, syrupUSDC, sDAI…), qu'Aave intègre au prix mais n'affiche pas comme un taux. Source : l'adaptateur de prix « CAPO » d'Aave de chaque token (`getSourceOfAsset` sur l'oracle), qui garde un relevé du taux de change et sa date (`getSnapshotRatio`, `getSnapshotTimestamp`). La hausse entre ce relevé et le taux actuel (`getRatio`), annualisée, donne un rendement moyen lu sur la même chaîne, sans API tierce ni nœud d'archive (`src/lib/nativeYield.ts`). Il s'ajoute sur le collatéral (× levier) et se retranche sur une dette qui en a un (× levier − 1). Un PT Pendle compte son APY implicite, fixe jusqu'à l'échéance (voir plus bas). Un token sans adaptateur CAPO (adaptateur Chainlink simple) n'a pas de valeur : le Scanner l'étiquette « rendement du token non compté » quand son prix laisse penser qu'il en a un. Relevé de moins de 7 jours : ignoré.

## Boucles Pendle PT (Ethereum)

Un PT Pendle listé sur Aave (en eMode seulement, LTV 0 hors eMode) se boucle comme un autre collatéral, avec un rendement fixe jusqu'à son échéance (`src/lib/pendle.ts`). Lectures : `SY()`, `YT()`, `expiry()`, `isExpired()` du PT, son marché Pendle (liste de `PENDLE_MARKETS` et API Pendle, chaque marché vérifié par `isValidMarket` des factories), APY implicite `exp(lastLnImpliedRate) − 1`, TWAP 15 min de l'oracle PY. Devis par le RouterStatic (`swapExactTokenForPtStatic`, `swapExactPtForTokenStatic`, `redeemPyToTokenStatic` après échéance) et calldata du routeur Pendle v4 construite par l'app, relue avant signature (destinataire, marché, token, montant, minimum). Route en plusieurs étapes du contrat v2 : USDC → token d'entrée du SY (KyberSwap ou Velora) → PT (Pendle), et l'inverse à la fermeture ; après échéance, rachat 1 pour 1 du PT (et une fermeture totale rachète tout le PT, le reste revient en dette). Il faut un contrat v2 qui autorise le routeur Pendle : un contrat déployé avant n'est pas refusé, un bandeau propose d'en déployer un nouveau.

Écrans : tuiles « APY fixe » (rendement au prix payé, jusqu'à l'échéance) et « Échéance » (jours restants, APY coûts compris sur cette durée) dans Ouvrir ; health factor projeté à l'échéance (le prix d'oracle remonte vers 1, la dette grossit) dans Risques ; bloc « Prix du PT » (oracle Aave, prix payé, marché Pendle, TWAP) ; « Coût de sortie » dans Fermer ; étiquette « PT · J−N » dans le Scanner (un PT échu ou sans marché Pendle n'y figure pas) ; tuile « Échéance du PT » et bouton « Renouveler » dans Positions.

**Renouveler** (dernier mois avant l'échéance, ou PT échu) : vers un PT plus long accepté par l'eMode du compte, même sous-jacent d'abord. En une transaction (`swapCollateral` : flash loan du nouveau PT, dépôt, retrait et vente de l'ancien) quand Aave ou Morpho peut prêter le nouveau PT ; Aave liste les PT récents sans flash loan, le renouvellement passe alors en deux transactions : fermer (le PT restant revient au portefeuille), puis ouvrir le nouveau PT au même levier avec ce PT comme capital, prérempli. Entre les deux, aucune position n'est ouverte.

Test sur fork d'Ethereum (`NET=ethereum bash e2e/fork.sh` liste PT-reUSDe-10DEC2026 et PT-sUSN-22JUL2027 sur Aave Core avec `contracts/script/ForkListPt.s.sol`, oracle à décote linéaire, `DISCOUNTS="1500,800"` en bps pour la régler ; puis `MARKET=ethereum CHAIN_HEX=0x1 COLL=PT-reUSDe-10DEC2026 CAPITAL=USDC AMOUNT=1000 LEV=5 node e2e/run.cjs open o`, `run.cjs roll2 r` pour le renouvellement en deux temps, `CLOCK=<s>` avance l'horloge de la page comme `evm_increaseTime`). Testé le 08/11/2026 : ouverture x5 (USDC → reUSDe par KyberSwap → PT par Pendle), écran Positions, renouvellement en deux temps reUSDe → sUSN (fermeture, puis ouverture avec 970 PT-reUSDe comme capital : Pendle + Velora + Pendle), fermeture après échéance par rachat. Limite du fork : après un `evm_increaseTime`, les devis Velora et KyberSwap portent l'échéance de l'heure réelle et revertent (« Transaction too old ») ; seule une route 100 % Pendle passe.

## Taux moyens sur 7 et 30 jours

Pour ne pas ouvrir une boucle sur un pic de taux, la Boucle montre la moyenne sur 7 et 30 jours des taux de dépôt et d'emprunt de la paire (bloc « Taux Aave »), l'APY net de la boucle à ces taux moyens (bloc « Risques ») et un bandeau ambre quand le taux d'emprunt dépasse 1,5 fois sa moyenne sur 30 jours et d'au moins un point (idem pour un rendement de dépôt en pic). Source : les événements `ReserveDataUpdated` du pool, qui portent les index de la réserve à chaque action. Le dernier événement avant la date de début donne l'index d'alors, `getReserveNormalizedIncome` / `getReserveNormalizedVariableDebt` celui d'aujourd'hui ; leur rapport, annualisé, est l'APY moyen (`src/lib/rateHistory.ts`). Il faut un RPC qui garde les logs de la période : PublicNode ne garde qu'environ un jour sur Ethereum, Arbitrum, Optimism, BNB et Linea, le RPC public suivant de la chaîne prend alors le relais ; sans historique lisible, la moyenne ne s'affiche pas.

## Réclamer et réinvestir les rewards Merkl

Onglet « Réinvestir » de la Boucle (et bouton « Réinvestir » d'une position quand Merkl doit des rewards sur son réseau). Chaque étape est une transaction signée depuis le portefeuille, sans contrat nouveau ni autorisation durable (`src/lib/reinvest.ts`, `src/components/ReinvestPanel.tsx`) :
1. réclamer sur le Distributor de Merkl (`0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae`), une transaction pour tous les tokens du réseau. Le montant réclamable est le cumul de l'arbre moins le `claimed` lu on-chain sur le Distributor (l'API Merkl a des heures de retard) ;
2. pour chaque reward : l'aToken du collatéral est déjà du collatéral ; le collatéral lui-même devient du capital ; l'aToken d'une autre réserve est retiré d'Aave puis échangé ; tout autre token est échangé en collatéral par l'agrégateur, depuis le portefeuille (approbation du montant exact au routeur, minimum du devis vérifié sur le solde reçu). Moins de 1 $ ou prix inconnu : le token reste dans le portefeuille ;
3. « Augmenter la position » : l'onglet Ouvrir / augmenter s'ouvre avec ce capital et le levier qu'avait la position.

**En un clic** (portefeuille qui envoie un lot atomique, EIP-5792 `wallet_sendCalls` avec `forceAtomic` : MetaMask en compte intelligent, Ambire ; position à reprendre sur la paire ; eMode du compte compatible) : toutes les étapes partent en une confirmation, toutes passent ou aucune (`src/lib/oneClick.ts`). Garde-fous :
- le calldata de chaque échange est relu avant signature (`src/lib/swapCalldata.ts`, Velora et KyberSwap) : mêmes tokens, montant vendu exact (et jamais plus tiré par le routeur), sortie payée au portefeuille, aucun frais, minimum au moins celui de l'app ; sinon le devis est refusé. Ce contrôle vaut aussi pour le mode étape par étape ;
- le capital remis au contrat est la somme de ces minimums : si un échange rend moins, le contrat ne peut pas prendre le capital et tout le lot est annulé ;
- chaque autorisation (routeur, contrat, délégation de crédit) est du montant exact et revient à sa valeur d'avant juste après usage (0 le plus souvent) ; pour les tokens type USDT, passage par 0 ;
- devis, autorisations et levier recalculés au clic ; LTV projetée au pire cas vérifiée ; simulation du lot (`eth_simulateV1`) quand le RPC la permet, le portefeuille simule de son côté ;
- le contrat n'a pas changé : il ne vérifie toujours que son propre échange et n'agit que pour l'adresse qui signe.

Sinon, le mode étape par étape ci-dessus reste disponible.

Testé sur fork de Base le 05/11/2026 avec un compte réel qui avait 47 MORPHO à réclamer (`USER_ADDR=0x… node e2e/run.cjs reinvest r`) : réclamation, approbation, échange MORPHO → 0,0435 WETH, puis Augmenter prérempli. En un clic (portefeuille de test qui exécute le lot avec retour arrière en cas d'échec), sur une position WETH/USDC à 1,98x : réclamation, échange, levier en un lot ; collatéral +210 $, dette +103 USDC, levier inchangé, toutes les autorisations revenues à 0. Le Distributor n'a été vérifié que sur Base (même adresse annoncée par Merkl sur les autres réseaux).

## Ouvrir et fermer en une confirmation

Avec un portefeuille qui envoie des lots atomiques (EIP-5792, `forceAtomic` : MetaMask en compte intelligent, Ambire), « Ouvrir / augmenter » et « Fermer / réduire » partent en une seule confirmation (`openBatchCalls`, `closeBatchCalls` dans `src/lib/oneClick.ts`) :
- ouvrir : eMode si besoin, autorisation du capital et délégation d'emprunt au contrat pour les montants exacts, `open`, puis autorisation et délégation remises à leur valeur d'avant ;
- fermer : autorisation des aTokens exacte (0,1 % de marge sur une fermeture totale, les intérêts courent), `close`, puis autorisation remise à sa valeur.
Les autorisations sont relues au moment du clic, le lot est simulé quand le RPC le permet, et c'est le même appel au contrat que le mode habituel. Les tests (`batchOpenClose.test.ts`) vérifient qu'aucun lot ne laisse une autorisation plus grande qu'avant, quelle que soit la valeur de départ. Sans lot atomique, le mode habituel (signature de délégation ou permit, puis transaction) reste.
Testé sur fork de Base le 05/11/2026 : ouverture 3x de 1 WETH en un lot puis fermeture totale en un lot ; autorisation WETH, délégation USDC et autorisation aWETH à 0 après chaque lot, contrat sans solde.

## eMode

Les catégories eMode du marché sont lues sur le pool (getters Aave v3.2+ : configuration, bitmaps collatéral, empruntable et LTV nulle). Pour une paire, l'interface propose les catégories où le collatéral compte avec la LTV de la catégorie et où la dette est empruntable, la meilleure LTV par défaut (ou la catégorie actuelle du compte si elle convient). Les calculs utilisent alors la LTV et le seuil de liquidation de la catégorie. L'eMode est un réglage du compte Aave que seul l'utilisateur peut changer : si besoin, une transaction `setUserEMode` part avant l'ouverture, le contrat ne change pas. La fermeture calcule avec l'eMode actuel du compte.

## Ce que fait l’interface

**Ouvrir** : emprunt `D = capital × (levier − 1)` au prix de l’oracle Aave, devis D → collatéral chez l’agrégateur choisi (taker = contrat), `minOut` = devis − slippage. Affiche collatéral déposé, levier effectif, health factor (attendu et pire cas), prix de liquidation, LTV face au maximum d’Aave, APY net. Bloque si la LTV dépasse le maximum, si l’actif est isolé, gelé, sans flash loan, ou si le solde manque.
Signature : `approve` du collatéral si besoin (une transaction, une fois), délégation de crédit signée en EIP-712 si besoin (sans gas), puis `openWithSig` ou `open`.

**Capital dans n’importe quel token** (contrat v2) : une liste à côté du montant propose le collatéral, l’actif emprunté, puis les tokens du marché Aave que le wallet détient. L’actif emprunté est vendu avec l’emprunt dans le même swap ; un autre token est d’abord échangé contre le collatéral par le contrat (`capitalSteps`, devis capital → collatéral avec le contrat comme taker). L’emprunt vise le levier sur la valeur du capital (devis attendu, ou oracle pour l’actif emprunté) ; le health factor du pire cas et la garde utilisent les minimums des deux devis ; le coût d’entrée compte les deux swaps. L’autorisation porte sur le token du capital.

**Fermer / réduire** (25, 50, 75 % ou tout) : avec la v2, le flash loan vient de Morpho Blue (sans prime) quand il détient au moins 102 % du montant à rembourser, sinon d'Aave (prime). Calcule le collatéral à vendre pour couvrir dette + prime éventuelle + slippage, vérifie que le minimum garanti du devis couvre le remboursement, affiche ce qui revient. Permit d’aToken signé si besoin, puis `closeWithSig` ou `close`.

**Changer de collatéral** (contrat v2, onglet visible quand le compte a du collatéral sur la paire) : nouveau collatéral parmi ceux du marché acceptés comme collatéral (LTV > 0, ni gelés, ni en pause, ni isolés ; ceux de la catégorie eMode du compte s’il en a une), part de 25 %, 50 % ou tout. Devis ancien → nouveau collatéral (taker = contrat) ; le contrat emprunte en flash loan `minOut − prime` du nouveau collatéral (Morpho sans prime s’il en détient au moins 102 %, sinon Aave), le dépose, retire l’ancien, l’échange et rembourse ; le surplus est déposé aussi. Health factor projeté avec le seuil de chaque collatéral, garde à 98 % du pire cas, APY avant / après, coût (swap, prime, gas). Permit d’aToken signé si besoin puis `swapCollateralWithSig`, ou lot avec autorisation exacte. Après un changement partiel, le compte a deux collatéraux : les écrans comptent alors le levier sur tout le compte, et « Fermer » refuse de rembourser plus que le collatéral de la paire ne couvre (réduire moins, ou ramener d’abord tout le collatéral sur un seul). La dette ne change pas ; après un changement total, le reste d’intérêts de l’ancien collatéral non vendu revient au wallet.

**Montants réels** (contrat v2) : après chaque ouverture, augmentation, réduction, fermeture ou changement de collatéral, l’app lit le reçu et décode les événements du contrat (`PositionOpened`, `PositionClosed`, `CollateralSwapped`, un `Swapped` par swap), pour le seul contrat Auto-loop et le compte connecté. Sous la ligne de succès, la liste « Montants réels » donne capital, déposé, emprunté, remboursé, retiré, rendu, prime (si non nulle), chaque swap et le health factor final ; « (devis …) » s’ajoute quand le réel s’écarte de plus de 0,01 % de l’estimation. Dans un lot, le reçu pris est celui où le contrat a agi. Rien n’est affiché si le reçu est illisible ou avec un contrat v1.

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
NODE_PATH=$(npm root -g) node e2e/run.cjs open ouvrir         # puis reduce / close
```

Résultats (1 WETH de capital, levier 3x, dette USDC, slippage 0,5 %) :
- ouverture : approve, délégation de crédit signée en EIP-712, `openWithSig`. 4 750 USDC empruntés, 3,0 WETH déposés, HF 1,24 comme affiché, ~733k gas ;
- fermeture à 50 % puis totale : permit d’aWETH signé, `closeWithSig`. Dette à 0, ~1,7M gas pour la fermeture totale ; il revient 0,9835 WETH + 33,6 USDC, soit ~0,25 % de coût aller-retour sur le capital (swaps sur 3x le capital + prime de flash loan) ;
- après chaque transaction, le contrat ne garde ni token ni approval ;
- avec le filtre AMM, 3 tours complets sur 4 ont réussi (dont un avec fermeture à 50 %) ; l’échec est remonté comme une erreur dans l’interface, sans perte.

Testé le 08/11/2026 avec la v2 (`bash e2e/fork.sh` la déploie, `V1=1` déploie l'ancienne) : ouverture 3x, augmentation à 4x, réduction à 2x, fermeture totale via Morpho (prime 0, événement `PositionClosed` vérifié), en étapes et en lot (`BATCH=1`), avec Velora et KyberSwap ; déploiement par le bouton de l'app ; ouverture et fermeture avec un contrat v1 (bandeau de mise à jour affiché). Capital dans un autre token (`FUND=1 bash e2e/fork.sh` donne aussi 5000 USDC et 1 wstETH, puis `CAPITAL=USDC AMOUNT=2000` ou `CAPITAL=wstETH AMOUNT=0.5` pour `run.cjs open`) : ouverture 3x avec 2000 USDC, avec 0,5 wstETH (étapes et lot), augmentation à 4x avec 1000 USDC. Changement de collatéral (`TARGET=cbETH PART="50 %" run.cjs swap`, `COLL=cbETH` pour agir ensuite sur la paire cbETH/USDC) : WETH → cbETH à 50 % via Morpho, en totalité en lot, en totalité via Aave (Morpho vidé de son cbETH sur le fork, prime prélevée), puis fermeture de la position cbETH/USDC. Montants réels : affichés après ouverture (capital wstETH, en lot), réduction, changement de collatéral et fermeture, identiques aux événements lus avec `cast`. La v2 ajoute un health factor minimum (98 % du pire cas du devis) et une échéance de 20 minutes à chaque appel.

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
