/**
 * base-protocol 工具函数测试
 */

import { describe, it, expect } from 'vitest'
import {
  generateId,
  generateTimestamp,
  createSuccessResponse,
  createErrorResponse,
  createAcceptedResponse,
  createEvent,
  type Request,
  type Response,
  type Event,
  type ErrorDetail,
  GlobalErrorCode,
} from './base-protocol.js'

describe('base-protocol', () => {
  describe('generateId', () => {
    it('should generate a valid UUID v4', () => {
      const id = generateId()
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    })

    it('should generate unique IDs', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 100; i++) {
        ids.add(generateId())
      }
      expect(ids.size).toBe(100)
    })
  })

  describe('generateTimestamp', () => {
    it('should generate valid ISO 8601 timestamp', () => {
      const timestamp = generateTimestamp()
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })

    it('should generate current time', () => {
      const before = Date.now()
      const timestamp = generateTimestamp()
      const after = Date.now()
      const parsed = new Date(timestamp).getTime()
      expect(parsed).toBeGreaterThanOrEqual(before)
      expect(parsed).toBeLessThanOrEqual(after)
    })
  })

  describe('createSuccessResponse', () => {
    it('should create a valid success response', () => {
        const id = generateId()
        const data = { foo: 'bar', count: 42 }
        const response = createSuccessResponse(id, data)

        expect(response.id).toBe(id)
        expect(response.success).toBe(true)
        expect(response.data).toEqual(data)
        expect(response.error).toBeUndefined()
        expect(response.timestamp).toBeDefined()
    })
  })

  describe('createErrorResponse', () => {
    it('should create a valid error response', () => {
      const id = generateId()
      const response = createErrorResponse(id, GlobalErrorCode.INVALID_PARAMS, 'Missing required field')

      expect(response.id).toBe(id)
      expect(response.success).toBe(false)
      expect(response.data).toBeUndefined()
      expect(response.error?.code).toBe(GlobalErrorCode.INVALID_PARAMS)
      expect(response.error?.message).toBe('Missing required field')
      expect(response.error?.details).toBeUndefined()
    })

    it('should include details when provided', () => {
      const id = generateId()
      const details = { field: 'name', reason: 'required' }
      const response = createErrorResponse(id, GlobalErrorCode.INVALID_PARAMS, 'Missing field', details)

      expect(response.error?.details).toEqual(details)
    })

    it('should handle all global error codes', () => {
      const id = generateId()
      const codes = Object.values(GlobalErrorCode)

      codes.forEach((code) => {
        const response = createErrorResponse(id, code, `Error: ${code}`)
        expect(response.error?.code).toBe(code)
      })
    })
  })

  describe('createAcceptedResponse', () => {
    it('should create a valid accepted response', () => {
      const id = generateId()
      const trackingId = generateId()
      const response = createAcceptedResponse(id, trackingId)

      expect(response.id).toBe(id)
      expect(response.success).toBe(true)
      expect(response.data.status).toBe('accepted')
      expect(response.data.tracking_id).toBe(trackingId)
      expect(response.timestamp).toBeDefined()
    })
  })

  describe('createEvent', () => {
    it('should create a valid event', () => {
      const type = 'test.event'
      const source = 'test-module'
      const payload = { message: 'hello', count: 42 }
      const event = createEvent(type, source, payload)

      expect(event.id).toBeDefined()
      expect(event.type).toBe(type)
      expect(event.source).toBe(source)
      expect(event.payload).toEqual(payload)
      expect(event.timestamp).toBeDefined()
    })

    it('should create unique event IDs', () => {
      const events = new Set<string>()
      for (let i = 0; i < 100; i++) {
        const event = createEvent('test', 'test', {})
        events.add(event.id)
      }
      expect(events.size).toBe(100)
    })
  })

  describe('Type definitions', () => {
    it('Request type should have correct structure', () => {
      const request: Request = {
        id: generateId(),
        source: 'test-module',
        method: 'test_method',
        params: { foo: 'bar' },
        timestamp: generateTimestamp(),
      }

      expect(request.id).toBeDefined()
      expect(request.source).toBe('test-module')
      expect(request.method).toBe('test_method')
      expect(request.params).toEqual({ foo: 'bar' })
      expect(request.timestamp).toBeDefined()
    })

    it('Response type should have correct structure for success', () => {
      const response: Response<{ count: number }> = {
        id: generateId(),
        success: true,
        data: { count: 42 },
        timestamp: generateTimestamp(),
      }

      expect(response.success).toBe(true)
      expect(response.data?.count).toBe(42)
    })

    it('Response type should have correct structure for error', () => {
      const errorDetail: ErrorDetail = {
        code: 'TEST_ERROR',
        message: 'Test error message',
        details: { reason: 'testing' },
      }

      const response: Response = {
        id: generateId(),
        success: false,
        error: errorDetail,
        timestamp: generateTimestamp(),
      }

      expect(response.success).toBe(false)
      expect(response.error?.code).toBe('TEST_ERROR')
    })

    it('Event type should have correct structure', () => {
      const event: Event<{ action: string }> = {
        id: generateId(),
        type: 'user.action',
        source: 'test-module',
        payload: { action: 'click' },
        timestamp: generateTimestamp(),
      }

      expect(event.type).toBe('user.action')
      expect(event.payload.action).toBe('click')
    })
  })

  describe('GlobalErrorCode', () => {
    it('should have all expected error codes', () => {
      expect(GlobalErrorCode.INVALID_REQUEST).toBe('INVALID_REQUEST')
      expect(GlobalErrorCode.INVALID_PARAMS).toBe('INVALID_PARAMS')
      expect(GlobalErrorCode.METHOD_NOT_FOUND).toBe('METHOD_NOT_FOUND')
      expect(GlobalErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED')
      expect(GlobalErrorCode.FORBIDDEN).toBe('FORBIDDEN')
      expect(GlobalErrorCode.NOT_FOUND).toBe('NOT_FOUND')
      expect(GlobalErrorCode.CONFLICT).toBe('CONFLICT')
      expect(GlobalErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR')
      expect(GlobalErrorCode.SERVICE_UNAVAILABLE).toBe('SERVICE_UNAVAILABLE')
      expect(GlobalErrorCode.TIMEOUT).toBe('TIMEOUT')
    })

    it('should have correct number of error codes', () => {
      const codes = Object.keys(GlobalErrorCode)
      expect(codes.length).toBe(10)
    })
  })
})
