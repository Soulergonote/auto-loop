# Auto-loop

Ouvrir, ajuster ou fermer une position à levier en **une seule transaction** (flash loan, swap via un agrégateur, dépôt) sur Aave v3 et Morpho Blue, boucles Pendle PT comprises, sur une quinzaine de réseaux EVM.

App en ligne : https://soulergonote.github.io/auto-loop/ (100 % statique, publiée à chaque push sur `main`).

| Dossier | Contenu |
|---|---|
| `app/` | Interface web (Vite, React, wagmi/viem). Organisation et commandes : `app/README.md`. |
| `contracts/` | Contrats Foundry : `LeverageExecutor` (v1, encore utilisé), `LeverageExecutorV2` (Aave, déployé par l'app), `LeverageExecutorMorpho` (Morpho Blue), et leurs tests. Voir `contracts/README.md`. |
| `docs/` | Choix d'architecture (`architecture.md`) et comparatif des agrégateurs (`agregateurs.md`). |
| `.github/workflows/` | `pages.yml` : lint, format, tests et build de l'app, puis publication. `contracts.yml` : `forge test` hors tests sur fork. |

Agrégateurs : Velora et KyberSwap. Les contrats n'ont ni propriétaire ni admin et ne gardent aucun fonds ; audit interne de la V2 seulement, pas d'audit externe.
