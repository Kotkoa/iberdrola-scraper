const {
  assertConfig,
  upsertRow,
  buildFullAddress,
  truncateError,
} = require('./supabaseService')
const { fetchStationsInBoundingBox } = require('./geoSearchClient')

const MAX_RADIUS_KM = 25
const KM_PER_DEGREE_LAT = 111

/**
 * @typedef {Object} BoundingBox
 * @property {number} latMin
 * @property {number} latMax
 * @property {number} lonMin
 * @property {number} lonMax
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {string|null} reason
 */

/**
 * Validate bounding box inputs
 * @param {BoundingBox} bbox
 * @returns {ValidationResult}
 */
function validateInputs(bbox) {
  const { latMin, latMax, lonMin, lonMax } = bbox

  if ([latMin, latMax, lonMin, lonMax].some(isNaN)) {
    return { valid: false, reason: 'Invalid number in coordinates' }
  }

  if (latMin >= latMax) {
    return { valid: false, reason: 'lat_min must be less than lat_max' }
  }

  if (lonMin >= lonMax) {
    return { valid: false, reason: 'lon_min must be less than lon_max' }
  }

  if (latMin < -90 || latMax > 90) {
    return { valid: false, reason: 'Latitude must be between -90 and 90' }
  }

  if (lonMin < -180 || lonMax > 180) {
    return { valid: false, reason: 'Longitude must be between -180 and 180' }
  }

  const latDeltaKm = (latMax - latMin) * KM_PER_DEGREE_LAT
  const centerLat = (latMin + latMax) / 2
  const lonDeltaKm =
    (lonMax - lonMin) * KM_PER_DEGREE_LAT * Math.cos((centerLat * Math.PI) / 180)

  if (latDeltaKm > MAX_RADIUS_KM * 2 || lonDeltaKm > MAX_RADIUS_KM * 2) {
    return {
      valid: false,
      reason: `Bounding box exceeds maximum size of ${MAX_RADIUS_KM}km radius`,
    }
  }

  return { valid: true, reason: null }
}

/**
 * Build station metadata payload for upsert
 * @param {import('./geoSearchClient').GeoSearchStation} station
 * @returns {Object}
 */
function buildStationPayload(station) {
  return {
    cp_id: station.cpId,
    cupr_id: station.locationData?.cuprId ?? null,
    name: station.locationData?.cuprName ?? null,
    latitude: station.locationData?.latitude ?? null,
    longitude: station.locationData?.longitude ?? null,
    address_full: buildFullAddress(
      station.locationData?.supplyPointData?.cpAddress ?? null
    ),
    overall_status: station.cpStatus?.statusCode ?? null,
    total_ports: station.socketNum ?? null,
    situation_code: station.locationData?.situationCode ?? null,
    updated_at: new Date().toISOString(),
  }
}

/**
 * Main orchestrator: fetches stations by bounding box and persists to Supabase
 * @returns {Promise<void>}
 */
async function main() {
  assertConfig()

  const bbox = {
    latMin: parseFloat(process.env.LAT_MIN),
    latMax: parseFloat(process.env.LAT_MAX),
    lonMin: parseFloat(process.env.LON_MIN),
    lonMax: parseFloat(process.env.LON_MAX),
  }

  const validation = validateInputs(bbox)
  if (!validation.valid) {
    console.error('VALIDATION FAILED:', validation.reason)
    process.exitCode = 1
    return
  }

  console.log('Searching stations in bounding box:', bbox)

  const stations = await fetchStationsInBoundingBox(bbox)
  if (stations === null) {
    console.error('API request failed')
    process.exitCode = 1
    return
  }

  console.log(`Found ${stations.length} stations`)

  if (stations.length === 0) {
    console.log('No stations found in this area')
    return
  }

  const payloads = stations.map(buildStationPayload)

  const { error } = await upsertRow('station_metadata', payloads, 'cp_id')

  if (error) {
    console.error('Batch upsert error:', truncateError(error))
    console.log(`Completed: 0 stations upserted, ${payloads.length} errors`)
  } else {
    console.log(`Completed: ${payloads.length} stations upserted, 0 errors`)
  }

  if (error) {
    process.exitCode = 1
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('UNHANDLED ERROR:', err)
    process.exitCode = 1
  })
}

module.exports = { validateInputs, buildStationPayload, MAX_RADIUS_KM, KM_PER_DEGREE_LAT }
