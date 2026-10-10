// The device that synced last: its name plus a short id, which tells same-named readers apart
// (every CrossPoint reader reports "CrossPoint"). A CrossPoint id is the eFuse MAC printed as a
// little-endian u64, so its LAST hex digits are the shared vendor prefix; show the MAC's last
// three bytes instead, as the reader's WiFi screen prints them. Other ids: their last 6 chars.
export function deviceLabel(b) {
  const id = b.device_id || ''
  const mac = /^crosspoint-([0-9a-f]{12})$/i.exec(id)
  const tag = mac ? mac[1].match(/../g).reverse().slice(3).join('-') : id.slice(-6)
  return [b.device, tag && `#${tag}`].filter(Boolean).join(' ')
}
