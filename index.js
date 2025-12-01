// @ts-nocheck
const { chromium } = require('playwright')
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

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

  page.on('requestfailed', (request) => {
    console.error('REQUEST FAILED', {
      url: request.url(),
      method: request.method(),
      error: request.failure()?.errorText,
    })
  })

  let landingResponse
  try {
    landingResponse = await page.goto(
      'https://www.iberdrola.es/en/electric-mobility/recharge-outside-the-house',
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    )
  } catch (error) {
    console.error('NAVIGATION FAILED', error)
    await browser.close()
    throw error
  }

  if (!landingResponse) {
    await browser.close()
    throw new Error('Navigation did not return a response')
  }

  const landingStatus = landingResponse.status()
  if (landingStatus >= 400) {
    const statusText = landingResponse.statusText()
    await browser.close()
    throw new Error(
      `Navigation failed with status ${landingStatus} ${statusText} for ${landingResponse.url()}`
    )
  }

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

  // Map widget is lazy-loaded and only renders the search input after scrolling it into view.
  const waitForShipAddress = async () => {
    const timeoutMs = 60000
    const pollDelay = 400
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      const inputHandle = await page.$('#ship-address')
      if (inputHandle) {
        await inputHandle.scrollIntoViewIfNeeded()
        return
      }

      await page.evaluate(() =>
        window.scrollBy(0, Math.ceil(window.innerHeight * 0.8))
      )
      await page.waitForTimeout(pollDelay)
    }

    throw new Error('ship-address input did not become available')
  }

  await waitForShipAddress()
  await page.waitForSelector('#ship-address', { timeout: 15000 })

  const address = 'Passeig Cervantes, 10, Pego, Spain'
  await page.click('#ship-address', { force: true })
  await page.fill('#ship-address', '')
  await page.type('#ship-address', address, { delay: 40 })
  await page.waitForFunction(
    (expected) => document.querySelector('#ship-address')?.value === expected,
    address
  )

  await page.waitForTimeout(600)

  // click 60px below the top edge of the input to hit the dropdown overlay reliably
  const inputBox = await page.locator('#ship-address').boundingBox()
  if (!inputBox) throw new Error('ship-address bounding box not found')
  await page.mouse.click(inputBox.x + inputBox.width / 2, inputBox.y + 60)

  // wait for Google Places suggestions and click matching entry via JS dispatch
  const waitForSuggestions = async (timeout) => {
    try {
      await page.waitForSelector('.pac-item', { state: 'visible', timeout })
      return true
    } catch {
      return false
    }
  }

  if (!(await waitForSuggestions(7000))) {
    await page.click('#ship-address')
    await page.keyboard.type(' ')
    await page.waitForTimeout(150)
    await page.keyboard.press('Backspace')
    if (!(await waitForSuggestions(5000))) {
      throw new Error('Google Places suggestions did not appear')
    }
  }
  await page.evaluate((targetText) => {
    const suggestions = Array.from(document.querySelectorAll('.pac-item'))
    const pick =
      suggestions.find((el) => el.textContent?.includes(targetText)) ||
      suggestions[0]
    if (pick) {
      pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      pick.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      pick.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
  }, 'Passeig Cervantes')

  const waitForDropdownHidden = async (timeout) => {
    try {
      await page.waitForSelector('.pac-container', { state: 'hidden', timeout })
      return true
    } catch {
      return false
    }
  }

  if (!(await waitForDropdownHidden(5000))) {
    await page.click('#ship-address')
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(120)
    await page.keyboard.press('Enter')
    if (!(await waitForDropdownHidden(5000))) {
      throw new Error('Autocomplete dropdown did not close after selection')
    }
  }

  console.log('AUTOCOMPLETE SELECTED')

  await page.waitForTimeout(2500)
  await page.screenshot({ path: 'autocomplete-clicked.png' })

  const marker = page.locator('div[role="button"][aria-label="Point 0"]')
  await marker.waitFor({ state: 'visible', timeout: 12000 })
  await marker.click({ force: true })

  console.log('MARKER CLICKED')

  const detailResponse = await page.waitForResponse(
    (response) => {
      const url = response.url()
      return (
        url.includes('getDetallePunto') || url.includes('getDatosPuntoRecarga')
      )
    },
    { timeout: 10000 }
  )

  try {
    const detailJson = await detailResponse.json()
    console.log('POINT DETAILS RESPONSE', JSON.stringify(detailJson))
  } catch (error) {
    console.log('FAILED TO PARSE POINT DETAILS RESPONSE', error)
  }

  // Save to Supabase
  try {
    const detailJson = await detailResponse.json()

    console.log('INSERTING INTO SUPABASE...')

    const { data, error } = await supabase.from('charge_logs').insert({
      cp_id: detailJson?.entidad?.[0]?.cpId || null,
      status: detailJson?.entidad?.[0]?.cpStatus?.statusCode || null,
      full_json: detailJson,
    })

    console.log('SUPABASE RESULT:', { data, error })

    if (error) {
      console.error('SUPABASE ERROR:', error)
    }
  } catch (e) {
    console.error('FAILED TO SAVE JSON TO SUPABASE', e)
  }

  // Save parsed fields into charge_logs_parsed
  const parsedDetailJson = await detailResponse.json()
  try {
    const { data, error } = await supabase.from('charge_logs_parsed').insert({
      cp_id: parsedDetailJson?.entidad?.[0]?.cpId ?? null,
      cp_name: parsedDetailJson?.entidad?.[0]?.locationData?.cuprName ?? null,
      schedule:
        parsedDetailJson?.entidad?.[0]?.locationData?.scheduleType
          ?.scheduleTypeDesc ?? null,

      port1_status:
        parsedDetailJson?.entidad?.[0]?.logicalSocket?.[0]?.status
          ?.statusCode ?? null,
      port1_power_kw:
        parsedDetailJson?.entidad?.[0]?.logicalSocket?.[0]?.physicalSocket?.[0]
          ?.maxPower ?? null,
      port1_update_date:
        parsedDetailJson?.entidad?.[0]?.logicalSocket?.[0]?.status
          ?.updateDate ?? null,

      port2_status:
        parsedDetailJson?.entidad?.[0]?.logicalSocket?.[1]?.status
          ?.statusCode ?? null,
      port2_power_kw:
        parsedDetailJson?.entidad?.[0]?.logicalSocket?.[1]?.physicalSocket?.[0]
          ?.maxPower ?? null,
      port2_update_date:
        parsedDetailJson?.entidad?.[0]?.logicalSocket?.[1]?.status
          ?.updateDate ?? null,

      overall_status:
        parsedDetailJson?.entidad?.[0]?.cpStatus?.statusCode ?? null,

      overall_update_date:
        parsedDetailJson?.entidad?.[0]?.cpStatus?.updateDate ?? null,
    })

    console.log('PARSED INSERT RESULT:', { data, error })
  } catch (e) {
    console.error('FAILED TO SAVE PARSED FIELDS', e)
  }

  console.log('DONE')

  await browser.close()
})()
