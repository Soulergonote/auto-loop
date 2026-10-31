# Auto-loop

Ouvrir ou fermer une position à levier sur Aave v3 (Base) en une seule transaction : flash loan, swap via un agrégateur, dépôt.

- `app/` : interface web (Vite + React + wagmi), 100 % statique, publiée sur GitHub Pages à chaque push sur `main`.
- `contracts/` : contrat `LeverageExecutor` (Foundry) et ses tests.
- `architecture.md`, `agregateurs.md` : choix d'architecture et comparatif des agrégateurs.

Non audité. Le contrat n'est pas encore déployé sur Base : l'interface calcule tout mais ne propose pas encore de signer.
