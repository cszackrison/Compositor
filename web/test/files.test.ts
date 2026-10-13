import { describe, expect, it } from 'vitest'
import { imagesIn } from '../src/io/files'

describe('image folders', () => {
  it('take images in Finder name order, camera HEIF by name, and skip hidden and other files', () => {
    const file = (name: string, type = '') => new File([new Uint8Array(1)], name, { type })
    const files = [file('10 Ten.png', 'image/png'), file('2 Two.jpeg', 'image/jpeg'), file('.Hidden.png', 'image/png'), file('Notes.txt', 'text/plain'), file('DSC1.HIF')]
    expect(imagesIn(files).map(f => f.name)).toEqual(['2 Two.jpeg', '10 Ten.png', 'DSC1.HIF'])
  })
})
