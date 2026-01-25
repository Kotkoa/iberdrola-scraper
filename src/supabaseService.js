const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || ''
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const SUPABASE_REST_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1` : ''

const SUPABASE_HEADERS = SUPABASE_KEY
  ? {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
    }
  : null

function getConfigError() {
  if (!SUPABASE_REST_URL) {
    return new Error('SUPABASE_URL is not configured')
  }

  if (!SUPABASE_HEADERS) {
    return new Error('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY is required')
  }

  return null
}

function assertConfig() {
  const error = getConfigError()
  if (error) {
    console.error('CONFIG ERROR:', error.message)
    process.exit(1)
  }
}

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

function safeJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch (err) {
    return text
  }
}

function truncateError(payload) {
  if (payload == null) return 'No response body'
  const str =
    typeof payload === 'string' ? payload : JSON.stringify(payload).slice(0, 300)
  return str.length > 300 ? `${str.slice(0, 297)}...` : str
}

async function insertRow(table, payload) {
  const configError = getConfigError()
  if (configError) {
    return { data: null, error: configError }
  }

  const url = `${SUPABASE_REST_URL}/${table}`

  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: SUPABASE_HEADERS,
      body: JSON.stringify(payload),
    })

    const text = await res.text()
    const parsed = text ? safeJsonParse(text) : null

    if (!res.ok) {
      return {
        data: null,
        error: new Error(
          `Supabase REST error ${res.status}: ${truncateError(parsed ?? text)}`
        ),
      }
    }

    return { data: parsed, error: null }
  } catch (error) {
    return { data: null, error }
  }
}

/**
 * Fetch last status for a station to enable deduplication
 * @param {number} cpId - charging point ID
 * @returns {Promise<{port1Status: string|null, port2Status: string|null, overallStatus: string|null, emergencyStopPressed: boolean|null}|null>}
 */
async function getLastStatus(cpId) {
  const configError = getConfigError()
  if (configError) return null

  const url = `${SUPABASE_REST_URL}/rpc/get_last_station_status`

  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: SUPABASE_HEADERS,
      body: JSON.stringify({ p_cp_id: cpId }),
    })

    if (!res.ok) return null

    const data = await res.json()
    if (!data || data.length === 0) return null

    const row = data[0]
    return {
      port1Status: row.port1_status,
      port2Status: row.port2_status,
      overallStatus: row.overall_status,
      emergencyStopPressed: row.emergency_stop_pressed,
    }
  } catch {
    return null
  }
}

/**
 * @typedef {Object} StatusSnapshot
 * @property {string|null} port1Status
 * @property {string|null} port2Status
 * @property {string|null} overallStatus
 * @property {boolean|null} emergencyStopPressed
 */

/**
 * Check if station status has changed
 * @param {StatusSnapshot} current - current parsed data
 * @param {StatusSnapshot|null} last - last status from DB
 * @returns {boolean}
 */
function hasStatusChanged(current, last) {
  if (!last) return true // No previous data, always insert

  return (
    current.port1Status !== last.port1Status ||
    current.port2Status !== last.port2Status ||
    current.overallStatus !== last.overallStatus ||
    current.emergencyStopPressed !== last.emergencyStopPressed
  )
}

/**
 * @typedef {Object} ScheduleType
 * @property {string|null} scheduleTypeDesc
 * @property {string|null} scheduleCodeType
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
 * @typedef {Object} AppliedRate
 * @property {{price: number, typeRate: string, finalPrice: number}|null} recharge
 * @property {{price: number, typeRate: string, finalPrice: number}|null} reservation
 */

/**
 * @typedef {Object} PhysicalSocket
 * @property {number|null} maxPower
 * @property {SocketType|null} socketType
 * @property {ChargingPointStatus|null} status
 * @property {number} physicalSocketId
 * @property {string|null} physicalSocketCode
 * @property {AppliedRate|null} appliedRate
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
 * @typedef {Object} CpAddress
 * @property {string|null} streetName
 * @property {string|null} streetNum
 * @property {string|null} townName
 * @property {string|null} regionName
 */

/**
 * @typedef {Object} SupplyPointData
 * @property {CpAddress|null} cpAddress
 */

/**
 * @typedef {Object} Operator
 * @property {string|null} operatorDesc
 */

/**
 * @typedef {Object} LocationData
 * @property {string} cuprName
 * @property {ScheduleType|null} scheduleType
 * @property {number} cuprId
 * @property {number} latitude
 * @property {number} longitude
 * @property {string|null} situationCode
 * @property {SupplyPointData|null} supplyPointData
 * @property {Operator|null} operator
 * @property {boolean|null} cuprReservationIndicator
 * @property {string|null} chargePointTypeCode
 */

/**
 * @typedef {Object} ChargingPoint
 * @property {number} cpId
 * @property {LocationData} locationData
 * @property {LogicalSocket[]} logicalSocket
 * @property {ChargingPointStatus} cpStatus
 * @property {number} socketNum
 * @property {boolean} advantageous
 * @property {string|null} serialNumber
 * @property {boolean|null} emergencyStopButtonPressed
 */

/**
 * @typedef {Object} IberdrolaResponse
 * @property {ChargingPoint[]} entidad
 * @property {boolean} seguro
 * @property {string|null} errorAjax
 * @property {any} errores
 * @property {any} serviceException
 */

/**
 * Validate Iberdrola response structure
 * @param {IberdrolaResponse} detailJson
 * @returns {{valid: boolean, reason: string|null}}
 */
function validateResponse(detailJson) {
  if (!detailJson) {
    return { valid: false, reason: 'Response is null or undefined' }
  }

  if (!Array.isArray(detailJson.entidad) || detailJson.entidad.length === 0) {
    return { valid: false, reason: 'entidad array is empty or missing' }
  }

  const first = detailJson.entidad[0]

  if (!first.cpId) {
    return { valid: false, reason: 'cpId is missing or falsy' }
  }

  if (!first.locationData?.cuprName) {
    return { valid: false, reason: 'locationData.cuprName is missing' }
  }

  if (!first.cpStatus?.statusCode) {
    return { valid: false, reason: 'cpStatus.statusCode is missing' }
  }

  if (!Array.isArray(first.logicalSocket) || first.logicalSocket.length === 0) {
    return { valid: false, reason: 'logicalSocket array is empty or missing' }
  }

  return { valid: true, reason: null }
}

/**
 * Build full address string from cpAddress components
 * @param {CpAddress|null} cpAddress
 * @returns {string|null}
 */
function buildFullAddress(cpAddress) {
  if (!cpAddress) return null

  const parts = [
    cpAddress.streetName,
    cpAddress.streetNum,
    cpAddress.townName,
    cpAddress.regionName,
  ].filter(Boolean)

  return parts.length > 0 ? parts.join(', ') : null
}

/**
 * Parse and extract charging point data from Iberdrola response
 * @param {IberdrolaResponse} detailJson
 * @returns {{
 *   cpId: number|null,
 *   cpName: string|null,
 *   schedule: string|null,
 *   port1Status: string|null,
 *   port1PowerKw: number|null,
 *   port1UpdateDate: string|null,
 *   port2Status: string|null,
 *   port2PowerKw: number|null,
 *   port2UpdateDate: string|null,
 *   overallStatus: string|null,
 *   overallUpdateDate: string|null,
 *   addressFull: string|null,
 *   port1PriceKwh: number|null,
 *   port2PriceKwh: number|null,
 *   port1SocketType: string|null,
 *   port2SocketType: string|null,
 *   emergencyStopPressed: boolean|null,
 *   situationCode: string|null,
 *   cpLatitude: number|null,
 *   cpLongitude: number|null
 * }}
 */
function parseEntidad(detailJson) {
  const first = detailJson?.entidad?.[0] ?? {}
  const cpAddress = first?.locationData?.supplyPointData?.cpAddress ?? null

  const port1Physical = first?.logicalSocket?.[0]?.physicalSocket?.[0] ?? null
  const port2Physical = first?.logicalSocket?.[1]?.physicalSocket?.[0] ?? null

  return {
    cpId: first?.cpId ?? null,
    cpName: first?.locationData?.cuprName ?? null,
    schedule: first?.locationData?.scheduleType?.scheduleTypeDesc ?? null,

    port1Status: first?.logicalSocket?.[0]?.status?.statusCode ?? null,
    port1PowerKw: port1Physical?.maxPower ?? null,
    port1UpdateDate: first?.logicalSocket?.[0]?.status?.updateDate ?? null,

    port2Status: first?.logicalSocket?.[1]?.status?.statusCode ?? null,
    port2PowerKw: port2Physical?.maxPower ?? null,
    port2UpdateDate: first?.logicalSocket?.[1]?.status?.updateDate ?? null,

    overallStatus: first?.cpStatus?.statusCode ?? null,
    overallUpdateDate: first?.cpStatus?.updateDate ?? null,

    // New fields
    addressFull: buildFullAddress(cpAddress),
    port1PriceKwh: port1Physical?.appliedRate?.recharge?.finalPrice ?? null,
    port2PriceKwh: port2Physical?.appliedRate?.recharge?.finalPrice ?? null,
    port1SocketType: port1Physical?.socketType?.socketName ?? null,
    port2SocketType: port2Physical?.socketType?.socketName ?? null,
    emergencyStopPressed: first?.emergencyStopButtonPressed ?? null,
    situationCode: first?.locationData?.situationCode ?? null,
    cpLatitude: first?.locationData?.latitude ?? null,
    cpLongitude: first?.locationData?.longitude ?? null,
  }
}

/**
 * Save raw charging point data to Supabase
 * @param {IberdrolaResponse} detailJson
 * @returns {Promise<{success: boolean, error: any}>}
 */
async function saveRaw(detailJson) {
  try {
    console.log('INSERTING INTO SUPABASE: charge_logs...')

    const first = detailJson?.entidad?.[0] ?? {}
    const { data, error } = await insertRow('charge_logs', {
      cp_id: first?.cpId ?? null,
      status: first?.cpStatus?.statusCode ?? null,
      full_json: detailJson,
    })

    console.log('SUPABASE charge_logs RESULT:', { data, error })

    if (error) {
      console.error('SUPABASE ERROR (charge_logs):', error)
      return { success: false, error }
    }

    return { success: true, error: null }
  } catch (err) {
    console.error('FAILED TO SAVE INTO charge_logs', err)
    return { success: false, error: err }
  }
}

/**
 * Save parsed charging point data to Supabase (with deduplication)
 * @param {IberdrolaResponse} detailJson
 * @returns {Promise<{success: boolean, skipped: boolean, error: any}>}
 */
async function saveParsed(detailJson) {
  try {
    const parsed = parseEntidad(detailJson)

    // Check if status changed (deduplication)
    const lastStatus = await getLastStatus(parsed.cpId)
    const currentStatus = {
      port1Status: parsed.port1Status,
      port2Status: parsed.port2Status,
      overallStatus: parsed.overallStatus,
      emergencyStopPressed: parsed.emergencyStopPressed,
    }

    if (!hasStatusChanged(currentStatus, lastStatus)) {
      console.log('SKIPPING charge_logs_parsed: status unchanged')
      return { success: true, skipped: true, error: null }
    }

    console.log('INSERTING INTO SUPABASE: charge_logs_parsed (status changed)...')

    const { data, error } = await insertRow('charge_logs_parsed', {
      cp_id: parsed.cpId,
      cp_name: parsed.cpName,
      schedule: parsed.schedule,

      port1_status: parsed.port1Status,
      port1_power_kw: parsed.port1PowerKw,
      port1_update_date: parsed.port1UpdateDate,

      port2_status: parsed.port2Status,
      port2_power_kw: parsed.port2PowerKw,
      port2_update_date: parsed.port2UpdateDate,

      overall_status: parsed.overallStatus,
      overall_update_date: parsed.overallUpdateDate,

      // New fields
      address_full: parsed.addressFull,
      port1_price_kwh: parsed.port1PriceKwh,
      port2_price_kwh: parsed.port2PriceKwh,
      port1_socket_type: parsed.port1SocketType,
      port2_socket_type: parsed.port2SocketType,
      emergency_stop_pressed: parsed.emergencyStopPressed,
      situation_code: parsed.situationCode,
      cp_latitude: parsed.cpLatitude,
      cp_longitude: parsed.cpLongitude,
    })

    console.log('SUPABASE charge_logs_parsed RESULT:', { data, error })

    if (error) {
      console.error('SUPABASE ERROR (charge_logs_parsed):', error)
      return { success: false, skipped: false, error }
    }

    return { success: true, skipped: false, error: null }
  } catch (err) {
    console.error('FAILED TO SAVE INTO charge_logs_parsed', err)
    return { success: false, skipped: false, error: err }
  }
}

/**
 * Upsert a row into Supabase table (insert or update on conflict)
 * @param {string} table - table name
 * @param {Object} payload - row data
 * @param {string} onConflict - column name for conflict resolution
 * @returns {Promise<{data: any, error: Error|null}>}
 */
async function upsertRow(table, payload, onConflict) {
  const configError = getConfigError()
  if (configError) {
    return { data: null, error: configError }
  }

  const url = `${SUPABASE_REST_URL}/${table}?on_conflict=${onConflict}`

  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        ...SUPABASE_HEADERS,
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(payload),
    })

    const text = await res.text()
    const parsed = text ? safeJsonParse(text) : null

    if (!res.ok) {
      return {
        data: null,
        error: new Error(
          `Supabase REST error ${res.status}: ${truncateError(parsed ?? text)}`
        ),
      }
    }

    return { data: parsed, error: null }
  } catch (error) {
    return { data: null, error }
  }
}

/**
 * Build socket details object for station_metadata
 * @param {PhysicalSocket|null} physicalSocket
 * @param {LogicalSocket|null} logicalSocket
 * @returns {Object|null}
 */
function buildSocketDetails(physicalSocket, logicalSocket) {
  if (!physicalSocket) return null

  return {
    physicalSocketId: physicalSocket.physicalSocketId ?? null,
    physicalSocketCode: physicalSocket.physicalSocketCode ?? null,
    logicalSocketId: logicalSocket?.logicalSocketId ?? null,
    socketTypeId: physicalSocket.socketType?.socketTypeId ?? null,
    socketName: physicalSocket.socketType?.socketName ?? null,
    maxPower: physicalSocket.maxPower ?? null,
    evseId: logicalSocket?.evseId ?? null,
    chargeSpeedId: logicalSocket?.chargeSpeedId ?? null,
  }
}

/**
 * Save or update station metadata in Supabase
 * @param {IberdrolaResponse} detailJson
 * @returns {Promise<{success: boolean, error: any}>}
 */
async function saveStationMetadata(detailJson) {
  try {
    console.log('UPSERTING INTO SUPABASE: station_metadata...')

    const first = detailJson?.entidad?.[0] ?? {}
    const locationData = first?.locationData
    const cpAddress = locationData?.supplyPointData?.cpAddress

    const port1Logical = first?.logicalSocket?.[0] ?? null
    const port2Logical = first?.logicalSocket?.[1] ?? null
    const port1Physical = port1Logical?.physicalSocket?.[0] ?? null
    const port2Physical = port2Logical?.physicalSocket?.[0] ?? null

    const payload = {
      cp_id: first?.cpId ?? null,
      cupr_id: locationData?.cuprId ?? null,
      serial_number: first?.serialNumber ?? null,
      operator_name: locationData?.operator?.operatorDesc ?? null,
      address_street: cpAddress?.streetName ?? null,
      address_number: cpAddress?.streetNum ?? null,
      address_town: cpAddress?.townName ?? null,
      address_region: cpAddress?.regionName ?? null,
      schedule_code: locationData?.scheduleType?.scheduleCodeType ?? null,
      schedule_description: locationData?.scheduleType?.scheduleTypeDesc ?? null,
      supports_reservation: locationData?.cuprReservationIndicator ?? false,
      charge_point_type_code: locationData?.chargePointTypeCode ?? null,
      port1_socket_details: buildSocketDetails(port1Physical, port1Logical),
      port2_socket_details: buildSocketDetails(port2Physical, port2Logical),
      latitude: locationData?.latitude ?? null,
      longitude: locationData?.longitude ?? null,
      address_full: buildFullAddress(cpAddress),
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await upsertRow('station_metadata', payload, 'cp_id')

    console.log('SUPABASE station_metadata RESULT:', { data, error })

    if (error) {
      console.error('SUPABASE ERROR (station_metadata):', error)
      return { success: false, error }
    }

    return { success: true, error: null }
  } catch (err) {
    console.error('FAILED TO SAVE INTO station_metadata', err)
    return { success: false, error: err }
  }
}

/**
 * Call a Supabase RPC function
 * @param {string} functionName - RPC function name
 * @param {Object} params - function parameters
 * @returns {Promise<{data: any, error: Error|null}>}
 */
async function callRpc(functionName, params) {
  const configError = getConfigError()
  if (configError) {
    return { data: null, error: configError }
  }

  const url = `${SUPABASE_REST_URL}/rpc/${functionName}`

  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: SUPABASE_HEADERS,
      body: JSON.stringify(params),
    })

    const text = await res.text()
    const parsed = text ? safeJsonParse(text) : null

    if (!res.ok) {
      return {
        data: null,
        error: new Error(
          `Supabase RPC error ${res.status}: ${truncateError(parsed ?? text)}`
        ),
      }
    }

    return { data: parsed, error: null }
  } catch (error) {
    return { data: null, error }
  }
}

/**
 * Compute snapshot hash via Supabase RPC
 * @param {Object} parsed - parsed station data
 * @returns {Promise<string|null>}
 */
async function computeSnapshotHash(parsed) {
  const { data, error } = await callRpc('compute_snapshot_hash', {
    p1_status: parsed.port1Status,
    p1_power: parsed.port1PowerKw,
    p1_price: parsed.port1PriceKwh,
    p2_status: parsed.port2Status,
    p2_power: parsed.port2PowerKw,
    p2_price: parsed.port2PriceKwh,
    overall: parsed.overallStatus,
    emergency: parsed.emergencyStopPressed ?? false,
    situation: parsed.situationCode,
  })

  if (error) {
    console.error('Failed to compute snapshot hash:', error)
    return null
  }

  return data
}

/**
 * Check if snapshot should be stored (throttle check via RPC)
 * @param {number} cpId - charging point ID
 * @param {string} hash - payload hash
 * @param {number} minutes - throttle window in minutes
 * @returns {Promise<boolean>}
 */
async function shouldStoreSnapshot(cpId, hash, minutes = 5) {
  const { data, error } = await callRpc('should_store_snapshot', {
    p_cp_id: cpId,
    p_hash: hash,
    p_minutes: minutes,
  })

  if (error) {
    console.error('Failed to check throttle:', error)
    return true
  }

  return data === true
}

/**
 * Update snapshot throttle record
 * @param {number} cpId - charging point ID
 * @param {string} hash - payload hash
 * @returns {Promise<{success: boolean, error: any}>}
 */
async function updateThrottle(cpId, hash) {
  const { error } = await upsertRow(
    'snapshot_throttle',
    {
      cp_id: cpId,
      last_payload_hash: hash,
      last_snapshot_at: new Date().toISOString(),
    },
    'cp_id'
  )

  if (error) {
    console.error('Failed to update throttle:', error)
    return { success: false, error }
  }

  return { success: true, error: null }
}

/**
 * Save station snapshot to station_snapshots table (with deduplication)
 * @param {IberdrolaResponse} detailJson
 * @returns {Promise<{success: boolean, skipped: boolean, error: any}>}
 */
async function saveSnapshot(detailJson) {
  try {
    const parsed = parseEntidad(detailJson)

    if (!parsed.cpId) {
      return { success: false, skipped: false, error: new Error('cpId is missing') }
    }

    const hash = await computeSnapshotHash(parsed)
    if (!hash) {
      return { success: false, skipped: false, error: new Error('Failed to compute hash') }
    }

    const shouldStore = await shouldStoreSnapshot(parsed.cpId, hash)
    if (!shouldStore) {
      console.log('SKIPPING station_snapshots: status unchanged (throttled)')
      return { success: true, skipped: true, error: null }
    }

    console.log('INSERTING INTO SUPABASE: station_snapshots (status changed)...')

    const { data, error } = await insertRow('station_snapshots', {
      cp_id: parsed.cpId,
      source: 'scraper',
      payload_hash: hash,
      port1_status: parsed.port1Status,
      port1_power_kw: parsed.port1PowerKw,
      port1_price_kwh: parsed.port1PriceKwh,
      port1_update_date: parsed.port1UpdateDate,
      port2_status: parsed.port2Status,
      port2_power_kw: parsed.port2PowerKw,
      port2_price_kwh: parsed.port2PriceKwh,
      port2_update_date: parsed.port2UpdateDate,
      overall_status: parsed.overallStatus,
      emergency_stop_pressed: parsed.emergencyStopPressed ?? false,
      situation_code: parsed.situationCode,
    })

    if (error) {
      console.error('SUPABASE ERROR (station_snapshots):', error)
      return { success: false, skipped: false, error }
    }

    console.log('SUPABASE station_snapshots RESULT:', { data })

    await updateThrottle(parsed.cpId, hash)

    return { success: true, skipped: false, error: null }
  } catch (err) {
    console.error('FAILED TO SAVE INTO station_snapshots', err)
    return { success: false, skipped: false, error: err }
  }
}

module.exports = {
  assertConfig,
  validateResponse,
  parseEntidad,
  saveRaw,
  saveParsed,
  saveStationMetadata,
  saveSnapshot,
  getConfigError,
  safeJsonParse,
  truncateError,
  buildFullAddress,
  hasStatusChanged,
  buildSocketDetails,
  insertRow,
  upsertRow,
  callRpc,
  getLastStatus,
}
