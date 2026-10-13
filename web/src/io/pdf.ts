import { zlibSync } from 'fflate'

// A one-page PDF of an opaque RGB image (3 bytes a pixel), losslessly compressed, filling a page `pageWidth` × `pageHeight` points,
// as the Mac's Export As writes one: the export's pixels at the document's resolution. With `cmyk`, a CMYK profile, the image is that
// profile's inks (4 bytes a pixel), the profile embedded.
export function pdfOfImage(rgb: Uint8Array, width: number, height: number, pageWidth: number, pageHeight: number, cmyk?: Uint8Array): Uint8Array {
  const n = (v: number) => String(+v.toFixed(3))
  const image = zlibSync(rgb), contents = `q ${n(pageWidth)} 0 0 ${n(pageHeight)} 0 0 cm /Im0 Do Q`
  const text = (s: string) => new TextEncoder().encode(s)
  const objects: Uint8Array[][] = [
    [text('<< /Type /Catalog /Pages 2 0 R >>')],
    [text('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')],
    [text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(pageWidth)} ${n(pageHeight)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)],
    [text(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${cmyk ? '[/ICCBased 6 0 R]' : '/DeviceRGB'} /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`), image, text('\nendstream')],
    [text(`<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`)],
  ]
  if (cmyk) { const profile = zlibSync(cmyk); objects.push([text(`<< /N 4 /Alternate /DeviceCMYK /Filter /FlateDecode /Length ${profile.length} >>\nstream\n`), profile, text('\nendstream')]) }
  const parts: Uint8Array[] = [text('%PDF-1.4\n%âãÏÓ\n')], offsets: number[] = []
  let length = parts[0].length
  const push = (part: Uint8Array) => { parts.push(part); length += part.length }
  objects.forEach((body, index) => { offsets.push(length); push(text(`${index + 1} 0 obj\n`)); body.forEach(push); push(text('\nendobj\n')) })
  const xref = length
  push(text(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`))
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}
