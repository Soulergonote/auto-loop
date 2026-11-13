import { parseAbi } from 'viem'

const swap = '(address router, bytes data, uint256 minOut)'
const sig = '(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)'
const openParams = `(address collateralAsset, address debtAsset, uint256 initialCollateral, uint256 debtAmount, ${swap} swap)`
const closeParams = `(address collateralAsset, address debtAsset, uint256 repayAmount, uint256 collateralToWithdraw, uint256 collateralToSell, ${swap} swap)`

/** LeverageExecutor v1: still used by executors deployed before v2 (positions live in the user's Aave account). */
export const executorAbiV1 = parseAbi([
  'constructor(address pool, address[] routers)',
  'function POOL() view returns (address)',
  `function open(${openParams} p)`,
  `function openWithSig(${openParams} p, ${sig} delegation)`,
  `function close(${closeParams} p)`,
  `function closeWithSig(${closeParams} p, ${sig} aTokenPermit)`,
  'function isRouterAllowed(address) view returns (bool)',
  'error SameAsset()',
  'error ZeroAmount()',
  'error RouterNotAllowed(address router)',
  'error InvalidFlashLoan()',
  'error InsufficientOutput(uint256 received, uint256 minOut)',
  'error ExcessiveInput(uint256 spent, uint256 maxIn)',
  'error SellExceedsWithdrawn(uint256 toSell, uint256 withdrawn)',
  'error InsufficientToRepayFlashLoan(uint256 balance, uint256 owed)',
  'error ZeroAddress()',
  'error InvalidRouter(address router)',
])

const step = '(address router, address tokenOut, bytes data, uint256 minOut)'
const guard = '(uint256 minHealthFactor, uint256 deadline)'
const openV2 = `(address collateralAsset, address debtAsset, address capitalToken, uint256 capitalAmount, ${step}[] capitalSteps, uint256 debtAmount, ${step}[] steps, ${guard} guard)`
const closeV2 = `(address collateralAsset, address debtAsset, uint256 repayAmount, uint256 collateralToWithdraw, uint256 collateralToSell, ${step}[] steps, address flashLender, ${guard} guard)`
const swapCollV2 = `(address fromAsset, address toAsset, uint256 fromAmount, uint256 toAmount, ${step}[] steps, address flashLender, ${guard} guard)`
const swapCollResult = '(uint256 withdrawn, uint256 supplied, uint256 flashPremium, uint256 healthFactor)'
const swapDebtV2 = `(address fromAsset, address toAsset, uint256 newDebtAmount, uint256 minRepaid, ${step}[] steps, ${guard} guard)`
const swapDebtResult = '(uint256 repaid, uint256 borrowed, uint256 returned, uint256 healthFactor)'
const closeResult =
  '(uint256 debtRepaid, uint256 collateralWithdrawn, uint256 collateralReturned, uint256 debtReturned, uint256 flashPremium, uint256 healthFactor)'

/** LeverageExecutorV2, deployed by the app. */
export const executorAbi = parseAbi([
  'constructor(address pool, address[] routers, (uint8 kind, address lender)[] lenders)',
  'function POOL() view returns (address)',
  `function open(${openV2} p) returns (uint256 collateralSupplied, uint256 debtBorrowed, uint256 healthFactor)`,
  `function openWithSig(${openV2} p, ${sig} delegation) returns (uint256 collateralSupplied, uint256 debtBorrowed, uint256 healthFactor)`,
  `function close(${closeV2} p) returns (${closeResult})`,
  `function closeWithSig(${closeV2} p, ${sig} aTokenPermit) returns (${closeResult})`,
  `function swapCollateral(${swapCollV2} p) returns (${swapCollResult})`,
  `function swapCollateralWithSig(${swapCollV2} p, ${sig} aTokenPermit) returns (${swapCollResult})`,
  `function swapDebt(${swapDebtV2} p) returns (${swapDebtResult})`,
  `function swapDebtWithSig(${swapDebtV2} p, ${sig} delegation) returns (${swapDebtResult})`,
  'function isRouterAllowed(address) view returns (bool)',
  'function flashLenderKind(address) view returns (uint8)',
  'error ZeroAddress()',
  'error SameAsset()',
  'error ZeroAmount()',
  'error Expired(uint256 deadline)',
  'error HealthFactorTooLow(uint256 healthFactor, uint256 minHealthFactor)',
  'error InvalidRouter(address router)',
  'error RouterNotAllowed(address router)',
  'error InvalidFlashLender(address lender)',
  'error FlashLenderNotAllowed(address lender)',
  'error CallerNotLender()',
  'error InitiatorNotSelf()',
  'error InvalidFlashLoan()',
  'error UnexpectedFlashLoan()',
  'error FlashLoanNotExecuted()',
  'error InvalidSteps()',
  'error UnexpectedSteps()',
  'error WrongFinalToken(address tokenOut, address expected)',
  'error InsufficientOutput(uint256 received, uint256 minOut)',
  'error ExcessiveInput(uint256 spent, uint256 maxIn)',
  'error SellExceedsWithdrawn(uint256 toSell, uint256 withdrawn)',
  'error InsufficientToRepayFlashLoan(uint256 balance, uint256 owed)',
  'error RepaidTooLittle(uint256 repaid, uint256 minRepaid)',
])

