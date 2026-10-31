# Auto-loop : contrat de levier atomique

`LeverageExecutor` ouvre et ferme une position à levier sur Aave v3 en **une seule transaction**, avec un swap via un agrégateur (0x, 1inch, Velora). Conception : voir `../architecture.md`.

## Contenu

| Fichier | Rôle |
|---|---|
| `src/LeverageExecutor.sol` | Le contrat (ouverture, fermeture, variantes avec signature EIP-712). |
| `src/interfaces/IAaveV3.sol` | Interface minimale d'Aave v3 (compatible v3.0 → v3.7). |
| `test/LeverageExecutor.t.sol` | 24 tests sur un **vrai Aave v3.6** déployé en local (code officiel `aave-v3-origin`), swap simulé par un routeur factice au prix de l'oracle. |
| `test/mocks/MockAggregatorRouter.sol` | Routeur factice (slippage réglable, routes malveillantes). |
| `test/fork/BaseFork.t.sol` | Tests sur fork de Base (Aave v3 réel, swap Uniswap v3, puis rejeu de calldata Velora réel). Ignorés sans `BASE_RPC_URL`. |
| `script/quote-velora.sh` | Récupère un devis Velora réel (USDC → WETH) avec le contrat comme taker. |
| `script/setup.sh` | Installe les dépendances dans `lib/`. |

## Lancer

```bash
bash script/setup.sh
forge test                                   # tests locaux
BASE_RPC_URL=https://... forge test --match-contract BaseForkTest -vv
eval "$(bash script/quote-velora.sh 2000)" && BASE_RPC_URL=https://... forge test --match-test aggregatorCalldata -vv
```

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
- Liste blanche des routeurs (gérée par l'owner, le Pool est interdit comme routeur), approval exacte remise à 0 après le swap, contrôle du swap par différence de soldes, `nonReentrant`.
- Aucun fonds ni approval ne reste dans le contrat entre deux transactions (vérifié après chaque test). L'owner ne peut que gérer la liste blanche et récupérer des tokens envoyés par erreur ; il n'a aucun pouvoir sur les positions.

## Résultats

- 24 tests locaux passent, dont un fuzz (256 runs) ouverture puis fermeture totale entre 1,1x et 5x.
- Gas (local, swap factice) : ~526k pour `open`, ~513k pour `close`. Un vrai agrégateur ajoute le coût de sa route.
- **Tests sur fork de Base : 2/2 passent** (18/10/2026, RPC public `https://mainnet.base.org`, dernier bloc) :
  - ouverture 3x WETH/USDC avec swap Uniswap v3 (1 WETH + 4 769 USDC empruntés → 2,996 aWETH, HF 1,24), puis fermeture totale 7 jours plus tard : dette à 0, aucun reste dans le contrat ;
  - rejeu d'un vrai devis Velora (2 000 USDC → WETH via Augustus v6.2) : 1,838 aWETH, HF 1,82.
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
- Non audité. Rien n'est déployé.

Dépendance de test : `aave-v3-origin` est sous licence BUSL-1.1, utilisé uniquement pour les tests. Le contrat lui-même est MIT et n'importe que OpenZeppelin.
