// @ts-nocheck
const { chromium } = require('playwright')

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-sandbox',
      '--disable-site-isolation-trials',
    ],
  })

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  })

  const page = await context.newPage()

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] })
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    })

    window.chrome = { runtime: {} }

    const originalQuery = navigator.permissions.query
    navigator.permissions.query = (p) =>
      p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(p)
  })

  await page.goto(
    'https://www.iberdrola.es/en/electric-mobility/recharge-outside-the-house',
    { waitUntil: 'domcontentloaded', timeout: 60000 }
  )

  await page.waitForLoadState('load')
  await page.waitForTimeout(1000)

  await page.screenshot({ path: 'loaded-page.png', fullPage: true })
  console.log('PAGE LOADED')

  try {
    await page.waitForSelector('#onetrust-accept-btn-handler', {
      timeout: 5000,
    })
    await page.click('#onetrust-accept-btn-handler')
    console.log('COOKIES ACCEPTED')
    await page.waitForTimeout(1200)
  } catch {
    console.log('NO COOKIES BANNER')
  }

  await page.waitForSelector('#ship-address', { timeout: 30000 })

  const address = 'Passeig Cervantes, 10, Pego, Spain'
  await page.fill('#ship-address', address)

  await page.waitForTimeout(600)

  // wait for Google Places suggestions and click the most relevant one
  const suggestions = page.locator('.pac-item')
  await suggestions.first().waitFor({ state: 'visible', timeout: 7000 })

  const matchingSuggestion = suggestions.filter({ hasText: 'Passeig Cervantes' })
  if ((await matchingSuggestion.count()) > 0) {
    await matchingSuggestion.first().click()
  } else {
    await suggestions.first().click()
  }

  console.log('AUTOCOMPLETE SELECTED')

  await page.waitForTimeout(1800)
  await page.screenshot({ path: 'autocomplete-clicked.png' })

  console.log('DONE')

  await browser.close()
})()
