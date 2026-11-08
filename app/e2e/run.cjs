// Drives the app in headless Chromium with a test wallet that forwards to anvil (account 1, unlocked).
//   node e2e/run.cjs open ouvrir     open 1 WETH at 3x against USDC
//   node e2e/run.cjs increase aug   lever the existing position to 4x without new capital
//   node e2e/run.cjs reduce r2      reduce the position to 2x (target leverage slider)
//   node e2e/run.cjs close fermer   close everything
//   node e2e/run.cjs deploy deployer deploy the contract from the test wallet with the app's button
//   USER_ADDR=0x… node e2e/run.cjs reinvest rei   claim that account's Merkl rewards, swap them, open "Augmenter"
// USER_ADDR=0x… acts as that account (impersonated on anvil, funded for gas); Merkl's API is fetched from node
// (its CORS only allows the deployed site).
// EXECUTOR=0x… preloads an executor as if deployed from this browser (app built without VITE_EXECUTORS).
// Writes <prefix>-avant.png / <prefix>-apres.png and prints the notices. Needs playwright (NODE_PATH=$(npm root -g)).
const { chromium } = require('playwright')
const [, , mode, outPrefix] = process.argv
const U = process.env.USER_ADDR || '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const anvil = async (method, params) =>
  (
    await fetch('http://127.0.0.1:8545', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  ).json()
;(async () => {
  if (process.env.USER_ADDR) {
    await anvil('anvil_impersonateAccount', [U])
    await anvil('anvil_setBalance', [U, '0x56BC75E2D63100000'])
  }
  const browser = await chromium.launch()
  const page = await browser.newPage(
    process.env.MOBILE
      ? { viewport: { width: 390, height: 1400 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { viewport: { width: 1100, height: 1500 } },
  )
  // anvil forwards eth_getLogs (7/30-day rates) upstream, where public RPCs rate-limit them: they hang for minutes and
  // slow the whole fork. Fail them at once; the page then just shows no averages.
  await page.route('http://127.0.0.1:8545/**', (route) => {
    const body = route.request().postData() ?? ''
    if (!body.includes('eth_getLogs')) return route.continue()
    const one = (r) => ({ jsonrpc: '2.0', id: r.id, error: { code: -32005, message: 'getLogs disabled in e2e' } })
    const req = JSON.parse(body)
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(Array.isArray(req) ? req.map(one) : one(req)),
    })
  })
  await page.route('https://api.merkl.xyz/**', async (route) => {
    try {
      const r = await fetch(route.request().url())
      await route.fulfill({ status: r.status, body: await r.text(), headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } })
    } catch {
      await route.abort()
    }
  })
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('console:', m.text().slice(0, 300))
  })
  if (process.env.EXECUTOR) await page.addInitScript((a) => localStorage.setItem('auto-loop.executors', JSON.stringify({ base: a })), process.env.EXECUTOR)
  await page.addInitScript(
    ([U, BATCH]) => {
      let id = 0
      const rpc = async (method, params) => {
        const r = await fetch('http://127.0.0.1:8545', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }),
        })
        const j = await r.json()
        if (j.error) {
          const e = new Error(j.error.message)
          e.code = j.error.code
          e.data = j.error.data
          throw e
        }
        return j.result
      }
      window.__calls = []
      window.ethereum = {
        isMetaMask: true,
        on() {},
        removeListener() {},
        async request({ method, params }) {
          window.__calls.push(method)
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [U]
          if (method === 'eth_chainId') return '0x2105'
          if (method === 'wallet_switchEthereumChain' || method === 'wallet_requestPermissions') return null
          // BATCH=1: an EIP-5792 wallet that sends a batch atomically (the calls one by one, all undone if one fails)
          if (method === 'wallet_getCapabilities') {
            if (!BATCH) throw Object.assign(new Error('Method not supported'), { code: 4200 })
            return { '0x2105': { atomic: { status: 'supported' } } }
          }
          if (method === 'wallet_sendCalls') {
            const { calls } = params[0]
            window.__batch = calls.length
            const snap = await rpc('evm_snapshot')
            const receipts = []
            let ok = true
            for (const c of calls) {
              const hash = await rpc('eth_sendTransaction', [{ from: U, to: c.to, data: c.data, value: c.value }]).catch(() => null)
              let r = null
              for (let i = 0; hash && !r && i < 120; i++) {
                r = await rpc('eth_getTransactionReceipt', [hash])
                if (!r) {
                  await new Promise((res) => setTimeout(res, 1000))
                  if (i % 5 === 4) await rpc('evm_mine')
                }
              }
              if (!r || r.status !== '0x1') {
                ok = false
                break
              }
              receipts.push(r)
            }
            if (!ok) await rpc('evm_revert', [snap])
            const id = '0x' + Date.now().toString(16).padStart(64, '0')
            window.__bundles = { ...window.__bundles, [id]: { ok, receipts: ok ? receipts : [] } }
            return { id }
          }
          if (method === 'wallet_getCallsStatus') {
            const b = window.__bundles?.[params[0]]
            return { version: '2.0.0', id: params[0], chainId: '0x2105', atomic: true, status: b.ok ? 200 : 500, receipts: b.receipts }
          }
          return rpc(method, params)
        },
      }
    },
    [U, !!process.env.BATCH],
  )
  await page.goto(process.env.APP_URL || 'http://localhost:5173/')
  await page.getByText('Connecter le portefeuille').click()
  await page.waitForSelector('.summary', { timeout: 30000 })
  if (mode === 'deploy') {
    await page.getByText('Déployer le contrat sur Base').click()
    await page.waitForSelector('text=Contrat Auto-loop absent', { state: 'detached', timeout: 60000 }).catch(() => {})
    await page.screenshot({ path: `${outPrefix}-apres.png`, fullPage: true })
    console.log('verified line:', await page.locator('p:has-text("Contrat Auto-loop vérifié")').allTextContents())
    console.log('notices:', (await page.locator('.notice').allTextContents()).join(' | '))
    console.log('saved:', await page.evaluate(() => localStorage.getItem('auto-loop.executors')))
    return browser.close()
  }
  if (mode === 'reinvest') return reinvest(page, browser)
  // AGG=Velora|KyberSwap forces one aggregator instead of the best-price comparison
  if (mode.startsWith('close') || mode === 'reduce') await page.getByRole('radio', { name: 'Fermer / réduire' }).click()
  // the aggregator lives in the collapsed "Réglages" block
  if (process.env.AGG) {
    await page.locator('summary', { hasText: 'Réglages' }).click()
    await page.getByRole('radio', { name: process.env.AGG }).click()
  }
  if (mode === 'reduce') {
    await page.waitForTimeout(3000)
    await page.locator('input[type=range]').first().fill('2')
  }
  // CAPITAL=USDC|wstETH (v2): the capital token, AMOUNT its amount (default 1, or 0 for "increase")
  if ((mode === 'open' || mode === 'increase') && process.env.CAPITAL) {
    const sel = page.locator('select[aria-label="Token du capital"]')
    await sel.waitFor({ timeout: 30000 })
    await sel.selectOption({ label: process.env.CAPITAL })
  }
  if (mode === 'open') {
    await page.locator('input[inputmode=decimal]').fill(process.env.AMOUNT || '1')
    await page.locator('input[type=range]').fill('3')
  }
  if (mode === 'increase') {
    await page.waitForSelector('h2:has-text("Augmenter la position")', { timeout: 30000 })
    await page.locator('input[inputmode=decimal]').fill(process.env.AMOUNT || '0')
    await page.locator('input[type=range]').fill('4')
  }
  await page.waitForTimeout(8000)
  await page.screenshot({ path: `${outPrefix}-avant.png`, fullPage: true })
  const btn = page.locator('button.btn.primary')
  console.log('button:', await btn.textContent(), 'enabled:', await btn.isEnabled(), 'title:', await btn.getAttribute('title'))
  console.log('notices:', (await page.locator('.notice').allTextContents()).join(' | '))
  console.log('metrics:', (await page.locator('.metric, .sum-item').allInnerTexts()).map((t) => t.replace(/\n/g, ' ')).join(' | '))
  console.log('quotes:', (await page.locator('p:has-text("Devis comparés")').allTextContents()).join(' | '))
  if (process.env.CAPITAL) {
    await page.locator('summary', { hasText: 'Devis' }).click()
    console.log('quote lines:', (await page.locator('p:has-text("Capital :"), p:has-text("Emprunt :")').allTextContents()).join(' | '))
    console.log('steps:', (await page.locator('.steps li, ol li').allTextContents()).join(' | '))
    // closed again: its calldata would look like a transaction hash to the wait below
    await page.locator('summary', { hasText: 'Devis' }).click()
  }
  console.log('reason:', (await page.locator('.sum-reason').allTextContents()).join(' | '))
  if (await btn.isEnabled()) {
    await btn.click()
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(1000)
      const t = await page.locator('main, .page').first().innerText()
      if (
        /Position ouverte|Position augmentée|Position réduite|Position fermée|réussi|Transaction incluse|0x[0-9a-f]{64}|échoué|Erreur|Revert/i.test(t) &&
        i > 3
      )
        break
    }
    await page.screenshot({ path: `${outPrefix}-apres.png`, fullPage: true })
    console.log('wallet calls:', [...new Set(await page.evaluate(() => window.__calls))].join(','))
    console.log('notices after:', (await page.locator('.notice, .success').allTextContents()).join(' | '))
  }
  await browser.close()
})()

