const { createClient } = require('@supabase/supabase-js')
const { fetchDatos } = require('./src/iberdrolaClient')

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || ''
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const CUPR_ID = 144569

/**
 * Main function: fetches charging point data and persists to Supabase
 * @returns {Promise<void>}
 */
async function main() {
  console.log('START FETCH getDatosPuntoRecarga, cuprId =', CUPR_ID)

  const detailJson = await fetchDatos(CUPR_ID)
  if (!detailJson) {
    console.log('NO DETAIL JSON RECEIVED — skipping DB inserts')
    return
  }

  try {
    console.log('INSERTING INTO SUPABASE: charge_logs...')
    const first = detailJson?.entidad?.[0] ?? {}
    const { data, error } = await supabase.from('charge_logs').insert({
      cp_id: first?.cpId ?? null,
      status: first?.cpStatus?.statusCode ?? null,
      full_json: detailJson,
    })
    console.log('SUPABASE charge_logs RESULT:', { data, error })
    if (error) console.error('SUPABASE ERROR:', error)
  } catch (err) {
    console.error('FAILED TO SAVE INTO charge_logs', err)
  }

  try {
    console.log('INSERTING INTO SUPABASE: charge_logs_parsed...')
    const first = detailJson?.entidad?.[0] ?? {}

    const { data, error } = await supabase.from('charge_logs_parsed').insert({
      cp_id: first?.cpId ?? null,
      cp_name: first?.locationData?.cuprName ?? null,
      schedule: first?.locationData?.scheduleType?.scheduleTypeDesc ?? null,

      port1_status: first?.logicalSocket?.[0]?.status?.statusCode ?? null,
      port1_power_kw:
        first?.logicalSocket?.[0]?.physicalSocket?.[0]?.maxPower ?? null,
      port1_update_date: first?.logicalSocket?.[0]?.status?.updateDate ?? null,

      port2_status: first?.logicalSocket?.[1]?.status?.statusCode ?? null,
      port2_power_kw:
        first?.logicalSocket?.[1]?.physicalSocket?.[0]?.maxPower ?? null,
      port2_update_date: first?.logicalSocket?.[1]?.status?.updateDate ?? null,

      overall_status: first?.cpStatus?.statusCode ?? null,
      overall_update_date: first?.cpStatus?.updateDate ?? null,
    })

    console.log('PARSED INSERT RESULT:', { data, error })
  } catch (err) {
    console.error('FAILED TO SAVE PARSED FIELDS', err)
  }

  console.log('DONE')
}

main().catch((err) => {
  console.error('UNHANDLED ERROR IN MAIN', err)
})
