// The device that synced last, as "device:TAG" (e.g. "xteink_x3:1D-F8"), the same format the
// reader's sync screen uses. A CrossPoint id is "crosspoint-" + the eFuse MAC printed as a
// little-endian u64, so the MAC's last two bytes are its first four hex digits, reversed (the
// last digits are the vendor prefix every reader shares). Any other id: its last four chars.
export function deviceTag(id) {
  if (!id) return ''
  const mac = /^crosspoint-([0-9a-f]{12})$/i.exec(id)
  const hex = mac ? mac[1].slice(2, 4) + mac[1].slice(0, 2) : id.slice(-4)
  return hex.length === 4 ? `${hex.slice(0, 2)}-${hex.slice(2)}`.toUpperCase() : id
}

export function deviceLabel(b) {
  const tag = deviceTag(b.device_id)
  return tag ? `${b.device || 'device'}:${tag}` : b.device || ''
}
