/**
 * @typedef {Object} GeoSearchBoundingBox
 * @property {number} latMin - Minimum latitude
 * @property {number} latMax - Maximum latitude
 * @property {number} lonMin - Minimum longitude
 * @property {number} lonMax - Maximum longitude
 */

/**
 * @typedef {Object} GeoSearchCpAddress
 * @property {string|null} streetName
 * @property {string|null} streetNum
 * @property {string|null} townName
 * @property {string|null} regionName
 */

/**
 * @typedef {Object} GeoSearchSupplyPointData
 * @property {GeoSearchCpAddress|null} cpAddress
 */

/**
 * @typedef {Object} GeoSearchLocationData
 * @property {number} cuprId
 * @property {string} cuprName
 * @property {number} latitude
 * @property {number} longitude
 * @property {string|null} situationCode
 * @property {GeoSearchSupplyPointData|null} supplyPointData
 */

/**
 * @typedef {Object} GeoSearchCpStatus
 * @property {string|null} statusCode
 */

/**
 * @typedef {Object} GeoSearchStation
 * @property {number} cpId
 * @property {GeoSearchLocationData} locationData
 * @property {GeoSearchCpStatus|null} cpStatus
 * @property {number} socketNum
 */

/**
 * @typedef {Object} GeoSearchResponse
 * @property {GeoSearchStation[]} entidad
 * @property {boolean} seguro
 * @property {string|null} errorAjax
 */

const { buildHeaders, fetchWithTimeout, withRetry } = require('./iberdrolaClient')

const GEO_SEARCH_ENDPOINT =
  'https://www.iberdrola.es/o/webclipb/iberdrola/puntosrecargacontroller/getListarPuntosRecarga'

/**
 * Build request body for geo search API
 * @param {GeoSearchBoundingBox} bbox
 * @returns {Object}
 */
function buildGeoSearchBody(bbox) {
  return {
    dto: {
      chargePointTypesCodes: ['P', 'R', 'I', 'N'],
      socketStatus: [],
      advantageous: false,
      connectorsType: [],
      loadSpeed: [],
      latitudeMax: bbox.latMax,
      latitudeMin: bbox.latMin,
      longitudeMax: bbox.lonMax,
      longitudeMin: bbox.lonMin,
    },
    language: 'en',
  }
}

/**
 * Validate geo search API response structure
 * @param {any} data
 * @returns {{valid: boolean, reason: string|null}}
 */
function validateGeoSearchResponse(data) {
  if (!data) {
    return { valid: false, reason: 'Response is null or undefined' }
  }

  if (!Array.isArray(data.entidad)) {
    return { valid: false, reason: 'entidad is not an array' }
  }

  return { valid: true, reason: null }
}

/**
 * Fetch stations in bounding box from Iberdrola API
 * @param {GeoSearchBoundingBox} bbox
 * @returns {Promise<GeoSearchStation[]|null>} - Array of stations or null on error
 */
async function fetchStationsInBoundingBox(bbox) {
  const body = buildGeoSearchBody(bbox)
  const headers = buildHeaders()

  try {
    const response = await withRetry(
      async () => {
        const res = await fetchWithTimeout(GEO_SEARCH_ENDPOINT, {
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
      3,
      500
    )

    const validation = validateGeoSearchResponse(response)
    if (!validation.valid) {
      console.error('Geo search response validation failed:', validation.reason)
      return null
    }

    return response.entidad
  } catch (err) {
    console.error('fetchStationsInBoundingBox failed after retries:', err.message)
    return null
  }
}

module.exports = {
  fetchStationsInBoundingBox,
  buildGeoSearchBody,
  validateGeoSearchResponse,
  GEO_SEARCH_ENDPOINT,
}
