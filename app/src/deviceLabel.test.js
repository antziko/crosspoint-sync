import { describe, expect, it } from 'vitest'
import { deviceLabel } from './deviceLabel.js'

describe('deviceLabel', () => {
  it('shows a CrossPoint reader by the last two bytes of its MAC', () => {
    // MAC 9c-cc-a0-62-1d-f8 is sent as the little-endian u64 f81d62a0cc9c.
    expect(deviceLabel({ device: 'xteink_x3', device_id: 'crosspoint-f81d62a0cc9c' })).toBe('xteink_x3:1D-F8')
  })

  it('tells two readers with the same vendor prefix apart', () => {
    const x3 = deviceLabel({ device: 'xteink_x3', device_id: 'crosspoint-f81d62a0cc9c' })
    const x4 = deviceLabel({ device: 'xteink_x3', device_id: 'crosspoint-0a1b62a0cc9c' })
    expect(x3).not.toBe(x4)
  })

  it('uses the end of any other id', () => {
    expect(deviceLabel({ device: 'Kobo_Libra2', device_id: 'A1B2C3D4E5F60718293A4B5C6D9f3e21' })).toBe('Kobo_Libra2:3E-21')
    expect(deviceLabel({ device: 'CrossPoint' })).toBe('CrossPoint')
    expect(deviceLabel({ device_id: 'crosspoint-f81d62a0cc9c' })).toBe('device:1D-F8')
  })
})
