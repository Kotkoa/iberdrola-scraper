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
    const res = await fetch(url, {
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
 *   overallUpdateDate: string|null
 * }}
 */
function parseEntidad(detailJson) {
  const first = detailJson?.entidad?.[0] ?? {}

  return {
    cpId: first?.cpId ?? null,
    cpName: first?.locationData?.cuprName ?? null,
    schedule: first?.locationData?.scheduleType?.scheduleTypeDesc ?? null,

    port1Status: first?.logicalSocket?.[0]?.status?.statusCode ?? null,
    port1PowerKw:
      first?.logicalSocket?.[0]?.physicalSocket?.[0]?.maxPower ?? null,
    port1UpdateDate: first?.logicalSocket?.[0]?.status?.updateDate ?? null,

    port2Status: first?.logicalSocket?.[1]?.status?.statusCode ?? null,
    port2PowerKw:
      first?.logicalSocket?.[1]?.physicalSocket?.[0]?.maxPower ?? null,
    port2UpdateDate: first?.logicalSocket?.[1]?.status?.updateDate ?? null,

    overallStatus: first?.cpStatus?.statusCode ?? null,
    overallUpdateDate: first?.cpStatus?.updateDate ?? null,
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
 * Save parsed charging point data to Supabase
 * @param {IberdrolaResponse} detailJson
 * @returns {Promise<{success: boolean, error: any}>}
 */
async function saveParsed(detailJson) {
  try {
    console.log('INSERTING INTO SUPABASE: charge_logs_parsed...')

    const parsed = parseEntidad(detailJson)

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
    })

    console.log('SUPABASE charge_logs_parsed RESULT:', { data, error })

    if (error) {
      console.error('SUPABASE ERROR (charge_logs_parsed):', error)
      return { success: false, error }
    }

    return { success: true, error: null }
  } catch (err) {
    console.error('FAILED TO SAVE INTO charge_logs_parsed', err)
    return { success: false, error: err }
  }
}

module.exports = { validateResponse, parseEntidad, saveRaw, saveParsed }
