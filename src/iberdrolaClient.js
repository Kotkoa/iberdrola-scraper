/**
 * @typedef {Object} ScheduleType
 * @property {string|null} scheduleTypeDesc
 * @property {string|null} scheduleTypeId
 */

/**
 * @typedef {Object} ChargingPointStatus
 * @property {string|null} statusCode
 * @property {string|null} updateDate
 * @property {number} statusId
 */

/**
 * @typedef {Object} SocketType
 * @property {string|null} socketTypeId
 * @property {string|null} socketName
 */

/**
 * @typedef {Object} PhysicalSocket
 * @property {number|null} maxPower
 * @property {SocketType} socketType
 * @property {string|null} status
 * @property {number} physicalSocketId
 */

/**
 * @typedef {Object} LogicalSocket
 * @property {number} logicalSocketId
 * @property {ChargingPointStatus|null} status
 * @property {PhysicalSocket[]} physicalSocket
 * @property {string|null} evseId
 * @property {number} chargeSpeedId
 */

/**
 * @typedef {Object} LocationData
 * @property {string} cuprName
 * @property {ScheduleType|null} scheduleType
 * @property {number} cuprId
 * @property {number} latitude
 * @property {number} longitude
 * @property {string|null} situationCode
 */

/**
 * @typedef {Object} ChargingPoint
 * @property {number} cpId
 * @property {LocationData} locationData
 * @property {LogicalSocket[]} logicalSocket
 * @property {ChargingPointStatus} cpStatus
 * @property {number} socketNum
 * @property {boolean} advantageous
 */

/**
 * @typedef {Object} IberdrolaResponse
 * @property {ChargingPoint[]} entidad
 * @property {boolean} seguro
 * @property {string|null} errorAjax
 * @property {any} errores
 * @property {any} serviceException
 */

const ENDPOINT =
  'https://www.iberdrola.es/o/webclipb/iberdrola/puntosrecargacontroller/getDatosPuntoRecarga'

const DEFAULT_TIMEOUT = 15000

async function fetchWithTimeout(url, options = {}, timeout = DEFAULT_TIMEOUT) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

const USER_AGENT =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const REFERER =
  process.env.REFERER ||
  'https://www.iberdrola.es/en/electric-mobility/recharge-outside-the-house'

const ORIGIN = process.env.ORIGIN || 'https://www.iberdrola.es'

/**
 * Build request body for Iberdrola API
 * @param {number} cuprId
 * @param {string} [language]
 * @returns {{dto: {cuprId: number[]}, language: string}}
 */
const buildBody = (cuprId, language = 'en') => ({
  dto: { cuprId: [cuprId] },
  language,
})

/**
 * Build request headers for Iberdrola API
 * @returns {Record<string,string>}
 */
const buildHeaders = () => ({
  'content-type': 'application/json',
  accept: 'application/json, text/javascript, */*; q=0.01',
  'accept-language': 'en-US,en;q=0.9',
  referer: REFERER,
  origin: ORIGIN,
  'user-agent': USER_AGENT,
  'x-requested-with': 'XMLHttpRequest',
})

/**
 * Executes an async function with retry logic on failure.
 * Uses exponential backoff: each retry waits delay * (attempt + 1) milliseconds.
 * @template T
 * @param {() => Promise<T>} fn - async function to execute
 * @param {number} [attempts=3] - number of retry attempts (must be >= 1)
 * @param {number} [delay=500] - base delay between retries in milliseconds
 * @returns {Promise<T>} resolved value from fn on success
 * @throws {Error} if all attempts are exhausted or fn throws
 */
async function withRetry(fn, attempts = 3, delay = 500) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      console.error(`Attempt ${i + 1} failed`, err)
      if (i === attempts - 1) throw err
      await new Promise((r) => setTimeout(r, delay * (i + 1)))
    }
  }

  throw new Error('withRetry: exhausted all attempts')
}

/**
 * Fetch charging point data from Iberdrola API
 * @param {number} cuprId - charging point ID
 * @param {number} attempts - number of retry attempts
 * @returns {Promise<IberdrolaResponse|null>}
 */
async function fetchDatos(cuprId, attempts = 3) {
  const body = buildBody(cuprId)
  const headers = buildHeaders()

  try {
    return await withRetry(
      async () => {
        const res = await fetchWithTimeout(ENDPOINT, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })

        if (!res.ok) {
          const txt = await res.text()
          throw new Error(`HTTP ${res.status}: ${txt.slice(0, 500)}`)
        }

        return res.json()
      },
      attempts,
      500
    )
  } catch (err) {
    console.error('fetchDatos failed after retries', err)
    return null
  }
}

module.exports = {
  fetchDatos,
  buildBody,
  buildHeaders,
  withRetry,
  fetchWithTimeout,
}