async function reinvest(page, browser) {
  await page.getByRole('radio', { name: 'Réinvestir' }).click({ timeout: 60000 })
  const btn = page.locator('button.btn.primary')
  const log = async (tag) => {
    console.log(tag, 'button:', await btn.textContent(), 'enabled:', await btn.isEnabled())
    console.log('  reason:', (await page.locator('.sum-reason').allTextContents()).join(' | '))
    console.log('  summary:', (await page.locator('.sum-item').allInnerTexts()).map((t) => t.replace(/\n/g, ' ')).join(' | '))
    console.log('  notices:', (await page.locator('.notice, .success').allTextContents()).join(' | '))
    for (const v of globalThis.__inflight?.values() ?? []) console.log('  in flight', Date.now() - v.t0, 'ms', v.methods)
  }
  if (process.env.SLIP) {
    await page.locator('summary', { hasText: 'Réglages' }).click()
    await page.getByRole('radio', { name: process.env.SLIP }).click()
  }
  if (process.env.OPEN_STEPS) await page.locator('summary', { hasText: 'Étapes' }).click()
  for (let step = 0; step < 8; step++) {
    // wait for the button to be ready (rewards read, quote fetched)
    for (let i = 0; i < 150 && !(await btn.isEnabled()); i++) await page.waitForTimeout(1000)
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `${outPrefix}-${step}.png`, fullPage: true })
    await log(`step ${step}`)
    const text = await btn.textContent()
    if (!(await btn.isEnabled())) break
    await btn.click()
    if (/Augmenter la position/.test(text)) {
      await page.waitForTimeout(8000)
      console.log('open tab capital:', await page.locator('input[inputmode=decimal]').inputValue())
      console.log('open tab leverage:', await page.locator('input[type=range]').first().inputValue())
      console.log('open tab notices:', (await page.locator('.notice').allTextContents()).join(' | '), '/ button:', await btn.textContent())
      await page.screenshot({ path: `${outPrefix}-augmenter.png`, fullPage: true })
      break
    }
    // busy labels end with "…" (simulation, wallet, inclusion)
    for (let i = 0; i < 300; i++) {
      await page.waitForTimeout(1000)
      const t = await btn.textContent()
      if (i % 10 === 0) console.log('  ', i, 's:', t)
      if (!t.endsWith('…') && i > 2) break
      // automine makes no block after the transaction's own: when the app's first receipt poll came before that block
      // was done (a swap reads many pool slots from the fork), it waits for a next block forever. A live chain has one.
      if (i % 5 === 4) await anvil('evm_mine', [])
    }
  }
  console.log('wallet calls:', [...new Set(await page.evaluate(() => window.__calls))].join(','))
  await browser.close()
}
