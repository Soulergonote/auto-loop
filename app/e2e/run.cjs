// Drives the app in headless Chromium with a test wallet that forwards to anvil (account 1, unlocked).
//   node e2e/run.cjs open ouvrir     open 1 WETH at 3x against USDC
//   node e2e/run.cjs close50 f50    repay 50 %
//   node e2e/run.cjs close fermer   close everything
//   node e2e/run.cjs deploy deployer deploy the contract from the test wallet with the app's button
// EXECUTOR=0x… preloads an executor as if deployed from this browser (app built without VITE_EXECUTORS).
// Writes <prefix>-avant.png / <prefix>-apres.png and prints the notices. Needs playwright (NODE_PATH=$(npm root -g)).
const { chromium } = require('playwright')
const [,, mode, outPrefix] = process.argv
const U = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1100, height: 1500 } })
  page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 300)) })
  if (process.env.EXECUTOR) await page.addInitScript((a) => localStorage.setItem('auto-loop.executors', JSON.stringify({ base: a })), process.env.EXECUTOR)
  await page.addInitScript((U) => {
    let id = 0
    const rpc = async (method, params) => {
      const r = await fetch('http://127.0.0.1:8545', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }) })
      const j = await r.json()
      if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e }
      return j.result
    }
    window.__calls = []
    window.ethereum = {
      isMetaMask: true,
      on() {}, removeListener() {},
      async request({ method, params }) {
        window.__calls.push(method)
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [U]
        if (method === 'eth_chainId') return '0x2105'
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_requestPermissions') return null
        return rpc(method, params)
      },
    }
  }, U)
  await page.goto(process.env.APP_URL || 'http://localhost:5173/')
  await page.getByText('Connecter le portefeuille').click()
  await page.waitForSelector('table.reserves', { timeout: 30000 })
  if (mode === 'deploy') {
    await page.getByText('Déployer le contrat sur Base').click()
    await page.waitForSelector('text=Contrat Auto-loop vérifié', { timeout: 60000 }).catch(() => {})
    await page.screenshot({ path: `${outPrefix}-apres.png`, fullPage: true })
    console.log('verified line:', await page.locator('text=Contrat Auto-loop vérifié').allTextContents())
    console.log('notices:', (await page.locator('.notice').allTextContents()).join(' | '))
    console.log('saved:', await page.evaluate(() => localStorage.getItem('auto-loop.executors')))
    return browser.close()
  }
  if (mode.startsWith('close')) await page.getByText('Fermer / réduire').click()
  if (mode === 'close50') { await page.waitForTimeout(3000); await page.locator('button', { hasText: /^50\s*%$/ }).first().click() }
  if (mode === 'open') {
    await page.locator('input[inputmode=decimal]').fill('1')
    await page.locator('input[type=range]').fill('3')
  }
  await page.waitForTimeout(8000)
  await page.screenshot({ path: `${outPrefix}-avant.png`, fullPage: true })
  const btn = page.locator('button.btn.primary')
  console.log('button:', await btn.textContent(), 'enabled:', await btn.isEnabled(), 'title:', await btn.getAttribute('title'))
  console.log('notices:', (await page.locator('.notice').allTextContents()).join(' | '))
  if (await btn.isEnabled()) {
    await btn.click()
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(1000)
      const t = await page.locator('main, .page').first().innerText()
      if (/Position ouverte|Position fermée|réussi|Transaction incluse|0x[0-9a-f]{64}|échoué|Erreur|Revert/i.test(t) && i > 3) break
    }
    await page.screenshot({ path: `${outPrefix}-apres.png`, fullPage: true })
    console.log('wallet calls:', [...new Set(await page.evaluate(() => window.__calls))].join(','))
    console.log('notices after:', (await page.locator('.notice').allTextContents()).join(' | '))
  }
  await browser.close()
})()
