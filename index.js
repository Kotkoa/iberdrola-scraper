const { fetchDatos } = require('./src/iberdrolaClient')
const { saveRaw, saveParsed } = require('./src/supabaseService')

const CUPR_ID = 144569

/**
 * Main orchestrator: fetches data and persists to Supabase
 * @returns {Promise<void>}
 */
async function main() {
  console.log('START FETCH getDatosPuntoRecarga, cuprId =', CUPR_ID)

  const detailJson = await fetchDatos(CUPR_ID)
  if (!detailJson) {
    console.log('NO DETAIL JSON RECEIVED — skipping DB inserts')
    return
  }

  await saveRaw(detailJson)
  await saveParsed(detailJson)

  console.log('DONE')
}

main().catch((err) => {
  console.error('UNHANDLED ERROR IN MAIN', err)
})