export const poolAbi = parseAbi([
  'struct ReserveDataLegacy { uint256 configuration; uint128 liquidityIndex; uint128 currentLiquidityRate; uint128 variableBorrowIndex; uint128 currentVariableBorrowRate; uint128 currentStableBorrowRate; uint40 lastUpdateTimestamp; uint16 id; address aTokenAddress; address stableDebtTokenAddress; address variableDebtTokenAddress; address interestRateStrategyAddress; uint128 accruedToTreasury; uint128 unbacked; uint128 isolationModeTotalDebt; }',
  'function getReserveData(address asset) view returns (ReserveDataLegacy)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getUserEMode(address user) view returns (uint256)',
  'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)',
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function getReservesList() view returns (address[])',
  'function getEModeCategoryLabel(uint8 id) view returns (string)',
  'function getEModeCategoryCollateralConfig(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus))',
  'function getEModeCategoryCollateralBitmap(uint8 id) view returns (uint128)',
  'function getEModeCategoryBorrowableBitmap(uint8 id) view returns (uint128)',
  'function getEModeCategoryLtvzeroBitmap(uint8 id) view returns (uint128)',
  // before Aave v3.2 (SparkLend): one call per category, the reserves carry their category in their configuration
  'function getEModeCategoryData(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus, address priceSource, string label))',
  'function setUserEMode(uint8 categoryId)',
])

export const providerAbi = parseAbi(['function getPriceOracle() view returns (address)'])

export const oracleAbi = parseAbi(['function getAssetsPrices(address[] assets) view returns (uint256[])'])

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
])

export const debtTokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function borrowAllowance(address fromUser, address toUser) view returns (uint256)',
  'function approveDelegation(address delegatee, uint256 amount)',
  'function name() view returns (string)',
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
])

const marketParams = '(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)'
const openMorpho = `(${marketParams} market, address capitalToken, uint256 capitalAmount, ${step}[] capitalSteps, uint256 debtAmount, ${step}[] steps, ${guard} guard)`
const closeMorpho = `(${marketParams} market, uint256 repayAmount, uint256 collateralToWithdraw, uint256 collateralToSell, ${step}[] steps, ${guard} guard)`
const rollMorpho = `(${marketParams} from, ${marketParams} to, uint256 repayAmount, uint256 collateralToMove, ${step}[] steps, ${guard} guard)`
const authSigs = '(uint256 nonce, uint256 deadline, (uint8 v, bytes32 r, bytes32 s) grant, (uint8 v, bytes32 r, bytes32 s) revoke)'
const closeMorphoResult = '(uint256 debtRepaid, uint256 collateralWithdrawn, uint256 collateralReturned, uint256 loanReturned, uint256 healthFactor)'
const rollMorphoResult = '(uint256 debtRepaid, uint256 collateralWithdrawn, uint256 collateralSupplied, uint256 debtBorrowed, uint256 healthFactor)'

/** LeverageExecutorMorpho: the same swap steps against Morpho Blue markets, deployed by the app (one per chain). */
/** LeverageExecutorMorpho.refinance: Aave v3 <-> Morpho, same pair, no swap */
const refinanceMorpho = `(address pool, ${marketParams} market, bool toMorpho, uint256 debtAmount, uint256 collateralAmount, (uint256 minHealthFactor, uint256 deadline) guard)`
const refinanceResult = '(uint256 debtMoved, uint256 collateralMoved, uint256 healthFactor)'

