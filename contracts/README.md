# Auto-loop : contrat de levier atomique

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

Dépendance de test : `aave-v3-origin` est sous licence BUSL-1.1, utilisé uniquement pour les tests. Le contrat lui-même est MIT et n'importe que OpenZeppelin.
