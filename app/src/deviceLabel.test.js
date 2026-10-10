import { describe, expect, it } from 'vitest'
import { deviceLabel } from './deviceLabel.js'

describe('deviceLabel', () => {
  it('shows a CrossPoint reader by the last three bytes of its MAC', () => {
    // MAC a1-b2-c3-d4-e5-f6 is sent as the little-endian u64 f6e5d4c3b2a1.
    expect(deviceLabel({ device: 'CrossPoint', device_id: 'crosspoint-f6e5d4c3b2a1' })).toBe('CrossPoint #d4-e5-f6')
  })

  it('tells two readers with the same vendor prefix apart', () => {
    const x3 = deviceLabel({ device: 'CrossPoint', device_id: 'crosspoint-112233c3b2a1' })
    const x4 = deviceLabel({ device: 'CrossPoint', device_id: 'crosspoint-445566c3b2a1' })
    expect(x3).not.toBe(x4)
  })

  it('uses the end of any other id', () => {
    expect(deviceLabel({ device: 'Kobo_Libra2', device_id: 'A1B2C3D4E5F60718293A4B5C6D9F3E21' })).toBe('Kobo_Libra2 #9F3E21')
    expect(deviceLabel({ device: 'CrossPoint' })).toBe('CrossPoint')
  })
})
