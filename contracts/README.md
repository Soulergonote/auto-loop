# Auto-loop : contrat de levier atomique

Deux versions cohabitent : `LeverageExecutor` (v1, utilisée par l'app et déployée par Azerty sur Plasma) et `LeverageExecutorV2` (v2, voir [la section v2](#v2--leverageexecutorv2), pas encore branchée dans l'app).

`LeverageExecutor` ouvre et ferme une position à levier sur Aave v3 en **une seule transaction**, avec un swap via un agrégateur (Velora, KyberSwap ; 0x et 1inch prévus). Conception : voir `../architecture.md`.

## Contenu

| Fichier | Rôle |
|---|---|
| `src/LeverageExecutor.sol` | Le contrat (ouverture, fermeture, variantes avec signature EIP-712). |
| `src/interfaces/IAaveV3.sol` | Interface minimale d'Aave v3 (compatible v3.0 → v3.7). |
| `test/LeverageExecutor.t.sol` | 27 tests sur un **vrai Aave v3.6** déployé en local (code officiel `aave-v3-origin`), swap simulé par un routeur factice au prix de l'oracle. |
| `test/mocks/MockAggregatorRouter.sol` | Routeur factice (slippage réglable, routes malveillantes). |
| `test/fork/BaseFork.t.sol` | Tests sur fork de Base (Aave v3 réel, swap Uniswap v3, puis rejeu de calldata Velora ou KyberSwap réel). Ignorés sans `BASE_RPC_URL`. |
| `script/quote-velora.sh`, `script/quote-kyber.sh` | Récupèrent un devis Velora ou KyberSwap réel (USDC → WETH) avec le contrat comme taker. |
| `script/export-bytecode.cjs` | Compile le contrat avec solc-js 0.8.27 et écrit `app/src/executorBytecode.ts`, utilisé par le bouton « Déployer le contrat » de l'app. |
| `script/setup.sh` | Installe les dépendances dans `lib/`. |
| `src/LeverageExecutorV2.sol` | La v2 (chaînes de swaps, capital en n'importe quel token, garde, changement de collatéral, flash loans gratuits). |
| `src/interfaces/IFlashLenders.sol` | Interfaces des flash loans Morpho Blue et Balancer v2. |
| `test/v2/*.t.sol` | 130 tests v2 sur le même Aave v3.6 local : ouverture, fermeture, changement de collatéral, attaques, fuzz et invariants. |
| `test/mocks/MockFlashLenders.sol`, `test/mocks/AttackRouter.sol` | Prêteurs Morpho et Balancer factices (même déroulé que les vrais), prêteurs qui ne rappellent jamais, routeur qui exécute du code hostile au milieu d'un swap. |
| `test/fork/BaseForkV2.t.sol`, `test/fork/EthereumForkV2.t.sol` | v2 sur forks réels : Base (Aave, Morpho, Balancer, Uniswap) et Ethereum (Aave Core, Pendle, Curve, Morpho, Balancer). Ignorés sans `BASE_RPC_URL` / `ETH_RPC_URL`. |

## Lancer

```bash
bash script/setup.sh
forge test                                   # tests locaux
BASE_RPC_URL=https://... forge test --match-contract BaseForkTest -vv
eval "$(bash script/quote-velora.sh 2000)" && BASE_RPC_URL=https://... forge test --match-test aggregatorCalldata -vv
eval "$(bash script/quote-kyber.sh 2000)" && BASE_RPC_URL=https://... forge test --match-test aggregatorCalldata -vv
```

Sans accès à binaries.soliditylang.org, `forge --use <solc>` accepte n'importe quel binaire qui parle le JSON standard de solc 0.8.27 (par exemple un petit wrapper autour de solc-js, la même version compilée en wasm).

`ffi = true` est requis par les helpers de déploiement d'Aave (ils lisent seulement `.env` via `sed` et `cast`).

## Fonctionnement

**Ouverture** `open(OpenParams)` (collatéral C, dette D) :
1. récupère le capital initial en C de l'appelant ;
2. `Pool.flashLoan` de D en mode 2 avec `onBehalfOf = msg.sender` : **aucune prime**, Aave ouvre la dette variable au nom de l'appelant à la fin du callback ;
3. dans le callback : swap D → C via le routeur, contrôle `minOut`, `supply` de tout le C au nom de l'appelant ;
4. Aave vérifie le health factor : s'il est < 1 tout revert.

Prérequis côté utilisateur : `C.approve(executor, initial)` et `variableDebtD.approveDelegation(executor, montant)`, ou `openWithSig` avec une signature `delegationWithSig` pour tout faire en une transaction.

**Fermeture** `close(CloseParams)` : flash loan de D en mode 0 (prime payée, 0,05 % par défaut) → `repay` de la dette de l'appelant → transfert de ses aTokens → `withdraw` → swap C → D → Aave reprend le prêt + prime → le reste (C non vendu et excédent de D) revient à l'appelant. `repayAmount` et `collateralToWithdraw` acceptent `type(uint256).max` pour une fermeture totale ; fermeture partielle possible. Prérequis : `aC.approve(executor, …)` ou `closeWithSig` avec un permit d'aToken.

**Paramètre de swap** : `router` (le `to` du devis), `data` (calldata du devis, demandé avec **le contrat comme taker**), `minOut`. Le montant vendu doit être exactement le montant du devis (`debtAmount` à l'ouverture, `collateralToSell` à la fermeture).

## Sécurité

- Le contrat n'agit que pour `msg.sender` : l'emprunteur, le bénéficiaire du supply et le propriétaire des aTokens retirés sont toujours l'appelant. Une délégation de crédit ou une approval d'aTokens accordée au contrat ne peut pas être utilisée par quelqu'un d'autre (testé).
- `executeOperation` n'accepte que les appels du Pool pour des flash loans initiés par le contrat lui-même (testé).
- **Aucun propriétaire, aucune fonction d'administration** : la liste blanche des routeurs est fixée dans le constructeur et ne peut plus jamais changer (testé). Le constructeur refuse comme routeur le Pool, le contrat lui-même et toute adresse sans code ; un swap ne peut pas viser le token vendu ni le token acheté (testé : un routeur ne peut pas servir à dépenser les approvals laissées par un autre utilisateur).
- Approval exacte remise à 0 après le swap, contrôle du swap par différence de soldes, `nonReentrant`.
- Aucun fonds ni approval ne reste dans le contrat entre deux transactions (vérifié après chaque test). Le contrat ne garde jamais rien : la position est sur le compte Aave de l'utilisateur, qui peut toujours la gérer ou la fermer directement sur Aave sans ce contrat.
- L'app vérifie le contrat avant de proposer quoi que ce soit à la signature : son code on-chain doit être identique à celui que produit le constructeur pour ce Pool (dry-run `eth_call`), et chaque routeur attendu doit être autorisé.

## Résultats

- 27 tests locaux passent (01/11/2026, après suppression de l'owner), dont un fuzz (256 runs) ouverture puis fermeture totale entre 1,1x et 5x.
- Gas (local, swap factice) : ~526k pour `open`, ~513k pour `close`. Un vrai agrégateur ajoute le coût de sa route.
- **Tests sur fork de Base : 2/2 passent** (18/10/2026, RPC public `https://mainnet.base.org`, dernier bloc) :
  - ouverture 3x WETH/USDC avec swap Uniswap v3 (1 WETH + 4 769 USDC empruntés → 2,996 aWETH, HF 1,24), puis fermeture totale 7 jours plus tard : dette à 0, aucun reste dans le contrat ;
  - rejeu d'un vrai devis Velora (2 000 USDC → WETH via Augustus v6.2) : 1,838 aWETH, HF 1,82.
- 01/11/2026, contrat sans owner : 3/3 fork Base passent (Uniswap v3 ouverture + fermeture ; vrai devis Velora : 1,881 aWETH, HF 1,79 ; vrai devis KyberSwap : 1,882 aWETH, HF 1,79). Déploiement depuis le bouton de l'app puis ouverture et fermeture réussis sur fork local de Base.
- Devis 0x et 1inch pas encore testés : leurs API demandent une clé (`ZEROX_API_KEY`, `ONEINCH_API_KEY`).
- `evm_version = "cancun"` est nécessaire : le Pool Aave de Base utilise des opcodes Cancun et le fork revert (`NotActivated`) en `shanghai`.
- La dette Aave peut dépasser `debtAmount` de 1 à 2 wei (arrondi du solde à l'échelle), d'où `assertApproxEqAbs` dans les tests fork.

## Limites connues (v1)

- Collatéral initial uniquement dans l'actif de collatéral (pas en actif de dette).
- eMode : l'utilisateur doit l'activer lui-même avant (`setUserEMode` n'agit que pour `msg.sender`).
- Actifs en isolation mode : un supply fait par un tiers n'active pas le collatéral sans rôle spécial chez Aave, donc l'ouverture échouera sur ces actifs.
- Fermeture : la prime de flash loan Aave est payée ; un flash loan Morpho Blue (gratuit) pourrait la supprimer plus tard.
- Tokens à frais de transfert non supportés.
- Adresses des routeurs dans `BaseFork.t.sol` à revérifier dans la doc de chaque agrégateur avant tout déploiement.
- Non audité. Rien n'est déployé sur un réseau réel ; le déploiement se fait depuis le portefeuille de l'utilisateur, dans l'app.

## v2 : `LeverageExecutorV2`

Nouveau contrat, même modèle de sécurité que la v1 ; la v1 n'est pas modifiée. Une position ouverte avec la v1 (ou directement sur aave.com) se gère avec la v2, puisqu'elle vit sur le compte Aave de l'utilisateur (testé).

### Les 7 changements

1. **Chaînes de swaps** : chaque swap est une liste de 1 à 4 étapes `Step {router, tokenOut, data, minOut}` (par exemple PT → sUSDe → USDe). Chaque étape a son propre minimum, contrôlé par différence de soldes ; la dernière doit livrer le bon token. La deuxième étape vend le montant écrit dans son calldata (le minimum de la première, comme l'app le cote) : ce que la première a livré en plus revient à l'utilisateur dans le token intermédiaire.
2. **Capital en n'importe quel token** : `capitalToken` peut être le collatéral, l'actif de dette (vendu avec la dette, en une seule étape) ou autre chose, échangé en collatéral par `capitalSteps`. `debtAmount = 0` fait un simple dépôt (avec ou sans swap) ; `capitalAmount = 0` ajoute du levier à une position existante.
3. **Garde** sur chaque appel : `minHealthFactor` (0 = pas de contrôle) et `deadline` (inclusive ; 0 échoue toujours, ce n'est pas « sans limite »).
4. **`swapCollateral`** : remplace le collatéral sans toucher à la dette (flash loan du nouveau collatéral → supply pour l'utilisateur → retrait de l'ancien → swap → remboursement ; le surplus est déposé pour l'utilisateur). C'est le « roll » d'un PT Pendle à maturité.
5. **Fermeture et changement de collatéral sans prime** : `flashLender` vaut `address(POOL)` (prime Aave, 0,05 % par défaut) ou un prêteur gratuit enregistré au déploiement, Morpho Blue ou le Vault Balancer v2. L'ouverture reste en flash loan Aave mode 2 (sans prime).
6. **Valeurs de retour et événements** : `open` renvoie `(collateralSupplied, debtBorrowed, healthFactor)`, `close` un `CloseResult` (dette remboursée, collatéral retiré, collatéral et dette rendus, prime, HF), `swapCollateral` un `SwapCollateralResult`. Un événement `Swapped` par étape, et `PositionOpened` / `PositionClosed` / `CollateralSwapped` qui reprennent exactement les valeurs renvoyées (testé).
7. **Routeur Pendle** : aucun code spécifique, il suffit de le mettre dans la liste blanche au déploiement (`0x888888888889758F76e7103c6CbF23ABbF58F946`, même adresse sur toutes les chaînes).

Prérequis côté utilisateur, montants exacts, dans le même lot de transactions du portefeuille :
- ouverture : `capitalToken.approve(executor, capitalAmount)` et `variableDebtD.approveDelegation(executor, debtAmount)` (ou `openWithSig`) ;
- fermeture : `aC.approve(executor, montant)` (ou `closeWithSig`) ;
- changement de collatéral : `aC1.approve(executor, montant)` (ou `swapCollateralWithSig`), et l'eMode de l'utilisateur doit accepter le nouveau collatéral.

### Sécurité v2 (en plus de celle de la v1)

- **Rappels de flash loan à usage unique** : juste avant de demander un prêt, le contrat enregistre `keccak256(prêteur, actif, montant, données)` ; un rappel n'est accepté que du prêteur demandé, avec exactement ces valeurs, et efface l'empreinte. Un rappel qui n'arrive jamais fait échouer l'appel (`FlashLoanNotExecuted`). Testé : appels directs des trois rappels, Vault Balancer appelé par un attaquant avec le contrat comme destinataire (l'attaque classique), flash loan Aave initié par un tiers, autre instance de Morpho, rejeu des mêmes données pendant un swap.
- **Routeurs hostiles** : un routeur de la liste blanche qui exécute du code au milieu d'un swap ne peut ni rentrer dans `open`, `close` ou `swapCollateral` (`nonReentrant`), ni déclencher un rappel de flash loan, ni dépenser les approvals des utilisateurs (elles sont données au contrat, pas au routeur). Testé avec `AttackRouter`.
- **Aucun token comme routeur** : le constructeur refuse le Pool, les prêteurs, le contrat lui-même, les adresses sans code, et **tout token Aave** (actif listé, aToken, token de dette) ; en plus, chaque étape refuse un routeur qui est l'un des tokens de l'opération. Testé, y compris avec des routeurs qui ont une fonction `fallback`.
- Le constructeur refuse un prêteur sans code, en double, de type `None`, ou égal au Pool ou au contrat.
- Toujours aucun propriétaire, aucune fonction d'administration, aucun proxy ; le bytecode ne contient ni `SELFDESTRUCT`, ni `DELEGATECALL`, ni `CALLCODE` (testé en parcourant le bytecode).
- Invariants (fuzz avec état, 48 séquences de 40 appels par propriété : ouvertures, fermetures partielles et totales, changements de collatéral, par 3 utilisateurs, via les 3 prêteurs, routes à 1 ou 2 étapes, temps qui passe) : le contrat ne garde jamais ni token ni approval, et aucun appel ne modifie la position d'un autre utilisateur que l'appelant.
- Slither 0.11.6 : rien de bloquant. Signalés et vérifiés : `transferFrom` d'un `user` qui est toujours `msg.sender` (ou l'adresse liée à l'empreinte du flash loan, elle-même écrite avec `msg.sender`) ; soldes lus avant l'appel au routeur (c'est voulu : contrôle par différence) ; écritures après appels externes protégées par `nonReentrant` et l'empreinte.
- Un token envoyé par erreur au contrat y reste (seules les différences de soldes sont rendues) et ne bloque rien ; des aTokens envoyés par erreur partent avec le prochain retrait. Pas de fonction de récupération, puisqu'il n'y a pas d'administrateur.

### Lancer

```bash
forge test --no-match-path 'test/fork/*'                       # v1 + v2 en local
BASE_RPC_URL=https://base-rpc.publicnode.com forge test --match-contract BaseForkV2Test -vv
ETH_RPC_URL=https://ethereum-rpc.publicnode.com forge test --match-contract EthereumForkV2Test -vv
```

### Résultats (06/11/2026)

- **156 tests locaux passent** : 27 v1 + 129 v2 (40 ouverture, 26 fermeture, 27 changement de collatéral, 31 sécurité, 3 fuzz à 256 essais, 2 invariants).
- Cas des PT (collatéral seulement en eMode, LTV de base 0) : confirmé en local (actif à LTV 0 hors eMode, eMode à 90 %) **et sur le vrai Aave Core d'Ethereum**, où USDe et sUSDe ont justement une LTV de base de 0. Un supply fait par le contrat pour l'utilisateur active bien le collatéral à la LTV de l'eMode ; hors eMode, Aave refuse l'emprunt ; si Aave met la LTV d'un PT à zéro dans l'eMode (`ltvzero`), l'ouverture échoue.
- **Fork Base, 5/5** (Aave v3, vrais Morpho et Balancer v2, Uniswap v3 comme routeur) : ouverture 3x WETH/USDC depuis 3 000 USDC puis fermeture totale via Morpho (prime 0, Morpho remboursé au wei près) ; route à 2 étapes USDC → WETH → wstETH avec capital en WETH, fermeture en 2 étapes via Balancer (frais 0) ; changement de collatéral WETH → wstETH via Morpho et via Aave (prime 0,0016 wstETH) ; faux rappel Balancer refusé. Le constructeur accepte les 6 routeurs de Base (Uniswap, Velora, KyberSwap, 1inch, 0x, Pendle).
- **Fork Ethereum, 4/4** : boucle 5x USDe/USDC en eMode (10 000 USDC de capital, 50 022 USDe déposés, HF 1,15) puis fermeture totale via Morpho ; fermeture partielle via Balancer avec `minHealthFactor` ; refus hors eMode ; un PT arrivé à maturité (PT-srUSDe-22OCT2026) apporté comme capital est remboursé par le **routeur Pendle** (`redeemPyToToken`) en sUSDe et déposé, en une transaction (7 954,6 sUSDe pour 10 000 PT, 0,03 % sous l'oracle).
- Gas (local, swap factice) : ~550k pour `open`, ~570k pour `close` en médiane. Taille : 17 552 octets (limite 24 576).

### Limites connues (v2)

- **Non audité.** Rien n'est déployé sur un réseau réel. L'app utilise toujours la v1 : brancher la v2 (bytecode, vérification on-chain, formulaires) est l'étape suivante.
- Achat de PT Pendle (`swapExactTokenForPt`) non testé de bout en bout : aucun PT actif n'est listé sur Aave Core Ethereum aujourd'hui (le plus récent, PT-srUSDe-22OCT2026, est arrivé à maturité), ni sur Base. Le même routeur Pendle a été testé pour le remboursement à maturité, avec le même mécanisme (approval exacte, `transferFrom` par le routeur, sortie vers le contrat).
- Aave de Plasma et de Monad non testés (RPC inaccessibles depuis l'environnement cloud) : version d'Aave et comportement du LTV 0 en eMode à vérifier avant d'y faire des PT.
- Morpho Blue et Balancer v2 doivent être déployés sur la chaîne pour servir de prêteur gratuit (adresses à vérifier chaîne par chaîne ; sinon `address(POOL)` avec prime).
- Mêmes limites que la v1 pour l'isolation mode, les tokens à frais de transfert et l'eMode (que l'utilisateur active lui-même).

Dépendance de test : `aave-v3-origin` est sous licence BUSL-1.1, utilisé uniquement pour les tests. Le contrat lui-même est MIT et n'importe que OpenZeppelin.
