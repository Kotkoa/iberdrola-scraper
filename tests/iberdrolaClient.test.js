const { test, describe, mock, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')

const validResponse = require('./fixtures/iberdrola-response.json')

describe('iberdrolaClient', () => {
  describe('buildBody', () => {
    const { buildBody } = require('../src/iberdrolaClient')

    test('builds request body with cuprId', () => {
      const result = buildBody(144569)
      assert.deepStrictEqual(result, {
        dto: { cuprId: [144569] },
        language: 'en',
      })
    })

    test('accepts custom language', () => {
      const result = buildBody(123, 'es')
      assert.deepStrictEqual(result, {
        dto: { cuprId: [123] },
        language: 'es',
      })
    })

    test('wraps single cuprId in array', () => {
      const result = buildBody(999)
      assert.ok(Array.isArray(result.dto.cuprId))
      assert.strictEqual(result.dto.cuprId[0], 999)
    })
  })

  describe('buildHeaders', () => {
    const { buildHeaders } = require('../src/iberdrolaClient')

    test('includes required headers', () => {
      const headers = buildHeaders()

      assert.strictEqual(headers['content-type'], 'application/json')
      assert.ok(headers.accept.includes('application/json'))
      assert.ok(headers.referer.includes('iberdrola.es'))
      assert.ok(headers.origin.includes('iberdrola.es'))
      assert.ok(headers['user-agent'].length > 0)
      assert.strictEqual(headers['x-requested-with'], 'XMLHttpRequest')
    })

    test('includes accept-language header', () => {
      const headers = buildHeaders()
      assert.ok(headers['accept-language'].includes('en'))
    })
  })

  describe('withRetry', () => {
    const { withRetry } = require('../src/iberdrolaClient')

    test('returns result on first successful attempt', async () => {
      const fn = mock.fn(() => Promise.resolve('success'))

      const result = await withRetry(fn, 3, 10)

      assert.strictEqual(result, 'success')
      assert.strictEqual(fn.mock.calls.length, 1)
    })

    test('retries on failure and succeeds', async () => {
      let attempts = 0
      const fn = mock.fn(() => {
        attempts++
        if (attempts < 3) {
          return Promise.reject(new Error('fail'))
        }
        return Promise.resolve('success')
      })

      const result = await withRetry(fn, 3, 10)

      assert.strictEqual(result, 'success')
      assert.strictEqual(fn.mock.calls.length, 3)
    })

    test('throws after exhausting all attempts', async () => {
      const fn = mock.fn(() => Promise.reject(new Error('always fails')))

      await assert.rejects(
        () => withRetry(fn, 3, 10),
        { message: 'always fails' }
      )

      assert.strictEqual(fn.mock.calls.length, 3)
    })

    test('uses exponential backoff', async () => {
      const startTime = Date.now()
      let attempts = 0

      const fn = mock.fn(() => {
        attempts++
        if (attempts < 3) {
          return Promise.reject(new Error('fail'))
        }
        return Promise.resolve('success')
      })

      await withRetry(fn, 3, 50)

      const elapsed = Date.now() - startTime
      assert.ok(elapsed >= 100, `Expected >= 100ms delay, got ${elapsed}ms`)
    })
  })

  describe('fetchWithTimeout', () => {
    let originalFetch

    beforeEach(() => {
      originalFetch = global.fetch
    })

    afterEach(() => {
      global.fetch = originalFetch
    })

    test('returns response on success', async () => {
      const { fetchWithTimeout } = require('../src/iberdrolaClient')

      global.fetch = mock.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: 'test' }),
        })
      )

      const response = await fetchWithTimeout('https://example.com', {}, 1000)

      assert.ok(response.ok)
      const data = await response.json()
      assert.deepStrictEqual(data, { data: 'test' })
    })

    test('aborts on timeout', async () => {
      const { fetchWithTimeout } = require('../src/iberdrolaClient')

      global.fetch = mock.fn((url, options) => {
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => resolve({ ok: true }), 500)
          options.signal.addEventListener('abort', () => {
            clearTimeout(timeoutId)
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      })

      await assert.rejects(
        () => fetchWithTimeout('https://example.com', {}, 50),
        { name: 'AbortError' }
      )
    })

    test('passes options to fetch', async () => {
      const { fetchWithTimeout } = require('../src/iberdrolaClient')

      global.fetch = mock.fn(() => Promise.resolve({ ok: true }))

      await fetchWithTimeout(
        'https://example.com',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
        1000
      )

      const [url, options] = global.fetch.mock.calls[0].arguments
      assert.strictEqual(url, 'https://example.com')
      assert.strictEqual(options.method, 'POST')
      assert.strictEqual(options.headers['Content-Type'], 'application/json')
      assert.ok(options.signal instanceof AbortSignal)
    })
  })

  describe('fetchDatos with mocked fetch', () => {
    let originalFetch

    beforeEach(() => {
      originalFetch = global.fetch
    })

    afterEach(() => {
      global.fetch = originalFetch
    })

    test('returns parsed response on success', async () => {
      const { fetchDatos } = require('../src/iberdrolaClient')

      global.fetch = mock.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(validResponse),
        })
      )

      const result = await fetchDatos(144569, 1)

      assert.deepStrictEqual(result, validResponse)
      assert.strictEqual(global.fetch.mock.calls.length, 1)
    })

    test('returns null on HTTP error', async () => {
      const { fetchDatos } = require('../src/iberdrolaClient')

      global.fetch = mock.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Internal Server Error'),
        })
      )

      const result = await fetchDatos(144569, 1)

      assert.strictEqual(result, null)
    })

    test('returns null on network error', async () => {
      const { fetchDatos } = require('../src/iberdrolaClient')

      global.fetch = mock.fn(() => Promise.reject(new Error('Network error')))

      const result = await fetchDatos(144569, 1)

      assert.strictEqual(result, null)
    })

    test('sends correct request body', async () => {
      const { fetchDatos } = require('../src/iberdrolaClient')

      global.fetch = mock.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(validResponse),
        })
      )

      await fetchDatos(12345, 1)

      const [, options] = global.fetch.mock.calls[0].arguments
      const body = JSON.parse(options.body)

      assert.deepStrictEqual(body.dto.cuprId, [12345])
      assert.strictEqual(body.language, 'en')
    })

    test('sends correct headers', async () => {
      const { fetchDatos } = require('../src/iberdrolaClient')

      global.fetch = mock.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(validResponse),
        })
      )

      await fetchDatos(144569, 1)

      const [, options] = global.fetch.mock.calls[0].arguments

      assert.strictEqual(options.headers['content-type'], 'application/json')
      assert.ok(options.headers.referer.includes('iberdrola.es'))
      assert.strictEqual(options.headers['x-requested-with'], 'XMLHttpRequest')
    })

    test('retries on failure before giving up', async () => {
      const { fetchDatos } = require('../src/iberdrolaClient')

      let attempts = 0
      global.fetch = mock.fn(() => {
        attempts++
        return Promise.reject(new Error('Network error'))
      })

      const result = await fetchDatos(144569, 2)

      assert.strictEqual(result, null)
      assert.strictEqual(attempts, 2)
    })
  })
})
