// Reads the text off a screenshot, on this device.
//
// tesseract.js is loaded only when a screenshot is actually chosen. Its engine
// and English language data download once from a public CDN and are then
// cached by the browser; the image itself is never uploaded anywhere.

const MAX_SIDE = 3000

// Very large photos are scaled down first — OCR doesn't need more and phones
// run out of memory on the biggest ones.
async function prepare(file) {
  try {
    const bitmap = await createImageBitmap(file)
    const longest = Math.max(bitmap.width, bitmap.height)
    if (longest <= MAX_SIDE) { bitmap.close?.(); return file }
    const scale = MAX_SIDE / longest
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    return await new Promise(resolve => canvas.toBlob(b => resolve(b || file), 'image/png'))
  } catch {
    return file // an unreadable preview shouldn't stop the OCR from trying
  }
}

// onProgress(fraction 0–1, status text)
export async function readImageText(file, onProgress) {
  const { createWorker } = await import('tesseract.js')
  const image = await prepare(file)
  const worker = await createWorker('eng', 1, {
    logger: m => { if (onProgress && typeof m.progress === 'number') onProgress(m.progress, m.status) },
  })
  try {
    const { data } = await worker.recognize(image)
    return data.text || ''
  } finally {
    await worker.terminate()
  }
}
