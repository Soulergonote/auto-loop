# Comparaison des agrégateurs DEX pour Auto-loop (Base)

Vérifié le 18/10/2026 dans les docs officielles, sauf mention contraire. Seules les quotes Velora ont été testées en direct : le réseau du projet bloque les autres API.

## Tableau

| Agrégateur | Clé API | Débit gratuit | Frais du protocole | Atomique (utilisable dans notre flash loan) | Remarque |
|---|---|---|---|---|---|
| **Velora v6.2** (ex-Paraswap) | Non | Non publié (15 requêtes d'affilée passées sans 429) | 0,01 % en anonyme, **0 avec `partner=auto-loop`** (testé) | Oui | RFQ inclus (Native, Tessera) |
| **KyberSwap** | Non (`x-client-id` recommandé) | 3 req/s | Aucun frais publié | Oui | Bon candidat de secours sans clé |
| **1inch v6** (Classic) | Oui | 1 req/s, 100 k/mois | Aucun frais de protocole ; surplus gardé par les fournisseurs d'infra | Oui | Liquidité très large |
| **Odos** | Oui, selon la page du portail (free plan avec clé) | 2 req/s, 4 000/jour (portail) ou 600/5 min par IP (page pricing) | Pas de frais fixe documenté ; le surplus est une source de revenu (estimé à 0,25 % sur les paires volatiles en Simple Swap) | Oui | Docs contradictoires |
| **0x v2** | Oui | ~5 à 10 req/s | **0,15 %** sur certaines paires + surplus | Oui | |
| **Matcha** | Pas d'API propre | | | | Interface de 0x : mêmes routes et mêmes frais via l'API 0x |
| **LI.FI** | Non (clé pour monter le quota) | /quote : 75 requêtes par 2 h et par IP | **0,25 %** par transaction (doc officielle) | Oui en same-chain | Méta-agrégateur (appelle 1inch, 0x, etc.) ; surtout utile pour le cross-chain |
| **OKX DEX API** | Oui (clé + secret + passphrase, signature HMAC) | Non trouvé | Pas de frais de protocole trouvé ; commission intégrateur jusqu'à 3 % | Oui | Auth lourde pour un front-end |
| **OpenOcean** | Non confirmé | Non trouvé | Non confirmé (sources tierces seulement) | Oui | Docs officielles introuvables |
| **MetaMask Swaps** | Pas d'API publique | | **0,875 %** | | Méta-agrégateur grand public, hors sujet pour nous |

Exclus d'office, car non atomiques (intent ou ordre signé, exécution différée) : CoW, 1inch Fusion, UniswapX, Bebop JAM, Velora Delta.

## Ce que ça coûte avec le levier

Les frais s'appliquent à tout le montant swappé, flash loan compris. Exemple : 1 000 $ de capital à 3x, donc 2 000 $ swappés à l'ouverture.

| Frais | Coût | En % du capital |
|---|---|---|
| Velora avec `partner`, Kyber, 1inch | ~0 $ | ~0 % |
| 0x (0,15 %) | 3 $ | 0,3 % |
| LI.FI (0,25 %) | 5 $ | 0,5 % |
| MetaMask (0,875 %) | 17,5 $ | 1,75 % |

Le même coût revient à la fermeture.

## Recommandation

Velora reste l'agrégateur principal (sans clé, sans frais avec `partner`). KyberSwap est la meilleure alternative sans clé, et 1inch celle avec clé. Odos vaut un test de prix. LI.FI, Matcha et MetaMask n'apportent rien en same-chain et coûtent plus cher. Avant de trancher, il faudrait comparer les prix nets réels.

Pour ce comparatif, il faut ajouter ces hôtes à la liste réseau de l'environnement : `aggregator-api.kyberswap.com`, `api.odos.xyz`, `li.quest`.

## Sources

- Velora : appels directs à `api.paraswap.io` (Base, 18/10/2026), [Market API](https://www.velora.xyz/docs/api-reference/market/overview)
- KyberSwap : [Rate limits & Client ID](https://docs.kyberswap.com/developer-guide/start-here/rate-limits-and-client-id)
- 1inch : [plans](https://help.1inch.com/en/articles/12398075-pricing-and-subscriptions-faq), [surplus](https://help.1inch.com/en/articles/5583703-what-is-a-swap-surplus-and-where-does-it-end-up-when-my-swap-is-completed)
- Odos : [API pricing](https://docs.odos.xyz/build/api_pricing), [API portal](https://docs.odos.xyz/home/api-portal-access), [Protocol fees](https://docs.odos.xyz/build/fees)
- 0x : [Pricing FAQ](https://help.0x.org/articles/3042324687-0x-api-pricing-faq), [Monetize](https://docs.0x.org/evm/0x-swap-api/guides/monetize-your-app-using-swap)
- LI.FI : [Rate limits](https://docs.li.fi/api-reference/rate-limits), [FAQ frais](https://docs.li.fi/overview/faq)
- OKX : [SDK auth](https://www.mintlify.com/okx/okx-dex-sdk/core-concepts/authentication) (source secondaire)
- MetaMask : [Swaps user guide](https://support.metamask.io/trade/swap/user-guide-swaps/)
