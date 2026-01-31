const { test, describe, mock, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')

const validResponse = require('./fixtures/iberdrola-response.json')

describe('supabaseService', () => {
  describe('safeJsonParse', () => {
    const { safeJsonParse } = require('../src/supabaseService')

    test('parses valid JSON', () => {
      const result = safeJsonParse('{"foo": "bar"}')
      assert.deepStrictEqual(result, { foo: 'bar' })
    })

    test('returns original string for invalid JSON', () => {
      const result = safeJsonParse('not json')
      assert.strictEqual(result, 'not json')
    })

    test('parses JSON array', () => {
      const result = safeJsonParse('[1, 2, 3]')
      assert.deepStrictEqual(result, [1, 2, 3])
    })
  })

  describe('truncateError', () => {
    const { truncateError } = require('../src/supabaseService')

    test('returns "No response body" for null', () => {
      assert.strictEqual(truncateError(null), 'No response body')
    })

    test('returns "No response body" for undefined', () => {
      assert.strictEqual(truncateError(undefined), 'No response body')
    })

    test('returns short string as-is', () => {
      assert.strictEqual(truncateError('short error'), 'short error')
    })

    test('truncates long string with ellipsis', () => {
      const longString = 'a'.repeat(400)
      const result = truncateError(longString)
      assert.strictEqual(result.length, 300)
      assert.ok(result.endsWith('...'))
    })

    test('stringifies and truncates objects', () => {
      const obj = { error: 'x'.repeat(400) }
      const result = truncateError(obj)
      assert.ok(result.length <= 300)
    })
  })

  describe('validateResponse', () => {
    const { validateResponse } = require('../src/supabaseService')

    test('returns valid for correct response', () => {
      const result = validateResponse(validResponse)
      assert.strictEqual(result.valid, true)
      assert.strictEqual(result.reason, null)
    })

    test('returns invalid for null response', () => {
      const result = validateResponse(null)
      assert.strictEqual(result.valid, false)
      assert.strictEqual(result.reason, 'Response is null or undefined')
    })

    test('returns invalid for empty entidad array', () => {
      const result = validateResponse({ entidad: [] })
      assert.strictEqual(result.valid, false)
      assert.strictEqual(result.reason, 'entidad array is empty or missing')
    })

    test('returns invalid for missing entidad', () => {
      const result = validateResponse({})
      assert.strictEqual(result.valid, false)
      assert.strictEqual(result.reason, 'entidad array is empty or missing')
    })

    test('returns invalid for missing cpId', () => {
      const result = validateResponse({
        entidad: [{ locationData: { cuprName: 'Test' } }],
      })
      assert.strictEqual(result.valid, false)
      assert.strictEqual(result.reason, 'cpId is missing or falsy')
    })

    test('returns invalid for missing cuprName', () => {
      const result = validateResponse({
        entidad: [{ cpId: 123, locationData: {} }],
      })
      assert.strictEqual(result.valid, false)
      assert.strictEqual(result.reason, 'locationData.cuprName is missing')
    })

    test('returns invalid for missing cpStatus.statusCode', () => {
      const result = validateResponse({
        entidad: [
          {
            cpId: 123,
            locationData: { cuprName: 'Test' },
            cpStatus: {},
          },
        ],
      })
      assert.strictEqual(result.valid, false)
      assert.strictEqual(result.reason, 'cpStatus.statusCode is missing')
    })

    test('returns invalid for empty logicalSocket', () => {
      const result = validateResponse({
        entidad: [
          {
            cpId: 123,
            locationData: { cuprName: 'Test' },
            cpStatus: { statusCode: 'AVAILABLE' },
            logicalSocket: [],
          },
        ],
      })
      assert.strictEqual(result.valid, false)
      assert.strictEqual(result.reason, 'logicalSocket array is empty or missing')
    })
  })

  describe('buildFullAddress', () => {
    const { buildFullAddress } = require('../src/supabaseService')

    test('returns null for null input', () => {
      assert.strictEqual(buildFullAddress(null), null)
    })

    test('returns null for empty object', () => {
      assert.strictEqual(buildFullAddress({}), null)
    })

    test('builds full address from all parts', () => {
      const result = buildFullAddress({
        streetName: 'Gran Via',
        streetNum: '42',
        townName: 'Madrid',
        regionName: 'Madrid',
      })
      assert.strictEqual(result, 'Gran Via, 42, Madrid, Madrid')
    })

    test('builds partial address', () => {
      const result = buildFullAddress({
        streetName: 'Gran Via',
        townName: 'Madrid',
      })
      assert.strictEqual(result, 'Gran Via, Madrid')
    })
  })

  describe('parseEntidad', () => {
    const { parseEntidad } = require('../src/supabaseService')

    test('parses full response correctly', () => {
      const result = parseEntidad(validResponse)

      assert.strictEqual(result.cpId, 144569)
      assert.strictEqual(result.cpName, 'Iberdrola Charging Station Test')
      assert.strictEqual(result.schedule, '24 hours')
      assert.strictEqual(result.port1Status, 'AVAILABLE')
      assert.strictEqual(result.port1PowerKw, 50)
      assert.strictEqual(result.port2Status, 'OCCUPIED')
      assert.strictEqual(result.port2PowerKw, 50)
      assert.strictEqual(result.overallStatus, 'PARTIALLY_AVAILABLE')
      assert.strictEqual(result.addressFull, 'Calle Gran Via, 42, Madrid, Madrid')
      assert.strictEqual(result.port1PriceKwh, 0.39)
      assert.strictEqual(result.port1SocketType, 'CCS Combo 2')
      assert.strictEqual(result.emergencyStopPressed, false)
      assert.strictEqual(result.situationCode, 'ACTIVE')
      assert.strictEqual(result.cpLatitude, 40.416775)
      assert.strictEqual(result.cpLongitude, -3.70379)
    })

    test('returns nulls for empty response', () => {
      const result = parseEntidad({})

      assert.strictEqual(result.cpId, null)
      assert.strictEqual(result.cpName, null)
      assert.strictEqual(result.port1Status, null)
      assert.strictEqual(result.port2Status, null)
    })

    test('returns nulls for null response', () => {
      const result = parseEntidad(null)

      assert.strictEqual(result.cpId, null)
      assert.strictEqual(result.cpName, null)
    })
  })

  describe('computePriceFields', () => {
    const { computePriceFields } = require('../src/supabaseService')

    test('returns null/false when both prices are null', () => {
      const result = computePriceFields(null, null)
      assert.strictEqual(result.isFree, null)
      assert.strictEqual(result.priceVerified, false)
    })

    test('returns isFree=true when port1 price is 0', () => {
      const result = computePriceFields(0, null)
      assert.strictEqual(result.isFree, true)
      assert.strictEqual(result.priceVerified, true)
    })

    test('returns isFree=true when port2 price is 0', () => {
      const result = computePriceFields(null, 0)
      assert.strictEqual(result.isFree, true)
      assert.strictEqual(result.priceVerified, true)
    })

    test('returns isFree=true when both prices are 0', () => {
      const result = computePriceFields(0, 0)
      assert.strictEqual(result.isFree, true)
      assert.strictEqual(result.priceVerified, true)
    })

    test('returns isFree=false when port1 price > 0', () => {
      const result = computePriceFields(0.39, null)
      assert.strictEqual(result.isFree, false)
      assert.strictEqual(result.priceVerified, true)
    })

    test('returns isFree=false when port2 price > 0', () => {
      const result = computePriceFields(null, 0.25)
      assert.strictEqual(result.isFree, false)
      assert.strictEqual(result.priceVerified, true)
    })

    test('returns isFree=false when any price > 0', () => {
      const result = computePriceFields(0, 0.39)
      assert.strictEqual(result.isFree, false)
      assert.strictEqual(result.priceVerified, true)
    })

    test('returns isFree=false when both prices > 0', () => {
      const result = computePriceFields(0.39, 0.39)
      assert.strictEqual(result.isFree, false)
      assert.strictEqual(result.priceVerified, true)
    })
  })

  describe('buildSocketDetails', () => {
    const { buildSocketDetails } = require('../src/supabaseService')

    test('returns null for null physical socket', () => {
      assert.strictEqual(buildSocketDetails(null, null), null)
    })

    test('builds socket details from physical and logical sockets', () => {
      const physical = {
        physicalSocketId: 2001,
        physicalSocketCode: 'CCS2',
        maxPower: 50,
        socketType: {
          socketTypeId: 'CCS',
          socketName: 'CCS Combo 2',
        },
      }
      const logical = {
        logicalSocketId: 1001,
        evseId: 'ES*IBE*E001*001',
        chargeSpeedId: 3,
      }

      const result = buildSocketDetails(physical, logical)

      assert.strictEqual(result.physicalSocketId, 2001)
      assert.strictEqual(result.physicalSocketCode, 'CCS2')
      assert.strictEqual(result.logicalSocketId, 1001)
      assert.strictEqual(result.socketTypeId, 'CCS')
      assert.strictEqual(result.socketName, 'CCS Combo 2')
      assert.strictEqual(result.maxPower, 50)
      assert.strictEqual(result.evseId, 'ES*IBE*E001*001')
      assert.strictEqual(result.chargeSpeedId, 3)
    })

    test('handles missing logical socket', () => {
      const physical = {
        physicalSocketId: 2001,
        maxPower: 50,
      }

      const result = buildSocketDetails(physical, null)

      assert.strictEqual(result.physicalSocketId, 2001)
      assert.strictEqual(result.logicalSocketId, null)
      assert.strictEqual(result.evseId, null)
    })
  })

  describe('insertRow with mocked fetch', () => {
    let originalFetch
    let originalEnv

    beforeEach(() => {
      originalFetch = global.fetch
      originalEnv = { ...process.env }
    })

    afterEach(() => {
      global.fetch = originalFetch
      process.env = originalEnv
    })

    test('returns data on successful insert', async (t) => {
      process.env.SUPABASE_URL = 'https://test.supabase.co'
      process.env.SUPABASE_KEY = 'test-key'

      delete require.cache[require.resolve('../src/supabaseService')]
      const { insertRow } = require('../src/supabaseService')

      global.fetch = mock.fn(() =>
        Promise.resolve({
          ok: true,
          text: () => Promise.resolve('[{"id": 1}]'),
        })
      )

      const result = await insertRow('test_table', { foo: 'bar' })

      assert.strictEqual(result.error, null)
      assert.deepStrictEqual(result.data, [{ id: 1 }])
      assert.strictEqual(global.fetch.mock.calls.length, 1)
    })

    test('returns error on API failure', async () => {
      process.env.SUPABASE_URL = 'https://test.supabase.co'
      process.env.SUPABASE_KEY = 'test-key'

      delete require.cache[require.resolve('../src/supabaseService')]
      const { insertRow } = require('../src/supabaseService')

      global.fetch = mock.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          text: () => Promise.resolve('{"message": "Bad request"}'),
        })
      )

      const result = await insertRow('test_table', { foo: 'bar' })

      assert.ok(result.error instanceof Error)
      assert.ok(result.error.message.includes('400'))
      assert.strictEqual(result.data, null)
    })

    test('returns error on network failure', async () => {
      process.env.SUPABASE_URL = 'https://test.supabase.co'
      process.env.SUPABASE_KEY = 'test-key'

      delete require.cache[require.resolve('../src/supabaseService')]
      const { insertRow } = require('../src/supabaseService')

      global.fetch = mock.fn(() => Promise.reject(new Error('Network error')))

      const result = await insertRow('test_table', { foo: 'bar' })

      assert.ok(result.error instanceof Error)
      assert.strictEqual(result.error.message, 'Network error')
      assert.strictEqual(result.data, null)
    })
  })

  describe('getConfigError', () => {
    let originalEnv

    beforeEach(() => {
      originalEnv = { ...process.env }
    })

    afterEach(() => {
      process.env = originalEnv
      delete require.cache[require.resolve('../src/supabaseService')]
    })

    test('returns error when SUPABASE_URL is missing', () => {
      delete process.env.SUPABASE_URL
      delete process.env.SUPABASE_KEY
      delete process.env.SUPABASE_SERVICE_ROLE_KEY

      delete require.cache[require.resolve('../src/supabaseService')]
      const { getConfigError } = require('../src/supabaseService')

      const error = getConfigError()
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes('SUPABASE_URL'))
    })

    test('returns error when SUPABASE_KEY is missing', () => {
      process.env.SUPABASE_URL = 'https://test.supabase.co'
      delete process.env.SUPABASE_KEY
      delete process.env.SUPABASE_SERVICE_ROLE_KEY

      delete require.cache[require.resolve('../src/supabaseService')]
      const { getConfigError } = require('../src/supabaseService')

      const error = getConfigError()
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes('SUPABASE_KEY') || error.message.includes('SUPABASE_SERVICE_ROLE_KEY'))
    })

    test('returns null when config is valid', () => {
      process.env.SUPABASE_URL = 'https://test.supabase.co'
      process.env.SUPABASE_KEY = 'test-key'

      delete require.cache[require.resolve('../src/supabaseService')]
      const { getConfigError } = require('../src/supabaseService')

      const error = getConfigError()
      assert.strictEqual(error, null)
    })
  })
})
