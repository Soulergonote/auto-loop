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
