const { createClient } = require('@supabase/supabase-js')

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

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || ''
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

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
    const { data, error } = await supabase.from('charge_logs').insert({
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

    const { data, error } = await supabase.from('charge_logs_parsed').insert({
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

module.exports = { parseEntidad, saveRaw, saveParsed }