export const morphoExecutorAbi = parseAbi([
  'constructor(address morpho, address[] routers, address[] aavePools)',
  'function MORPHO() view returns (address)',
  'function isAavePool(address) view returns (bool)',
  `function refinance(${refinanceMorpho} p) returns (${refinanceResult})`,
  `function refinanceWithAuth(${refinanceMorpho} p, ${authSigs} auth, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) aaveSig) returns (${refinanceResult})`,
  `event Refinanced(address indexed user, address indexed pool, bytes32 indexed marketId, bool toMorpho, ${refinanceResult} result)`,
  'error PoolNotAllowed(address pool)',
  `function open(${openMorpho} p) returns (uint256 collateralSupplied, uint256 debtBorrowed, uint256 healthFactor)`,
  `function openWithAuth(${openMorpho} p, ${authSigs} auth) returns (uint256 collateralSupplied, uint256 debtBorrowed, uint256 healthFactor)`,
  `function close(${closeMorpho} p) returns (${closeMorphoResult})`,
  `function closeWithAuth(${closeMorpho} p, ${authSigs} auth) returns (${closeMorphoResult})`,
  `function roll(${rollMorpho} p) returns (${rollMorphoResult})`,
  `function rollWithAuth(${rollMorpho} p, ${authSigs} auth) returns (${rollMorphoResult})`,
  `function healthFactor(${marketParams} market, address user) view returns (uint256)`,
  'function isRouterAllowed(address) view returns (bool)',
  `event PositionOpened(address indexed user, bytes32 indexed marketId, address capitalToken, uint256 capitalAmount, uint256 collateralSupplied, uint256 debtBorrowed, uint256 healthFactor)`,
  `event PositionClosed(address indexed user, bytes32 indexed marketId, ${closeMorphoResult} result)`,
  `event PositionRolled(address indexed user, bytes32 indexed fromId, bytes32 indexed toId, ${rollMorphoResult} result)`,
  'event Swapped(address indexed user, address indexed router, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
  'error ZeroAddress()',
  'error SameAsset()',
  'error SameMarket()',
  'error LoanTokenMismatch()',
  'error ZeroAmount()',
  'error Expired(uint256 deadline)',
  'error HealthFactorTooLow(uint256 healthFactor, uint256 minHealthFactor)',
  'error InvalidRouter(address router)',
  'error RouterNotAllowed(address router)',
  'error CallerNotLender()',
  'error UnexpectedFlashLoan()',
  'error FlashLoanNotExecuted()',
  'error InvalidSteps()',
  'error UnexpectedSteps()',
  'error WrongFinalToken(address tokenOut, address expected)',
  'error InsufficientOutput(uint256 received, uint256 minOut)',
  'error ExcessiveInput(uint256 spent, uint256 maxIn)',
  'error SellExceedsWithdrawn(uint256 toSell, uint256 withdrawn)',
  'error InsufficientToRepayFlashLoan(uint256 balance, uint256 owed)',
  'error AuthorizationNotRevoked()',
])

/** Morpho Blue (the singleton), the reads and the authorization the app uses. */
export const morphoAbi = parseAbi([
  `function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)`,
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function isAuthorized(address authorizer, address authorized) view returns (bool)',
  'function nonce(address authorizer) view returns (uint256)',
  'function setAuthorization(address authorized, bool newIsAuthorized)',
])

export const morphoOracleAbi = parseAbi(['function price() view returns (uint256)'])

/** Morpho's AdaptiveCurveIrm (and any IRM with the same view): borrow rate per second, WAD. */
export const morphoIrmAbi = parseAbi([
  `function borrowRateView(${marketParams} marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)`,
])

/** Aave v3.2+ DefaultReserveInterestRateStrategyV2: rate curve of a reserve, in bps */
export const rateStrategyAbi = parseAbi([
  'struct InterestRateDataRay { uint16 optimalUsageRatio; uint32 baseVariableBorrowRate; uint32 variableRateSlope1; uint32 variableRateSlope2; }',
  'function getInterestRateDataBps(address reserve) view returns (InterestRateDataRay)',
])
